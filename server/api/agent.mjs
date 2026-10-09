/**
 * Agent 接口：写卡助手跑起来的地方。
 *
 * 注意 run 走的是 SSE：Agent 每想一步、每调一次工具都会推一条事件，
 * 前端能实时看到它在干什么，而不是等一大坨结果。
 */

import { openSse } from '../http/sse.mjs';
import { SKILL_CATEGORIES } from '../../core/agent/skills.mjs';
import { BINDING_SCOPES } from '../../core/models/router.mjs';

export function register(router, { repo, agents, models }) {
  router.get('/api/agent/skills', (ctx) => {
    const registry = agents.buildSkills();
    return ctx.json(200, {
      items: registry.list().map((skill) => registry.describe(skill)),
      categories: SKILL_CATEGORIES,
      builtin: registry.list({ source: 'builtin' }).length,
      fromMcp: registry.list({ source: 'mcp' }).length,
    });
  });

  router.post('/api/agent/skills/:id/run', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    const result = await agents.runSingleSkill({
      skillId: ctx.params.id,
      input: body.input ?? body,
      providerId: body.providerId ?? null,
      characterId: body.characterId ?? null,
      chatId: body.chatId ?? null,
    });
    return ctx.json(200, result);
  });

  /** 多步 Agent：SSE 推 step / thought / tool / result / final / error。 */
  router.post('/api/agent/run', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    const sse = openSse(ctx);
    try {
      const { agent, target, registry } = agents.createRunner({
        providerId: body.providerId ?? null,
        characterId: body.characterId ?? null,
        chatId: body.chatId ?? null,
        maxSteps: Math.min(Math.max(Number(body.maxSteps ?? 4), 1), 8),
      });
      sse.send('ready', { target, toolCount: registry.size });
      for await (const event of agent.run({
        goal: body.goal ?? '',
        context: body.context ?? '',
        extra: body.extra ?? '',
        temperature: body.temperature ?? 0.6,
      })) {
        sse.send(event.type, event);
        if (event.type === 'final' || event.type === 'error') break;
      }
    } catch (err) {
      sse.send('error', { message: String(err?.message ?? err) });
    }
    sse.close();
    return true;
  });

  router.get('/api/agent/meta', (ctx) =>
    ctx.json(200, {
      scopes: BINDING_SCOPES,
      providers: models.descriptors(),
      note: '记忆与上下文挂在对话上，与模型无关 —— 换模型不会丢记忆。',
    }),
  );
  void repo;
}
