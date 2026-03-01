const path = require('path');
const fs = require('fs/promises');
const YTDlpWrap = require('yt-dlp-wrap').default;
const { YoutubeTranscript } = require('youtube-transcript');

const BIN_DIR = path.join(__dirname, '.cache');
const BIN_PATH = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureYtDlp() {
  if (await fileExists(BIN_PATH)) return BIN_PATH;
  await fs.mkdir(BIN_DIR, { recursive: true });
  // Downloads the platform-specific yt-dlp binary from GitHub releases.
  await YTDlpWrap.downloadFromGithub(BIN_PATH);
  return BIN_PATH;
}

function clampInt(n, min, max, fallback) {
  const x = Number.parseInt(n, 10);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, x));
}

function ensureVideosTabUrl(channelUrl) {
  const u = String(channelUrl || '').trim();
  if (!u) return u;
  if (u.includes('/videos')) return u;
  // yt-dlp treats handle/channel root as a collection of playlists (Videos/Shorts).
  // Adding `/videos` reliably yields a flat playlist of actual video IDs.
  return u.replace(/\/$/, '') + '/videos';
}

function normalizeVideoUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function parseUploadDate(uploadDate) {
  // yt-dlp often returns upload_date as YYYYMMDD
  if (typeof uploadDate !== 'string' || uploadDate.length !== 8) return null;
  const y = uploadDate.slice(0, 4);
  const m = uploadDate.slice(4, 6);
  const d = uploadDate.slice(6, 8);
  return `${y}-${m}-${d}`;
}

async function fetchTranscriptBestEffort(videoId) {
  try {
    const items = await YoutubeTranscript.fetchTranscript(videoId);
    if (!Array.isArray(items) || items.length === 0) return null;
    return items
      .map((t) => (typeof t.text === 'string' ? t.text.trim() : ''))
      .filter(Boolean)
      .join(' ');
  } catch {
    return null;
  }
}

async function listVideoIds(channelUrl, maxVideos) {
  const max = clampInt(maxVideos, 1, 100, 10);
  const ytDlpPath = await ensureYtDlp();
  const ytdlp = new YTDlpWrap(ytDlpPath);

  // Flat playlist fetch is fast and works for @handle, /c/, /channel/ URLs.
  const json = await ytdlp.execPromise([
    ensureVideosTabUrl(channelUrl),
    '--flat-playlist',
    '--dump-single-json',
    '--playlist-end',
    String(max),
    '--no-warnings',
  ]);

  const parsed = JSON.parse(json);
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  return entries
    .map((e) => (e && typeof e.id === 'string' ? e.id : null))
    .filter(Boolean)
    .slice(0, max);
}

async function fetchVideoMeta(videoId) {
  const ytDlpPath = await ensureYtDlp();
  const ytdlp = new YTDlpWrap(ytDlpPath);
  const url = normalizeVideoUrl(videoId);
  const json = await ytdlp.execPromise([
    url,
    '--dump-single-json',
    '--skip-download',
    '--no-warnings',
  ]);

  const v = JSON.parse(json);
  const thumb =
    v.thumbnail ||
    (Array.isArray(v.thumbnails) && v.thumbnails.length
      ? v.thumbnails[v.thumbnails.length - 1]?.url
      : null);

  const uploadDate = parseUploadDate(v.upload_date) || (v.timestamp ? new Date(v.timestamp * 1000).toISOString() : null);

  return {
    video_id: v.id || videoId,
    title: v.title || '',
    description: v.description || '',
    transcript: null, // filled separately
    duration_seconds: typeof v.duration === 'number' ? v.duration : null,
    duration_iso: typeof v.duration_string === 'string' ? v.duration_string : null,
    release_date: uploadDate,
    view_count: typeof v.view_count === 'number' ? v.view_count : null,
    like_count: typeof v.like_count === 'number' ? v.like_count : null,
    comment_count: typeof v.comment_count === 'number' ? v.comment_count : null,
    video_url: v.webpage_url || url,
    thumbnail_url: thumb || null,
  };
}

async function downloadChannelData(channelUrl, maxVideos, onProgress) {
  const ids = await listVideoIds(channelUrl, maxVideos);
  const total = ids.length;
  const results = [];

  for (let i = 0; i < ids.length; i++) {
    const videoId = ids[i];
    let item = null;
    let error = null;
    try {
      item = await fetchVideoMeta(videoId);
      item.transcript = await fetchTranscriptBestEffort(videoId);
      results.push(item);
    } catch (e) {
      error = e?.message || String(e);
      // Non-fatal per spec.
      results.push({
        video_id: videoId,
        title: '',
        description: '',
        transcript: null,
        duration_seconds: null,
        duration_iso: null,
        release_date: null,
        view_count: null,
        like_count: null,
        comment_count: null,
        video_url: normalizeVideoUrl(videoId),
        thumbnail_url: null,
        error,
      });
    }

    if (typeof onProgress === 'function') {
      onProgress({
        completed: i + 1,
        total,
        video_id: videoId,
        error,
        item,
      });
    }
  }

  return { total, results };
}

module.exports = {
  downloadChannelData,
  clampInt,
};

