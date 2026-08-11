<script setup>
const props = defineProps({ messages: Array, selectedId: { type: [Number, null], default: null } });
const emit = defineEmits(['select']);

function fmt(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
</script>

<template>
  <div class="list">
    <div v-if="!messages.length" class="muted" style="padding: 20px">该分类下暂无消息</div>
    <div
      v-for="m in messages"
      :key="m.id"
      class="item"
      :class="{ active: m.id === selectedId }"
      @click="emit('select', m.id)"
    >
      <div class="meta">
        <span class="tag">{{ m.category }}<template v-if="m.sub"> / {{ m.sub }}</template></span>
        <span class="muted">{{ fmt(m.ts) }}</span>
      </div>
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
  border-bottom: 1px solid #eef0f3;
  cursor: pointer;
}
.item:hover {
  background: #fafbff;
}
.item.active {
  background: #eef2ff;
}
.meta {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 4px;
}
.text {
  font-size: 13px;
  color: #374151;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.muted {
  font-size: 11px;
}
</style>
