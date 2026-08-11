// Provider 抽象基类：所有 bot 接入协议（微信 ClawBot / Telegram / Webhook / 办公 IM 等）
// 都实现这一统一接口，Manager 与前端无需关心具体协议差异。
//
// 生命周期：
//   startLogin()  -> 发起登录/连接，返回给前端的展示信息（二维码 / 连接说明）
//   resume()      -> 进程重启后恢复（长轮询类需重连，Webhook 类直接置为已连接）
//   start()       -> 启动接收循环（仅长轮询/WS 类需要；Webhook 类由 HTTP 路由触发）
//   stop()        -> 停止
//   send()        -> 可选：主动外发（默认不启用回执，但保留能力）
//   handleInbound(body, headers) -> Webhook 类入站：把平台回调归一化为 { peer, text }
//
// 共享状态（Provider 直接读写 channel 上的字段）：
//   channel.loggedIn / channel.needRescan / channel.qrcode / channel.qrcodeImg /
//   channel.qrcodeDataUrl —— 这些都是前端展示用的通用字段。
//   收到消息时调用 channel.deliver({ peer, text, contextToken, ts, raw }) 进入归档链路。
//   状态变化后调用 channel._emitStatus() 触发广播。

export class Provider {
  constructor({ channel }) {
    this.channel = channel;
  }

  // 便捷读取该通道的 provider 配置
  get cfg() {
    return this.channel.providerConfig || {};
  }

  // 默认实现：Webhook 类无需扫码，配置存在即视为已连接
  async startLogin() {
    this.channel.loggedIn = this._configured();
    this.channel.needRescan = false;
    this.channel._emitStatus();
    return {};
  }

  // 默认恢复：配置在即连接
  resume() {
    this.channel.loggedIn = this._configured();
    this.channel.needRescan = false;
  }

  start() {}
  stop() {}

  async send(/* peer, text, ctx */) {
    throw new Error('该 Provider 未实现主动发送');
  }

  // Webhook 类必须实现：把平台回调体归一化
  handleInbound(/* body, headers */) {
    return null;
  }

  // 持久化：返回需要保存的额外状态对象
  toJSON() {
    return {};
  }

  // 恢复：读入持久化的额外状态
  applyState(/* state */) {}

  // 配置是否齐备（用于判定"已连接"）
  _configured() {
    return true;
  }
}
