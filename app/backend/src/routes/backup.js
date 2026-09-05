import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// FUN-4：整库备份/导出入口。
// 数据全在 dataDir（fnOS 上即 /vol1/@appshare/clawvault），升级/卸载有误删风险，
// 此前没有任何导出入口。这里提供「一键导出 zip」：
//   - archive.db    经 SQLite 在线备份 API 落出的一致性快照（WAL 安全）
//   - settings.json / channels.json  配置与渠道（含 AES-GCM 密文字段）
//   - .clvkey       主密钥——没有它，上面两个文件里的密文永远无法解密，
//                   因此完整可恢复的备份必须带上它
// 安全说明：zip 内含主密钥，等同于「能解密全部渠道凭据」的敏感文件，
// 接口仅管理员可用（requireAdmin），前端按钮也只对管理员展示；
// manifest.json 里明示了敏感性，提醒用户妥善保管导出的 zip。
export default function createBackupRouter({ config, storage, requireAdmin }) {
  const r = Router();

  r.get('/export', requireAdmin, async (req, res) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clv-backup-'));
    try {
      // 1) DB 一致性快照（WAL 模式下直接拷文件会丢未 checkpoint 的内容）
      const dbSnap = path.join(tmp, 'archive.db');
      await storage.backup(dbSnap);

      // 2) 打 zip（adm-zip 已是生产依赖，media.js 里也在用）
      const AdmZip = (await import('adm-zip')).default;
      const zip = new AdmZip();
      zip.addLocalFile(dbSnap);
      const included = ['archive.db'];
      for (const f of ['settings.json', 'channels.json', '.clvkey']) {
        const p = path.join(config.dataDir, f);
        if (fs.existsSync(p)) {
          zip.addLocalFile(p);
          included.push(f);
        }
      }
      const now = new Date();
      zip.addFile(
        'manifest.json',
        Buffer.from(
          JSON.stringify(
            {
              app: 'clawvault',
              exportedAt: now.toISOString(),
              files: included,
              warning:
                '本备份包含 .clvkey 主密钥，可解密 settings/channels 中的全部凭据，请妥善保管。',
            },
            null,
            2,
          ),
          'utf8',
        ),
      );

      // 3) 以附件形式下发（文件名纯 ASCII，无需 RFC6266）
      const p2 = (n) => String(n).padStart(2, '0');
      const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="clawvault-backup-${stamp}.zip"`);
      res.send(zip.toBuffer());
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 200) });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  return r;
}
