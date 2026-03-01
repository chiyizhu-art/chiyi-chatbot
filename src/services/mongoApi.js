const API = process.env.REACT_APP_API_URL || '';

const api = async (path, options = {}) => {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text || res.statusText);
  return text ? JSON.parse(text) : {};
};

export const getYouTubeStreamUrl = (jobId) => {
  // EventSource requires an absolute URL in some production setups.
  // If API is empty, use relative URL (dev proxy).
  return `${API}/api/youtube/jobs/${encodeURIComponent(jobId)}/stream`;
};

// ── Users ────────────────────────────────────────────────────────────────────

export const createUser = async (username, password, email = '', firstName, lastName) => {
  await api('/api/users', {
    method: 'POST',
    body: JSON.stringify({ username, password, email, firstName, lastName }),
  });
};

export const findUser = async (username, password) => {
  const data = await api('/api/users/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  if (!data.ok) return null;
  if (data.user && typeof data.user === 'object') return data.user;
  // Backward compatible with older backend responses.
  return data.username ? { username: data.username, firstName: '', lastName: '' } : null;
};

// ── Sessions ─────────────────────────────────────────────────────────────────

export const getSessions = async (username) => {
  return api(`/api/sessions?username=${encodeURIComponent(username)}`);
};

export const createSession = async (username, agent = null, title = null) => {
  return api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ username, agent, title }),
  });
};

export const deleteSession = async (sessionId) => {
  return api(`/api/sessions/${sessionId}`, { method: 'DELETE' });
};

export const updateSessionTitle = async (sessionId, title) => {
  return api(`/api/sessions/${sessionId}/title`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
};

// ── Messages ─────────────────────────────────────────────────────────────────

export const saveMessage = async (sessionId, role, content, imageData = null, charts = null, toolCalls = null) => {
  return api('/api/messages', {
    method: 'POST',
    body: JSON.stringify({ session_id: sessionId, role, content, imageData, charts, toolCalls }),
  });
};

export const loadMessages = async (sessionId) => {
  return api(`/api/messages?session_id=${encodeURIComponent(sessionId)}`);
};

// ── YouTube ──────────────────────────────────────────────────────────────────

export const createYouTubeJob = async (channelUrl, maxVideos) => {
  return api('/api/youtube/jobs', {
    method: 'POST',
    body: JSON.stringify({ channelUrl, maxVideos }),
  });
};

export const getYouTubeJobResult = async (jobId) => {
  return api(`/api/youtube/jobs/${encodeURIComponent(jobId)}/result`);
};
