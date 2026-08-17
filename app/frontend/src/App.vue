<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { api, connectWS } from './api.js';
import { setWindowTitle } from './fnos.js';
import FolderTree from './components/FolderTree.vue';
import MessageList from './components/MessageList.vue';
import ChannelDialog from './components/ChannelDialog.vue';
import SettingsDialog from './components/SettingsDialog.vue';
import AboutDialog from './components/AboutDialog.vue';

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

const loading = ref(false);
const loadingMore = ref(false);
const total = ref(0);
const limit = 30;
const offset = ref(0);

const showSide = ref(false); // 移动端侧栏抽屉
const showDetail = ref(false); // 移动端详情覆盖层

const KIND_LABELS = [
  { value: '', label: '全部' },
  { value: 'text', label: '文本' },
  { value: 'voice', label: '语音' },
  { value: 'image', label: '图片' },
  { value: 'sticker', label: '表情' },
  { value: 'video', label: '视频' },
  { value: 'file', label: '文件' },
];

const hasMore = computed(() => messages.value.length < total.value);

const emptyText = computed(() => {
  if (filter.q) return `未找到包含「${filter.q}」的消息`;
  if (filter.kind) return `该类型下暂无消息`;
  return '该分类下暂无消息';
});

function channelIdByName(name) {
  const c = channels.value.find((c) => c.name === name);
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
  q.limit = limit;
  q.offset = offset.value;
  try {
    const r = await api.listMessages(q);
    total.value = r.total;
    messages.value = reset ? r.items : messages.value.concat(r.items);
  } finally {
    loading.value = false;
    loadingMore.value = false;
  }
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

function onSelectKind(k) {
  filter.kind = k;
  selectedId.value = null;
  selectedMessage.value = null;
  loadMessages(true);
}

function loadMore() {
  offset.value += limit;
  loadMessages(false);
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
  if (!selectedMessage.value || !newCat.value) return;
  await api.reclassify(selectedMessage.value.id, newCat.value, newSub.value);
  selectedMessage.value = { ...selectedMessage.value, category: newCat.value, sub: newSub.value };
  await loadMessages(true);
  await loadFolders();
}

function onWSEvent(e) {
  if (e.type === 'message' || e.type === 'reclassify') {
    loadMessages(true);
    loadFolders();
    loadChats();
    if (e.type === 'reclassify' && selectedMessage.value && e.record.id === selectedMessage.value.id) {
      selectedMessage.value = e.record;
      newCat.value = e.record.category;
      newSub.value = e.record.sub;
    }
  } else if (e.type === 'channels') {
    channels.value = e.channels;
  }
}

async function loadChannels() {
  channels.value = await api.listChannels();
}
// 通道变更（新增/删除/重命名）后，同步刷新侧栏与聊天归档列表
async function onChannelsChanged() {
  await loadChannels();
  await loadFolders();
  await loadChats();
}
async function loadChats() {
  try {
    chats.value = await api.chats();
  } catch {
    chats.value = [];
  }
}
async function loadFolders() {
  folders.value = await api.folders();
}

onMounted(() => {
  loadChannels();
  loadFolders();
  loadChats();
  loadMessages(true);
  connectWS(onWSEvent);
  // 在飞牛桌面窗口内运行时，同步窗口标题（非宿主环境自动忽略）
  setWindowTitle('ClawVault（爪匣）');
});
</script>

<template>
  <div class="app">
    <header class="top">
      <button class="icon-btn hamburger" aria-label="打开目录" @click="toggleSide">☰</button>
      <div class="brand">🐾 ClawVault <span class="muted">爪匣</span></div>
      <div class="spacer"></div>
      <button class="btn ghost" aria-label="通道管理" @click="showChannels = true">通道 ({{ channels.length }})</button>
      <button class="btn ghost" aria-label="关于" @click="showAbout = true">关于</button>
      <button class="btn ghost" aria-label="设置" @click="showSettings = true">设置</button>
    </header>

    <div class="body">
      <!-- 移动端侧栏遮罩 -->
      <div v-if="showSide" class="side-mask" @click="showSide = false"></div>

      <aside class="side" :class="{ open: showSide }">
        <div class="side-sec">
          <div class="side-title">聊天归档</div>
          <div v-for="c in chats" :key="c.channel" class="chat-row">
            <span class="chat-name">💬 {{ c.channel }}</span>
            <a class="chat-dl" :href="c.downloadUrl" :download="`${c.channel}-聊天.xlsx`">⬇️ xlsx</a>
            <span v-if="c.hasVoice" title="含语音">🎧</span>
            <span class="muted small">{{ c.rows }} 行</span>
          </div>
          <div v-if="!chats.length" class="muted small">暂无聊天归档</div>
        </div>
        <FolderTree :folders="folders" :selected="filter" @select="onSelectFilter" />
      </aside>

      <main class="main">
        <div class="toolbar">
          <div class="search">
            <span class="search-ico" aria-hidden="true">🔍</span>
            <input
              class="input search-input"
              type="search"
              :value="filter.q"
              @input="onSearchInput"
              aria-label="搜索消息内容"
              placeholder="搜索消息内容…"
            />
          </div>
          <div class="chips" role="group" aria-label="按类型筛选">
            <button
              v-for="k in KIND_LABELS"
              :key="k.value"
              class="chip"
              :class="{ active: filter.kind === k.value }"
              :aria-pressed="filter.kind === k.value"
              @click="onSelectKind(k.value)"
            >
              {{ k.label }}
            </button>
          </div>
          <div class="count muted small">共 {{ total }} 条</div>
        </div>

        <div class="list-wrap">
          <div v-if="loading" class="loader" role="status" aria-live="polite">
            <span class="spinner" aria-hidden="true"></span> 加载中…
          </div>
          <MessageList
            v-else
            :messages="messages"
            :selectedId="selectedId"
            :emptyText="emptyText"
            @select="onSelectMessage"
          />
          <button v-if="hasMore && !loading" class="btn ghost more" :disabled="loadingMore" @click="loadMore">
            {{ loadingMore ? '加载中…' : '加载更多' }}
          </button>
        </div>
      </main>

      <!-- 桌面端：右侧栏；移动端：全屏覆盖层 -->
      <section class="detail" :class="{ open: showDetail }" v-if="selectedMessage">
        <button class="icon-btn detail-close" aria-label="关闭详情" @click="closeDetail">✕</button>
        <div class="meta">
          <span class="tag">{{ selectedMessage.category }}<template v-if="selectedMessage.sub"> / {{ selectedMessage.sub }}</template></span>
          <span class="muted">{{ selectedMessage.channelName }} · {{ new Date(selectedMessage.ts).toLocaleString('zh-CN') }}</span>
        </div>
        <div class="content">{{ selectedMessage.text }}</div>
        <div v-if="(selectedMessage.kind === 'image' || selectedMessage.kind === 'sticker') && selectedMessage.media" class="media">
          <div class="muted small">{{ selectedMessage.kind === 'sticker' ? '表情' : '图片' }}</div>
          <img v-if="!detailImgFailed" :src="api.mediaUrl(selectedMessage.id)" alt="图片" @error="detailImgFailed = true" />
          <div v-else class="muted small">🖼️ 媒体加载失败</div>
        </div>
        <div v-else-if="selectedMessage.kind === 'video' && selectedMessage.media" class="media">
          <div class="muted small">视频</div>
          <video controls :src="api.mediaUrl(selectedMessage.id)"></video>
        </div>
        <div v-else-if="selectedMessage.kind === 'file' && selectedMessage.media" class="media">
          <div class="muted small">文件</div>
          <a :href="api.mediaUrl(selectedMessage.id)" target="_blank" :download="selectedMessage.filename || ''">
            📎 {{ selectedMessage.filename || '下载文件' }}
          </a>
        </div>
        <div v-else-if="['image', 'video', 'file', 'sticker'].includes(selectedMessage.kind) && !selectedMessage.media" class="media">
          <div class="muted small">⚠️ 该媒体未保存（旧版本或接收时缺失）</div>
        </div>
        <div v-if="selectedMessage.voice" class="voice">
          <div class="muted small">语音</div>
          <audio controls :src="api.voiceUrl(selectedMessage.id)"></audio>
        </div>
        <div class="reclass">
          <h4>重新分类</h4>
          <div class="row">
            <input class="input" v-model="newCat" placeholder="主分类" />
            <input class="input" v-model="newSub" placeholder="子分类(可选)" />
            <button class="btn" @click="doReclassify">保存</button>
          </div>
        </div>
      </section>
      <section class="detail empty" :class="{ open: showDetail }" v-else>
        <div class="muted">选择左侧分类或消息查看详情</div>
      </section>
    </div>

    <ChannelDialog :show="showChannels" :channels="channels" @close="showChannels = false" @changed="onChannelsChanged" />
    <SettingsDialog :show="showSettings" @close="showSettings = false" @saved="loadFolders" />
    <AboutDialog :show="showAbout" @close="showAbout = false" />
  </div>
</template>

<style>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}
.top {
  height: 52px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 16px;
  background: var(--c-surface);
  border-bottom: 1px solid var(--c-border);
  box-shadow: var(--shadow);
  z-index: 30;
}
.brand {
  font-weight: 700;
  font-size: 16px;
}
.body {
  flex: 1;
  display: flex;
  overflow: hidden;
}
.side {
  width: 244px;
  flex-shrink: 0;
  border-right: 1px solid var(--c-border);
  background: var(--c-surface);
  overflow: auto;
  padding: 10px;
}
.main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--c-surface);
  border-right: 1px solid var(--c-border);
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--c-border);
  background: var(--c-surface);
  flex-wrap: wrap;
}
.search {
  position: relative;
  flex: 1;
  min-width: 180px;
}
.search-ico {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 13px;
  opacity: 0.6;
  pointer-events: none;
}
.search-input {
  padding-left: 30px;
}
.chips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.chip {
  border: 1px solid var(--c-border-strong);
  background: var(--c-surface);
  color: var(--c-text-2);
  border-radius: 999px;
  padding: 5px 12px;
  font-size: 12px;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.chip:hover {
  border-color: var(--c-primary);
  color: var(--c-primary);
}
.chip.active {
  background: var(--c-primary);
  border-color: var(--c-primary);
  color: #fff;
}
.count {
  white-space: nowrap;
}
.list-wrap {
  flex: 1;
  overflow: auto;
}
.more {
  display: block;
  margin: 14px auto 20px;
}
.detail {
  width: 340px;
  flex-shrink: 0;
  padding: 16px;
  overflow: auto;
  background: var(--c-bg);
  position: relative;
}
.detail.empty {
  display: flex;
  align-items: center;
  justify-content: center;
}
.detail .meta {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}
.detail .content {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  font-size: 14px;
  line-height: 1.6;
  color: var(--c-text);
}
.reclass {
  margin-top: 20px;
  border-top: 1px solid var(--c-border);
  padding-top: 12px;
}
.reclass h4 {
  margin: 0 0 8px;
}
.muted {
  color: var(--c-muted);
}
.side-sec {
  border-bottom: 1px solid var(--c-border);
  padding: 10px 10px 12px;
  margin-bottom: 6px;
}
.side-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--c-text-2);
  margin-bottom: 6px;
}
.chat-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
  font-size: 13px;
}
.chat-name {
  font-weight: 500;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.chat-dl {
  color: var(--c-primary);
  text-decoration: none;
  font-size: 12px;
}
.chat-dl:hover {
  text-decoration: underline;
}
.voice {
  margin-top: 14px;
  border-top: 1px solid var(--c-border);
  padding-top: 12px;
}
.voice audio {
  width: 100%;
  margin-top: 6px;
}
.media {
  margin-top: 14px;
  border-top: 1px solid var(--c-border);
  padding-top: 12px;
}
.media img,
.media video {
  max-width: 100%;
  border-radius: 8px;
  border: 1px solid var(--c-border);
}

/* 加载态 */
.loader {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 24px;
  color: var(--c-muted);
  font-size: 13px;
}
.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--c-border-strong);
  border-top-color: var(--c-primary);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* 通用按钮焦点态（无障碍） */
:focus-visible {
  outline: 2px solid var(--c-primary);
  outline-offset: 2px;
}
.icon-btn {
  border: none;
  background: transparent;
  font-size: 18px;
  line-height: 1;
  padding: 6px 8px;
  border-radius: 8px;
  color: var(--c-text-2);
  cursor: pointer;
  transition: background 0.15s;
}
.icon-btn:hover {
  background: var(--c-primary-50);
}
.hamburger {
  display: none;
}
.detail-close {
  display: none;
  position: absolute;
  top: 10px;
  right: 10px;
}

/* 平板/中等屏：收窄侧栏与详情，避免主区过窄导致文字/控件拥挤 */
@media (max-width: 1100px) and (min-width: 769px) {
  .side {
    width: 210px;
  }
  .detail {
    width: 300px;
  }
  .toolbar {
    gap: 8px;
  }
}

/* 移动端响应式：≤768px 折叠为单栏 */
@media (max-width: 768px) {
  .hamburger {
    display: inline-flex;
  }
  .side {
    position: fixed;
    left: 0;
    top: 52px;
    bottom: 0;
    z-index: 40;
    width: 78vw;
    max-width: 300px;
    transform: translateX(-100%);
    transition: transform 0.22s ease;
    box-shadow: 2px 0 12px rgba(16, 24, 40, 0.12);
  }
  .side.open {
    transform: translateX(0);
  }
  .side-mask {
    position: fixed;
    inset: 52px 0 0 0;
    background: rgba(0, 0, 0, 0.35);
    z-index: 35;
  }
  .main {
    border-right: none;
  }
  .detail {
    position: fixed;
    inset: 52px 0 0 0;
    width: auto;
    z-index: 45;
    background: var(--c-surface);
    transform: translateX(100%);
    transition: transform 0.22s ease;
  }
  .detail.open {
    transform: translateX(0);
  }
  .detail-close {
    display: inline-flex;
  }
  .detail.empty {
    display: none;
  }
  .toolbar {
    gap: 8px;
  }
}
</style>
