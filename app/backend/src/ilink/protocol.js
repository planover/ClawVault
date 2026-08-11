// iLink / 微信 ClawBot 协议封装
// 协议细节来自腾讯官方开放实现（openclaw-weixin / weixin-ClawBot-API）。
// 接入域名 ilinkai.weixin.qq.com，请求头需携带 ilink_bot_token 与 X-WECHAT-UIN。

export const BASE_URL = 'https://ilinkai.weixin.qq.com';
const CHANNEL_VERSION = '1.0.2';

function randomUin() {
  const n = Math.floor(Math.random() * 0xffffffff);
  return Buffer.from(String(n)).toString('base64');
}

export function makeHeaders(token) {
  const h = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomUin(),
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function apiPost(path, body, token, baseUrl) {
  const url = `${baseUrl || BASE_URL}/${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: makeHeaders(token),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// 获取登录二维码：GET /ilink/bot/get_bot_qrcode?bot_type=3
export async function getQRCode() {
  const url = `${BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`;
  const res = await fetch(url, { headers: makeHeaders() });
  return res.json();
}

// 轮询扫码状态：GET /ilink/bot/get_qrcode_status?qrcode=xxx
// 返回 { status: "confirmed"|..., bot_token, baseurl }
export async function getQRCodeStatus(qrcode) {
  const url = `${BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const res = await fetch(url, { headers: makeHeaders() });
  return res.json();
}

// 长轮询接收消息：POST /ilink/bot/getupdates
export function getUpdates(token, baseUrl, buf) {
  return apiPost(
    'ilink/bot/getupdates',
    { get_updates_buf: buf || '', base_info: { channel_version: CHANNEL_VERSION } },
    token,
    baseUrl,
  );
}

// 获取账号配置（typing ticket 等）：POST /ilink/bot/getconfig
export function getConfig(token, baseUrl, ilinkUserId, contextToken) {
  return apiPost(
    'ilink/bot/getconfig',
    { ilink_user_id: ilinkUserId, context_token: contextToken, base_info: { channel_version: CHANNEL_VERSION } },
    token,
    baseUrl,
  );
}

// 发送「正在输入」状态：POST /ilink/bot/sendtyping  { status: 1 | 2 }
export function sendTyping(token, baseUrl, ilinkUserId, typingTicket, status) {
  return apiPost(
    'ilink/bot/sendtyping',
    { ilink_user_id: ilinkUserId, typing_ticket: typingTicket, status },
    token,
    baseUrl,
  );
}

// 发送文本消息（用于可选回执，默认不启用）：POST /ilink/bot/sendmessage
export function sendMessage(token, baseUrl, toUserId, contextToken, text) {
  const clientId = `openclaw-weixin-${Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')}`;
  return apiPost(
    'ilink/bot/sendmessage',
    {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      },
      base_info: { channel_version: CHANNEL_VERSION },
    },
    token,
    baseUrl,
  );
}
