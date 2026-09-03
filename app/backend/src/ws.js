import { WebSocketServer } from 'ws';

// WebSocket 实时广播（新消息、重分类、通道状态变化）
export class WSBroadcaster {
  constructor() {
    this.wss = null;
    this.clients = new Set();
    this.requireGatewayAuth = false; // 生产态置 true：WebSocket 升级也须携带网关注入身份头
  }

  // wsPath：WebSocket 挂载路径。飞牛统一网关模式下必须带网关前缀
  // （如 /app/clawvault/ws）——升级请求不经过 express 的前缀剥离中间件，
  // ws 库是拿原始 req.url 与 path 比对的。
  attach(server, wsPath = '/ws') {
    this.wss = new WebSocketServer({ server, path: wsPath || '/ws' });
    this.wss.on('connection', (ws, req) => {
      // 纵深防御（OPS-P0-02）：生产态要求升级请求携带网关注入身份头，直连 socket 无头则断开
      if (this.requireGatewayAuth && !req?.headers?.['x-trim-userid']) {
        ws.terminate();
        return;
      }
      // 网关在建立连接时同样注入身份 Header，按官方要求把连接绑定到 uid
      ws.fnUid = req?.headers?.['x-trim-userid'] ? String(req.headers['x-trim-userid']) : null;
      this.clients.add(ws);
      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => this.clients.delete(ws));
    });
  }

  broadcast(obj) {
    const msg = JSON.stringify(obj);
    for (const ws of this.clients) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }
}
