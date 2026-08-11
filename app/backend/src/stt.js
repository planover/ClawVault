import fs from 'node:fs';
import path from 'node:path';
import config from './config.js';

// 语音转文字（AI 补转）：仅在社交软件端未提供转写、且配置了兼容 OpenAI 的
// /v1/audio/transcriptions 端点时才调用。未配置则优雅返回 null（不消耗任何 AI）。
// 注意：分类用的 LLM（Anthropic /v1/messages）不能处理音频，故语音转写走独立 STT 端点。
export async function transcribeVoice(relativePath) {
  const { sttUrl, apiKey, sttModel } = config.ai;
  if (!sttUrl || !apiKey) return null;
  const abs = relativePath.startsWith('/') ? relativePath : path.join(config.archiveRoot, relativePath);
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return null;
  }
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/mpeg' }), path.basename(abs));
  form.append('model', sttModel || 'whisper-1');
  try {
    const res = await fetch(sttUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return data?.text ? String(data.text).trim() : null;
  } catch {
    return null;
  }
}
