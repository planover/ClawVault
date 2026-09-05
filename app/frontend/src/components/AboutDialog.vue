<script setup>
import { ref, watch } from 'vue';
import { api } from '../api.js';
import { useDialogA11y } from '../dialogA11y.js';
import Icon from './Icon.vue';

const props = defineProps({ show: Boolean });
const emit = defineEmits(['close']);
const info = ref(null);

// UI-M1：Esc 关闭 + 打开时焦点入窗 + 关闭时焦点还原
const dialogRoot = ref(null);
useDialogA11y(() => props.show, () => emit('close'), dialogRoot);

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
  <div v-if="show" ref="dialogRoot" class="modal-mask" role="dialog" aria-modal="true" @click.self="emit('close')">
    <div class="modal about">
      <div class="hero">
        <span class="hero-mark"><Icon name="archive" :size="22" /></span>
        <div>
          <h3>{{ info?.name || '爪匣 ClawVault' }}</h3>
          <p class="modal-sub">多 Bot 对话自动分类归档到飞牛 NAS</p>
        </div>
        <span v-if="info?.version" class="tag">v{{ info.version }}</span>
      </div>

      <template v-if="info">
        <div class="grid">
          <div class="cell">
            <span class="k">开发者</span>
            <span class="v">{{ info.developer }}</span>
          </div>
          <div class="cell">
            <span class="k">开源协议</span>
            <span class="v">{{ info.license }}</span>
          </div>
          <div class="cell">
            <span class="k">已归档</span>
            <span class="v">{{ info.total ?? 0 }} 条</span>
          </div>
        </div>

        <p class="desc">{{ info.description }}</p>

        <ul class="links">
          <li>
            <a :href="info.repo" target="_blank" rel="noopener">
              <Icon name="external" :size="15" /> GitHub 仓库
            </a>
          </li>
          <li>
            <a :href="info.changelog" target="_blank" rel="noopener">
              <Icon name="clock" :size="15" /> 更新日志
            </a>
          </li>
          <li>
            <a :href="info.licenseUrl" target="_blank" rel="noopener">
              <Icon name="sheet" :size="15" /> 开源许可
            </a>
          </li>
          <li>
            <a :href="info.privacyUrl" target="_blank" rel="noopener">
              <Icon name="info" :size="15" /> 隐私说明
            </a>
          </li>
        </ul>

        <p class="privacy">{{ info.privacyNote }}</p>
      </template>
      <p v-else class="muted small">加载中…</p>

      <div class="modal-actions">
        <button class="btn ghost" @click="emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hero {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 18px;
}
.hero-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border-radius: var(--r-md);
  background: var(--c-primary);
  color: #fff;
  flex-shrink: 0;
}
.hero h3 {
  margin: 0;
}
.hero .modal-sub {
  margin: 0;
}
.hero .tag {
  margin-left: auto;
  flex-shrink: 0;
}

.grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-bottom: 16px;
}
.cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 9px 11px;
  border-radius: var(--r-md);
  background: var(--c-surface-2);
  border: 1px solid var(--c-border);
  min-width: 0;
}
.k {
  font-size: 11px;
  color: var(--c-faint);
}
.v {
  font-size: 13.5px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.desc {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--c-text-2);
}

.links {
  list-style: none;
  padding: 0;
  margin: 0 0 14px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.links a {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 11px;
  border: 1px solid var(--c-border);
  border-radius: var(--r-md);
  font-size: 12.5px;
  color: var(--c-text-2);
  transition: background var(--t-fast), color var(--t-fast), border-color var(--t-fast);
}
.links a:hover {
  background: var(--c-surface-2);
  border-color: var(--c-border-strong);
  color: var(--c-primary);
  text-decoration: none;
}

.privacy {
  margin: 0;
  font-size: 12px;
  line-height: 1.65;
  color: var(--c-muted);
}

@media (max-width: 520px) {
  .grid,
  .links {
    grid-template-columns: 1fr;
  }
}
</style>
