/**
 * Agent 主循环。
 *
 * 纯逻辑：模型怎么调、技能怎么执行都由外面注入（server 提供 models.complete），
 * 所以这里可以脱离网络单测。
 *
 * 事件流（前端按这个渲染）：
 *   { type:'step',   n }                    第几步
 *   { type:'thought',text }                 模型给的理由
 *   { type:'tool',   id, args }             要调哪个技能
 *   { type:'result', id, ok, data, ms }     技能结果
 *   { type:'final',  text }                 最终答案
 *   { type:'error',  message }              出错
 */

import { buildSystemPrompt, extractJson } from './prompt.mjs';
import { runSkill } from './skills.mjs';

export function createAgent({ skills, model, logger = console, maxSteps = 4 }) {
  const available = skills.list();

  async function* run({ goal, context = '', persona, extra, temperature = 0.6 }) {
    const system = buildSystemPrompt({ skills: available, persona: persona ?? undefined, extra, maxSteps });
    const messages = [];
    if (context) messages.push({ role: 'user', content: `已知信息：\n${context}` });
    messages.push({ role: 'user', content: `任务：${goal}` });

    const trace = [];
    for (let step = 1; step <= maxSteps; step += 1) {
      yield { type: 'step', n: step };

      let reply;
      try {
        reply = await model.complete({ system, messages, params: { temperature } });
      } catch (err) {
        yield { type: 'error', message: String(err?.message ?? err) };
        return;
      }

      const action = extractJson(reply.text);
      if (!action) {
        // 模型没按协议走：把它当纯文本答案收工，别死循环
        yield { type: 'final', text: reply.text ?? '' };
        return;
      }

      if (action.thought) yield { type: 'thought', text: String(action.thought) };

      if (action.final !== undefined) {
        yield { type: 'final', text: String(action.final) };
        return;
      }

      if (!action.tool || !skills.has(action.tool)) {
        messages.push({ role: 'assistant', content: JSON.stringify(action) });
        messages.push({
          role: 'user',
          content: `工具 ${action.tool ?? '(空)'} 不存在。可用工具：${available.map((skill) => skill.id).join(', ')}。请重新输出一个 JSON。`,
        });
        continue;
      }

      const skill = skills.get(action.tool);
      yield { type: 'tool', id: skill.id, args: action.args ?? {} };
      const result = await runSkill(skill, { input: action.args ?? {}, model, logger });
      trace.push({ id: skill.id, ok: result.ok });
      yield { type: 'result', id: skill.id, ok: result.ok, data: result.data ?? null, error: result.error ?? null, ms: result.ms };

      messages.push({ role: 'assistant', content: JSON.stringify(action) });
      messages.push({
        role: 'user',
        content: result.ok
          ? `工具 ${skill.id} 返回：\n${JSON.stringify(result.data).slice(0, 6000)}\n继续：要么再调工具，要么给 final。`
          : `工具 ${skill.id} 出错：${result.error}。换个做法，或直接给 final。`,
      });
    }

    yield { type: 'final', text: '（达到最大步数，先停在这里）', trace };
  }

  return { run, skills: available };
}
