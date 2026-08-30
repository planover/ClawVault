<script setup>
import { ref, watch, onMounted } from 'vue';
import { api } from '../api.js';
import { toast } from '../toast.js';
import { pickArchiveDir, inFnosHost, revealInFileManager } from '../fnos.js';
import Icon from './Icon.vue';

const props = defineProps({ show: Boolean, mode: String, themeStyle: String });
const emit = defineEmits(['close', 'saved', 'set-mode', 'set-style']);

// 外观：模式（跟随系统 / 浅色 / 深色）+ 风格，改动直接冒泡到 App 做持久化
const modeOptions = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];
// 风格键值必须与主题 CSS 的 [data-theme-style='…'] 选择器一致：
//   default → style.css 默认；ios-classic → theme-ios-classic.css；ios27 → theme-ios27.css
const styleOptions = [
  { value: 'default', label: '默认' },
  { value: 'ios-classic', label: 'iOS 经典' },
  { value: 'ios27', label: 'iOS 27' },
];
function onSetMode(v) {
  emit('set-mode', v);
}
function onSetStyle(v) {
  emit('set-style', v);
}

const settings = ref(null);
const testing = ref(false);
const testResult = ref(null); // { ok, model, latencyMs, sample } | { ok:false, error }
const saving = ref(false);
const inHost = ref(false);
const pickError = ref('');

// API Key 不回显：后端 GET 返回 '******'，这里用独立输入框承载用户的新输入，
// 未填写则保持原值不变。这样「打开设置 → 直接保存」不会把密钥写成掩码。
const MASK = '******';
const keySaved = ref(false);
const keyInput = ref('');

onMounted(async () => {
  inHost.value = await inFnosHost();
});

// 调起飞牛原生目录选择器：选中即把该目录授权给 ClawVault（scope: trim.file.sharedAccess）
async function chooseArchiveDir() {
  pickError.value = '';
  try {
    const p = await pickArchiveDir();
    if (p) settings.value.archiveRoot = p;
    else pickError.value = '未选择目录（或当前环境不支持选择器）';
  } catch (e) {
    pickError.value = e?.message || '目录选择失败';
  }
}

function openArchiveDir() {
  revealInFileManager(settings.value?.archiveRoot);
}

async function load() {
  try {
    const s = await api.getSettings();
    s.ingest.whitelistText = (s.ingest.whitelist || []).join(', ');
    keySaved.value = s.ai.apiKey === MASK;
    keyInput.value = '';
    // 掩码不能直接放进可编辑输入框，否则用户一保存就把 '******' 写回去
    if (keySaved.value) s.ai.apiKey = '';
    settings.value = s;
  } catch (e) {
    toast.error('设置加载失败：' + (e.message || e));
  }
}

watch(
  () => props.show,
  (v) => {
    if (v) {
      testResult.value = null;
      pickError.value = '';
      load();
    }
  },
);

async function save() {
  if (!settings.value || saving.value) return;
  saving.value = true;
  try {
    const ingest = { ...settings.value.ingest };
    ingest.whitelist = (ingest.whitelistText || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    delete ingest.whitelistText;

    const ai = { ...settings.value.ai };
    // 留空 = 沿用已保存的密钥；只有用户真正输入了新值才覆盖
    ai.apiKey = keyInput.value.trim() || (keySaved.value ? MASK : '');

    await api.saveSettings({
      ai,
      ingest,
      classification: settings.value.classification,
      archiveRoot: settings.value.archiveRoot,
    });
    emit('saved');
    emit('close');
    toast.success('设置已保存');
  } catch (e) {
    toast.error('保存失败：' + (e.message || e));
  } finally {
    saving.value = false;
  }
}

async function testAI() {
  testing.value = true;
  testResult.value = null;
  try {
    const r = await api.testAI({
      apiKey: keyInput.value.trim() || (keySaved.value ? MASK : ''),
      baseUrl: settings.value.ai.baseUrl,
      model: settings.value.ai.model,
    });
    testResult.value = r;
  } catch (e) {
    testResult.value = { ok: false, error: e.message || '测试失败' };
  } finally {
    testing.value = false;
  }
}
</script>

<template>
  <div v-if="show" class="modal-mask" @click.self="emit('close')">
    <div class="modal" v-if="settings">
      <h3>设置</h3>
      <p class="modal-sub">外观、归档位置、AI 分类与语音转写。</p>

      <!-- 外观 -->
      <div class="section-label section-title">外观</div>
      <div class="field">
        <label>模式</label>
        <div class="seg-group" role="group" aria-label="主题模式">
          <button
            v-for="o in modeOptions"
            :key="o.value"
            class="seg"
            :class="{ on: props.mode === o.value }"
            :aria-pressed="props.mode === o.value"
            @click="onSetMode(o.value)"
          >
            {{ o.label }}
          </button>
        </div>
        <p class="field-hint">选择「跟随系统」时，会随操作系统深浅色设置自动切换。</p>
      </div>
      <div class="field">
        <label>风格</label>
        <div class="seg-group" role="group" aria-label="主题风格">
          <button
            v-for="o in styleOptions"
            :key="o.value"
            class="seg"
            :class="{ on: props.themeStyle === o.value }"
            :aria-pressed="props.themeStyle === o.value"
            @click="onSetStyle(o.value)"
          >
            {{ o.label }}
          </button>
        </div>
        <p class="field-hint">「iOS 经典」为独立视觉风格，具备细腻光影、半透明层次与圆润控件质感；「iOS 27」为强玻璃质感风格，采用半透明毛玻璃背景、细腻高光边框、层次化景深与光折射效果。两套风格均完整适配浅色与深色。</p>
      </div>

      <!-- 归档 -->
      <div class="section-label section-title">归档</div>
      <div class="field">
        <label for="s-archive">归档根目录</label>
        <div class="row">
          <input id="s-archive" class="input" v-model="settings.archiveRoot" />
          <template v-if="inHost">
            <button class="btn ghost" type="button" title="选择目录" @click="chooseArchiveDir">选择…</button>
            <button class="icon-btn" type="button" title="在文件管理器中打开" aria-label="在文件管理器中打开" @click="openArchiveDir">
              <Icon name="external" :size="16" />
            </button>
          </template>
        </div>
        <p v-if="pickError" class="field-hint warn-text">{{ pickError }}</p>
      </div>

      <div class="field">
        <label for="s-wl">仅归档这些联系人</label>
        <input id="s-wl" class="input" v-model="settings.ingest.whitelistText" placeholder="留空 = 归档全部；多个用逗号分隔" />
        <p class="field-hint">填写后，只有来自这些会话对象的消息会被归档。</p>
      </div>

      <label class="toggle-row">
        <span>
          <span class="toggle-label">消息接收回执</span>
          <span class="field-hint">Bot 收到消息后自动向发送者回复归档回执（接收日期 + 总条数 + 各类型条数，数量为 0 的类型不显示）。同一会话短时间内的多条消息会合并为一封回执。</span>
        </span>
        <button
          class="switch"
          :class="{ on: settings.ingest.auto_reply_receipt }"
          role="switch"
          :aria-checked="settings.ingest.auto_reply_receipt"
          aria-label="消息接收回执"
          @click="settings.ingest.auto_reply_receipt = !settings.ingest.auto_reply_receipt"
        ></button>
      </label>

      <!-- AI -->
      <div class="section-label section-title">AI 自动分类</div>
      <label class="toggle-row">
        <span>
          <span class="toggle-label">启用分类</span>
          <span class="field-hint">未配置密钥时，消息会归入「未分类」，仍可正常归档与检索。</span>
        </span>
        <button
          class="switch"
          :class="{ on: settings.classification.enabled }"
          role="switch"
          :aria-checked="settings.classification.enabled"
          aria-label="启用分类"
          @click="settings.classification.enabled = !settings.classification.enabled"
        ></button>
      </label>

      <label class="toggle-row">
        <span>
          <span class="toggle-label">优先按平台类型归类</span>
          <span class="field-hint">图片、文件、语音等直接用平台判定的类型归档，省掉一次 AI 调用。</span>
        </span>
        <button
          class="switch"
          :class="{ on: settings.classification.usePlatformType }"
          role="switch"
          :aria-checked="settings.classification.usePlatformType"
          aria-label="优先按平台类型归类"
          @click="settings.classification.usePlatformType = !settings.classification.usePlatformType"
        ></button>
      </label>

      <div class="form-grid">
        <div class="field">
          <label for="s-key">API Key</label>
          <input
            id="s-key"
            class="input"
            type="password"
            v-model="keyInput"
            :placeholder="keySaved ? '已保存，留空保持不变' : 'sk-…'"
            autocomplete="off"
          />
        </div>
        <div class="field">
          <label for="s-base">Base URL</label>
          <input id="s-base" class="input" v-model="settings.ai.baseUrl" />
        </div>
        <div class="field">
          <label for="s-model">模型</label>
          <input id="s-model" class="input" v-model="settings.ai.model" />
        </div>
      </div>

      <div class="row test-row">
        <button class="btn ghost sm" :disabled="testing" @click="testAI">
          <Icon v-if="!testing" name="sparkle" :size="14" />
          <span v-else class="spinner"></span>
          {{ testing ? '测试中…' : '测试连接' }}
        </button>
        <span v-if="testResult" class="test" :class="testResult.ok ? 'ok' : 'fail'">
          <template v-if="testResult.ok">
            ✓ {{ testResult.model }} · {{ testResult.latencyMs }}ms · 样例：{{ testResult.sample.category
            }}<template v-if="testResult.sample.sub"> / {{ testResult.sample.sub }}</template>
          </template>
          <template v-else>✗ {{ testResult.error }}</template>
        </span>
      </div>

      <!-- 语音 -->
      <div class="section-label section-title">语音转写（可选）</div>
      <div class="form-grid">
        <div class="field">
          <label for="s-stt">STT 接口地址</label>
          <input id="s-stt" class="input" v-model="settings.ai.sttUrl" placeholder="https://api.openai.com/v1/audio/transcriptions" />
        </div>
        <div class="field">
          <label for="s-sttm">STT 模型</label>
          <input id="s-sttm" class="input" v-model="settings.ai.sttModel" placeholder="whisper-1" />
        </div>
      </div>
      <p class="field-hint">
        语音消息在社交端没有转写文字时，用这个端点补转；需兼容 OpenAI <code>/v1/audio/transcriptions</code>。留空则只保存音频、不转写。
      </p>

      <div class="modal-actions">
        <button class="btn ghost" @click="emit('close')">取消</button>
        <button class="btn" :disabled="saving" @click="save">保存</button>
      </div>
    </div>

    <div class="modal" v-else>
      <h3>设置</h3>
      <p class="muted small">加载中…</p>
    </div>
  </div>
</template>

<style scoped>
.section-title {
  margin: 22px 0 12px;
  padding-bottom: 7px;
  border-bottom: 1px solid var(--c-border);
}
.field {
  margin-bottom: 14px;
}
.field > label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 8px;
}
.seg-group {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  background: var(--c-surface-3);
  border-radius: var(--r-sm);
  max-width: 100%;
}
.seg {
  padding: 6px 16px;
  border-radius: var(--r-xs);
  font-size: 13px;
  color: var(--c-text-2);
  white-space: nowrap;
  transition: background var(--t-fast), color var(--t-fast), box-shadow var(--t-fast);
}
.seg:hover {
  color: var(--c-text);
}
.seg.on {
  background: var(--c-surface);
  color: var(--c-primary);
  font-weight: 600;
  box-shadow: var(--shadow-xs);
}
.toggle-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 9px 0;
  cursor: pointer;
}
.toggle-label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 2px;
}
.toggle-row .field-hint {
  max-width: 380px;
}
.test-row {
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 2px;
}
.test {
  font-size: 12px;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.test.ok {
  color: var(--c-success);
}
.test.fail {
  color: var(--c-danger);
}
.warn-text {
  color: var(--c-warn);
}
</style>
