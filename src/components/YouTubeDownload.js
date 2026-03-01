import { useEffect, useMemo, useRef, useState } from 'react';
import { createYouTubeJob, getYouTubeJobResult, getYouTubeStreamUrl } from '../services/mongoApi';
import './YouTubeDownload.css';

function clamp(n, min, max) {
  const x = Number.parseInt(n, 10);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function safeFilename(s) {
  return String(s || 'channel')
    .replace(/^https?:\/\//, '')
    .replace(/[^\w.-]+/g, '_')
    .slice(0, 60);
}

export default function YouTubeDownload({ user }) {
  const [channelUrl, setChannelUrl] = useState('https://www.youtube.com/@veritasium');
  const [maxVideos, setMaxVideos] = useState(10);
  const [status, setStatus] = useState('');
  const [jobId, setJobId] = useState(null);
  const [total, setTotal] = useState(0);
  const [completed, setCompleted] = useState(0);
  const [errors, setErrors] = useState([]);
  const [results, setResults] = useState(null);
  const [downloading, setDownloading] = useState(false);

  const esRef = useRef(null);

  const progressPct = useMemo(() => {
    if (!total) return 0;
    return Math.round((completed / total) * 100);
  }, [completed, total]);

  useEffect(() => {
    return () => {
      try {
        esRef.current?.close();
      } catch {
        // ignore
      }
    };
  }, []);

  const startDownload = async () => {
    setResults(null);
    setErrors([]);
    setStatus('');
    setCompleted(0);
    setTotal(0);
    setDownloading(true);

    const max = clamp(maxVideos, 1, 100);
    setMaxVideos(max);

    const resp = await createYouTubeJob(channelUrl.trim(), max);
    if (!resp?.ok) throw new Error('Failed to start job');
    setJobId(resp.jobId);
    setStatus('Starting…');

    const url = getYouTubeStreamUrl(resp.jobId);
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener('status', (e) => {
      try {
        const data = JSON.parse(e.data);
        setStatus(data.status || 'Working…');
        if (typeof data.total === 'number') setTotal(data.total);
        if (typeof data.completed === 'number') setCompleted(data.completed);
      } catch {
        // ignore
      }
    });

    es.addEventListener('progress', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (typeof data.total === 'number') setTotal(data.total);
        if (typeof data.completed === 'number') setCompleted(data.completed);
        if (data.error) {
          setErrors((prev) => [...prev, `${data.video_id}: ${data.error}`]);
        }
        setStatus(`Downloading ${data.completed} / ${data.total} …`);
      } catch {
        // ignore
      }
    });

    es.addEventListener('done', async (e) => {
      try {
        const data = JSON.parse(e.data);
        setStatus('Finalizing…');
        setTotal(data.total || total);
        setCompleted(data.total || completed);
      } catch {
        // ignore
      }
      try {
        es.close();
      } catch {
        // ignore
      }
      const json = await getYouTubeJobResult(resp.jobId);
      setResults(json);
      setStatus('Done.');
      setDownloading(false);
    });

    es.addEventListener('error', async (e) => {
      // EventSource uses "error" for connection errors too.
      setStatus('Error while downloading (see errors below).');
      setDownloading(false);
      try {
        es.close();
      } catch {
        // ignore
      }
      // If job actually finished quickly, allow user to still fetch results.
      try {
        const json = await getYouTubeJobResult(resp.jobId);
        if (Array.isArray(json)) setResults(json);
      } catch {
        // ignore
      }
    });
  };

  const downloadJson = () => {
    if (!results) return;
    const blob = new Blob([JSON.stringify(results, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `channel_${safeFilename(channelUrl)}_${results.length}videos.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="yt-page">
      <div className="yt-header">
        <div>
          <h2 className="yt-title">YouTube Channel Download</h2>
          <p className="yt-subtitle">
            Download metadata for a channel’s recent videos as JSON (titles, stats, duration, transcript if available).
          </p>
        </div>
        <div className="yt-user">
          Signed in as <span className="yt-user-name">{user?.firstName || user?.username || 'user'}</span>
        </div>
      </div>

      <div className="yt-card">
        <label className="yt-label">
          Channel URL
          <input
            className="yt-input"
            type="url"
            value={channelUrl}
            onChange={(e) => setChannelUrl(e.target.value)}
            placeholder="https://www.youtube.com/@veritasium"
            required
            disabled={downloading}
          />
        </label>

        <label className="yt-label">
          Max videos (1–100)
          <input
            className="yt-input"
            type="number"
            min={1}
            max={100}
            value={maxVideos}
            onChange={(e) => setMaxVideos(e.target.value)}
            disabled={downloading}
          />
        </label>

        <button className="yt-btn" onClick={startDownload} disabled={downloading || !channelUrl.trim()}>
          {downloading ? 'Downloading…' : 'Download Channel Data'}
        </button>

        {(downloading || status) && (
          <div className="yt-progress-wrap">
            <div className="yt-progress-meta">
              <span>{status || 'Working…'}</span>
              <span>
                {completed}/{total || '?'}
              </span>
            </div>
            <div className="yt-progress-bar">
              <div className="yt-progress-fill" style={{ width: `${progressPct}%` }} />
            </div>
          </div>
        )}

        {errors.length > 0 && (
          <div className="yt-errors">
            <div className="yt-errors-title">Non-fatal errors</div>
            <ul>
              {errors.slice(0, 10).map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
            {errors.length > 10 && <div className="yt-errors-more">…and {errors.length - 10} more</div>}
          </div>
        )}

        {Array.isArray(results) && (
          <div className="yt-done">
            <div className="yt-done-meta">
              Downloaded <b>{results.length}</b> videos.
              {jobId && (
                <>
                  {' '}
                  <span className="yt-done-job">Job: {jobId}</span>
                </>
              )}
            </div>
            <button className="yt-btn secondary" onClick={downloadJson}>
              Download JSON
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

