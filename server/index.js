require('dotenv').config();
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const { downloadChannelData, clampInt } = require('./youtubeDownloader');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Retry/backoff for Google API calls ────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const parseDurationToMs = (dur) => {
  // Accepts "1s", "2.5s", or { seconds, nanos }.
  if (!dur) return null;
  if (typeof dur === 'string') {
    const m = dur.trim().match(/^(\d+(?:\.\d+)?)s$/i);
    if (!m) return null;
    const s = Number(m[1]);
    return Number.isFinite(s) ? Math.max(0, Math.round(s * 1000)) : null;
  }
  if (typeof dur === 'object') {
    const seconds = Number(dur.seconds || 0);
    const nanos = Number(dur.nanos || 0);
    if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) return null;
    return Math.max(0, Math.round(seconds * 1000 + nanos / 1e6));
  }
  return null;
};

const getRetryDelayMs = (resp, json, fallbackMs) => {
  // Prefer explicit server hints if available.
  const retryAfter = resp?.headers?.get?.('retry-after');
  if (retryAfter) {
    const s = Number(retryAfter);
    if (Number.isFinite(s)) return Math.max(0, Math.round(s * 1000));
  }

  // Google RPC RetryInfo (best-effort).
  const details = json?.error?.details;
  if (Array.isArray(details)) {
    const retryInfo = details.find((d) =>
      typeof d?.['@type'] === 'string' && d['@type'].includes('google.rpc.RetryInfo')
    );
    const ms = parseDurationToMs(retryInfo?.retryDelay);
    if (typeof ms === 'number') return ms;
  }

  return fallbackMs;
};

async function fetchWithRetry(url, options, { maxRetries = 3, baseDelayMs = 1000 } = {}) {
  let lastJson = null;
  let lastStatus = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const resp = await fetch(url, options);
    lastStatus = resp.status;

    let json = {};
    try {
      json = await resp.json();
    } catch {
      json = {};
    }
    lastJson = json;

    if (resp.ok) return { ok: true, status: resp.status, json };

    const isRateLimit = resp.status === 429;
    if (!isRateLimit) return { ok: false, status: resp.status, json };

    const fallback = baseDelayMs * 2 ** attempt; // 1s, 2s, 4s
    const delayMs = getRetryDelayMs(resp, json, fallback);
    console.error(`[Gemini] 429 rate limit. Retry ${attempt + 1}/${maxRetries} after ${delayMs}ms`, {
      status: resp.status,
      error: json?.error?.message,
    });
    await sleep(delayMs);
  }

  return { ok: false, status: lastStatus || 429, json: lastJson || {} };
}

const URI = process.env.REACT_APP_MONGODB_URI || process.env.MONGODB_URI || process.env.REACT_APP_MONGO_URI;
const DB = 'chatapp';

let db;

async function connect() {
  const client = await MongoClient.connect(URI);
  db = client.db(DB);
  console.log('MongoDB connected');
}

app.get('/', (req, res) => {
  res.send(`
    <html>
      <body style="font-family:sans-serif;padding:2rem;background:#00356b;color:white;min-height:100vh;display:flex;align-items:center;justify-content:center;margin:0">
        <div style="text-align:center">
          <h1>Chat API Server</h1>
          <p>Backend is running. Use the React app at <a href="http://localhost:3000" style="color:#ffd700">localhost:3000</a></p>
          <p><a href="/api/status" style="color:#ffd700">Check DB status</a></p>
        </div>
      </body>
    </html>
  `);
});

app.get('/api/status', async (req, res) => {
  try {
    const usersCount = await db.collection('users').countDocuments();
    const sessionsCount = await db.collection('sessions').countDocuments();
    res.json({ usersCount, sessionsCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Image generation (Google Gemini image model) ──────────────────────────────

app.post('/api/images/generate', async (req, res) => {
  try {
    const { prompt, anchorImageBase64 } = req.body || {};
    const text = typeof prompt === 'string' ? prompt.trim() : '';
    if (!text) return res.status(400).json({ error: 'prompt is required' });

    // Prefer server-side secret name, but keep backward compatibility with existing .env usage.
    const apiKey =
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      process.env.REACT_APP_GEMINI_API_KEY ||
      '';
    if (!apiKey) return res.status(500).json({ error: 'Missing Gemini API key on server' });

    const parts = [{ text }];
    if (typeof anchorImageBase64 === 'string' && anchorImageBase64.trim()) {
      // Best-effort: treat as PNG if mime type is unknown.
      parts.push({ inlineData: { mimeType: 'image/png', data: anchorImageBase64.trim() } });
    }

    const IMAGE_MODEL = 'gemini-2.5-flash-image';
    const IMAGE_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const result = await fetchWithRetry(
      IMAGE_ENDPOINT,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
        }),
      },
      { maxRetries: 3, baseDelayMs: 1000 }
    );

    if (!result.ok) {
      const msg =
        result.status === 429
          ? 'Rate limit hit, please retry in ~60 seconds.'
          : result.json?.error?.message || 'Image generation failed';
      console.error('[generateImage] Gemini image API error:', { model: IMAGE_MODEL, status: result.status, error: result.json });
      return res.status(result.status || 500).json({ error: msg });
    }

    const outParts = result.json?.candidates?.[0]?.content?.parts || [];
    const imgPart = outParts.find((p) => p.inlineData?.data && p.inlineData?.mimeType?.startsWith('image/'));
    if (!imgPart) {
      console.error('[generateImage] No image in response:', { model: IMAGE_MODEL, response: result.json });
      return res.status(500).json({ error: 'No image returned by model' });
    }

    // Preferred output shape for HW5
    res.json({ imageBase64: imgPart.inlineData.data });
  } catch (err) {
    console.error('[generateImage] Unexpected error:', err);
    res.status(500).json({ error: err?.message || 'Unexpected error' });
  }
});

// ── YouTube channel download (SSE job) ───────────────────────────────────────

const youtubeJobs = new Map(); // jobId -> { status, total, completed, results, createdAt, error }
const youtubeStreams = new Map(); // jobId -> Set(res)

function sseSend(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function attachStream(jobId, res) {
  if (!youtubeStreams.has(jobId)) youtubeStreams.set(jobId, new Set());
  youtubeStreams.get(jobId).add(res);
}

function broadcast(jobId, event, data) {
  const set = youtubeStreams.get(jobId);
  if (!set) return;
  for (const res of set) {
    try {
      sseSend(res, event, data);
    } catch {
      // ignore broken pipes
    }
  }
}

function closeStreams(jobId) {
  const set = youtubeStreams.get(jobId);
  if (!set) return;
  for (const res of set) {
    try {
      res.end();
    } catch {
      // ignore
    }
  }
  youtubeStreams.delete(jobId);
}

app.post('/api/youtube/jobs', async (req, res) => {
  try {
    const { channelUrl, maxVideos } = req.body || {};
    if (!channelUrl || typeof channelUrl !== 'string') {
      return res.status(400).json({ error: 'channelUrl is required' });
    }
    const max = clampInt(maxVideos, 1, 100, 10);

    const jobId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    youtubeJobs.set(jobId, {
      status: 'running',
      total: max,
      completed: 0,
      results: [],
      createdAt: new Date().toISOString(),
      error: null,
      channelUrl,
      maxVideos: max,
    });

    // Kick off async download.
    (async () => {
      try {
        broadcast(jobId, 'status', { status: 'starting' });
        const { total, results } = await downloadChannelData(channelUrl, max, (p) => {
          const job = youtubeJobs.get(jobId);
          if (!job) return;
          job.completed = p.completed;
          // p.total is safe to read during download; `total` is only available after completion.
          if (typeof p.total === 'number') job.total = p.total;
          broadcast(jobId, 'progress', p);
        });

        const job = youtubeJobs.get(jobId);
        if (!job) return;
        job.status = 'done';
        job.total = total;
        job.completed = total;
        job.results = results;
        broadcast(jobId, 'done', { ok: true, jobId, total });
      } catch (e) {
        const job = youtubeJobs.get(jobId);
        if (job) {
          job.status = 'error';
          job.error = e?.message || String(e);
        }
        broadcast(jobId, 'error', { error: e?.message || String(e) });
      } finally {
        closeStreams(jobId);
      }
    })();

    res.json({ ok: true, jobId, maxVideos: max });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/youtube/jobs/:jobId/stream', (req, res) => {
  const { jobId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  attachStream(jobId, res);

  // Send current job state immediately if available.
  const job = youtubeJobs.get(jobId);
  if (job) {
    sseSend(res, 'status', { status: job.status, completed: job.completed, total: job.total });
    if (job.status === 'done') sseSend(res, 'done', { ok: true, jobId, total: job.total });
    if (job.status === 'error') sseSend(res, 'error', { error: job.error || 'Unknown error' });
  } else {
    sseSend(res, 'error', { error: 'Unknown jobId' });
  }

  req.on('close', () => {
    const set = youtubeStreams.get(jobId);
    if (set) set.delete(res);
  });
});

app.get('/api/youtube/jobs/:jobId/result', (req, res) => {
  const { jobId } = req.params;
  const job = youtubeJobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Unknown jobId' });
  if (job.status !== 'done') return res.status(400).json({ error: `Job not done: ${job.status}` });
  res.json(job.results || []);
});

app.get('/api/youtube/jobs/:jobId/status', (req, res) => {
  const { jobId } = req.params;
  const job = youtubeJobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Unknown jobId' });
  res.json({
    status: job.status,
    completed: job.completed,
    total: job.total,
    error: job.error || null,
  });
});

// ── Users ────────────────────────────────────────────────────────────────────

app.post('/api/users', async (req, res) => {
  try {
    const { username, password, email, firstName, lastName } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    if (!firstName || !lastName) {
      return res.status(400).json({ error: 'First name and last name required' });
    }
    const name = String(username).trim().toLowerCase();
    const existing = await db.collection('users').findOne({ username: name });
    if (existing) return res.status(400).json({ error: 'Username already exists' });
    const hashed = await bcrypt.hash(password, 10);
    const cleanFirst = String(firstName).trim();
    const cleanLast = String(lastName).trim();
    if (!cleanFirst || !cleanLast) {
      return res.status(400).json({ error: 'First name and last name required' });
    }
    await db.collection('users').insertOne({
      username: name,
      password: hashed,
      email: email ? String(email).trim().toLowerCase() : null,
      firstName: cleanFirst,
      lastName: cleanLast,
      createdAt: new Date().toISOString(),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password required' });
    const name = username.trim().toLowerCase();
    const user = await db.collection('users').findOne({ username: name });
    if (!user) return res.status(401).json({ error: 'User not found' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid password' });
    // Backward compatible: older users may not have names yet.
    const firstName = typeof user.firstName === 'string' ? user.firstName : '';
    const lastName = typeof user.lastName === 'string' ? user.lastName : '';
    res.json({
      ok: true,
      username: name, // kept for older frontend clients
      user: {
        username: name,
        email: user.email || null,
        firstName,
        lastName,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sessions ─────────────────────────────────────────────────────────────────

app.get('/api/sessions', async (req, res) => {
  try {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: 'username required' });
    const sessions = await db
      .collection('sessions')
      .find({ username })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(
      sessions.map((s) => ({
        id: s._id.toString(),
        agent: s.agent || null,
        title: s.title || null,
        createdAt: s.createdAt,
        messageCount: (s.messages || []).length,
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions', async (req, res) => {
  try {
    const { username, agent } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });
    const { title } = req.body;
    const result = await db.collection('sessions').insertOne({
      username,
      agent: agent || null,
      title: title || null,
      createdAt: new Date().toISOString(),
      messages: [],
    });
    res.json({ id: result.insertedId.toString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/sessions/:id', async (req, res) => {
  try {
    await db.collection('sessions').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/sessions/:id/title', async (req, res) => {
  try {
    const { title } = req.body;
    await db.collection('sessions').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { title } }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Messages ─────────────────────────────────────────────────────────────────

app.post('/api/messages', async (req, res) => {
  try {
    const { session_id, role, content, imageData, charts, toolCalls } = req.body;
    if (!session_id || !role || content === undefined)
      return res.status(400).json({ error: 'session_id, role, content required' });
    const msg = {
      role,
      content,
      timestamp: new Date().toISOString(),
      ...(imageData && {
        imageData: Array.isArray(imageData) ? imageData : [imageData],
      }),
      ...(charts?.length && { charts }),
      ...(toolCalls?.length && { toolCalls }),
    };
    await db.collection('sessions').updateOne(
      { _id: new ObjectId(session_id) },
      { $push: { messages: msg } }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/messages', async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: 'session_id required' });
    const doc = await db
      .collection('sessions')
      .findOne({ _id: new ObjectId(session_id) });
    const raw = doc?.messages || [];
    const msgs = raw.map((m, i) => {
      const arr = m.imageData
        ? Array.isArray(m.imageData)
          ? m.imageData
          : [m.imageData]
        : [];
      return {
        id: `${doc._id}-${i}`,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        images: arr.length
          ? arr.map((img) => ({ data: img.data, mimeType: img.mimeType }))
          : undefined,
        charts: m.charts?.length ? m.charts : undefined,
        toolCalls: m.toolCalls?.length ? m.toolCalls : undefined,
      };
    });
    res.json(msgs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;

connect()
  .then(() => {
    app.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });
