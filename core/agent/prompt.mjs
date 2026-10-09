/**
 * Agent 的系统提示词。
 *
 * 工具协议故意做成"纯 JSON 文本"而不是各家原生的 function calling：
 * OpenAI / Claude / Gemini 支持，本地文本补全模型也支持，行为一致、调试直观。
 */

export const AGENT_PROTOCOL_VERSION = 1;

export function buildSystemPrompt({ skills = [], persona = '你是写卡助手', extra = '', maxSteps = 4 }) {
  const toolLines = skills
    .map((skill) => {
      const params = Object.keys(skill.parameters?.properties ?? {});
      return `- ${skill.id}（${skill.title}）：${skill.description}${params.length ? ` 参数：${params.join(', ')}` : ''}`;
    })
    .join('\n');

  return [
    persona,
    '',
    '你可以调用下面这些工具来完成任务：',
    toolLines || '（当前没有可用工具）',
    '',
    '回答格式要求（必须严格遵守）：',
    '每次只输出一个 JSON 对象，不要输出别的文字、不要用 markdown 代码块包裹。',
    '要调用工具时输出：{"thought":"简短理由","tool":"工具id","args":{...}}',
    '任务完成时输出：{"thought":"简短理由","final":"最终答案"}',
    `最多连续调用 ${maxSteps} 步；信息已经足够时就直接给 final，不要反复调用同一个工具。`,
    extra ? `\n补充要求：\n${extra}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 从模型输出里抠出 JSON。
 * 容忍三种情况：裸 JSON、```json 代码块、前后有废话的 JSON。
 */
export function extractJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(raw);

  for (const candidate of candidates) {
    const direct = tryParse(candidate);
    if (direct) return direct;
    const slice = sliceBalanced(candidate);
    if (slice) {
      const parsed = tryParse(slice);
      if (parsed) return parsed;
    }
  }
  return null;
}

function tryParse(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/** 找到第一段括号配平的片段（忽略字符串里的括号）。 */
function sliceBalanced(text) {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
