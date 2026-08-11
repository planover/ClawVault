<script setup>
import { ref, watch } from 'vue';
import { api } from '../api.js';

const props = defineProps({ show: Boolean });
const emit = defineEmits(['close', 'saved']);
const settings = ref(null);
const testing = ref(false);
const testResult = ref(null); // { ok, model, latencyMs, sample, raw } | { ok:false, error }

async function load() {
  const s = await api.getSettings();
  s.ingest.whitelistText = (s.ingest.whitelist || []).join(', ');
  settings.value = s;
}
watch(
  () => props.show,
  (v) => {
    if (v) {
      testResult.value = null;
      load();
    }
  },
);

async function save() {
  const ingest = { ...settings.value.ingest };
  ingest.whitelist = (ingest.whitelistText || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  delete ingest.whitelistText;
  await api.saveSettings({
    ai: settings.value.ai,
    ingest,
    classification: settings.value.classification,
    archiveRoot: settings.value.archiveRoot,
  });
  emit('saved');
  emit('close');
}

async function testAI() {
  testing.value = true;
  testResult.value = null;
  try {
    const r = await api.testAI({
      apiKey: settings.value.ai.apiKey,
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

      <label class="lbl">归档根目录</label>
      <input class="input" v-model="settings.archiveRoot" />

      <label class="lbl">AI 自动分类</label>
      <div class="row">
        <span class="muted" style="width: 90px">启用分类</span>
        <input type="checkbox" v-model="settings.classification.enabled" />
      </div>
      <div class="row">
        <span class="muted" style="width: 90px">优先平台类型</span>
        <input type="checkbox" v-model="settings.classification.usePlatformType" />
        <span class="muted" style="font-size: 11px">图片/文件/语音等按平台判定归类，减少 AI 调用</span>
      </div>

      <label class="lbl">API Key</label>
      <input class="input" v-model="settings.ai.apiKey" placeholder="sk-..." />
      <label class="lbl">Base URL</label>
      <input class="input" v-model="settings.ai.baseUrl" />
      <label class="lbl">模型</label>
      <input class="input" v-model="settings.ai.model" />

      <label class="lbl">语音转写 STT URL（可选）</label>
      <input class="input" v-model="settings.ai.sttUrl" placeholder="https://api.openai.com/v1/audio/transcriptions" />
      <label class="lbl">STT 模型</label>
      <input class="input" v-model="settings.ai.sttModel" placeholder="whisper-1" />
      <p class="muted" style="margin: 4px 0 0">
        语音消息：社交端无转写时，用此端点 AI 补转；留空则语音只存音频、不转写。需兼容 OpenAI
        <code>/v1/audio/transcriptions</code>。纯文本与语音会写入每通道的 <b>聊天.xlsx</b>。
      </p>

      <div class="row" style="margin-top: 10px">
        <button class="btn ghost" :disabled="testing" @click="testAI">
          {{ testing ? '测试中…' : '测试连接' }}
        </button>
        <span v-if="testResult" class="test" :class="testResult.ok ? 'ok' : 'fail'">
          <template v-if="testResult.ok">
            ✓ 连接成功 · {{ testResult.model }} · {{ testResult.latencyMs }}ms · 样例分类：{{ testResult.sample.category }}<template v-if="testResult.sample.sub"> / {{ testResult.sample.sub }}</template>
          </template>
          <template v-else>✗ {{ testResult.error }}</template>
        </span>
      </div>

      <label class="lbl">仅归档白名单联系人（留空 = 全部 bot）</label>
      <input class="input" v-model="settings.ingest.whitelistText" placeholder="逗号分隔的 wechat id" />

      <p class="muted" style="margin-top: 12px">
        未配置 AI 时，分类退化为「未分类」，仍可正常归档与全文检索。
      </p>

      <div class="row" style="margin-top: 16px; justify-content: flex-end">
        <button class="btn ghost" @click="emit('close')">取消</button>
        <button class="btn" @click="save">保存</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lbl {
  display: block;
  font-size: 12px;
  margin: 12px 0 4px;
  color: #4b5563;
}
.test {
  font-size: 12px;
  font-weight: 600;
}
.test.ok {
  color: #15803d;
}
.test.fail {
  color: #b91c1c;
}
</style>
