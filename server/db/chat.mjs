/**
 * 玩卡区的存储层：对话、消息、群聊成员、变量、快照、候选行动。
 *
 * core/chat/service.mjs 只依赖一组抽象方法（store 端口），真正的 SQL 全在这里。
 * 行 → 对象时统一做 JSON 解析与布尔转换，别让上层再关心存储细节。
 *
 * 时间一律 ISO 字符串（和 schema 的约定一致），排序即时间序。
 */

import { newId, nowIso } from '../../core/ids.mjs';
import { fromJson } from './repo.mjs';
import { NotFoundError, ValidationError } from '../../core/errors.mjs';

const CHAT_COLUMNS = `id, title, character_id, persona, settings, world_state, is_group, group_strategy,
  group_mode, auto_mode_delay, parent_chat_id, branch_from_message_id, branch_label,
  last_message_at, created_at, updated_at`;

function chatToObject(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title ?? '',
    characterId: row.character_id ?? null,
    characterName: row.character_name ?? '',
    persona: fromJson(row.persona, {}),
    settings: fromJson(row.settings, {}),
    worldState: fromJson(row.world_state, {}),
    isGroup: Boolean(row.is_group),
    groupStrategy: row.group_strategy ?? 'natural',
    groupMode: row.group_mode ?? 'swap',
    autoModeDelay: row.auto_mode_delay ?? 5,
    parentChatId: row.parent_chat_id ?? null,
    branchFromMessageId: row.branch_from_message_id ?? null,
    branchLabel: row.branch_label ?? null,
    lastMessageAt: row.last_message_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count !== undefined ? Number(row.message_count) : undefined,
    lastMessage: row.last_message_preview ?? undefined,
  };
}

function memberToObject(row) {
  if (!row) return null;
  return {
    id: row.id,
    chatId: row.chat_id,
    characterId: row.character_id ?? null,
    name: row.name,
    card: fromJson(row.card, {}),
    talkativeness: row.talkativeness ?? 0.5,
    muted: Boolean(row.muted),
    orderIndex: row.order_index ?? 0,
    overrides: fromJson(row.overrides, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function messageToObject(row) {
  if (!row) return null;
  const swipes = fromJson(row.swipes, []);
  return {
    id: row.id,
    chatId: row.chat_id,
    seq: row.seq,
    role: row.role,
    characterId: row.character_id ?? null,
    memberId: row.member_id ?? null,
    name: row.name ?? '',
    content: row.content ?? '',
    hidden: Boolean(row.hidden),
    isSystem: Boolean(row.is_system),
    swipes: Array.isArray(swipes) && swipes.length ? swipes : [row.content ?? ''],
    swipeId: row.swipe_id ?? 0,
    tokens: row.tokens === null || row.tokens === undefined ? null : Number(row.tokens),
    cost: row.cost === null || row.cost === undefined ? null : Number(row.cost),
    model: row.model ?? null,
    providerId: row.provider_id ?? null,
    extra: fromJson(row.extra, {}),
    createdAt: row.created_at,
    chatTitle: row.chat_title ?? undefined,
  };
}

/** 允许写入消息的字段；其它字段一律忽略，避免上层随手塞进来的东西污染存储。 */
function messagePatch(patch = {}) {
  const out = {};
  if (patch.role !== undefined) out.role = String(patch.role);
  if (patch.characterId !== undefined) out.character_id = patch.characterId ? String(patch.characterId) : null;
  if (patch.memberId !== undefined) out.member_id = patch.memberId ? String(patch.memberId) : null;
  if (patch.name !== undefined) out.name = String(patch.name ?? '');
  if (patch.content !== undefined) out.content = String(patch.content ?? '');
  if (patch.hidden !== undefined) out.hidden = patch.hidden ? 1 : 0;
  if (patch.isSystem !== undefined) out.is_system = patch.isSystem ? 1 : 0;
  if (patch.swipes !== undefined) out.swipes = JSON.stringify(Array.isArray(patch.swipes) ? patch.swipes : []);
  if (patch.swipeId !== undefined) out.swipe_id = Number(patch.swipeId) || 0;
  if (patch.tokens !== undefined) out.tokens = patch.tokens === null ? null : Number(patch.tokens);
  if (patch.cost !== undefined) out.cost = patch.cost === null ? null : Number(patch.cost);
  if (patch.model !== undefined) out.model = patch.model ? String(patch.model) : null;
  if (patch.providerId !== undefined) out.provider_id = patch.providerId ? String(patch.providerId) : null;
  if (patch.extra !== undefined) out.extra = JSON.stringify(patch.extra ?? {});
  return out;
}

/**
 * 把一个素材从所有消息的 extra.images 里摘掉 —— 删素材 / 删图时用，
 * 免得聊天里留下一张裂图。只动真正引用到它的消息（extra.images 既可能是 id 字符串，
 * 也可能是 { assetId } 对象，两种都认）。返回改动过的消息数。
 */
export function detachAssetRefs(repo, assetId) {
  const id = String(assetId ?? '');
  if (!id || !repo) return 0;
  let touched = 0;
  for (const row of repo.all('SELECT id, chat_id, extra FROM chat_messages WHERE extra LIKE ?', [`%${id}%`])) {
    let extra;
    try {
      extra = JSON.parse(row.extra ?? '{}');
    } catch {
      continue;
    }
    const images = Array.isArray(extra?.images) ? extra.images : null;
    if (!images) continue;
    const kept = images.filter((entry) => String(typeof entry === 'string' ? entry : entry?.assetId ?? entry?.id ?? '') !== id);
    if (kept.length === images.length) continue;
    repo.run('UPDATE chat_messages SET extra = ? WHERE id = ?', [JSON.stringify({ ...extra, images: kept }), row.id]);
    repo.run('UPDATE chats SET updated_at = ? WHERE id = ?', [nowIso(), row.chat_id]);
    touched += 1;
  }
  return touched;
}

export function createChatStore({ repo }) {
  // ---------------------------------------------------------------- 对话

  function listChats({ group = null, search = '', characterId = null } = {}) {
    const where = [];
    const params = [];
    if (group === true) where.push('c.is_group = 1');
    if (group === false) where.push('c.is_group = 0');
    // 一张卡 → 多个对话：卡库 / 卡编辑器 / 对话页都用它把"这张卡的对话"捞出来。
    if (characterId) {
      where.push('c.character_id = ?');
      params.push(String(characterId));
    }
    if (search) {
      where.push('c.title LIKE ?');
      params.push(`%${search}%`);
    }
    // 带上这张卡的名字：对话页左栏要"按卡分组"，多对话收在同一张卡下面。
    // 用相关子查询而不是 JOIN —— 免得 characters 的 id / created_at 跟 chats 撞名。
    const sql = `SELECT ${CHAT_COLUMNS},
        (SELECT name FROM characters WHERE id = c.character_id) AS character_name,
        (SELECT COUNT(*) FROM chat_messages m WHERE m.chat_id = c.id) AS message_count,
        (SELECT SUBSTR(m.content, 1, 80) FROM chat_messages m WHERE m.chat_id = c.id ORDER BY m.seq DESC LIMIT 1) AS last_message_preview
      FROM chats c
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY COALESCE(c.last_message_at, c.updated_at) DESC`;
    return repo.all(sql, params).map(chatToObject);
  }

  function getChat(id) {
    const row = repo.get(`SELECT ${CHAT_COLUMNS} FROM chats WHERE id = ?`, [id]);
    if (!row) return null;
    const chat = chatToObject(row);
    chat.members = listMembers(id);
    chat.messageCount = repo.get('SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = ?', [id])?.n ?? 0;
    return chat;
  }

  function createChat(input = {}) {
    const now = nowIso();
    const id = input.id ? String(input.id) : newId('chat');
    const title = String(input.title ?? '').trim() || '新对话';
    repo.run(
      `INSERT INTO chats (id, title, character_id, persona, settings, world_state, is_group, group_strategy,
         group_mode, auto_mode_delay, parent_chat_id, branch_from_message_id, branch_label,
         last_message_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        title,
        input.characterId ?? null,
        JSON.stringify(input.persona ?? {}),
        JSON.stringify(input.settings ?? {}),
        JSON.stringify(input.worldState ?? {}),
        input.isGroup ? 1 : 0,
        input.groupStrategy ?? 'natural',
        input.groupMode ?? 'swap',
        input.autoModeDelay ?? 5,
        input.parentChatId ?? null,
        input.branchFromMessageId ?? null,
        input.branchLabel ?? null,
        null,
        now,
        now,
      ],
    );
    return getChat(id);
  }

  const CHAT_PATCH_COLUMNS = {
    title: 'title',
    characterId: 'character_id',
    persona: 'persona',
    settings: 'settings',
    worldState: 'world_state',
    isGroup: 'is_group',
    groupStrategy: 'group_strategy',
    groupMode: 'group_mode',
    autoModeDelay: 'auto_mode_delay',
    parentChatId: 'parent_chat_id',
    branchFromMessageId: 'branch_from_message_id',
    branchLabel: 'branch_label',
    lastMessageAt: 'last_message_at',
  };
  const JSON_PATCH_FIELDS = new Set(['persona', 'settings', 'worldState']);
  const BOOL_PATCH_FIELDS = new Set(['isGroup']);

  function updateChat(id, patch = {}) {
    const existing = repo.get('SELECT id FROM chats WHERE id = ?', [id]);
    if (!existing) throw new NotFoundError(`对话 ${id}`);
    const sets = [];
    const params = [];
    for (const [key, column] of Object.entries(CHAT_PATCH_COLUMNS)) {
      if (patch[key] === undefined) continue;
      sets.push(`${column} = ?`);
      let value = patch[key];
      if (JSON_PATCH_FIELDS.has(key)) value = JSON.stringify(value ?? {});
      else if (BOOL_PATCH_FIELDS.has(key)) value = value ? 1 : 0;
      params.push(value);
    }
    sets.push('updated_at = ?');
    params.push(patch.updatedAt ?? nowIso());
    params.push(id);
    repo.run(`UPDATE chats SET ${sets.join(', ')} WHERE id = ?`, params);
    return getChat(id);
  }

  function deleteChat(id) {
    const existing = repo.get('SELECT id FROM chats WHERE id = ?', [id]);
    if (!existing) throw new NotFoundError(`对话 ${id}`);
    repo.run('DELETE FROM chats WHERE id = ?', [id]);
    return true;
  }

  // ---------------------------------------------------------------- 消息

  function listMessages(chatId, { limit = null, afterSeq = null } = {}) {
    let sql = `SELECT * FROM chat_messages WHERE chat_id = ?`;
    const params = [chatId];
    if (afterSeq !== null && afterSeq !== undefined) {
      sql += ' AND seq > ?';
      params.push(Number(afterSeq));
    }
    sql += ' ORDER BY seq ASC';
    const rows = repo.all(sql, params).map(messageToObject);
    return limit ? rows.slice(-Number(limit)) : rows;
  }

  function getMessage(chatId, messageId) {
    return messageToObject(repo.get('SELECT * FROM chat_messages WHERE id = ? AND chat_id = ?', [messageId, chatId]));
  }

  function nextSeq(chatId) {
    return Number(repo.get('SELECT COALESCE(MAX(seq), 0) AS n FROM chat_messages WHERE chat_id = ?', [chatId])?.n ?? 0) + 1;
  }

  function insertMessageRow(chatId, seq, message) {
    const id = message.id ? String(message.id) : newId('msg');
    const patch = messagePatch({ role: 'assistant', ...message });
    repo.run(
      `INSERT INTO chat_messages (id, chat_id, seq, role, character_id, member_id, name, content, hidden, is_system,
         swipes, swipe_id, tokens, cost, model, provider_id, extra, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        chatId,
        seq,
        patch.role ?? 'assistant',
        patch.character_id ?? null,
        patch.member_id ?? null,
        patch.name ?? '',
        patch.content ?? '',
        patch.hidden ?? 0,
        patch.is_system ?? 0,
        patch.swipes ?? JSON.stringify(message.content ? [message.content] : []),
        patch.swipe_id ?? 0,
        patch.tokens ?? null,
        patch.cost ?? null,
        patch.model ?? null,
        patch.provider_id ?? null,
        patch.extra ?? '{}',
        message.createdAt ?? nowIso(),
      ],
    );
    return getMessage(chatId, id);
  }

  function appendMessage(chatId, message = {}) {
    const seq = nextSeq(chatId);
    const row = insertMessageRow(chatId, seq, message);
    repo.run('UPDATE chats SET last_message_at = ?, updated_at = ? WHERE id = ?', [
      row.createdAt,
      nowIso(),
      chatId,
    ]);
    return row;
  }

  /**
   * 在 afterMessageId 后面插一条；后面的消息整体后移一位。
   *
   * 后移要分两步走负数：`UPDATE ... SET seq = seq + 1` 在 SQLite 里逐行更新，
   * 中间会撞上 UNIQUE(chat_id, seq)（插在对话中间时必现，报
   * "UNIQUE constraint failed"）。先取负数再翻正就绕开了瞬时冲突。
   */
  function insertMessageAfter(chatId, afterMessageId, message = {}) {
    const after = afterMessageId
      ? repo.get('SELECT seq FROM chat_messages WHERE id = ? AND chat_id = ?', [afterMessageId, chatId])
      : null;
    // 锚点不在这个对话里是调用方传错了，别默默插到最前面。
    if (afterMessageId && !after) throw new NotFoundError(`这个对话里没有这条消息：${afterMessageId}`);
    const seq = after ? Number(after.seq) + 1 : 1;
    return repo.transaction(() => {
      repo.run('UPDATE chat_messages SET seq = -seq WHERE chat_id = ? AND seq >= ?', [chatId, seq]);
      repo.run('UPDATE chat_messages SET seq = -seq + 1 WHERE chat_id = ? AND seq <= ?', [chatId, -seq]);
      const row = insertMessageRow(chatId, seq, message);
      repo.run('UPDATE chats SET updated_at = ? WHERE id = ?', [nowIso(), chatId]);
      return row;
    });
  }

  function updateMessage(chatId, messageId, patch = {}) {
    const existing = repo.get('SELECT id FROM chat_messages WHERE id = ? AND chat_id = ?', [messageId, chatId]);
    if (!existing) throw new NotFoundError(`消息 ${messageId}`);
    const clean = messagePatch(patch);
    const sets = Object.entries(clean).map(([column]) => `${column} = ?`);
    const params = Object.values(clean);
    if (sets.length) {
      params.push(messageId, chatId);
      repo.run(`UPDATE chat_messages SET ${sets.join(', ')} WHERE id = ? AND chat_id = ?`, params);
    }
    repo.run('UPDATE chats SET updated_at = ? WHERE id = ?', [nowIso(), chatId]);
    return getMessage(chatId, messageId);
  }

  function deleteMessage(chatId, messageId) {
    const existing = repo.get('SELECT id FROM chat_messages WHERE id = ? AND chat_id = ?', [messageId, chatId]);
    if (!existing) throw new NotFoundError(`消息 ${messageId}`);
    repo.run('DELETE FROM chat_messages WHERE id = ? AND chat_id = ?', [messageId, chatId]);
    return true;
  }

  /** 重新生成用：删掉这条及其之后的全部消息。 */
  function deleteMessagesFrom(chatId, messageId) {
    const row = repo.get('SELECT seq FROM chat_messages WHERE id = ? AND chat_id = ?', [messageId, chatId]);
    if (!row) throw new NotFoundError(`消息 ${messageId}`);
    repo.run('DELETE FROM chat_messages WHERE chat_id = ? AND seq >= ?', [chatId, row.seq]);
    return true;
  }

  function searchMessages({ query = '', limit = 50 } = {}) {
    const q = String(query ?? '').trim();
    if (!q) return [];
    return repo
      .all(
        `SELECT m.*, c.title AS chat_title FROM chat_messages m
           JOIN chats c ON c.id = m.chat_id
          WHERE m.content LIKE ?
          ORDER BY m.created_at DESC
          LIMIT ?`,
        [`%${q}%`, Number(limit) || 50],
      )
      .map(messageToObject);
  }

  // ---------------------------------------------------------------- 成员

  function listMembers(chatId) {
    return repo
      .all('SELECT * FROM chat_members WHERE chat_id = ? ORDER BY order_index, created_at', [chatId])
      .map(memberToObject);
  }

  function getMember(memberId) {
    return memberToObject(repo.get('SELECT * FROM chat_members WHERE id = ?', [memberId]));
  }

  function addMember(chatId, member = {}) {
    if (!repo.get('SELECT id FROM chats WHERE id = ?', [chatId])) throw new NotFoundError(`对话 ${chatId}`);
    const now = nowIso();
    const id = member.id ? String(member.id) : newId('mem');
    const order =
      member.orderIndex ?? Number(repo.get('SELECT COALESCE(MAX(order_index), -1) AS n FROM chat_members WHERE chat_id = ?', [chatId])?.n ?? -1) + 1;
    repo.run(
      `INSERT INTO chat_members (id, chat_id, character_id, name, card, talkativeness, muted, order_index, overrides, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        chatId,
        member.characterId ?? null,
        String(member.name ?? member.card?.name ?? '角色'),
        JSON.stringify(member.card ?? {}),
        member.talkativeness ?? 0.5,
        member.muted ? 1 : 0,
        order,
        JSON.stringify(member.overrides ?? {}),
        now,
        now,
      ],
    );
    return getMember(id);
  }

  const MEMBER_PATCH = { characterId: 'character_id', name: 'name', card: 'card', talkativeness: 'talkativeness', muted: 'muted', orderIndex: 'order_index', overrides: 'overrides' };

  function updateMember(memberId, patch = {}) {
    if (!getMember(memberId)) throw new NotFoundError(`群聊成员 ${memberId}`);
    const sets = [];
    const params = [];
    for (const [key, column] of Object.entries(MEMBER_PATCH)) {
      if (patch[key] === undefined) continue;
      sets.push(`${column} = ?`);
      let value = patch[key];
      if (key === 'card' || key === 'overrides') value = JSON.stringify(value ?? {});
      else if (key === 'muted') value = value ? 1 : 0;
      params.push(value);
    }
    sets.push('updated_at = ?');
    params.push(nowIso(), memberId);
    repo.run(`UPDATE chat_members SET ${sets.join(', ')} WHERE id = ?`, params);
    return getMember(memberId);
  }

  function removeMember(memberId) {
    if (!getMember(memberId)) throw new NotFoundError(`群聊成员 ${memberId}`);
    repo.run('DELETE FROM chat_members WHERE id = ?', [memberId]);
    return true;
  }

  // ---------------------------------------------------------------- 变量

  function listVariables(chatId, { scope = null, characterId = null } = {}) {
    let sql = 'SELECT * FROM chat_variables WHERE chat_id = ?';
    const params = [chatId];
    if (scope) {
      sql += ' AND scope = ?';
      params.push(scope);
    }
    if (characterId !== null) {
      sql += ' AND character_id = ?';
      params.push(String(characterId));
    }
    sql += ' ORDER BY key';
    return repo.all(sql, params).map((row) => ({
      id: row.id,
      chatId: row.chat_id,
      characterId: row.character_id,
      scope: row.scope,
      key: row.key,
      value: fromJson(row.value, null),
      label: row.label ?? null,
      updatedAt: row.updated_at,
    }));
  }

  function setVariable(chatId, { scope = 'chat', characterId = '', key, value, label = null } = {}) {
    const name = String(key ?? '').trim();
    if (!name) throw new ValidationError('变量需要一个 key');
    const existing = repo.get(
      'SELECT id FROM chat_variables WHERE chat_id = ? AND scope = ? AND character_id = ? AND key = ?',
      [chatId, scope, String(characterId ?? ''), name],
    );
    const id = existing?.id ?? newId('var');
    const now = nowIso();
    repo.run(
      `INSERT INTO chat_variables (id, chat_id, character_id, scope, key, value, label, updated_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET value = excluded.value, label = excluded.label, updated_at = excluded.updated_at`,
      [id, chatId, String(characterId ?? ''), scope, name, JSON.stringify(value ?? null), label, now],
    );
    return listVariables(chatId, { scope, characterId: String(characterId ?? '') }).find((item) => item.key === name) ?? null;
  }

  function deleteVariable(chatId, { scope = 'chat', characterId = '', key } = {}) {
    repo.run('DELETE FROM chat_variables WHERE chat_id = ? AND scope = ? AND character_id = ? AND key = ?', [
      chatId,
      scope,
      String(characterId ?? ''),
      String(key ?? ''),
    ]);
    return true;
  }

  function replaceVariables(chatId, variables = []) {
    // 不用 transaction 包起来：setVariable 自己会 upsert，这里只需要保证先清后写。
    repo.run('DELETE FROM chat_variables WHERE chat_id = ?', [chatId]);
    for (const item of variables) setVariable(chatId, item);
    return listVariables(chatId);
  }

  // ---------------------------------------------------------------- 快照与行动

  function listSnapshots(chatId) {
    return repo
      .all('SELECT * FROM chat_snapshots WHERE chat_id = ? ORDER BY created_at DESC', [chatId])
      .map((row) => ({
        id: row.id,
        chatId: row.chat_id,
        messageId: row.message_id ?? null,
        label: row.label ?? '',
        variables: fromJson(row.variables, []),
        worldState: fromJson(row.world_state, {}),
        createdAt: row.created_at,
      }));
  }

  function addSnapshot(chatId, { label = '', messageId = null, variables = [], worldState = {} } = {}) {
    const id = newId('snap');
    const now = nowIso();
    repo.run(
      `INSERT INTO chat_snapshots (id, chat_id, message_id, label, variables, world_state, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [id, chatId, messageId, label, JSON.stringify(variables), JSON.stringify(worldState), now],
    );
    return listSnapshots(chatId).find((item) => item.id === id) ?? null;
  }

  function getSnapshot(id) {
    const row = repo.get('SELECT * FROM chat_snapshots WHERE id = ?', [id]);
    if (!row) return null;
    return {
      id: row.id,
      chatId: row.chat_id,
      messageId: row.message_id ?? null,
      label: row.label ?? '',
      variables: fromJson(row.variables, []),
      worldState: fromJson(row.world_state, {}),
      createdAt: row.created_at,
    };
  }

  function removeSnapshot(id) {
    repo.run('DELETE FROM chat_snapshots WHERE id = ?', [id]);
    return true;
  }

  function saveActions(chatId, { messageId = null, options = [] } = {}) {
    const id = newId('act');
    repo.run('INSERT INTO chat_actions (id, chat_id, message_id, options, created_at) VALUES (?,?,?,?,?)', [
      id,
      chatId,
      messageId,
      JSON.stringify(options),
      nowIso(),
    ]);
    return { id, chatId, messageId, options, createdAt: nowIso() };
  }

  function latestActions(chatId) {
    const row = repo.get('SELECT * FROM chat_actions WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1', [chatId]);
    if (!row) return null;
    return {
      id: row.id,
      chatId: row.chat_id,
      messageId: row.message_id ?? null,
      options: fromJson(row.options, []),
      createdAt: row.created_at,
    };
  }

  return {
    listChats,
    getChat,
    createChat,
    updateChat,
    deleteChat,
    listMessages,
    getMessage,
    appendMessage,
    insertMessageAfter,
    updateMessage,
    deleteMessage,
    deleteMessagesFrom,
    nextSeq,
    searchMessages,
    listMembers,
    getMember,
    addMember,
    updateMember,
    removeMember,
    listVariables,
    setVariable,
    deleteVariable,
    replaceVariables,
    listSnapshots,
    addSnapshot,
    getSnapshot,
    removeSnapshot,
    saveActions,
    latestActions,
  };
}
