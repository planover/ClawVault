<script setup>
import Icon from './Icon.vue';
import { toasts, dismiss, runAction } from '../toast.js';

const ICONS = { success: 'check', error: 'alert', warning: 'alert', info: 'info' };
</script>

<template>
  <div class="toast-host" role="status" aria-live="polite">
    <TransitionGroup name="toast">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="t.type">
        <Icon :name="ICONS[t.type] || 'info'" :size="16" />
        <span class="toast-msg">{{ t.message }}</span>
        <button v-if="t.actionLabel" class="toast-action" @click="runAction(t)">{{ t.actionLabel }}</button>
        <button class="toast-close" aria-label="关闭提示" @click="dismiss(t.id)">
          <Icon name="close" :size="13" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-host {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 200;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
  max-width: min(380px, calc(100vw - 32px));
}
.toast {
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 10px 12px;
  border-radius: var(--r-md);
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  box-shadow: var(--shadow-md);
  font-size: 13px;
  color: var(--c-text);
}
.toast.success {
  border-left: 3px solid var(--c-success);
}
.toast.success > :first-child {
  color: var(--c-success);
}
.toast.error {
  border-left: 3px solid var(--c-danger);
}
.toast.error > :first-child {
  color: var(--c-danger);
}
.toast.info {
  border-left: 3px solid var(--c-primary);
}
.toast.info > :first-child {
  color: var(--c-primary);
}
.toast.warning {
  border-left: 3px solid var(--c-warn);
}
.toast.warning > :first-child {
  color: var(--c-warn);
}
.toast-action {
  flex-shrink: 0;
  align-self: center;
  padding: 3px 10px;
  border-radius: var(--r-full);
  background: var(--c-primary-soft);
  color: var(--c-primary);
  font-size: 12.5px;
  font-weight: 600;
  transition: background var(--t-fast);
}
.toast-action:hover {
  background: var(--c-primary-soft-2);
}
.toast-msg {
  flex: 1;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.toast-close {
  flex-shrink: 0;
  display: inline-flex;
  color: var(--c-faint);
  padding: 2px;
  border-radius: var(--r-xs);
  transition: color var(--t-fast), background var(--t-fast);
}
.toast-close:hover {
  color: var(--c-text);
  background: var(--c-hover);
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity var(--t), transform var(--t);
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.97);
}
.toast-leave-active {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 100%;
}
</style>
