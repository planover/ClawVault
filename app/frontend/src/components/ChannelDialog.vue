<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { api } from '../api.js';
import { toast } from '../toast.js';
import Icon from './Icon.vue';

const props = defineProps({ show: Boolean, channels: Array });
const emit = defineEmits(['close', 'changed']);

const providers = ref([]);
const selProvider = ref('wechat_ilink');
const newName = ref('');
const config = ref({});
const qr = ref(null);
const notice = ref('');
const confirmId = ref(null); // 待二次确认删除的通道 id
const busy = ref(false);

async function loadProviders() {
  try {
    providers.value = await api.providers();
    if (!providers.value.find((p) => p.id === selProvider.value)) {
      selProvider.value = providers.value[0]?.id || 'webhook';
    }
  } catch (e) {
    toast.error('接入类型加载失败：' + (e.message || e));
  }
}
onMounted(loadProviders);
watch(() => props.show, (v) => v && loadProviders());

const currentMeta = computed(() => providers.value.find((p) => p.id === selProvider.value) || {});

// 切换 Provider 时重置配置表单（不同接入类型的字段不同，不能串味）
watch(selProvider, () => {
  config.value = {};
});

// 统一错误出口：所有通道操作都必须落到 toast，避免静默失败让用户以为没生效
async function run(action, okMsg) {
  if (busy.value) return false;
  busy.value = true;
  try {
    await action();
    if (okMsg) toast.success(okMsg);
    return true;
  } catch (e) {
    toast.error(e?.message || '操作失败');
    return false;
  } finally {
    busy.value = false;
  }
}

async function add() {
  if (!newName.value.trim()) {
    toast.error('请先填写通道名');
    return;
  }
  const name = newName.value.trim();
  const ok = await run(() => api.createChannel(name, selProvider.value, { ...config.value }));
  if (!ok) return;
  newName.value = '';
  config.value = {};
  const m = currentMeta.value;
  if (m.auth === 'webhook') {
    notice.value = '已创建。外部系统请 POST 到 /api/inbound/<通道ID> 推送消息（列表里可复制通道 ID）。';
  } else {
    notice.value = '';
  }
  emit('changed');
}

async function remove(id) {
  confirmId.value = null;
  const ok = await run(() => api.deleteChannel(id), '通道已删除');
  if (ok) emit('changed');
}

async function login(ch) {
  try {
    const info = await api.loginChannel(ch.id);
    if (ch.auth === 'qr') {
      qr.value = { name: ch.name, ...info };
    } else {
      qr.value = null;
      toast.success(`${ch.name}：已发起连接`);
      emit('changed');
    }
  } catch (e) {
    toast.error(`连接失败：${e?.message || e}`);
  }
}

async function reLogin(ch) {
  const ok = await run(() => api.reLoginChannel(ch.id));
  if (!ok) return;
  qr.value = null;
  toast.success(`${ch.name}：已重置，请重新扫码`);
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
  const ok = await run(() => api.renameChannel(ch.id, name), '通道已重命名');
  if (ok) {
    cancelRename();
    emit('changed');
  }
}

async function copyId(id) {
  try {
    await navigator.clipboard.writeText(id);
    toast.success('通道 ID 已复制');
  } catch {
    toast.error('复制失败，请手动选中复制');
  }
}

function close() {
  qr.value = null;
  notice.value = '';
  confirmId.value = null;
  emit('close');
}
</script>

<template>
  <div v-if="show" class="modal-mask" @click.self="close">
    <div class="modal wide">
      <h3>通道管理</h3>
      <p class="modal-sub">接入一个或多个 Bot，消息会被自动归档到 NAS。</p>

      <!-- 新增通道 -->
      <div class="add-card">
        <div class="add-row">
          <select class="input" v-model="selProvider" aria-label="接入类型">
            <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
          <input class="input" v-model="newName" placeholder="通道名，如 工作Bot" maxlength="20" @keyup.enter="add" />
          <button class="btn" :disabled="busy" @click="add">
            <Icon name="plus" :size="15" /> 添加
          </button>
        </div>
        <p v-if="currentMeta.desc" class="field-hint">{{ currentMeta.desc }}</p>

        <div v-if="currentMeta.configFields?.length" class="cfg">
          <div v-for="f in currentMeta.configFields" :key="f.key" class="field">
            <label :for="`cfg-${f.key}`">{{ f.label }}<span v-if="f.required" class="req">*</span></label>
            <select v-if="f.type === 'select'" :id="`cfg-${f.key}`" class="input" v-model="config[f.key]">
              <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
            </select>
            <input
              v-else
              :id="`cfg-${f.key}`"
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
      <div class="section-label ch-header">已接入 {{ channels.length }} 个通道</div>
      <div v-for="ch in channels" :key="ch.id" class="ch-row">
        <div class="ch-main">
          <template v-if="editingId === ch.id">
            <input
              class="input rename-input"
              :value="editName"
              maxlength="20"
              aria-label="新通道名"
              @input="editName = sanitizeName($event.target.value)"
              @keyup.enter="saveRename(ch)"
              @keyup.esc="cancelRename"
            />
            <button class="btn sm" @click="saveRename(ch)">保存</button>
            <button class="btn sm ghost" @click="cancelRename">取消</button>
          </template>
          <template v-else>
            <span class="ch-name truncate">{{ ch.name }}</span>
            <button class="icon-btn sm" title="重命名通道" aria-label="重命名通道" @click="startRename(ch)">
              <Icon name="edit" :size="14" />
            </button>
            <span class="tag ok" v-if="ch.connected">已连接</span>
            <span class="tag warn" v-else-if="ch.needRescan">需重新扫码</span>
            <span class="tag neutral" v-else>未连接</span>
            <span class="provider muted small">{{ ch.providerName }}</span>
          </template>
        </div>

        <div class="row ch-actions" v-if="editingId !== ch.id">
          <button class="icon-btn sm" title="复制通道 ID" aria-label="复制通道 ID" @click="copyId(ch.id)">
            <Icon name="sheet" :size="15" />
          </button>
          <button class="btn sm ghost" :disabled="busy" @click="login(ch)">
            {{ ch.connected ? '重连' : ch.auth === 'qr' ? '扫码登录' : '连接' }}
          </button>
          <template v-if="ch.needRescan">
            <button class="btn sm ghost" :disabled="busy" @click="reLogin(ch)">重置</button>
          </template>
          <template v-if="confirmId !== ch.id">
            <button class="icon-btn sm danger-text" title="删除通道" aria-label="删除通道" @click="confirmId = ch.id">
              <Icon name="trash" :size="15" />
            </button>
          </template>
          <template v-else>
            <span class="confirm-text">确认删除？</span>
            <button class="btn sm danger" @click="remove(ch.id)">删除</button>
            <button class="btn sm ghost" @click="confirmId = null">取消</button>
          </template>
        </div>
      </div>

      <p v-if="!channels.length" class="muted small empty-ch">还没有通道，选择一种接入类型并添加。</p>

      <!-- 扫码绑定 -->
      <div v-if="qr" class="qr">
        <div class="section-label">扫码绑定「{{ qr.name }}」</div>
        <img v-if="qrSrc" class="qr-img" :src="qrSrc" alt="登录二维码" />
        <div v-else class="muted small qr-fallback">
          <p>二维码链接（请在 App 中打开）：</p>
          <code>{{ qr.qrcodeImg || qr.qrcode }}</code>
        </div>
        <p class="muted small">扫码并在手机确认后，该 bot 的私聊即开始归档。</p>
      </div>

      <div class="modal-actions">
        <button class="btn ghost" @click="close">完成</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.add-card {
  padding: 14px;
  border: 1px solid var(--c-border);
  border-radius: var(--r-lg);
  background: var(--c-surface-2);
  margin-bottom: 20px;
}
.add-row {
  display: grid;
  grid-template-columns: 1.1fr 1.4fr auto;
  gap: 8px;
}
.cfg {
  margin-top: 14px;
  display: grid;
  gap: 12px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-bottom: 0;
}
.req {
  color: var(--c-danger);
  margin-left: 3px;
}
.notice {
  margin: 12px 0 0;
  padding: 9px 11px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--c-primary);
  background: var(--c-primary-soft);
  border-radius: var(--r-sm);
}
.ch-header {
  margin-bottom: 8px;
}
.ch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 0;
  border-bottom: 1px solid var(--c-border);
  flex-wrap: wrap;
}
.ch-main {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
}
.ch-name {
  font-size: 13.5px;
  font-weight: 600;
}
.provider {
  white-space: nowrap;
}
.ch-actions {
  flex-shrink: 0;
  gap: 4px;
}
.danger-text {
  color: var(--c-faint);
}
.danger-text:hover {
  color: var(--c-danger);
  background: var(--c-danger-bg);
}
.confirm-text {
  font-size: 12px;
  color: var(--c-danger);
  white-space: nowrap;
}
.rename-input {
  width: 150px;
  height: 30px;
}
.empty-ch {
  padding: 4px 0 8px;
}
.qr {
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid var(--c-border);
  text-align: center;
}
.qr-img {
  width: 200px;
  height: 200px;
  margin: 12px 0 8px;
  border-radius: var(--r-md);
  border: 1px solid var(--c-border);
  background: #fff;
}
.qr-fallback {
  text-align: left;
  word-break: break-all;
}
.qr-fallback p {
  margin: 8px 0 4px;
}

@media (max-width: 560px) {
  .add-row {
    grid-template-columns: 1fr;
  }
  .ch-row {
    flex-direction: column;
    align-items: stretch;
  }
  .ch-actions {
    justify-content: flex-end;
  }
}
</style>
