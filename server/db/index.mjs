/** 打开数据库、跑迁移。数据目录由配置决定，测试里换成临时目录。 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { createRepo } from './repo.mjs';
import { runMigrations, currentVersion, latestVersion } from './migrations.mjs';
import { createBackupStore } from './backup.mjs';

/**
 * 迁移前自动备份（蓝图 3.2「每次大改动前各留一份」）。
 * 只有"已经有数据的老库要升版本"时才做：全新建库没东西可备份。
 * 备份走的是和手动备份完全一样的 `createBackupStore`（VACUUM INTO + zip），
 * 所以它和别的备份一样列在「备份与维护」里、一样受保留份数限制。
 */
function backupBeforeMigration(handle, logger) {
  try {
    const store = createBackupStore({ rawDb: handle.db, repo: handle.repo, dataDir: handle.dataDir, logger });
    const made = store.create({ label: `数据库迁移前自动备份（v${handle.schemaVersion} → v${handle.latestSchemaVersion}）`, kind: 'pre-migration' });
    let keep = 5;
    try {
      const row = handle.repo.get("SELECT value FROM settings WHERE key = 'data.autoBackupKeep'");
      if (row) keep = Number(JSON.parse(row.value)) || 5;
    } catch {
      // 设置表读不到就用默认保留份数
    }
    if (keep > 0) store.prune(keep + 1);
    logger.info?.(`[db] 迁移前已自动备份：${made.name}`);
  } catch (err) {
    logger.warn?.(`[db] 迁移前自动备份失败（不阻断迁移）：${err?.message ?? err}`);
  }
}

export function openDatabase({ dataDir, logger = console }) {
  if (!dataDir) throw new Error('openDatabase 需要 dataDir');
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'tavern.db');

  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  const handle = {
    file,
    dataDir,
    db,
    repo: createRepo(db),
    schemaVersion: currentVersion(db),
    latestSchemaVersion: latestVersion(),
    close: () => db.close(),
  };

  if (handle.latestSchemaVersion > handle.schemaVersion && handle.schemaVersion > 0) {
    backupBeforeMigration(handle, logger);
  }
  runMigrations(db, logger);
  handle.schemaVersion = currentVersion(db);

  return handle;
}
