/**
 * 正则脚本：忠实移植 SillyTavern 的正则扩展引擎。
 *
 * 来源：`release` 分支 `public/scripts/extensions/regex/engine.js`、
 * `.../regex/index.js` 的字段表，以及 `public/scripts/utils.js` 的 `regexFromString`。
 *
 * 容易写错、这里特意保留的行为：
 *   - `regexFromString` 用反向引用的分隔符匹配，`/pattern/flags` 与裸 `pattern` 都收；
 *     flags 非法时退化成 `new RegExp(input)`
 *   - 替换串里的 `{{match}}` 变成 `$0`，再由捕获组那一步解析成整个匹配
 *   - `substituteRegex.ESCAPED` 会先展开宏再转义，角色名里带 `.` `(` 也能当字面量匹配
 *   - markdownOnly / promptOnly 决定脚本是给"显示"还是给"发出去的提示词"用
 */

export const SCRIPT_TYPES = { GLOBAL: 0, SCOPED: 1, PRESET: 2 };
export const SCRIPT_TYPE_UNKNOWN = -1;

/** 脚本作用的位置（与酒馆的 regex_placement 一致）。 */
export const regex_placement = {
  MD_DISPLAY: 0,
  USER_INPUT: 1,
  AI_OUTPUT: 2,
  SLASH_COMMAND: 3,
  WORLD_INFO: 5,
  REASONING: 6,
};

export const PLACEMENT_OPTIONS = [
  { value: regex_placement.USER_INPUT, label: '用户输入（发送前）' },
  { value: regex_placement.AI_OUTPUT, label: 'AI 输出（收到后）' },
  { value: regex_placement.WORLD_INFO, label: '世界书条目' },
  { value: regex_placement.REASONING, label: '推理内容' },
  { value: regex_placement.MD_DISPLAY, label: '只改显示（已弃用）' },
  { value: regex_placement.SLASH_COMMAND, label: '斜杠命令' },
];

export const substitute_find_regex = { NONE: 0, RAW: 1, ESCAPED: 2 };

/** 逐字对齐 `public/scripts/utils.js` 的 regexFromString。 */
export function regexFromString(input) {
  try {
    const m = String(input).match(/(\/?)(.+)\1([a-z]*)/i);
    if (!m) return undefined;
    if (m[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(m[3])) return new RegExp(input);
    return new RegExp(m[2], m[3]);
  } catch {
    return undefined;
  }
}

/** 编译缓存（LRU），对应酒馆的 RegexProvider。 */
export class RegexProvider {
  #cache = new Map();
  #maxSize = 1000;
  static instance = new RegexProvider();

  get(regexString) {
    const cached = this.#cache.has(regexString);
    const regex = cached ? this.#cache.get(regexString) : regexFromString(regexString);
    if (!regex) return null;
    if (cached) {
      this.#cache.delete(regexString);
    } else if (this.#cache.size >= this.#maxSize) {
      this.#cache.delete(this.#cache.keys().next().value);
    }
    this.#cache.set(regexString, regex);
    if (regex.global || regex.sticky) regex.lastIndex = 0;
    return regex;
  }

  clear() {
    this.#cache.clear();
  }
}

/** 转义成可以安全塞进正则的宏值。 */
export function sanitizeRegexMacro(x) {
  return typeof x === 'string'
    ? x.replace(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/g, (s) => {
        switch (s) {
          case '\n': return '\\n';
          case '\r': return '\\r';
          case '\t': return '\\t';
          case '\v': return '\\v';
          case '\f': return '\\f';
          case '\0': return '\\0';
          default: return `\\${s}`;
        }
      })
    : x;
}

/** 从卡 / 预设的 extensions.regex_scripts 里取脚本。 */
export function scriptsFromExtensions(container) {
  const scripts = container?.extensions?.regex_scripts ?? container?.regex_scripts;
  return Array.isArray(scripts) ? scripts.filter(Boolean) : [];
}

/** 归一化一个脚本，补齐酒馆编辑器会写的默认值。 */
export function normalizeScript(script, index = 0) {
  const placement = Array.isArray(script?.placement)
    ? script.placement.map(Number).filter((n) => Number.isFinite(n))
    : script?.placement === undefined || script?.placement === null
      ? []
      : [Number(script.placement)].filter((n) => Number.isFinite(n));
  const depth = (value) => (value === undefined || value === null || Number.isNaN(Number(value)) ? null : Number(value));
  return {
    id: script?.id ?? `script-${index}`,
    scriptName: String(script?.scriptName ?? script?.name ?? `脚本 ${index + 1}`),
    findRegex: String(script?.findRegex ?? ''),
    replaceString: String(script?.replaceString ?? ''),
    trimStrings: Array.isArray(script?.trimStrings) ? script.trimStrings.map(String) : [],
    placement,
    disabled: Boolean(script?.disabled),
    markdownOnly: Boolean(script?.markdownOnly),
    promptOnly: Boolean(script?.promptOnly),
    runOnEdit: Boolean(script?.runOnEdit),
    substituteRegex: Number(script?.substituteRegex ?? substitute_find_regex.NONE),
    minDepth: depth(script?.minDepth),
    maxDepth: depth(script?.maxDepth),
  };
}

function filterString(rawString, trimStrings, { substitute, characterOverride } = {}) {
  let finalString = rawString;
  for (const trimString of trimStrings ?? []) {
    const subTrimString = substitute(trimString, { name2Override: characterOverride });
    finalString = finalString.replaceAll(subTrimString, '');
  }
  return finalString;
}

/** 跑单个脚本，对应 runRegexScript。 */
export function runRegexScript(script, rawString, { substitute = (t) => t, substituteExtended, characterOverride } = {}) {
  let newString = rawString;
  if (!script || script.disabled || !script.findRegex || !rawString) return newString;

  const getRegexString = () => {
    switch (Number(script.substituteRegex)) {
      case substitute_find_regex.RAW:
        return substituteExtended ? substituteExtended(script.findRegex, {}, (v) => v) : substitute(script.findRegex);
      case substitute_find_regex.ESCAPED:
        return substituteExtended ? substituteExtended(script.findRegex, {}, sanitizeRegexMacro) : substitute(script.findRegex);
      default:
        return script.findRegex;
    }
  };

  const findRegex = RegexProvider.instance.get(getRegexString());
  if (!findRegex) return newString;

  newString = rawString.replace(findRegex, (...args) => {
    let match = args[0];
    const replaceString = String(script.replaceString).replace(/{{match}}/gi, '$0');
    const replaceWithGroups = replaceString.replaceAll(/\$(\d+)|\$<([^>]+)>/g, (_, num, groupName) => {
      if (num) match = args[Number(num)];
      else if (groupName) {
        const groups = args[args.length - 1];
        match = groups && typeof groups === 'object' ? groups[groupName] : undefined;
      }
      if (!match) return '';
      return filterString(match, script.trimStrings, { substitute, characterOverride });
    });
    return substitute(replaceWithGroups);
  });

  return newString;
}

/**
 * 按位置与 markdown/prompt 模式应用脚本，对应 getRegexedString。
 * depth 是这条消息离最新一条有多远（用于 minDepth/maxDepth）。
 */
export function getRegexedString(rawString, placement, { scripts = [], substitute = (t) => t, substituteExtended, characterOverride, isMarkdown, isPrompt, isEdit, depth } = {}) {
  if (typeof rawString !== 'string') return '';
  let finalString = rawString;
  if (!rawString || placement === undefined) return finalString;

  for (const script of scripts) {
    // 有意偏离酒馆：酒馆里"markdownOnly / promptOnly 都不勾"的脚本既不作用于显示、
    // 也不作用于提示词（它只改消息的原始内容）。蓝图 1.4 要的是"发送前改写"，
    // 所以这里把这种脚本当成作用于"发出去的提示词"。
    const applies =
      (script.markdownOnly && isMarkdown) ||
      (script.promptOnly && isPrompt) ||
      (!script.markdownOnly && !script.promptOnly && (isPrompt || !isMarkdown));
    if (!applies) continue;
    if (isEdit && !script.runOnEdit) continue;
    if (typeof depth === 'number') {
      if (script.minDepth !== null && script.minDepth >= -1 && depth < script.minDepth) continue;
      if (script.maxDepth !== null && script.maxDepth >= 0 && depth > script.maxDepth) continue;
    }
    if (script.placement.includes(placement)) {
      finalString = runRegexScript(script, finalString, { substitute, substituteExtended, characterOverride });
    }
  }
  return finalString;
}

/** 按 全局 → 角色 → 预设 的优先级收集脚本（高优先级的先跑）。 */
export function collectScripts({ global = [], character = null, preset = null } = {}) {
  const out = [];
  const push = (list) => list.forEach((script) => out.push(normalizeScript(script, out.length)));
  push(global ?? []);
  push(scriptsFromExtensions(character));
  push(scriptsFromExtensions(preset));
  return out;
}
