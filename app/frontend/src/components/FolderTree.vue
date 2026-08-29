<script setup>
import { ref, watch } from 'vue';
import Icon from './Icon.vue';

const props = defineProps({ folders: Array, selected: Object });
const emit = defineEmits(['select']);

// 通道级折叠状态：默认展开当前选中的通道与所有有内容的通道
const collapsed = ref({});

// 切换筛选后，确保目标通道是展开的，否则用户看不到自己选中的层级
watch(
  () => props.selected?.channelName,
  (name) => {
    if (name) collapsed.value = { ...collapsed.value, [name]: false };
  },
  { immediate: true },
);

function toggle(name) {
  collapsed.value = { ...collapsed.value, [name]: !collapsed.value[name] };
}
function isCollapsed(name) {
  return Boolean(collapsed.value[name]);
}

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
    <div v-for="ch in folders" :key="ch.name" class="ch">
      <div class="ch-row" :class="{ active: selected?.channelName === ch.name && !selected?.category }">
        <button class="chev" :aria-label="isCollapsed(ch.name) ? '展开' : '折叠'" @click.stop="toggle(ch.name)">
          <Icon name="chevronRight" :size="13" :class="{ rotated: !isCollapsed(ch.name) }" />
        </button>
        <button class="ch-name truncate" :title="ch.name" @click="selectChannel(ch.name)">
          <Icon name="folder" :size="15" />
          <span>{{ ch.name }}</span>
        </button>
      </div>

      <div v-show="!isCollapsed(ch.name)" class="ch-body">
        <template v-for="cat in ch.categories" :key="cat.name">
          <button
            class="cat"
            :class="{ active: isSel({ channelName: ch.name, category: cat.name }) }"
            @click="selectCat(ch.name, cat.name)"
          >
            <span class="truncate cat-label">{{ cat.name }}</span>
            <span class="count">{{ cat.count }}</span>
          </button>
          <button
            v-for="s in cat.subs"
            :key="`${cat.name}/${s.name}`"
            class="sub"
            :class="{ active: isSel({ channelName: ch.name, category: cat.name, sub: s.name }) }"
            @click="selectSub(ch.name, cat.name, s.name)"
          >
            <span class="truncate">{{ s.name }}</span>
            <span class="count">{{ s.count }}</span>
          </button>
        </template>
      </div>
    </div>

    <p v-if="!folders.length" class="empty muted small">暂无归档。先添加通道，或开启演示模式看看效果。</p>
  </div>
</template>

<style scoped>
.tree {
  font-size: 13px;
  user-select: none;
}
.ch + .ch {
  margin-top: 2px;
}
.ch-row {
  display: flex;
  align-items: center;
  gap: 1px;
  border-radius: var(--r-sm);
  transition: background var(--t-fast);
}
.ch-row:hover {
  background: var(--c-hover);
}
.ch-row.active {
  background: var(--c-active);
}
.chev {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 26px;
  color: var(--c-faint);
  border-radius: var(--r-xs);
}
.chev:hover {
  color: var(--c-text);
}
.chev :deep(svg) {
  transition: transform var(--t-fast);
}
.chev .rotated {
  transform: rotate(90deg);
}
.ch-name {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  height: 26px;
  padding: 0 8px 0 2px;
  font-size: 13px;
  font-weight: 550;
  color: var(--c-text);
  text-align: left;
}
.ch-row.active .ch-name {
  color: var(--c-primary);
}
.ch-body {
  padding-left: 21px;
  margin: 1px 0 4px;
}
.cat {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 26px;
  padding: 0 8px 0 7px;
  border-radius: var(--r-sm);
  color: var(--c-text-2);
  text-align: left;
  border-left: 2px solid transparent;
  transition: background var(--t-fast), color var(--t-fast), border-color var(--t-fast);
}
.cat:hover {
  background: var(--c-hover);
  color: var(--c-text);
}
.cat.active {
  background: var(--c-active);
  border-left-color: var(--c-primary);
  color: var(--c-primary);
  font-weight: 500;
}
.cat-label {
  flex: 1;
  min-width: 0;
}
.count {
  font-size: 11px;
  color: var(--c-faint);
  font-variant-numeric: tabular-nums;
}
.cat.active .count {
  color: var(--c-primary);
}
.sub {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 24px;
  padding: 0 8px 0 15px;
  border-radius: var(--r-sm);
  font-size: 12.5px;
  color: var(--c-muted);
  text-align: left;
  border-left: 2px solid transparent;
  transition: background var(--t-fast), color var(--t-fast), border-color var(--t-fast);
}
.sub::before {
  content: '';
  flex-shrink: 0;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--c-faint);
}
.sub:hover {
  background: var(--c-hover);
  color: var(--c-text);
}
.sub.active {
  background: var(--c-active);
  border-left-color: var(--c-primary);
  color: var(--c-primary);
  font-weight: 500;
}
.sub span:first-of-type {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.empty {
  padding: 6px 8px;
  line-height: 1.6;
}
</style>
