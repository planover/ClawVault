<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { api } from '../api.js';
import { inFnosHost, revealInFileManager } from '../fnos.js';
import { toast } from '../toast.js';
import Icon from './Icon.vue';

// 文件消息预览：根据类型在线预览常见格式，无法预览时给出明确提示并提供「下载 / 外部打开」。
//   - 图片 / 视频 / 音频 / PDF / 文本：直接内嵌渲染（PDF 用 inline 处置的 iframe）
//   - Office（docx / xlsx）：后端转为 HTML 后内嵌渲染
//   - 压缩包（zip / tar / tgz）：列出内部文件清单
//   - 其他（rar / 7z / apk / 未知…）：展示「不支持预览」并给出下载 / 外部打开两个入口
// compact=true 用于列表卡片内：只显示头部一行，不联网取大小与内容。
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
const officeFailed = ref(false);
const archiveEntries = ref([]);
const archiveError = ref(false);
const archiveLoading = ref(false);
const inHost = ref(false); // 是否运行在飞牛宿主窗口（决定能否调原生文件管理器）

const id = computed(() => props.message?.id);
const hasMedia = computed(() => !!props.message?.media);
const filename = computed(() => props.message?.filename || info.value?.filename || '');

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
const ARCHIVE = ['zip', 'tar', 'tgz', 'gz'];

const isImage = computed(() => IMAGE.includes(ext.value) || mime.value.startsWith('image/'));
const isVideo = computed(() => VIDEO.includes(ext.value) || mime.value.startsWith('video/'));
const isAudio = computed(() => AUDIO.includes(ext.value) || mime.value.startsWith('audio/'));
const isPdf = computed(() => ext.value === 'pdf' || mime.value === 'application/pdf');
const isText = computed(() => TEXT.includes(ext.value) || mime.value.startsWith('text/'));
const isDocx = computed(() => ext.value === 'docx');
const isXlsx = computed(() => ext.value === 'xlsx');
const isArchive = computed(() => ARCHIVE.includes(ext.value));

// 预览形态归类
const previewKind = computed(() => {
  if (isImage.value) return 'image';
  if (isVideo.value) return 'video';
  if (isAudio.value) return 'audio';
  if (isPdf.value) return 'pdf';
  if (isText.value) return 'text';
  if (isDocx.value || isXlsx.value) return 'office';
  if (isArchive.value) return 'archive';
  return 'unsupported';
});

const previewSrc = computed(() => api.mediaUrl(id.value, { inline: true }));
const downloadUrl = computed(() => api.mediaUrl(id.value)); // attachment → 触发下载
const officeSrc = computed(() => api.mediaPreviewUrl(id.value));
const downloadName = computed(() => filename.value || 'download');

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
  if (isDocx.value) return 'Word 文档';
  if (isXlsx.value) return 'Excel 文档';
  if (isArchive.value) return '压缩包';
  const e = ext.value;
  if (TYPE_LABEL[e]) return TYPE_LABEL[e];
  return e ? `${e.toUpperCase()} 文件` : '未知类型';
});

function formatSize(bytes) {
  if (bytes === null || bytes === undefined) return '';
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
  // UI-L3：compact（列表卡片内）只用 message.filename 渲染一行芯片，
  // 不需要大小/MIME/正文/压缩包清单——跳过全部网络调用，
  // 列表里有 20 个文件卡片就少 20 次详情接口请求。
  if (props.compact) return;
  infoError.value = false;
  textContent.value = '';
  textError.value = false;
  archiveEntries.value = [];
  archiveError.value = false;
  if (!hasMedia.value) return;
  try {
    info.value = await api.mediaInfo(id.value);
  } catch (e) {
    console.warn('[FilePreview] 元信息获取失败：', e?.message || e);
    infoError.value = true;
  }
  // 文本预览：仅在大小可控时拉取正文，避免大文件阻塞
  if (isText.value && info.value && info.value.size <= 512 * 1024) {
    try {
      const res = await fetch(previewSrc.value);
      if (!res.ok) throw new Error('fetch failed');
      textContent.value = await res.text();
    } catch (e) {
      console.warn('[FilePreview] 文本读取失败：', e?.message || e);
      textError.value = true;
    }
  }
  // 压缩包：列出内部文件
  if (isArchive.value) {
    archiveLoading.value = true;
    try {
      const r = await api.mediaList(id.value);
      archiveEntries.value = (r.entries || []).slice(0, 300);
      archiveError.value = false;
    } catch (e) {
      console.warn('[FilePreview] 压缩包列表失败：', e?.message || e);
      archiveError.value = true;
    } finally {
      archiveLoading.value = false;
    }
  }
}

function openLightbox() {
  emit('open-lightbox', { ids: [id.value], index: 0 });
}
// 外部打开：在新标签页用浏览器原生能力打开（绕过应用内嵌预览的限制）
function externalOpen() {
  window.open(downloadUrl.value, '_blank', 'noopener');
}
// 借助飞牛：在原生文件管理器中定位该文件，用户即可用系统已装应用
// （PDF 阅读器、Office 等，由 fnOS 的文件关联决定）打开它。
// 这比猜各应用的 deep-link 协议可靠得多——协议未知也能用。
async function openInFileManager() {
  const p = info.value?.absPath;
  if (!p) {
    toast.error('尚未获取到文件路径，请稍候再试');
    return;
  }
  const ok = await revealInFileManager(p);
  if (!ok) toast.error('当前环境不支持打开文件管理器');
}

onMounted(async () => {
  inHost.value = await inFnosHost();
  loadInfo();
});
watch(id, loadInfo);
</script>

<template>
  <div class="file-preview" :class="{ compact }">
    <!-- 无媒体文件（旧版本 / 接收时缺失） -->
    <div v-if="!hasMedia" class="media-missing">
      <Icon name="alert" :size="15" /> 该文件未保存（旧版本或接收时缺失）
    </div>

    <template v-else>
      <!-- 头部：文件名 + 类型 + 大小 + 下载 / 外部打开 -->
      <div class="fp-head">
        <span class="fp-ico" :title="typeLabel"><Icon name="file" :size="18" /></span>
        <div class="fp-meta">
          <span class="fp-name truncate" :title="filename">{{ filename || '未命名文件' }}</span>
          <span class="fp-sub">
            <span class="fp-type">{{ typeLabel }}</span>
            <span v-if="sizeText" class="fp-size">{{ sizeText }}</span>
          </span>
        </div>
        <div class="fp-acts">
          <button
            v-if="inHost && !compact"
            class="fp-act"
            title="在飞牛文件管理器中打开（可用系统已装应用打开）"
            aria-label="在飞牛文件管理器中打开"
            @click="openInFileManager"
          >
            <Icon name="folder" :size="16" />
          </button>
          <button class="fp-act" title="外部打开" aria-label="外部打开" @click="externalOpen">
            <Icon name="external" :size="16" />
          </button>
          <a class="fp-act" :href="downloadUrl" :download="downloadName" title="下载" aria-label="下载">
            <Icon name="download" :size="16" />
          </a>
        </div>
      </div>

      <!-- 在线预览区（compact 列表卡片只显示头部一行，不渲染预览体） -->
      <div v-if="!compact && previewKind !== 'unsupported'" class="fp-body">
        <img
          v-if="previewKind === 'image' && !imageFailed"
          class="fp-img"
          :src="previewSrc"
          alt="文件预览"
          @error="imageFailed = true"
          @click="openLightbox"
        />
        <div v-else-if="previewKind === 'image' && imageFailed" class="fp-fallback">
          <Icon name="alert" :size="14" /> 图片加载失败，<a :href="downloadUrl" :download="downloadName">点击下载</a>
        </div>

        <video v-else-if="previewKind === 'video'" class="fp-media" controls :src="previewSrc" preload="metadata"></video>

        <audio v-else-if="previewKind === 'audio'" class="fp-media" controls :src="previewSrc" preload="metadata"></audio>

        <iframe
          v-else-if="previewKind === 'pdf' && !pdfFailed"
          class="fp-pdf"
          :src="previewSrc"
          title="PDF 预览"
          @error="pdfFailed = true"
        ></iframe>
        <div v-else-if="previewKind === 'pdf' && pdfFailed" class="fp-fallback">
          <Icon name="alert" :size="14" /> 浏览器无法内嵌预览，<a :href="downloadUrl" :download="downloadName">点击下载 PDF</a>
        </div>

        <iframe
          v-else-if="previewKind === 'office' && !officeFailed"
          class="fp-office"
          :src="officeSrc"
          title="文档预览"
          @error="officeFailed = true"
        ></iframe>
        <div v-else-if="previewKind === 'office' && officeFailed" class="fp-fallback">
          <Icon name="alert" :size="14" /> 文档预览生成失败，<a :href="downloadUrl" :download="downloadName">点击下载</a>
        </div>

        <pre v-else-if="previewKind === 'text'" class="fp-text">{{ textContent || (textError ? '文本内容读取失败，请下载查看。' : '加载中…') }}</pre>

        <!-- 压缩包：展示内部文件清单 -->
        <div v-else-if="previewKind === 'archive'" class="fp-archive">
          <div v-if="archiveLoading" class="fp-arch-loading"><span class="spinner"></span> 读取压缩包…</div>
          <div v-else-if="archiveError" class="fp-fallback">
            <Icon name="alert" :size="14" /> 无法读取压缩包内容，<a :href="downloadUrl" :download="downloadName">点击下载</a>
          </div>
          <ul v-else class="fp-arch-list">
            <li v-for="(e, i) in archiveEntries" :key="i" class="fp-arch-item" :class="{ dir: e.dir }">
              <Icon :name="e.dir ? 'folder' : 'file'" :size="14" />
              <span class="fp-arch-name truncate">{{ e.name }}</span>
              <span v-if="!e.dir && e.size" class="fp-arch-size">{{ formatSize(e.size) }}</span>
            </li>
            <li v-if="archiveEntries.length === 300" class="fp-arch-more">仅显示前 300 项…</li>
          </ul>
        </div>
      </div>

      <!-- 不支持预览：明确提示 + 下载 / 外部打开（compact 同样不渲染） -->
      <div v-else-if="!compact" class="fp-unsupported">
        <Icon name="file" :size="20" />
        <div class="fp-unsupported-text">
          <span>当前暂不支持在应用内直接预览该格式（.{{ ext || '未知' }}）。</span>
          <span class="muted small">可下载到本地，或用外部应用打开。</span>
        </div>
        <div class="fp-unsupported-actions">
          <button class="btn ghost sm" @click="externalOpen">
            <Icon name="external" :size="14" /> 外部打开
          </button>
          <a class="btn sm" :href="downloadUrl" :download="downloadName">
            <Icon name="download" :size="14" /> 下载
          </a>
        </div>
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
.fp-acts {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.fp-act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--r-sm);
  color: var(--c-text-2);
  transition: background var(--t-fast), color var(--t-fast);
}
.fp-act:hover {
  background: var(--c-primary-soft);
  color: var(--c-primary);
}

/* 响应式：小屏压缩预览高度、纵向堆叠，避免溢出与重叠 */
@media (max-width: 560px) {
  .fp-pdf,
  .fp-office {
    height: 58vh;
  }
  .fp-img,
  .fp-media {
    max-height: 46vh;
  }
  .fp-archive {
    max-height: 46vh;
  }
  .fp-head {
    flex-wrap: wrap;
  }
  .fp-acts {
    margin-left: auto;
  }
  .fp-unsupported {
    flex-direction: column;
    align-items: stretch;
  }
  .fp-unsupported-actions {
    justify-content: stretch;
  }
  .fp-unsupported-actions > * {
    flex: 1;
    justify-content: center;
  }
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
.fp-pdf,
.fp-office {
  width: 100%;
  height: 460px;
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

/* 压缩包清单 */
.fp-archive {
  border: 1px solid var(--c-border);
  border-radius: var(--r-md);
  background: var(--c-surface-2);
  padding: 6px;
  max-height: 320px;
  overflow: auto;
}
.fp-arch-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  font-size: 12.5px;
  color: var(--c-muted);
}
.fp-arch-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.fp-arch-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--r-xs);
  font-size: 12.5px;
  color: var(--c-text);
}
.fp-arch-item:hover {
  background: var(--c-hover);
}
.fp-arch-item.dir {
  color: var(--c-text-2);
}
.fp-arch-name {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 12px;
}
.fp-arch-size {
  color: var(--c-faint);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.fp-arch-more {
  list-style: none;
  padding: 6px 8px;
  font-size: 11.5px;
  color: var(--c-faint);
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

/* 不支持预览 */
.fp-unsupported {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px;
  border: 1px dashed var(--c-border-strong);
  border-radius: var(--r-md);
  background: var(--c-surface-2);
  color: var(--c-text-2);
}
.fp-unsupported-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12.5px;
  line-height: 1.5;
}
.fp-unsupported-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
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
.file-preview.compact .fp-act {
  width: 28px;
  height: 28px;
}
</style>
