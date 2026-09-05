<script setup>
import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue';
import { api } from '../api.js';
import Icon from './Icon.vue';
import FilePreview from './FilePreview.vue';
import { renderEmojiHtml, isPureEmoji } from '../wechatEmoji.js';

const props = defineProps({
  messages: Array,
  selectedId: { type: [Number, null], default: null },
  emptyText: { type: String, default: '这里还没有归档内容' },
  query: { type: String, default: '' },
});
const emit = defineEmits(['select', 'delete', 'load-more', 'open-lightbox']);

// 当前视图里的图片类消息 id 列表（按展示顺序），供灯箱左右切换使用
const imageIds = computed(() =>
  props.messages.filter((m) => (m.kind === 'image' || m.kind === 'sticker') && m.media).map((m) => m.id),
);
function openLightbox(id) {
  const i = imageIds.value.indexOf(id);
  emit('open-lightbox', { ids: imageIds.value, index: i < 0 ? 0 : i });
}

// 图片加载失败兜底（按消息 id 记录）
const imgFailed = reactive({});
// 语音「听原文」展开状态
const voiceOpen = reactive({});
// 待二次确认删除的消息 id
const confirmId = ref(null);
// 无限滚动哨兵
const sentinel = ref(null);
let observer = null;

const KIND_ICON = {
  text: 'message',
  voice: 'mic',
  image: 'image',
  sticker: 'smile',
  emoji: 'smile',
  video: 'video',
  file: 'file',
};

function fmt(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 先转义再高亮：消息文本来自外部聊天，直接 v-html 会有 XSS 风险
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

// UI-L6：高亮正则按 query 缓存——此前每条消息渲染都 new 一次 RegExp，
// 列表 300 条就是 300 次编译。query 为空时直接返回转义文本（零正则开销）。
const hlRegex = computed(() => {
  const q = (props.query || '').trim();
  if (!q) return null;
  const needle = escapeHtml(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return new RegExp(needle, 'gi');
  } catch {
    return null;
  }
});

function highlighted(text) {
  const safe = escapeHtml(text);
  const re = hlRegex.value;
  if (!re) return safe;
  return safe.replace(re, (m) => `<mark>${m}</mark>`);
}

// 搜索高亮后再还原微信表情占位符（[裂开] → 😆）。输入已是转义文本，renderEmojiHtml 只做占位符替换，安全。
function renderText(text) {
  return renderEmojiHtml(highlighted(text));
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

function askDelete(id) {
  confirmId.value = id;
}
function cancelDelete() {
  confirmId.value = null;
}
function confirmDelete(id) {
  confirmId.value = null;
  emit('delete', id);
}

// 滚动到底部自动加载下一页；内容不足一屏时哨兵可见会连续触发，
// 由父级的 loadingMore / hasMore 守卫兜住，不会重复请求。
onMounted(() => {
  if (typeof IntersectionObserver === 'undefined' || !sentinel.value) return;
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) emit('load-more');
    },
    { rootMargin: '320px 0px' },
  );
  observer.observe(sentinel.value);
});
onUnmounted(() => {
  if (observer) observer.disconnect();
});
// 列表被整体替换（重新筛选）后需要重新观察同一个哨兵节点
watch(
  () => props.messages.length,
  () => {
    if (observer && sentinel.value) {
      observer.disconnect();
      observer.observe(sentinel.value);
    }
  },
);
</script>

<template>
  <div class="list">
    <div v-if="!messages.length" class="empty">
      <Icon name="empty" :size="30" />
      <p class="empty-title">{{ emptyText }}</p>
      <p class="muted small">消息进入后会自动归档并实时出现在这里。</p>
    </div>

    <article
      v-for="m in messages"
      :key="m.id"
      class="card"
      :class="{ active: m.id === selectedId, confirming: confirmId === m.id, 'emoji-card': m.kind === 'emoji' }"
      role="button"
      tabindex="0"
      :aria-pressed="m.id === selectedId"
      :aria-label="`${m.category}${m.sub ? ' / ' + m.sub : ''} ${m.kind || '文本'}消息`"
      @click="emit('select', m.id)"
      @keydown="onKey($event, m.id)"
    >
      <header class="card-head">
        <span class="tag">{{ m.category }}<template v-if="m.sub"> / {{ m.sub }}</template></span>
        <Icon v-if="KIND_ICON[m.kind]" class="kind-ico" :name="KIND_ICON[m.kind]" :size="14" />
        <span class="spacer"></span>
        <time class="time">{{ fmt(m.ts) }}</time>
        <button
          class="del-btn"
          :aria-label="`删除这条归档`"
          :title="'删除这条归档'"
          @click.stop="askDelete(m.id)"
        >
          <Icon name="trash" :size="14" />
        </button>
      </header>

      <!-- 图片 / 表情 -->
      <div v-if="(m.kind === 'image' || m.kind === 'sticker') && m.media" class="thumb">
        <img
          v-if="!imgFailed[m.id]"
          :src="api.thumbUrl(m.id, 800)"
          loading="lazy"
          decoding="async"
          alt="图片"
          class="thumb-img"
          @error="imgFailed[m.id] = true"
          @click.stop="openLightbox(m.id)"
        />
        <div v-else class="media-missing"><Icon name="alert" :size="14" /> 媒体加载失败</div>
      </div>
      <div v-else-if="(m.kind === 'image' || m.kind === 'sticker') && !m.media" class="media-missing">
        <Icon name="alert" :size="14" /> {{ m.kind === 'sticker' ? '表情' : '图片' }}未保存（旧版本或接收时缺失）
      </div>

      <!-- 视频：列表内保持轻量，点开详情再内嵌播放 -->
      <a
        v-else-if="m.kind === 'video' && m.media"
        class="file-chip"
        :href="api.mediaUrl(m.id)"
        target="_blank"
        rel="noopener"
        :download="m.filename || ''"
        @click.stop
      >
        <Icon name="video" :size="15" />
        <span class="truncate">{{ m.filename || '播放视频' }}</span>
      </a>

      <!-- 文件：在线预览（图片/视频/音频/PDF/文本）或下载回退 -->
      <FilePreview
        v-else-if="m.kind === 'file' && m.media"
        :message="m"
        compact
        @open-lightbox="openLightbox"
      />

      <!-- 语音：文字 + 可展开音频 -->
      <template v-else-if="m.kind === 'voice'">
        <div v-if="m.voice" class="voice-row">
          <button class="voice-toggle" :aria-expanded="!!voiceOpen[m.id]" @click.stop="toggleVoice(m.id)">
            <Icon name="mic" :size="13" />
            {{ voiceOpen[m.id] ? '收起语音' : '听原文' }}
          </button>
          <audio v-show="voiceOpen[m.id]" controls :src="api.voiceUrl(m.id)" preload="none" class="voice-audio"></audio>
        </div>
        <div v-else class="media-missing"><Icon name="mic" :size="14" /> 语音（无音频文件）</div>
      </template>

      <p v-if="m.text" class="text" :class="{ 'text-emoji': m.kind === 'emoji' }" v-html="renderText(m.text)"></p>

      <!-- 删除二次确认 -->
      <div v-if="confirmId === m.id" class="confirm" @click.stop>
        <span class="confirm-text">删除这条归档？</span>
        <button class="btn sm danger" @click="confirmDelete(m.id)">删除</button>
        <button class="btn sm ghost" @click="cancelDelete">取消</button>
      </div>
    </article>

    <div ref="sentinel" class="sentinel" aria-hidden="true"></div>
  </div>
</template>

<style scoped>
.list {
  display: grid;
  gap: 8px;
}

.card {
  padding: 12px 14px;
  border-radius: var(--r-lg);
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  cursor: pointer;
  transition: border-color var(--t-fast), box-shadow var(--t-fast), transform var(--t-fast);
}
.card:hover {
  border-color: var(--c-border-strong);
  box-shadow: var(--shadow-sm);
}
.card:focus-visible {
  outline: 2px solid var(--c-primary);
  outline-offset: 1px;
}
.card.active {
  border-color: var(--c-primary);
  box-shadow: 0 0 0 3px var(--c-primary-ring);
}
.card.confirming {
  border-color: var(--c-danger-border);
  background: var(--c-danger-bg);
}

.card-head {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 7px;
}
.kind-ico {
  color: var(--c-faint);
}
.time {
  font-size: 11.5px;
  color: var(--c-faint);
  font-variant-numeric: tabular-nums;
}
.del-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--r-xs);
  color: var(--c-faint);
  opacity: 0;
  transition: opacity var(--t-fast), color var(--t-fast), background var(--t-fast);
}
.card:hover .del-btn,
.card:focus-within .del-btn {
  opacity: 1;
}
.del-btn:hover {
  color: var(--c-danger);
  background: var(--c-danger-bg);
}

.text {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--c-text-2);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.thumb {
  margin-bottom: 8px;
  /* 用户反馈（v1.0.40 后）：180px 定高 + cover 裁切导致宽截图只能看到一条横条，
     必须点开灯箱才能看内容。改为完整显示：
     - 图片按原始比例完整呈现，不裁切（宽图撑满卡片宽度，长图按 480px 高度封顶居中）；
     - min-height 作为加载占位，尽量减轻图片到达时的布局跳动（CLS 无法完全消除，
       这里优先「看得见内容」）。 */
  min-height: 120px;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  border-radius: var(--r-md);
  overflow: hidden;
  background: var(--c-surface-2);
}
.thumb img {
  display: block;
  max-width: 100%;
  max-height: 480px;
  width: auto;
  height: auto;
  object-fit: contain;
  border: 1px solid var(--c-border);
  border-radius: var(--r-md);
  background: var(--c-surface-2);
  cursor: zoom-in;
  transition: filter var(--t-fast);
}
.thumb img:hover {
  filter: brightness(0.96);
}

.file-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: 100%;
  margin-bottom: 8px;
  padding: 7px 11px;
  border: 1px solid var(--c-border);
  border-radius: var(--r-full);
  background: var(--c-surface-2);
  font-size: 12.5px;
  color: var(--c-text-2);
  transition: border-color var(--t-fast), color var(--t-fast);
}
.file-chip:hover {
  border-color: var(--c-primary);
  color: var(--c-primary);
  text-decoration: none;
}

.voice-row {
  margin-bottom: 8px;
}
.voice-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 11px;
  border: 1px solid var(--c-border-strong);
  border-radius: var(--r-full);
  background: var(--c-surface-2);
  color: var(--c-text-2);
  font-size: 12px;
  transition: border-color var(--t-fast), color var(--t-fast);
}
.voice-toggle:hover {
  border-color: var(--c-primary);
  color: var(--c-primary);
}
.voice-audio {
  display: block;
  width: 100%;
  margin-top: 8px;
}

.media-missing {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  padding: 5px 10px;
  border-radius: var(--r-sm);
  background: var(--c-warn-bg);
  color: var(--c-warn);
  font-size: 11.5px;
}

.confirm {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--c-danger-border);
}
.confirm-text {
  flex: 1;
  font-size: 12.5px;
  color: var(--c-danger);
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 4px;
  padding: 56px 24px;
  color: var(--c-faint);
}
.empty-title {
  margin: 6px 0 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--c-text-2);
}

.sentinel {
  height: 1px;
}
</style>
