<script setup>
import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue';
import { api, connectWS } from './api.js';
import { setWindowTitle } from './fnos.js';
import { toast } from './toast.js';
import Icon from './components/Icon.vue';
import FolderTree from './components/FolderTree.vue';
import MessageList from './components/MessageList.vue';
import ChannelDialog from './components/ChannelDialog.vue';
import SettingsDialog from './components/SettingsDialog.vue';
import AboutDialog from './components/AboutDialog.vue';
import ToastHost from './components/ToastHost.vue';

const channels = ref([]);
const folders = ref([]);
const chats = ref([]);
const messages = ref([]);
const filter = reactive({ channelName: '', category: '', sub: '', kind: '', q: '' });
const selectedId = ref(null);
const selectedMessage = ref(null);
const showChannels = ref(false);
const showSettings = ref(false);
const showAbout = ref(false);
const detailImgFailed = ref(false);
const newCat = ref('');
const newSub = ref('');

// ---- 主题：默认跟随系统，用户手动切换后记入 localStorage ----
const THEME_KEY = 'clawvault-theme';
const theme = ref(
  (() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === 'dark' || saved === 'light') return saved;
    } catch {
      /* localStorage 不可用（隐私模式）时忽略 */
    }
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  })(),
);

function applyTheme(t) {
  theme.value = t;
  document.documentElement.setAttribute('data-theme', t);
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* ignore */
  }
}
function toggleTheme() {
  applyTheme(theme.value === 'dark' ? 'light' : 'dark');
}
applyTheme(theme.value); // 尽早应用，避免首屏闪白/闪黑

// ---- 列表加载 ----
const PAGE = 30;
const loading = ref(false); // 首屏 / 重新筛选
const loadingMore = ref(false); // 追加下一页
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
  { value: 'sticker', label: '表情', icon: 'smile' },
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

// 已有分类：给「重新分类」输入框做候选提示，避免手打出错
const categoryOptions = computed(() => {
  const set = new Set();
  for (const ch of folders.value) for (const c of ch.categories || []) set.add(c.name);
  return [...set].sort();
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
  } catch (e) {
    toast.error('消息加载失败：' + (e.message || e));
  } finally {
    loading.value = false;
    loadingMore.value = false;
  }
}

function loadMore() {
  if (loadingMore.value || !hasMore.value) return;
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
  newCat.value = selectedMessage.value?.category || '';
  newSub.value = selectedMessage.value?.sub || '';
  detailImgFailed.value = false;
  showDetail.value = true;
}
function closeDetail() {
  showDetail.value = false;
}
function toggleSide() {
  showSide.value = !showSide.value;
}

async function doReclassify() {
  if (!selectedMessage.value || !newCat.value.trim()) return;
  try {
    const updated = await api.reclassify(selectedMessage.value.id, newCat.value.trim(), newSub.value.trim());
    selectedMessage.value = updated;
    await Promise.all([loadMessages(true), loadFolders()]);
    toast.success('已重新分类');
  } catch (e) {
    toast.error('重新分类失败：' + (e.message || e));
  }
}

async function doDelete(id) {
  if (busyDelete.value) return;
  busyDelete.value = true;
  try {
    const r = await api.deleteMessage(id);
    if (selectedMessage.value?.id === id) {
      selectedMessage.value = null;
      selectedId.value = null;
      showDetail.value = false;
    }
    await Promise.all([loadMessages(true), loadFolders(), loadChats()]);
    const extra = r?.removedFiles ? `，清理了 ${r.removedFiles} 个归档文件` : '';
    toast.success(`已删除${extra}`);
  } catch (e) {
    toast.error('删除失败：' + (e.message || e));
  } finally {
    busyDelete.value = false;
  }
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
      newCat.value = e.record.category;
      newSub.value = e.record.sub;
    }
  } else if (e.type === 'delete') {
    if (selectedMessage.value?.id === e.id) {
      selectedMessage.value = null;
      selectedId.value = null;
    }
    loadMessages(true);
    loadFolders();
  } else if (e.type === 'channels') {
    channels.value = e.channels;
  }
}

async function loadChannels() {
  try {
    channels.value = await api.listChannels();
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

// Esc：移动端关闭浮层
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
        通道
        <span class="badge">{{ channels.length }}</span>
      </button>
      <button class="icon-btn" :aria-label="theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'" :title="theme === 'dark' ? '浅色模式' : '深色模式'" @click="toggleTheme">
        <Icon :name="theme === 'dark' ? 'sun' : 'moon'" :size="17" />
      </button>
      <button class="icon-btn" aria-label="设置" title="设置" @click="showSettings = true">
        <Icon name="settings" :size="18" />
      </button>
      <button class="icon-btn" aria-label="关于" title="关于" @click="showAbout = true">
        <Icon name="info" :size="18" />
      </button>
    </header>

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
              <a class="icon-btn sm" :href="c.downloadUrl" :download="`${c.channel}-聊天.xlsx`" :title="`下载 ${c.channel} 聊天.xlsx`">
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
          <div v-if="loading" class="skeletons" aria-hidden="true">
            <div v-for="i in 6" :key="i" class="skeleton-card">
              <div class="sk-line w30"></div>
              <div class="sk-line w90"></div>
              <div class="sk-line w60"></div>
            </div>
          </div>
          <MessageList
            v-else
            :messages="messages"
            :selectedId="selectedId"
            :emptyText="emptyText"
            :query="filter.q"
            @select="onSelectMessage"
            @delete="doDelete"
            @load-more="loadMore"
          />
          <div v-if="loadingMore" class="more-state"><span class="spinner"></span> 加载中…</div>
        </div>
      </main>

      <section class="detail" :class="{ open: showDetail }">
        <button class="icon-btn sm detail-close" aria-label="关闭详情" @click="closeDetail">
          <Icon name="close" :size="16" />
        </button>

        <div v-if="selectedMessage" class="detail-inner">
          <div class="detail-head">
            <span class="tag">{{ selectedMessage.category }}<template v-if="selectedMessage.sub"> / {{ selectedMessage.sub }}</template></span>
            <h3 class="detail-meta truncate">{{ selectedMessage.channelName }}</h3>
            <span class="detail-time">{{ new Date(selectedMessage.ts).toLocaleString('zh-CN') }}</span>
          </div>

          <p v-if="selectedMessage.text" class="detail-text">{{ selectedMessage.text }}</p>

          <div v-if="(selectedMessage.kind === 'image' || selectedMessage.kind === 'sticker') && selectedMessage.media" class="block">
            <div class="section-label">图片</div>
            <img v-if="!detailImgFailed" class="detail-img" :src="api.thumbUrl(selectedMessage.id, 800)" alt="图片" @error="detailImgFailed = true" />
            <div v-else class="media-missing"><Icon name="alert" :size="15" /> 媒体加载失败</div>
          </div>

          <div v-else-if="selectedMessage.kind === 'video' && selectedMessage.media" class="block">
            <div class="section-label">视频</div>
            <video class="detail-img" controls :src="api.mediaUrl(selectedMessage.id)"></video>
          </div>

          <div v-else-if="selectedMessage.kind === 'file' && selectedMessage.media" class="block">
            <div class="section-label">文件</div>
            <a class="file-chip" :href="api.mediaUrl(selectedMessage.id)" target="_blank" rel="noopener" :download="selectedMessage.filename || ''">
              <Icon name="file" :size="16" />
              <span class="truncate">{{ selectedMessage.filename || '下载文件' }}</span>
              <Icon name="download" :size="15" />
            </a>
          </div>

          <div v-else-if="['image', 'video', 'file', 'sticker'].includes(selectedMessage.kind) && !selectedMessage.media" class="block">
            <div class="media-missing"><Icon name="alert" :size="15" /> 该媒体未保存（旧版本或接收时缺失）</div>
          </div>

          <div v-if="selectedMessage.voice" class="block">
            <div class="section-label">语音</div>
            <audio class="detail-audio" controls :src="api.voiceUrl(selectedMessage.id)"></audio>
          </div>

          <div v-if="selectedMessage.peer" class="block">
            <div class="section-label">会话对象</div>
            <div class="detail-peer">{{ selectedMessage.peer }}</div>
          </div>

          <div class="block reclass">
            <div class="section-label">重新分类</div>
            <div class="reclass-row">
              <input class="input" v-model="newCat" list="cv-cats" placeholder="主分类" />
              <datalist id="cv-cats">
                <option v-for="c in categoryOptions" :key="c" :value="c"></option>
              </datalist>
              <input class="input" v-model="newSub" placeholder="子分类（可选）" />
              <button class="btn sm" :disabled="!newCat.trim()" @click="doReclassify">保存</button>
            </div>
          </div>

          <div class="detail-actions">
            <button class="btn ghost sm" @click="doDelete(selectedMessage.id)">
              <Icon name="trash" :size="14" /> 删除这条归档
            </button>
          </div>
        </div>

        <div v-else class="detail-empty">
          <Icon name="empty" :size="34" />
          <p class="detail-empty-title">未选择消息</p>
          <p class="muted small">从左侧分类或右侧列表中选一条，这里会显示完整内容、媒体与重新分类入口。</p>
        </div>
      </section>
    </div>

    <ChannelDialog :show="showChannels" :channels="channels" @close="showChannels = false" @changed="onChannelsChanged" />
    <SettingsDialog :show="showSettings" @close="showSettings = false" @saved="loadFolders" />
    <AboutDialog :show="showAbout" @close="showAbout = false" />
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

/* ---------- 详情面板 ---------- */
.detail {
  width: var(--detail-w);
  flex-shrink: 0;
  border-left: 1px solid var(--c-border);
  background: var(--c-surface);
  overflow-y: auto;
  position: relative;
  padding: 18px;
}
.detail-inner {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.detail-close {
  display: none;
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 2;
}
.detail-head {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-right: 8px;
}
.detail-meta {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.detail-time,
.detail-peer {
  font-size: 12px;
  color: var(--c-muted);
}
.detail-text {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--c-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.detail-img {
  width: 100%;
  max-height: 340px;
  object-fit: contain;
  border-radius: var(--r-md);
  border: 1px solid var(--c-border);
  background: var(--c-surface-2);
}
.detail-audio {
  width: 100%;
}
.file-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--c-border-strong);
  border-radius: var(--r-md);
  font-size: 13px;
  color: var(--c-text);
  transition: background var(--t-fast), border-color var(--t-fast);
}
.file-chip:hover {
  background: var(--c-hover);
  border-color: var(--c-primary);
  text-decoration: none;
}
.media-missing {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 10px 12px;
  border-radius: var(--r-md);
  background: var(--c-warn-bg);
  color: var(--c-warn);
  font-size: 12.5px;
}
.reclass {
  padding-top: 16px;
  border-top: 1px solid var(--c-border);
}
.reclass-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.reclass-row .btn {
  grid-column: 1 / -1;
}
.detail-actions {
  padding-top: 4px;
}

.detail-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 6px;
  padding: 28px;
  color: var(--c-faint);
}
.detail-empty-title {
  margin: 4px 0 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--c-text-2);
}
.detail-empty .muted {
  max-width: 240px;
  line-height: 1.6;
}

/* ---------- 响应式 ---------- */
.side-mask {
  display: none;
}

@media (max-width: 1240px) {
  .detail {
    width: 330px;
  }
}

@media (max-width: 1024px) {
  .sidebar {
    width: 224px;
  }
  .detail {
    width: 300px;
  }
  .brand-name {
    display: none;
  }
}

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
    width: 80vw;
    max-width: 300px;
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
  .detail {
    position: fixed;
    inset: var(--topbar-h) 0 0 0;
    width: auto;
    z-index: 70;
    transform: translateX(100%);
    transition: transform var(--t);
    box-shadow: var(--shadow-lg);
  }
  .detail.open {
    transform: translateX(0);
  }
  .detail-close {
    display: inline-flex;
  }
  .detail:not(.open) {
    pointer-events: none;
  }
  .search {
    max-width: none;
  }
}

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
}
</style>
