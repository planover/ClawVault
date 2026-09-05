// 轻量 Toast 通知：替代原先唯一的全局错误条。
// 原方案的两个问题：① 新错误会覆盖旧错误，用户只看到最后一条；② 没有成功类反馈，
// 用户点了保存/删除却不知道成没成。这里改为多条堆叠 + 自动消失 + 可手动关闭。
import { ref } from 'vue';

export const toasts = ref([]);

let seq = 0;

function push(type, message, ttl, extra = {}) {
  const id = ++seq;
  toasts.value = [...toasts.value, { id, type, message, ...extra }];
  const timer = setTimeout(() => dismiss(id), ttl);
  // 用户手动关闭时清掉定时器，避免对已移除的项做无谓操作
  return { id, timer };
}

export function dismiss(id) {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

export function toast(message, type = 'info', ttl = 3600) {
  return push(type, message, ttl);
}

toast.success = (m, ttl) => push('success', m, ttl ?? 2800);
toast.error = (m, ttl) => push('error', m, ttl ?? 6000);
toast.warning = (m, ttl) => push('warning', m, ttl ?? 4500);
toast.info = (m, ttl) => push('info', m, ttl ?? 3600);

// 带动作按钮的提示（UI-M6 撤销删除用）：点击按钮执行 onAction 并关闭。
toast.action = (m, actionLabel, onAction, ttl = 5000) =>
  push('info', m, ttl, { actionLabel, onAction });

// ToastHost 点击动作按钮时调用
export function runAction(t) {
  try {
    t.onAction?.();
  } finally {
    dismiss(t.id);
  }
}
