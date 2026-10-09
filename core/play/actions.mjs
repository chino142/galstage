/**
 * 动作序列（快速回复）。
 *
 * 抄的是酒馆 Quick Replies 的价值点，不是它的 254 个斜杠命令：
 * 把一串常用操作存成一个按钮，点一下按顺序跑完，可以带变量与条件。
 *
 * 这一层只做「定义 + 校验 + 展开」；真正执行由前端按步骤调用既有接口，
 * 这样不用在后端开一个万能执行的口子。
 */

import { ValidationError } from '../errors.mjs';

export const STEP_TYPES = [
  { id: 'send', title: '发送消息', fields: ['text'], summary: '把 text 填进输入框并发送' },
  { id: 'continue', title: '继续', fields: [], summary: '让 AI 接着写' },
  { id: 'regenerate', title: '重新生成', fields: [], summary: '重写最后一条' },
  { id: 'impersonate', title: '扮演', fields: [], summary: '让 AI 替你写一句，填进输入框' },
  { id: 'append', title: '追加到输入框', fields: ['text'], summary: '不发送，只把 text 加到输入框' },
  { id: 'note', title: '设置临场指令', fields: ['text'], summary: '改这一段对话的临场指令' },
  { id: 'setVariable', title: '设置变量', fields: ['key', 'value'], summary: '写对话变量' },
  { id: 'switchCharacter', title: '切换角色', fields: ['characterId'], summary: '换一张角色卡继续' },
  { id: 'translate', title: '翻译最后一条', fields: ['target'], summary: '把最后一条回复翻成目标语言' },
  { id: 'export', title: '导出对话', fields: ['format'], summary: '导出为 md / html / jsonl' },
  { id: 'sleep', title: '等待', fields: ['ms'], summary: '等一会儿再跑下一步' },
];

const BY_ID = new Map(STEP_TYPES.map((item) => [item.id, item]));

export function stepSpec(type) {
  return BY_ID.get(String(type ?? '')) ?? null;
}

export function validateStep(step = {}) {
  const type = String(step.type ?? '').trim();
  const spec = stepSpec(type);
  if (!spec) throw new ValidationError(`不认识的动作：${type || '(空)'}（可用 ${STEP_TYPES.map((item) => item.id).join(' / ')}）`);
  const out = { type };
  for (const field of spec.fields) {
    const value = step[field];
    if (value === undefined || value === null || value === '') {
      throw new ValidationError(`动作「${spec.title}」需要 ${field}`);
    }
    out[field] = field === 'ms' ? Math.max(0, Math.min(60000, Number(value) || 0)) : String(value);
  }
  if (type === 'export' && !['md', 'html', 'jsonl'].includes(out.format)) {
    throw new ValidationError('导出格式只认 md / html / jsonl');
  }
  if (step.condition) out.condition = String(step.condition);
  return out;
}

export function normaliseActionSet(raw = {}) {
  const name = String(raw.name ?? '').trim();
  if (!name) throw new ValidationError('动作组需要起个名字');
  const steps = (Array.isArray(raw.steps) ? raw.steps : []).map(validateStep);
  if (!steps.length) throw new ValidationError('动作组至少要有一个步骤');
  if (steps.length > 40) throw new ValidationError('一个动作组最多 40 步');
  const variables = {};
  for (const [key, value] of Object.entries(raw.variables ?? {})) {
    const clean = String(key ?? '').trim();
    if (clean) variables[clean] = String(value ?? '');
  }
  return {
    name,
    icon: String(raw.icon ?? '⚡').slice(0, 4),
    summary: String(raw.summary ?? '').trim(),
    autoRun: Boolean(raw.autoRun),
    showInBar: raw.showInBar !== false,
    variables,
    steps,
  };
}

/** 展开变量：`{{好感度}}` 换成这套动作里存的值。 */
export function expandActionText(text, variables = {}) {
  return String(text ?? '').replace(/\{\{\s*([^}]{1,40})\s*\}\}/g, (whole, key) => {
    const name = String(key).trim();
    return name in variables ? String(variables[name]) : whole;
  });
}

export function describeActionSet(set = {}) {
  const steps = Array.isArray(set.steps) ? set.steps : [];
  const parts = steps.slice(0, 4).map((step) => stepSpec(step.type)?.title ?? step.type);
  if (steps.length > 4) parts.push(`…共 ${steps.length} 步`);
  return parts.join(' → ');
}
