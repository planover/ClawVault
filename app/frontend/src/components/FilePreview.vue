<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { api } from '../api.js';
import Icon from './Icon.vue';

// 文件消息预览：根据类型在线预览常见图片 / 视频 / 音频 / PDF / 文本，
// 无法预览（如 Office、压缩包）时回退为下载；始终展示文件名、大小与类型标识。
// compact=true 用于列表卡片内的紧凑形态：只做图标 + 文件名 + 类型标识，不联网取大小。
const props = defineProps({
  message: { type: Object, required: true },
  compact: { type: Boolean, default: false },
});
const emit = defineEmits(['open-lightbox']);

const info = ref(null); // { filename, size, mime, ext }
const infoError = ref(false);
const textContent = ref('');
const textError = ref(false);
const imageFailed = ref(false);
const pdfFailed = ref(false);

const id = computed(() => props.message?.id);
const hasMedia = computed(() => !!props.message?.media);
const filename = computed(() => props.message?.filename || info.value?.filename || '');

// 预览判定：优先用后端返回的 MIME，缺省时按扩展名兜底
const ext = computed(() => {
  const f = filename.value;
  const i = f.lastIndexOf('.');
  return i > 0 ? f.slice(i + 1).toLowerCase() : info.value?.ext || '';
});
const mime = computed(() => info.value?.mime || '');

const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];
const VIDEO = ['mp4', 'webm', 'mov', 'mkv', 'm4v'];
const AUDIO = ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac'];
const TEXT = ['txt', 'md', 'json', 'xml', 'log', 'yml', 'yaml', 'js', 'ts', 'py', 'conf', 'ini', 'cfg', 'csv', 'sql', 'html', 'htm', 'css', 'sh', 'php', 'go', 'rs', 'java', 'kt', 'swift', 'dart', 'vue'];

function isIn(list, v) {
  return list.includes(v);
}
const isImage = computed(() => isIn(IMAGE, ext.value) || mime.value.startsWith('image/'));
const isVideo = computed(() => isIn(VIDEO, ext.value) || mime.value.startsWith('video/'));
const isAudio = computed(() => isIn(AUDIO, ext.value) || mime.value.startsWith('audio/'));
const isPdf = computed(() => ext.value === 'pdf' || mime.value === 'application/pdf');
const isText = computed(() => isIn(TEXT, ext.value) || mime.value.startsWith('text/'));

const isPreviewable = computed(() => isImage.value || isVideo.value || isAudio.value || isPdf.value || isText.value);

const src = computed(() => api.mediaUrl(id.value));
const downloadName = computed(() => filename.value || 'download');

// 类型标识（中文 + 扩展名）
const TYPE_LABEL = {
  doc: 'Word 文档', docx: 'Word 文档',
  xls: 'Excel 文档', xlsx: 'Excel 文档',
  ppt: 'PPT 文档', pptx: 'PPT 文档',
  zip: '压缩包', rar: '压缩包', '7z': '压缩包', tar: '压缩包', gz: '压缩包', tgz: '压缩包', bz2: '压缩包',
};
const typeLabel = computed(() => {
  if (isImage.value) return '图片';
  if (isVideo.value) return '视频';
  if (isAudio.value) return '音频';
  if (isPdf.value) return 'PDF 文档';
  if (isText.value) return '文本';
  const e = ext.value;
  if (TYPE_LABEL[e]) return TYPE_LABEL[e];
  return e ? `${e.toUpperCase()} 文件` : '未知类型';
});

function formatSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}
const sizeText = computed(() => (info.value ? formatSize(info.value.size) : ''));

async function loadInfo() {
  info.value = null;
  infoError.value = false;
  textContent.value = '';
  textError.value = false;
  if (!hasMedia.value) return;
  try {
    info.value = await api.mediaInfo(id.value);
  } catch {
    infoError.value = true;
  }
  // 文本预览：仅在大小可控时拉取正文，避免大文件阻塞
  if (isText.value && info.value && info.value.size <= 512 * 1024) {
    try {
      const res = await fetch(src.value);
      if (!res.ok) throw new Error('fetch failed');
      textContent.value = await res.text();
    } catch {
      textError.value = true;
    }
  }
}

function openLightbox() {
  emit('open-lightbox', { ids: [id.value], index: 0 });
}

onMounted(loadInfo);
watch(id, loadInfo);
</script>

<template>
  <div class="file-preview" :class="{ compact }">
    <!-- 无媒体文件（旧版本 / 接收时缺失） -->
    <div v-if="!hasMedia" class="media-missing">
      <Icon name="alert" :size="15" /> 该文件未保存（旧版本或接收时缺失）
    </div>

    <!-- 元信息加载中 -->
    <template v-else>
      <!-- 头部：文件名 + 类型 + 大小 + 下载 -->
      <div class="fp-head">
        <span class="fp-ico" :title="typeLabel"><Icon name="file" :size="18" /></span>
        <div class="fp-meta">
          <span class="fp-name truncate" :title="filename">{{ filename || '未命名文件' }}</span>
          <span class="fp-sub">
            <span class="fp-type">{{ typeLabel }}</span>
            <span v-if="sizeText" class="fp-size">{{ sizeText }}</span>
          </span>
        </div>
        <a class="fp-dl" :href="src" :download="downloadName" title="下载" aria-label="下载">
          <Icon name="download" :size="16" />
        </a>
      </div>

      <!-- 在线预览区：图片 / 视频 / 音频 / PDF / 文本 -->
      <div v-if="isPreviewable" class="fp-body">
        <img
          v-if="isImage && !imageFailed"
          class="fp-img"
          :src="src"
          alt="文件预览"
          @error="imageFailed = true"
          @click="openLightbox"
        />
        <div v-else-if="isImage && imageFailed" class="fp-fallback">
          <Icon name="alert" :size="14" /> 图片加载失败，<a :href="src" :download="downloadName">点击下载</a>
        </div>

        <video v-else-if="isVideo" class="fp-media" controls :src="src" preload="metadata"></video>

        <audio v-else-if="isAudio" class="fp-media" controls :src="src" preload="metadata"></audio>

        <iframe
          v-else-if="isPdf && !pdfFailed"
          class="fp-pdf"
          :src="src"
          title="PDF 预览"
          @error="pdfFailed = true"
        ></iframe>
        <div v-else-if="isPdf && pdfFailed" class="fp-fallback">
          <Icon name="alert" :size="14" /> 浏览器无法内嵌预览，<a :href="src" :download="downloadName">点击下载 PDF</a>
        </div>

        <pre v-else-if="isText" class="fp-text">{{ textContent || (textError ? '文本内容读取失败，请下载查看。' : '加载中…') }}</pre>
      </div>
    </template>
  </div>
</template>

<style scoped>
.file-preview {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.fp-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--c-border);
  border-radius: var(--r-md);
  background: var(--c-surface-2);
}
.fp-ico {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  border-radius: var(--r-sm);
  background: var(--c-primary-soft);
  color: var(--c-primary);
}
.fp-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.fp-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--c-text);
}
.fp-sub {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
}
.fp-type {
  padding: 1px 7px;
  border-radius: var(--r-full);
  background: var(--c-surface-3);
  color: var(--c-text-2);
  white-space: nowrap;
}
.fp-size {
  color: var(--c-faint);
  font-variant-numeric: tabular-nums;
}
.fp-dl {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border-radius: var(--r-sm);
  color: var(--c-text-2);
  transition: background var(--t-fast), color var(--t-fast);
}
.fp-dl:hover {
  background: var(--c-primary-soft);
  color: var(--c-primary);
}

.fp-body {
  border-radius: var(--r-md);
  overflow: hidden;
}
.fp-img {
  display: block;
  width: 100%;
  max-height: 360px;
  object-fit: contain;
  background: var(--c-surface-2);
  border: 1px solid var(--c-border);
  border-radius: var(--r-md);
  cursor: zoom-in;
  transition: filter var(--t-fast);
}
.fp-img:hover {
  filter: brightness(0.96);
}
.fp-media {
  width: 100%;
  max-height: 360px;
  border-radius: var(--r-md);
  border: 1px solid var(--c-border);
  background: #000;
}
.fp-pdf {
  width: 100%;
  height: 420px;
  border: 1px solid var(--c-border);
  border-radius: var(--r-md);
  background: var(--c-surface-2);
}
.fp-text {
  margin: 0;
  max-height: 340px;
  overflow: auto;
  padding: 12px 14px;
  border: 1px solid var(--c-border);
  border-radius: var(--r-md);
  background: var(--c-surface-2);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  color: var(--c-text-2);
  white-space: pre-wrap;
  word-break: break-word;
}
.fp-fallback {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-radius: var(--r-sm);
  background: var(--c-warn-bg);
  color: var(--c-warn);
  font-size: 12.5px;
}
.fp-fallback a {
  color: var(--c-warn);
  text-decoration: underline;
}

/* 紧凑形态（列表卡片内）：只显示头部一行 */
.file-preview.compact {
  gap: 0;
}
.file-preview.compact .fp-head {
  margin-bottom: 8px;
  background: transparent;
  border-color: var(--c-border);
  padding: 7px 11px;
}
.file-preview.compact .fp-ico {
  width: 28px;
  height: 28px;
}
.file-preview.compact .fp-ico :deep(svg) {
  width: 15px;
  height: 15px;
}
.file-preview.compact .fp-dl {
  width: 28px;
  height: 28px;
}
.media-missing {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 11px;
  border-radius: var(--r-sm);
  background: var(--c-warn-bg);
  color: var(--c-warn);
  font-size: 12px;
}
</style>
