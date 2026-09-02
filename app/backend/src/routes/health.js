import { Router } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRecentAiFailures } from '../classify.js';
import { readManifestVersion } from '../version.js';

// 从仓库根 docker-compose.yml 读取 clawvault 镜像版本，用于与 manifest 比对。
function readComposeImageVersion() {
  const candidates = [
    fileURLToPath(new URL('../../../../docker-compose.yml', import.meta.url)), // 仓库态 → 仓库根
    fileURLToPath(new URL('../../docker/docker-compose.yaml', import.meta.url)), // 部署态 → 应用根/docker
    path.resolve(process.cwd(), '..', '..', 'docker-compose.yml'),
    path.resolve(process.cwd(), '..', 'docker-compose.yml'),
    path.resolve(process.cwd(), 'docker-compose.yml'),
  ];
  for (const p of candidates) {
    try {
      const txt = fs.readFileSync(p, 'utf8');
      const m = txt.match(/image:\s*clawvault:([0-9]+\.[0-9]+\.[0-9]+)/);
      if (m) return m[1];
    } catch {
      /* 尝试下一候选 */
    }
  }
  return null;
}

// 归档根剩余空间（best-effort，Node 18.15+ 才提供 statfsSync）
function freeBytes(dir) {
  try {
    if (typeof fs.statfsSync === 'function') {
      const s = fs.statfsSync(dir);
      return (s.bavail ?? s.bfree) * s.bsize;
    }
  } catch {
    /* ignore */
  }
  return null;
}

// 归档根是否可写（写删临时文件探测）
function isWritable(dir) {
  try {
    const f = path.join(dir, `.clawvault_write_test_${Date.now()}_${process.pid}`);
    fs.writeFileSync(f, 'ok');
    fs.unlinkSync(f);
    return true;
  } catch {
    return false;
  }
}

// 运行状况分析接口：实时采集系统运行状态，供监控/排障与持续优化使用。
// GET /api/health → 返回 JSON；支持 ?simple=1 仅返回核心健康标志。
export default function createHealthRouter({ storage, manager, config, startedAt }) {
  const r = Router();

  r.get('/', (req, res) => {
    const manifestVer = readManifestVersion();
    const composeVer = readComposeImageVersion();
    const mem = process.memoryUsage();
    const mb = (b) => Math.round((b / 1024 / 1024) * 10) / 10;
    const stats = storage.stats ? storage.stats() : { total: storage.count() };
    const channels = manager.listChannels();
    const free = freeBytes(storage.archiveRoot);
    const wsOk = Boolean(manager && typeof manager.listChannels === 'function');

    const payload = {
      ok: true,
      timestamp: Date.now(),
      app: {
        name: 'ClawVault（爪匣）',
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      system: {
        archiveRoot: storage.archiveRoot,
        archiveExists: fs.existsSync(storage.archiveRoot),
        archiveWritable: isWritable(storage.archiveRoot),
        archiveFreeBytes: free,
        memory: {
          rssMb: mb(mem.rss),
          heapUsedMb: mb(mem.heapUsed),
          heapTotalMb: mb(mem.heapTotal),
          externalMb: mb(mem.external),
        },
        cpuLoad: os.loadavg(),
        cpuCount: os.cpus().length,
      },
      database: stats,
      channels: {
        total: channels.length,
        connected: channels.filter((c) => c.connected).length,
        needRescan: channels.filter((c) => c.needRescan).length,
        list: channels.map((c) => ({
          id: c.id,
          name: c.name,
          providerType: c.providerType,
          connected: c.connected,
          needRescan: c.needRescan,
        })),
      },
      ai: {
        enabled: Boolean(config.ai.enabled),
        baseUrl: config.ai.baseUrl,
        model: config.ai.model,
        apiKeySet: Boolean(config.ai.apiKey),
        recentFailures: getRecentAiFailures(),
      },
      stt: { configured: Boolean(config.ai.sttUrl) },
      versionConsistency: {
        consistent: manifestVer && composeVer ? manifestVer === composeVer : null,
      },
    };

    if (req.query.simple !== undefined) {
      return res.json({
        ok: payload.ok,
        uptimeSec: payload.app.uptimeSec,
        messages: stats.total,
        mediaGaps: stats.mediaGaps,
        channelsConnected: payload.channels.connected,
        aiEnabled: payload.ai.enabled,
        archiveWritable: payload.system.archiveWritable,
        versionConsistent: payload.versionConsistency.consistent,
      });
    }
    res.json(payload);
  });

  return r;
}
