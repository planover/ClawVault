// 后端 REST + WebSocket 封装（同源）
async function getJson(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  return res.json();
}

export const api = {
  providers: () => getJson('/api/providers'),
  listChannels: () => getJson('/api/channels'),
  createChannel: (name, providerType, providerConfig) =>
    getJson('/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name, providerType, providerConfig }),
    }),
  deleteChannel: (id) => getJson(`/api/channels/${id}`, { method: 'DELETE' }),
  loginChannel: (id) => getJson(`/api/channels/${id}/login`, { method: 'POST' }),
  reLoginChannel: (id) => getJson(`/api/channels/${id}/relogin`, { method: 'POST' }),
  listMessages: (q = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) {
      if (v !== undefined && v !== null && v !== '') params.set(k, v);
    }
    const s = params.toString();
    return getJson('/api/messages' + (s ? '?' + s : ''));
  },
  reclassify: (id, category, sub) =>
    getJson(`/api/messages/${id}/reclassify`, {
      method: 'POST',
      body: JSON.stringify({ category, sub }),
    }),
  folders: () => getJson('/api/folders'),
  chats: () => getJson('/api/chats'),
  voiceUrl: (id) => `/api/voice/${id}`,
  mediaUrl: (id) => `/api/media/${id}`,
  getSettings: () => getJson('/api/settings'),
  saveSettings: (body) =>
    getJson('/api/settings', { method: 'POST', body: JSON.stringify(body) }),
  testAI: (cfg) =>
    getJson('/api/settings/test', { method: 'POST', body: JSON.stringify(cfg) }),
};

export function connectWS(onEvent) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data));
    } catch {
      /* ignore */
    }
  };
  ws.onclose = () => setTimeout(() => connectWS(onEvent), 3000);
  return ws;
}
