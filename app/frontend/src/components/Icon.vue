<script setup>
// 统一图标集：24×24 描边风格（Lucide 风格），替代原先散落的 emoji，
// 保证深/浅色下视觉一致、可随字号缩放、不受系统 emoji 字体差异影响。
import { computed } from 'vue';

const props = defineProps({
  name: { type: String, required: true },
  size: { type: [Number, String], default: 18 },
  strokeWidth: { type: [Number, String], default: 1.8 },
});

const PATHS = {
  menu: 'M4 7h16M4 12h16M4 17h16',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3',
  close: 'M18 6 6 18M6 6l12 12',
  chevronRight: 'm9 6 6 6-6 6',
  chevronDown: 'm6 9 6 6 6-6',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  expand: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
  check: 'm5 13 4 4L19 7',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  edit: 'M4 20h4L19 9l-4-4L4 16v4ZM14 6l4 4',
  download: 'M12 4v11m0 0 4-4m-4 4-4-4M5 20h14',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',
  folderOpen: 'M3 8V6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1M3 8h18l-2 9a2 2 0 0 1-2 1.6H7A2 2 0 0 1 5 17L3 8Z',
  layers: 'm12 3 9 5-9 5-9-5 9-5ZM3 13l9 5 9-5M3 17l9 5 9-5',
  inbox: 'M4 13h4l2 3h4l2-3h4M4 13V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7m-16 0v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5',
  sheet: 'M5 3h14v18H5zM5 9h14M5 15h14M9 3v18M15 3v18',
  image: 'M4 5h16v14H4zM4 15l4.5-4.5 3.5 3.5 3-3L20 15M15 9h.01',
  video: 'M3 6h12v12H3zM15 10l6-3v10l-6-3',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5ZM14 3v5h5',
  mic: 'M12 4a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V7a3 3 0 0 1 3-3ZM5 11a7 7 0 0 0 14 0M12 18v3M9 21h6',
  smile: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9 10h.01M15 10h.01M8.5 14.5a4.5 4.5 0 0 0 7 0',
  message: 'M20 15a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9Z',
  bot: 'M9 8V6a3 3 0 0 1 6 0v2M6 10h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2ZM9.5 14h.01M14.5 14h.01',
  plug: 'M9 3v6M15 3v6M6 9h12v3a6 6 0 0 1-12 0V9ZM12 18v3',
  settings:
    'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-2.87 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.87-1.2l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15H4.5a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 11.5 4.6V4.5a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.87 1.2l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 11h.1a2 2 0 1 1 0 4h-.1Z',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5M12 8h.01',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z',
  alert: 'M12 3 2.5 20h19L12 3ZM12 9v5M12 17h.01',
  refresh: 'M20 11a8 8 0 1 0-2.3 6.3M20 5v6h-6',
  sparkle: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3ZM19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8L19 17Z',
  archive: 'M3 7h18v4H3zM5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8M10 15h4',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2',
  arrowRight: 'M5 12h14M13 6l6 6-6 6',
  empty: 'M4 13V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7M4 13h4l1.5 2.5h5L16 13h4m0 0v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-5',
};

const d = computed(() => PATHS[props.name] || PATHS.info);
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    :stroke-width="strokeWidth"
    stroke="currentColor"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path :d="d" />
  </svg>
</template>
