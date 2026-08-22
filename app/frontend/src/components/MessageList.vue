<script setup>
import { reactive } from 'vue';
import { api } from '../api.js';
const props = defineProps({
  messages: Array,
  selectedId: { type: [Number, null], default: null },
  emptyText: { type: String, default: '该分类下暂无消息' },
});
const emit = defineEmits(['select']);

// 图片/表情加载失败兜底
const imgFailed = reactive({});
// 语音「听原文」展开状态
const voiceOpen = reactive({});

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
function toggleVoice(id) {
  voiceOpen[id] = !voiceOpen[id];
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
      <!-- 图片 / 表情：统一走媒体渲染，加载失败显示占位 -->
      <div v-if="(m.kind === 'image' || m.kind === 'sticker') && m.media" class="thumb">
        <img v-if="!imgFailed[m.id]" :src="api.thumbUrl(m.id, 320)" loading="lazy" decoding="async" alt="图片" @error="imgFailed[m.id] = true" />
        <div v-else class="muted small">🖼️ 媒体加载失败</div>
      </div>
      <div v-else-if="(m.kind === 'image' || m.kind === 'sticker') && !m.media" class="muted small">
        🖼️ {{ m.kind === 'sticker' ? '表情' : '图片' }}未保存（旧版本或接收时缺失）
      </div>
      <div v-else-if="(m.kind === 'video' || m.kind === 'file') && m.media" class="thumb file">
        <a :href="api.mediaUrl(m.id)" target="_blank" :download="m.filename || ''" @click.stop>
          📎 {{ m.filename || '查看/下载附件' }}
        </a>
      </div>
      <!-- 语音：文字 + 可折叠「听原文」语音条 -->
      <template v-else-if="m.kind === 'voice'">
        <div v-if="m.voice" class="voice-row">
          <button class="voice-toggle" :aria-expanded="!!voiceOpen[m.id]" @click.stop="toggleVoice(m.id)">
            {{ voiceOpen[m.id] ? '🔊 收起语音' : '🎧 听原文' }}
          </button>
          <audio v-show="voiceOpen[m.id]" controls :src="api.voiceUrl(m.id)" preload="none" class="voice-audio"></audio>
        </div>
        <div v-else class="muted small">🎧 语音（无音频）</div>
      </template>
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
  border-bottom: 1px solid var(--c-border);
  cursor: pointer;
  transition: background 0.15s;
}
.item:hover {
  background: var(--c-card);
}
.item:focus-visible {
  outline: 2px solid var(--c-primary);
  outline-offset: -2px;
  background: var(--c-card);
}
.item.active {
  background: var(--c-active);
}
.meta {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 4px;
  flex-wrap: wrap;
}
.text {
  font-size: 13px;
  color: var(--c-text-2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.thumb {
  margin-bottom: 6px;
}
.thumb img {
  max-width: 100%;
  max-height: 160px;
  border-radius: 8px;
  border: 1px solid var(--c-border);
}
.voice-row {
  margin-bottom: 6px;
}
.voice-toggle {
  border: 1px solid var(--c-border-strong, #d0d5dd);
  background: var(--c-primary-50, #eff6ff);
  color: var(--c-primary, #2563eb);
  border-radius: 999px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
}
.voice-audio {
  display: block;
  width: 100%;
  margin-top: 6px;
}
.small {
  font-size: 11px;
}
.muted {
  color: var(--c-muted);
}
.empty {
  padding: 24px;
  font-size: 13px;
}
</style>
