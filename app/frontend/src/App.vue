<script setup>
import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue';
import { api, connectWS, apiUrl, wsState } from './api.js';
import { setWindowTitle } from './fnos.js';
import { toast } from './toast.js';
import Icon from './components/Icon.vue';
import FolderTree from './components/FolderTree.vue';
import MessageList from './components/MessageList.vue';
import Lightbox from './components/Lightbox.vue';
import DetailPanel from './components/DetailPanel.vue';
import ChannelDialog from './components/ChannelDialog.vue';
import SettingsDialog from './components/SettingsDialog.vue';
import AboutDialog from './components/AboutDialog.vue';
import ToastHost from './components/ToastHost.vue';

const channels = ref([]);
const credError = ref(false); // 凭据无法解密恢复（如卸载重装清掉 data-share），需提示重新绑定
const folders = ref([]);
const chats = ref([]);
const messages = ref([]);
const filter = reactive({ channelName: '', category: '', sub: '', kind: '', q: '' });
const selectedId = ref(null);
const selectedMessage = ref(null);
const showChannels = ref(false);
const showSettings = ref(false);
const showAbout = ref(false);
// UI-L1：灯箱支持两种源——消息媒体 id 序列（ids）或任意 URL 序列（srcs，如快照截图）
const lightbox = reactive({ show: false, ids: [], srcs: [], index: 0 });
const detailPanel = ref(null); // DetailPanel 实例（转发 WS 快照/删除事件用）

// ---- 主题：模式（跟随系统 / 浅色 / 深色）+ 风格，均持久化 ----
// 风格：default（默认）/ ios-classic（iOS 经典）/ ios27（iOS 27 强玻璃质感），
// 分别对应 theme-ios-classic.css / theme-ios27.css 的 [data-theme-style='…'] 选择器。
const THEME_KEY = 'clawvault-mode'; // system | light | dark
const STYLE_KEY = 'clawvault-style'; // default | ios-classic | ios27
const STYLES = ['default', 'ios-classic', 'ios27'];
const theme = ref('light'); // 实际生效的 light/dark（由 mode 推导）
const mode = ref('system');
const themeStyle = ref('default');

const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
const systemPrefersDark = () => !!(mq && mq.matches);

function applyTheme() {
  const eff = mode.value === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : mode.value;
  theme.value = eff;
  const root = document.documentElement;
  root.setAttribute('data-theme', eff);
  root.setAttribute('data-theme-style', themeStyle.value);
  try {
    localStorage.setItem(THEME_KEY, mode.value);
    localStorage.setItem(STYLE_KEY, themeStyle.value);
  } catch {
    /* localStorage 不可用时忽略 */
  }
}
function setMode(m) {
  mode.value = m;
  applyTheme();
}
function setStyle(s) {
  themeStyle.value = s;
  applyTheme();
}
function toggleTheme() {
  setMode(theme.value === 'dark' ? 'light' : 'dark');
}

// 跟随系统模式下，系统配色偏好变化实时响应
if (mq) mq.addEventListener('change', () => {
  if (mode.value === 'system') applyTheme();
});

// 初始化：localStorage 优先，缺省跟随系统 + 默认风格
// 兼容：旧版本曾把 iOS 风格存为 'ios'，现重命名为 'ios-classic'，读到旧值自动迁移。
try {
  const m = localStorage.getItem(THEME_KEY);
  if (m === 'light' || m === 'dark' || m === 'system') mode.value = m;
  const s = localStorage.getItem(STYLE_KEY);
  if (s === 'ios') themeStyle.value = 'ios-classic';
  else if (STYLES.includes(s)) themeStyle.value = s;
} catch {
  /* ignore */
}
applyTheme(); // 尽早应用，避免首屏闪白/闪黑

// ---- 列表加载 ----
const PAGE = 30;
// UI-F3：列表 DOM 上限。无限滚动每翻一页就往 DOM 追加 30 个卡片，
// 千条规模下节点数爆炸、滚动掉帧。到达上限后停止翻页并提示改用搜索/筛选。
const MAX_RENDERED = 300;
const capped = ref(false);
const loading = ref(false); // 首屏 / 重新筛选
const loadingMore = ref(false); // 追加下一页
// UI-F2：加载失败要有明确的错误态（此前失败只弹 toast，列表区显示「空」，像真的没数据）
const loadError = ref('');
const total = ref(0);
const offset = ref(0);
const hasMore = computed(() => messages.value.length < total.value);

const showSide = ref(false); // 移动端侧栏抽屉
const showDetail = ref(false); // 移动端详情覆盖层
const busyDelete = ref(false); // 删除进行中，避免重复提交

const KINDS = [
  { value: '', label: '全部' },
  { value: 'text', label: '文本', icon: 'message' },
  { value: 'voice', label: '语音', icon: 'mic' },
  { value: 'image', label: '图片', icon: 'image' },
  { value: 'sticker,emoji', label: '表情', icon: 'smile' },
  { value: 'video', label: '视频', icon: 'video' },
  { value: 'file', label: '文件', icon: 'file' },
];

// 当前筛选路径的可读标题，用作列表区标题（面包屑式）
const filterTitle = computed(() => {
  if (filter.q) return `搜索「${filter.q}」`;
  const parts = [];
  if (filter.channelName) parts.push(filter.channelName);
  if (filter.category) parts.push(filter.category);
  if (filter.sub) parts.push(filter.sub);
  return parts.length ? parts.join(' › ') : '全部消息';
});

const emptyText = computed(() => {
  if (filter.q) return `没有包含「${filter.q}」的消息`;
  if (filter.kind) return '该类型下暂无消息';
  return '这里还没有归档内容';
});

// 归档总量：从分类树汇总得出，无需额外请求。
// 侧栏「全部消息」用它，而列表标题旁的 total 是当前筛选结果数，两者不能混用。
const totalAll = computed(() =>
  folders.value.reduce(
    (sum, ch) => sum + (ch.categories || []).reduce((n, c) => n + (c.count || 0), 0),
    0,
  ),
);

function channelIdByName(name) {
  const c = channels.value.find((x) => x.name === name);
  return c ? c.id : '';
}

async function loadMessages(reset = true) {
  if (reset) {
    offset.value = 0;
    capped.value = false;
    loading.value = true;
  } else {
    loadingMore.value = true;
  }
  const q = {};
  const cid = channelIdByName(filter.channelName);
  if (cid) q.channelId = cid;
  if (filter.category) q.category = filter.category;
  if (filter.sub) q.sub = filter.sub;
  if (filter.kind) q.kind = filter.kind;
  if (filter.q) q.q = filter.q;
  q.limit = PAGE;
  q.offset = offset.value;
  try {
    const r = await api.listMessages(q);
    total.value = r.total;
    messages.value = reset ? r.items : messages.value.concat(r.items);
    loadError.value = '';
  } catch (e) {
    // UI-F2：失败时保留已有列表，错误态内联展示（含重试入口），不再伪装成「空列表」
    loadError.value = '消息加载失败：' + (e.message || e);
  } finally {
    loading.value = false;
    loadingMore.value = false;
  }
}

function loadMore() {
  if (loadingMore.value || !hasMore.value) return;
  if (messages.value.length >= MAX_RENDERED) {
    capped.value = true;
    return;
  }
  offset.value += PAGE;
  loadMessages(false);
}

async function refresh() {
  await Promise.all([loadMessages(true), loadFolders(), loadChats()]);
}

async function onSelectFilter(f) {
  filter.channelName = f.channelName || '';
  filter.category = f.category || '';
  filter.sub = f.sub || '';
  filter.kind = '';
  filter.q = '';
  selectedId.value = null;
  selectedMessage.value = null;
  showSide.value = false;
  await loadMessages(true);
}

let searchTimer = null;
function onSearchInput(e) {
  filter.q = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    selectedId.value = null;
    selectedMessage.value = null;
    loadMessages(true);
  }, 300);
}

function clearSearch() {
  filter.q = '';
  selectedId.value = null;
  selectedMessage.value = null;
  loadMessages(true);
}

function onSelectKind(k) {
  filter.kind = k;
  selectedId.value = null;
  selectedMessage.value = null;
  loadMessages(true);
}

function onSelectMessage(id) {
  selectedId.value = id;
  selectedMessage.value = messages.value.find((m) => m.id === id) || null;
  showDetail.value = true;
}

// 图片灯箱：从列表或详情打开，统一用「当前筛选下的图片 id 序列」便于左右切换
function onOpenLightbox({ ids, index }) {
  lightbox.ids = ids && ids.length ? ids : [];
  lightbox.srcs = [];
  lightbox.index = index || 0;
  lightbox.show = true;
}
// UI-L1：任意 URL 源灯箱（网址快照截图等没有消息媒体 id 的图片）
function onOpenLightboxSrcs({ srcs, index }) {
  lightbox.ids = [];
  lightbox.srcs = srcs && srcs.length ? srcs : [];
  lightbox.index = index || 0;
  lightbox.show = true;
}
function closeLightbox() {
  lightbox.show = false;
}
function closeDetail() {
  showDetail.value = false;
}
function toggleSide() {
  showSide.value = !showSide.value;
}

// 详情面板重新分类成功：同步选中消息并刷新列表与分类树
async function onReclassified(updated) {
  if (updated && selectedMessage.value?.id === updated.id) selectedMessage.value = updated;
  await Promise.all([loadMessages(true), loadFolders()]);
}

// UI-M6：删除改为「乐观移除 + 5 秒撤销窗口」。
// 此前的「二次确认」只能在误点前拦截，误确认后无法挽回；现在点击删除立即从列表移除，
// toast 提供 5 秒撤销，倒计时结束才真正调后端删除接口（后端删除会连带清理归档文件，不可恢复）。
async function doDelete(id) {
  if (busyDelete.value) return;
  const idx = messages.value.findIndex((m) => m.id === id);
  const backup = idx >= 0 ? messages.value[idx] : null;
  if (idx >= 0) {
    messages.value = messages.value.filter((m) => m.id !== id);
    total.value = Math.max(0, total.value - 1);
  }
  if (selectedMessage.value?.id === id) {
    selectedMessage.value = null;
    selectedId.value = null;
    showDetail.value = false;
  }
  let undone = false;
  const restore = () => {
    if (!backup) return;
    const arr = messages.value.slice();
    arr.splice(Math.min(idx, arr.length), 0, backup);
    messages.value = arr;
    total.value += 1;
  };
  toast.action('已删除，5 秒内可撤销', '撤销', () => {
    undone = true;
    restore();
  }, 5000);
  setTimeout(async () => {
    if (undone) return;
    busyDelete.value = true;
    try {
      const r = await api.deleteMessage(id);
      await Promise.all([loadFolders(), loadChats()]);
      const extra = r?.removedFiles ? `，清理了 ${r.removedFiles} 个归档文件` : '';
      toast.success(`已删除${extra}`);
    } catch (e) {
      restore();
      toast.error('删除失败：' + (e.message || e));
    } finally {
      busyDelete.value = false;
    }
  }, 5200);
}

// ---- 实时推送 ----
// 新消息到达时防抖合并刷新：聊天归档是 xlsx 导出，变化频率低，不必每条都拉。
let refreshTimer = null;
function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    loadMessages(true);
    loadFolders();
  }, 800);
}
function onWSEvent(e) {
  if (e.type === 'message') {
    scheduleRefresh();
  } else if (e.type === 'reclassify') {
    loadMessages(true);
    loadFolders();
    if (selectedMessage.value && e.record.id === selectedMessage.value.id) {
      selectedMessage.value = e.record;
    }
  } else if (e.type === 'delete') {
    if (selectedMessage.value?.id === e.id) {
      selectedMessage.value = null;
      selectedId.value = null;
    }
    detailPanel.value?.onDeleted(e.id);
    loadMessages(true);
    loadFolders();
  } else if (e.type === 'link_snapshot') {
    // 抓取是异步的：消息已入库，几秒后快照才落库并通过 WS 推来，转发给详情面板就地更新
    detailPanel.value?.onLinkSnapshot(e.record);
  } else if (e.type === 'channels') {
    channels.value = e.channels;
  }
}

async function loadChannels() {
  try {
    const r = await api.listChannels();
    channels.value = r.channels || [];
    credError.value = !!r.credentialError;
  } catch (e) {
    toast.error('通道加载失败：' + (e.message || e));
  }
}
async function onChannelsChanged() {
  await Promise.all([loadChannels(), loadFolders(), loadChats()]);
}
async function loadChats() {
  try {
    chats.value = await api.chats();
  } catch {
    chats.value = [];
  }
}
async function loadFolders() {
  try {
    folders.value = await api.folders();
  } catch (e) {
    toast.error('分类加载失败：' + (e.message || e));
  }
}

// Esc：移动端关闭浮层（弹窗与灯箱各自处理自己的 Esc——弹窗用捕获阶段拦截，不会冒泡到这里）
function onKeydown(e) {
  if (e.key !== 'Escape') return;
  if (showSide.value) showSide.value = false;
  else if (showDetail.value) showDetail.value = false;
}

onMounted(() => {
  loadChannels();
  loadFolders();
  loadChats();
  loadMessages(true);
  connectWS(onWSEvent);
  setWindowTitle('ClawVault（爪匣）');
  window.addEventListener('keydown', onKeydown);
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  if (refreshTimer) clearTimeout(refreshTimer);
  if (searchTimer) clearTimeout(searchTimer);
});

// 详情面板切到空态时，同步关掉移动端的覆盖层
watch(selectedMessage, (v) => {
  if (!v) showDetail.value = false;
});
</script>

<template>
  <div class="app">
    <header class="topbar">
      <button class="icon-btn hamburger" aria-label="打开目录" @click="toggleSide">
        <Icon name="menu" :size="19" />
      </button>

      <div class="brand">
        <span class="brand-mark"><Icon name="archive" :size="17" /></span>
        <span class="brand-name">ClawVault</span>
      </div>

      <div class="search">
        <Icon class="search-ico" name="search" :size="15" />
        <input
          class="search-input"
          type="search"
          :value="filter.q"
          aria-label="搜索消息内容"
          placeholder="搜索消息内容…"
          @input="onSearchInput"
        />
        <button v-if="filter.q" class="search-clear" aria-label="清空搜索" @click="clearSearch">
          <Icon name="close" :size="13" />
        </button>
      </div>

      <div class="spacer"></div>

      <button class="btn ghost sm" @click="showChannels = true">
        <Icon name="plug" :size="14" />
        <span class="btn-label">通道</span>
        <span class="badge">{{ channels.length }}</span>
      </button>
      <button class="icon-btn" :aria-label="theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'" :title="theme === 'dark' ? '浅色模式' : '深色模式'" @click="toggleTheme">
        <Icon :name="theme === 'dark' ? 'sun' : 'moon'" :size="17" />
      </button>
      <button class="icon-btn" aria-label="设置" title="设置" @click="showSettings = true">
        <Icon name="settings" :size="18" />
      </button>
      <button class="icon-btn about-btn" aria-label="关于" title="关于" @click="showAbout = true">
        <Icon name="info" :size="18" />
      </button>
    </header>

    <!-- UI-M3：WS 断连可见提示（此前断连后界面一切如常，只是数据悄悄不再更新） -->
    <div v-if="wsState === 'offline'" class="ws-banner" role="alert">
      <Icon name="alert" :size="14" /> 实时连接已断开，正在自动重连…
    </div>

    <div class="body">
      <div v-if="showSide" class="side-mask" @click="showSide = false"></div>

      <aside class="sidebar" :class="{ open: showSide }">
        <div class="side-scroll">
          <section class="side-sec">
            <div class="section-label">浏览</div>
            <button
              class="nav-item"
              :class="{ active: !filter.channelName && !filter.category && !filter.q && !filter.kind }"
              @click="onSelectFilter({})"
            >
              <Icon name="layers" :size="16" />
              <span class="truncate">全部消息</span>
              <span class="nav-count">{{ totalAll }}</span>
            </button>
          </section>

          <section class="side-sec">
            <div class="section-label">分类</div>
            <FolderTree :folders="folders" :selected="filter" @select="onSelectFilter" />
          </section>

          <section class="side-sec" v-if="chats.length">
            <div class="section-label">聊天归档</div>
            <div v-for="c in chats" :key="c.channel" class="chat-row">
              <Icon class="chat-ico" name="sheet" :size="15" />
              <span class="truncate chat-name">{{ c.channel }}</span>
              <span class="nav-count">{{ c.rows }}</span>
              <a class="icon-btn sm" :href="apiUrl(c.downloadUrl)" :download="`${c.channel}-聊天.xlsx`" :title="`下载 ${c.channel} 聊天.xlsx`">
                <Icon name="download" :size="15" />
              </a>
            </div>
          </section>
        </div>
      </aside>

      <main class="main">
        <div class="list-head">
          <div class="list-head-top">
            <h2 class="list-title truncate">{{ filterTitle }}</h2>
            <button class="icon-btn sm" aria-label="刷新" title="刷新" @click="refresh">
              <Icon name="refresh" :size="16" />
            </button>
          </div>
          <div class="list-head-bottom">
            <div class="segmented" role="group" aria-label="按类型筛选">
              <button
                v-for="k in KINDS"
                :key="k.value"
                class="seg"
                :class="{ active: filter.kind === k.value }"
                :aria-pressed="filter.kind === k.value"
                @click="onSelectKind(k.value)"
              >
                <Icon v-if="k.icon" :name="k.icon" :size="14" />
                {{ k.label }}
              </button>
            </div>
            <span class="list-count">{{ total }} 条</span>
          </div>
        </div>

        <div class="list-wrap">
          <!-- UI-F2：加载失败内联错误条（含重试），不再被误显为「空列表」 -->
          <div v-if="loadError" class="load-error" role="alert">
            <Icon name="alert" :size="15" />
            <span class="load-error-msg">{{ loadError }}</span>
            <button class="btn ghost sm" @click="refresh">重试</button>
          </div>
          <div v-if="loading" class="skeletons" aria-hidden="true">
            <div v-for="i in 6" :key="i" class="skeleton-card">
              <div class="sk-line w30"></div>
              <div class="sk-line w90"></div>
              <div class="sk-line w60"></div>
            </div>
          </div>
          <MessageList
            v-else-if="messages.length || !loadError"
            :messages="messages"
            :selectedId="selectedId"
            :emptyText="emptyText"
            :query="filter.q"
            @select="onSelectMessage"
            @delete="doDelete"
            @load-more="loadMore"
            @open-lightbox="onOpenLightbox"
          />
          <div v-if="loadingMore" class="more-state"><span class="spinner"></span> 加载中…</div>
          <!-- UI-F3：到达 DOM 上限的提示，引导改用搜索/筛选而不是无限翻页 -->
          <div v-else-if="capped" class="more-state">
            已显示前 {{ MAX_RENDERED }} 条。结果较多，请用搜索或筛选缩小范围。
          </div>
        </div>
      </main>

      <DetailPanel
        ref="detailPanel"
        :message="selectedMessage"
        :show="showDetail"
        :folders="folders"
        @close="closeDetail"
        @delete="doDelete"
        @reclassified="onReclassified"
        @open-lightbox="onOpenLightbox"
        @open-lightbox-srcs="onOpenLightboxSrcs"
      />
    </div>

    <ChannelDialog :show="showChannels" :channels="channels" :credential-error="credError" @close="showChannels = false" @changed="onChannelsChanged" />
    <SettingsDialog
      :show="showSettings"
      :mode="mode"
      :theme-style="themeStyle"
      @close="showSettings = false"
      @saved="loadFolders"
      @set-mode="setMode"
      @set-style="setStyle"
    />
    <AboutDialog :show="showAbout" @close="showAbout = false" />
    <Lightbox
      :show="lightbox.show"
      :ids="lightbox.ids"
      :srcs="lightbox.srcs"
      v-model:index="lightbox.index"
      @close="closeLightbox"
    />
    <ToastHost />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* ---------- 顶栏 ---------- */
.topbar {
  flex-shrink: 0;
  height: var(--topbar-h);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  background: color-mix(in srgb, var(--c-surface) 82%, transparent);
  backdrop-filter: saturate(180%) blur(12px);
  border-bottom: 1px solid var(--c-border);
  z-index: 30;
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-right: 4px;
}
.brand-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--r-sm);
  background: var(--c-primary);
  color: #fff;
}
.brand-name {
  font-size: 15px;
  font-weight: 650;
  letter-spacing: -0.015em;
}
.badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: var(--r-full);
  background: var(--c-surface-3);
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.search {
  position: relative;
  flex: 1;
  max-width: 460px;
}
.search-ico {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--c-faint);
  pointer-events: none;
}
.search-input {
  width: 100%;
  height: 34px;
  padding: 0 32px 0 32px;
  border: 1px solid transparent;
  border-radius: var(--r-full);
  background: var(--c-surface-3);
  color: var(--c-text);
  font-size: 13px;
  outline: none;
  transition: background var(--t-fast), border-color var(--t-fast), box-shadow var(--t-fast);
}
.search-input::placeholder {
  color: var(--c-faint);
}
.search-input:focus {
  background: var(--c-surface);
  border-color: var(--c-primary);
  box-shadow: 0 0 0 3px var(--c-primary-ring);
}
.search-input::-webkit-search-cancel-button {
  display: none;
}
.search-clear {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  padding: 4px;
  border-radius: var(--r-full);
  color: var(--c-faint);
  transition: color var(--t-fast), background var(--t-fast);
}
.search-clear:hover {
  color: var(--c-text);
  background: var(--c-border);
}

.hamburger {
  display: none;
}

/* ---------- UI-M3：WS 断连横幅 ---------- */
.ws-banner {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 7px 12px;
  background: var(--c-warn-bg);
  color: var(--c-warn);
  font-size: 12.5px;
  border-bottom: 1px solid var(--c-border);
  z-index: 29;
}

/* ---------- 主体三栏 ---------- */
.body {
  flex: 1;
  display: flex;
  min-height: 0;
}

.sidebar {
  width: var(--side-w);
  flex-shrink: 0;
  border-right: 1px solid var(--c-border);
  background: var(--c-surface-2);
  overflow: hidden;
  display: flex;
}
.side-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 14px 10px 24px;
}
.side-sec + .side-sec {
  margin-top: 20px;
}
.side-sec .section-label {
  padding: 0 8px 8px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 9px;
  border-radius: var(--r-sm);
  font-size: 13px;
  color: var(--c-text-2);
  transition: background var(--t-fast), color var(--t-fast);
}
.nav-item:hover {
  background: var(--c-hover);
  color: var(--c-text);
}
.nav-item.active {
  background: var(--c-active);
  color: var(--c-primary);
  font-weight: 500;
}
.nav-count {
  margin-left: auto;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--c-faint);
}

.chat-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px 4px 9px;
  border-radius: var(--r-sm);
  font-size: 13px;
  color: var(--c-text-2);
  transition: background var(--t-fast);
}
.chat-row:hover {
  background: var(--c-hover);
}
.chat-ico {
  color: var(--c-faint);
  flex-shrink: 0;
}
.chat-name {
  flex: 1;
}

/* ---------- 列表区 ---------- */
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--c-bg);
}
.list-head {
  flex-shrink: 0;
  padding: 14px 18px 10px;
  background: var(--c-bg);
  border-bottom: 1px solid var(--c-border);
}
.list-head-top {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
}
.list-title {
  margin: 0;
  font-size: 16px;
  font-weight: 620;
  letter-spacing: -0.01em;
  flex: 1;
  min-width: 0;
}
.list-head-bottom {
  display: flex;
  align-items: center;
  gap: 12px;
}
.segmented {
  display: flex;
  gap: 2px;
  padding: 2px;
  background: var(--c-surface-3);
  border-radius: var(--r-sm);
  overflow-x: auto;
}
.seg {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 11px;
  border-radius: var(--r-xs);
  font-size: 12.5px;
  color: var(--c-text-2);
  white-space: nowrap;
  transition: background var(--t-fast), color var(--t-fast), box-shadow var(--t-fast);
}
.seg:hover {
  color: var(--c-text);
}
.seg.active {
  background: var(--c-surface);
  color: var(--c-primary);
  font-weight: 500;
  box-shadow: var(--shadow-xs);
}
.list-count {
  margin-left: auto;
  font-size: 12px;
  color: var(--c-faint);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.list-wrap {
  flex: 1;
  overflow-y: auto;
  padding: 10px 12px 24px;
}
.more-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 16px;
  font-size: 12.5px;
  color: var(--c-muted);
}

/* UI-F2：列表加载失败错误条 */
.load-error {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 10px;
  padding: 10px 12px;
  border-radius: var(--r-md);
  background: var(--c-danger-bg);
  border: 1px solid var(--c-danger-border);
  color: var(--c-danger);
  font-size: 12.5px;
}
.load-error-msg {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

/* 骨架屏 */
.skeletons {
  display: grid;
  gap: 8px;
}
.skeleton-card {
  padding: 12px 14px;
  border-radius: var(--r-lg);
  background: var(--c-surface);
  border: 1px solid var(--c-border);
}
.sk-line {
  height: 10px;
  border-radius: var(--r-full);
  background: var(--c-surface-3);
  animation: skeleton 1.4s ease-in-out infinite;
  margin-bottom: 8px;
}
.sk-line:last-child {
  margin-bottom: 0;
}
.w30 {
  width: 30%;
}
.w60 {
  width: 60%;
}
.w90 {
  width: 90%;
}

/* ---------- 响应式 ----------
   断点划分：≥1600 宽屏（大尺寸 PC / Mac 外接屏）
             1240 / 1024 桌面与笔记本（侧栏 + 列表 + 详情三栏同屏）
             ≤860  平板竖屏 / 小窗口（侧栏与详情转为抽屉覆盖层）
             ≤560  手机（压缩顶栏，隐藏非关键元素）
             触摸设备统一放大点按目标，保证触控与鼠标均无异常
   注：详情面板（.detail）的断点规则已随 UI-M7 拆入 DetailPanel.vue */
.side-mask {
  display: none;
}

/* 笔记本 / 平板横屏：收紧侧栏 */
@media (max-width: 1024px) {
  .sidebar {
    width: 224px;
  }
  .brand-name {
    display: none;
  }
}

/* 平板竖屏 / 小窗口：侧栏改为抽屉覆盖层，不再与列表争宽度 */
@media (max-width: 860px) {
  .hamburger {
    display: inline-flex;
  }
  .sidebar {
    position: fixed;
    left: 0;
    top: var(--topbar-h);
    bottom: 0;
    z-index: 60;
    width: min(80vw, 300px);
    transform: translateX(-100%);
    transition: transform var(--t);
    box-shadow: var(--shadow-lg);
  }
  .sidebar.open {
    transform: translateX(0);
  }
  .side-mask {
    display: block;
    position: fixed;
    inset: var(--topbar-h) 0 0 0;
    background: rgba(16, 24, 40, 0.35);
    z-index: 55;
  }
  .search {
    max-width: none;
  }
  /* 列表头部：类型筛选与条数换行，避免两者在同一行互相挤压导致溢出 */
  .list-head-bottom {
    flex-wrap: wrap;
    gap: 8px;
  }
  .segmented {
    flex: 1 1 auto;
    max-width: 100%;
    -webkit-overflow-scrolling: touch;
  }
  .list-count {
    margin-left: 0;
  }
}

/* 手机：压缩顶栏与内边距，隐藏非关键元素，保证不溢出、不重叠 */
@media (max-width: 560px) {
  .topbar {
    padding: 0 8px;
    gap: 4px;
  }
  .brand {
    display: none;
  }
  .list-head {
    padding: 12px 12px 8px;
  }
  .list-wrap {
    padding: 8px;
  }
  /* 只留图标，隐藏按钮文字，给搜索框让出空间 */
  .btn-label {
    display: none;
  }
}

/* 超小屏手机：再省掉「关于」入口 */
@media (max-width: 400px) {
  .topbar .about-btn {
    display: none;
  }
}
</style>
