// 飞牛 fnOS 微应用 SDK 适配层（@trimjs/web-app）
//
// 设计原则：**能力探测 + 静默降级**。
// ClawVault 既可能运行在飞牛桌面窗口内（宿主环境，SDK 可用），
// 也可能被用户直接用浏览器打开网关地址（独立页面，部分能力不可用）。
// 因此这里所有调用都必须容错：SDK 缺失、宿主不支持、方法抛错都不能影响主功能。
//
// 前置条件：manifest 必须声明 micro_app=true，否则页面不会按微应用环境加载，
// SDK 无法完成初始化（这一点是飞牛官方文档的硬要求）。

let sdkPromise = null;

// 惰性初始化：只在真正用到时才加载 SDK，避免独立浏览器环境下的无谓开销
function getSdk() {
  if (sdkPromise) return sdkPromise;
  sdkPromise = (async () => {
    try {
      const mod = await import('@trimjs/web-app');
      const TrimApp = mod.TrimApp || mod.default;
      if (!TrimApp) return null;
      const sdk = new TrimApp();
      // ready() 等待宿主握手完成；宿主不存在时可能超时/抛错，一律视为不可用
      if (typeof sdk.ready === 'function') await sdk.ready();
      return sdk;
    } catch {
      return null;
    }
  })();
  return sdkPromise;
}

// 是否运行在飞牛宿主环境内（桌面窗口 iframe），而非独立浏览器标签页。
// 文件选择、$on 事件监听等能力只在宿主环境可用。
export async function inFnosHost() {
  const sdk = await getSdk();
  if (!sdk) return false;
  return sdk.isStandaloneWeb === false;
}

// 设置飞牛桌面窗口标题。失败无害，忽略即可。
export async function setWindowTitle(title) {
  try {
    const sdk = await getSdk();
    await sdk?.setTitle?.(title);
  } catch {
    /* 非宿主环境或宿主版本过低，忽略 */
  }
}

// 调起飞牛原生目录选择器，选择归档根目录并把该目录授权给本应用。
// 用 pickSharedFile（应用共享授权）而非 pickUserFile：ClawVault 的归档是
// 应用级全局数据，不按登录用户区分内容，对应 scope trim.file.sharedAccess。
//
// 返回：成功则返回绝对路径字符串；不可用或用户取消则返回 null。
export async function pickArchiveDir() {
  const sdk = await getSdk();
  if (!sdk || sdk.isStandaloneWeb !== false) return null;
  if (typeof sdk.pickSharedFile !== 'function') return null;

  const res = await sdk.pickSharedFile();
  // 约定返回 { code, msg, data: string[] }，code 0 为成功
  if (!res || (res.code !== 0 && res.code !== undefined)) return null;
  const paths = Array.isArray(res.data) ? res.data : [];
  return paths.length ? paths[0] : null;
}

// 在飞牛文件管理器中定位到指定路径（用于"在文件管理器中打开归档目录"）
export async function revealInFileManager(path) {
  try {
    const sdk = await getSdk();
    if (!sdk || !path) return false;
    await sdk.openFileManager(path);
    return true;
  } catch {
    return false;
  }
}
