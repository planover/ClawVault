// 后端 REST + WebSocket 封装（同源）
//
// 飞牛统一网关会把应用挂在 /app/clawvault/ 前缀下，因此所有请求都必须带前缀。
// 该前缀由 Vite 的 base 配置注入（import.meta.env.BASE_URL）：
//   - 发布构建：'/app/clawvault/' → BASE = '/app/clawvault'
//   - 本地开发：'/'               → BASE = ''
// 这样同一份代码在飞牛窗口内和 vite dev 下都能正确寻址。
const BASE = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');

// 导出给组件拼接静态资源用
export const basePath = BASE;

function apiUrl(p) {
  return BASE + p;
}

async function getJson(url, opts = {}) {
  const res = await fetch(apiUrl(url), {
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
  renameChannel: (id, name) =>
    getJson(`/api/channels/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ name }),
    }),
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
  // 直接给 <audio src> / <img src> / <a download> 用，必须自带网关前缀
  voiceUrl: (id) => apiUrl(`/api/voice/${id}`),
  mediaUrl: (id) => apiUrl(`/api/media/${id}`),
  about: () => getJson('/api/about'),
  getSettings: () => getJson('/api/settings'),
  saveSettings: (body) =>
    getJson('/api/settings', { method: 'POST', body: JSON.stringify(body) }),
  testAI: (cfg) =>
    getJson('/api/settings/test', { method: 'POST', body: JSON.stringify(cfg) }),
};

export function connectWS(onEvent) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // 网关模式下 WS 也走同一前缀（/app/clawvault/ws），由网关转发到同一个 Unix Socket
  const ws = new WebSocket(`${proto}://${location.host}${BASE}/ws`);
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
