import { Router } from 'express';
import fs from 'node:fs';

// 聊天归档（每通道一个 聊天.xlsx）的列表与下载入口
export default function createChatsRouter({ storage }) {
  const r = Router();

  // 各通道聊天归档概览：{ channel, rows, hasVoice, size, downloadUrl }
  r.get('/', (req, res) => res.json(storage.listChatArchives()));

  // 下载某通道的 聊天.xlsx
  r.get('/:channel/xlsx', (req, res) => {
    const channel = decodeURIComponent(req.params.channel);
    const file = storage.chatFileFor(channel);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'not found' });
    res.download(file, `${channel}-聊天.xlsx`);
  });

  return r;
}
