<script setup>
const props = defineProps({ folders: Array, selected: Object });
const emit = defineEmits(['select']);

function selectChannel(name) {
  emit('select', { channelName: name, category: '', sub: '' });
}
function selectCat(ch, cat) {
  emit('select', { channelName: ch, category: cat, sub: '' });
}
function selectSub(ch, cat, sub) {
  emit('select', { channelName: ch, category: cat, sub });
}
function isSel(o) {
  return (
    props.selected?.channelName === o.channelName &&
    props.selected?.category === (o.category || '') &&
    props.selected?.sub === (o.sub || '')
  );
}
</script>

<template>
  <div class="tree">
    <div
      v-for="ch in folders"
      :key="ch.name"
      class="ch"
      :class="{ active: selected?.channelName === ch.name && !selected?.category }"
      @click="selectChannel(ch.name)"
    >
      <div class="ch-name">📁 {{ ch.name }}</div>
      <div
        v-for="cat in ch.categories"
        :key="cat.name"
        class="cat"
        :class="{ active: isSel({ channelName: ch.name, category: cat.name }) }"
        @click.stop="selectCat(ch.name, cat.name)"
      >
        <div class="cat-name">▸ {{ cat.name }} <span class="muted">({{ cat.count }})</span></div>
        <div
          v-for="s in cat.subs"
          :key="s.name"
          class="sub"
          :class="{ active: isSel({ channelName: ch.name, category: cat.name, sub: s.name }) }"
          @click.stop="selectSub(ch.name, cat.name, s.name)"
        >
          · {{ s.name }} <span class="muted">({{ s.count }})</span>
        </div>
      </div>
    </div>
    <div v-if="!folders.length" class="muted" style="padding: 10px">暂无归档。先添加通道或开启演示模式。</div>
  </div>
</template>

<style scoped>
.tree {
  font-size: 13px;
  user-select: none;
}
.ch {
  margin-bottom: 4px;
}
.ch-name {
  font-weight: 600;
  padding: 4px 6px;
  border-radius: 6px;
  cursor: pointer;
}
.cat-name,
.sub {
  padding: 3px 6px 3px 14px;
  border-radius: 6px;
  cursor: pointer;
}
.sub {
  padding-left: 28px;
  color: var(--c-text-2);
}
.active {
  background: var(--c-active);
  color: var(--c-primary);
}
.muted {
  font-size: 11px;
}
</style>
