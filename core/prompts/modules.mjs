/**
 * 模块（Mod）的模型与落地计划。
 *
 * 一个模块能带七样东西，**各自落到确定的位置**：
 *   · 提示词   → 按 position 插进提示词（系统提示里 / 用户输入前后 / 历史之后）
 *   · CSS      → 只带 CSS 的模块，样式直接注入聊天页（别人的自动收进消息区）
 *   · HTML+JS  → 带这两样的模块，整块渲染进**沙箱 iframe**（跟卡内前端同一套机制）
 *   · 世界书条目 → 跟着这一轮的对话一起参与触发（和后端世界书同一套匹配 / 试触发）
 *   · 正则脚本 → 并进这一轮的正则链（发送前改输入 / 收到后改输出）
 *   · 背景图   → 从素材库里挑一张，聊天页铺在后面
 *
 * 为什么 HTML/JS 一定要进沙箱：模块可能来自别人。主页面里跑的脚本能读聊天记录、
 * 能拿会话调我们的接口、能往外发请求；沙箱 iframe 是不透明源 + 锁死 CSP + 能力白名单，
 * 这几条路全堵上。**自己的模块也一样进沙箱**——跟卡内前端的规矩保持一致，
 * 只是不用你点信任、也不拦静态检查。
 */

import { createHash } from 'node:crypto';
import { MODULE_POSITIONS, MODULE_POSITION_IDS, MODULE_SCOPE, lintModuleCss, scopeCss } from './module-css.mjs';

export { MODULE_POSITIONS, MODULE_POSITION_IDS, MODULE_SCOPE };

/** 代码指纹：改了任何一个字，信任就失效。跟卡内前端同一个思路。 */
export function moduleCodeHash(module = {}) {
  return createHash('sha256')
    .update(`${String(module.html ?? '')}\u0000${String(module.css ?? '')}\u0000${String(module.js ?? '')}`)
    .digest('hex')
    .slice(0, 32);
}

/** 归一化：把任意来源的模块收拾成统一形状（界面、导入、数据库都走这里）。 */
export function normalizeModule(input = {}) {
  const position = MODULE_POSITION_IDS.includes(String(input.position)) ? String(input.position) : 'after-history';
  // 世界书条目：只要求是一个对象数组，字段交给世界书引擎自己的 normalize 收拾
  const worldbook = Array.isArray(input.worldbook)
    ? input.worldbook.filter((entry) => entry && typeof entry === 'object')
    : [];
  return {
    id: input.id ?? null,
    title: String(input.title ?? '').trim() || '未命名模块',
    description: String(input.description ?? '').trim(),
    body: String(input.body ?? ''),
    css: String(input.css ?? ''),
    html: String(input.html ?? ''),
    js: String(input.js ?? ''),
    worldbook,
    // 用户粘贴的"一行语法"原文留着，下次编辑还能看到自己写的东西
    worldbookText: String(input.worldbookText ?? ''),
    regex: Array.isArray(input.regex) ? input.regex.filter((script) => script && typeof script === 'object') : [],
    background: String(input.background ?? '').trim(),
    capabilities: Array.isArray(input.capabilities) ? input.capabilities.map(String) : [],
    position,
    source: String(input.source ?? 'original') === 'imported' ? 'imported' : 'original',
  };
}

/**
 * 这个模块按哪一档跑。
 *   own    = 自己写的 → CSS 不限作用域、不用信任、不拦检查
 *   strict = 别人的   → CSS 收进消息区、跑之前要信任（信任绑代码哈希）
 */
export function moduleTier(module, trust = null) {
  const codeHash = moduleCodeHash(module);
  const own = String(module.source ?? 'original') !== 'imported';
  const trustedByUser = Boolean(trust && codeHash && trust.codeHash === codeHash);
  const trusted = own || trustedByUser;
  return {
    tier: own ? 'own' : 'strict',
    title: own ? '自己写的' : '别人的',
    trusted,
    trustedByUser,
    needsTrust: !trusted,
    codeHash,
    canStyleWholePage: trusted,
    reason: own ? '本机新建的模块' : trustedByUser ? '你信任过这段代码（哈希对得上）' : '别人的模块：样式只作用在消息区，脚本要信任才跑',
  };
}

/**
 * 把挂着的一批模块算成"这一轮怎么用"。
 *
 * @param {Array} modules 已经挂着、且启用着的模块（归一化过的）
 * @param {{trustOf?: (id: string) => object|null}} [options]
 * @returns {{promptByPosition: object, pageCss: string, panels: Array, items: Array,
 *            embedBooks: Array, regexScripts: Array, backgrounds: Array, notes: string[]}}
 */
export function modulePlan(modules = [], { trustOf = () => null } = {}) {
  const promptByPosition = Object.fromEntries(MODULE_POSITION_IDS.map((id) => [id, []]));
  const notes = [];
  const pageCss = [];
  const panels = [];
  const items = [];
  const embedBooks = [];
  const regexScripts = [];
  const backgrounds = [];

  for (const raw of Array.isArray(modules) ? modules : []) {
    const module = normalizeModule(raw);
    const tier = moduleTier(module, trustOf(module.id));
    items.push({ id: module.id, title: module.title, position: module.position, tier });

    // ---- 世界书条目：当成一本"卡内世界书"跟着这一轮一起触发 ----
    if (module.worldbook.length) {
      embedBooks.push({ name: `模块：${module.title}`, entries: module.worldbook });
      notes.push(`模块「${module.title}」带了 ${module.worldbook.length} 条世界书条目`);
    }

    // ---- 正则脚本：并进这一轮的正则链。别人的模块要信任过才放行（正则能挂在每一轮上）----
    if (module.regex.length) {
      if (tier.trusted) {
        regexScripts.push(...module.regex);
        notes.push(`模块「${module.title}」的 ${module.regex.length} 条正则脚本已并进这一轮`);
      } else {
        notes.push(`模块「${module.title}」带了 ${module.regex.length} 条正则脚本，但它是别人的模块：信任之后才会跑`);
      }
    }

    // ---- 背景图：素材库里的图，铺在聊天页后面 ----
    if (module.background) {
      backgrounds.push({ id: module.id, title: module.title, assetId: module.background });
    }

    if (module.body.trim()) {
      promptByPosition[module.position].push({ id: module.id, title: module.title, body: module.body });
    }

    const hasPanel = Boolean(module.html.trim() || module.js.trim());
    if (hasPanel) {
      // HTML / JS 走沙箱：CSS 也跟着进 iframe，不然它只能改到外面、里头反而没样式
      panels.push({
        id: module.id,
        title: module.title,
        html: module.html,
        css: module.css,
        js: module.js,
        capabilities: module.capabilities,
        tier,
      });
      continue;
    }

    const css = module.css.trim();
    if (!css) continue;
    const check = lintModuleCss(css, { trusted: tier.trusted });
    const blocked = check.issues.filter((issue) => issue.severity === 'error');
    if (blocked.length) {
      notes.push(`模块「${module.title}」的样式被拦下了：${blocked.map((issue) => issue.message).join('；')}`);
      continue;
    }
    pageCss.push(tier.canStyleWholePage ? css : scopeCss(css));
    if (!tier.canStyleWholePage) notes.push(`模块「${module.title}」是别人的代码，样式只作用在消息区`);
  }

  if (backgrounds.length > 1) notes.push(`有 ${backgrounds.length} 个模块都设了背景图，用最后挂上的那个「${backgrounds.at(-1).title}」`);

  return { promptByPosition, pageCss: pageCss.join('\n\n'), panels, items, embedBooks, regexScripts, backgrounds, notes };
}
