/**
 * 卡内前端与全局外观服务。
 *
 * 两块要分清楚：
 *   卡内前端 —— 跟卡走，只在该卡的对话里生效，跑在沙箱里；
 *   全局外观 —— 跟软件走，影响所有界面。
 * 沙箱能力用声明式表达，导入卡时把声明列给用户确认，而不是让脚本随便跑。
 */

import { emptyList } from '../contracts.mjs';
import { ValidationError } from '../errors.mjs';
import { FRONTEND_TIERS, frontendCodeHash, resolveFrontendPolicy } from './policy.mjs';

export const CARD_FRONTEND_CAPABILITIES = [
  { id: 'chat.vars.read', title: '读取对话变量', risk: 'low' },
  { id: 'chat.vars.write', title: '写入对话变量', risk: 'low' },
  { id: 'char.vars.read', title: '读取角色变量', risk: 'low' },
  { id: 'char.vars.write', title: '写入角色变量', risk: 'medium' },
  { id: 'chat.messages.read', title: '读取当前对话的消息', risk: 'low' },
  { id: 'chat.send', title: '发送用户消息并触发回复', risk: 'medium' },
  { id: 'turn.events', title: '注册回合事件', risk: 'low' },
];

export const THEME_TOKENS = [
  { id: '--st-bg', label: '背景色', default: '#ffffff' },
  { id: '--st-surface', label: '面板色', default: '#f6f7f9' },
  { id: '--st-border', label: '描边色', default: '#e3e6ea' },
  { id: '--st-text', label: '正文色', default: '#1b1b1f' },
  { id: '--st-muted', label: '次要文字', default: '#6b7280' },
  { id: '--st-accent', label: '强调色', default: '#c76b9b' },
  { id: '--st-bubble-user', label: '用户气泡', default: '#fdeef5' },
  { id: '--st-bubble-char', label: '角色气泡', default: '#f4f5f7' },
  { id: '--st-radius', label: '圆角', default: '10px' },
];

export const BUILTIN_THEMES = [
  { id: 'dark', title: '暗色', tone: 'dark', status: 'partial' },
  { id: 'light', title: '亮色', tone: 'light', status: 'partial' },
  { id: 'system', title: '跟随系统', tone: 'auto', status: 'partial' },
];

/**
 * 卡内前端沙箱的能力边界（蓝图 1.3，这次把它定死）。
 *
 * 三条硬线：
 *   1) 跑在 `<iframe sandbox="allow-scripts">` 里 —— 没有 allow-same-origin，
 *      所以拿不到主文档的 DOM / localStorage / cookie，也不能 `parent.document`。
 *   2) 一张白名单 CSP：默认禁止一切外部请求（connect-src 'none'、img-src 只允许
 *      data: 与 blob:），脚本只能是我们注入的那一份 + 卡自己的内联脚本。
 *   3) 卡内脚本**只能**通过 postMessage 桥跟主界面说话，桥按声明的能力放行；
 *      没声明的能力调用会被桥拒绝并回一条错误。
 *
 * 有意偏离：SillyTavern 的卡内前端是直接在同源页面里跑脚本（能做到什么取决于
 * 作者写什么）。这里按蓝图的取舍选了更严的隔离：能做的少了，但卡跑不出沙箱。
 */
/**
 * 沙箱的 CSP。
 *
 * 默认（严格档）只放行内联样式脚本和 `data:` / `blob:` —— 卡想显示一张图，必须把图内联进去。
 *
 * `allowExternalAssets` 打开后额外放行 `https:` / `http:` 的图片、字体、音视频和样式表，
 * 也就是"复刻那个平台：在 CSS 里贴一个图片 URL 就能显示"。卡从哪拿到这个权限见
 * `resolveFrontendPolicy`：自己的卡默认有，导入的卡要先被信任。
 *
 * `connect-src` 永远是 `'none'`：**图片能加载 ≠ 脚本能联网**。卡依然拿不到 fetch /
 * WebSocket，也就没法把聊天内容 POST 出去；它唯一能用出去的通道是"构造一个带参数的
 * 图片 URL"，这也是为什么这个开关要按信任给、不给陌生卡。
 */
export function buildSandboxCsp({ allowExternalAssets = false } = {}) {
  const remote = allowExternalAssets ? ['https:', 'http:'] : [];
  const parts = (label, ...values) => [label, ...values, ...remote].filter(Boolean).join(' ');
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    parts('style-src', "'unsafe-inline'"),
    parts('img-src', 'data:', 'blob:'),
    parts('font-src', 'data:'),
    "connect-src 'none'",
    parts('media-src', 'data:', 'blob:'),
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

export const SANDBOX_POLICY = {
  iframe: { sandbox: 'allow-scripts', referrerPolicy: 'no-referrer', loading: 'lazy' },
  csp: buildSandboxCsp(),
  bridge: {
    hostToCard: 'tavern-host',
    cardToHost: 'tavern-card',
    // 卡能调用的方法 → 需要的能力 id
    methods: {
      'vars.get': 'chat.vars.read',
      'vars.set': 'chat.vars.write',
      'charVars.get': 'char.vars.read',
      'charVars.set': 'char.vars.write',
      'messages.list': 'chat.messages.read',
      'chat.send': 'chat.send',
      'turn.on': 'turn.events',
      // ui.resize 不需要能力：只是让卡告诉宿主"我自然高度是多少"，宿主据此撑开 iframe。
    },
  },
  rules: [
    { id: 'js.fetch', severity: 'error', pattern: /\bfetch\s*\(/, message: '沙箱禁止联网：不要用 fetch' },
    { id: 'js.xhr', severity: 'error', pattern: /\bXMLHttpRequest\b/, message: '沙箱禁止联网：不要用 XMLHttpRequest' },
    { id: 'js.websocket', severity: 'error', pattern: /\b(WebSocket|EventSource)\b/, message: '沙箱禁止联网：不要开 WebSocket / EventSource' },
    { id: 'js.storage', severity: 'error', pattern: /\b(localStorage|sessionStorage|indexedDB)\b/, message: '沙箱里没有存储：改用对话变量（vars.set）' },
    { id: 'js.cookie', severity: 'error', pattern: /document\s*\.\s*cookie/, message: '沙箱读不到 cookie' },
    { id: 'js.parent', severity: 'error', pattern: /\b(window\s*\.\s*)?(parent|top|opener)\b\s*\.\s*(document|location|localStorage)/, message: '不能碰宿主页面：只用 Tavern 桥' },
    { id: 'js.eval', severity: 'error', pattern: /\b(eval|new\s+Function|importScripts)\s*\(/, message: '禁止动态执行代码（eval / new Function）' },
    { id: 'js.import', severity: 'error', pattern: /\bimport\s*\(|\brequire\s*\(/, message: '沙箱里没有模块加载器' },
    { id: 'js.process', severity: 'error', pattern: /\bprocess\s*\.\s*(env|exit|versions)/, message: '沙箱里没有 process' },
    // 下面三条是"静态扫描能被绕过"的补丁：JS / CSS 是直接拼进 <script> / <style> 里的，
    // 一旦出现结束标签就能提前收尾、把后面当成 HTML 插进去；location 赋值 / window.open
    // 则是唯一能绕过 `connect-src 'none'` 把数据带出去的通道（导航不受 CSP 连接指令管）。
    { id: 'js.scriptBreak', severity: 'error', pattern: /<\/\s*script/i, message: '脚本里不能出现 </script>（会提前结束脚本块，把代码当 HTML 插出去）' },
    { id: 'css.styleBreak', severity: 'error', pattern: /<\/\s*style/i, message: 'CSS 里不能出现 </style>（会提前结束样式块）' },
    {
      id: 'js.navigation',
      severity: 'error',
      pattern: /\blocation\s*(\.\s*(href|assign|replace)\b)?\s*=[^=]|\blocation\s*\.\s*(assign|replace)\s*\(|\bwindow\s*\.\s*open\s*\(/,
      message: '沙箱里不能导航 / 开新窗口：导航不受 connect-src 管，是个能绕过"禁止联网"的口子',
    },
    { id: 'js.locationAccess', severity: 'error', pattern: /\[\s*['"]location['"]\s*\]/, message: '不能写 window["location"] 这种形式绕过导航检查' },
    // HTML 里**一律**不许出现 <script>：脚本只能放 JS 段。
    // 否则卡把代码塞进 html 就能整段绕过上面那些 js.* 规则（静态扫描只扫 js 字段）。
    { id: 'html.scriptTag', severity: 'error', pattern: /<script\b/i, message: 'HTML 里不能写 <script>：脚本一律放 JS 段（外链脚本 CSP 也会挡）' },
    { id: 'html.iframe', severity: 'error', pattern: /<(iframe|object|embed|frame)\b/i, message: '不能再嵌一层 iframe / object' },
    { id: 'html.metaRefresh', severity: 'error', pattern: /<meta[^>]+http-equiv\s*=\s*['"]?\s*refresh/i, message: 'meta refresh 能导航出去，禁用' },
    { id: 'html.form', severity: 'warn', pattern: /<form\b/i, message: '表单无法提交（form-action 被禁），只是提示' },
    // 内联属性里的代码同样绕过 js.* 规则，所以这里是 error 不是提示
    { id: 'html.inlineHandler', severity: 'error', pattern: /\son[a-z]+\s*=/i, message: '不能写 onclick="…" 这类内联处理器（会绕过 JS 检查）：改用 addEventListener' },
    { id: 'html.javascriptUrl', severity: 'error', pattern: /javascript\s*:/i, message: 'javascript: URL 会被拦掉' },
    // 下面这两条只有在"不允许外部资源"时才算问题：开了外链，@import 和 url(https:) 本来就是作者要用的写法。
    {
      id: 'css.import',
      severity: 'error',
      relaxedSeverity: 'info',
      pattern: /@import\b/i,
      message: 'CSS 不能 @import 外部样式',
      relaxedMessage: '@import 外部样式：这张卡允许外链，能加载；但图床哪天挂了，样式就会掉',
    },
    {
      id: 'css.url',
      severity: 'warn',
      relaxedSeverity: 'info',
      pattern: /url\s*\(\s*['"]?https?:/i,
      message: '外部图片加载不了，改用 data: / blob:',
      relaxedMessage: '外部图片：这张卡允许外链，能显示；想稳的话可以用「本地化」把它存进卡资源',
    },
  ],
};

/** 静态扫描：把违反边界的写法找出来。error 会阻止保存 / 渲染，warn 只提示。 */
export function validateCardFrontend({ html = '', css = '', js = '', capabilities = [], allowExternalAssets = false } = {}) {
  const issues = [];
  const scan = (source, target, label) => {
    for (const rule of SANDBOX_POLICY.rules) {
      if (!rule.id.startsWith(`${target}.`)) continue;
      const match = String(source ?? '').match(rule.pattern);
      if (!match) continue;
      const relaxed = allowExternalAssets && rule.relaxedSeverity;
      issues.push({
        rule: rule.id,
        severity: relaxed ? rule.relaxedSeverity : rule.severity,
        message: relaxed ? (rule.relaxedMessage ?? rule.message) : rule.message,
        sample: String(match[0]).slice(0, 60),
        where: label,
      });
    }
  };
  scan(js, 'js', 'JS');
  scan(html, 'html', 'HTML');
  scan(css, 'css', 'CSS');

  const declared = Array.isArray(capabilities) ? capabilities : [];
  const known = new Set(CARD_FRONTEND_CAPABILITIES.map((item) => item.id));
  for (const id of declared) {
    if (!known.has(id)) issues.push({ rule: 'capability.unknown', severity: 'error', message: `不认识的能力：${id}`, where: '能力声明' });
  }
  const errors = issues.filter((item) => item.severity === 'error');
  return {
    ok: errors.length === 0,
    issues,
    errors: errors.length,
    warnings: issues.length - errors.length,
    capabilities: declared,
    allowExternalAssets,
    policy: { iframe: SANDBOX_POLICY.iframe, csp: buildSandboxCsp({ allowExternalAssets }) },
  };
}

function escapeHtml(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 把卡给的代码塞进 raw text 元素（`<script>` / `<style>`）之前，先把能"提前收尾"的序列废掉。
 *
 * HTML 解析器只看 `</script` 这几个字符（大小写不敏感，后面跟空白 / `/` / `>` 都算），
 * 所以把 `</script` 改写成 `<\/script` 就足够：在 JS / CSS 里 `\/` 与 `/` 等价、语义不变，
 * 但解析器不再认为脚本块到此结束。静态扫描（`js.scriptBreak` / `css.styleBreak`）也拦这一手，
 * 这里是不依赖扫描是否开启的**结构性**兜底 —— 以后放宽 / 跳过 lint 时它仍然生效。
 */
export function escapeRawText(source, tag) {
  const close = new RegExp(`</(${String(tag)})`, 'gi');
  return String(source ?? '').replace(close, '<\\/$1');
}

/**
 * 把卡内 HTML/CSS/JS 拼成 iframe srcdoc：CSP 写死在文档里，桥只放行声明的能力。
 * 返回给前端的只有字符串，真正的隔离由 iframe 的 sandbox 属性负责。
 *
 * 注意：沙箱 iframe 是 opaque origin，父页面拿不到 contentDocument，所以内容只能走
 * srcdoc 这条字符串路径 —— 没法"用 DOM 建好再塞进去"。因此这里对 css / js 做 raw text
 * 转义来替代拼字符串的风险；html 段在 `<body>` 里、不在 raw text 元素里，不需要转义
 * （它想写 `</body>` 之类的只会弄坏它自己那张卡）。
 */
export function renderCardFrontend({ html = '', css = '', js = '', capabilities = [], background = '' } = {}, { policy = null } = {}) {
  // 允许外部资源与否来自这张卡的策略（自己的卡 / 信任过的卡才有），不是代码自己说了算。
  const allowExternalAssets = Boolean(policy?.allowExternalAssets);
  const csp = buildSandboxCsp({ allowExternalAssets });
  const check = validateCardFrontend({ html, css, js, capabilities, allowExternalAssets });
  // 自己的卡 / 你信任过的卡：静态检查只当提示，不拦渲染。
  // 这不等于"关掉安全" —— 真正的隔离是沙箱 iframe + CSP + 宿主侧校验（来源、能力），
  // 静态检查只负责在你不确定代码来路时提前拦一道。
  if (!check.ok && !policy?.skipLint) {
    throw new ValidationError(`卡内前端有 ${check.errors} 处违反沙箱边界：${check.issues.filter((i) => i.severity === 'error').map((i) => i.rule).join('、')}`);
  }

  const allowed = capabilities.filter((id) => SANDBOX_POLICY.bridge.methods && Object.values(SANDBOX_POLICY.bridge.methods).includes(id));
  const bridge = `
  (function () {
    var allowed = ${JSON.stringify(allowed)};
    var methods = ${JSON.stringify(SANDBOX_POLICY.bridge.methods)};
    var pending = {};
    var seq = 0;
    function call(name, payload) {
      var need = methods[name];
      if (!need) return Promise.reject(new Error('没有这个方法：' + name));
      if (allowed.indexOf(need) === -1) return Promise.reject(new Error('这张卡没有声明能力：' + need));
      var id = 'c' + (++seq);
      return new Promise(function (resolve, reject) {
        pending[id] = { resolve: resolve, reject: reject };
        parent.postMessage({ source: '${SANDBOX_POLICY.bridge.cardToHost}', id: id, method: name, payload: payload || {} }, '*');
      });
    }
    window.addEventListener('message', function (event) {
      var data = event.data || {};
      if (data.source !== '${SANDBOX_POLICY.bridge.hostToCard}') return;
      // 宿主推过来的事件（比如"这一轮说完了"）→ 转成卡里能监听的 tavern-turn
      if (data.event) {
        try { window.dispatchEvent(new CustomEvent('tavern-turn', { detail: data.detail || {} })); } catch (err) {}
        return;
      }
      if (!data.id || !pending[data.id]) return;
      var slot = pending[data.id];
      delete pending[data.id];
      if (data.error) slot.reject(new Error(data.error));
      else slot.resolve(data.result);
    });
    window.Tavern = Object.freeze({
      capabilities: allowed.slice(),
      vars: { get: function (key) { return call('vars.get', { key: key }); }, set: function (key, value) { return call('vars.set', { key: key, value: value }); } },
      charVars: { get: function (key) { return call('charVars.get', { key: key }); }, set: function (key, value) { return call('charVars.set', { key: key, value: value }); } },
      messages: { list: function (limit) { return call('messages.list', { limit: limit }); } },
      send: function (text) { return call('chat.send', { text: text }); },
      onTurn: function (handler) { window.addEventListener('tavern-turn', function (event) { handler(event.detail); }); },
      ui: {
        resize: function (height) {
          var px = Number(height);
          if (!Number.isFinite(px) || px <= 0) return;
          parent.postMessage({ source: '${SANDBOX_POLICY.bridge.cardToHost}', method: 'ui.resize', payload: { height: px } }, '*');
        },
      },
      ready: function () { parent.postMessage({ source: '${SANDBOX_POLICY.bridge.cardToHost}', method: 'ready' }, '*'); },
    });
  })();`;

  /**
   * 沙箱里的默认底色：**中性的白底深字**。
   *
   * 为什么不是跟着我们自己的深色主题：卡是给别人家的平台写的，绝大多数按"白底深字"排版。
   * 以前这里给的是透明底 + 深色主题的浅灰字，搬过来的卡一贴到我们的浅色界面上，
   * 字就发灰、颜色全变样（用户实测反馈过）。想要跟着我们主题走的卡，
   * 用 --st-* 变量就行 —— 这层只是"什么都没写时的兜底"。
   */
  const tokenVars = THEME_TOKENS.map((token) => `${token.id}: ${token.default}`).join('; ');
  // 只认我们自己素材库的地址：别让"卡里带一段能拼进 <style> 的东西"有可乘之机
  const rawBackground = String(background ?? '').trim();
  const backgroundUrl = /^\/api\/assets\/[A-Za-z0-9_-]+\/file$/.test(rawBackground) ? rawBackground : '';
  const backgroundVar = backgroundUrl ? `; --st-card-bg: url("${backgroundUrl}")` : '';
  const srcdoc = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
:root { ${tokenVars}${backgroundVar}; }
html, body {
  margin: 0;
  background: var(--st-bg, #ffffff);
  color: var(--st-text, #1b1b1f);
  font-family: system-ui, sans-serif;
  min-height: 100%;
}
/* 这张卡自己的背景图（导入平台作品时搬过来的横幅）走这个变量，卡里想用就 use 它 */
body {
  background-image: var(--st-card-bg, none);
  background-size: cover;
  background-position: center;
}
${escapeRawText(css, 'style')}
</style>
</head>
<body>
${String(html ?? '')}
<script>${bridge}</script>
<script>
try {
${escapeRawText(js, 'script')}
} catch (err) {
  console.error('卡内脚本出错：', err);
}
</script>
</body>
</html>`;

  return {
    srcdoc,
    // 卡自己的背景（有的话）：界面把它塞进 --st-card-bg，卡里想铺就铺
    background: backgroundUrl || null,
    sandbox: SANDBOX_POLICY.iframe.sandbox,
    referrerPolicy: SANDBOX_POLICY.iframe.referrerPolicy,
    csp,
    capabilities: allowed,
    // 宿主侧的桥要知道"哪个方法对应哪个能力"，跟服务端用同一张表，别在前端再抄一份
    methods: { ...SANDBOX_POLICY.bridge.methods },
    validation: check,
  };
}

/** 只收白名单里的主题变量；值截断到 60 字符，坏数据不落库。 */
function normaliseThemeTokens(raw = {}) {
  const out = {};
  for (const token of THEME_TOKENS) {
    const value = raw?.[token.id];
    if (value === undefined || value === null || value === '') continue;
    out[token.id] = String(value).slice(0, 60);
  }
  return out;
}

export function createFrontendService({ settings = {}, ports = {} } = {}) {
  const store = () => ports.frontendStore ?? null;
  const requireStore = (what) => {
    const found = store();
    if (!found) throw new ValidationError(`${what}需要存储端口：请通过 createEngine({ ports }) 注入 frontendStore`);
    return found;
  };

  // 自定义主题跟软件走：内置三家 + 用户存的。
  async function listThemes() {
    const custom = store()?.listThemes?.() ?? [];
    const items = [...BUILTIN_THEMES, ...custom];
    return { items, total: items.length, tokens: THEME_TOKENS };
  }

  async function saveTheme(input = {}) {
    const found = requireStore('保存主题');
    const tokens = normaliseThemeTokens(input.tokens ?? input);
    if (!Object.keys(tokens).length) throw new ValidationError('主题至少要改一个颜色 / 圆角');
    const name = String(input.name ?? '').trim() || '自定义主题';
    return found.saveTheme({ id: input.id ?? undefined, name, tokens });
  }

  async function removeTheme(id) {
    return requireStore('删除主题').removeTheme(id);
  }

  // 卡内前端代码按 scope（角色卡 / 对话 / global）持久化；保存前先过沙箱静态校验。
  async function listSnippets(query = {}) {
    const found = store();
    if (!found) return emptyList();
    const items = found.listSnippets({ scope: query?.scope ?? null });
    return { items, total: items.length };
  }

  async function saveSnippet(input = {}) {
    const found = requireStore('保存卡内前端代码');
    // 片段是用户自己在界面里写的（没有"别人的卡"这回事），所以直接按允许外链来查——
    // 否则贴一段带 @import 的全局样式会被当成违规拦住。
    const check = validateCardFrontend({
      html: input.html,
      css: input.css,
      js: input.js,
      capabilities: input.capabilities,
      allowExternalAssets: true,
    });
    if (!check.ok) {
      throw new ValidationError(
        `卡内前端有 ${check.errors} 处违反沙箱边界：${check.issues.filter((item) => item.severity === 'error').map((item) => item.rule).join('、')}`,
      );
    }
    const saved = found.saveSnippet({
      id: input.id ?? undefined,
      scope: input.scope ?? '',
      name: input.name ?? '未命名片段',
      html: input.html ?? '',
      css: input.css ?? '',
      js: input.js ?? '',
      capabilities: check.capabilities,
    });
    return { ...saved, validation: check };
  }

  async function removeSnippet(id) {
    return requireStore('删除卡内前端代码').removeSnippet(id);
  }

  // ---------------------------------------------------------------- 卡内前端：策略 + 信任

  function trustOf(characterId) {
    return store()?.getTrust?.(characterId) ?? null;
  }

  /**
   * 把"卡里的代码 + 卡从哪来 + 信任记录"算成一次渲染所需的一切。
   * 代码过不了静态检查时**不抛错**，只是不给 srcdoc —— 界面要把问题清单列出来让人改。
   */
  function describeCardFrontend({ source = 'original', code = {}, trust = null } = {}) {
    const clean = {
      html: String(code?.html ?? ''),
      css: String(code?.css ?? ''),
      js: String(code?.js ?? ''),
      capabilities: Array.isArray(code?.capabilities) ? code.capabilities.map(String) : [],
      // 卡自己的背景（导入平台作品时搬过来的横幅）：跟着代码一起带着，
      // 渲染时变成 --st-card-bg；不带的话每次描述都会把它丢掉
      background: String(code?.background ?? ''),
    };
    const codeHash = frontendCodeHash(clean);
    const policy = resolveFrontendPolicy({ source, codeHash, trust });
    const hasCode = Boolean(clean.html.trim() || clean.css.trim() || clean.js.trim());
    const validation = validateCardFrontend({ ...clean, allowExternalAssets: policy.allowExternalAssets });
    let render = null;
    let blocked = null;
    if (hasCode) {
      try {
        // 卡自己的背景图（从平台搬过来的横幅）跟着一起进沙箱：
        // 它是素材库地址，会变成 --st-card-bg，卡里想铺就铺
        render = renderCardFrontend({ ...clean, background: code?.background ?? '' }, { policy });
      } catch (err) {
        blocked = err?.message ?? String(err);
      }
    }
    return { code: clean, codeHash, policy, hasCode, validation, render, blocked };
  }

  /** 信任这张卡的**当前这段代码**（哈希存在信任表里，不属于卡数据）。 */
  function trustCardFrontend(characterId, codeHash) {
    const found = requireStore('信任卡内前端');
    if (!characterId || !codeHash) throw new ValidationError('信任需要 characterId 与代码哈希');
    return found.grantTrust(characterId, codeHash);
  }

  function untrustCardFrontend(characterId) {
    return requireStore('取消信任').revokeTrust(characterId);
  }

  return {
    capabilities: () => CARD_FRONTEND_CAPABILITIES,
    tiers: () => FRONTEND_TIERS.map((item) => ({ ...item })),
    themeTokens: () => THEME_TOKENS,
    listThemes,
    saveTheme,
    removeTheme,
    listSnippets,
    saveSnippet,
    removeSnippet,
    trustOf,
    describeCardFrontend,
    trustCardFrontend,
    untrustCardFrontend,
    codeHashOf: (code = {}) => frontendCodeHash(code),

    // ---- 沙箱（蓝图 1.3）----
    policy: () => SANDBOX_POLICY,
    validateSnippet: async (input = {}) => validateCardFrontend(input),
    renderSandbox: async (input = {}, options = {}) => renderCardFrontend(input, options),
  };
}
