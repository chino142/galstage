/**
 * 把一个闭源 AIrp 平台导出的「作品 JSON」翻译成我们的角色卡。
 *
 * 那个平台的字段名是缩写，先在这里对齐一遍（对着真实导出件核过）：
 *
 *   app_name            作品名称                  → name
 *   desc                详细介绍（**前端代码**）   → 卡内前端 html / js（拆 <style>/<script>）
 *   builtInCss          全局 CSS                  → 卡内前端 css
 *   prpt                提示词                    → system_prompt
 *   prefix_txt          前置词（拼在用户输入前）    → prefix_text
 *   suffix_txt          后置词（拼在用户输入后）    → suffix_text
 *   world_bk            世界书                    → character_book
 *   opening_statement   开场白                    → first_mes
 *   lbls / locale       标签 / 语言                → tags
 *   cover               封面（外链）               → 不导（我们的头像是字节，不是 URL）
 *
 * 两个要注意的地方：
 *   1. 那个平台**没有"给 AI 看的简介"**——世界观、人设、回复示例全在 prpt 里。
 *      所以这张卡的 description 留空是有意的，别把前端代码当简介塞进去。
 *   2. 它的世界书用两个位掩码（key_region / value_region）表达"扫谁"和"注入到哪个插槽"，
 *      我们这边没有对应字段，只能按默认处理并**如实报出来**，不假装支持。
 *
 * 纯逻辑，不碰数据库、不发请求，能直接拿真卡单测。
 */

import { SELECTIVE_LOGIC } from '../worldbook/shapes.mjs';

/** 平台字段 → 我们的字段，给报告和文档用。 */
export const PLATFORM_FIELD_MAP = {
  app_name: 'name',
  desc: '卡内前端 html / js',
  builtInCss: '卡内前端 css',
  prpt: 'system_prompt',
  prefix_txt: 'prefix_text',
  suffix_txt: 'suffix_text',
  world_bk: 'character_book',
  opening_statement: 'first_mes',
  lbls: 'tags',
  cover: '（不导：头像是字节，不是 URL）',
  re_replaces: '（暂不导：正则脚本）',
  ban_wd: '（暂不导：屏蔽词）',
  short_cmds: '（暂不导：快捷指令）',
  suggested_questions: '卡扩展 · 推荐问题',
  ai_variable_text: '（暂不导：变量面板，我们有世界状态 + 卡内前端）',
  ai_variable_tmpl: '（暂不导）',
  ai_variable_json: '（暂不导）',
  bgm: '卡扩展 · BGM 列表',
  def_msg_cnt: '卡扩展 · 默认消息数',
};

/** 平台上那几个「选一段开场白」之类的占位文案，别当成真开场白导进来。 */
const PLACEHOLDER_GREETINGS = ['选择一段开场白', '请选择开场白'];

const KEY_PREFIX = /^_(or|and)_/;
const KEY_SEPARATOR = '@wb@';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 从提示词里抽一句能当"简介"的话。
 *
 * 那个平台没有"给 AI 看的简介"字段，人设 / 世界观全在 prpt 里。这里按约定俗成的结构抽：
 * 优先找 `## 简介` / `## 作品设定` / `## 人物设定` 这类标题，取它下面第一段自然语言；
 * 找不到就退回 prpt 开头，跳过协议说明、标签、模板占位，拼出一句话。
 */
export function extractDescription(prpt) {
  const lines = String(prpt ?? '').split(/\r?\n/);
  const headingRe = /^#{1,4}\s*(简介|角色简介|作品简介|作品设定|人物设定|人设|角色设定|世界观|故事背景|背景设定)/;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i].trim())) {
      start = i;
      break;
    }
  }
  const begin = start >= 0 ? start + 1 : 0;
  for (let i = begin; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || /^#/.test(raw) || /^\{\{/.test(raw) || /^[<[]/.test(raw)) continue;
    const cleaned = raw
      .replace(/^\*\*[^*]+\*\*[:：]?\s*/, '')
      .replace(/^[-*]\s*/, '')
      .replace(/\*\*/g, '')
      .replace(/`/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned || cleaned.startsWith('<') || cleaned.startsWith('[') || cleaned.startsWith('{{')) continue;
    return cleaned.slice(0, 300);
  }
  return '';
}

/**
 * 一整份 HTML 文档拆成三段。
 * 为什么要拆：我们的卡内前端是 html / css / js 三格，而且 HTML 段里禁止 `<script>`
 * （内联脚本会绕过 JS 段的静态检查），不拆的话贴进去既不跑也过不了检查。
 */
export function splitFrontendDocument(source) {
  let html = String(source ?? '');
  const styles = [];
  const scripts = [];
  html = html.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_, body) => {
    styles.push(body);
    return '';
  });
  html = html.replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, (_, body) => {
    scripts.push(body);
    return '';
  });
  return { html: html.trim(), css: styles.join('\n').trim(), js: scripts.join('\n').trim() };
}

/** 条目没有标题字段，用内容第一行当标题（真实导出件都是 `# 【智乃】` 这种）。 */
function titleFromContent(content) {
  const line = String(content ?? '').split('\n').map((item) => item.trim()).find(Boolean) ?? '';
  return line.replace(/^#+\s*/, '').replace(/^[【\[［]|[】\]］]$/g, '').trim().slice(0, 60);
}

/**
 * 平台的 `key` 字段是拼出来的：`_or_智乃`、`_or_a@wb@b@wb@c`。
 * `match_type`：1 = 与，2 = 或（对着界面上的"与/或"单选核过）。
 */
export function parsePlatformKeys(rawKey, matchType) {
  const raw = String(rawKey ?? '');
  const prefix = KEY_PREFIX.exec(raw);
  const body = prefix ? raw.slice(prefix[0].length) : raw;
  const keys = body.split(KEY_SEPARATOR).map((item) => item.trim()).filter(Boolean);
  const mode = prefix?.[1] ?? (Number(matchType) === 1 ? 'and' : 'or');
  return {
    keys,
    selectiveLogic: mode === 'and' ? SELECTIVE_LOGIC.AND_ALL : SELECTIVE_LOGIC.AND_ANY,
  };
}

/**
 * 世界书一条 → 我们的一条。
 * @returns {{entry: object, notes: string[]}}
 */
export function mapPlatformWorldbookEntry(raw, index) {
  const notes = [];
  const content = text(raw?.value);
  const title = titleFromContent(content) || `条目 ${index + 1}`;
  const { keys, selectiveLogic } = parsePlatformKeys(raw?.key, raw?.match_type);
  const scanDepth = Number(raw?.depth ?? 0);
  const probability = Number(raw?.probability ?? 100);

  // 这两个位掩码我们表达不了，如实说出来，不装作支持。
  const keyRegion = Number(raw?.key_region ?? 6);
  if (keyRegion !== 6) {
    notes.push(`「${title}」原本只扫${keyRegion === 4 ? ' AI 输出' : '用户输入'}，我们这边两边都会扫`);
  }
  const valueRegion = Number(raw?.value_region ?? 1);
  if (valueRegion !== 1) {
    notes.push(`「${title}」原本注入到前置词 / 后置词，我们按普通世界书插入`);
  }
  if (!keys.length) notes.push(`「${title}」没有触发词，在我们这边永远不会激活`);

  return {
    entry: {
      uid: index,
      comment: title,
      content,
      keys,
      secondaryKeys: [],
      enabled: raw?.enable !== false,
      constant: false,
      selectiveLogic,
      // 平台的 sort 就是插入顺序；它的 depth 是"扫描深度"，对应我们的 scanDepth（不是注入深度）
      order: Number(raw?.sort ?? 0) || 0,
      scanDepth: Number.isFinite(scanDepth) && scanDepth > 0 ? scanDepth : null,
      probability: Number.isFinite(probability) && probability > 0 ? probability : 100,
      useProbability: true,
      group: text(raw?.group),
    },
    notes,
  };
}

/**
 * 主入口：作品 JSON → 我们的卡 + 卡内前端 + 报告。
 *
 * @param {object} doc 平台导出的作品对象
 * @param {{name?: string}} [options] name 可以覆盖作品名
 * @returns {{card: object, frontend: object, cover: string, report: object}}
 */
export function platformCardFromExport(doc, { name = '' } = {}) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('作品数据必须是一个对象');
  }

  const appName = text(name) || text(doc.app_name) || '未命名作品';
  const frontendParts = splitFrontendDocument(doc.desc);
  const builtInCss = text(doc.builtInCss);
  const frontend = {
    html: frontendParts.html,
    css: [frontendParts.css, builtInCss].filter(Boolean).join('\n\n'),
    js: frontendParts.js,
    capabilities: [],
  };

  const warnings = [];
  const lore = Array.isArray(doc.world_bk) ? doc.world_bk : [];
  const entries = [];
  const entryNotes = [];
  for (let index = 0; index < lore.length; index++) {
    const mapped = mapPlatformWorldbookEntry(lore[index], index);
    entries.push(mapped.entry);
    for (const note of mapped.notes) entryNotes.push(note);
  }

  const opening = text(doc.opening_statement);
  const firstMes = opening && !PLACEHOLDER_GREETINGS.includes(opening) ? opening : '';
  if (opening && !firstMes) warnings.push(`开场白是占位文案「${opening}」，没有导入`);

  const prompt = text(doc.prpt);
  if (!prompt) warnings.push('这份作品里没有提示词（prpt 是空的）');

  const description = extractDescription(doc.prpt);

  const tags = [];
  if (Array.isArray(doc.lbls)) for (const item of doc.lbls) if (text(item)) tags.push(text(item));
  const locale = text(doc.locale);

  const card = {
    name: appName,
    // 平台没有"给 AI 看的简介"字段，所以从 prpt 里抽一句；抽不到就留空。
    description,
    personality: '',
    scenario: '',
    first_mes: firstMes,
    mes_example: '',
    creator_notes: `从「${appName}」的平台作品导入。设定在系统提示（提示词）里，界面代码在卡内前端。`,
    system_prompt: prompt,
    post_history_instructions: '',
    prefix_text: text(doc.prefix_txt),
    suffix_text: text(doc.suffix_txt),
    alternate_greetings: [],
    tags: locale ? [...tags, locale] : tags,
    character_book: entries.length ? { name: `${appName} 的世界书`, entries } : null,
    extensions: {},
  };

  // 封面：那个平台给的是一个网址（`https://…/cover…`），带出去让接口那边去抓。
  // 抓回来的图有两种落法（见 server/api/characters.mjs）：PNG 直接当卡头像，
  // 其它格式进素材库、卡片数据里记一个 cover，列表照样显示。
  const cover = text(doc.cover);
  // 卡自己的背景（横幅）：很多作品会写一张横图当会话背景
  const backgroundImage = text(doc.bg_image) || text(doc.bg_m);

  // 平台专属字段搬进卡扩展，跟着卡走（导出 PNG / JSON 原样带走），不另加表。
  const platform = {
    bgm: {
      tracks: Array.isArray(doc.bgm?.tracks) ? doc.bgm.tracks.map((item) => ({ ...(item && typeof item === 'object' ? item : {}) })) : [],
      autoplay: Boolean(doc.bgm?.autoplay),
    },
    suggestedQuestions: Array.isArray(doc.suggested_questions) ? doc.suggested_questions.map(String) : [],
    defMsgCount: Number.isFinite(Number(doc.def_msg_cnt)) ? Number(doc.def_msg_cnt) : 0,
  };

  // 没导成的东西要摊开说，别让用户以为全搬过来了
  const notImported = [];
  if (Array.isArray(doc.re_replaces) && doc.re_replaces.length) notImported.push(`正则替换（${doc.re_replaces.length} 条）`);
  if (Array.isArray(doc.ban_wd) && doc.ban_wd.length) notImported.push(`屏蔽词（${doc.ban_wd.length} 条）`);
  if (Array.isArray(doc.short_cmds) && doc.short_cmds.length) notImported.push(`快捷指令（${doc.short_cmds.length} 条）`);
  if (text(doc.ai_variable_text) || text(doc.ai_variable_tmpl) || text(doc.ai_variable_json)) notImported.push('变量面板');

  // 已经搬进卡扩展的，单独列一份让报告看得见（不再算"没导过来"）。
  const preserved = [];
  if (platform.bgm.tracks.length) preserved.push(`BGM（${platform.bgm.tracks.length} 首，存进卡扩展）`);
  if (platform.suggestedQuestions.length) preserved.push(`推荐问题（${platform.suggestedQuestions.length} 条，存进卡扩展）`);
  if (platform.defMsgCount) preserved.push(`默认消息数（${platform.defMsgCount}，存进卡扩展）`);

  const externalUrls = new Set([
    ...(String(doc.desc ?? '').match(/https?:\/\/[^\s'"()<>\\`]+/g) ?? []),
    ...(builtInCss.match(/https?:\/\/[^\s'"()<>\\`]+/g) ?? []),
  ]);

  return {
    card,
    frontend,
    cover,
    backgroundImage,
    platform,
    report: {
      name: appName,
      promptChars: prompt.length,
      descriptionChars: description.length,
      frontend: {
        html: frontend.html.length,
        css: frontend.css.length,
        js: frontend.js.length,
        externalUrls: externalUrls.size,
      },
      worldbook: { total: entries.length, notes: entryNotes },
      firstMes: Boolean(firstMes),
      prefix: card.prefix_text.length,
      suffix: card.suffix_text.length,
      notImported,
      preserved,
      warnings,
      fieldMap: PLATFORM_FIELD_MAP,
    },
  };
}
