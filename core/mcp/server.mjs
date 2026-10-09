/**
 * 把 Silver Tavern 变成 MCP **服务器**（蓝图 3.2「扩展性」第一条）。
 *
 * 和 core/mcp/client.mjs 刚好相反：那个是"把外面的工具接进来"，这个是
 * "把酒馆的能力递出去"，让 Codex / Claude Code 这类客户端直接读写酒馆：
 * 列角色卡、查对话、发消息触发回复、改世界书、切预设、看提示词快照。
 *
 * 两个设计点：
 *   1) 三种返回模式省 token —— summary（只有 id + 标题）/
 *      search（按关键词过滤 + 片段）/ index（标题 + 一句话概述）。
 *      模型上下文很贵，默认就用最省的 summary。
 *   2) 破坏性操作要二次确认 —— 调用时没带 confirm:true 就只返回"该做什么 +
 *      让用户确认"的提示，不落库。客户端把这句话给用户看，用户同意后再带
 *      confirm:true 调一次。这是 MCP 里最通行的做法。
 *
 * 纯逻辑：所有数据都通过注入的 services / stores 拿，所以能脱离服务器单测。
 */

export const MCP_PROTOCOL_VERSION = '2024-11-05';

export const MCP_RETURN_MODES = [
  { id: 'summary', title: '摘要', summary: '只给 id、标题和计数，最省 token（默认）' },
  { id: 'search', title: '搜索', summary: '按关键词过滤，只返回命中的那几条和片段' },
  { id: 'index', title: '索引', summary: '给较完整的索引：标题 + 一句话概述 + 标签' },
];

const MODE_IDS = MCP_RETURN_MODES.map((mode) => mode.id);

function clip(text, length = 120) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

function json(value) {
  return JSON.stringify(value, null, 2);
}

function modeOf(args = {}) {
  const mode = String(args.mode ?? 'summary');
  return MODE_IDS.includes(mode) ? mode : 'summary';
}

function limitOf(args = {}, fallback = 20, max = 100) {
  const value = Number(args.limit ?? fallback);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(max, Math.trunc(value));
}

/** 统一的 MCP 工具返回形状。 */
export function textResult(text, { isError = false } = {}) {
  return { content: [{ type: 'text', text: String(text ?? '') }], isError };
}

export function confirmResult(what, hint = null) {
  return textResult(
    [`这是会改动酒馆数据的操作：${what}。`, '先跟用户确认；用户同意后，再带 confirm: true 重新调用一次这个工具。', hint ? `提示：${hint}` : '']
      .filter(Boolean)
      .join('\n'),
    { isError: true },
  );
}

/**
 * @param {{services?:object, stores?:object, repo?:object, version?:string}} deps
 */
export function createMcpServer({ services = {}, stores = {}, repo = null, version = '0.5.2', extraTools = [] } = {}) {
  const cards = services.cards ?? {};
  const chat = services.chat ?? {};
  const worldbook = services.worldbook ?? {};
  const prompts = services.prompts ?? {};
  const cost = services.cost ?? {};

  // ---------------------------------------------------------------- 渲染

  function renderCards(list, mode, queryText = '') {
    if (!list.length) return '没有符合条件的角色卡。';
    if (mode === 'summary') return json(list.map((card) => ({ id: card.id, name: card.name })));
    if (mode === 'search') {
      const needle = String(queryText ?? '').toLowerCase();
      return json(
        list.map((card) => {
          const description = clip(card.data?.description ?? card.data?.personality ?? '', 160);
          return { id: card.id, name: card.name, match: Boolean(needle) && description.toLowerCase().includes(needle), description };
        }),
      );
    }
    return json(
      list.map((card) => ({
        id: card.id,
        name: card.name,
        specVersion: card.specVersion,
        tags: card.tags ?? [],
        favorite: Boolean(card.favorite),
        summary: clip(card.data?.description ?? card.data?.personality ?? '', 80),
        updatedAt: card.updatedAt,
      })),
    );
  }

  function renderChats(list, mode, queryText = '') {
    if (!list.length) return '没有符合条件的对话。';
    if (mode === 'summary') return json(list.map((item) => ({ id: item.id, title: item.title, messageCount: item.messageCount ?? null })));
    if (mode === 'search') {
      const needle = String(queryText ?? '').toLowerCase();
      return json(
        list.map((item) => ({
          id: item.id,
          title: item.title,
          preview: clip(item.lastMessage ?? '', 160),
          match: Boolean(needle) && String(item.lastMessage ?? '').toLowerCase().includes(needle),
        })),
      );
    }
    return json(
      list.map((item) => ({
        id: item.id,
        title: item.title,
        isGroup: Boolean(item.isGroup),
        messageCount: item.messageCount ?? null,
        lastMessage: clip(item.lastMessage ?? '', 80),
        updatedAt: item.updatedAt,
      })),
    );
  }

  function renderMessages(chatRecord, messages, mode, queryText = '', total = null) {
    const header = { chatId: chatRecord?.id ?? null, title: chatRecord?.title ?? null, total: total ?? messages.length };
    if (mode === 'summary') {
      return json({
        ...header,
        roles: messages.reduce((acc, message) => {
          acc[message.role] = (acc[message.role] ?? 0) + 1;
          return acc;
        }, {}),
      });
    }
    if (mode === 'search') {
      const needle = String(queryText ?? '').toLowerCase();
      const hits = messages.filter((message) => String(message.content ?? '').toLowerCase().includes(needle));
      return json({ ...header, hits: hits.map((message) => ({ seq: message.seq, role: message.role, name: message.name, content: clip(message.content, 240) })) });
    }
    return json({
      ...header,
      messages: messages.map((message) => ({ seq: message.seq, role: message.role, name: message.name, content: clip(message.content, 400) })),
    });
  }

  function renderEntries(book, entries, mode, queryText = '') {
    const header = { bookId: book?.id ?? null, name: book?.name ?? null, total: entries.length };
    if (mode === 'summary') return json({ ...header, comments: entries.map((entry) => entry.comment || entry.uid) });
    if (mode === 'search') {
      const needle = String(queryText ?? '').toLowerCase();
      const hits = entries.filter(
        (entry) =>
          String(entry.comment ?? '').toLowerCase().includes(needle) ||
          String(entry.content ?? '').toLowerCase().includes(needle) ||
          (entry.keys ?? []).some((key) => String(key).toLowerCase().includes(needle)),
      );
      return json({ ...header, hits: hits.map((entry) => ({ uid: entry.uid, comment: entry.comment, content: clip(entry.content, 240) })) });
    }
    return json({
      ...header,
      entries: entries.map((entry) => ({
        uid: entry.uid,
        comment: entry.comment,
        keys: entry.keys ?? [],
        constant: Boolean(entry.constant),
        enabled: entry.enabled !== false,
        content: clip(entry.content, 120),
      })),
    });
  }

  // ---------------------------------------------------------------- 工具表

  const tools = [];

  tools.push({
    name: 'cards.list',
    title: '列角色卡',
    description: '列出酒馆里的角色卡。默认只返回 id 和名字（省 token）；mode=index 会带上标签与一句话简介。',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: MODE_IDS, description: 'summary（默认）/ search / index' },
        query: { type: 'string', description: '按名字或卡内容搜索' },
        tag: { type: 'string', description: '按标签过滤' },
        favorite: { type: 'boolean', description: '只看收藏' },
        limit: { type: 'number', description: '最多返回几条，默认 20' },
      },
    },
    async handler(args) {
      const result = await cards.list({ q: args.query ?? '', tag: args.tag ?? '', favorite: args.favorite ?? null, limit: limitOf(args, 20, 200) });
      return textResult(renderCards(result.items ?? [], modeOf(args), args.query ?? ''));
    },
  });

  tools.push({
    name: 'cards.get',
    title: '看一张角色卡',
    description: '读一张角色卡的字段。mode=summary 只给名字与简介长度，index 给主要字段，full 给全量 JSON。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '角色卡 id' },
        mode: { type: 'string', enum: ['summary', 'index', 'full'], description: '默认 index' },
      },
      required: ['id'],
    },
    async handler(args) {
      const card = await cards.get(args.id);
      if (!card) return textResult(`没有这张角色卡：${args.id}`, { isError: true });
      const mode = ['summary', 'index', 'full'].includes(args.mode) ? args.mode : 'index';
      if (mode === 'summary') return textResult(json({ id: card.id, name: card.name, descriptionLength: String(card.data?.description ?? '').length }));
      if (mode === 'full') return textResult(json({ id: card.id, name: card.name, specVersion: card.specVersion, tags: card.tags, data: card.data }));
      return textResult(
        json({
          id: card.id,
          name: card.name,
          specVersion: card.specVersion,
          tags: card.tags ?? [],
          description: clip(card.data?.description, 400),
          personality: clip(card.data?.personality, 200),
          scenario: clip(card.data?.scenario, 200),
          firstMes: clip(card.data?.first_mes, 200),
        }),
      );
    },
  });

  tools.push({
    name: 'chats.list',
    title: '列对话',
    description: '列出对话（单聊与群聊）。默认只给 id / 标题 / 消息数。',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: MODE_IDS, description: 'summary（默认）/ search / index' },
        query: { type: 'string', description: '按标题或最后一条消息搜索' },
        limit: { type: 'number', description: '默认 20' },
      },
    },
    async handler(args) {
      const result = await chat.list({ search: args.query ?? '' });
      const items = (result.items ?? []).slice(0, limitOf(args, 20, 200));
      return textResult(renderChats(items, modeOf(args), args.query ?? ''));
    },
  });

  tools.push({
    name: 'chats.messages',
    title: '查对话内容',
    description: '读一个对话的消息。summary 只给条数与角色分布（最省），search 按关键词找，index 给最近若干条摘录。',
    inputSchema: {
      type: 'object',
      properties: {
        chatId: { type: 'string' },
        mode: { type: 'string', enum: MODE_IDS, description: 'summary（默认）/ search / index' },
        query: { type: 'string', description: 'mode=search 时的关键词' },
        limit: { type: 'number', description: '返回多少条，默认 20' },
      },
      required: ['chatId'],
    },
    async handler(args) {
      const record = await chat.get(args.chatId);
      if (!record) return textResult(`没有这个对话：${args.chatId}`, { isError: true });
      const all = (await chat.messages(args.chatId, {})).items ?? [];
      const mode = modeOf(args);
      const slice = mode === 'search' ? all : all.slice(-limitOf(args, 20, 200));
      return textResult(renderMessages(record, slice, mode, args.query ?? '', all.length));
    },
  });

  tools.push({
    name: 'chats.send',
    title: '发消息并触发回复',
    description: '往对话里发一条用户消息，并让绑定的模型生成回复（会消耗 token）。返回模型这一轮的正文。需要 confirm: true。',
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: {
        chatId: { type: 'string' },
        text: { type: 'string', description: '要发的内容' },
        confirm: { type: 'boolean', description: '用户确认后传 true' },
      },
      required: ['chatId', 'text'],
    },
    async handler(args) {
      if (!args.confirm) return confirmResult(`往对话 ${args.chatId} 发消息并让模型回复（要花 token）`);
      const record = await chat.get(args.chatId);
      if (!record) return textResult(`没有这个对话：${args.chatId}`, { isError: true });
      let text = '';
      let messageId = null;
      let usage = null;
      try {
        for await (const event of chat.send(args.chatId, { text: String(args.text ?? '') })) {
          if (event.type === 'delta') text += event.text ?? '';
          else if (event.type === 'done') {
            text = event.text ?? text;
            messageId = event.messageId ?? null;
            usage = event.usage ?? null;
          } else if (event.type === 'error') {
            return textResult(`生成失败：${event.message ?? event.code}`, { isError: true });
          }
        }
      } catch (err) {
        return textResult(`生成失败：${err?.message ?? err}`, { isError: true });
      }
      return textResult(json({ chatId: args.chatId, messageId, text: clip(text, 2000), usage }));
    },
  });

  tools.push({
    name: 'worldbook.list',
    title: '列世界书',
    description: '列出世界书（全局的与挂在角色卡上的）。',
    inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: MODE_IDS }, query: { type: 'string' }, limit: { type: 'number' } } },
    async handler(args) {
      const result = await worldbook.list({ search: args.query ?? '' });
      const items = (result.items ?? []).slice(0, limitOf(args, 20, 200));
      if (!items.length) return textResult('没有世界书。');
      const mode = modeOf(args);
      return textResult(
        mode === 'summary'
          ? json(items.map((item) => ({ id: item.id, name: item.name })))
          : json(items.map((item) => ({ id: item.id, name: item.name, characterId: item.characterId ?? null, source: item.source ?? null }))),
      );
    },
  });

  tools.push({
    name: 'worldbook.entries',
    title: '看世界书条目',
    description: '读一本世界书的条目。summary 只给备注名，search 按关键词找，index 给关键词 + 内容摘录。',
    inputSchema: {
      type: 'object',
      properties: { bookId: { type: 'string' }, mode: { type: 'string', enum: MODE_IDS }, query: { type: 'string' }, limit: { type: 'number' } },
      required: ['bookId'],
    },
    async handler(args) {
      const book = await worldbook.get(args.bookId);
      if (!book) return textResult(`没有这本世界书：${args.bookId}`, { isError: true });
      const items = ((await worldbook.entries(args.bookId)).items ?? []).slice(0, limitOf(args, 50, 500));
      return textResult(renderEntries(book, items, modeOf(args), args.query ?? ''));
    },
  });

  tools.push({
    name: 'worldbook.saveEntry',
    title: '写世界书条目',
    description: '新增或修改一条世界书条目（带 uid 就是改，不带就是新增）。需要 confirm: true。',
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: {
        bookId: { type: 'string' },
        uid: { type: 'string', description: '要改的条目 uid；留空表示新增' },
        comment: { type: 'string', description: '备注名' },
        content: { type: 'string' },
        keys: { type: 'array', items: { type: 'string' } },
        secondaryKeys: { type: 'array', items: { type: 'string' } },
        constant: { type: 'boolean' },
        confirm: { type: 'boolean' },
      },
      required: ['bookId', 'content'],
    },
    async handler(args) {
      if (!args.confirm) return confirmResult(`改写世界书 ${args.bookId} 里的一条条目`);
      const book = await worldbook.get(args.bookId);
      if (!book) return textResult(`没有这本世界书：${args.bookId}`, { isError: true });
      const saved = await worldbook.saveEntry(args.bookId, {
        uid: args.uid ?? null,
        comment: args.comment ?? '',
        content: String(args.content ?? ''),
        keys: args.keys ?? [],
        secondaryKeys: args.secondaryKeys ?? [],
        constant: Boolean(args.constant),
      });
      return textResult(json({ ok: true, bookId: args.bookId, uid: saved?.uid ?? args.uid ?? null }));
    },
  });

  tools.push({
    name: 'worldbook.removeEntry',
    title: '删世界书条目',
    description: '删掉一条世界书条目（不可恢复）。需要 confirm: true。',
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: { bookId: { type: 'string' }, uid: { type: 'string' }, confirm: { type: 'boolean' } },
      required: ['bookId', 'uid'],
    },
    async handler(args) {
      if (!args.confirm) return confirmResult(`删掉世界书 ${args.bookId} 里的条目 ${args.uid}（删了就找不回来）`);
      const book = await worldbook.get(args.bookId);
      if (!book) return textResult(`没有这本世界书：${args.bookId}`, { isError: true });
      await worldbook.removeEntry(args.bookId, args.uid);
      return textResult(json({ ok: true, bookId: args.bookId, uid: args.uid }));
    },
  });

  tools.push({
    name: 'presets.list',
    title: '列提示词预设',
    description: '列出提示词预设（酒馆预设）。',
    inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: MODE_IDS }, limit: { type: 'number' } } },
    async handler(args) {
      const result = await prompts.listPresets({});
      const items = (result.items ?? []).slice(0, limitOf(args, 30, 200));
      if (!items.length) return textResult('还没有提示词预设。');
      const mode = modeOf(args);
      return textResult(
        json(items.map((item) => ({ id: item.id, name: item.name, kind: item.kind, promptCount: mode === 'summary' ? undefined : (item.data?.prompts ?? []).length }))),
      );
    },
  });

  tools.push({
    name: 'presets.use',
    title: '给对话切预设',
    description: '把一个提示词预设挂到某个对话上（之后每一轮都用它组装提示词）；presetId 传空表示取消。需要 confirm: true。',
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: { chatId: { type: 'string' }, presetId: { type: 'string', description: '传空字符串表示取消预设' }, confirm: { type: 'boolean' } },
      required: ['chatId'],
    },
    async handler(args) {
      const record = await chat.get(args.chatId);
      if (!record) return textResult(`没有这个对话：${args.chatId}`, { isError: true });
      if (!args.confirm) return confirmResult(`把对话 ${args.chatId} 的提示词预设换成 ${args.presetId || '（取消预设）'}，之后每一轮都会变`);
      if (args.presetId) {
        const preset = await prompts.getPreset(args.presetId);
        if (!preset) return textResult(`没有这个预设：${args.presetId}`, { isError: true });
      }
      const settingsNext = { ...(record.settings ?? {}) };
      if (args.presetId) settingsNext.presetId = String(args.presetId);
      else delete settingsNext.presetId;
      await chat.update(args.chatId, { settings: settingsNext });
      return textResult(json({ ok: true, chatId: args.chatId, presetId: settingsNext.presetId ?? null }));
    },
  });

  tools.push({
    name: 'prompts.xray',
    title: '看上一轮的提示词',
    description: '看某个对话最近一轮真正发出去的提示词（X 光机）。summary 只给分段与 token，index 给每段内容摘录。',
    inputSchema: {
      type: 'object',
      properties: { chatId: { type: 'string' }, mode: { type: 'string', enum: ['summary', 'index'] }, limit: { type: 'number' } },
      required: ['chatId'],
    },
    async handler(args) {
      if (typeof stores.xrayList !== 'function') return textResult('这一版没有接上提示词快照的存储', { isError: true });
      const rows = stores.xrayList({ chatId: args.chatId, limit: limitOf(args, 1, 10), includeText: true });
      if (!rows.length) return textResult(`对话 ${args.chatId} 还没有提示词快照。`);
      const mode = args.mode === 'index' ? 'index' : 'summary';
      return textResult(
        json(
          rows.map((row) => ({
            id: row.id,
            createdAt: row.createdAt,
            model: row.model,
            tokens: row.tokens,
            notes: row.notes ?? [],
            sections: (row.sections ?? []).map((section) => ({
              id: section.id,
              title: section.title,
              tokens: section.tokens,
              source: section.source,
              ...(mode === 'index' ? { content: clip(section.content, 400) } : {}),
            })),
          })),
        ),
      );
    },
  });

  tools.push({
    name: 'stats.overview',
    title: '酒馆总览',
    description: '角色卡 / 对话 / 消息 / 花费的总体计数，用来先摸清库里有什么。',
    inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: MODE_IDS } } },
    async handler() {
      const cardStats = typeof cards.stats === 'function' ? await cards.stats() : {};
      const chatList = await chat.list({});
      const messageTotal = (chatList.items ?? []).reduce((sum, item) => sum + Number(item.messageCount ?? 0), 0);
      let usage = null;
      try {
        if (typeof cost.summary === 'function') usage = (await cost.summary({})).totals;
      } catch {
        usage = null;
      }
      return textResult(
        json({
          cards: cardStats?.total ?? 0,
          favorites: cardStats?.favorites ?? 0,
          chats: chatList.total ?? 0,
          messages: messageTotal,
          usage: usage ? { turns: usage.turns, cost: usage.cost, totalTokens: usage.totalTokens } : null,
          version,
        }),
      );
    },
  });

  // 插件注册的 MCP 工具：同名不覆盖内置的（内置是行为契约，不能被插件悄悄改掉）。
  for (const tool of extraTools) {
    const name = String(tool?.name ?? '').trim();
    if (!name || typeof tool.handler !== 'function') continue;
    if (tools.some((item) => item.name === name)) continue;
    tools.push({
      name,
      title: tool.title ?? name,
      description: tool.description ?? '',
      destructive: Boolean(tool.destructive),
      inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
      async handler(args = {}) {
        const out = await tool.handler(args);
        if (out && Array.isArray(out.content)) return out;
        return textResult(typeof out === 'string' ? out : json(out ?? null));
      },
    });
  }

  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  function listTools() {
    return tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.destructive ? { destructiveHint: true } : undefined,
    }));
  }

  async function callTool(name, args = {}) {
    const tool = byName.get(String(name ?? ''));
    if (!tool) return textResult(`没有这个工具：${name}。可用工具：${tools.map((item) => item.name).join(', ')}`, { isError: true });
    try {
      return await tool.handler(args ?? {});
    } catch (err) {
      return textResult(`${tool.name} 执行失败：${err?.message ?? err}`, { isError: true });
    }
  }

  return {
    version,
    listTools,
    callTool,
    get toolCount() {
      return tools.length;
    },
  };
}
