/**
 * 「审查」：给一段（通常是 AI 帮你写的）前端代码做体检。
 *
 * 做三件事：
 *   1) 能不能解析 —— JS 用 node:vm **只编译、不执行**，语法错直接指到原因；
 *   2) 会不会被沙箱挡 —— 复用卡内前端那套静态规则（fetch / eval / localStorage…）；
 *   3) 常见的"看着对、跑起来才发现"的坑 —— 用了桥方法却没声明能力、漏了 Tavern.ready()、
 *      外链脚本、CSS 括号不配平、模板占位符没填，等等。
 *
 * 纯逻辑：不碰 HTTP、不写文件、**不执行**被审的代码。返回一份能直接读的报告。
 */

import vm from 'node:vm';
import { SANDBOX_POLICY, validateCardFrontend } from './service.mjs';

const SEVERITY_RANK = { error: 0, warn: 1, info: 2 };

/** 沙箱规则的"为什么 / 怎么改"，抽查几处最容易踩的。 */
const RULE_HINTS = {
  'js.fetch': '沙箱里禁止联网。要数据就用 Tavern 桥（vars / messages），或把数据直接写进代码。',
  'js.xhr': '同上：沙箱里发不出请求。',
  'js.websocket': '沙箱里不能开长连接。',
  'js.storage': '沙箱里没有 localStorage / sessionStorage。要存东西用 Tavern.vars.set（对话变量）或 charVars.set（角色变量）。',
  'js.eval': '动态执行代码会被挡，也基本是 AI 代码的坏味道：改成直接写函数。',
  'js.navigation': '沙箱里不能跳转 / 开新窗口。',
  'html.scriptTag': '脚本要放在 JS 那一栏，HTML 里塞 <script> 会被拦。',
  'html.inlineHandler': '别写 onclick="…"，改成 addEventListener。',
  'html.iframe': '沙箱里不能再套 iframe。',
  'capability.unknown': '这个能力名字不在这份清单里，多半是拼错了。',
  'css.import': '外链样式在"严格档"会被拦；这个板块是放开档，能加载，但对方哪天挂了你样式就掉，建议把 CSS 直接贴进来。',
  'css.url': '外链图片在"严格档"会被拦；这个板块是放开档，能显示。想稳一点可以换成 data: 或本地素材。',
};

/** 桥调用 → 需要的能力（跟 SANDBOX_POLICY.bridge.methods 同一张表）。 */
const BRIDGE_USAGE = [
  { pattern: /Tavern\s*\.\s*vars\s*\.\s*get\s*\(/, method: 'vars.get', label: 'Tavern.vars.get' },
  { pattern: /Tavern\s*\.\s*vars\s*\.\s*set\s*\(/, method: 'vars.set', label: 'Tavern.vars.set' },
  { pattern: /Tavern\s*\.\s*charVars\s*\.\s*get\s*\(/, method: 'charVars.get', label: 'Tavern.charVars.get' },
  { pattern: /Tavern\s*\.\s*charVars\s*\.\s*set\s*\(/, method: 'charVars.set', label: 'Tavern.charVars.set' },
  { pattern: /Tavern\s*\.\s*messages\s*\.\s*list\s*\(/, method: 'messages.list', label: 'Tavern.messages.list' },
  { pattern: /Tavern\s*\.\s*send\s*\(/, method: 'chat.send', label: 'Tavern.send' },
  { pattern: /Tavern\s*\.\s*onTurn\s*\(/, method: 'turn.on', label: 'Tavern.onTurn' },
];

const TAG_CHECKS = ['div', 'span', 'p', 'a', 'ul', 'ol', 'li', 'button', 'section', 'nav', 'header', 'footer', 'table', 'tr', 'td'];

function countTag(source, tag, closing) {
  const re = new RegExp(`<${closing ? '/' : ''}${tag}\\b`, 'gi');
  return (String(source).match(re) ?? []).length;
}

/**
 * @param {{html?:string, css?:string, js?:string, capabilities?:string[], allowExternalAssets?:boolean}} input
 * @returns {{ok:boolean, counts:{error:number,warn:number,info:number}, issues:Array, summary:string}}
 */
export function reviewFrontend({ html = '', css = '', js = '', capabilities = [], allowExternalAssets = true } = {}) {
  const issues = [];
  const add = (severity, where, rule, message, hint = '', sample = '') => {
    issues.push({ severity, where, rule, message, hint, sample: String(sample ?? '').slice(0, 80) });
  };

  // 1) 沙箱规则（跟卡内前端同一套，别在两处各写一份）
  const sandbox = validateCardFrontend({ html, css, js, capabilities, allowExternalAssets });
  for (const issue of sandbox.issues ?? []) {
    add(issue.severity, issue.where ?? '', issue.rule, issue.message, RULE_HINTS[issue.rule] ?? '', issue.sample ?? '');
  }

  // 2) JS 语法：只编译、不执行。语法错的话浏览器里整段都不会跑。
  const code = String(js ?? '');
  const htmlText = String(html ?? '');
  const cssText = String(css ?? '');
  if (code.trim()) {
    try {
      new vm.Script(code, { filename: 'galgame-frontend.js' });
    } catch (err) {
      add('error', 'JS', 'js.syntax', `语法错误，浏览器里这一栏整段都跑不起来：${err?.message ?? err}`, '多半是括号 / 引号没配平。把这条报错原样发给 AI，让它重写这段。');
    }
  }

  // 3) 用了桥方法，却没勾对应的能力 —— AI 最爱犯的错（代码没错，但桥会拒绝）
  const declared = new Set(Array.isArray(capabilities) ? capabilities : []);
  for (const item of BRIDGE_USAGE) {
    if (!item.pattern.test(code)) continue;
    const need = SANDBOX_POLICY.bridge?.methods?.[item.method];
    if (need && !declared.has(need)) {
      add('error', '权限', `bridge.${item.method}`, `用了 ${item.label}，但没有勾选它需要的能力「${need}」，桥会直接拒绝这次调用。`, '在上面把那个能力勾上；或改成不需要能力的方法。');
    }
  }

  // 4) 常见坑
  if (/document\s*\.\s*write\s*\(/.test(code)) {
    add('warn', 'JS', 'js.documentWrite', '用了 document.write()：文档写完再调用会把整页清空。', '改成把内容塞进某个元素的 innerHTML 或 textContent。');
  }
  if (/\.innerHTML\s*=/.test(code)) {
    add('info', 'JS', 'js.innerHTML', '用了 innerHTML 赋值：如果拼进去的是外部内容，容易出问题。', '纯文本用 textContent；确实要插 HTML 的话，先想清楚内容从哪来。');
  }
  if (/console\s*\.\s*(log|debug|warn|info)\s*\(/.test(code)) {
    add('info', 'JS', 'js.console', '代码里留了 console.log 之类的调试语句。', '正式用的时候可以删掉，不影响运行。');
  }
  if (/\balert\s*\(/.test(code)) {
    add('info', 'JS', 'js.alert', '用了 alert()：沙箱里能弹，但会打断整个界面。', '改用页面里自己的提示元素。');
  }
  if (/Tavern\s*\./.test(code) && !/Tavern\s*\.\s*ready\s*\(/.test(code)) {
    add('info', 'JS', 'js.noReady', '用了 Tavern 桥，但没看到 Tavern.ready()。', '习惯上脚本就绪后调一下 Tavern.ready()，宿主据此知道界面挂好了。');
  }

  // CSS 括号配平
  const openBraces = (cssText.match(/\{/g) ?? []).length;
  const closeBraces = (cssText.match(/\}/g) ?? []).length;
  if (openBraces !== closeBraces) {
    add('error', 'CSS', 'css.braces', `CSS 的 { 和 } 数量对不上（${openBraces} 个 { / ${closeBraces} 个 }），后面的样式会全部失效。`, '检查最后几段是不是少了个 }。');
  }

  // HTML 成对标签
  for (const tag of TAG_CHECKS) {
    const opened = countTag(htmlText, tag, false);
    const closed = countTag(htmlText, tag, true);
    if (opened !== closed) {
      const selfClosing = new RegExp(`<${tag}\\b[^>]*/>`, 'gi');
      const selfCount = (htmlText.match(selfClosing) ?? []).length;
      if (opened - selfCount !== closed) {
        add('warn', 'HTML', 'html.unbalanced', `<${tag}> 开合数量不一样（${opened} 开 / ${closed} 合），浏览器会自动补，页面结构可能跟你想的不一样。`, '把少掉的那个闭合标签补上。');
      }
    }
  }

  // 外链脚本 / 样式：沙箱里外部 JS 会被 CSP 挡
  if (/<script\b[^>]*\bsrc\s*=/i.test(htmlText) || /<link\b[^>]*\bhref\s*=\s*["']?https?:/i.test(htmlText)) {
    add('warn', 'HTML', 'html.externalTag', 'HTML 里有外链的 <script src> 或 <link>：沙箱的 CSP 会挡住它们，加载不到。', '脚本贴进 JS 那一栏；样式贴进 CSS 那一栏。');
  }

  // 模板占位符没填
  const placeholder = /(\{\{[^{}]{1,40}\}\})/.exec(`${htmlText}\n${cssText}\n${code}`);
  if (placeholder) {
    add('info', '通用', 'text.placeholder', `代码里还留着模板占位符 ${placeholder[1]}（如果它是渲染时才替换的就忽略这条）。`, '确认它是"运行时替换"还是"忘了填"。');
  }

  const counts = { error: 0, warn: 0, info: 0 };
  for (const issue of issues) counts[issue.severity] = (counts[issue.severity] ?? 0) + 1;
  issues.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9));

  const summary = !issues.length
    ? '没查出问题：语法能过、沙箱规则不犯、桥能力也对得上。'
    : `查出 ${counts.error} 处会直接报错的问题、${counts.warn} 处要留心的地方、${counts.info} 条提示。`
      + (counts.error ? '先把"会报错"那几条清掉，代码基本就能跑了。' : '');

  return { ok: counts.error === 0, counts, issues, summary };
}
