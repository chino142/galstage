/**
 * 素材库：图片这类二进制的统一存放。
 *
 * 文件放 `<数据目录>/assets/`，数据库里只记相对路径。同内容（sha256 相同）
 * 只落一份，重复保存返回已有的那条 —— 出图经常重跑，靠这个省空间。
 * 这个模块原来只是占位（`assets` 表在 v1 就建好了），ComfyUI 出图要用，
 * 所以这里把它真正接上。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { newId, nowIso } from '../../core/ids.mjs';
import { ValidationError } from '../../core/errors.mjs';
import { fromJson } from './repo.mjs';

const COLUMNS = 'id, kind, name, mime, size, sha256, path, width, height, meta, created_at';

function toObject(row, refCount = null) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    name: row.name ?? null,
    mime: row.mime ?? 'application/octet-stream',
    size: row.size === null || row.size === undefined ? null : Number(row.size),
    sha256: row.sha256 ?? null,
    path: row.path,
    width: row.width === null || row.width === undefined ? null : Number(row.width),
    height: row.height === null || row.height === undefined ? null : Number(row.height),
    meta: fromJson(row.meta, {}),
    createdAt: row.created_at,
    ...(refCount === null ? {} : { refCount }),
  };
}

const ID_RE = /^[A-Za-z0-9_.-]+$/;

function extensionFor(mime, name) {
  const fromName = name ? path.extname(String(name)).replace(/[^A-Za-z0-9.]/g, '') : '';
  if (fromName && fromName.length <= 6) return fromName;
  const map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'audio/wav': '.wav',
    'audio/mpeg': '.mp3',
    'video/mp4': '.mp4',
  };
  return map[mime] ?? '.bin';
}

export function createAssetStore({ repo, dataDir }) {
  function dir() {
    if (!dataDir) throw new ValidationError('没有配置数据目录，素材没地方放');
    const target = path.join(dataDir, 'assets');
    mkdirSync(target, { recursive: true });
    return target;
  }

  function get(id) {
    if (!ID_RE.test(String(id))) return null;
    const row = repo.get(`SELECT ${COLUMNS} FROM assets WHERE id = ?`, [id]);
    if (!row) return null;
    return toObject(row, usageCounts()[id] ?? 0);
  }

  function findByHash(sha256) {
    if (!sha256) return null;
    return toObject(repo.get(`SELECT ${COLUMNS} FROM assets WHERE sha256 = ? ORDER BY created_at ASC LIMIT 1`, [sha256]));
  }

  /** 存一段二进制。同 sha256 已存在就直接复用。 */
  function save({ buffer, kind = 'image', name = null, mime = 'application/octet-stream', width = null, height = null, meta = {} } = {}) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new ValidationError('素材内容为空');
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const existing = findByHash(sha256);
    if (existing) return existing;

    const id = newId('ast');
    const filename = `${id}${extensionFor(mime, name)}`;
    writeFileSync(path.join(dir(), filename), buffer);
    const relative = path.join('assets', filename);
    repo.run(
      `INSERT INTO assets (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, kind, name, mime, buffer.length, sha256, relative, width, height, JSON.stringify(meta ?? {}), nowIso()],
    );
    return get(id);
  }

  function buffer(id) {
    const found = get(id);
    if (!found) return null;
    const absolute = path.join(dataDir ?? '', found.path);
    if (!existsSync(absolute)) return null;
    return { buffer: readFileSync(absolute), asset: found };
  }

  function list({ kind = null, limit = 100 } = {}) {
    const params = [];
    let sql = `SELECT ${COLUMNS} FROM assets`;
    if (kind) {
      sql += ' WHERE kind = ?';
      params.push(kind);
    }
    params.push(Math.max(1, Math.min(1000, Number(limit) || 100)));
    sql += ' ORDER BY created_at DESC LIMIT ?';
    const counts = usageCounts();
    return repo.all(sql, params).map((row) => toObject(row, counts[row.id] ?? 0));
  }

  /**
   * 素材被引用了多少次：消息的 extra.images、出图记录的 images、角色头像。
   * 表不大（自用场景），全表扫一遍在 JS 里数最省事，也不依赖 SQLite 的 JSON1。
   */
  function usageCounts() {
    const counts = {};
    const bump = (assetId) => {
      const id = typeof assetId === 'string' ? assetId : assetId?.assetId ?? null;
      if (id) counts[id] = (counts[id] ?? 0) + 1;
    };
    for (const row of repo.all('SELECT extra FROM chat_messages')) {
      const extra = fromJson(row.extra, {}) ?? {};
      for (const image of Array.isArray(extra.images) ? extra.images : []) bump(image);
    }
    for (const row of repo.all('SELECT images FROM comfy_runs')) {
      for (const image of fromJson(row.images, []) ?? []) bump(image);
    }
    for (const row of repo.all('SELECT avatar_asset_id FROM characters WHERE avatar_asset_id IS NOT NULL')) bump(row.avatar_asset_id);
    return counts;
  }

  function remove(id) {
    const found = get(id);
    if (!found) return false;
    repo.run('DELETE FROM assets WHERE id = ?', [id]);
    const absolute = path.join(dataDir ?? '', found.path);
    try {
      if (existsSync(absolute)) unlinkSync(absolute);
    } catch {
      // 文件删不掉不影响数据库记录，留个孤儿比报错强
    }
    return true;
  }

  /** 清理"数据库里没有、文件还留着"的孤儿素材，维护页用。 */
  function orphanFiles() {
    const known = new Set(repo.all('SELECT path FROM assets').map((row) => String(row.path)));
    const target = path.join(dataDir ?? '', 'assets');
    if (!existsSync(target)) return [];
    const out = [];
    for (const entry of readdirSync(target)) {
      const relative = path.join('assets', entry);
      if (!known.has(relative)) out.push(relative);
    }
    return out;
  }

  function stats() {
    const row = repo.get('SELECT COUNT(*) AS total, COALESCE(SUM(size),0) AS bytes FROM assets');
    return { total: Number(row?.total ?? 0), bytes: Number(row?.bytes ?? 0) };
  }

  return { save, get, findByHash, buffer, list, remove, orphanFiles, stats, usageCounts, dir };
}
