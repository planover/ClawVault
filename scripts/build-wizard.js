/*
 * 生成 wizard/install —— fnOS 安装向导 JSON（中英双语《许可协议》合一步）。
 * 内容：
 *   1. 欢迎
 *   2. 许可协议（中文摘要 + GNU AGPL v3 英文全文，来自仓库根 LICENSE）
 *      —— 完整英文内嵌进 tips 的 helpText，勾选框 required
 *   3. 使用说明
 *
 * 用法：node scripts/build-wizard.js
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const licensePath = path.join(root, 'LICENSE');
if (!fs.existsSync(licensePath)) {
  console.error('✗ 找不到 LICENSE：' + licensePath);
  process.exit(1);
}
const licenseEn = fs.readFileSync(licensePath, 'utf8');

// 转义为 JSON 字符串字面量，并把换行转为 <br> 以便 HTML 保留原文换行结构
function jsonStr(s) {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '<br>');
}
const englishHtml = jsonStr(licenseEn);

const zhSummary =
  '<p>本程序依据 <b>GNU Affero General Public License v3.0（AGPL-3.0）</b> 发布，要点：</p>' +
  '<ol>' +
    '<li><b>自由使用与修改</b>：你有权运行、研究、复制、修改本程序及其源码。</li>' +
    '<li><b>持续开源（Copyleft）</b>：若你分发本程序的修改版本，必须以 AGPL-3.0 同样开源，并提供完整对应源码。</li>' +
    '<li><b>网络使用条款（AGPL 特有）</b>：即使你仅通过网络（如本应用的 Web 管理界面）向他人提供本程序功能，也视为"分发"，须向用户提供获取完整对应源码的途径。</li>' +
    '<li><b>无担保</b>：本程序按"现状"提供，作者与贡献者不对适用性、正确性及任何后果提供担保，使用风险由你自行承担。</li>' +
    '<li><b>数据本地化</b>：本应用默认将对话归档到你飞牛本地的共享目录，不主动上传任何第三方；AI 分类接口由你自行配置，请妥善保管 api_key。</li>' +
    '<li><b>商标</b>：本许可不授予任何商标或名称的使用权。</li>' +
  '</ol>' +
  '<p>勾选下方选项即表示你已阅读、理解并接受上述全部条款以及下方英文 AGPL-3.0 全文。</p>';

const wizard = [
  {
    stepTitle: '欢迎使用 ClawVault（爪匣）',
    items: [
      {
        type: 'tips',
        helpText:
          '<p><b>ClawVault（爪匣）</b>是一款开源的对话归档工具，可把你在微信 / Telegram / 飞书 / 钉钉 / 企业微信 / Discord / Slack 等平台与 bot 的私聊，自动分类、存入飞牛本地存储。</p>' +
          '<p>本应用以 <b>GNU Affero General Public License v3.0（AGPL-3.0）</b> 协议发布。安装前请阅读下方中英双语《许可协议》并勾选同意。</p>',
      },
    ],
  },
  {
    stepTitle: '许可协议（中文） / License Agreement (English)',
    items: [
      {
        type: 'tips',
        helpText:
          '<h3 style="margin-top:0">中文摘要 / Chinese Summary</h3>' +
          zhSummary +
          '<hr/>' +
          '<h3>English — GNU Affero General Public License v3 (Full Text)</h3>' +
          '<div style="font-size:12px;line-height:1.5;">' + englishHtml + '</div>',
      },
      {
        type: 'checkbox',
        field: 'accept_license',
        label: '我已阅读并同意上述《许可协议》/ I have read and agree',
        options: [{ label: '同意 / Agree', value: 'yes' }],
        initValue: '',
        rules: [{ required: true, message: '请先勾选同意许可协议 / Please accept the license' }],
      },
    ],
  },
  {
    stepTitle: '使用说明',
    items: [
      {
        type: 'tips',
        helpText:
          '<p><b>安装完成后：</b></p>' +
          '<ol>' +
            '<li>在飞牛「应用中心」打开 ClawVault，或浏览器访问 <code>http://&lt;飞牛IP&gt;:6789</code>。</li>' +
            '<li>进入「设置」页，填写 AI 分类接口（api_key / base_url / model）；留空则退化为按时间归档，仍可使用。</li>' +
            '<li>进入「通道管理」，点击「添加通道」并扫码绑定你的微信 ClawBot；可添加多个通道，分别归档你与不同 bot 的对话。</li>' +
            '<li>此后与各 bot 的私聊会自动分类存入：<code>[归档根]/[通道]/[分类]/[子分类]/</code>。</li>' +
          '</ol>' +
          '<p>归档根目录默认挂载到飞牛共享目录中的 <code>archive</code> 文件夹。</p>',
      },
    ],
  },
];

const out = path.join(root, 'wizard', 'install');
fs.writeFileSync(out, JSON.stringify(wizard, null, 2));
console.log('✓ 已生成 ' + path.relative(root, out) + ' （' + fs.statSync(out).size + ' bytes，含完整英文 AGPL-3.0）');