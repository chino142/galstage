/**
 * 预设里的「函数调用（function calling）」怎么落到我们这边。
 *
 * 酒馆本体（`public/scripts/tool-calling.js`）只认**已经注册过的工具**——注册来自扩展和
 * `/tools-register` 斜杠命令，预设文件本身不带工具。真正让预设带上工具的是第三方扩展
 * **SPreset**，它把工具定义塞进预设的 `extensions.SPreset.ToolBindings` 里，并且用
 * `extensions.SPreset.OutputPreprocessing` 决定「工具调用的参数算不算正文」。
 * 用户的 `-Meowssiah-1.1` 预设走的就是这条路。
 *
 * 所以这里做三件事：
 *   1. 把 `ToolBindings` 里的 `form` 翻译成 OpenAI 形状的工具定义（不执行预设里的 JS）；
 *   2. 认出 `consumeToolCalls`——开着的时候工具调用**就是这一轮回复**，不再二次生成；
 *   3. 认出 `OutputPreprocessing` 里的字面量标记（例如 `<|valid|>`），用来丢掉标记之前的碎嘴。
 *
 * 取值的保守原则跟 `preset-options.mjs` 一致：预设没明确写的一律不猜，认不出来的字段
 * 记一条 note 说明，不装作支持。
 */

/** 参数的语义分类：哪些算正文、哪些算思维链。两边都认英文原名和常见别名。 */
const CONTENT_KEYS = new Set(['content', 'text', 'reply', 'message', 'body', 'output', 'result']);
const THINKING_KEYS = new Set(['thinking', 'thought', 'thoughts', 'reasoning', 'think', 'analysis', 'mind']);

/** SPreset 用 `<think_nya~>` 包思维链；酒馆里那条正则也认这个标签，我们沿用，见 splitThinkingTags。 */
const THINKING_TAG = 'think_nya~';

const FORM_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);

function finiteInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** `form.parameters` 是 SPreset 的编辑器形状：数组，每项 {name,type,description,required}。 */
function schemaFromFormParameters(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const properties = {};
  const required = [];
  for (const item of list) {
    const name = String(item?.name ?? '').trim();
    if (!name) continue;
    const type = FORM_TYPES.has(String(item?.type)) ? String(item.type) : 'string';
    const property = { type };
    const description = String(item?.description ?? '').trim();
    if (description) property.description = description;
    if (type === 'array') property.items = { type: 'string' };
    properties[name] = property;
    if (item?.required === true) required.push(name);
  }
  if (!Object.keys(properties).length) return null;
  const schema = { type: 'object', properties };
  if (required.length) schema.required = required;
  return schema;
}

/**
 * 兜底：预设只留了 `code` 没留 `form`（手写过工具的作者可能这样）。
 * 这里只做**字面量抽取**，不执行任何 JS：从 `parameters: { ... }` 里截出平衡括号再按 JSON 解析。
 * 解析不了就返回 null，宁可不给工具也不瞎猜。
 */
function schemaFromCode(code) {
  const source = String(code ?? '');
  const start = source.search(/parameters\s*:\s*\{/);
  if (start < 0) return null;
  const open = source.indexOf('{', start);
  let depth = 0;
  let inString = null;
  for (let index = open; index < source.length; index++) {
    const char = source[index];
    if (inString) {
      if (char === '\\') index++;
      else if (char === inString) inString = null;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = char;
      continue;
    }
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) {
        const literal = source.slice(open, index + 1);
        try {
          const parsed = JSON.parse(literal);
          return parsed && typeof parsed === 'object' ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function toolFromBinding(binding, notes, label) {
  if (!binding || typeof binding !== 'object') return null;
  const form = binding.form && typeof binding.form === 'object' ? binding.form : null;
  const name = String(form?.name ?? binding.resolvedName ?? '').trim();
  if (!name) {
    notes.push(`工具绑定「${label}」没有名字，跳过`);
    return null;
  }
  const parameters = schemaFromFormParameters(form?.parameters) ?? schemaFromCode(binding.code);
  if (!parameters) {
    notes.push(`工具「${name}」没找到可用的参数定义（只有 form 有结构，code 里的参数解析不了），暂时不给模型`);
    return null;
  }
  return {
    name,
    displayName: String(form?.displayName ?? '').trim() || name,
    description: String(form?.description ?? '').trim(),
    parameters,
    // SPreset 的 stealth = 结果不进聊天记录。我们的实现里这一轮不落库，只写日志。
    stealth: binding.stealth === true || form?.stealth === true,
  };
}

/** 扩展里带代码但不带的字面量，这里只认「赋值给 marker 的字符串字面量」。 */
function markerFromScript(script) {
  const match = String(script ?? '').match(/marker\s*=\s*(['"])((?:[^\\]|\\.)*?)\1/);
  if (!match) return null;
  return match[2] || null;
}

/**
 * 把一条预设翻译成「这一轮要不要带工具、带哪些、结果怎么算」。
 *
 * @param {object} preset 预设原文（数据库里存的那份，`extensions` 完整保留）
 * @returns {{
 *   enabled: boolean, tools: Array, recurseLimit: number,
 *   consumeToolCalls: boolean, outputMarker: string|null,
 *   format: (calls: Array) => { text: string, notes: string[] },
 *   notes: string[],
 * }}
 */
export function presetToolPlan(preset) {
  const source = preset && typeof preset === 'object' ? preset : {};
  const notes = [];
  const spreset = source.extensions?.SPreset && typeof source.extensions.SPreset === 'object' ? source.extensions.SPreset : null;

  const enabled = source.function_calling === true;
  const recurseLimit = clamp(finiteInt(source.tool_call_recurse_limit, 5), 1, 50);

  const tools = [];
  if (enabled) {
    const bindings = spreset?.ToolBindings;
    if (bindings && typeof bindings === 'object') {
      for (const [key, binding] of Object.entries(bindings)) {
        if (!binding || typeof binding !== 'object') continue;
        if (binding.enabled === false) continue;
        const tool = toolFromBinding(binding, notes, key);
        if (tool) tools.push(tool);
      }
    }
    if (!tools.length && !notes.length) {
      notes.push('预设开了 function_calling，但里面没有找到工具定义（extensions.SPreset.ToolBindings 是空的）');
    }
  }

  const preprocessing = spreset?.OutputPreprocessing;
  const consumeToolCalls = preprocessing?.consumeToolCalls === true;
  const outputMarker = preprocessing?.enabled === true ? markerFromScript(preprocessing?.script) : null;

  return {
    enabled,
    tools,
    recurseLimit,
    consumeToolCalls,
    outputMarker,
    format: (calls) => formatToolCalls(calls, tools),
    notes,
  };
}

/** 某个参数名算正文还是算思维链。 */
function classifyParameter(name) {
  const key = String(name ?? '').trim().toLowerCase();
  if (THINKING_KEYS.has(key)) return 'thinking';
  if (CONTENT_KEYS.has(key)) return 'content';
  return 'other';
}

/**
 * `consumeToolCalls` 开着的时候，工具调用的参数要还原成给人看的正文。
 *
 * 这里不执行预设里那段 JS formatter（本项目全局不 eval 不可信代码，卡内前端那边连
 * `new Function` 都是静态检查禁止的）。改成按参数的**语义**还原，覆盖同一个意思：
 *   · `content` / `text` 之类 → 正文
 *   · `thinking` / `thought` 之类 → 思维链，用 `<think_nya~>` 包上，交给既有的摘取逻辑
 *   · 其余参数 → 追加成 `名字：值` 一行
 */
export function formatToolCalls(calls, tools = []) {
  const notes = [];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const bodies = [];
  const thoughts = [];

  for (const call of Array.isArray(calls) ? calls : []) {
    const name = String(call?.name ?? '').trim();
    const args = call?.arguments && typeof call.arguments === 'object' ? call.arguments : {};
    const entries = Object.entries(args);
    if (!entries.length) {
      notes.push(`工具「${name}」没有带参数，这一轮没有正文可还原`);
      continue;
    }
    const properties = byName.get(name)?.parameters?.properties ?? null;
    const rest = [];
    for (const [key, value] of entries) {
      const kind = classifyParameter(key);
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      if (kind === 'thinking') thoughts.push(text);
      else if (kind === 'content') bodies.push(text);
      else if (properties && !properties[key]) rest.push(`${key}: ${text}`);
      else rest.push(`${key}: ${text}`);
    }
    if (rest.length) bodies.push(rest.join('\n'));
  }

  if (thoughts.length) bodies.unshift(`<${THINKING_TAG}>\n${thoughts.join('\n\n')}\n</${THINKING_TAG}>`);
  return { text: bodies.join('\n\n').trim(), notes };
}

/**
 * 预设的 `OutputPreprocessing` 只认标记之后的内容（作者用它挡掉模型开头那段碎碎念）。
 * 标记是我们从预设里读出来的字面量，不带标记就原样返回，免得整条消息变空。
 */
export function applyOutputMarker(text, marker) {
  const body = String(text ?? '');
  const tag = String(marker ?? '');
  if (!tag) return { text: body, trimmed: false };
  const at = body.indexOf(tag);
  if (at < 0) return { text: body, trimmed: false };
  return { text: body.slice(at + tag.length), trimmed: true };
}

export const PRESET_TOOL_INTERNALS = { CONTENT_KEYS, THINKING_KEYS, THINKING_TAG };
