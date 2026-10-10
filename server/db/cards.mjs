/**
 * 角色卡的存储层：characters / character_tags / character_versions 三张表。
 *
 * core/cards/service.mjs 只依赖这一组抽象方法（store 端口），SQL 全在这里。
 * 返回对象统一做 JSON 解析与布尔转换，形状对齐 core/contracts.mjs 的 cardRecord。
 *
 * 头像：PNG 卡的文件本身就是头像，导入时把它落到 <数据目录>/cards/<id>.png，
 * 并把相对路径记在 characters.avatar_asset_id 上（真正接入 assets 表之前先这样，
 * 语义一致、路径可控，导出 PNG 卡时能把它读回来）。
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import { newId, nowIso } from '../../core/ids.mjs';
import { fromJson } from './repo.mjs';
import { NotFoundError, ValidationError } from '../../core/errors.mjs';

const CARD_COLUMNS = `id, name, spec_version, data, avatar_asset_id, source, favorite, created_at, updated_at`;

/** 剧本状态存在单独一张表里（见 schema V19），取的时候现查一下；没标就是 ''。 */
const STATUS_SELECT = `(SELECT s.status FROM character_status s WHERE s.character_id = c.id) AS status`;

/** 写状态：没有就插，有就改。 */
function writeStatus(repo, id, status, now) {
  repo.run(
    `INSERT INTO character_status (character_id, status, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(character_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
    [id, String(status ?? ''), now],
  );
}

function rowToCard(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    specVersion: row.spec_version ?? 'v2',
    data: fromJson(row.data, {}),
    avatarAssetId: row.avatar_asset_id ?? null,
    source: row.source ?? 'original',
    favorite: Boolean(row.favorite),
    status: row.status ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tags: [],
    versionCount: row.version_count !== undefined ? Number(row.version_count) : undefined,
    // 这张卡开过几个**单聊**对话（群聊不算——群聊有自己的入口）。卡库列表与编辑器拿它显示"N 个对话"。
    chatCount: row.chat_count !== undefined ? Number(row.chat_count) : undefined,
  };
}

function toTags(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    const tag = String(raw ?? '').trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

export function createCardStore({ repo, dataDir = null }) {
  // ---------------------------------------------------------------- 头像文件

  function avatarDir() {
    if (!dataDir) throw new ValidationError('没有配置数据目录，无法保存头像');
    const dir = path.join(dataDir, 'cards');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function saveAvatar(id, buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
    const file = path.join(avatarDir(), `${id}.png`);
    writeFileSync(file, buffer);
    return `cards/${id}.png`;
  }

  function readAvatar(id) {
    const row = repo.get('SELECT avatar_asset_id FROM characters WHERE id = ?', [id]);
    if (!row?.avatar_asset_id) return null;
    const rel = String(row.avatar_asset_id);
    // 只认我们写下的相对路径，别让脏数据读出去。
    if (!rel.startsWith('cards/')) return null;
    const file = path.join(dataDir ?? '', rel);
    if (!existsSync(file)) return null;
    return readFileSync(file);
  }

  // ---------------------------------------------------------------- 标签

  function attachTags(cards) {
    if (!cards.length) return cards;
    const ids = cards.map((card) => card.id);
    const placeholders = ids.map(() => '?').join(',');
    const rows = repo.all(
      // 不排序：按写入顺序返回，卡上的标签顺序才有意义。
      `SELECT character_id, tag FROM character_tags WHERE character_id IN (${placeholders})`,
      ids,
    );
    const byCard = new Map();
    for (const row of rows) {
      if (!byCard.has(row.character_id)) byCard.set(row.character_id, []);
      byCard.get(row.character_id).push(row.tag);
    }
    for (const card of cards) {
      const fromTable = byCard.get(card.id) ?? [];
      // 标签表用 (character_id, tag) 做主键，取出来是按键排序的；
      // 卡里 data.tags 的顺序才是作者写的顺序，用它来还原展示顺序。
      const preferred = Array.isArray(card.data?.tags) ? card.data.tags.map(String) : [];
      const out = [];
      for (const tag of preferred) if (fromTable.includes(tag) && !out.includes(tag)) out.push(tag);
      for (const tag of fromTable) if (!out.includes(tag)) out.push(tag);
      card.tags = out;
    }
    return cards;
  }

  function setTags(id, tags) {
    const list = toTags(tags);
    repo.run('DELETE FROM character_tags WHERE character_id = ?', [id]);
    for (const tag of list) {
      repo.run('INSERT OR IGNORE INTO character_tags (character_id, tag) VALUES (?, ?)', [id, tag]);
    }
    return list;
  }

  // ---------------------------------------------------------------- 查询

  function list({ q = '', tag = '', favorite = null, source = '', status = '', sort = 'updated', limit = 200, offset = 0 } = {}) {
    const where = [];
    const params = [];
    if (q) {
      where.push('(c.name LIKE ? OR c.data LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }
    if (tag) {
      where.push('EXISTS (SELECT 1 FROM character_tags t WHERE t.character_id = c.id AND t.tag = ?)');
      params.push(tag);
    }
    if (favorite === true) where.push('c.favorite = 1');
    if (favorite === false) where.push('c.favorite = 0');
    if (source) {
      where.push('c.source = ?');
      params.push(source);
    }
    if (status) {
      where.push('EXISTS (SELECT 1 FROM character_status s WHERE s.character_id = c.id AND s.status = ?)');
      params.push(status);
    }

    const order = sort === 'name' ? 'c.name COLLATE NOCASE ASC' : sort === 'created' ? 'c.created_at DESC' : 'c.updated_at DESC';
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = repo.get(`SELECT COUNT(*) AS n FROM characters c ${whereSql}`, params).n;
    const lim = Math.max(1, Math.min(1000, Number(limit) || 200));
    const off = Math.max(0, Number(offset) || 0);
    const rows = repo.all(
      `SELECT ${CARD_COLUMNS}, ${STATUS_SELECT},
          (SELECT COUNT(*) FROM character_versions v WHERE v.character_id = c.id) AS version_count,
          (SELECT COUNT(*) FROM chats ch WHERE ch.character_id = c.id AND ch.is_group = 0) AS chat_count
        FROM characters c ${whereSql}
        ORDER BY ${order}
        LIMIT ? OFFSET ?`,
      [...params, lim, off],
    );
    return { items: attachTags(rows.map(rowToCard)), total: Number(total) };
  }

  function get(id) {
    const row = repo.get(
      `SELECT ${CARD_COLUMNS}, ${STATUS_SELECT},
          (SELECT COUNT(*) FROM character_versions v WHERE v.character_id = c.id) AS version_count,
          (SELECT COUNT(*) FROM chats ch WHERE ch.character_id = c.id AND ch.is_group = 0) AS chat_count
        FROM characters c WHERE c.id = ?`,
      [id],
    );
    if (!row) return null;
    return attachTags([rowToCard(row)])[0];
  }

  function stats() {
    const total = repo.get('SELECT COUNT(*) AS n FROM characters').n;
    const favorites = repo.get('SELECT COUNT(*) AS n FROM characters WHERE favorite = 1').n;
    const tags = repo.all(
      `SELECT tag, COUNT(*) AS n FROM character_tags GROUP BY tag ORDER BY n DESC, tag ASC`,
    ).map((row) => ({ tag: row.tag, count: Number(row.n) }));
    return { total: Number(total), favorites: Number(favorites), tags };
  }

  // ---------------------------------------------------------------- 写入

  function insert({ name, specVersion = 'v2', data = {}, source = 'original', tags = [], favorite = false, status = '', avatar = null } = {}) {
    const id = newId('char');
    const now = nowIso();
    const cardName = String(name ?? data.name ?? '').trim() || '未命名';
    repo.run(
      `INSERT INTO characters (id, name, spec_version, data, avatar_asset_id, source, favorite, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, cardName, specVersion, JSON.stringify(data ?? {}), null, source, favorite ? 1 : 0, now, now],
    );
    if (String(status ?? '')) writeStatus(repo, id, status, now);
    setTags(id, tags);
    if (avatar) {
      const rel = saveAvatar(id, avatar);
      if (rel) repo.run('UPDATE characters SET avatar_asset_id = ? WHERE id = ?', [rel, id]);
    }
    addVersion(id, data, '创建');
    return get(id);
  }

  function update(id, patch = {}) {
    const existing = get(id);
    if (!existing) throw new NotFoundError(`角色卡 ${id}`);
    const fields = [];
    const params = [];
    if (patch.name !== undefined) {
      fields.push('name = ?');
      params.push(String(patch.name ?? '').trim() || existing.name);
    }
    if (patch.specVersion !== undefined) {
      fields.push('spec_version = ?');
      params.push(String(patch.specVersion));
    }
    if (patch.data !== undefined) {
      fields.push('data = ?');
      params.push(JSON.stringify(patch.data ?? {}));
    }
    if (patch.source !== undefined) {
      fields.push('source = ?');
      params.push(String(patch.source || 'original'));
    }
    if (patch.favorite !== undefined) {
      fields.push('favorite = ?');
      params.push(patch.favorite ? 1 : 0);
    }
    if (patch.status !== undefined) {
      writeStatus(repo, id, patch.status, nowIso());
    }
    if (patch.avatar !== undefined) {
      const rel = patch.avatar ? saveAvatar(id, patch.avatar) : null;
      fields.push('avatar_asset_id = ?');
      params.push(rel);
    }
    if (fields.length) {
      fields.push('updated_at = ?');
      params.push(nowIso());
      params.push(id);
      repo.run(`UPDATE characters SET ${fields.join(', ')} WHERE id = ?`, params);
    }
    if (patch.tags !== undefined) setTags(id, patch.tags);
    return get(id);
  }

  function remove(id) {
    const existing = get(id);
    if (!existing) throw new NotFoundError(`角色卡 ${id}`);
    repo.run('DELETE FROM characters WHERE id = ?', [id]);
    if (existing.avatarAssetId && String(existing.avatarAssetId).startsWith('cards/')) {
      try {
        unlinkSync(path.join(dataDir ?? '', String(existing.avatarAssetId)));
      } catch {
        // 文件可能已经被手动删掉了，不影响删除记录
      }
    }
  }

  // ---------------------------------------------------------------- 版本

  function addVersion(id, data, note = '') {
    const existing = repo.get('SELECT id FROM characters WHERE id = ?', [id]);
    if (!existing) throw new NotFoundError(`角色卡 ${id}`);
    const versionId = newId('ver');
    repo.run(
      'INSERT INTO character_versions (id, character_id, data, note, created_at) VALUES (?, ?, ?, ?, ?)',
      [versionId, id, JSON.stringify(data ?? {}), note, nowIso()],
    );
    return versionId;
  }

  function listVersions(id) {
    const rows = repo.all(
      'SELECT id, character_id, data, note, created_at FROM character_versions WHERE character_id = ? ORDER BY created_at DESC',
      [id],
    );
    return rows.map((row) => ({
      id: row.id,
      characterId: row.character_id,
      data: fromJson(row.data, {}),
      note: row.note ?? '',
      createdAt: row.created_at,
    }));
  }

  function getVersion(id, versionId) {
    const row = repo.get('SELECT * FROM character_versions WHERE id = ? AND character_id = ?', [versionId, id]);
    if (!row) return null;
    return { id: row.id, characterId: row.character_id, data: fromJson(row.data, {}), note: row.note ?? '', createdAt: row.created_at };
  }

  /** 回滚前先把"现在"存一版，这样回滚本身也能被回滚。 */
  function restoreVersion(id, versionId) {
    const version = getVersion(id, versionId);
    if (!version) throw new NotFoundError(`版本 ${versionId}`);
    const current = get(id);
    addVersion(id, current.data, `回滚前自动留档（来自 ${versionId}）`);
    return update(id, { data: version.data, name: version.data?.name ?? current.name });
  }

  return {
    list,
    get,
    stats,
    insert,
    update,
    remove,
    setTags,
    saveAvatar,
    readAvatar,
    addVersion,
    listVersions,
    getVersion,
    restoreVersion,
  };
}
