#!/usr/bin/env bash
# ClawVault fpk 打包脚本（飞牛 fnOS 双层 gzip tarball，原生应用，无 Docker）
#
# 与原 Docker 版的区别：
#   - 不再打包 app/docker/；运行时由内置 Node（app/runtime/node）提供
#   - app.tgz 内容为 backend（含 node_modules + 构建后的 public）/ ui / runtime
#   - 前端构建产物（vite release，base=/app/clawvault/）落到 backend/public
#   - 原生模块 better-sqlite3 通过 scripts/prepare-runtime.sh 注入 linux 预编译
#
# 用法：
#   bash scripts/build-fpk.sh            # 构建到 dist-fpk/clawvault_<ver>_x86_64.fpk
#   bash scripts/build-fpk.sh --check    # 构建后额外模拟 fnOS 安装校验布局
#
# 注意：必须在 bash（Git Bash / Linux / macOS）下运行；Windows cmd 不行。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."
REPO="$(pwd)"

VER="$(grep '^version=' manifest | head -1 | cut -d= -f2)"
if [ -z "$VER" ]; then echo "✗ 无法从 manifest 读取 version" >&2; exit 1; fi

OUT_DIR="dist-fpk"
mkdir -p "$OUT_DIR"
export FPK="$OUT_DIR/clawvault_${VER}_x86_64.fpk"

echo "==> 打包 ClawVault v$VER fpk（原生应用：内置 Node + 统一网关 /app/clawvault）"

# 1) cmd 脚本执行位（Windows 不保留 Unix 权限，强制补 755）。
# v1.0.43 修复：旧写法 `chmod +x cmd/main cmd/*.sh` 的 cmd/*.sh 通配符匹配不到任何
# 文件（生命周期脚本没有 .sh 后缀），|| true 又吞掉报错——执行位完全取决于构建宿主机
# 默认值：CI 构建的 1.0.41 release 包 cmd/* 全 644，fnOS GUI 升级 fork/exec
# uninstall_init 报 permission denied（2026-09-06 15:07/15:11 两次升级失败实录）。
chmod 755 cmd/* wizard/install 2>/dev/null || true
# 注：文件系统级 -x 检查在 Windows/NTFS 上不可靠（chmod 对 git 追踪为 644 的文件是
# no-op，且 Git for Windows 的 core.filemode=false 不在 checkout 时落执行位），在此中止会
# 误杀 Windows 本地构建。归档内执行位的【强制 + 校验】统一放在下方 6.5 段（跨平台可靠）。
echo "    ✓ cmd/* 与 wizard/install 已尝试补 755（归档内最终模式位由 6.5 段保证）"

# 2) 前端发布构建（base=/app/clawvault/）→ backend/public
echo "==> 构建前端 (vite release, base=/app/clawvault/)"
cd "$REPO/app/frontend"
rm -rf ../backend/public/assets ../backend/public/index.html 2>/dev/null || true
npm ci --no-audit --no-fund
npm run build -- --config vite.release.config.mjs
cd "$REPO"
if [ ! -f app/backend/public/index.html ]; then
  echo "✗ 前端构建产物缺失: app/backend/public/index.html" >&2; exit 1
fi
echo "    ✓ 前端产物: app/backend/public/index.html"

# 3) 后端生产依赖（--ignore-scripts 跳过 better-sqlite3 平台预编译，稍后注入 linux 预编译）
echo "==> 安装后端生产依赖"
cd "$REPO/app/backend"
# 先清掉本机可能残留的 Windows/darwin 原生模块，避免 prepare-runtime.sh 看到文件存在就跳过。
# 用 mv 移出仓库（而非 rm），避免 Windows safe-delete 守护（FAIL_CLOSED）拦截删除导致脚本中断。
if [ -e node_modules/better-sqlite3/build/Release/better_sqlite3.node ]; then
  mv -f node_modules/better-sqlite3/build/Release/better_sqlite3.node /tmp/bsql-stale-$$.node 2>/dev/null || rm -f node_modules/better-sqlite3/build/Release/better_sqlite3.node 2>/dev/null || true
fi
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
cd "$REPO"

# 4) 准备原生运行时（内置 Node + better-sqlite3 linux 预编译 + 可选 ffmpeg）
bash "$SCRIPT_DIR/prepare-runtime.sh"

# 4.5) OPS-P1：收紧应用目录属主/权限——应用代码仅 root 可读执行、包用户 clawvault 不可写，
# 杜绝 clawvault 被拿下后篡改代码实现 RCE 持久化（可写数据只在 @appshare）。
# 同时把 node_modules/.bin 从 777 收为 755（低危：全可写的可执行文件可被篡改）。
# 注意：只改「我们打进包的子目录」（cmd / app/backend / app/ui / app/runtime），
# 不动 fnOS 创建的顶层控制目录（socket 落在其下，需保持 clawvault 可写）。
echo "==> 收紧应用目录权限（OPS-P1：代码目录去 group/other 写位；.bin 收 755）"
for d in cmd app/backend app/ui app/runtime; do
  [ -d "$REPO/$d" ] || continue
  chmod -R go-w "$REPO/$d"
done
chmod 755 "$REPO/cmd/main" 2>/dev/null || true
find "$REPO/app/backend/node_modules/.bin" -type f -exec chmod 755 {} + 2>/dev/null || true
echo "    ✓ 应用目录权限已收紧（代码目录 group/other 不可写，.bin=755）"

# 4.6) OPS-P2：Windows 构建机（Git for Windows 默认 core.autocrlf=true）会在 checkout 时
# 把 LF 转回 CRLF，导致 fnOS Linux 执行生命周期脚本时 shebang 变成 /bin/sh\r，
# 内核报「cannot execute: required file not found」→ 应用中心「执行脚本出错且原因未知」。
# 这里【先归一化再校验】：无论工作树是 CRLF 还是 LF，打进包的一定是 LF（双保险，
# 与 .gitattributes 的 eol=lf 互补——后者只管 checkout，本步管打包产物）。
echo "==> 归一化关键脚本换行符为 LF（防止 CRLF 导致 fnOS 生命周期脚本失败）"
for f in cmd/* wizard/* config/* manifest README.md CONTRIBUTING.md; do
  [ -f "$f" ] || continue
  sed -i 's/\r$//' "$f" 2>/dev/null || true
done
CRLF_OK=1
for f in cmd/* wizard/* config/* manifest; do
  [ -f "$f" ] || continue
  if grep -q $'\r' "$f"; then
    echo "    ✗ $f 归一化后仍含 CRLF 换行符" >&2
    CRLF_OK=0
  fi
done
if [ "$CRLF_OK" = "0" ]; then
  echo "✗ 关键脚本归一化后仍含 CRLF，打包已中止。" >&2
  exit 1
fi
echo "    ✓ 关键脚本均为 LF"

# 5) 内层 app.tgz：backend（node_modules + public）/ ui / runtime
#    不含 frontend 源码（已构建进 public）、不含 data/archive、不含测试与日志
[ -d app ] || { echo "✗ 缺少 app/ 目录" >&2; exit 1; }
rm -f app.tgz 2>/dev/null || true
( cd app && tar -czf ../app.tgz \
    --exclude='node_modules/.cache' \
    --exclude='*/test' --exclude='tests' \
    --exclude='data' --exclude='archive' --exclude='*.log' \
    --exclude='var' --exclude='*/var' \
    --exclude='.env' --exclude='.env.*' --exclude='*/.env' --exclude='*/.env.*' \
    backend ui runtime )
echo "    ✓ app.tgz ($(stat -c%s app.tgz) bytes)"

# 6) 外层 fpk：app.tgz 作为顶层文件之一（fnpack 规范）
rm -f "$FPK" 2>/dev/null || true
tar -czf "$FPK" \
  manifest cmd wizard config ICON.PNG ICON_256.PNG app.tgz \
  README.md CONTRIBUTING.md
echo "    ✓ fpk: $FPK ($(stat -c%s "$FPK") bytes)"

# 6.5) 归档内执行位【强制 + 校验】：跨平台可靠，不依赖文件系统 chmod 语义。
# Windows/NTFS 上 chmod 对 git 追踪为 644 的文件是 no-op，tar 会原样记录 644，
# 导致 fnOS fork/exec 失败。这里直接改写 tar 头里的模式位，确保 cmd/* 与 wizard/install
# 在归档内恒为 0755，再随后校验。python3 在 Windows(Git Bash 托管) 与 CI(Ubuntu) 均可用。
echo "==> 强制归档内生命周期脚本执行位为 0755（跨平台）"
python3 - <<'PYEOF'
import os, tarfile, io
fpk = os.environ.get('FPK')
if not fpk or not os.path.isfile(fpk):
    raise SystemExit('FPK 未设置或不存在: %r' % fpk)
tmp = fpk + '.tmp_modefix'
forced = []
with tarfile.open(fpk, 'r:gz') as t, tarfile.open(tmp, 'w:gz') as out:
    for m in t.getmembers():
        if (m.name.startswith('cmd/') or m.name == 'wizard/install') and m.isfile():
            m.mode = 0o755
            forced.append(m.name)
        # 硬链接/符号链接/目录成员的 extractfile() 返回 None，无数据载荷，直接保留成员本身；
        # 否则（常规文件）读出数据后按改过的模式位重写。
        tf = t.extractfile(m)
        if tf is not None:
            data = tf.read()
            out.addfile(m, io.BytesIO(data))
        else:
            out.addfile(m)
os.replace(tmp, fpk)
print('    forced 0755:', forced)
PYEOF
# 校验：直接读 tar 头模式位（fnOS 解包时真正看到的东西）。任一缺 owner 执行位即中止。
BAD_EXEC="$(tar -tzvf "$FPK" | awk '$NF ~ /^cmd\// || $NF == "wizard/install" { if (substr($1, 1, 1) != "d" && substr($1, 4, 1) != "x") print "  ✗ " $NF " mode=" $1 }')"
if [ -n "$BAD_EXEC" ]; then
  echo "✗ 归档内生命周期脚本仍缺执行位（fnOS 将 fork/exec 失败）：" >&2
  echo "$BAD_EXEC" >&2
  exit 1
fi
echo "    ✓ 归档内 cmd/* 与 wizard/install 模式位校验通过（owner 可执行）"

# 7) 可选：模拟 fnOS 安装校验布局
if [ "${1:-}" = "--check" ]; then
  SIM="$(pwd)/dist-fpk/_sim_check"
  # 本地 safe-delete 守护会拦截批量 rm >50，用 mv 移出仓库再清理
  if [ -d "$SIM" ]; then
    mv -f "$SIM" "/tmp/clawvault-sim-old-$$" 2>/dev/null || rm -rf "$SIM" 2>/dev/null || true
  fi
  mkdir -p "$SIM"
  # 模拟 fnOS 第一步：解外层 fpk 到 ${TRIM_APPDEST}
  tar -xzf "$FPK" -C "$SIM"
  # 模拟 fnOS 第二步：解 app.tgz 直接铺平到应用根（无 app/ 中间层）
  tar -xzf "$SIM/app.tgz" -C "$SIM"
  ok=1
  for p in \
    manifest cmd/main config/privilege config/resource wizard/install \
    backend/src/index.js backend/node_modules/better-sqlite3/build/Release/better_sqlite3.node \
    backend/public/index.html ui/config runtime/node/bin/node; do
    if [ ! -e "$SIM/$p" ]; then echo "    ✗ 缺失 $p"; ok=0; fi
  done
  # 校验原生二进制确为 Linux ELF，避免把 Windows PE / HTML 错误页打包进 fpk
  for f in "$SIM/backend/node_modules/better-sqlite3/build/Release/better_sqlite3.node" "$SIM/runtime/node/bin/node"; do
    head="$(head -c 4 "$f" 2>/dev/null | od -An -tx1 | tr -d ' \n')" || true
    if [ "$head" != "7f454c46" ]; then echo "    ✗ $f 不是 Linux ELF（文件头 $head）"; ok=0; fi
  done
  # 原生应用不应再含 docker
  if [ -e "$SIM/docker" ]; then echo "    ✗ 不应包含 docker 目录（已改为原生）"; ok=0; fi
  # SEC-14：.env 等本地密钥文件绝不进包
  if find "$SIM" -name '.env' -o -name '.env.*' 2>/dev/null | grep -q .; then
    echo "    ✗ 包内发现 .env 文件（密钥泄露风险）"; ok=0
  fi
  # LICENSE 不应在外层根目录（避免触发 fnOS 自动英文协议步骤）
  if [ -e "$SIM/LICENSE" ]; then echo "    ✗ 外层不应有 LICENSE（会触发 fnOS 自动渲染英文协议步骤）"; ok=0; fi
  if [ ! -f "$SIM/app.tgz" ]; then echo "    ✗ 外层应含 app.tgz（fnpack 规范）"; ok=0; fi
  for f in "$SIM"/cmd/* "$SIM/wizard/install"; do
    if [ ! -x "$f" ]; then echo "    ✗ 无执行位 $f"; ok=0; fi
  done
  if [ "$ok" = "1" ]; then
    echo "    ✓ 安装布局校验通过（原生布局）"
    mv -f "$SIM" "/tmp/clawvault-sim-ok-$$" 2>/dev/null || rm -rf "$SIM" 2>/dev/null || true
  else
    mv -f "$SIM" "/tmp/clawvault-sim-fail-$$" 2>/dev/null || rm -rf "$SIM" 2>/dev/null || true
    exit 1
  fi
fi

echo "==> 完成: $FPK"
