<script setup>
import { ref, watch } from 'vue';
import { api } from '../api.js';

const props = defineProps({ show: Boolean });
const emit = defineEmits(['close']);
const info = ref(null);

watch(
  () => props.show,
  async (v) => {
    if (v) {
      try {
        info.value = await api.about();
      } catch {
        info.value = null;
      }
    }
  },
);
</script>

<template>
  <div v-if="show" class="modal-mask" @click.self="emit('close')">
    <div class="modal about" v-if="info">
      <h3>关于 爪匣 ClawVault</h3>
      <div class="grid">
        <div><span class="k">版本</span><span class="v">{{ info.version || '—' }}</span></div>
        <div><span class="k">开发者</span><span class="v">{{ info.developer }}</span></div>
        <div><span class="k">开源协议</span><span class="v">{{ info.license }}</span></div>
      </div>
      <p class="desc">{{ info.description }}</p>
      <ul class="links">
        <li><a :href="info.repo" target="_blank" rel="noopener">📦 GitHub 仓库</a></li>
        <li><a :href="info.changelog" target="_blank" rel="noopener">📝 更新日志</a></li>
        <li><a :href="info.licenseUrl" target="_blank" rel="noopener">⚖️ 开源许可 ({{ info.license }})</a></li>
        <li><a :href="info.privacyUrl" target="_blank" rel="noopener">🔒 隐私说明</a></li>
      </ul>
      <p class="muted small privacy">{{ info.privacyNote }}</p>
      <div class="row" style="justify-content: flex-end; margin-top: 16px">
        <button class="btn" @click="emit('close')">关闭</button>
      </div>
    </div>
    <div class="modal about" v-else>
      <h3>关于 爪匣 ClawVault</h3>
      <p class="muted">加载中…</p>
    </div>
  </div>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin: 6px 0 12px;
}
.grid > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--c-primary-50, #eff6ff);
  border-radius: 8px;
  padding: 8px 10px;
}
.k {
  font-size: 11px;
  color: var(--c-muted, #6b7280);
}
.v {
  font-size: 14px;
  font-weight: 600;
  color: var(--c-text, #1f2329);
  overflow-wrap: anywhere;
  word-break: break-word;
}
.desc {
  font-size: 13px;
  line-height: 1.6;
  color: var(--c-text-2, #4b5563);
  margin: 4px 0 12px;
}
.links {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.links a {
  display: block;
  padding: 8px 10px;
  border: 1px solid var(--c-border, #e5e7eb);
  border-radius: 8px;
  text-decoration: none;
  color: var(--c-primary, #2563eb);
  font-size: 13px;
  transition: background 0.15s;
}
.links a:hover {
  background: var(--c-primary-50, #eff6ff);
}
.privacy {
  margin: 12px 0 0;
  line-height: 1.5;
}
.small {
  font-size: 12px;
}
.muted {
  color: var(--c-muted, #6b7280);
}
@media (max-width: 560px) {
  .grid,
  .links {
    grid-template-columns: 1fr;
  }
}
</style>
