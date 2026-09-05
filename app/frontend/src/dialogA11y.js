// 弹窗可访问性 composable（UI-M1）：
//   - Esc 关闭（仅当本弹窗打开时响应，避免与全局/其他弹窗的 Esc 处理打架）
//   - 打开时把焦点移入弹窗内第一个可聚焦元素（键盘/读屏用户不再「迷失」在背景页）
//   - 关闭时把焦点还给打开前的元素
// 用法：const root = ref(null); useDialogA11y(() => props.show, () => emit('close'), root);
// 模板：根元素（.modal-mask）上加 ref="root"。
import { watch, nextTick } from 'vue';

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function useDialogA11y(showFn, closeFn, rootRef) {
  let prevFocus = null;

  function onKey(e) {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    closeFn();
  }

  watch(
    showFn,
    async (v) => {
      if (v) {
        prevFocus = document.activeElement;
        window.addEventListener('keydown', onKey, true);
        await nextTick();
        const root = rootRef?.value;
        const target = root?.querySelector(FOCUSABLE);
        if (target) target.focus();
      } else {
        window.removeEventListener('keydown', onKey, true);
        if (prevFocus && typeof prevFocus.focus === 'function') {
          try {
            prevFocus.focus();
          } catch {
            /* 元素可能已卸载，忽略 */
          }
        }
        prevFocus = null;
      }
    },
    { flush: 'post' },
  );
}
