/**
 * 工坊（studio）相关的仓储：临场指令、采样器档案、套装、反向代理预设、连接档案。
 *
 * 五张表都在 SCHEMA_V12 里，全是"一份 JSON 载荷 + 几个查询列"的形状，
 * 因为这几样东西本来就没有固定模式，硬拆列只会让以后加字段要迁移。
 */

import { newId, nowIso } from '../../core/ids.mjs';
import { ValidationError, NotFoundError } from '../../core/errors.mjs';
import { fromJson } from './repo.mjs';

// ---------------------------------------------------------------- 临场指令

const NOTE_SCOPES = new Set(['default', 'character', 'chat']);

export function createNoteStore({ repo } = {}) {
  if (!repo) throw new ValidationError('createNoteStore 需要 repo');

  function normaliseScope(scope, scopeId) {
    const key = String(scope ?? '').trim();
    if (!NOTE_SCOPES.has(key)) throw new ValidationError(`临场指令的作用域只能是 default / character / chat，收到 ${scope}`);
    const id = key === 'default' ? '' : String(scopeId ?? '').trim();
    if (key !== 'default' && !id) throw new ValidationError(`${key} 层的临场指令需要指定 scopeId`);
    return { scope: key, scopeId: id };
  }

  return {
    get(scope, scopeId = '') {
      const key = normaliseScope(scope, scopeId);
      const row = repo.get('SELECT payload, updated_at FROM author_notes WHERE scope = ? AND scope_id = ?', [key.scope, key.scopeId]);
      if (!row) return null;
      const payload = fromJson(row.payload, null);
      return payload ? { ...payload, scope: key.scope, scopeId: key.scopeId, updatedAt: row.updated_at } : null;
    },
    set(scope, scopeId, payload) {
      const key = normaliseScope(scope, scopeId);
      if (!payload || typeof payload !== 'object') throw new ValidationError('临场指令载荷必须是对象');
      const stamp = nowIso();
      repo.run(
        `INSERT INTO author_notes (scope, scope_id, payload, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(scope, scope_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
        [key.scope, key.scopeId, JSON.stringify(payload), stamp],
      );
      return this.get(key.scope, key.scopeId);
    },
    remove(scope, scopeId = '') {
      const key = normaliseScope(scope, scopeId);
      const result = repo.run('DELETE FROM author_notes WHERE scope = ? AND scope_id = ?', [key.scope, key.scopeId]);
      return Number(result?.changes ?? 0) > 0;
    },
    /** 一次取三层（给提示词管线用）。 */
    layers({ characterId = null, chatId = null } = {}) {
      return {
        default: this.get('default', ''),
        character: characterId ? this.get('character', characterId) : null,
        chat: chatId ? this.get('chat', chatId) : null,
      };
    },
    list() {
      return repo
        .all('SELECT scope, scope_id, payload, updated_at FROM author_notes ORDER BY scope, scope_id')
        .map((row) => {
          const payload = fromJson(row.payload, null);
          return payload ? { ...payload, scope: row.scope, scopeId: row.scope_id, updatedAt: row.updated_at } : null;
        })
        .filter(Boolean);
    },
  };
}

// ---------------------------------------------------------------- 采样器档案

export function createSamplerStore({ repo } = {}) {
  if (!repo) throw new ValidationError('createSamplerStore 需要 repo');
  return {
    list({ backend = null } = {}) {
      const rows = backend
        ? repo.all('SELECT * FROM sampler_profiles WHERE backend = ? ORDER BY updated_at DESC', [backend])
        : repo.all('SELECT * FROM sampler_profiles ORDER BY updated_at DESC');
      return rows.map(rowToProfile).filter(Boolean);
    },
    get(id) {
      const row = repo.get('SELECT * FROM sampler_profiles WHERE id = ?', [id]);
      return row ? rowToProfile(row) : null;
    },
    save({ id = null, name, backend, payload = {} }) {
      const label = String(name ?? '').trim();
      if (!label) throw new ValidationError('采样器档案需要名字');
      const target = id ? String(id) : newId('smp');
      const stamp = nowIso();
      repo.run(
        `INSERT INTO sampler_profiles (id, name, backend, payload, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, backend = excluded.backend,
           payload = excluded.payload, updated_at = excluded.updated_at`,
        [target, label, String(backend ?? 'llamacpp'), JSON.stringify(payload), stamp],
      );
      return this.get(target);
    },
    remove(id) {
      const result = repo.run('DELETE FROM sampler_profiles WHERE id = ?', [id]);
      return Number(result?.changes ?? 0) > 0;
    },
  };
}

function rowToProfile(row) {
  const payload = fromJson(row.payload, null);
  if (!payload) return null;
  return { ...payload, id: row.id, name: row.name, backend: row.backend, updatedAt: row.updated_at };
}

// ---------------------------------------------------------------- 套装

export function createLoadoutStore({ repo } = {}) {
  if (!repo) throw new ValidationError('createLoadoutStore 需要 repo');
  return {
    list() {
      return repo
        .all('SELECT * FROM loadouts ORDER BY favorite DESC, COALESCE(last_used_at, created_at) DESC')
        .map(rowToLoadout)
        .filter(Boolean);
    },
    get(id) {
      const row = repo.get('SELECT * FROM loadouts WHERE id = ?', [id]);
      return row ? rowToLoadout(row) : null;
    },
    save({ id = null, name, payload = {}, favorite = false }) {
      const label = String(name ?? '').trim();
      if (!label) throw new ValidationError('套装需要名字');
      const target = id ? String(id) : newId('lo');
      const stamp = nowIso();
      repo.run(
        `INSERT INTO loadouts (id, name, payload, favorite, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, payload = excluded.payload, favorite = excluded.favorite`,
        [target, label, JSON.stringify(payload), favorite ? 1 : 0, stamp, stamp],
      );
      return this.get(target);
    },
    touch(id) {
      const result = repo.run('UPDATE loadouts SET last_used_at = ? WHERE id = ?', [nowIso(), id]);
      if (Number(result?.changes ?? 0) === 0) throw new NotFoundError(`套装 ${id}`);
      return this.get(id);
    },
    remove(id) {
      const result = repo.run('DELETE FROM loadouts WHERE id = ?', [id]);
      return Number(result?.changes ?? 0) > 0;
    },
  };
}

function rowToLoadout(row) {
  const payload = fromJson(row.payload, null);
  if (!payload) return null;
  const { parts, data } = payload;
  return {
    id: row.id,
    name: row.name,
    favorite: Boolean(row.favorite),
    parts: Array.isArray(parts) ? parts : [],
    payload: data && typeof data === 'object' ? data : {},
    lastUsedAt: row.last_used_at ?? null,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------- 反向代理预设

export function createProxyStore({ repo } = {}) {
  if (!repo) throw new ValidationError('createProxyStore 需要 repo');
  const toRecord = (row) => {
    const payload = fromJson(row.payload, null);
    if (!payload) return null;
    return { ...payload, id: row.id, name: row.name, providerKind: row.provider_kind, updatedAt: row.updated_at };
  };
  return {
    list({ providerKind = null } = {}) {
      const rows = providerKind
        ? repo.all('SELECT * FROM proxy_presets WHERE provider_kind = ? ORDER BY updated_at DESC', [providerKind])
        : repo.all('SELECT * FROM proxy_presets ORDER BY updated_at DESC');
      return rows.map(toRecord).filter(Boolean);
    },
    get(id) {
      const row = repo.get('SELECT * FROM proxy_presets WHERE id = ?', [id]);
      return row ? toRecord(row) : null;
    },
    save({ id = null, name, providerKind = 'chat', payload = {} }) {
      const label = String(name ?? '').trim();
      if (!label) throw new ValidationError('代理预设需要名字');
      const target = id ? String(id) : newId('px');
      repo.run(
        `INSERT INTO proxy_presets (id, name, provider_kind, payload, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, provider_kind = excluded.provider_kind,
           payload = excluded.payload, updated_at = excluded.updated_at`,
        [target, label, String(providerKind), JSON.stringify(payload), nowIso()],
      );
      return this.get(target);
    },
    remove(id) {
      const result = repo.run('DELETE FROM proxy_presets WHERE id = ?', [id]);
      return Number(result?.changes ?? 0) > 0;
    },
  };
}

// ---------------------------------------------------------------- 连接档案

export function createProfileStore({ repo } = {}) {
  if (!repo) throw new ValidationError('createProfileStore 需要 repo');
  const toRecord = (row) => {
    const payload = fromJson(row.payload, null);
    if (!payload) return null;
    return { ...payload, id: row.id, name: row.name, updatedAt: row.updated_at };
  };
  return {
    list() {
      return repo.all('SELECT * FROM connection_profiles ORDER BY updated_at DESC').map(toRecord).filter(Boolean);
    },
    get(id) {
      const row = repo.get('SELECT * FROM connection_profiles WHERE id = ?', [id]);
      return row ? toRecord(row) : null;
    },
    save({ id = null, name, payload = {} }) {
      const label = String(name ?? '').trim();
      if (!label) throw new ValidationError('连接档案需要名字');
      const target = id ? String(id) : newId('cp');
      repo.run(
        `INSERT INTO connection_profiles (id, name, payload, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, payload = excluded.payload, updated_at = excluded.updated_at`,
        [target, label, JSON.stringify(payload), nowIso()],
      );
      return this.get(target);
    },
    remove(id) {
      const result = repo.run('DELETE FROM connection_profiles WHERE id = ?', [id]);
      return Number(result?.changes ?? 0) > 0;
    },
  };
}

// ---------------------------------------------------------------- 消息书签

export function createBookmarkStore({ repo } = {}) {
  if (!repo) throw new ValidationError('createBookmarkStore 需要 repo');
  const toRecord = (row) => {
    const payload = fromJson(row.payload, null);
    if (!payload) return null;
    // 注意顺序：payload 里可能带一个 id: null，必须让行里的真 id 覆盖它。
    return { ...payload, id: row.id, createdAt: row.created_at };
  };
  return {
    list({ chatId = null, characterId = null } = {}) {
      const rows = chatId
        ? repo.all('SELECT * FROM message_bookmarks WHERE chat_id = ? ORDER BY created_at DESC', [chatId])
        : repo.all('SELECT * FROM message_bookmarks ORDER BY created_at DESC LIMIT 500');
      return rows
        .map(toRecord)
        .filter(Boolean)
        .filter((item) => (characterId ? item.characterId === characterId : true));
    },
    get(id) {
      const row = repo.get('SELECT * FROM message_bookmarks WHERE id = ?', [id]);
      return row ? toRecord(row) : null;
    },
    /** 同一条消息重复打书签 = 覆盖（唯一索引兜底）。 */
    save(bookmark) {
      const id = bookmark.id ? String(bookmark.id) : newId('bm');
      repo.run(
        `INSERT INTO message_bookmarks (id, chat_id, message_id, payload, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chat_id, message_id) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at`,
        [id, bookmark.chatId, bookmark.messageId, JSON.stringify(bookmark), nowIso()],
      );
      const row = repo.get('SELECT * FROM message_bookmarks WHERE chat_id = ? AND message_id = ?', [bookmark.chatId, bookmark.messageId]);
      return row ? toRecord(row) : null;
    },
    remove(id) {
      const result = repo.run('DELETE FROM message_bookmarks WHERE id = ?', [id]);
      return Number(result?.changes ?? 0) > 0;
    },
    removeByMessage(chatId, messageId) {
      const result = repo.run('DELETE FROM message_bookmarks WHERE chat_id = ? AND message_id = ?', [chatId, messageId]);
      return Number(result?.changes ?? 0) > 0;
    },
  };
}

// ---------------------------------------------------------------- 动作序列

export function createActionStore({ repo } = {}) {
  if (!repo) throw new ValidationError('createActionStore 需要 repo');
  const toRecord = (row) => {
    const payload = fromJson(row.payload, null);
    if (!payload) return null;
    return { ...payload, id: row.id, updatedAt: row.updated_at };
  };
  return {
    list() {
      return repo.all('SELECT * FROM action_sets ORDER BY updated_at DESC').map(toRecord).filter(Boolean);
    },
    get(id) {
      const row = repo.get('SELECT * FROM action_sets WHERE id = ?', [id]);
      return row ? toRecord(row) : null;
    },
    save(id, set) {
      const target = id ? String(id) : newId('act');
      repo.run(
        `INSERT INTO action_sets (id, name, payload, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, payload = excluded.payload, updated_at = excluded.updated_at`,
        [target, set.name, JSON.stringify(set), nowIso()],
      );
      return this.get(target);
    },
    remove(id) {
      const result = repo.run('DELETE FROM action_sets WHERE id = ?', [id]);
      return Number(result?.changes ?? 0) > 0;
    },
  };
}

// ---------------------------------------------------------------- Logit Bias 预设

export function createLogitStore({ repo } = {}) {
  if (!repo) throw new ValidationError('createLogitStore 需要 repo');
  const toRecord = (row) => {
    const payload = fromJson(row.payload, null);
    if (!payload) return null;
    return { ...payload, id: row.id, updatedAt: row.updated_at };
  };
  return {
    list() {
      return repo.all('SELECT * FROM logit_presets ORDER BY updated_at DESC').map(toRecord).filter(Boolean);
    },
    get(id) {
      const row = repo.get('SELECT * FROM logit_presets WHERE id = ?', [id]);
      return row ? toRecord(row) : null;
    },
    save(id, preset) {
      const target = id ? String(id) : newId('lg');
      repo.run(
        `INSERT INTO logit_presets (id, name, payload, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, payload = excluded.payload, updated_at = excluded.updated_at`,
        [target, preset.name, JSON.stringify(preset), nowIso()],
      );
      return this.get(target);
    },
    remove(id) {
      const result = repo.run('DELETE FROM logit_presets WHERE id = ?', [id]);
      return Number(result?.changes ?? 0) > 0;
    },
  };
}

// ---------------------------------------------------------------- 缩略图

export function createThumbnailStore({ repo } = {}) {
  if (!repo) throw new ValidationError('createThumbnailStore 需要 repo');
  return {
    get(assetId) {
      const row = repo.get('SELECT * FROM asset_thumbnails WHERE asset_id = ?', [String(assetId)]);
      return row ? { mime: row.mime, bytes: Buffer.isBuffer(row.bytes) ? row.bytes : Buffer.from(row.bytes), width: row.width, height: row.height } : null;
    },
    has(assetId) {
      return Boolean(repo.get('SELECT asset_id FROM asset_thumbnails WHERE asset_id = ?', [String(assetId)]));
    },
    save(assetId, { mime = 'image/webp', bytes, width = null, height = null } = {}) {
      if (!bytes || !bytes.length) throw new ValidationError('缩略图内容是空的');
      repo.run(
        `INSERT INTO asset_thumbnails (asset_id, mime, bytes, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(asset_id) DO UPDATE SET mime = excluded.mime, bytes = excluded.bytes,
           width = excluded.width, height = excluded.height, created_at = excluded.created_at`,
        [String(assetId), String(mime), bytes, width, height, nowIso()],
      );
      return this.get(assetId);
    },
    remove(assetId) {
      const result = repo.run('DELETE FROM asset_thumbnails WHERE asset_id = ?', [String(assetId)]);
      return Number(result?.changes ?? 0) > 0;
    },
    count() {
      const row = repo.get('SELECT COUNT(*) AS n FROM asset_thumbnails');
      return Number(row?.n ?? 0);
    },
  };
}
