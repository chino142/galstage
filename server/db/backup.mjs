/**
 * 备份与恢复（蓝图 3.2）。
 *
 * 几个关键取舍：
 *   1) **不用直接拷 .db 文件**。数据库跑在 WAL 模式下，直接复制会漏掉还没
 *      落盘的 WAL 内容、甚至拷到一个写了一半的文件。这里用 SQLite 自己的
 *      `VACUUM INTO`（等价于 backup API）：它输出一个一致、已整理过的副本。
 *   2) **备份是一个 zip**：里面是 tavern.db + 素材（assets/）+ 角色头像
 *      （cards/）+ manifest.json。用户拿走一个文件就是全部数据。
 *   3) **恢复不需要重启**：把备份里的库 ATTACH 进来，按表整体搬进正在用的库
 *      （外键先关掉、搬完再检查）。这样界面点"恢复"立刻生效，不用让用户
 *      自己关进程 —— 代价是要求表结构一致，字段对不上就明确拒绝，而不是
 *      半搬一半把人数据搞坏。
 *   4) 恢复前自动留一份当前状态的备份（kind='pre-restore'），点错了能回来。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { randomBytes } from 'node:crypto';

import { ValidationError } from '../../core/errors.mjs';
import { createZip, readZip } from '../toolbox/zip.mjs';

const DATA_DIRS = ['assets', 'cards'];

function stamp(date = new Date()) {
  // 精确到毫秒，再加 4 位随机 —— 同一秒内连做两次备份（比如"恢复前自动备份"）
  // 绝不能撞名：撞了就是把刚备份好的那份覆盖掉，恢复出来的还是改动后的状态。
  const base = date.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 23);
  return `${base}-${randomBytes(2).toString('hex')}`;
}

function escapeSql(text) {
  return String(text).replace(/'/g, "''");
}

function listFiles(root, prefix = '') {
  if (!existsSync(root)) return [];
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(absolute, relative));
    else if (entry.isFile()) out.push({ relative, absolute, size: statSync(absolute).size });
  }
  return out;
}

/**
 * 把备份里的相对路径安全地拼到目标目录下。
 *
 * zip 里的条目名是**外部输入**（`import-encrypted` 收进来的备份可能被人为改过），
 * 所以 `assets/../../evil.js` 这种必须挡住 —— 否则恢复就能往数据目录外面写文件。
 * 想往外跑就返回 null，调用方跳过并计数。
 */
function safeResolve(root, relative) {
  const base = path.resolve(root);
  const absolute = path.resolve(base, relative);
  if (absolute === base) return null;
  return absolute.startsWith(base + path.sep) ? absolute : null;
}

/** 条目名本身就不合法（绝对路径 / 盘符 / 含 `..` 段）时直接拒绝，别等到写的时候再跳过。 */
function unsafeEntryName(name) {
  const clean = String(name ?? '').replace(/\\/g, '/');
  if (!clean) return true;
  if (clean.startsWith('/') || /^[A-Za-z]:/.test(clean)) return true;
  return clean.split('/').some((segment) => segment === '..');
}

export function createBackupStore({ rawDb, repo, dataDir, logger = console, allowExecutableConfig = true }) {
  if (!dataDir) throw new ValidationError('备份需要数据目录');
  const backupDir = path.join(dataDir, 'backups');

  function ensureDir() {
    mkdirSync(backupDir, { recursive: true });
    return backupDir;
  }

  function dataStats() {
    // 迁移前的备份会在"老版本的库"上跑：那时候新表还不存在，统计不能因此炸掉。
    const count = (table) => {
      try {
        return Number(repo.get(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0);
      } catch {
        return 0;
      }
    };
    let chars = 0;
    try {
      chars = Number(repo.get('SELECT COALESCE(SUM(LENGTH(content)), 0) AS n FROM chat_messages')?.n ?? 0);
    } catch {
      chars = 0;
    }
    return {
      characters: count('characters'),
      chats: count('chats'),
      messages: count('chat_messages'),
      charactersOfText: Number(chars),
      worldbooks: count('worldbooks'),
      memories: count('memories'),
      vectors: count('vector_items'),
      assets: count('assets'),
      comfyRuns: count('comfy_runs'),
      usageTurns: count('usage_log'),
    };
  }

  /** 用 VACUUM INTO 导出一致性快照；返回临时 db 的路径。 */
  function snapshotDatabase() {
    const temp = path.join(ensureDir(), `_snapshot-${process.pid}-${Date.now()}.db`);
    rawDb.exec(`VACUUM INTO '${escapeSql(temp)}'`);
    return temp;
  }

  function create({ label = null, kind = 'manual' } = {}) {
    const id = `tavern-${stamp()}`;
    const temp = snapshotDatabase();
    let snapshot;
    try {
      snapshot = readFileSync(temp);
    } finally {
      rmSync(temp, { force: true });
    }

    const entries = [{ name: 'tavern.db', data: snapshot }];
    const included = [];
    for (const dir of DATA_DIRS) {
      for (const file of listFiles(path.join(dataDir, dir), dir)) {
        entries.push({ name: file.relative, data: readFileSync(file.absolute) });
        included.push({ name: file.relative, size: file.size });
      }
    }

    const meta = {
      name: id,
      label,
      kind,
      createdAt: new Date().toISOString(),
      schemaVersion: rawDb.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()?.v ?? null,
      dbBytes: snapshot.length,
      assetFiles: included.length,
      stats: dataStats(),
    };
    const manifest = { ...meta, files: included.map((item) => item.name) };
    entries.push({ name: 'manifest.json', data: JSON.stringify(manifest, null, 2) });

    const zip = createZip(entries);
    const zipPath = path.join(ensureDir(), `${id}.zip`);
    writeFileSync(zipPath, zip);
    const finalMeta = { ...meta, bytes: zip.length };
    writeFileSync(path.join(ensureDir(), `${id}.meta.json`), JSON.stringify(finalMeta, null, 2));
    logger?.info?.(`[backup] 已备份：${id}.zip（${(zip.length / 1024).toFixed(0)} KB）`);
    return { ...finalMeta, path: zipPath };
  }

  function list() {
    ensureDir();
    const items = [];
    for (const entry of readdirSync(backupDir)) {
      if (!entry.endsWith('.meta.json')) continue;
      try {
        items.push(JSON.parse(readFileSync(path.join(backupDir, entry), 'utf8')));
      } catch {
        // 元数据坏了就跳过，不影响别的备份
      }
    }
    return items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  function find(name) {
    const clean = String(name ?? '').replace(/[^A-Za-z0-9._-]/g, '');
    if (!clean) return null;
    const zipPath = path.join(backupDir, clean.endsWith('.zip') ? clean : `${clean}.zip`);
    if (!existsSync(zipPath)) return null;
    const metaPath = zipPath.replace(/\.zip$/, '.meta.json');
    let meta = null;
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    } catch {
      meta = null;
    }
    return { name: path.basename(zipPath, '.zip'), zipPath, metaPath, meta };
  }

  function remove(name) {
    const found = find(name);
    if (!found) return false;
    rmSync(found.zipPath, { force: true });
    rmSync(found.metaPath, { force: true });
    return true;
  }

  /** 某份备份的原始字节（加密导出用）。 */
  function readBytes(name) {
    const found = find(name);
    if (!found) return null;
    return readFileSync(found.zipPath);
  }

  /**
   * 把外面拿来的 zip 收进备份目录（比如刚解密出来的加密备份）。
   * 校验里面确实有 manifest.json，之后就能走正常的 restoreBackup 流程。
   */
  function adoptZip({ buffer, label = '导入的备份', kind = 'imported' } = {}) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new ValidationError('备份内容为空');
    let manifest = null;
    try {
      const entries = readZip(buffer);
      const evil = entries.find((entry) => unsafeEntryName(entry.name));
      if (evil) throw new ValidationError(`备份里的文件名不安全（${String(evil.name).slice(0, 80)}），不能导入`);
      const found = entries.find((entry) => entry.name === 'manifest.json');
      if (found) manifest = JSON.parse(Buffer.from(found.data).toString('utf8'));
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError(`这不是一个能认的备份 zip：${err?.message ?? err}`);
    }
    if (!manifest) throw new ValidationError('备份里没有 manifest.json，认不出这是哪份备份');
    const id = `tavern-${stamp()}`;
    const zipPath = path.join(ensureDir(), `${id}.zip`);
    writeFileSync(zipPath, buffer);
    const meta = {
      ...manifest,
      name: id,
      label,
      kind,
      createdAt: new Date().toISOString(),
      bytes: buffer.length,
    };
    writeFileSync(path.join(ensureDir(), `${id}.meta.json`), JSON.stringify(meta, null, 2));
    logger?.info?.(`[backup] 收进一份外部备份：${id}.zip（${(buffer.length / 1024).toFixed(0)} KB）`);
    return { ...meta, path: zipPath };
  }

  /** 只保留最近 keep 份（0 表示不清理）。自动备份用得多。 */
  function prune(keep = 5) {
    const limit = Number(keep);
    if (!Number.isFinite(limit) || limit <= 0) return { removed: [] };
    const items = list();
    const removed = [];
    for (const item of items.slice(limit)) {
      if (remove(item.name)) removed.push(item.name);
    }
    return { removed };
  }

  /** 把备份里的表整体搬进正在用的库；字段对不上就拒绝。 */
  function restoreDatabase(snapshotPath) {
    const restored = new DatabaseSync(snapshotPath, { readOnly: true });
    const tables = restored
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name)
      .filter((name) => name !== 'schema_migrations');

    const mismatch = [];
    const copyable = [];
    for (const table of tables) {
      const mainCols = rawDb.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
      const backupCols = restored.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
      if (!mainCols.length) {
        mismatch.push(`${table}（当前库里没有这张表）`);
        continue;
      }
      if (mainCols.length !== backupCols.length || mainCols.some((column, index) => column !== backupCols[index])) {
        mismatch.push(`${table}（字段对不上：备份 ${backupCols.length} 列 / 现在 ${mainCols.length} 列）`);
        continue;
      }
      copyable.push(table);
    }
    restored.close();
    if (mismatch.length) {
      throw new ValidationError(`这份备份和当前版本的表结构不一致，不能直接恢复：${mismatch.join('；')}。建议用同一版本的备份，或者先手动升级。`);
    }

    rawDb.exec('PRAGMA foreign_keys = OFF');
    try {
      rawDb.exec(`ATTACH DATABASE '${escapeSql(snapshotPath)}' AS restored`);
      rawDb.exec('BEGIN');
      try {
        for (const table of copyable) rawDb.exec(`DELETE FROM main.${table}`);
        for (const table of copyable) rawDb.exec(`INSERT INTO main.${table} SELECT * FROM restored.${table}`);
        // 备份里的"可执行配置"不能带进一个本来就不允许执行它们的数据目录：
        // providers.launcher 会在模型调用前 spawn 命令，mcp_servers 会被 connect 拉起进程。
        // 多用户模式下成员租户没有 launcher，但成员能导一份自己改过的备份（import-encrypted
        // 对成员开放），把这些配置搬进自己的库；等这个数据目录被以启用 launcher 的方式打开
        // （README 推荐的 `--mcp --user <账号>`、或直接单机模式指过来），命令就以主机身份跑了。
        // 单机 / 管理员运行时 allowExecutableConfig 为 true，备份里的配置照常保留（迁移要用）。
        if (!allowExecutableConfig) {
          if (copyable.includes('providers')) {
            try {
              rawDb.exec('UPDATE main.providers SET launcher = NULL');
            } catch {
              // 老备份可能没有这一列；那本来也带不过去
            }
          }
          if (copyable.includes('mcp_servers')) rawDb.exec('DELETE FROM main.mcp_servers');
        }
        rawDb.exec('COMMIT');
      } catch (err) {
        rawDb.exec('ROLLBACK');
        throw err;
      } finally {
        rawDb.exec('DETACH DATABASE restored');
      }
    } finally {
      rawDb.exec('PRAGMA foreign_keys = ON');
    }
    const problems = rawDb.prepare('PRAGMA foreign_key_check').all();
    return { tables: copyable.length, foreignKeyIssues: problems.length };
  }

  function restore({ name, keepCurrent = true } = {}) {
    const found = find(name);
    if (!found) throw new ValidationError(`没有这份备份：${name}`);

    const safety = keepCurrent ? create({ label: '恢复前自动备份', kind: 'pre-restore' }) : null;
    const entries = readZip(readFileSync(found.zipPath));
    const dbEntry = entries.find((entry) => entry.name === 'tavern.db');
    if (!dbEntry) throw new ValidationError('这个压缩包里没有 tavern.db，不是本项目的备份');
    const manifestEntry = entries.find((entry) => entry.name === 'manifest.json');
    let manifest = null;
    try {
      manifest = manifestEntry ? JSON.parse(manifestEntry.data.toString('utf8')) : null;
    } catch {
      manifest = null;
    }

    const tempPath = path.join(ensureDir(), `_restore-${process.pid}-${Date.now()}.db`);
    writeFileSync(tempPath, dbEntry.data);
    let result;
    try {
      result = restoreDatabase(tempPath);
    } finally {
      rmSync(tempPath, { force: true });
    }

    // 素材与头像：按备份镜像（备份里有、现在没有的写回去；现在多出来的删掉），
    // 因为数据库里引用的就是这些文件名，镜像才能保持一致。
    const restoredFiles = { written: 0, removed: 0, skipped: 0 };
    for (const dir of DATA_DIRS) {
      const target = path.join(dataDir, dir);
      const wanted = new Map();
      for (const entry of entries) {
        if (!entry.name.startsWith(`${dir}/`) || entry.name.endsWith('/')) continue;
        const relative = entry.name.slice(dir.length + 1);
        const absolute = safeResolve(target, relative);
        if (!absolute) {
          // 备份里有想写到数据目录外面的条目：跳过，别让恢复变成任意文件写
          restoredFiles.skipped += 1;
          logger?.warn?.(`[backup] 跳过不安全的备份条目：${entry.name}`);
          continue;
        }
        wanted.set(relative, { entry, absolute });
      }
      for (const [relative, { entry, absolute }] of wanted) {
        mkdirSync(path.dirname(absolute), { recursive: true });
        writeFileSync(absolute, entry.data);
        restoredFiles.written += 1;
      }
      for (const file of listFiles(target)) {
        if (wanted.has(file.relative)) continue;
        rmSync(file.absolute, { force: true });
        restoredFiles.removed += 1;
      }
    }

    logger?.info?.(`[backup] 已从 ${found.name} 恢复：${result.tables} 张表、${restoredFiles.written} 个素材`);
    return {
      ok: true,
      restoredFrom: found.name,
      tables: result.tables,
      foreignKeyIssues: result.foreignKeyIssues,
      files: restoredFiles,
      safetyBackup: safety?.name ?? null,
      manifest,
      stats: dataStats(),
    };
  }

  return { create, list, find, remove, prune, restore, readBytes, adoptZip, stats: dataStats, dir: ensureDir };
}
