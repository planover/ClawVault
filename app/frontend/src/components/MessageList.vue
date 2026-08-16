<script setup>
import { api } from '../api.js';
const props = defineProps({
  messages: Array,
  selectedId: { type: [Number, null], default: null },
  emptyText: { type: String, default: '该分类下暂无消息' },
});
const emit = defineEmits(['select']);

function fmt(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function onKey(e, id) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    emit('select', id);
  }
}
</script>

<template>
  <div class="list">
    <div v-if="!messages.length" class="muted empty">{{ emptyText }}</div>
    <div
      v-for="m in messages"
      :key="m.id"
      class="item"
      :class="{ active: m.id === selectedId }"
      role="button"
      tabindex="0"
      :aria-pressed="m.id === selectedId"
      :aria-label="`${m.category}${m.sub ? ' / ' + m.sub : ''} ${m.kind || '文本'}消息`"
      @click="emit('select', m.id)"
      @keydown="onKey($event, m.id)"
    >
      <div class="meta">
        <span class="tag">{{ m.category }}<template v-if="m.sub"> / {{ m.sub }}</template></span>
        <span class="muted">{{ fmt(m.ts) }}</span>
      </div>
      <div v-if="m.kind === 'image' && m.media" class="thumb">
        <img :src="api.mediaUrl(m.id)" loading="lazy" alt="图片" />
      </div>
      <div v-else-if="(m.kind === 'video' || m.kind === 'file') && m.media" class="thumb">
        <a :href="api.mediaUrl(m.id)" target="_blank" download @click.stop>📎 查看/下载附件</a>
      </div>
      <div v-else-if="m.kind === 'image' && !m.media" class="muted small">🖼️ 图片未保存（旧版本）</div>
      <div v-else-if="m.kind === 'voice' && !m.media" class="muted small">🎧 语音（无音频）</div>
      <div class="text">{{ m.text }}</div>
    </div>
  </div>
</template>

<style scoped>
.list {
  overflow: auto;
  height: 100%;
}
.item {
  padding: 10px 12px;
  border-bottom: 1px solid #eef0f3;
  cursor: pointer;
  transition: background 0.15s;
}
.item:hover {
  background: #fafbff;
}
.item:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: -2px;
  background: #fafbff;
}
.item.active {
  background: #eef2ff;
}
.meta {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 4px;
}
.text {
  font-size: 13px;
  color: #374151;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.thumb {
  margin-bottom: 6px;
}
.thumb img {
  max-width: 100%;
  max-height: 160px;
  border-radius: 8px;
  border: 1px solid #e5e7eb;
}
.small {
  font-size: 11px;
}
.muted {
  color: #6b7280;
}
.empty {
  padding: 24px;
  font-size: 13px;
}
</style>
