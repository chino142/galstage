/**
 * 世界书的「一行语法」：把一条条目写成一行标题，批量粘贴就能建条目。
 *
 * 形状借自社区写卡方法论里的 world-info 条目头：
 *
 *   ### 条目名 | keys: a, b | constant | order: 250 | depth: 3 | position: before_char
 *            | secondary: c, d | logic: and_any | prob: 25 | sticky: 2 | cooldown: 6
 *            | recursion: prevent | group: 组名 | weight: 150 | trigger: continue
 *
 * 两个贴心设计（都是从那份方法论里搬来的）：
 *   - **缺省 keys 即视为常开**：不写 keys 的条目自动 constant，避免产出永远不触发的死条目。
 *   - **一键从正文反推**：`toNotation` 能把已有条目写回这一行，方便导出给别人。
 */

import { ValidationError } from '../errors.mjs';
import { POSITION, SELECTIVE_LOGIC } from './engine.mjs';

export const GENERATION_TRIGGERS = ['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet'];

const POSITION_NAMES = {
  before: POSITION.before,
  after: POSITION.after,
  before_an: POSITION.ANTop,
  after_an: POSITION.ANBottom,
  at_depth: POSITION.atDepth,
  em_top: POSITION.EMTop,
  em_bottom: POSITION.EMBottom,
  outlet: POSITION.outlet,
  before_char: POSITION.before,
  after_char: POSITION.after,
};

const LOGIC_NAMES = {
  and_any: SELECTIVE_LOGIC.AND_ANY,
  not_all: SELECTIVE_LOGIC.NOT_ALL,
  not_any: SELECTIVE_LOGIC.NOT_ANY,
  and_all: SELECTIVE_LOGIC.AND_ALL,
};

const POSITION_LABELS = Object.fromEntries(
  Object.entries(POSITION_NAMES).map(([name, value]) => [value, name]),
);
const LOGIC_LABELS = Object.fromEntries(Object.entries(LOGIC_NAMES).map(([name, value]) => [value, name]));

function splitList(value) {
  return String(value ?? '')
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * 解析一行条目头。
 * @param {string} line 例如 `### 老板娘 | keys: 酒馆, 打烊 | order: 250`
 * @returns {{entry:object|null, errors:string[]}}
 */
export function parseNotationLine(line) {
  const text = String(line ?? '').trim();
  if (!text) return { entry: null, errors: [] };
  const stripped = text.replace(/^#{1,6}\s*/, '');
  const [head, ...rest] = stripped.split('|').map((part) => part.trim());
  if (!head) return { entry: null, errors: ['条目名不能为空'] };

  const entry = {
    comment: head,
    content: '',
    keys: [],
    secondaryKeys: [],
    constant: false,
    selective: false,
    selectiveLogic: SELECTIVE_LOGIC.AND_ANY,
    order: 100,
    position: POSITION.before,
    depth: 4,
    probability: 100,
    useProbability: false,
    group: '',
    groupWeight: 100,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    ignoreBudget: false,
    excludeRecursion: false,
    preventRecursion: false,
    vectorized: false,
    role: 'system',
    enabled: true,
    injectionTrigger: [],
  };
  const errors = [];
  let keysDeclared = false;
  let keysValue = '';

  for (const token of rest) {
    if (!token) continue;
    const match = /^([a-zA-Z_]+)\s*[:：]\s*(.*)$/.exec(token);
    if (!match) {
      switch (token.toLowerCase()) {
        case 'constant':
        case '常开':
          entry.constant = true;
          break;
        case 'selective':
          entry.selective = true;
          break;
        case 'vectorized':
        case '向量':
          entry.vectorized = true;
          break;
        case 'disabled':
        case '关闭':
          entry.enabled = false;
          break;
        default:
          errors.push(`看不懂的标记：${token}`);
      }
      continue;
    }
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    switch (key) {
      case 'keys':
      case 'key':
        keysDeclared = true;
        keysValue = value;
        entry.keys = splitList(value);
        break;
      case 'secondary':
      case 'secondary_keys':
        entry.secondaryKeys = splitList(value);
        break;
      case 'logic':
        if (!(value in LOGIC_NAMES)) errors.push(`不认识逻辑：${value}`);
        else entry.selectiveLogic = LOGIC_NAMES[value];
        break;
      case 'order':
      case 'insertion_order': {
        const num = numberOrNull(value);
        if (num === null) errors.push(`order 不是数字：${value}`);
        else entry.order = num;
        break;
      }
      case 'depth': {
        const num = numberOrNull(value);
        if (num === null) errors.push(`depth 不是数字：${value}`);
        else {
          entry.depth = num;
          if (entry.position !== POSITION.atDepth) entry.position = POSITION.atDepth;
        }
        break;
      }
      case 'position':
        if (!(value in POSITION_NAMES)) errors.push(`不认识位置：${value}`);
        else entry.position = POSITION_NAMES[value];
        break;
      case 'prob':
      case 'probability': {
        const num = numberOrNull(value);
        if (num === null) errors.push(`prob 不是数字：${value}`);
        else {
          entry.probability = Math.max(0, Math.min(100, num));
          entry.useProbability = entry.probability < 100;
        }
        break;
      }
      case 'sticky':
      case 'cooldown':
      case 'delay':
      case 'weight':
      case 'group_weight': {
        const num = numberOrNull(value);
        if (num === null) errors.push(`${key} 不是数字：${value}`);
        else if (key === 'weight' || key === 'group_weight') entry.groupWeight = num;
        else entry[key] = num;
        break;
      }
      case 'group':
        entry.group = value;
        break;
      case 'recursion':
        if (value === 'exclude') entry.excludeRecursion = true;
        else if (value === 'prevent') entry.preventRecursion = true;
        else errors.push(`recursion 只认 exclude / prevent，收到 ${value}`);
        break;
      case 'ignore_budget':
        entry.ignoreBudget = value !== 'false';
        break;
      case 'role':
        if (!['system', 'user', 'assistant'].includes(value)) errors.push('role 只认 system / user / assistant');
        else entry.role = value;
        break;
      case 'trigger':
      case 'triggers': {
        const list = splitList(value).map((item) => item.toLowerCase());
        const unknown = list.filter((item) => !GENERATION_TRIGGERS.includes(item));
        if (unknown.length) errors.push(`不认识生成动作：${unknown.join('、')}`);
        entry.injectionTrigger = list.filter((item) => GENERATION_TRIGGERS.includes(item));
        break;
      }
      default:
        errors.push(`不认识的键：${key}`);
    }
  }

  // 缺省 keys = 常开（防死条目）
  if (!keysDeclared || keysValue.trim() === '') entry.constant = true;
  if (entry.secondaryKeys.length) entry.selective = true;
  return { entry, errors };
}

/**
 * 解析一整块文本：`### 条目头` 开头，后面到下一个 `###` 之间是正文。
 * @returns {{entries:Array, errors:Array<{line:number,message:string}>}}
 */
export function parseNotationBlock(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const entries = [];
  const errors = [];
  let current = null;

  const flush = () => {
    if (current) {
      current.entry.content = current.body.join('\n').trim();
      entries.push(current.entry);
    }
    current = null;
  };

  lines.forEach((rawLine, index) => {
    const line = rawLine.trimEnd();
    if (/^\s*#{1,6}\s+\S/.test(line)) {
      flush();
      const { entry, errors: lineErrors } = parseNotationLine(line);
      for (const message of lineErrors) errors.push({ line: index + 1, message });
      current = { entry, body: [] };
      return;
    }
    if (current) current.body.push(line);
    else if (line.trim()) {
      errors.push({ line: index + 1, message: '正文之前先写一行条目头（### 条目名 | keys: …）' });
    }
  });
  flush();
  return { entries, errors };
}

/** 把内部条目写回一行语法（不含正文）。 */
export function toNotation(entry = {}) {
  const parts = [`### ${entry.comment ?? entry.name ?? '未命名'}`];
  const keys = entry.keys ?? [];
  if (entry.constant) parts.push('constant');
  if (keys.length) parts.push(`keys: ${keys.join(', ')}`);
  if (entry.secondaryKeys?.length) {
    parts.push(`secondary: ${entry.secondaryKeys.join(', ')}`);
    const logic = LOGIC_LABELS[entry.selectiveLogic ?? SELECTIVE_LOGIC.AND_ANY];
    if (logic) parts.push(`logic: ${logic}`);
  }
  parts.push(`order: ${entry.order ?? 100}`);
  if (entry.position === POSITION.atDepth) parts.push(`depth: ${entry.depth ?? 4}`);
  else {
    const label = POSITION_LABELS[entry.position ?? POSITION.before];
    if (label) parts.push(`position: ${label}`);
  }
  if (entry.useProbability && Number(entry.probability) < 100) parts.push(`prob: ${entry.probability}`);
  if (Number(entry.sticky) > 0) parts.push(`sticky: ${entry.sticky}`);
  if (Number(entry.cooldown) > 0) parts.push(`cooldown: ${entry.cooldown}`);
  if (Number(entry.delay) > 0) parts.push(`delay: ${entry.delay}`);
  if (entry.group) parts.push(`group: ${entry.group}`, `weight: ${entry.groupWeight ?? 100}`);
  if (entry.excludeRecursion) parts.push('recursion: exclude');
  if (entry.preventRecursion) parts.push('recursion: prevent');
  if (entry.ignoreBudget) parts.push('ignore_budget: true');
  if (entry.injectionTrigger?.length) parts.push(`trigger: ${entry.injectionTrigger.join(', ')}`);
  if (entry.enabled === false) parts.push('disabled');
  return parts.join(' | ');
}

/** 整本书写回一行语法文本。 */
export function toNotationBlock(entries = []) {
  return entries.map((entry) => `${toNotation(entry)}\n${String(entry.content ?? '').trim()}`).join('\n\n');
}

/** 按生成动作过滤条目：没有声明 trigger 的条目在任何动作下都生效。 */
export function filterByGeneration(entries = [], generationType = 'normal') {
  const type = String(generationType ?? 'normal').toLowerCase();
  return entries.filter((entry) => {
    const triggers = entry?.injectionTrigger ?? [];
    if (!Array.isArray(triggers) || triggers.length === 0) return true;
    return triggers.includes(type);
  });
}

// ---------------------------------------------------------------- 递归地图

/**
 * 递归地图：谁触发了谁。
 *
 * 判断依据和引擎一致 —— 一条条目被激活之后，它自己的正文会进入扫描文本；
 * 如果正文里出现了另一条条目的 key，那条就会被连锁激活。这里用同一套
 * 关键词匹配的简化版（大小写不敏感、支持 /正则/ 写法）来画出这些边。
 */
export function buildRecursionMap(entries = []) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  const nodes = list.map((entry, index) => ({
    id: String(entry.uid ?? entry.id ?? index),
    name: String(entry.comment ?? entry.name ?? `条目 ${index + 1}`),
    constant: Boolean(entry.constant),
    keys: Array.isArray(entry.keys) ? entry.keys.map(String) : [],
    enabled: entry.enabled !== false,
  }));
  const edges = [];
  const matchers = list.map((entry, index) =>
    buildMatcher(nodes[index].keys, { caseSensitive: Boolean(entry.caseSensitive), wholeWords: Boolean(entry.matchWholeWords) }),
  );

  list.forEach((entry, from) => {
    const body = String(entry.content ?? '');
    if (!body) return;
    nodes.forEach((node, to) => {
      if (from === to) return;
      if (node.keys.length === 0) return; // 常开条目不靠正文触发
      if (matchers[to].test(body)) {
        edges.push({ from: nodes[from].id, to: node.id, reason: `正文里出现了「${node.keys[0]}」` });
      }
    });
  });

  const adjacency = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) adjacency.get(edge.from)?.push(edge.to);

  const cycles = [];
  const state = new Map();
  const walk = (id, trail) => {
    const current = state.get(id);
    if (current === 'done') return;
    if (current === 'visiting') {
      const start = trail.indexOf(id);
      cycles.push(trail.slice(start).concat(id));
      return;
    }
    state.set(id, 'visiting');
    for (const next of adjacency.get(id) ?? []) walk(next, [...trail, id]);
    state.set(id, 'done');
  };
  for (const node of nodes) walk(node.id, []);

  return {
    nodes,
    edges,
    cycles: cycles.map((cycle) => cycle.map((id) => nodes.find((node) => node.id === id)?.name ?? id)),
    stats: {
      total: nodes.length,
      constant: nodes.filter((node) => node.constant).length,
      orphans: nodes.filter((node) => !node.constant && !edges.some((edge) => edge.to === node.id)).length,
    },
  };
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildMatcher(keys = [], { caseSensitive = false, wholeWords = false } = {}) {
  const regexes = [];
  const plain = [];
  for (const raw of keys) {
    const key = String(raw ?? '').trim();
    if (!key) continue;
    const asRegex = /^\/(.+)\/([a-z]*)$/.exec(key);
    if (asRegex) {
      try {
        regexes.push(new RegExp(asRegex[1], asRegex[2].replace('g', '') || (caseSensitive ? '' : 'i')));
      } catch {
        plain.push(key);
      }
    } else {
      plain.push(key);
    }
  }
  return {
    test(text) {
      const haystack = caseSensitive ? String(text) : String(text).toLowerCase();
      if (regexes.some((regex) => regex.test(text))) return true;
      return plain.some((key) => {
        const needle = caseSensitive ? key : key.toLowerCase();
        if (!needle) return false;
        if (!wholeWords) return haystack.includes(needle);
        return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}([^\\p{L}\\p{N}]|$)`, 'u').test(haystack);
      });
    },
  };
}

/** 给界面用的：一条条目的健康体检。 */
export function lintEntries(entries = []) {
  const issues = [];
  const list = Array.isArray(entries) ? entries : [];
  list.forEach((entry, index) => {
    const name = entry.comment ?? entry.name ?? `条目 ${index + 1}`;
    const length = String(entry.content ?? '').length;
    if (length > 2500) issues.push({ level: 'warn', name, message: `正文 ${length} 字，超过 2500 建议拆条（预算裁剪按整条丢）` });
    if (length > 0 && length < 100 && !entry.constant) issues.push({ level: 'info', name, message: '正文不到 100 字，只适合当抽卡池微条目' });
    if (!entry.constant && !(entry.keys?.length)) issues.push({ level: 'error', name, message: '既不是常开也没有 key，永远不会触发' });
    if ((entry.keys?.length ?? 0) > 0 && entry.keys.some((key) => String(key).length <= 2) && !(entry.secondaryKeys?.length)) {
      issues.push({ level: 'info', name, message: '有 1–2 字的短 key，建议配 secondary 收窄，避免误触发' });
    }
  });
  const constants = list.filter((entry) => entry.constant).length;
  if (list.length > 6 && constants / list.length > 1 / 3) {
    issues.push({ level: 'info', name: '整本', message: `常开条目 ${constants}/${list.length}，超过三分之一会挤压预算` });
  }
  return { issues, stats: { total: list.length, constant: constants } };
}
