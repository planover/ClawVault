<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { api } from '../api.js';
import Icon from './Icon.vue';

const props = defineProps({
  show: { type: Boolean, default: false },
  ids: { type: Array, default: () => [] }, // 当前视图里的图片消息 id 列表（用于左右切换）
  // UI-L1：可选的直接 URL 列表（如网址快照截图 /api/links/:id/screenshot，
  // 它们不是消息媒体、没有 message id）。提供时优先于 ids。
  srcs: { type: Array, default: () => [] },
  index: { type: Number, default: 0 },
});
const emit = defineEmits(['close']);

const zoom = ref(1);
const panX = ref(0);
const panY = ref(0);
const loading = ref(false);
const loadFailed = ref(false);
const imgEl = ref(null);

const count = computed(() => (props.srcs.length ? props.srcs.length : props.ids.length));
const safeIndex = computed(() => {
  if (!count.value) return 0;
  return Math.min(Math.max(props.index, 0), count.value - 1);
});
const currentId = computed(() => props.ids[safeIndex.value]);
// 灯箱里直接展示原图（媒体接口），下载也走原图
const currentSrc = computed(() => {
  if (props.srcs.length) return props.srcs[safeIndex.value] || '';
  return currentId.value != null ? api.mediaUrl(currentId.value) : '';
});
const currentDownload = computed(() => currentSrc.value);

// 切换图片时重置缩放/平移并重新加载
watch(
  () => [props.show, safeIndex.value],
  async ([s]) => {
    if (s) {
      zoom.value = 1;
      panX.value = 0;
      panY.value = 0;
      loadFailed.value = false;
      loading.value = true;
      await nextTick();
      // 焦点交给关闭按钮，Esc 可用
      window.requestAnimationFrame(() => closeBtn.value?.focus());
    }
  },
  { immediate: true },
);

function onImgLoad() {
  loading.value = false;
}
function onImgError() {
  loading.value = false;
  loadFailed.value = true;
}

// ---------- 缩放 ----------
function setZoom(z) {
  zoom.value = Math.min(Math.max(z, 0.2), 6);
  if (zoom.value === 1) {
    panX.value = 0;
    panY.value = 0;
  }
}
function zoomIn() {
  setZoom(Math.round((zoom.value + 0.25) * 100) / 100);
}
function zoomOut() {
  setZoom(Math.round((zoom.value - 0.25) * 100) / 100);
}
function resetView() {
  zoom.value = 1;
  panX.value = 0;
  panY.value = 0;
}

// ---------- 拖拽平移（仅放大时可拖） ----------
let dragging = false;
let startX = 0;
let startY = 0;
let startPanX = 0;
let startPanY = 0;
function onPointerDown(e) {
  if (zoom.value <= 1) return;
  dragging = true;
  startX = e.clientX;
  startY = e.clientY;
  startPanX = panX.value;
  startPanY = panY.value;
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
}
function onPointerMove(e) {
  if (!dragging) return;
  panX.value = startPanX + (e.clientX - startX);
  panY.value = startPanY + (e.clientY - startY);
}
function onPointerUp() {
  dragging = false;
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
}

// 滚轮缩放（以画面中心为锚点即可，保持简单）
function onWheel(e) {
  e.preventDefault();
  if (e.deltaY < 0) zoomIn();
  else zoomOut();
}

// 双击在 100% 与 适配之间切换
function onDoubleClick() {
  if (zoom.value > 1) resetView();
  else setZoom(2);
}

// ---------- 切换 ----------
function goTo(i) {
  // 切换图片：通知父级更新 index（单一数据源），本地只负责重置视图
  panX.value = 0;
  panY.value = 0;
  setZoom(1);
  loadFailed.value = false;
  loading.value = true;
  emit('update:index', i);
}
function prev() {
  if (count.value <= 1) return;
  goTo((safeIndex.value - 1 + count.value) % count.value);
}
function next() {
  if (count.value <= 1) return;
  goTo((safeIndex.value + 1) % count.value);
}

const closeBtn = ref(null);
function close() {
  emit('close');
}
// UI-L5：下载文件名不再写死 .jpg——消息媒体优先用后端记录的原始文件名；
// 直接 URL 源（如快照截图）从 URL 路径推断扩展名。
async function resolveDownloadName() {
  if (!props.srcs.length && currentId.value != null) {
    try {
      const info = await api.mediaInfo(currentId.value);
      if (info?.filename) return info.filename;
    } catch {
      /* 拿不到元信息就用兜底名 */
    }
    return `clawvault-${currentId.value}`;
  }
  try {
    const p = new URL(currentDownload.value, location.href).pathname;
    const base = p.split('/').filter(Boolean).pop() || 'image';
    return `clawvault-${base}.png`;
  } catch {
    return 'clawvault-image.png';
  }
}

async function download() {
  if (!currentDownload.value) return;
  const a = document.createElement('a');
  a.href = currentDownload.value;
  a.download = await resolveDownloadName();
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------- 键盘 ----------
function onKey(e) {
  if (!props.show) return;
  switch (e.key) {
    case 'Escape':
      close();
      break;
    case '+':
    case '=':
      zoomIn();
      break;
    case '-':
    case '_':
      zoomOut();
      break;
    case '0':
      resetView();
      break;
    case 'ArrowLeft':
      prev();
      break;
    case 'ArrowRight':
      next();
      break;
  }
}

onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => {
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
});

// 触屏滑动切换（简单阈值）
let touchX = 0;
function onTouchStart(e) {
  touchX = e.touches[0].clientX;
}
function onTouchEnd(e) {
  const dx = e.changedTouches[0].clientX - touchX;
  if (Math.abs(dx) > 50) {
    if (dx < 0) next();
    else prev();
  }
}
</script>

<template>
  <transition name="lb-fade">
    <div v-if="show" class="lightbox" @click.self="close" @wheel.prevent="onWheel">
      <div class="lb-topbar">
        <span class="lb-counter" v-if="count > 1">{{ safeIndex + 1 }} / {{ count }}</span>
        <span class="spacer"></span>
        <button class="lb-btn" :title="`下载原图 (${zoom.toFixed(2)}x)`" @click="download" aria-label="下载原图">
          <Icon name="download" :size="17" />
        </button>
        <button ref="closeBtn" class="lb-btn" title="关闭 (Esc)" @click="close" aria-label="关闭">
          <Icon name="close" :size="17" />
        </button>
      </div>

      <button v-if="count > 1" class="lb-nav lb-prev" title="上一张 (←)" @click.stop="prev" aria-label="上一张">
        <Icon name="chevronRight" :size="22" style="transform: rotate(180deg)" />
      </button>
      <button v-if="count > 1" class="lb-nav lb-next" title="下一张 (→)" @click.stop="next" aria-label="下一张">
        <Icon name="chevronRight" :size="22" />
      </button>

      <div
        class="lb-stage"
        @pointerdown="onPointerDown"
        @dblclick="onDoubleClick"
        @touchstart="onTouchStart"
        @touchend="onTouchEnd"
      >
        <img
          v-if="currentSrc"
          ref="imgEl"
          class="lb-img"
          :class="{ grabbing: zoom > 1 }"
          :src="currentSrc"
          :style="{ transform: `translate(${panX}px, ${panY}px) scale(${zoom})`, cursor: zoom > 1 ? 'grab' : 'zoom-in' }"
          alt="预览"
          draggable="false"
          @load="onImgLoad"
          @error="onImgError"
        />
        <div v-if="loading && !loadFailed" class="lb-loading"><span class="spinner"></span></div>
        <div v-if="loadFailed" class="lb-missing"><Icon name="alert" :size="16" /> 图片加载失败</div>
      </div>

      <div class="lb-bottombar">
        <button class="lb-btn" title="缩小 (-)" @click="zoomOut" aria-label="缩小">
          <Icon name="minus" :size="16" />
        </button>
        <span class="lb-zoom" @click="resetView">{{ Math.round(zoom * 100) }}%</span>
        <button class="lb-btn" title="放大 (+)" @click="zoomIn" aria-label="放大">
          <Icon name="plus" :size="16" />
        </button>
        <button class="lb-btn" title="适应窗口" @click="resetView" aria-label="适应窗口">
          <Icon name="expand" :size="16" />
        </button>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.lightbox {
  /* UI-L2：颜色统一走变量。灯箱是图片查看器，无论深浅主题都保持深色遮罩
     （让图片本身成为唯一光源，业界惯例），因此变量固定为深色系，
     但集中在这一处定义，后续要随主题变化只改这里。 */
  --lb-fg: rgba(255, 255, 255, 0.9);
  --lb-fg-dim: rgba(255, 255, 255, 0.82);
  --lb-surface: rgba(20, 22, 28, 0.72);
  --lb-surface-2: rgba(20, 22, 28, 0.6);
  --lb-border: rgba(255, 255, 255, 0.12);
  --lb-hover: rgba(255, 255, 255, 0.14);
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(8, 10, 14, 0.86);
  backdrop-filter: blur(8px);
}
.lb-stage {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  touch-action: none;
}
.lb-img {
  max-width: 92vw;
  max-height: 86vh;
  object-fit: contain;
  user-select: none;
  border-radius: 6px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
  transition: transform 90ms ease-out;
  will-change: transform;
}
.lb-img.grabbing {
  cursor: grabbing;
}
.lb-topbar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
}
.lb-counter {
  font-size: 13px;
  color: var(--lb-fg-dim);
  font-variant-numeric: tabular-nums;
  background: rgba(0, 0, 0, 0.35);
  padding: 3px 10px;
  border-radius: 999px;
}
.lb-bottombar {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  border-radius: 999px;
  background: var(--lb-surface);
  backdrop-filter: blur(12px);
  border: 1px solid var(--lb-border);
}
.lb-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 999px;
  color: var(--lb-fg);
  transition: background var(--t-fast), color var(--t-fast);
}
.lb-btn:hover {
  background: var(--lb-hover);
  color: #fff;
}
.lb-zoom {
  min-width: 52px;
  text-align: center;
  font-size: 12.5px;
  color: var(--lb-fg-dim);
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  user-select: none;
}
.lb-nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 3;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  color: var(--lb-fg);
  background: var(--lb-surface-2);
  backdrop-filter: blur(8px);
  border: 1px solid var(--lb-border);
  transition: background var(--t-fast), transform var(--t-fast);
}
.lb-nav:hover {
  background: var(--lb-surface);
}
.lb-prev {
  left: 18px;
}
.lb-next {
  right: 18px;
}
.lb-loading,
.lb-missing {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--lb-fg-dim);
  font-size: 13px;
}
.lb-loading .spinner {
  width: 20px;
  height: 20px;
  border-width: 2.5px;
  border-top-color: #fff;
  border-color: var(--lb-border);
  border-top-color: #fff;
}
.lb-missing {
  padding: 12px 16px;
  border-radius: var(--r-md);
  background: rgba(40, 20, 20, 0.7);
  color: #ffb4ad;
}

.lb-fade-enter-active,
.lb-fade-leave-active {
  transition: opacity var(--t) ease;
}
.lb-fade-enter-from,
.lb-fade-leave-to {
  opacity: 0;
}
</style>
