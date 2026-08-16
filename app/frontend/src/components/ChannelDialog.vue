<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { api } from '../api.js';

const props = defineProps({ show: Boolean, channels: Array });
const emit = defineEmits(['close', 'changed']);

const providers = ref([]);
const selProvider = ref('wechat_ilink');
const newName = ref('');
const config = ref({});
const qr = ref(null);
const notice = ref('');

async function loadProviders() {
  try {
    providers.value = await api.providers();
    if (!providers.value.find((p) => p.id === selProvider.value)) {
      selProvider.value = providers.value[0]?.id || 'webhook';
    }
  } catch {
    /* ignore */
  }
}
onMounted(loadProviders);
watch(() => props.show, (v) => v && loadProviders());

const currentMeta = computed(() => providers.value.find((p) => p.id === selProvider.value) || {});

// 切换 Provider 时重置配置表单
watch(selProvider, () => {
  config.value = {};
});

async function add() {
  notice.value = '';
  await api.createChannel(newName.value, selProvider.value, { ...config.value });
  newName.value = '';
  config.value = {};
  const m = currentMeta.value;
  if (m.auth === 'webhook') {
    notice.value = `已创建。外部系统请 POST 到 /api/inbound/<通道ID> 推送消息（通道管理列表里可看到 ID）。`;
  }
  emit('changed');
}
async function remove(id) {
  await api.deleteChannel(id);
  emit('changed');
}
async function login(ch) {
  const info = await api.loginChannel(ch.id);
  if (ch.auth === 'qr') qr.value = { name: ch.name, ...info };
  else {
    qr.value = null;
    emit('changed');
  }
}
async function reLogin(ch) {
  await api.reLoginChannel(ch.id);
  qr.value = null;
  emit('changed');
}

const qrSrc = computed(() => {
  if (!qr.value) return '';
  if (qr.value.qrcodeDataUrl) return qr.value.qrcodeDataUrl;
  const img = qr.value.qrcodeImg || '';
  if (img.startsWith('data:image')) return img;
  if (img.startsWith('http')) return img;
  if (img) return 'data:image/png;base64,' + img;
  return '';
});

// 通道重命名：限制 20 字、过滤文件系统非法字符
const editingId = ref(null);
const editName = ref('');
function startRename(ch) {
  editingId.value = ch.id;
  editName.value = ch.name;
}
function sanitizeName(v) {
  return (v || '').replace(/[\\/:*?"<>|]/g, '').slice(0, 20);
}
function cancelRename() {
  editingId.value = null;
  editName.value = '';
}
async function saveRename(ch) {
  const name = sanitizeName(editName.value);
  if (!name || name === ch.name) {
    cancelRename();
    return;
  }
  await api.renameChannel(ch.id, name);
  cancelRename();
  emit('changed');
}

function close() {
  qr.value = null;
  notice.value = '';
  emit('close');
}
</script>

<template>
  <div v-if="show" class="modal-mask" @click.self="close">
    <div class="modal wide">
      <h3>通道管理（多 Bot 接入）</h3>

      <!-- 新增通道 -->
      <div class="card">
        <div class="row">
          <select class="input" v-model="selProvider">
            <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.icon }} {{ p.name }}</option>
          </select>
          <input class="input" v-model="newName" placeholder="通道名，如 工作Bot" @keyup.enter="add" />
          <button class="btn primary" @click="add">添加</button>
        </div>
        <p class="muted small">{{ currentMeta.desc }}</p>

        <div v-if="currentMeta.configFields?.length" class="cfg">
          <div v-for="f in currentMeta.configFields" :key="f.key" class="field">
            <label>{{ f.label }}<span v-if="f.required" class="req">*</span></label>
            <select
              v-if="f.type === 'select'"
              class="input"
              v-model="config[f.key]"
            >
              <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
            </select>
            <input
              v-else
              class="input"
              :type="f.type === 'password' ? 'password' : 'text'"
              v-model="config[f.key]"
              :placeholder="f.placeholder || ''"
            />
          </div>
        </div>
        <p v-if="notice" class="notice">{{ notice }}</p>
      </div>

      <!-- 已有通道 -->
      <div v-for="ch in channels" :key="ch.id" class="ch-row">
        <div class="ch-main">
          <template v-if="editingId === ch.id">
            <input
              class="input rename-input"
              :value="editName"
              maxlength="20"
              @input="editName = sanitizeName($event.target.value)"
              @keyup.enter="saveRename(ch)"
              @keyup.esc="cancelRename"
            />
            <button class="btn ghost small-btn" @click="saveRename(ch)">保存</button>
            <button class="btn ghost small-btn" @click="cancelRename">取消</button>
          </template>
          <template v-else>
            <b>{{ ch.providerIcon }} {{ ch.name }}</b>
            <button class="icon-edit" title="重命名通道" aria-label="重命名通道" @click="startRename(ch)">✎</button>
            <span class="tag ok" v-if="ch.connected">已连接</span>
            <span class="tag warn" v-else-if="ch.needRescan">需重新扫码</span>
            <span class="muted" v-else>未连接</span>
            <span class="muted small">· {{ ch.providerName }}</span>
          </template>
        </div>
        <div class="row" v-if="editingId !== ch.id">
          <button class="btn ghost" @click="login(ch)">
            {{ ch.connected ? '重连' : ch.auth === 'qr' ? '扫码登录' : '连接' }}
          </button>
          <button class="btn danger" @click="remove(ch.id)">删除</button>
        </div>
      </div>
      <div v-if="!channels.length" class="muted" style="margin: 10px 0">
        还没有通道，选择一个 Bot 类型并添加。
      </div>

      <div v-if="qr" class="qr">
        <h3>用{{ qr.name.includes('微信') ? '微信' : '对应 App' }}扫码绑定「{{ qr.name }}」</h3>
        <img v-if="qrSrc" :src="qrSrc" style="width: 220px; height: 220px" />
        <div v-else class="muted">
          二维码链接（请在 App 中打开）：<br />
          <code>{{ qr.qrcodeImg || qr.qrcode }}</code>
        </div>
        <p class="muted">扫码并在手机确认后，该 bot 的私聊即开始归档。</p>
      </div>

      <div class="row" style="margin-top: 16px; justify-content: flex-end">
        <button class="btn" @click="close">完成</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.card {
  border: 1px solid #eef0f3;
  border-radius: 10px;
  padding: 12px;
  margin-bottom: 14px;
  background: #fafbfc;
}
.cfg {
  margin-top: 10px;
  display: grid;
  gap: 8px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.field label {
  font-size: 12px;
  color: #4b5563;
}
.req {
  color: #dc2626;
}
.row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.small {
  font-size: 12px;
}
.notice {
  margin-top: 10px;
  font-size: 12px;
  color: #1d4ed8;
  background: #eff6ff;
  padding: 8px 10px;
  border-radius: 8px;
}
.ch-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid #eef0f3;
}
.ch-main {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
}
.icon-edit {
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 13px;
  color: #6b7280;
  padding: 2px 4px;
  border-radius: 6px;
  line-height: 1;
}
.icon-edit:hover {
  background: #eef2ff;
  color: #2563eb;
}
.rename-input {
  width: 160px;
  padding: 5px 8px;
}
.small-btn {
  padding: 5px 10px;
  font-size: 12px;
}
.qr {
  margin-top: 16px;
  text-align: center;
  border-top: 1px solid #eef0f3;
  padding-top: 12px;
}
code {
  word-break: break-all;
}
.tag {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 6px;
  margin-left: 6px;
}
.tag.ok {
  background: #dcfce7;
  color: #15803d;
}
.tag.warn {
  background: #fef3c7;
  color: #b45309;
}
.muted {
  color: #8a9099;
}
.wide {
  width: 560px;
  max-width: 94vw;
}
</style>
