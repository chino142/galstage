/**
 * 宏引擎：把 {{...}} 与旧的 <...> 占位符展开成文本。
 *
 * 移植自老项目 core/macros.mjs，对照 SillyTavern `release` 分支
 * `public/scripts/macros.js` 与 `public/scripts/macros/definitions/*`：
 *   - 旧式尖括号：<USER> <BOT> <CHAR> <CHARIFNOTGROUP> <GROUP>
 *   - 条件块：{{if 条件}}a{{else}}b{{/if}}，条件支持 ! 取反、.局部变量、$全局变量
 *   - 变量家族：getvar / setvar / addvar / incvar / decvar / deletevar / hasvar / getvarkey / setvarkey
 *     以及对应的 global 版本
 *   - 时间家族、随机 / 抽签 / 掷骰、消息引用等
 * 未知宏原样留着（SillyTavern 就是这么做的）。
 *
 * 在酒馆基础上多加一件蓝图 1.4 要的东西：**自定义宏**（ctx.customMacros）。
 */

const MAX_PASSES = 40;
export const FALSY = new Set(['', 'false', 'off', '0']);

function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const pad = (n, len = 2) => String(n).padStart(len, '0');
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** moment.js 风格的时间格式化（只做大家真正会用的那些 token）。 */
export function formatDate(date, fmt) {
  const h24 = date.getHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const tokens = {
    YYYY: String(date.getFullYear()), YY: String(date.getFullYear()).slice(-2),
    MMMM: MONTHS_LONG[date.getMonth()], MMM: MONTHS_SHORT[date.getMonth()],
    MM: pad(date.getMonth() + 1), M: String(date.getMonth() + 1),
    DD: pad(date.getDate()), D: String(date.getDate()),
    dddd: WEEKDAYS_LONG[date.getDay()], ddd: WEEKDAYS_SHORT[date.getDay()],
    HH: pad(h24), H: String(h24), hh: pad(h12), h: String(h12),
    mm: pad(date.getMinutes()), m: String(date.getMinutes()),
    ss: pad(date.getSeconds()), s: String(date.getSeconds()),
    A: h24 < 12 ? 'AM' : 'PM', a: h24 < 12 ? 'am' : 'pm',
  };
  return fmt.replace(/YYYY|YY|MMMM|MMM|MM|DD|dddd|ddd|HH|hh|mm|ss|M|D|H|h|m|s|A|a/g, (t) => tokens[t] ?? t);
}

export function formatLT(date) {
  const h24 = date.getHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${pad(date.getMinutes())} ${h24 < 12 ? 'AM' : 'PM'}`;
}

export function formatLL(date) {
  return `${MONTHS_LONG[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

// ---------------------------------------------------------------- 变量

export class VarStore {
  constructor({ local = {}, global = {} } = {}) {
    this.local = new Map(Object.entries(local).map(([key, value]) => [key, String(value)]));
    this.global = new Map(Object.entries(global).map(([key, value]) => [key, String(value)]));
  }

  #bag(scope) {
    return scope === 'global' ? this.global : this.local;
  }

  has(name, scope = 'local') { return this.#bag(scope).has(name); }
  get(name, scope = 'local') { const bag = this.#bag(scope); return bag.has(name) ? bag.get(name) : ''; }
  raw(name, scope = 'local') { const bag = this.#bag(scope); return bag.has(name) ? bag.get(name) : ''; }
  set(name, value, scope = 'local') { this.#bag(scope).set(name, value === undefined || value === null ? '' : String(value)); }
  del(name, scope = 'local') { this.#bag(scope).delete(name); }

  add(name, value, scope = 'local') {
    const bag = this.#bag(scope);
    const current = bag.get(name) ?? '';
    const a = Number(current);
    const b = Number(value);
    bag.set(name, current !== '' && !Number.isNaN(a) && !Number.isNaN(b) ? String(a + b) : current + String(value ?? ''));
  }

  inc(name, scope = 'local') { const n = Number(this.raw(name, scope)); this.set(name, Number.isNaN(n) ? 1 : n + 1, scope); }
  dec(name, scope = 'local') { const n = Number(this.raw(name, scope)); this.set(name, Number.isNaN(n) ? -1 : n - 1, scope); }

  #object(name, scope) {
    const stored = this.raw(name, scope);
    if (!stored) return {};
    try {
      const parsed = JSON.parse(stored);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  getKey(name, key, scope = 'local') { const obj = this.#object(name, scope); return obj[key] === undefined ? '' : String(obj[key]); }
  setKey(name, key, value, scope = 'local') { const obj = this.#object(name, scope); obj[key] = value; this.set(name, JSON.stringify(obj), scope); }

  snapshot() {
    return { local: Object.fromEntries(this.local), global: Object.fromEntries(this.global) };
  }
}

// ---------------------------------------------------------------- 上下文

export function createMacroContext(init = {}) {
  return {
    character: init.character ?? null,
    persona: init.persona ?? null,
    userName: init.userName ?? 'User',
    charName: init.charName ?? 'Character',
    group: init.group ?? null,
    messages: init.messages ?? [],
    vars: init.vars instanceof VarStore ? init.vars : new VarStore({ local: init.vars ?? {} }),
    model: init.model ?? '',
    maxContext: init.maxContext ?? 0,
    maxPrompt: init.maxPrompt ?? 0,
    maxResponse: init.maxResponse ?? 0,
    mainPrompt: init.mainPrompt ?? '',
    customMacros: init.customMacros ?? {},
    extra: init.extra ?? {},
    now: init.now ?? new Date(),
    seed: init.seed ?? '',
    rng: typeof init.rng === 'function' ? init.rng : Math.random,
  };
}

function lastOf(messages, predicate) {
  for (let i = messages.length - 1; i >= 0; i--) if (predicate(messages[i])) return messages[i];
  return null;
}

function pickFrom(args, ctx, deterministic) {
  const list = (Array.isArray(args) ? args : String(args).split(',')).map((item) => String(item).trim()).filter(Boolean);
  if (!list.length) return '';
  const index = deterministic ? hash32(`${ctx.seed}|${list.join(',')}`) % list.length : Math.floor(ctx.rng() * list.length);
  return list[index];
}

function rollDice(expr, ctx) {
  const m = /^(\d*)d(\d+)([+-]\d+)?$/i.exec(String(expr).trim());
  if (!m) return '';
  const count = m[1] ? parseInt(m[1], 10) : 1;
  const sides = parseInt(m[2], 10);
  const mod = m[3] ? parseInt(m[3], 10) : 0;
  if (!Number.isFinite(count) || !Number.isFinite(sides) || count < 1 || sides < 1 || count > 1000) return '';
  let total = mod;
  for (let i = 0; i < count; i++) total += 1 + Math.floor(ctx.rng() * sides);
  return String(total);
}

function isTruthy(value) {
  return !FALSY.has(String(value ?? '').trim().toLowerCase());
}

// ---------------------------------------------------------------- 展开宏

/** 返回替换文本；不认识的宏返回 null（调用方保留原样）。 */
function resolveMacro(body, ctx) {
  const trimmed = body.trim();
  if (trimmed.startsWith('//')) return '';

  const shape = /^([A-Za-z_][A-Za-z0-9_]*)(\s*::\s*|\s*:\s*|\s+)([\s\S]*)$/.exec(trimmed);
  let key;
  let args;
  if (shape) {
    key = shape[1].toLowerCase();
    const separator = shape[2].trim();
    args = separator === '::' ? shape[3].split('::') : [shape[3]];
  } else {
    key = trimmed.toLowerCase();
    args = [];
  }

  const data = ctx.character?.data ?? ctx.character ?? {};
  const msgText = (message) => (message ? String(message.content ?? '') : '');

  switch (key) {
    case 'newline': return '\n';
    case 'space': return ' ';
    case 'noop':
    case 'trim': return '';
    case 'char':
    case 'charname': return ctx.charName ?? '';
    case 'charifnotgroup': return ctx.group || ctx.charName || '';
    case 'user':
    case 'username': return ctx.userName ?? '';
    case 'notchar': return ctx.userName ?? '';
    case 'group': return ctx.group ?? '';
    case 'groupnotmuted': return ctx.group ?? '';
    case 'description': return data.description ?? '';
    case 'chardescription': return data.description ?? '';
    case 'personality': return data.personality ?? '';
    case 'charpersonality': return data.personality ?? '';
    case 'scenario': return data.scenario ?? '';
    case 'charscenario': return data.scenario ?? '';
    case 'persona': return ctx.persona?.description ?? '';
    case 'charversion': return data.character_version ?? '';
    case 'version':
    case 'char_version': return data.character_version ?? '';
    case 'charcreator': return data.creator ?? '';
    case 'charprompt': return data.system_prompt ?? '';
    case 'charinstruction':
    case 'charjailbreak': return data.post_history_instructions ?? '';
    case 'chardeptprompt': return data.extensions?.depth_prompt?.prompt ?? '';
    case 'firstmessage': return data.first_mes ?? '';
    case 'charfirstmessage':
    case 'greeting': return data.first_mes ?? '';
    case 'examplemessage':
    case 'mesexample': return data.mes_example ?? '';
    case 'mesexamples':
    case 'mesexamplesraw': return data.mes_example ?? '';
    case 'creatornotes': return data.creator_notes ?? '';
    case 'charcreatornotes': return data.creator_notes ?? '';
    case 'model': return ctx.model ?? '';
    case 'maxcontext':
    case 'maxcontexttokens': return String(ctx.maxContext ?? '');
    case 'maxprompt':
    case 'maxprompttokens': return String(ctx.maxPrompt ?? '');
    case 'maxresponse':
    case 'maxresponsetokens': return String(ctx.maxResponse ?? '');
    case 'mainprompt': return ctx.mainPrompt ?? '';
    case 'time': return args[0] ? formatDate(ctx.now, args[0]) : formatLT(ctx.now);
    case 'date': return args[0] ? formatDate(ctx.now, args[0]) : formatLL(ctx.now);
    case 'datetime': return `${formatLL(ctx.now)} ${formatLT(ctx.now)}`;
    case 'weekday': return WEEKDAYS_LONG[ctx.now.getDay()];
    case 'isotime': return `${pad(ctx.now.getHours())}:${pad(ctx.now.getMinutes())}`;
    case 'isodate': return `${ctx.now.getFullYear()}-${pad(ctx.now.getMonth() + 1)}-${pad(ctx.now.getDate())}`;
    case 'datetimeformat': return formatDate(ctx.now, (args[0] ?? '').trim());
    case 'idle_duration':
    case 'idleduration': return ctx.extra.idleDuration ?? 'just now';
    case 'timediff': {
      const a = Date.parse(evaluateMacros(args[0] ?? '', ctx));
      const b = Date.parse(evaluateMacros(args[1] ?? '', ctx));
      if (Number.isNaN(a) || Number.isNaN(b)) return '';
      return humanizeDuration(Math.abs(Math.round((a - b) / 1000)));
    }
    // 两种情况都要认：{{random::甲::乙::丙}}（多参数）和 {{random:甲,乙,丙}}（一个参数里逗号分隔）
    // 以前只把 args[0] 传进去，于是 :: 形式永远只取第一个选项。
    case 'random': return pickFrom(args.length > 1 ? args : (args[0] ?? ''), ctx, false);
    case 'pick': return pickFrom(args.length > 1 ? args : (args[0] ?? ''), ctx, true);
    case 'roll': return rollDice(args[0] ?? '1d20', ctx);
    case 'reverse': return Array.from(args.join('::')).reverse().join('');
    case 'banned':
    case 'outlet': return '';

    case 'getvar': return ctx.vars.get(args.join('::'), 'local');
    case 'setvar':
      ctx.vars.set(args[0], evaluateMacros(args.slice(1).join('::'), ctx), 'local');
      return '';
    case 'addvar':
      ctx.vars.add(args[0], evaluateMacros(args.slice(1).join('::'), ctx), 'local');
      return '';
    case 'incvar': ctx.vars.inc(args[0], 'local'); return ctx.vars.raw(args[0], 'local');
    case 'decvar': ctx.vars.dec(args[0], 'local'); return ctx.vars.raw(args[0], 'local');
    case 'deletevar':
    case 'delvar': ctx.vars.del(args[0], 'local'); return '';
    case 'hasvar': return ctx.vars.has(args[0], 'local') ? 'true' : 'false';
    case 'getvarkey': return ctx.vars.getKey(args[0], args.slice(1).join('::'), 'local');
    case 'setvarkey':
      ctx.vars.setKey(args[0], args[1], evaluateMacros(args.slice(2).join('::'), ctx), 'local');
      return '';

    case 'getglobalvar': return ctx.vars.get(args.join('::'), 'global');
    case 'setglobalvar':
      ctx.vars.set(args[0], evaluateMacros(args.slice(1).join('::'), ctx), 'global');
      return '';
    case 'addglobalvar':
      ctx.vars.add(args[0], evaluateMacros(args.slice(1).join('::'), ctx), 'global');
      return '';
    case 'incglobalvar': ctx.vars.inc(args[0], 'global'); return ctx.vars.raw(args[0], 'global');
    case 'decglobalvar': ctx.vars.dec(args[0], 'global'); return ctx.vars.raw(args[0], 'global');
    case 'deleteglobalvar':
    case 'delglobalvar': ctx.vars.del(args[0], 'global'); return '';
    case 'hasglobalvar': return ctx.vars.has(args[0], 'global') ? 'true' : 'false';
    case 'getglobalvarkey': return ctx.vars.getKey(args[0], args.slice(1).join('::'), 'global');
    case 'setglobalvarkey':
      ctx.vars.setKey(args[0], args[1], evaluateMacros(args.slice(2).join('::'), ctx), 'global');
      return '';

    case 'input': return ctx.extra.input ?? '';
    case 'original': return ctx.extra.original ?? '';
    case 'lastmessage': return msgText(lastOf(ctx.messages, () => true));
    case 'lastusermessage': return msgText(lastOf(ctx.messages, (message) => message.role === 'user'));
    case 'lastcharmessage': return msgText(lastOf(ctx.messages, (message) => message.role === 'assistant' || message.role === 'char'));
    case 'messagecount':
    case 'allchatrange': return ctx.messages.length ? `0-${ctx.messages.length - 1}` : '';
    default: {
      // 自定义宏：名字（不含花括号）匹配就展开，值里还能继续套宏。
      if (ctx.customMacros) {
        const value = Object.prototype.hasOwnProperty.call(ctx.customMacros, key)
          ? ctx.customMacros[key]
          : Object.prototype.hasOwnProperty.call(ctx.customMacros, trimmed)
            ? ctx.customMacros[trimmed]
            : undefined;
        if (value !== undefined) return evaluateMacros(String(value ?? ''), ctx);
      }
      return null;
    }
  }
}

function humanizeDuration(seconds) {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------- 条件块

const IF_RE = /\{\{\s*if\s+([^{}]*)\}\}([\s\S]*?)\{\{\s*\/if\s*\}\}/i;

function evaluateCondition(rawCondition, ctx) {
  let condition = rawCondition.trim();
  let inverted = false;
  if (condition.startsWith('!')) {
    inverted = true;
    condition = condition.replace(/^!\s*/, '');
  }
  if (/^\.[A-Za-z0-9_-]+$/.test(condition)) condition = ctx.vars.get(condition.slice(1), 'local');
  else if (/^\$[A-Za-z0-9_-]+$/.test(condition)) condition = ctx.vars.get(condition.slice(1), 'global');
  else if (/^[a-zA-Z_][\w-]*$/.test(condition) && resolveMacro(condition, ctx) !== null) condition = resolveMacro(condition, ctx);
  else condition = evaluateMacros(condition, ctx);
  const truthy = isTruthy(condition);
  return inverted ? !truthy : truthy;
}

function expandBlockMacros(input, ctx, depth) {
  if (depth > MAX_PASSES) return input;
  const match = IF_RE.exec(input);
  if (!match) return input;
  const [whole, rawCondition, body] = match;
  const branches = body.split(/\{\{\s*else\s*\}\}/i);
  const chosen = evaluateCondition(rawCondition, ctx) ? branches[0] ?? '' : branches.slice(1).join('{{else}}');
  return expandBlockMacros(input.slice(0, match.index) + chosen + input.slice(match.index + whole.length), ctx, depth + 1);
}

// ---------------------------------------------------------------- 入口

/**
 * 展开整段文本。不认识的宏原样保留。
 * @returns {string}
 */
export function evaluateMacros(input, ctx, depth = 0) {
  if (typeof input !== 'string' || input.length === 0) return '';
  if (!input.includes('{{') && !input.includes('<')) return input;
  if (depth > MAX_PASSES) return input;

  let text = expandBlockMacros(input, ctx, 0);
  text = text
    .replace(/<USER>/gi, () => ctx.userName ?? '')
    .replace(/<BOT>/gi, () => ctx.charName ?? '')
    .replace(/<CHAR>/gi, () => ctx.charName ?? '')
    .replace(/<CHARIFNOTGROUP>/gi, () => ctx.group || ctx.charName || '')
    .replace(/<GROUP>/gi, () => ctx.group ?? '');

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let changed = false;
    text = text.replace(/\{\{([^{}]*)\}\}/g, (match, body) => {
      const resolved = resolveMacro(body, ctx);
      if (resolved === null) return match;
      changed = true;
      const post = ctx.extra?.valuePostProcess;
      return typeof post === 'function' ? post(String(resolved)) : resolved;
    });
    if (!changed || !text.includes('{{')) break;
  }

  if (input.includes('{{trim}}')) text = text.replace(/(?:\r?\n)*\{\{trim\}\}(?:\r?\n)*/gi, '');
  return text;
}
