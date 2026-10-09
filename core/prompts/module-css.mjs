/**
 * 模块（Mod）的样式部分：**别人的代码只许动消息区，自己的代码不限制**。
 *
 * 为什么要有这一层：模块能带一段 CSS 来美化界面（这是那套玩法的核心之一——
 * "卡是骨架、功能靠模块补"）。但模块可能来自别人。CSS 虽然不能执行脚本，
 * 照样能干两件坏事：
 *   1. `position: fixed` 铺一个透明层盖住整个界面，做成钓鱼；
 *   2. 用 `url(http…)` 把请求发到站外（`input[value^="a"]{background:url(…)}`
 *      这种"逐字符探测"是老套路）。
 *
 * 所以分两档：
 *   · 自己写的 / 你点过信任的 → 原样注入，想改整个聊天页随你；
 *   · 别人的（未信任）        → **自动作用域化**：`.summary{…}` 改写成
 *     `.st-mod-scope .summary{…}`，只能作用在消息区里；再禁掉上面那三样。
 *     作者写法不用改，是我们在注入前加工的。
 *
 * 纯逻辑，不碰 DOM 也不碰数据库，能直接单测。
 */

/** 模块提示词能插的位置。后两个复用前置词 / 后置词那一套。 */
export const MODULE_POSITIONS = [
  { id: 'system', title: '系统提示里', summary: '当作设定的一部分，跟着角色描述走' },
  { id: 'before-user', title: '用户输入之前', summary: '贴在我这句话前面，当"本轮即时要求"' },
  { id: 'after-user', title: '用户输入之后', summary: '贴在我这句话后面，收尾指令用这个' },
  { id: 'after-history', title: '历史之后', summary: '作为最后一条系统消息发出' },
];

export const MODULE_POSITION_IDS = MODULE_POSITIONS.map((item) => item.id);

/** 别人的模块只能碰这个容器里的东西。 */
export const MODULE_SCOPE = '.st-mod-scope';

const AT_RULES_WITH_RULES = new Set(['media', 'supports', 'container', 'layer', 'scope']);

/** 只保留字符串之外、且是我们主动加工时才去掉的东西：注释。注释里出现 `{` 会把解析带偏。 */
function stripComments(css) {
  return String(css ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * 给一条选择器加作用域前缀。
 * `:root` / `html` / `body` 这几个"表示整页"的写法映射成作用域容器本身，
 * 否则会拼出 `:root .st-mod-scope` 这种永远匹配不到的东西。
 */
function scopeSelector(selector, scope) {
  const s = selector.trim();
  if (!s) return '';
  if (s === ':root' || s === 'html' || s === 'body') return scope;
  if (/^:root\b/.test(s)) return `${scope}${s.slice(':root'.length)}`;
  if (/^html\b/.test(s)) return `${scope}${s.slice(4)}`;
  if (/^body\b/.test(s)) return `${scope}${s.slice(4)}`;
  if (s === '*') return `${scope} *`;
  return `${scope} ${s}`;
}

/**
 * 把一整段 CSS 的作用域收进 `scope` 里。
 * 支持 `@media` / `@supports` / `@container` / `@layer` 嵌套；
 * `@font-face`、`@keyframes` 这类没有选择器的原样保留。
 */
export function scopeCss(css, scope = MODULE_SCOPE) {
  const source = stripComments(css);
  const out = [];
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf('{', cursor);
    if (open < 0) {
      const tail = source.slice(cursor).trim();
      if (tail) out.push(tail);
      break;
    }
    const prelude = source.slice(cursor, open).trim();
    let depth = 1;
    let index = open + 1;
    while (index < source.length && depth > 0) {
      if (source[index] === '{') depth++;
      else if (source[index] === '}') depth--;
      index++;
    }
    const body = source.slice(open + 1, index - 1);
    const at = /^@([a-z-]+)/i.exec(prelude);
    if (at && AT_RULES_WITH_RULES.has(at[1].toLowerCase())) {
      out.push(`${prelude}{${scopeCss(body, scope)}}`);
    } else if (at) {
      // @font-face / @keyframes / @property：没有选择器可加前缀，原样保留
      out.push(`${prelude}{${body}}`);
    } else {
      const selectors = prelude
        .split(',')
        .map((item) => scopeSelector(item, scope))
        .filter(Boolean)
        .join(', ');
      out.push(`${selectors}{${body}}`);
    }
    cursor = index;
  }
  return out.join('\n');
}

/**
 * 检查一段模块 CSS。
 * @param {string} css
 * @param {{trusted?: boolean}} [options] trusted = 自己的 / 点过信任的
 * @returns {{ok: boolean, issues: Array<{rule: string, severity: string, message: string}>}}
 */
export function lintModuleCss(css, { trusted = false } = {}) {
  const source = stripComments(css);
  const issues = [];
  const push = (rule, severity, message) => issues.push({ rule, severity, message });

  if (/@import\b/i.test(source)) {
    push('css.import', trusted ? 'warn' : 'error', trusted ? '@import 外部样式表：能用，但图床/字体站挂了就会掉样式' : '别人的模块不许 @import 外部样式表');
  }
  const external = /url\s*\(\s*['"]?https?:/i.test(source);
  if (external) {
    push('css.externalUrl', trusted ? 'warn' : 'error', trusted ? '样式里有外链资源（图片/字体），能用但要联网' : '别人的模块不许引用站外资源（会泄露你的 IP 和访问行为）');
  }
  if (/position\s*:\s*fixed/i.test(source)) {
    push('css.fixed', trusted ? 'info' : 'error', trusted ? '用了 position:fixed：能盖住整个界面，确认是你自己写的没关系' : '别人的模块不许用 position:fixed（可以铺一层透明遮罩冒充界面）');
  }

  const errors = issues.filter((issue) => issue.severity === 'error');
  return { ok: errors.length === 0, issues };
}

/**
 * 把所有挂着的模块合成一份 CSS。
 * @param {Array<{id: string, title?: string, css?: string}>} modules
 * @param {(id: string) => boolean} isTrusted
 * @returns {{css: string, notes: string[]}}
 */
export function moduleStyleFor(modules = [], isTrusted = () => false) {
  const chunks = [];
  const notes = [];
  for (const module of Array.isArray(modules) ? modules : []) {
    const css = String(module?.css ?? '').trim();
    if (!css) continue;
    const trusted = Boolean(isTrusted(module.id));
    const check = lintModuleCss(css, { trusted });
    const blocked = check.issues.filter((issue) => issue.severity === 'error');
    if (blocked.length) {
      notes.push(`模块「${module.title ?? module.id}」的样式被拦下了：${blocked.map((issue) => issue.message).join('；')}`);
      continue;
    }
    if (trusted) {
      chunks.push(`/* 模块：${module.title ?? module.id}（你自己的，作用域不限制） */\n${css}`);
    } else {
      chunks.push(`/* 模块：${module.title ?? module.id}（别人的，已收进消息区） */\n${scopeCss(css)}`);
      notes.push(`模块「${module.title ?? module.id}」是别人的代码，样式只作用在消息区`);
    }
  }
  return { css: chunks.join('\n\n'), notes };
}
