// Provider 注册表：新增一种 bot 接入，只需在此登记并实现 Provider 子类。
import { WeChatIlinkProvider } from './wechat_ilink.js';
import { WebhookProvider } from './webhook.js';
import { TelegramProvider } from './telegram.js';
import { OfficeProvider } from './office.js';
import { DiscordSlackProvider } from './discord_slack.js';

// 每种 Provider 的元数据用于前端渲染"添加通道"表单
export const PROVIDERS = {
  wechat_ilink: {
    id: 'wechat_ilink',
    name: '微信 ClawBot',
    desc: '腾讯 iLink 协议，微信扫码登录，私聊消息归档',
    icon: '💬',
    auth: 'qr',
    configFields: [],
  },
  webhook: {
    id: 'webhook',
    name: '通用 Webhook（万能接入）',
    desc: '任意能推 HTTP、能调 API 的 bot / 脚本 / 平台都能接',
    icon: '🔗',
    auth: 'webhook',
    configFields: [
      { key: 'send_url', label: '出站发送地址（可选）', type: 'text', placeholder: 'https://...  留空则只收不回', required: false },
      { key: 'send_method', label: '出站方法', type: 'select', options: ['POST', 'GET'], required: false },
      { key: 'send_token', label: '出站鉴权 Token（可选）', type: 'password', required: false },
    ],
  },
  telegram: {
    id: 'telegram',
    name: 'Telegram',
    desc: 'BotFather Token + getUpdates 长轮询',
    icon: '✈️',
    auth: 'token',
    configFields: [{ key: 'bot_token', label: 'Bot Token', type: 'password', placeholder: '123456:ABCdef...', required: true }],
  },
  office: {
    id: 'office',
    name: '钉钉 / 飞书 / 企业微信',
    desc: '办公 IM 群机器人 Webhook 接入',
    icon: '🏢',
    auth: 'webhook',
    configFields: [
      { key: 'platform', label: '平台', type: 'select', options: ['feishu', 'dingtalk', 'wecom'], required: true },
      { key: 'outgoing_url', label: '群机器人 Webhook 地址', type: 'text', placeholder: 'https://open.feishu.cn/... 或 https://oapi.dingtalk.com/...', required: true },
      { key: 'secret', label: '加签密钥（可选）', type: 'password', required: false },
    ],
  },
  discord_slack: {
    id: 'discord_slack',
    name: 'Discord / Slack',
    desc: '协作工具 Webhook / Events 接入',
    icon: '🤖',
    auth: 'webhook',
    configFields: [
      { key: 'platform', label: '平台', type: 'select', options: ['slack', 'discord'], required: true },
      { key: 'outgoing_url', label: 'Incoming Webhook 地址', type: 'text', placeholder: 'https://hooks.slack.com/... 或 https://discord.com/api/webhooks/...', required: true },
    ],
  },
};

export function getProviderClass(type) {
  switch (type) {
    case 'wechat_ilink':
      return WeChatIlinkProvider;
    case 'webhook':
      return WebhookProvider;
    case 'telegram':
      return TelegramProvider;
    case 'office':
      return OfficeProvider;
    case 'discord_slack':
      return DiscordSlackProvider;
    default:
      return WebhookProvider; // 未知类型兜底为通用 Webhook
  }
}

export function getProvider(type, ctx) {
  const Cls = getProviderClass(type);
  return new Cls(ctx);
}

export function listProviders() {
  return Object.values(PROVIDERS);
}
