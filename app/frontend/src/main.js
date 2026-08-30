import { createApp } from 'vue';
import App from './App.vue';
import './style.css';
// 风格主题：iOS 经典（ios-classic）与 iOS 27（ios27），需在 style.css 之后加载以覆盖语义变量
import './theme-ios-classic.css';
import './theme-ios27.css';

createApp(App).mount('#app');
