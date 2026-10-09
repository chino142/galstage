/**
 * 技能注册表。
 *
 * "技能"= 一次可以被 Agent 调用的动作（生成草稿、体检、翻译……）。
 * 每个技能声明自己收什么参数、干什么，Agent 把这些声明拼进系统提示词，
 * 模型再按 JSON 协议点名调用 —— 这样不依赖任何一家的原生 function calling，
 * 本地文本补全模型也能用。
 */

import { ValidationError, ConflictError, NotFoundError } from '../errors.mjs';

const ID_PATTERN = /^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$/;

export const SKILL_CATEGORIES = [
  { id: 'card', title: '角色卡', summary: '生成、改写、体检、打标签' },
  { id: 'worldbook', title: '世界书', summary: '从设定文本抽出条目' },
  { id: 'text', title: '文本', summary: '翻译、压缩、润色' },
  { id: 'novel', title: '创作辅助', summary: '对话成章、角色卡一条龙、素材抽取' },
  { id: 'external', title: '外部工具', summary: '来自 MCP 服务器的工具' },
];

export function createSkillRegistry(initial = []) {
  const skills = new Map();

  function register(skill) {
    if (!skill || typeof skill !== 'object') throw new ValidationError('技能必须是对象');
    if (!ID_PATTERN.test(String(skill.id ?? ''))) {
      throw new ValidationError(`技能 id 不合法：${skill.id}（要求 domain.action）`);
    }
    if (skills.has(skill.id)) throw new ConflictError(`技能 id 重复：${skill.id}`);
    if (typeof skill.handler !== 'function') throw new ValidationError(`技能 ${skill.id} 缺少 handler`);
    const normalized = {
      category: 'text',
      parameters: { type: 'object', properties: {}, required: [] },
      source: 'builtin',
      ...skill,
    };
    skills.set(normalized.id, normalized);
    return normalized;
  }

  function get(id) {
    const skill = skills.get(id);
    if (!skill) throw new NotFoundError(`技能 ${id}`);
    return skill;
  }

  function list({ category, source } = {}) {
    return [...skills.values()]
      .filter((skill) => (category ? skill.category === category : true))
      .filter((skill) => (source ? skill.source === source : true));
  }

  /** 给界面看的精简描述（不含 handler）。 */
  function describe(skill) {
    return {
      id: skill.id,
      title: skill.title,
      description: skill.description,
      category: skill.category,
      parameters: skill.parameters,
      source: skill.source,
      server: skill.server ?? null,
    };
  }

  for (const skill of initial) register(skill);

  return { register, get, has: (id) => skills.has(id), list, describe, get size() { return skills.size; } };
}

/** 执行技能，统一把参数与错误包一层。 */
export async function runSkill(skill, { input = {}, model, logger = console } = {}) {
  if (typeof model?.complete !== 'function') throw new ValidationError('技能执行需要一个可用的模型');
  const started = Date.now();
  try {
    const data = await skill.handler({ input, model, logger });
    return { ok: true, data, ms: Date.now() - started };
  } catch (err) {
    logger?.debug?.(`技能 ${skill.id} 失败：${err?.message ?? err}`);
    return { ok: false, error: String(err?.message ?? err), ms: Date.now() - started };
  }
}
