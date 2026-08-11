<script setup>
import { ref, onMounted } from 'vue';
import { api, connectWS } from './api.js';
import FolderTree from './components/FolderTree.vue';
import MessageList from './components/MessageList.vue';
import ChannelDialog from './components/ChannelDialog.vue';
import SettingsDialog from './components/SettingsDialog.vue';

const channels = ref([]);
const folders = ref([]);
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
  loadMessages();
  connectWS(onWSEvent);
});
</script>

<template>
  <div class="app">
    <header class="top">
      <div class="brand">🐾 飞牛爪匣 <span class="muted">FnClawVault</span></div>
      <div class="spacer"></div>
      <button class="btn ghost" @click="showChannels = true">通道管理 ({{ channels.length }})</button>
      <button class="btn ghost" @click="showSettings = true">设置</button>
    </header>

    <div class="body">
      <aside class="side">
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
</style>
