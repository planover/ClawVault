import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  pdf: 'application/pdf',
  txt: 'text/plain',
  json: 'application/json',
  csv: 'text/csv',
  md: 'text/markdown',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  tgz: 'application/gzip',
};

// 媒体文件服务：按消息 id 取落盘的图片/文件/视频，支持 Range 以便大文件/视频拖动。
// 与语音路由一致，强制校验路径落在归档根内，防止 media 字段被构造导致路径穿越。
function contentDisposition(filename) {
  const plain = String(filename).replace(/["\\]/g, '');
  // RFC 6266：legacy `filename="..."` 只对可打印 ASCII 安全。Node 的 setHeader
  // 会拒绝带非 ASCII 字节的 header 值（抛 ERR_INVALID_CHAR，整条响应被阻断，
  // 不止 header 本身）。非 ASCII 文件名跳过 legacy 字段，只走 filename*=UTF-8''...，
  // 现代浏览器（Chromium / Firefox / Safari）均支持。代价：极少数老浏览器会回退
  // 到一个由浏览器生成的文件名——远比"整条响应 500"好。
  const isAscii = /^[\x20-\x7E]*$/.test(plain);
  const encoded = encodeURIComponent(plain).replace(/['()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const legacy = isAscii ? `filename="${plain}"; ` : '';
  return `attachment; ${legacy}filename*=UTF-8''${encoded}`;
}

// 媒体扩展名的**唯一**判定入口。所有路由（info / preview / list / thumb / 原文件下载）
// 都必须走这里，禁止各自 path.extname(abs)——口径一分叉就会出现"看得见却打不开"。
//
// 为什么不能用磁盘扩展名：落盘时的扩展名来自魔数探测（detectMediaExt），
// 而魔数只能探到容器层，ZIP 家族（xlsx / docx / pptx / apk / jar…）一律被判成 zip。
// 于是「汇总.xlsx」落盘成「汇总.zip」，而 /info 展示用的是原始文件名的扩展名（xlsx）。
// 结果：/info 报 xlsx → 前端以为能预览 → /preview 按磁盘算出 zip → 415 不支持。
// 磁盘上真实存在的历史归档就是这样一批 .zip 命名的 Office 文件。
//
// 规则：**原始文件名优先，磁盘扩展名仅作兜底**。
// 原始名是社交端与用户认定的真实类型；原始名缺失时才退回磁盘名
// （此时磁盘名来自魔数，对非 ZIP 家族本身已足够可信）。
export function resolveMediaExt(m, abs) {
  if (m && m.filename) {
    const fromName = path.extname(m.filename).slice(1).toLowerCase();
    if (fromName) return fromName;
  }
  return path.extname(abs).slice(1).toLowerCase();
}

// 把 Office 渲染出的 HTML 包成独立、自带排版的文档（iframe 是隔离文档，
// 不继承应用 CSS 变量，这里内联一套中性、可读性好的样式）。
function wrapOfficeHtml(bodyHtml, title) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title || '预览'}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 24px; background: #fff; color: #1c1c1e;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    font-size: 14px; line-height: 1.7; }
  @media (prefers-color-scheme: dark) { body { background: #1c1c1e; color: #f2f2f7; } }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 13px; }
  th, td { border: 1px solid #d8dce4; padding: 6px 10px; text-align: left; vertical-align: top; }
  @media (prefers-color-scheme: dark) { th, td { border-color: #343a45; } }
  th { background: #f2f4f7; font-weight: 600; }
  @media (prefers-color-scheme: dark) { th { background: #191d24; } }
  h1,h2,h3 { line-height: 1.4; }
  pre { white-space: pre-wrap; word-break: break-word; }
  .sheet { margin-bottom: 28px; }
  .sheet-title { font-size: 13px; font-weight: 600; color: #6b6b70; margin: 0 0 8px; }
</style></head><body>${bodyHtml}</body></html>`;
}

// Excel 工作簿 → 多张表格的 HTML（每张表带标题与表头）
function renderXlsx(wb) {
  const esc = (v) =>
    String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  let out = '';
  for (const ws of wb.worksheets) {
    out += `<section class="sheet"><div class="sheet-title">${esc(ws.name)}</div>`;
    out += '<table>';
    let header = true;
    ws.eachRow((row) => {
      out += '<tr>';
      row.eachCell((cell) => {
        const tag = header ? 'th' : 'td';
        const val = cell.value && typeof cell.value === 'object' && 'text' in cell.value ? cell.value.text : cell.value;
        out += `<${tag}>${esc(val)}</${tag}>`;
      });
      out += '</tr>';
      header = false;
    });
    out += '</table></section>';
  }
  return out;
}

export default function createMediaRouter({ storage }) {
  const r = Router();

  // 统一解析并校验媒体文件。
  // 返回 { m, abs }；越界（media 字段被构造或数据损坏）返回 { traversal: true }；缺失返回 null。
  // 越界必须与缺失区分开：403 表示归档索引里存在可疑路径，这是需要排查的信号；
  // 若一律返回 404，真实的路径穿越尝试会被淹没在「文件没找到」里，排障时看不出来。
  function resolveMedia(id) {
    const m = storage.getMessage(parseInt(id, 10));
    if (!m || !m.media) return null;
    const root = path.resolve(storage.archiveRoot);
    const abs = path.resolve(root, m.media);
    // 词法越界（含 ../ 逃逸）先判，不依赖文件存在 → 稳定返回 403 便于排障
    if (abs !== root && !abs.startsWith(root + path.sep)) return { traversal: true };
    // 符号链接逃逸：解析真实路径后必须仍在媒体根内（词法合法但 symlink 指到根外即拦截）。
    // root 或文件尚不存在时退化为词法校验（已通过上方），不误伤空安装/首次归档。
    let realRoot = root;
    let real = abs;
    try {
      realRoot = fs.realpathSync(root);
      real = fs.realpathSync(abs);
    } catch {
      /* 退化为词法校验 */
    }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return { traversal: true };
    if (!fs.existsSync(real)) return null;
    return { m, abs: real };
  }

  // 统一消费 resolveMedia 的三种结果：越界 403 / 缺失 404 / 正常则交给 handler
  function respond(resolved, res, ok) {
    if (resolved && resolved.traversal) return res.status(403).json({ error: 'forbidden' });
    if (!resolved) return res.status(404).json({ error: 'not found' });
    return ok(resolved.m, resolved.abs);
  }

  function serveOriginal(req, res, m, abs) {
    const stat = fs.statSync(abs);
    const type = MIME[resolveMediaExt(m, abs)] || 'application/octet-stream';
    // 预览请求（?inline=1）用 inline 处置，让浏览器内嵌渲染（尤其 PDF 的 iframe）；
    // 否则用 attachment 触发下载。两者都带文件名，保证"另存为"拿到原名。
    const disposition = req.query.inline ? 'inline' : 'attachment';
    const setDisposition = () => {
      if (m.filename) res.set('Content-Disposition', `${disposition}; ${contentDisposition(m.filename).replace(/^attachment;\s*/, '')}`);
    };
    const range = req.headers.range;

    if (range) {
      const [s, e] = range.replace(/bytes=/, '').split('-');
      let start = parseInt(s, 10);
      let end = e ? parseInt(e, 10) : stat.size - 1;
      if (isNaN(start)) start = 0;
      if (isNaN(end) || end >= stat.size) end = stat.size - 1;
      if (start > end) {
        res.status(416).set('Content-Range', `bytes */${stat.size}`);
        return res.end();
      }
      res.status(206);
      res.set('Content-Type', type);
      res.set('Accept-Ranges', 'bytes');
      res.set('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.set('Content-Length', end - start + 1);
      setDisposition();
      return fs.createReadStream(abs, { start, end }).pipe(res);
    }

    res.set('Content-Type', type);
    res.set('Accept-Ranges', 'bytes');
    res.set('Content-Length', stat.size);
    setDisposition();
    fs.createReadStream(abs).pipe(res);
  }

  // 媒体元信息：返回文件名 / 大小 / MIME / 扩展名，供前端「文件预览」展示
  // 文件名、大小、类型标识。与下载路由共用 resolveMedia 的越界/缺失判定。
  r.get('/info/:id', (req, res) => {
    const hit = resolveMedia(req.params.id);
    if (hit && hit.traversal) return res.status(403).json({ error: 'forbidden' });
    if (!hit) return res.status(404).json({ error: 'not found' });
    const { m, abs } = hit;
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      return res.status(404).json({ error: 'not found' });
    }
    const ext = resolveMediaExt(m, abs);
    const mime = MIME[ext] || 'application/octet-stream';
    res.json({
      filename: m.filename || path.basename(abs),
      size: stat.size,
      mime,
      ext,
      // 绝对路径：供前端调飞牛原生"在文件管理器中打开"，
      // 用户即可用系统已装应用（如 PDF 阅读器 / Office）打开该文件。
      // 该路径仅对已登录的飞牛用户可见，且始终落在归档根内（上面已校验过）。
      absPath: abs,
    });
  });

  // 缩略图：按需用 jimp（纯 JS，无原生依赖）缩放，列表/详情用更小带宽。
  // jimp 未安装或处理失败时，自动回退为原图，保证不回归。
  r.get('/thumb/:id', async (req, res) => {
    const hit = resolveMedia(req.params.id);
    if (hit && hit.traversal) return res.status(403).json({ error: 'forbidden' });
    if (!hit) return res.status(404).json({ error: 'not found' });
    const { m, abs } = hit;
    const ext = resolveMediaExt(m, abs);
    const imgExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
    if (!imgExts.includes(ext) || (m.kind !== 'image' && m.kind !== 'sticker')) {
      return serveOriginal(req, res, m, abs);
    }
    let w = parseInt(req.query.w, 10) || 320;
    if (w < 16) w = 16;
    if (w > 1280) w = 1280;
    try {
      // jimp 0.22 是 CommonJS：命名导入 { Jimp } 取不到，需从 default 兜底。
      // 其 module.exports 即 Jimp 类本身（也挂了 .Jimp），统一兼容两种形态。
      const mod = await import('jimp');
      const Jimp = mod.Jimp ?? (mod.default && (mod.default.Jimp ?? mod.default));
      const image = await Jimp.read(abs);
      image.scaleToFit(w, Jimp.AUTO);
      const asPng = m.kind === 'sticker' || ext === 'png' || ext === 'gif' || ext === 'webp' || ext === 'bmp';
      const mime = asPng ? 'image/png' : 'image/jpeg';
      const buf = asPng
        ? await image.getBufferAsync(Jimp.MIME_PNG)
        : await image.getBufferAsync(Jimp.MIME_JPEG);
      res.set('Content-Type', mime);
      res.set('Cache-Control', 'public, max-age=86400');
      res.set('Content-Length', buf.length);
      return res.end(buf);
    } catch {
      return serveOriginal(req, res, m, abs);
    }
  });

  // 在线预览：Office 文档（docx / xlsx）转 HTML，供前端 iframe 内嵌渲染。
  // 纯文本/图片/音视频/PDF 由前端直接消费原始媒体，无需此路由。
  // 解析/渲染失败一律回退 404，让前端走"下载 / 外部打开"。
  r.get('/preview/:id', async (req, res) => {
    const hit = resolveMedia(req.params.id);
    if (hit && hit.traversal) return res.status(403).json({ error: 'forbidden' });
    if (!hit) return res.status(404).json({ error: 'not found' });
    const { m, abs } = hit;
    const ext = resolveMediaExt(m, abs);
    try {
      let html = '';
      if (ext === 'docx') {
        const mammoth = (await import('mammoth')).default;
        const result = await mammoth.convertToHtml({ path: abs });
        html = wrapOfficeHtml(result.value, m.filename || '文档');
      } else if (ext === 'xlsx') {
        const ExcelJS = (await import('exceljs')).default;
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(abs);
        html = wrapOfficeHtml(renderXlsx(wb), m.filename || '表格');
      } else {
        return res.status(415).json({ error: 'unsupported' });
      }
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('Cache-Control', 'public, max-age=300');
      return res.send(html);
    } catch (e) {
      console.error('[media] 预览生成失败:', e?.message || e);
      return res.status(404).json({ error: 'preview failed' });
    }
  });

  // 压缩包内文件列表（zip / tar / tgz），满足"至少展示压缩包内文件列表"。
  // rar / 7z 需系统原生工具，环境内不可用，回退 415 让前端提示下载。
  r.get('/list/:id', async (req, res) => {
    const hit = resolveMedia(req.params.id);
    if (hit && hit.traversal) return res.status(403).json({ error: 'forbidden' });
    if (!hit) return res.status(404).json({ error: 'not found' });
    const { m, abs } = hit;
    const ext = resolveMediaExt(m, abs);
    try {
      let entries = [];
      if (ext === 'zip') {
        const AdmZip = (await import('adm-zip')).default;
        const zip = new AdmZip(abs);
        entries = zip.getEntries().map((e) => ({
          name: e.entryName,
          size: e.isDirectory ? 0 : e.header.size,
          dir: e.isDirectory,
        }));
      } else if (ext === 'tar' || ext === 'tgz' || ext === 'gz') {
        const tar = await import('tar');
        const collected = [];
        await tar.list({
          file: abs,
          onentry: (entry) => collected.push({ name: entry.path, size: entry.size || 0, dir: entry.type === 'Directory' }),
        });
        entries = collected;
      } else {
        return res.status(415).json({ error: 'unsupported' });
      }
      return res.json({ entries, filename: m.filename || path.basename(abs) });
    } catch (e) {
      console.error('[media] 压缩包列表失败:', e?.message || e);
      return res.status(404).json({ error: 'list failed' });
    }
  });

  r.get('/:id', (req, res) =>
    respond(resolveMedia(req.params.id), res, (m, abs) => serveOriginal(req, res, m, abs)),
  );

  return r;
}
