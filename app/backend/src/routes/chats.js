import { Router } from 'express';
import fs from 'node:fs';

// 聊天归档（每通道一个 聊天.xlsx）的列表与下载入口
export default function createChatsRouter({ storage }) {
  const r = Router();

  // 各通道聊天归档概览：{ channel, rows, hasVoice, size, downloadUrl }
  r.get('/', (req, res) => res.json(storage.listChatArchives()));

  // 下载某通道的 聊天.xlsx
  // 显式构造 Content-Disposition：legacy 部分只用 ASCII（防 Node 的 setHeader
  // 在非 ASCII 字节上报 ERR_INVALID_CHAR），真实名走 RFC 5987 的 filename*。
  // 同时给出可读 404，便于区分"通道没消息"和"服务器出错"。
  r.get('/:channel/xlsx', (req, res) => {
    const channel = decodeURIComponent(req.params.channel);
    const file = storage.chatFileFor(channel);
    if (!fs.existsSync(file)) {
      return res.status(404).json({ error: 'not found', message: '该通道的聊天归档尚未生成或没有聊天类消息' });
    }
    const display = `${channel}-聊天.xlsx`;
    const ascii = String(channel).replace(/[^\x20-\x7E]/g, '_') || 'channel';
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set(
      'Content-Disposition',
      `attachment; filename="${ascii}-chat.xlsx"; filename*=UTF-8''${encodeURIComponent(display)}`,
    );
    res.set('Content-Length', String(fs.statSync(file).size));
    fs.createReadStream(file).pipe(res);
  });

  return r;
}
