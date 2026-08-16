<script setup>
import { ref, onMounted } from 'vue';
import { api, connectWS } from './api.js';
import FolderTree from './components/FolderTree.vue';
import MessageList from './components/MessageList.vue';
import ChannelDialog from './components/ChannelDialog.vue';
import SettingsDialog from './components/SettingsDialog.vue';

const channels = ref([]);
const folders = ref([]);
const chats = ref([]);
const messages = ref([]);
const filter = ref({ channelName: '', category: '', sub: '' });
const selectedId = ref(null);
const selectedMessage = ref(null);
const showChannels = ref(false);
const showSettings = ref(false);
const newCat = ref('');
const newSub = ref('');

function channelIdByName(name) {
  const c = channels.value.find((c) => c.name === name);
  return c ? c.id : '';
}

async function loadChannels() {
  channels.value = await api.listChannels();
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
async function loadMessages() {
  const q = {};
  const cid = channelIdByName(filter.value.channelName);
  if (cid) q.channelId = cid;
  if (filter.value.category) q.category = filter.value.category;
  if (filter.value.sub) q.sub = filter.value.sub;
  const r = await api.listMessages(q);
  messages.value = r.items;
}

async function onSelectFilter(f) {
  filter.value = f;
  selectedId.value = null;
  selectedMessage.value = null;
  await loadMessages();
}
function onSelectMessage(id) {
  selectedId.value = id;
  selectedMessage.value = messages.value.find((m) => m.id === id) || null;
  newCat.value = selectedMessage.value?.category || '';
  newSub.value = selectedMessage.value?.sub || '';
}
async function doReclassify() {
  if (!selectedMessage.value || !newCat.value) return;
  await api.reclassify(selectedMessage.value.id, newCat.value, newSub.value);
  selectedMessage.value = { ...selectedMessage.value, category: newCat.value, sub: newSub.value };
  await loadMessages();
  await loadFolders();
}

function onWSEvent(e) {
  if (e.type === 'message' || e.type === 'reclassify') {
    loadMessages();
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

onMounted(() => {
  loadChannels();
  loadFolders();
  loadChats();
  loadMessages();
  connectWS(onWSEvent);
});
</script>

<template>
  <div class="app">
    <header class="top">
      <div class="brand">🐾 ClawVault <span class="muted">爪匣</span></div>
      <div class="spacer"></div>
      <button class="btn ghost" @click="showChannels = true">通道管理 ({{ channels.length }})</button>
      <button class="btn ghost" @click="showSettings = true">设置</button>
    </header>

    <div class="body">
      <aside class="side">
        <div class="side-sec">
          <div class="side-title">聊天归档</div>
          <div v-for="c in chats" :key="c.channel" class="chat-row">
            <span class="chat-name">💬 {{ c.channel }}</span>
            <a class="chat-dl" :href="c.downloadUrl" :download="`${c.channel}-聊天.xlsx`">⬇️ 聊天.xlsx</a>
            <span v-if="c.hasVoice" title="含语音">🎧</span>
            <span class="muted small">{{ c.rows }} 行</span>
          </div>
          <div v-if="!chats.length" class="muted small">暂无聊天归档</div>
        </div>
        <FolderTree :folders="folders" :selected="filter" @select="onSelectFilter" />
      </aside>

      <main class="main">
        <MessageList :messages="messages" :selectedId="selectedId" @select="onSelectMessage" />
      </main>

      <section class="detail" v-if="selectedMessage">
        <div class="meta">
          <span class="tag">{{ selectedMessage.category }}<template v-if="selectedMessage.sub"> / {{ selectedMessage.sub }}</template></span>
          <span class="muted">{{ selectedMessage.channelName }} · {{ new Date(selectedMessage.ts).toLocaleString('zh-CN') }}</span>
        </div>
        <div class="content">{{ selectedMessage.text }}</div>
        <div v-if="selectedMessage.kind === 'image' && selectedMessage.media" class="media">
          <div class="muted small">图片</div>
          <img :src="api.mediaUrl(selectedMessage.id)" alt="图片" />
        </div>
        <div v-else-if="selectedMessage.kind === 'video' && selectedMessage.media" class="media">
          <div class="muted small">视频</div>
          <video controls :src="api.mediaUrl(selectedMessage.id)"></video>
        </div>
        <div v-else-if="selectedMessage.kind === 'file' && selectedMessage.media" class="media">
          <div class="muted small">文件</div>
          <a :href="api.mediaUrl(selectedMessage.id)" target="_blank" download>📎 下载文件</a>
        </div>
        <div v-else-if="['image', 'video', 'file'].includes(selectedMessage.kind) && !selectedMessage.media" class="media">
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
      <section class="detail empty" v-else>
        <div class="muted">选择左侧分类或消息查看详情</div>
      </section>
    </div>

    <ChannelDialog :show="showChannels" :channels="channels" @close="showChannels = false" @changed="loadChannels" />
    <SettingsDialog :show="showSettings" @close="showSettings = false" @saved="loadFolders" />
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
  background: #fff;
  border-bottom: 1px solid #e5e7eb;
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
  width: 240px;
  border-right: 1px solid #e5e7eb;
  background: #fff;
  overflow: auto;
  padding: 10px;
}
.main {
  flex: 1;
  overflow: hidden;
  background: #fff;
  border-right: 1px solid #e5e7eb;
}
.detail {
  width: 340px;
  padding: 16px;
  overflow: auto;
  background: #fafbfc;
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
  font-size: 14px;
  line-height: 1.6;
  color: #1f2329;
}
.reclass {
  margin-top: 20px;
  border-top: 1px solid #e5e7eb;
  padding-top: 12px;
}
.reclass h4 {
  margin: 0 0 8px;
}
.muted {
  color: #8a9099;
}
.side-sec {
  border-bottom: 1px solid #e5e7eb;
  padding: 10px 10px 12px;
  margin-bottom: 6px;
}
.side-title {
  font-size: 12px;
  font-weight: 600;
  color: #4b5563;
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
}
.chat-dl {
  color: #2563eb;
  text-decoration: none;
  font-size: 12px;
}
.chat-dl:hover {
  text-decoration: underline;
}
.voice {
  margin-top: 14px;
  border-top: 1px solid #e5e7eb;
  padding-top: 12px;
}
.voice audio {
  width: 100%;
  margin-top: 6px;
}
.media {
  margin-top: 14px;
  border-top: 1px solid #e5e7eb;
  padding-top: 12px;
}
.media img,
.media video {
  max-width: 100%;
  border-radius: 8px;
  border: 1px solid #e5e7eb;
}
</style>
