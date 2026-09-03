import fs from 'node:fs';
import path from 'node:path';

// 把「归档根目录下的相对路径」解析为绝对路径，并做双重越界校验：
//   1) 词法校验：拼接后的路径必须仍在 root 内（挡 ../ 逃逸）
//   2) 真实路径校验：解析符号链接后仍必须在 root 内（挡软链指到根外）
//      词法合法但 symlink 指到根外是典型的绕过姿势，只看词法是不够的。
//
// 返回值刻意区分三种情况：
//   { abs }          正常
//   { traversal }    越界 —— 归档索引里存在可疑路径，是需要排查的信号，
//                    调用方应返回 403 而不是 404，否则真实穿越尝试会被
//                    「文件没找到」淹没，排障时看不出来。
//   null             文件缺失
export function resolveWithin(root, rel) {
  if (!rel) return null;
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, rel);
  // 词法越界先判，不依赖文件是否存在 → 稳定返回 403 便于排障
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return { traversal: true };

  let realRoot = rootAbs;
  let real = abs;
  try {
    realRoot = fs.realpathSync(rootAbs);
    real = fs.realpathSync(abs);
  } catch {
    /* root 或文件尚不存在时退化为词法校验（已通过上方），不误伤空安装/首次归档 */
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return { traversal: true };
  if (!fs.existsSync(real)) return null;
  return { abs: real };
}
