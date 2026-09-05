<script setup>
// 详情面板（UI-M7 从 App.vue 拆出）：选中消息的完整内容、媒体、网址快照与重新分类。
// 事件协议：
//   close                 关闭（移动端覆盖层）
//   delete                请求删除该消息（实际的「乐观删除 + 撤销」流程在 App）
//   reclassified          重新分类成功（App 刷新列表与分类树）
//   open-lightbox         打开单张图片灯箱（消息媒体 id）
//   open-lightbox-srcs    打开任意 URL 灯箱（网址快照截图，UI-L1）
import { ref, computed, watch, nextTick } from 'vue';
import { api } from '../api.js';
import { toast } from '../toast.js';
import { renderEmojiText } from '../wechatEmoji.js';
import Icon from './Icon.vue';
import FilePreview from './FilePreview.vue';

const props = defineProps({
  message: { type: Object, default: null },
  show: { type: Boolean, default: false },
  folders: { type: Array, default: () => [] },
});
const emit = defineEmits(['close', 'delete', 'reclassified', 'open-lightbox', 'open-lightbox-srcs']);

const root = ref(null);
const linkSnapshots = ref([]); // 选中消息关联的「收藏网址」快照
const refetchingId = ref(null); // 正在重新抓取的快照 id（同一时刻只允许一个，避免并发压测外部站点）
const detailImgFailed = ref(false);
const newCat = ref('');
const newCatNew = ref(''); // 「＋ 新建分类…」时输入的新名字
const newSub = ref('');

// 实际提交到后端的主分类：选了已有就直接用；选了「新建」则用输入框内容
const finalCat = computed(() =>
  newCat.value === '__new__' ? newCatNew.value.trim() : newCat.value.trim(),
);
// 「＋ 新建分类…」时主分类必填；否则有选项即可
const canSaveReclass = computed(() =>
  newCat.value === '__new__' ? !!newCatNew.value.trim() : !!newCat.value,
);
// 当前主分类下已有的子分类，给子分类输入框做候选（datalist 仍可手输新子分类）
const subOptions = computed(() => {
  const c = newCat.value;
  if (!c || c === '__new__') return [];
  for (const ch of props.folders) {
    for (const cc of ch.categories || []) {
      if (cc.name === c) return (cc.subs || []).map((s) => s.name).sort();
    }
  }
  return [];
});
// 已有分类：给「重新分类」输入框做候选提示，避免手打出错
const categoryOptions = computed(() => {
  const set = new Set();
  for (const ch of props.folders) for (const c of ch.categories || []) set.add(c.name);
  return [...set].sort();
});

// 拉取某条消息关联的网址快照（纯文本/语音之外的消息不会有关联快照，静默返回空）
async function loadLinkSnapshots(messageId) {
  if (!messageId) {
    linkSnapshots.value = [];
    return;
  }
  try {
    const r = await api.messageLinks(messageId);
    linkSnapshots.value = r.items || [];
  } catch {
    linkSnapshots.value = [];
  }
}

// 选中消息变化：同步表单、重置图片错误态、重新拉快照，
// UI-M4：并把面板滚动回顶（此前切换消息时保持旧滚动位置，长文体验差）。
watch(
  () => props.message,
  async (m) => {
    newCat.value = m?.category || '';
    newCatNew.value = '';
    newSub.value = m?.sub || '';
    detailImgFailed.value = false;
    loadLinkSnapshots(m?.id);
    await nextTick();
    root.value?.scrollTo({ top: 0 });
  },
);

// 手动「重新抓取」：真机联网前抓取会失败，联网（或配好代理）后点这个按钮即可补抓。
// 后端用同一 id 更新行并广播，这里本地也直接替换该快照，保证即时反馈。
async function refetchLink(id) {
  if (refetchingId.value) return;
  refetchingId.value = id;
  try {
    const updated = await api.refetchLink(id);
    const idx = linkSnapshots.value.findIndex((s) => s.id === id);
    if (idx >= 0) {
      const arr = linkSnapshots.value.slice();
      arr[idx] = updated;
      linkSnapshots.value = arr;
    }
    if (updated.status === 'fetch_failed') {
      toast.warning('重新抓取仍失败：' + (updated.error || '未知错误'));
    } else {
      toast.success('已重新抓取');
    }
  } catch (e) {
    toast.error('重新抓取失败：' + (e.message || e));
  } finally {
    refetchingId.value = null;
  }
}

// WS 推送的快照更新（App 转发）：同 id 就地更新，新 id 追加。
// 仅当正看着对应消息时处理，避免无关的快照刷新面板。
function onLinkSnapshot(record) {
  if (!props.message || record?.messageId !== props.message.id || !record?.snapshot) return;
  const snap = record.snapshot;
  const idx = linkSnapshots.value.findIndex((s) => s.id === snap.id);
  if (idx >= 0) {
    const arr = linkSnapshots.value.slice();
    arr[idx] = snap;
    linkSnapshots.value = arr;
  } else {
    linkSnapshots.value = [...linkSnapshots.value, snap];
  }
}
// 消息被删除（WS）时清空快照
function onDeleted(id) {
  if (props.message?.id === id) linkSnapshots.value = [];
}
defineExpose({ onLinkSnapshot, onDeleted });

async function doReclassify() {
  if (!props.message || !canSaveReclass.value) return;
  try {
    const updated = await api.reclassify(props.message.id, finalCat.value, newSub.value.trim());
    // 选过「新建」后，把新分类正式设为已选，下次重新分类直接选到它
    if (newCat.value === '__new__') newCat.value = newCatNew.value.trim();
    newCatNew.value = '';
    toast.success('已重新分类');
    emit('reclassified', updated);
  } catch (e) {
    toast.error('重新分类失败：' + (e.message || e));
  }
}
</script>

<template>
  <section ref="root" class="detail" :class="{ open: show }">
    <button class="icon-btn sm detail-close" aria-label="关闭详情" @click="emit('close')">
      <Icon name="close" :size="16" />
    </button>

    <div v-if="message" class="detail-inner">
      <div class="detail-head">
        <span class="tag">{{ message.category }}<template v-if="message.sub"> / {{ message.sub }}</template></span>
        <h3 class="detail-meta truncate">{{ message.channelName }}</h3>
        <span class="detail-time">{{ new Date(message.ts).toLocaleString('zh-CN') }}</span>
      </div>

      <p
        v-if="message.text"
        class="detail-text"
        :class="{ 'detail-text-emoji': message.kind === 'emoji' }"
        v-html="renderEmojiText(message.text)"
      ></p>

      <div v-if="(message.kind === 'image' || message.kind === 'sticker') && message.media" class="block">
        <div class="section-label">图片</div>
        <img
          v-if="!detailImgFailed"
          class="detail-img clickable"
          :src="api.thumbUrl(message.id, 800)"
          alt="图片"
          @error="detailImgFailed = true"
          @click="emit('open-lightbox', message.id)"
        />
        <div v-else class="media-missing"><Icon name="alert" :size="15" /> 媒体加载失败</div>
      </div>

      <div v-else-if="message.kind === 'video' && message.media" class="block">
        <div class="section-label">视频</div>
        <video class="detail-img" controls :src="api.mediaUrl(message.id)"></video>
      </div>

      <div v-else-if="message.kind === 'file' && message.media" class="block">
        <div class="section-label">文件</div>
        <FilePreview :message="message" @open-lightbox="(p) => emit('open-lightbox', p)" />
      </div>

      <div v-else-if="['image', 'video', 'file', 'sticker'].includes(message.kind) && !message.media" class="block">
        <div class="media-missing"><Icon name="alert" :size="15" /> 该媒体未保存（旧版本或接收时缺失）</div>
      </div>

      <div v-if="message.voice" class="block">
        <div class="section-label">语音</div>
        <audio class="detail-audio" controls :src="api.voiceUrl(message.id)"></audio>
      </div>

      <div v-if="message.peer" class="block">
        <div class="section-label">会话对象</div>
        <div class="detail-peer">{{ message.peer }}</div>
      </div>

      <div v-if="linkSnapshots.length" class="block link-snap">
        <div class="section-label">网址快照</div>
        <div v-for="s in linkSnapshots" :key="s.id" class="snap-card">
          <div class="snap-head">
            <a class="snap-title" :href="api.linkHtmlUrl(s.id)" target="_blank" rel="noopener">{{ s.title || s.url }}</a>
            <span class="snap-domain">{{ s.domain || s.url }}</span>
          </div>
          <div v-if="s.status === 'fetch_failed'" class="snap-fail">
            <Icon name="alert" :size="15" />
            <div class="snap-fail-body">
              <strong>抓取失败</strong>
              <span class="snap-fail-msg">{{ s.error || '未能获取该网页，真机可能尚未联网或被代理/防火墙拦截。联网后再点「重新抓取」。' }}</span>
            </div>
          </div>
          <img v-if="s.cover_path" class="snap-cover" :src="api.linkCoverUrl(s.id)" alt="封面" loading="lazy" decoding="async" />
          <p v-if="s.description" class="snap-desc">{{ s.description }}</p>
          <!-- UI-L1：内联截图可点击，走灯箱放大（此前 cursor:zoom-in 但点了没反应） -->
          <img
            v-if="s.screenshot_path"
            class="snap-shot"
            :src="api.linkScreenshotUrl(s.id)"
            alt="网页截图"
            loading="lazy"
            decoding="async"
            @click="emit('open-lightbox-srcs', { srcs: [api.linkScreenshotUrl(s.id)], index: 0 })"
          />
          <!-- UI-F1：「截图不可用（未安装浏览器）」逐卡重复出现像报错，已移除 -->
          <div class="snap-actions">
            <a class="btn ghost sm" :href="api.linkHtmlUrl(s.id)" target="_blank" rel="noopener"><Icon name="external" :size="13" /> 查看归档</a>
            <a class="btn ghost sm" :href="s.url" target="_blank" rel="noopener"><Icon name="arrowRight" :size="13" /> 打开原网址</a>
            <!-- UI-L4：「重新抓取」只在抓取失败的卡片上显示，成功行不再常驻 -->
            <button v-if="s.status === 'fetch_failed'" class="btn ghost sm" :disabled="refetchingId === s.id" @click="refetchLink(s.id)">
              <Icon name="refresh" :size="13" />
              <span v-if="refetchingId === s.id" class="spinner-sm"></span>
              {{ refetchingId === s.id ? '抓取中…' : '重新抓取' }}
            </button>
          </div>
        </div>
      </div>

      <div class="block reclass">
        <div class="section-label">重新分类</div>
        <div class="reclass-fields">
          <select class="input" v-model="newCat" aria-label="主分类">
            <option value="">— 选择已有分类 —</option>
            <option v-for="c in categoryOptions" :key="c" :value="c">{{ c }}</option>
            <option value="__new__">＋ 新建分类…</option>
          </select>
          <input
            v-if="newCat === '__new__'"
            class="input"
            v-model="newCatNew"
            placeholder="新分类名称"
            aria-label="新分类名称"
          />
          <input
            class="input"
            v-model="newSub"
            list="cv-subs"
            placeholder="子分类（可选）"
            aria-label="子分类"
          />
          <datalist id="cv-subs">
            <option v-for="s in subOptions" :key="s" :value="s"></option>
          </datalist>
          <button class="btn sm" :disabled="!canSaveReclass" @click="doReclassify">保存</button>
        </div>
      </div>

      <div class="detail-actions">
        <button class="btn ghost sm" @click="emit('delete', message.id)">
          <Icon name="trash" :size="14" /> 删除这条归档
        </button>
      </div>
    </div>

    <div v-else class="detail-empty">
      <Icon name="empty" :size="34" />
      <p class="detail-empty-title">未选择消息</p>
      <p class="muted small">从左侧分类或右侧列表中选一条，这里会显示完整内容、媒体与重新分类入口。</p>
    </div>
  </section>
</template>

<style scoped>
.detail {
  width: var(--detail-w);
  flex-shrink: 0;
  border-left: 1px solid var(--c-border);
  background: var(--c-surface);
  overflow-y: auto;
  position: relative;
  padding: 18px;
}
.detail-inner {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.detail-close {
  display: none;
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 2;
}
.detail-head {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-right: 8px;
}
.detail-meta {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.detail-time,
.detail-peer {
  font-size: 12px;
  color: var(--c-muted);
}
.detail-text {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--c-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.detail-text-emoji {
  font-size: 40px;
  line-height: 1.4;
  letter-spacing: 4px;
}
.block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.detail-img {
  width: 100%;
  max-height: 340px;
  object-fit: contain;
  border-radius: var(--r-md);
  border: 1px solid var(--c-border);
  background: var(--c-surface-2);
}
.detail-img.clickable {
  cursor: zoom-in;
  transition: filter var(--t-fast);
}
.detail-img.clickable:hover {
  filter: brightness(0.96);
}
.detail-audio {
  width: 100%;
}
.media-missing {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 10px 12px;
  border-radius: var(--r-md);
  background: var(--c-warn-bg);
  color: var(--c-warn);
  font-size: 12.5px;
}
/* 网址快照卡片 */
.link-snap {
  gap: 10px;
}
.snap-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--c-border);
  border-radius: var(--r-md);
  background: var(--c-surface-2);
}
.snap-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.snap-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--c-text);
  text-decoration: none;
  overflow-wrap: anywhere;
}
.snap-title:hover {
  color: var(--c-primary);
  text-decoration: underline;
}
.snap-domain {
  font-size: 11.5px;
  color: var(--c-faint);
  overflow-wrap: anywhere;
  word-break: break-all;
}
.snap-cover {
  display: block;
  width: 100%;
  max-height: 200px;
  object-fit: contain;
  border-radius: var(--r-sm);
  border: 1px solid var(--c-border);
  background: var(--c-surface);
}
.snap-shot {
  display: block;
  width: 100%;
  border-radius: var(--r-sm);
  border: 1px solid var(--c-border);
  background: var(--c-surface);
  cursor: zoom-in;
  transition: filter var(--t-fast);
}
.snap-shot:hover {
  filter: brightness(0.96);
}
.snap-desc {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--c-text-2);
  display: -webkit-box;
  -webkit-line-clamp: 4;
  line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
/* 抓取失败：红色高亮横幅，明确告知原因与下一步动作 */
.snap-fail {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 11px;
  border-radius: var(--r-sm);
  background: var(--c-danger-bg, var(--c-warn-bg));
  color: var(--c-danger, var(--c-warn));
  border: 1px solid var(--c-danger-border, color-mix(in srgb, var(--c-danger, var(--c-warn)) 35%, transparent));
  font-size: 12px;
  line-height: 1.5;
}
.snap-fail :deep(svg),
.snap-fail > svg {
  flex-shrink: 0;
  margin-top: 1px;
}
.snap-fail-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.snap-fail-body strong {
  font-weight: 600;
}
.snap-fail-msg {
  color: var(--c-text-2);
  overflow-wrap: anywhere;
}
/* 重新抓取进行中的小转圈 */
.spinner-sm {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: cv-spin 0.7s linear infinite;
}
@keyframes cv-spin {
  to {
    transform: rotate(360deg);
  }
}
.snap-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.snap-actions .btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.reclass {
  padding-top: 16px;
  border-top: 1px solid var(--c-border);
}
.reclass-fields {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.reclass-fields .btn {
  align-self: flex-start;
}
.detail-actions {
  padding-top: 4px;
}

.detail-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 6px;
  padding: 28px;
  color: var(--c-faint);
}
.detail-empty-title {
  margin: 4px 0 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--c-text-2);
}
.detail-empty .muted {
  max-width: 240px;
  line-height: 1.6;
}

/* ---------- 响应式（仅详情面板相关；其余断点规则留在 App.vue） ---------- */
/* 宽屏：详情面板给足空间，避免长文本被压窄 */
@media (min-width: 1600px) {
  .detail {
    width: 420px;
  }
}
@media (max-width: 1240px) {
  .detail {
    width: 330px;
  }
}
@media (max-width: 1024px) {
  .detail {
    width: 300px;
  }
}
/* 平板竖屏 / 小窗口：详情改为抽屉覆盖层 */
@media (max-width: 860px) {
  .detail {
    position: fixed;
    inset: var(--topbar-h) 0 0 0;
    width: auto;
    z-index: 70;
    transform: translateX(100%);
    transition: transform var(--t);
    box-shadow: var(--shadow-lg);
  }
  .detail.open {
    transform: translateX(0);
  }
  .detail-close {
    display: inline-flex;
  }
  .detail:not(.open) {
    pointer-events: none;
  }
}
@media (max-width: 560px) {
  .detail {
    padding: 14px;
  }
}
</style>
