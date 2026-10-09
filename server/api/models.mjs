/**
 * 模型路由与绑定。
 *
 * 多模型协同：一个对话里，每个角色都能绑自己的模型；
 * 但历史、世界书、记忆都挂在**对话**上，所以所有模型共享同一份记忆。
 */

import { BINDING_SCOPES, planForChat, resolveModel } from '../../core/models/router.mjs';
import { listBindings, setBinding, deleteBinding, listProviders, getProvider } from '../db/providers.mjs';
import { validateAdapterParams } from '../providers/params.mjs';

export function register(router, { repo, models, chatStore }) {
  router.get('/api/models/scopes', (ctx) => ctx.json(200, { items: BINDING_SCOPES }));

  router.get('/api/models/bindings', (ctx) => {
    const items = listBindings(repo, ctx.query);
    return ctx.json(200, { items, total: items.length });
  });

  /**
   * 绑定时可以带一份**参数覆盖**：同一个提供方下的不同模型，采样参数往往是两套
   * （比如推理模型不吃 temperature）。这里按这个提供方的适配器校验一遍再存。
   */
  router.put('/api/models/bindings', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    if (body.params !== undefined && Object.keys(body.params ?? {}).length) {
      const provider = body.providerId ? getProvider(repo, body.providerId) : null;
      try {
        body.params = validateAdapterParams(provider?.adapter ?? 'openai', body.params ?? {});
      } catch (err) {
        return ctx.fail(400, 'VALIDATION_ERROR', err?.message ?? String(err));
      }
    }
    return ctx.json(200, setBinding(repo, body));
  });

  router.delete('/api/models/bindings/:id', (ctx) => {
    deleteBinding(repo, ctx.params.id);
    return ctx.noContent();
  });

  /** 算一次：这个角色这句话会由哪个模型来答。 */
  router.post('/api/models/resolve', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    const bindings = listBindings(repo, {});
    return ctx.json(200, resolveModel({ bindings, ...body }));
  });

  /**
   * 群聊/多角色的模型分工预览。
   *
   *   ?chatId=chat_xxx                → 服务端自己去查这个群的成员（最准，群聊成员覆盖也能算对）
   *   ?characters=id::名字,id::名字    → 没有对话时按角色卡算（老写法 `id:名字` 也认）
   *
   * 以前只吃前端拼的 characters，而前端拿不到"群聊成员 id"，所以「群聊成员覆盖」
   * 在预览里永远算不出来（成员 id 会被当成角色 id）。现在给 chatId 就由服务端查。
   */
  router.get('/api/models/plan', (ctx) => {
    const chatId = ctx.query.chatId ? String(ctx.query.chatId) : null;
    const chat = chatId && chatStore?.getChat ? chatStore.getChat(chatId) : null;

    const members = chat
      ? (chat.members ?? []).map((member) => ({
          id: member.id,
          characterId: member.characterId ?? null,
          name: member.name ?? member.characterId ?? '角色',
        }))
      : String(ctx.query.characters ?? '')
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
          .map((entry) => {
            const [first, second, third] = entry.split(':');
            const id = first || null;
            const characterId = third === undefined ? id : second || id;
            const name = (third === undefined ? second : third) || characterId || id;
            return { id, characterId, name };
          });

    const plan = planForChat({ bindings: listBindings(repo, {}), chatId: chat?.id ?? chatId, members });
    return ctx.json(200, { ...plan, chat: chat ? { id: chat.id, title: chat.title } : null, providers: listProviders(repo) });
  });

  /** 真发一次极短的请求，用来确认配置能用。 */
  router.post('/api/models/ping', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    if (!body.providerId) return ctx.fail(400, 'VALIDATION_ERROR', '需要 providerId');
    const result = await models.complete(body.providerId, {
      model: body.model ?? null,
      system: body.system ?? '你是一个测试助手，只回答"pong"。',
      messages: [{ role: 'user', content: body.prompt ?? 'ping' }],
      params: { max_tokens: body.maxTokens ?? 16 },
    });
    return ctx.json(200, { text: result.text, thinking: result.thinking, usage: result.usage, finish: result.finish });
  });
}
