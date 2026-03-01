import { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { streamChat, chatWithCsvTools, chatWithFunctionTools, CODE_KEYWORDS } from '../services/gemini';
import { parseCsvToRows, executeTool, computeDatasetSummary, enrichWithEngagement, buildSlimCsv } from '../services/csvTools';
import { REQUIRED_CHAT_TOOL_DECLARATIONS } from '../services/requiredChatTools';
import {
  getSessions,
  createSession,
  deleteSession,
  saveMessage,
  loadMessages,
} from '../services/mongoApi';
import EngagementChart from './EngagementChart';
import YouTubeDownload from './YouTubeDownload';
import MetricTimeChart from './MetricTimeChart';
import './Chat.css';

// ── Helpers ───────────────────────────────────────────────────────────────────

const chatTitle = () => {
  const d = new Date();
  return `Chat · ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
};

// Encode a string to base64 safely (handles unicode/emoji in tweet text etc.)
const toBase64 = (str) => {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
};

const parseCSV = (text) => {
  const lines = text.split('\n').filter((l) => l.trim());
  if (!lines.length) return null;
  const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  const rowCount = lines.length - 1;

  // Short human-readable preview (header + first 5 rows) for context
  const preview = lines.slice(0, 6).join('\n');

  // Full CSV as base64 — avoids ALL string-escaping issues in Python code execution
  // (tweet text with quotes, apostrophes, emojis, etc. all break triple-quoted strings)
  const raw = text.length > 500000 ? text.slice(0, 500000) : text;
  const base64 = toBase64(raw);
  const truncated = text.length > 500000;

  return { headers, rowCount, preview, base64, truncated };
};

// Extract plain text from a message (for history only — never returns base64)
const messageText = (m) => {
  if (m.parts) return m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  return m.content || '';
};

const isObjectRecord = (x) => x && typeof x === 'object' && !Array.isArray(x);

const parseChannelJson = (text) => {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    return { ok: false, error: 'That JSON is valid, but it must be an array of video objects.' };
  }
  if (!parsed.every(isObjectRecord)) {
    return { ok: false, error: 'The JSON array must contain objects (one object per video).' };
  }
  return { ok: true, data: parsed };
};

const downloadDataUrl = (dataUrl, filename) => {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
};

const downloadBase64 = (base64, mimeType, filename) => {
  downloadDataUrl(`data:${mimeType};base64,${base64}`, filename);
};

const svgElementToPngDataUrl = async (svgEl, scale = 2) => {
  const svg = new XMLSerializer().serializeToString(svgEl);
  const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(img.width * scale));
    canvas.height = Math.max(1, Math.floor(img.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
};

// ── Structured part renderer (code execution responses) ───────────────────────

function StructuredParts({ parts }) {
  return (
    <>
      {parts.map((part, i) => {
        if (part.type === 'text' && part.text?.trim()) {
          return (
            <div key={i} className="part-text">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown>
            </div>
          );
        }
        if (part.type === 'code') {
          return (
            <div key={i} className="part-code">
              <div className="part-code-header">
                <span className="part-code-lang">
                  {part.language === 'PYTHON' ? 'Python' : part.language}
                </span>
              </div>
              <pre className="part-code-body">
                <code>{part.code}</code>
              </pre>
            </div>
          );
        }
        if (part.type === 'result') {
          const ok = part.outcome === 'OUTCOME_OK';
          return (
            <div key={i} className="part-result">
              <div className="part-result-header">
                <span className={`part-result-badge ${ok ? 'ok' : 'err'}`}>
                  {ok ? '✓ Output' : '✗ Error'}
                </span>
              </div>
              <pre className="part-result-body">{part.output}</pre>
            </div>
          );
        }
        if (part.type === 'image') {
          return (
            <img
              key={i}
              src={`data:${part.mimeType};base64,${part.data}`}
              alt="Generated plot"
              className="part-image"
            />
          );
        }
        return null;
      })}
    </>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Chat({ user, onLogout }) {
  const username = user?.username || '';
  const [activePage, setActivePage] = useState('chat'); // 'chat' | 'youtube'
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [images, setImages] = useState([]);
  const [channelData, setChannelData] = useState(null); // YouTube channel JSON (array of video objects)
  const [channelDataError, setChannelDataError] = useState('');
  const [csvContext, setCsvContext] = useState(null);     // pending attachment chip
  const [sessionCsvRows, setSessionCsvRows] = useState(null);    // parsed rows for JS tools
  const [sessionCsvHeaders, setSessionCsvHeaders] = useState(null); // headers for tool routing
  const [csvDataSummary, setCsvDataSummary] = useState(null);    // auto-computed column stats summary
  const [sessionSlimCsv, setSessionSlimCsv] = useState(null);   // key-columns CSV string sent directly to Gemini
  const [streaming, setStreaming] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [openMenuId, setOpenMenuId] = useState(null);
  const [modal, setModal] = useState(null); // { type: 'image'|'chart', ...payload }

  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const abortRef = useRef(false);
  const fileInputRef = useRef(null);
  // Set to true immediately before setActiveSessionId() is called during a send
  // so the messages useEffect knows to skip the reload (streaming is in progress).
  const justCreatedSessionRef = useRef(false);
  const greetingStartedRef = useRef(false);

  const buildChannelContextInstruction = (data) => {
    if (!Array.isArray(data) || data.length === 0) return '';
    return `The user has uploaded YouTube channel data in JSON format.
The JSON is an array of ${data.length} video objects with fields such as:
title, description, transcript, duration_seconds, release_date, view_count, like_count, comment_count, video_url, thumbnail_url.

Use this data to answer questions about the channel and its videos.

Here is the channel JSON data:
${JSON.stringify(data)}`;
  };

  // On login: load sessions from DB; 'new' means an unsaved pending chat
  useEffect(() => {
    const init = async () => {
      const list = await getSessions(username);
      setSessions(list);
      setActiveSessionId('new'); // always start with a fresh empty chat on login
    };
    init();
  }, [username]);

  // Load channel JSON from localStorage (best effort)
  useEffect(() => {
    try {
      const raw = localStorage.getItem('channelData');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every(isObjectRecord)) {
        setChannelData(parsed);
      }
    } catch {
      // ignore invalid local storage
    }
  }, []);

  const clearChannelData = () => {
    setChannelData(null);
    setChannelDataError('');
    try {
      localStorage.removeItem('channelData');
    } catch {
      // ignore
    }
  };

  const executeRequiredTool = async (toolName, args, capturedImagesForAnchor = []) => {
    const supportedMetrics = ['view_count', 'like_count', 'comment_count', 'duration_seconds'];
    const safeMetric = (m) => (supportedMetrics.includes(m) ? m : null);

    const data = channelData;
    const requireData = () => {
      if (!Array.isArray(data) || data.length === 0) {
        return { ok: false, error: 'No channel data loaded. Drag and drop a channel JSON file first.' };
      }
      return null;
    };

    if (toolName === 'compute_stats_json') {
      const m = safeMetric(args?.metric);
      if (!m) return { metric: args?.metric ?? null, mean: null, median: null, std: null, min: null, max: null, error: 'Unsupported metric' };
      const missing = requireData();
      if (missing) return { metric: m, mean: null, median: null, std: null, min: null, max: null, error: missing.error };

      const vals = data
        .map((v) => Number(v?.[m]))
        .filter((x) => Number.isFinite(x));
      if (!vals.length) return { metric: m, mean: null, median: null, std: null, min: null, max: null, error: 'No numeric values found for metric' };

      const sorted = [...vals].sort((a, b) => a - b);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
      const variance = vals.reduce((acc, x) => acc + (x - mean) ** 2, 0) / vals.length;
      const std = Math.sqrt(variance);
      const min = sorted[0];
      const max = sorted[sorted.length - 1];

      return { metric: m, mean, median, std, min, max };
    }

    if (toolName === 'plot_metric_vs_time') {
      const m = safeMetric(args?.metric);
      if (!m) return { labels: [], values: [], metric: args?.metric ?? null, error: 'Unsupported metric' };
      const missing = requireData();
      if (missing) return { labels: [], values: [], metric: m, error: missing.error };

      const rows = data
        .map((v) => ({
          date: typeof v?.release_date === 'string' ? v.release_date : null,
          value: Number(v?.[m]),
        }))
        .filter((r) => r.date && Number.isFinite(r.value))
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));

      return {
        labels: rows.map((r) => r.date),
        values: rows.map((r) => r.value),
        metric: m,
      };
    }

    if (toolName === 'play_video') {
      const missing = requireData();
      if (missing) return { title: null, thumbnail_url: null, video_url: null, error: missing.error };

      const st = args?.selection_type;
      const value = args?.value;
      const vids = [...data].filter((v) => v && typeof v === 'object');

      const byViewsDesc = vids
        .filter((v) => Number.isFinite(Number(v.view_count)))
        .sort((a, b) => Number(b.view_count) - Number(a.view_count));

      let picked = null;
      if (st === 'most_viewed') {
        picked = byViewsDesc[0] || null;
      } else if (st === 'ordinal') {
        const sorted = vids
          .filter((v) => typeof v.release_date === 'string')
          .sort((a, b) => String(a.release_date).localeCompare(String(b.release_date)));
        const idx = Math.max(0, Number(value) - 1);
        picked = sorted[idx] || null;
      } else if (st === 'title') {
        const q = String(value || '').trim().toLowerCase();
        if (!q) return { title: null, thumbnail_url: null, video_url: null, error: 'Missing title value' };
        const scored = vids
          .map((v) => {
            const t = String(v.title || '').toLowerCase();
            let score = 0;
            if (t === q) score += 100;
            if (t.includes(q)) score += 50;
            // token overlap
            const qt = q.split(/\s+/).filter(Boolean);
            for (const tok of qt) if (tok.length >= 3 && t.includes(tok)) score += 5;
            return { v, score };
          })
          .sort((a, b) => b.score - a.score);
        picked = scored[0]?.v || null;
      } else {
        return { title: null, thumbnail_url: null, video_url: null, error: 'Invalid selection_type' };
      }

      if (!picked) return { title: null, thumbnail_url: null, video_url: null, error: 'No matching video found' };

      return {
        title: picked.title || null,
        thumbnail_url: picked.thumbnail_url || null,
        video_url: picked.video_url || null,
      };
    }

    if (toolName === 'generateImage') {
      const prompt = String(args?.prompt || '').trim();
      if (!prompt) return { base64_image: null, mimeType: null, error: 'Missing prompt' };

      const anchor =
        typeof args?.anchorImageBase64 === 'string' && args.anchorImageBase64.trim()
          ? args.anchorImageBase64.trim()
          : capturedImagesForAnchor?.[0]?.data || null;

      const apiKey = process.env.REACT_APP_GEMINI_API_KEY || '';
      if (!apiKey) return { base64_image: null, mimeType: null, error: 'Missing REACT_APP_GEMINI_API_KEY' };

      const body = {
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              ...(anchor ? [{ inlineData: { mimeType: 'image/png', data: anchor } }] : []),
            ],
          },
        ],
      };

      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
      const json = await resp.json();
      if (!resp.ok) {
        return { base64_image: null, mimeType: null, error: json?.error?.message || 'Image generation failed' };
      }

      const parts = json?.candidates?.[0]?.content?.parts || [];
      const imgPart = parts.find((p) => p.inlineData?.data && p.inlineData?.mimeType?.startsWith('image/'));
      if (!imgPart) return { base64_image: null, mimeType: null, error: 'No image returned' };

      return { base64_image: imgPart.inlineData.data, mimeType: imgPart.inlineData.mimeType };
    }

    return { error: `Unknown tool: ${toolName}` };
  };

  // On a brand-new chat: create the session and have the AI send the first greeting.
  // This ensures the first assistant message is AI-generated (not hardcoded UI text).
  useEffect(() => {
    if (!username) return;
    if (activePage !== 'chat') return;
    if (activeSessionId !== 'new') return;
    if (messages.length) return;
    if (streaming) return;
    if (greetingStartedRef.current) return;

    greetingStartedRef.current = true;
    setStreaming(true);

    const run = async () => {
      const title = chatTitle();
      const { id } = await createSession(username, 'lisa', title);
      const sessionId = id;

      justCreatedSessionRef.current = true; // skip reload; we'll stream into state
      setActiveSessionId(sessionId);
      setSessions((prev) => [
        { id: sessionId, agent: 'lisa', title, createdAt: new Date().toISOString(), messageCount: 0 },
        ...prev,
      ]);

      const assistantId = `a-${Date.now()}`;
      setMessages([
        { id: assistantId, role: 'model', content: '', timestamp: new Date().toISOString() },
      ]);
      abortRef.current = false;

      let fullContent = '';
      let structuredParts = null;
      try {
        const channelContextInstruction = buildChannelContextInstruction(channelData);
        for await (const chunk of streamChat([], 'Start this new chat with a friendly greeting.', [], false, user, channelContextInstruction)) {
          if (abortRef.current) break;
          if (chunk.type === 'text') {
            fullContent += chunk.text;
            setMessages((m) =>
              m.map((msg) => (msg.id === assistantId ? { ...msg, content: fullContent } : msg))
            );
          } else if (chunk.type === 'fullResponse') {
            structuredParts = chunk.parts;
            setMessages((m) =>
              m.map((msg) =>
                msg.id === assistantId ? { ...msg, content: '', parts: structuredParts } : msg
              )
            );
          }
        }
      } catch (err) {
        fullContent = `Error: ${err.message}`;
        setMessages((m) => m.map((msg) => (msg.id === assistantId ? { ...msg, content: fullContent } : msg)));
      }

      const savedContent = structuredParts
        ? structuredParts.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
        : fullContent;
      await saveMessage(sessionId, 'model', savedContent);

      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, messageCount: (s.messageCount || 0) + 1 } : s))
      );

      setStreaming(false);
    };

    run().catch((err) => {
      console.error('[New chat greeting failed]', err);
      setStreaming(false);
    });
  }, [activePage, activeSessionId, messages.length, streaming, username, user]);

  useEffect(() => {
    if (!activeSessionId || activeSessionId === 'new') {
      setMessages([]);
      return;
    }
    // If a session was just created during an active send, messages are already
    // in state and streaming is in progress — don't wipe them.
    if (justCreatedSessionRef.current) {
      justCreatedSessionRef.current = false;
      return;
    }
    setMessages([]);
    loadMessages(activeSessionId).then(setMessages);
  }, [activeSessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (!openMenuId) return;
    const handler = () => setOpenMenuId(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [openMenuId]);

  // ── Session management ──────────────────────────────────────────────────────

  const handleNewChat = () => {
    greetingStartedRef.current = false;
    setActiveSessionId('new');
    setMessages([]);
    setInput('');
    setImages([]);
    setCsvContext(null);
    setSessionCsvRows(null);
    setSessionCsvHeaders(null);
  };

  const handleSelectSession = (sessionId) => {
    if (sessionId === activeSessionId) return;
    greetingStartedRef.current = false;
    setActiveSessionId(sessionId);
    setInput('');
    setImages([]);
    setCsvContext(null);
    setSessionCsvRows(null);
    setSessionCsvHeaders(null);
  };

  const handleDeleteSession = async (sessionId, e) => {
    e.stopPropagation();
    setOpenMenuId(null);
    await deleteSession(sessionId);
    const remaining = sessions.filter((s) => s.id !== sessionId);
    setSessions(remaining);
    if (activeSessionId === sessionId) {
      setActiveSessionId(remaining.length > 0 ? remaining[0].id : 'new');
      setMessages([]);
    }
  };

  // ── File handling ───────────────────────────────────────────────────────────

  const fileToBase64 = (file) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result.split(',')[1]);
      r.onerror = reject;
      r.readAsDataURL(file);
    });

  const fileToText = (file) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsText(file);
    });

  const handleDrop = async (e) => {
    e.preventDefault();
    setDragOver(false);
    const files = [...e.dataTransfer.files];

    const csvFiles = files.filter((f) => f.name.endsWith('.csv') || f.type === 'text/csv');
    const jsonFiles = files.filter((f) => f.name.toLowerCase().endsWith('.json') || f.type === 'application/json');
    const imageFiles = files.filter((f) => f.type.startsWith('image/'));

    if (jsonFiles.length > 0) {
      const file = jsonFiles[0];
      try {
        const text = await fileToText(file);
        const { ok, data, error } = parseChannelJson(text);
        if (!ok) {
          setChannelDataError(error || 'Invalid JSON file.');
        } else {
          setChannelData(data);
          setChannelDataError('');
          try {
            localStorage.setItem('channelData', JSON.stringify(data));
          } catch {
            // ignore storage limits
          }
        }
      } catch {
        setChannelDataError('Could not read/parse that JSON file. Please upload a valid channel JSON array.');
      }
      // If a JSON file was dropped, treat it as the primary action (don’t also ingest CSV/images).
      return;
    }

    if (csvFiles.length > 0) {
      const file = csvFiles[0];
      const text = await fileToText(file);
      const parsed = parseCSV(text);
      if (parsed) {
        setCsvContext({ name: file.name, ...parsed });
        // Parse rows, add computed engagement col, build summary + slim CSV
        const raw = parseCsvToRows(text);
        const { rows, headers } = enrichWithEngagement(raw.rows, raw.headers);
        setSessionCsvHeaders(headers);
        setSessionCsvRows(rows);
        setCsvDataSummary(computeDatasetSummary(rows, headers));
        setSessionSlimCsv(buildSlimCsv(rows, headers));
      }
    }

    if (imageFiles.length > 0) {
      const newImages = await Promise.all(
        imageFiles.map(async (f) => ({
          data: await fileToBase64(f),
          mimeType: f.type,
          name: f.name,
        }))
      );
      setImages((prev) => [...prev, ...newImages]);
    }
  };

  const handleFileSelect = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';

    const csvFiles = files.filter((f) => f.name.endsWith('.csv') || f.type === 'text/csv');
    const imageFiles = files.filter((f) => f.type.startsWith('image/'));

    if (csvFiles.length > 0) {
      const text = await fileToText(csvFiles[0]);
      const parsed = parseCSV(text);
      if (parsed) {
        setCsvContext({ name: csvFiles[0].name, ...parsed });
        const raw = parseCsvToRows(text);
        const { rows, headers } = enrichWithEngagement(raw.rows, raw.headers);
        setSessionCsvHeaders(headers);
        setSessionCsvRows(rows);
        setCsvDataSummary(computeDatasetSummary(rows, headers));
        setSessionSlimCsv(buildSlimCsv(rows, headers));
      }
    }
    if (imageFiles.length > 0) {
      const newImages = await Promise.all(
        imageFiles.map(async (f) => ({
          data: await fileToBase64(f),
          mimeType: f.type,
          name: f.name,
        }))
      );
      setImages((prev) => [...prev, ...newImages]);
    }
  };

  // ── Stop generation ─────────────────────────────────────────────────────────

  const handlePaste = async (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const imageItems = items.filter((item) => item.type.startsWith('image/'));
    if (!imageItems.length) return;
    e.preventDefault();
    const newImages = await Promise.all(
      imageItems.map(
        (item) =>
          new Promise((resolve) => {
            const file = item.getAsFile();
            if (!file) return resolve(null);
            const reader = new FileReader();
            reader.onload = () =>
              resolve({ data: reader.result.split(',')[1], mimeType: file.type, name: 'pasted-image' });
            reader.readAsDataURL(file);
          })
      )
    );
    setImages((prev) => [...prev, ...newImages.filter(Boolean)]);
  };

  const handleStop = () => {
    abortRef.current = true;
  };

  // ── Send message ────────────────────────────────────────────────────────────

  const handleSend = async () => {
    const text = input.trim();
    if ((!text && !images.length && !csvContext) || streaming || !activeSessionId) return;

    const channelContextInstruction = buildChannelContextInstruction(channelData);

    // Lazily create the session in DB on the very first message
    let sessionId = activeSessionId;
    if (sessionId === 'new') {
      const title = chatTitle();
      const { id } = await createSession(username, 'lisa', title);
      sessionId = id;
      justCreatedSessionRef.current = true; // tell useEffect to skip the reload
      setActiveSessionId(id);
      setSessions((prev) => [{ id, agent: 'lisa', title, createdAt: new Date().toISOString(), messageCount: 0 }, ...prev]);
    }

    // ── Routing intent (computed first so we know whether Python/base64 is needed) ──
    // PYTHON_ONLY = things the client tools genuinely cannot produce
    const PYTHON_ONLY_KEYWORDS = /\b(regression|scatter|histogram|seaborn|matplotlib|numpy|time.?series|heatmap|box.?plot|violin|distribut|linear.?model|logistic|forecast|trend.?line)\b/i;
    const wantPythonOnly = PYTHON_ONLY_KEYWORDS.test(text);
    const wantCode = CODE_KEYWORDS.test(text) && !sessionCsvRows;
    const capturedCsv = csvContext;
    const hasCsvInSession = !!sessionCsvRows || !!capturedCsv;
    // Base64 is only worth sending when Gemini will actually run Python
    const needsBase64 = !!capturedCsv && wantPythonOnly;
    // Mode selection:
    //   useTools        — CSV loaded + no Python needed → client-side JS tools (free, fast)
    //   useCodeExecution — Python explicitly needed (regression, histogram, etc.)
    //   else            — Google Search streaming (also used for "tell me about this file")
    const useTools = !!sessionCsvRows && !wantPythonOnly && !wantCode && !capturedCsv;
    const useCodeExecution = wantPythonOnly || wantCode;
    const useRequiredTools =
      !!channelData ||
      /\b(plot|graph|chart)\b/i.test(text) ||
      /\baverage|mean|median|std|min|max\b/i.test(text) ||
      /\bplay\b.*\bvideo\b/i.test(text) ||
      /\bgenerate\b.*\bimage\b|\bthumbnail\b.*\bimage\b|\bcreate\b.*\bimage\b/i.test(text);

    // ── Build prompt ─────────────────────────────────────────────────────────
    // sessionSummary: auto-computed column stats, included with every message
    const sessionSummary = csvDataSummary || '';
    // slimCsv: key columns only (text, type, metrics, engagement) as plain readable CSV
    // ~6-10k tokens — Gemini reads it directly so it can answer from context or call tools
    const slimCsvBlock = sessionSlimCsv
      ? `\n\nFull dataset (key columns):\n\`\`\`csv\n${sessionSlimCsv}\n\`\`\``
      : '';

    const csvPrefix = capturedCsv
      ? needsBase64
        // Python path: send base64 so Gemini can load it with pandas
        ? `[CSV File: "${capturedCsv.name}" | ${capturedCsv.rowCount} rows | Columns: ${capturedCsv.headers.join(', ')}]

${sessionSummary}${slimCsvBlock}

IMPORTANT — to load the full data in Python use this exact pattern:
\`\`\`python
import pandas as pd, io, base64
df = pd.read_csv(io.BytesIO(base64.b64decode("${capturedCsv.base64}")))
\`\`\`

---

`
        // Standard path: plain CSV text — no encoding needed
        : `[CSV File: "${capturedCsv.name}" | ${capturedCsv.rowCount} rows | Columns: ${capturedCsv.headers.join(', ')}]

${sessionSummary}${slimCsvBlock}

---

`
      : sessionSummary
      ? `[CSV columns: ${sessionCsvHeaders?.join(', ')}]\n\n${sessionSummary}\n\n---\n\n`
      : '';

    // userContent  — displayed in bubble and stored in MongoDB (never contains base64)
    // promptForGemini — sent to the Gemini API (may contain the full prefix)
    const userContent = text || (images.length ? '(Image)' : '(CSV attached)');
    const promptForGemini = csvPrefix + (text || (images.length ? 'What do you see in this image?' : 'Please analyze this CSV data.'));

    const userMsg = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: userContent,
      timestamp: new Date().toISOString(),
      images: [...images],
      csvName: capturedCsv?.name || null,
    };

    setMessages((m) => [...m, userMsg]);
    setInput('');
    const capturedImages = [...images];
    setImages([]);
    setCsvContext(null);
    setStreaming(true);

    // Store display text only — base64 is never persisted
    await saveMessage(sessionId, 'user', userContent, capturedImages.length ? capturedImages : null);

    const imageParts = capturedImages.map((img) => ({ mimeType: img.mimeType, data: img.data }));

    // History: plain display text only — session summary handles CSV context on every message
    const history = messages
      .filter((m) => m.role === 'user' || m.role === 'model')
      .map((m) => ({ role: m.role, content: m.content || messageText(m) }));

    const assistantId = `a-${Date.now()}`;
    setMessages((m) => [
      ...m,
      { id: assistantId, role: 'model', content: '', timestamp: new Date().toISOString() },
    ]);

    abortRef.current = false;

    let fullContent = '';
    let groundingData = null;
    let structuredParts = null;
    let toolCharts = [];
    let toolCalls = [];
    let generatedImages = [];
    let videoCard = null;

    try {
      if (useTools) {
        // ── Function-calling path: Gemini picks tool + args, JS executes ──────
        console.log('[Chat] useTools=true | rows:', sessionCsvRows.length, '| headers:', sessionCsvHeaders);
        const { text: answer, charts: returnedCharts, toolCalls: returnedCalls } = await chatWithCsvTools(
          history,
          promptForGemini,
          sessionCsvHeaders,
          (toolName, args) => executeTool(toolName, args, sessionCsvRows),
          user,
          channelContextInstruction
        );
        fullContent = answer;
        toolCharts = returnedCharts || [];
        toolCalls = returnedCalls || [];
        console.log('[Chat] returnedCharts:', JSON.stringify(toolCharts));
        console.log('[Chat] toolCalls:', toolCalls.map((t) => t.name));
        setMessages((m) =>
          m.map((msg) =>
            msg.id === assistantId
              ? {
                  ...msg,
                  content: fullContent,
                  charts: toolCharts.length ? toolCharts : undefined,
                  toolCalls: toolCalls.length ? toolCalls : undefined,
                }
              : msg
          )
        );
      } else if (useRequiredTools) {
        const { text: answer, toolCalls: returnedCalls } = await chatWithFunctionTools(
          history,
          promptForGemini,
          REQUIRED_CHAT_TOOL_DECLARATIONS,
          (toolName, args) => executeRequiredTool(toolName, args, capturedImages),
          user,
          channelContextInstruction
        );
        fullContent = answer;
        toolCalls = returnedCalls || [];

        for (const tc of toolCalls) {
          if (tc.name === 'plot_metric_vs_time' && tc.result?.labels && tc.result?.values) {
            toolCharts.push({
              _chartType: 'metric_time',
              metric: tc.result.metric,
              labels: tc.result.labels,
              values: tc.result.values,
            });
          }
          if (tc.name === 'generateImage' && tc.result?.base64_image && tc.result?.mimeType) {
            generatedImages.push({
              data: tc.result.base64_image,
              mimeType: tc.result.mimeType,
            });
          }
          if (tc.name === 'play_video' && tc.result?.video_url) {
            videoCard = {
              title: tc.result.title,
              thumbnail_url: tc.result.thumbnail_url,
              video_url: tc.result.video_url,
            };
          }
        }

        setMessages((m) =>
          m.map((msg) =>
            msg.id === assistantId
              ? {
                  ...msg,
                  content: fullContent,
                  charts: toolCharts.length ? toolCharts : undefined,
                  toolCalls: toolCalls.length ? toolCalls : undefined,
                  generatedImages: generatedImages.length ? generatedImages : undefined,
                  videoCard: videoCard || undefined,
                }
              : msg
          )
        );
      } else {
        // ── Streaming path: code execution or search ─────────────────────────
        for await (const chunk of streamChat(history, promptForGemini, imageParts, useCodeExecution, user, channelContextInstruction)) {
          if (abortRef.current) break;
          if (chunk.type === 'text') {
            fullContent += chunk.text;
            setMessages((m) =>
              m.map((msg) => (msg.id === assistantId ? { ...msg, content: fullContent } : msg))
            );
          } else if (chunk.type === 'fullResponse') {
            structuredParts = chunk.parts;
            setMessages((m) =>
              m.map((msg) =>
                msg.id === assistantId ? { ...msg, content: '', parts: structuredParts } : msg
              )
            );
          } else if (chunk.type === 'grounding') {
            groundingData = chunk.data;
          }
        }
      }
    } catch (err) {
      const errText = `Error: ${err.message}`;
      setMessages((m) =>
        m.map((msg) => (msg.id === assistantId ? { ...msg, content: errText } : msg))
      );
      fullContent = errText;
    }

    if (groundingData) {
      setMessages((m) =>
        m.map((msg) => (msg.id === assistantId ? { ...msg, grounding: groundingData } : msg))
      );
    }

    // Save plain text + any tool charts to DB
    const savedContent = structuredParts
      ? structuredParts.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
      : fullContent;
    await saveMessage(
      sessionId,
      'model',
      savedContent,
      null,
      toolCharts.length ? toolCharts : null,
      toolCalls.length ? toolCalls : null
    );

    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, messageCount: s.messageCount + 2 } : s))
    );

    setStreaming(false);
    inputRef.current?.focus();
  };

  const removeImage = (i) => setImages((prev) => prev.filter((_, idx) => idx !== i));

  const activeSession = sessions.find((s) => s.id === activeSessionId);

  const formatDate = (dateStr) => {
    const d = new Date(dateStr);
    const diffDays = Math.floor((Date.now() - d) / 86400000);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (diffDays === 0) return `Today · ${time}`;
    if (diffDays === 1) return `Yesterday · ${time}`;
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${time}`;
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="chat-layout">
      {/* ── Sidebar ──────────────────────────────── */}
      <aside className="chat-sidebar">
        <div className="sidebar-top">
          <h1 className="sidebar-title">Chat</h1>
          <div className="sidebar-tabs">
            <button
              className={`sidebar-tab${activePage === 'chat' ? ' active' : ''}`}
              onClick={() => setActivePage('chat')}
            >
              Chat
            </button>
            <button
              className={`sidebar-tab${activePage === 'youtube' ? ' active' : ''}`}
              onClick={() => setActivePage('youtube')}
            >
              YouTube Channel Download
            </button>
          </div>
          {activePage === 'chat' && (
            <button className="new-chat-btn" onClick={handleNewChat}>
              + New Chat
            </button>
          )}
        </div>

        {activePage === 'chat' && (
          <div className="sidebar-sessions">
            {sessions.map((session) => (
              <div
                key={session.id}
                className={`sidebar-session${session.id === activeSessionId ? ' active' : ''}`}
                onClick={() => handleSelectSession(session.id)}
              >
                <div className="sidebar-session-info">
                  <span className="sidebar-session-title">{session.title}</span>
                  <span className="sidebar-session-date">{formatDate(session.createdAt)}</span>
                </div>
                <div
                  className="sidebar-session-menu"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenMenuId(openMenuId === session.id ? null : session.id);
                  }}
                >
                  <span className="three-dots">⋮</span>
                  {openMenuId === session.id && (
                    <div className="session-dropdown">
                      <button
                        className="session-delete-btn"
                        onClick={(e) => handleDeleteSession(session.id, e)}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="sidebar-footer">
          <span className="sidebar-username">{username}</span>
          <button onClick={onLogout} className="sidebar-logout">
            Log out
          </button>
        </div>
      </aside>

      {/* ── Main chat area ───────────────────────── */}
      <div className="chat-main">
        {activePage === 'youtube' ? (
          <YouTubeDownload user={user} />
        ) : (
          <>
            <header className="chat-header">
              <h2 className="chat-header-title">{activeSession?.title ?? 'New Chat'}</h2>
            </header>

            <div
              className={`chat-messages${dragOver ? ' drag-over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
            >
              {/* Channel JSON indicator */}
              {(channelDataError || channelData) && (
                <div className="channel-json-banner">
                  {channelData ? (
                    <>
                      <span className="channel-json-text">
                        Channel data loaded: <b>{channelData.length}</b> videos
                      </span>
                      <button type="button" className="channel-json-clear" onClick={clearChannelData}>
                        Clear
                      </button>
                    </>
                  ) : (
                    <span className="channel-json-error">{channelDataError}</span>
                  )}
                </div>
              )}

              {messages.map((m) => (
                <div key={m.id} className={`chat-msg ${m.role}`}>
                  <div className="chat-msg-meta">
                    <span className="chat-msg-role">{m.role === 'user' ? username : 'Lisa'}</span>
                    <span className="chat-msg-time">
                      {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>

              {/* CSV badge on user messages */}
              {m.csvName && (
                <div className="msg-csv-badge">
                  📄 {m.csvName}
                </div>
              )}

              {/* Image attachments */}
              {m.images?.length > 0 && (
                <div className="chat-msg-images">
                  {m.images.map((img, i) => (
                    <img key={i} src={`data:${img.mimeType};base64,${img.data}`} alt="" className="chat-msg-thumb" />
                  ))}
                </div>
              )}

              {/* Message body */}
              <div className="chat-msg-content">
                {m.role === 'model' ? (
                  m.parts ? (
                    <StructuredParts parts={m.parts} />
                  ) : m.content ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                  ) : (
                    <span className="thinking-dots">
                      <span /><span /><span />
                    </span>
                  )
                ) : (
                  m.content
                )}
              </div>

              {/* Tool calls log */}
              {m.toolCalls?.length > 0 && (
                <details className="tool-calls-details">
                  <summary className="tool-calls-summary">
                    🔧 {m.toolCalls.length} tool{m.toolCalls.length > 1 ? 's' : ''} used
                  </summary>
                  <div className="tool-calls-list">
                    {m.toolCalls.map((tc, i) => (
                      <div key={i} className="tool-call-item">
                        <span className="tool-call-name">{tc.name}</span>
                        <span className="tool-call-args">{JSON.stringify(tc.args)}</span>
                        {tc.result && !tc.result._chartType && (
                          <span className="tool-call-result">
                            → {JSON.stringify(tc.result).slice(0, 200)}
                            {JSON.stringify(tc.result).length > 200 ? '…' : ''}
                          </span>
                        )}
                        {tc.result?._chartType && (
                          <span className="tool-call-result">→ rendered chart</span>
                        )}
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {/* Generated image(s) from tools */}
              {m.generatedImages?.length > 0 &&
                m.generatedImages.map((img, gi) => (
                  <div key={gi}>
                    <div
                      className="tool-image"
                      onClick={() => setModal({ type: 'image', mimeType: img.mimeType, data: img.data })}
                      role="button"
                      tabIndex={0}
                    >
                      <img src={`data:${img.mimeType};base64,${img.data}`} alt="Generated" />
                    </div>
                    <div className="tool-media-row">
                      <button
                        className="tool-media-btn"
                        onClick={() =>
                          downloadBase64(img.data, img.mimeType, `generated_image_${m.id}_${gi}.png`)
                        }
                      >
                        Download
                      </button>
                      <button
                        className="tool-media-btn"
                        onClick={() => setModal({ type: 'image', mimeType: img.mimeType, data: img.data })}
                      >
                        Enlarge
                      </button>
                    </div>
                  </div>
                ))}

              {/* Engagement charts from tool calls */}
              {m.charts?.map((chart, ci) =>
                chart._chartType === 'engagement' ? (
                  <EngagementChart
                    key={ci}
                    data={chart.data}
                    metricColumn={chart.metricColumn}
                  />
                ) : chart._chartType === 'metric_time' ? (
                  <div key={ci}>
                    <div
                      id={`metric-chart-${m.id}-${ci}`}
                      onClick={() => setModal({ type: 'chart', chart })}
                      role="button"
                      tabIndex={0}
                    >
                      <MetricTimeChart
                        data={chart.labels.map((d, i) => ({ date: d, value: chart.values[i] }))}
                        metric={chart.metric}
                      />
                    </div>
                    <div className="tool-media-row">
                      <button
                        className="tool-media-btn"
                        onClick={async () => {
                          const root = document.getElementById(`metric-chart-${m.id}-${ci}`);
                          const svg = root?.querySelector('svg');
                          if (!svg) return;
                          const pngUrl = await svgElementToPngDataUrl(svg, 2);
                          downloadDataUrl(pngUrl, `${chart.metric || 'metric'}_vs_time.png`);
                        }}
                      >
                        Download PNG
                      </button>
                      <button className="tool-media-btn" onClick={() => setModal({ type: 'chart', chart })}>
                        Enlarge
                      </button>
                    </div>
                  </div>
                ) : null
              )}

              {/* Video card from tool */}
              {m.videoCard?.video_url && (
                <a className="video-card" href={m.videoCard.video_url} target="_blank" rel="noreferrer">
                  {m.videoCard.thumbnail_url && (
                    <img className="video-card-thumb" src={m.videoCard.thumbnail_url} alt="" />
                  )}
                  <div className="video-card-title">{m.videoCard.title || 'Open video'}</div>
                </a>
              )}

              {/* Search sources */}
              {m.grounding?.groundingChunks?.length > 0 && (
                <div className="chat-msg-sources">
                  <span className="sources-label">Sources</span>
                  <div className="sources-list">
                    {m.grounding.groundingChunks.map((chunk, i) =>
                      chunk.web ? (
                        <a key={i} href={chunk.web.uri} target="_blank" rel="noreferrer" className="source-link">
                          {chunk.web.title || chunk.web.uri}
                        </a>
                      ) : null
                    )}
                  </div>
                  {m.grounding.webSearchQueries?.length > 0 && (
                    <div className="sources-queries">
                      Searched: {m.grounding.webSearchQueries.join(' · ')}
                    </div>
                  )}
                </div>
              )}
                </div>
              ))}
              <div ref={bottomRef} />
            </div>

            {dragOver && <div className="chat-drop-overlay">Drop CSV or images here</div>}

            {/* ── Input area ── */}
            <div className="chat-input-area">
              {/* CSV chip */}
              {csvContext && (
                <div className="csv-chip">
                  <span className="csv-chip-icon">📄</span>
                  <span className="csv-chip-name">{csvContext.name}</span>
                  <span className="csv-chip-meta">
                    {csvContext.rowCount} rows · {csvContext.headers.length} cols
                  </span>
                  <button
                    className="csv-chip-remove"
                    onClick={() => setCsvContext(null)}
                    aria-label="Remove CSV"
                  >
                    ×
                  </button>
                </div>
              )}

              {/* Image previews */}
              {images.length > 0 && (
                <div className="chat-image-previews">
                  {images.map((img, i) => (
                    <div key={i} className="chat-img-preview">
                      <img src={`data:${img.mimeType};base64,${img.data}`} alt="" />
                      <button type="button" onClick={() => removeImage(i)} aria-label="Remove">
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Hidden file picker */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,.csv,text/csv"
                multiple
                style={{ display: 'none' }}
                onChange={handleFileSelect}
              />

              <div className="chat-input-row">
                <button
                  type="button"
                  className="attach-btn"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={streaming}
                  title="Attach image or CSV"
                >
                  📎
                </button>
                <input
                  ref={inputRef}
                  type="text"
                  placeholder="Ask a question, request analysis, or write & run code…"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
                  onPaste={handlePaste}
                  disabled={streaming}
                />
                {streaming ? (
                  <button onClick={handleStop} className="stop-btn">
                    ■ Stop
                  </button>
                ) : (
                  <button onClick={handleSend} disabled={!input.trim() && !images.length && !csvContext}>
                    Send
                  </button>
                )}
              </div>
            </div>

            {/* Modal (image/chart enlarge) */}
            {modal && (
              <div className="modal-overlay" onClick={() => setModal(null)}>
                <div className="modal-card" onClick={(e) => e.stopPropagation()}>
                  <div className="modal-header">
                    <div className="modal-title">
                      {modal.type === 'image'
                        ? 'Image'
                        : modal.type === 'chart'
                        ? `${modal.chart?.metric || 'Metric'} vs time`
                        : 'Preview'}
                    </div>
                    <button className="modal-close" onClick={() => setModal(null)}>
                      Close
                    </button>
                  </div>

                  {modal.type === 'image' && (
                    <>
                      <img
                        src={`data:${modal.mimeType};base64,${modal.data}`}
                        alt="Enlarged"
                        style={{ width: '100%', borderRadius: 12, border: '1px solid rgba(255,255,255,0.1)' }}
                      />
                      <div className="tool-media-row">
                        <button
                          className="tool-media-btn"
                          onClick={() => downloadBase64(modal.data, modal.mimeType, 'generated_image.png')}
                        >
                          Download
                        </button>
                      </div>
                    </>
                  )}

                  {modal.type === 'chart' && modal.chart && (
                    <>
                      <div id="modal-metric-chart">
                        <MetricTimeChart
                          data={modal.chart.labels.map((d, i) => ({ date: d, value: modal.chart.values[i] }))}
                          metric={modal.chart.metric}
                          height={420}
                        />
                      </div>
                      <div className="tool-media-row">
                        <button
                          className="tool-media-btn"
                          onClick={async () => {
                            const root = document.getElementById('modal-metric-chart');
                            const svg = root?.querySelector('svg');
                            if (!svg) return;
                            const pngUrl = await svgElementToPngDataUrl(svg, 2);
                            downloadDataUrl(pngUrl, `${modal.chart.metric || 'metric'}_vs_time.png`);
                          }}
                        >
                          Download PNG
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
