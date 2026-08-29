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

const DEFAULT_TIMEOUT = 15000;

async function getJson(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || DEFAULT_TIMEOUT);
  try {
    const res = await fetch(apiUrl(url), {
      headers: { 'content-type': 'application/json' },
      ...opts,
      signal: ctrl.signal,
    });
    // 任何非 2xx 都视为失败，抛出可读错误（后端 {error} 优先）
    if (!res.ok) {
      let msg = `请求失败 (HTTP ${res.status})`;
      try {
        const body = await res.json();
        if (body && body.error) msg = String(body.error);
      } catch {
        /* 响应体非 JSON 时忽略解析错误，沿用默认文案 */
      }
      throw new Error(msg);
    }
    return await res.json();
  } catch (e) {
    // 超时 abort 也会走到这里，保留原始错误文案
    if (e.name === 'AbortError') throw new Error('请求超时，请检查网络或后端');
    throw e;
  } finally {
    clearTimeout(timer);
  }
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
  deleteMessage: (id) => getJson(`/api/messages/${id}`, { method: 'DELETE' }),
  folders: () => getJson('/api/folders'),
  chats: () => getJson('/api/chats'),
  // 直接给 <audio src> / <img src> / <a download> 用，必须自带网关前缀
  voiceUrl: (id) => apiUrl(`/api/voice/${id}`),
  mediaUrl: (id) => apiUrl(`/api/media/${id}`),
  // 缩略图：后端按需缩放，列表/详情用更小的带宽（w 默认 320，详情可传更大）
  thumbUrl: (id, w = 320) => apiUrl(`/api/media/thumb/${id}?w=${w}`),
  // 媒体元信息：文件名 / 大小 / MIME / 扩展名，供「文件预览」展示
  mediaInfo: (id) => getJson(`/api/media/info/${id}`),
  about: () => getJson('/api/about'),
  getSettings: () => getJson('/api/settings'),
  saveSettings: (body) =>
    getJson('/api/settings', { method: 'POST', body: JSON.stringify(body) }),
  testAI: (cfg) =>
    getJson('/api/settings/test', { method: 'POST', body: JSON.stringify(cfg) }),
};

// 单例重连守卫：保证任意时刻最多只有一个重连定时器在跑，
// 避免断网抖动时每次 onclose 都新建一个定时器导致定时器堆积、CPU/内存上涨。
let reconnectTimer = null;
let wsClosedByUser = false;

export function connectWS(onEvent) {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
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
  ws.onopen = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };
  ws.onclose = () => {
    if (wsClosedByUser) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => connectWS(onEvent), 3000);
  };
  return ws;
}
