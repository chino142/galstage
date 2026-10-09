/**
 * Agent 运行时：把「技能 + 模型 + MCP 工具」拼成一个能干活的东西。
 *
 * 模型是现解析的：优先用请求指定的提供方，否则按
 * 角色覆盖 → 对话默认 → 全局默认 的顺序找。所以同一个写卡任务，
 * 用哪个模型取决于你给谁绑了什么。
 */

import { createSkillRegistry, runSkill } from '../../core/agent/skills.mjs';
import { createAgent } from '../../core/agent/loop.mjs';
import { WRITING_SKILLS } from '../../core/agent/writing-skills.mjs';
import { CREATIVE_SKILLS } from '../../core/agent/creative-skills.mjs';
import { resolveModel } from '../../core/models/router.mjs';
import { listBindings } from '../db/providers.mjs';
import { ProviderError, ValidationError } from '../../core/errors.mjs';

export function createAgentRuntime({ repo, models, mcp, logger = console }) {
  // 插件注册的技能（插件加载时才填进来；buildSkills 每次现拼，所以后加载的也生效）
  const extraSkills = [];

  /** 内置写卡技能 + 当前已连接的 MCP 工具。 */
  function buildSkills() {
    const registry = createSkillRegistry([...WRITING_SKILLS, ...CREATIVE_SKILLS]);
    for (const skill of extraSkills) {
      if (!registry.has(skill.id)) registry.register(skill);
    }
    for (const skill of mcp?.toolsAsSkills?.() ?? []) {
      if (!registry.has(skill.id)) registry.register(skill);
    }
    return registry;
  }

  function addSkill(skill) {
    if (!skill?.id) throw new ValidationError('技能要有 id');
    extraSkills.push(skill);
    return skill;
  }

  /** 决定这次用哪个提供方。 */
  function resolveTarget({ providerId = null, characterId = null, chatId = null, kind = 'chat' } = {}) {
    if (providerId) return { providerId, model: null, source: 'explicit', sourceTitle: '指定提供方' };
    const resolved = resolveModel({ bindings: listBindings(repo, { kind }), characterId, chatId, kind });
    if (!resolved.providerId) {
      throw new ProviderError('还没有可用的模型：去「模型接入」加一个，并把它设为默认或绑到角色上');
    }
    return resolved;
  }

  /** 给技能用的 model 门面。 */
  function modelFacade(target) {
    return {
      target,
      async complete(options) {
        return models.complete(target.providerId, { ...options, model: options?.model ?? target.model ?? null });
      },
    };
  }

  async function runSingleSkill({ skillId, input = {}, ...targetOptions }) {
    if (!skillId) throw new ValidationError('需要 skillId');
    const registry = buildSkills();
    const skill = registry.get(skillId);
    const target = resolveTarget(targetOptions);
    const result = await runSkill(skill, { input, model: modelFacade(target), logger });
    return { ...result, skill: registry.describe(skill), target };
  }

  function createRunner({ maxSteps = 4, ...targetOptions } = {}) {
    const registry = buildSkills();
    const target = resolveTarget(targetOptions);
    const agent = createAgent({ skills: registry, model: modelFacade(target), logger, maxSteps });
    return { agent, target, registry };
  }

  return { buildSkills, addSkill, extraSkills, resolveTarget, modelFacade, runSingleSkill, createRunner };
}
