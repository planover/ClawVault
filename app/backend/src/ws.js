import { WebSocketServer } from 'ws';

// WebSocket 实时广播（新消息、重分类、通道状态变化）
export class WSBroadcaster {
  constructor() {
    this.wss = null;
    this.clients = new Set();
  }

  attach(server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (ws) => {
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
