import { Router } from 'express';
import { readManifestVersion } from '../version.js';

// 关于页面信息：版本（读 manifest）+ 仓库/协议/开发者等静态信息。
// 品牌以 ClawVault（爪匣）真实身份展示。
export default function createAboutRouter({ storage } = {}) {
  const r = Router();
  r.get('/', (req, res) => {
    res.json({
      name: '爪匣 ClawVault',
      version: readManifestVersion() || '',
      developer: 'planover',
      // 归档总量：让「关于」页能直观显示已归档条数（无 storage 时省略）
      total: storage ? storage.count() : 0,
      repo: 'https://github.com/planover/ClawVault',
      changelog: 'https://github.com/planover/ClawVault/releases',
      license: 'AGPL-3.0',
      licenseUrl: 'https://github.com/planover/ClawVault/blob/main/LICENSE',
      privacyUrl: 'https://github.com/planover/ClawVault#%E9%9A%90%E7%A7%81',
      description:
        '飞牛 fnOS 上的微信 bot 消息归档应用：将聊天中的文本、语音、图片、文件等归档到本地 NAS，支持全文检索与分类浏览。',
      privacyNote:
        '本项目为自托管开源工具，所有消息与媒体仅存储在你自己的 NAS 本地，不经由任何第三方云端。',
    });
  });
  return r;
}
