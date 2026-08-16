import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 从仓库 manifest（INI）读取应用版本。
// 优先用本模块文件位置推导（部署态 backend/src/version.js → 应用根/manifest），
// 再回退若干 cwd 相对路径以兼容开发态；同时读取 CLAWVAULT_VERSION 环境变量作为最后兜底。
export function readManifestVersion() {
  const envVer = process.env.CLAWVAULT_VERSION?.trim();
  if (envVer) return envVer;
  const candidates = [
    '/app/manifest', // Docker 镜像内 manifest 落点
    fileURLToPath(new URL('../../../../manifest', import.meta.url)), // 仓库态 app/backend/src → 仓库根
    fileURLToPath(new URL('../../../manifest', import.meta.url)), // 部署态 backend/src → 应用根
    path.resolve(process.cwd(), '..', 'manifest'),
    path.resolve(process.cwd(), '..', '..', 'manifest'),
    path.resolve(process.cwd(), 'manifest'),
  ];
  for (const p of candidates) {
    try {
      const txt = fs.readFileSync(p, 'utf8');
      const line = txt.split('\n').find((l) => l.startsWith('version='));
      if (line) return line.split('=').slice(1).join('=').trim();
    } catch {
      /* 尝试下一候选 */
    }
  }
  return null;
}
