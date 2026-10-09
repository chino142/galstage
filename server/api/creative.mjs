/**
 * 创作辅助接口（蓝图 3.2「创作辅助」）。
 *
 * 三件事都在这里把"数据"和"技能"接起来：服务端负责把对话 / 角色卡拼成文本、
 * 把模型返回的结构化条目落库（世界书），模型调用本身走写卡助手的技能机制
 * （core/agent/creative-skills.mjs + server/agent/runtime.mjs 的 runSingleSkill）。
 */

import { ProviderError, ValidationError } from '../../core/errors.mjs';
import { entitiesToWorldbookEntries } from '../../core/agent/creative-skills.mjs';

function roleLabel(role) {
  if (role === 'user') return '用户';
  if (role === 'system') return '旁白';
  return '角色';
}

/** 对话 → 一段"用户：… / 角色：…"的文本，给模型当原文。 */
export function messagesToScript(messages = []) {
  return messages
    .filter((message) => !message.isSystem)
    .map((message) => `${message.name || roleLabel(message.role)}：${String(message.content ?? '').trim()}`)
    .filter((line) => line.replace(/^[^：]*：/, '').trim().length)
    .join('\n\n');
}

export function register(router, { engine, agents, chatStore }) {
  const chat = engine.services.chat;
  const cards = engine.services.cards;
  const worldbook = engine.services.worldbook;

  async function runSkill(skillId, input, body = {}) {
    const result = await agents.runSingleSkill({
      skillId,
      input,
      providerId: body.providerId ?? null,
      characterId: body.characterId ?? null,
      chatId: body.chatId ?? null,
    });
    if (!result.ok) throw new ProviderError(`技能 ${skillId} 失败：${result.error}`);
    return result;
  }

  function requireMessages(chatId, { maxChars = 24000 } = {}) {
    if (!chatId) throw new ValidationError('要指定一个对话（chatId）');
    const messages = chatStore.listMessages(chatId);
    if (!messages.length) throw new ValidationError('这个对话还没有消息');
    const text = messagesToScript(messages).slice(-maxChars);
    if (!text.trim()) throw new ValidationError('这个对话没有可以改写的正文');
    return { messages, text };
  }

  /** 一段对话 → 小说章节。 */
  router.post('/api/creative/chat-to-chapter', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    const { messages, text } = requireMessages(body.chatId, { maxChars: Number(body.maxChars ?? 24000) });
    const result = await runSkill(
      'chapter.polish',
      { text, title: body.title ?? '', style: body.style ?? '', pov: body.pov ?? '', words: body.words ?? 0 },
      body,
    );
    const data = result.data ?? {};
    return ctx.json(200, {
      title: data.title ?? '',
      text: data.text ?? (Array.isArray(data.chapters) ? data.chapters.map((chapter) => chapter.text ?? '').join('\n\n') : ''),
      chapters: Array.isArray(data.chapters) ? data.chapters : [],
      notes: data.notes ?? '',
      sourceMessages: messages.length,
      target: result.target,
    });
  });

  /** 角色卡 → 世界书 + 剧本。`saveWorldbook: true` 时顺手把条目存成一本世界书。 */
  router.post('/api/creative/card-to-script', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    if (!body.characterId) throw new ValidationError('要指定一张角色卡（characterId）');
    const card = await cards.get(body.characterId);
    if (!card) throw new ValidationError(`没有这张角色卡：${body.characterId}`);
    const result = await runSkill('script.from_card', { card: card.data ?? card, acts: body.acts ?? 3, length: body.length ?? '' }, {
      ...body,
      characterId: body.characterId,
    });
    const data = result.data ?? {};
    const entries = Array.isArray(data.worldbook) ? data.worldbook : [];

    let savedBook = null;
    if (body.saveWorldbook) {
      const book = await worldbook.save({
        name: body.worldbookName || `${card.name} · 剧本设定`,
        characterId: card.id ?? body.characterId,
        source: 'generated',
      });
      const added = [];
      for (const entry of entries) {
        if (!entry?.content) continue;
        added.push(await worldbook.saveEntry(book.id, {
          comment: entry.comment ?? entry.name ?? '',
          keys: Array.isArray(entry.keys) ? entry.keys : [],
          content: entry.content,
          constant: entry.constant === true,
        }));
      }
      savedBook = { id: book.id, name: book.name, added: added.length };
    }

    return ctx.json(200, {
      title: data.title ?? '',
      logline: data.logline ?? '',
      worldbook: entries,
      scenes: Array.isArray(data.scenes) ? data.scenes : [],
      script: data.script ?? '',
      savedWorldbook: savedBook,
      target: result.target,
    });
  });

  /** 对话 / 文本 → 人物 / 地点 / 物品，默认顺手存进该角色（或该对话）的世界书。 */
  router.post('/api/creative/extract-entities', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    let text = String(body.text ?? '').trim();
    let chatId = body.chatId ?? null;
    if (!text) {
      const collected = requireMessages(chatId);
      text = collected.text;
    }
    if (!text) throw new ValidationError('要指定对话（chatId）或直接给一段 text');

    const result = await runSkill('chat.extract_entities', { text, maxPerKind: body.maxPerKind ?? 12 }, { ...body, chatId });
    const entities = {
      characters: Array.isArray(result.data?.characters) ? result.data.characters : [],
      places: Array.isArray(result.data?.places) ? result.data.places : [],
      items: Array.isArray(result.data?.items) ? result.data.items : [],
      relations: Array.isArray(result.data?.relations) ? result.data.relations : [],
    };
    const entries = entitiesToWorldbookEntries(entities, { prefix: '' });

    let savedBook = null;
    if (body.save !== false && entries.length) {
      const chatItem = chatId ? await chat.get(chatId) : null;
      let bookId = body.worldbookId ?? null;
      if (!bookId) {
        const characterId = body.characterId ?? chatItem?.characterId ?? null;
        const existing = characterId ? (await worldbook.list({ characterId })).items : [];
        const found = existing.find((item) => item.source === 'generated') ?? existing[0] ?? null;
        if (found) {
          bookId = found.id;
        } else {
          const title = body.worldbookName || `素材库${chatItem?.title ? `：${chatItem.title}` : ''}`;
          const book = await worldbook.save({ name: title, characterId, source: 'generated' });
          bookId = book.id;
        }
      }
      const book = await worldbook.get(bookId);
      if (!book) throw new ValidationError(`没有这本世界书：${bookId}`);
      let added = 0;
      for (const entry of entries) {
        await worldbook.saveEntry(bookId, entry);
        added += 1;
      }
      savedBook = { id: bookId, name: book.name, added };
    }

    return ctx.json(200, {
      entities,
      entries,
      counts: { characters: entities.characters.length, places: entities.places.length, items: entities.items.length, relations: entities.relations.length },
      savedWorldbook: savedBook,
      target: result.target,
    });
  });
}
