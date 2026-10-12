/**
 * 版本化迁移。
 *
 * 规则：
 *   - 已经发布过的迁移不许改，只能往后加新的；
 *   - 每个迁移整体在事务里跑，失败就整体回滚；
 *   - 迁移记录写在 schema_migrations 里。
 */

import { SCHEMA_V1, SCHEMA_V2, SCHEMA_V3, SCHEMA_V4, SCHEMA_V5, SCHEMA_V6, SCHEMA_V7, SCHEMA_V8, SCHEMA_V9, SCHEMA_V10, SCHEMA_V11, SCHEMA_V12, SCHEMA_V13, SCHEMA_V14, SCHEMA_V15, SCHEMA_V16, SCHEMA_V17, SCHEMA_V18, SCHEMA_V19, SCHEMA_V20, SCHEMA_V21, SCHEMA_V22 } from './schema.mjs';

export const MIGRATIONS = [
  {
    version: 1,
    name: 'platform-and-writing-area',
    statements: SCHEMA_V1,
  },
  {
    version: 2,
    name: 'model-providers-and-bindings',
    statements: SCHEMA_V2,
  },
  {
    version: 3,
    name: 'mcp-servers',
    statements: SCHEMA_V3,
  },
  {
    version: 4,
    name: 'playing-area',
    statements: SCHEMA_V4,
  },
  {
    version: 5,
    name: 'provider-headers-auth-and-launcher',
    statements: SCHEMA_V5,
  },
  {
    version: 6,
    name: 'toolbox-comfyui',
    statements: SCHEMA_V6,
  },
  {
    version: 7,
    name: 'toolbox-cost-and-pricing',
    statements: SCHEMA_V7,
  },
  {
    version: 8,
    name: 'toolbox-comfy-character-bindings',
    statements: SCHEMA_V8,
  },
  {
    version: 9,
    name: 'frontend-themes-and-snippets',
    statements: SCHEMA_V9,
  },
  {
    version: 10,
    name: 'card-frontend-trust',
    statements: SCHEMA_V10,
  },
  {
    version: 11,
    name: 'reference-docs-and-vector-meta',
    statements: SCHEMA_V11,
  },
  {
    version: 12,
    name: 'studio-notes-samplers-loadouts-proxies',
    statements: SCHEMA_V12,
  },
  {
    version: 13,
    name: 'bookmarks-actions-logit-thumbnails',
    statements: SCHEMA_V13,
  },
  {
    version: 14,
    name: 'modules-from-prompt-snippets',
    statements: SCHEMA_V14,
  },
  {
    version: 15,
    name: 'module-parts-worldbook-regex-background',
    statements: SCHEMA_V15,
  },
  {
    version: 16,
    name: 'provider-param-overrides',
    statements: SCHEMA_V16,
  },
  {
    version: 17,
    name: 'comfy-lora-sets',
    statements: SCHEMA_V17,
  },
  {
    version: 18,
    name: 'comfy-outfits',
    statements: SCHEMA_V18,
  },
  {
    version: 19,
    name: 'character-status',
    statements: SCHEMA_V19,
  },
  {
    version: 20,
    name: 'story-plans',
    statements: SCHEMA_V20,
  },
  {
    version: 21,
    name: 'card-collections',
    statements: SCHEMA_V21,
  },
  {
    version: 22,
    name: 'background-tasks',
    statements: SCHEMA_V22,
  },
];

const LATEST = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

export function latestVersion() {
  return LATEST;
}

/** 迁移记录表要先建出来，否则第一次读版本号就会报 no such table。 */
function ensureMigrationsTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
     version INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     applied_at TEXT NOT NULL
   )`);
}

export function currentVersion(db) {
  ensureMigrationsTable(db);
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get();
  return row?.version ?? 0;
}

/**
 * 已经发布过的迁移不许改，但 `ALTER TABLE ... ADD COLUMN` 没有 `IF NOT EXISTS`：
 * 在"结构已经是最新"的库上重放同一条迁移（迁移记录被清掉、或从半截备份里恢复）会直接炸
 * "duplicate column name"。所以跑之前先看一眼那一列在不在，在就跳过 ——
 * 这样不动 V5 的 SQL，也能让它可重放。
 *
 * 只对 ALTER ADD COLUMN 生效，其余语句照旧执行（`CREATE TABLE IF NOT EXISTS` 本来就幂等）。
 */
const ADD_COLUMN_RE =
  /^\s*ALTER\s+TABLE\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?\s+ADD\s+COLUMN\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?/i;

function alreadyHasColumn(db, sql) {
  const match = ADD_COLUMN_RE.exec(String(sql ?? ''));
  if (!match) return false;
  try {
    const columns = db.prepare(`PRAGMA table_info(${match[1]})`).all();
    return columns.some((row) => String(row.name).toLowerCase() === match[2].toLowerCase());
  } catch {
    // 表还不存在之类的情况：交给正常路径去建
    return false;
  }
}

export function runMigrations(db, logger = console) {
  ensureMigrationsTable(db);
  const applied = [];
  const done = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version),
  );

  for (const migration of MIGRATIONS) {
    if (done.has(migration.version)) continue;
    db.exec('BEGIN');
    try {
      for (const sql of migration.statements) {
        if (alreadyHasColumn(db, sql)) continue;
        db.exec(sql);
      }
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`迁移 ${migration.version} (${migration.name}) 失败：${err.message}`, { cause: err });
    }
    applied.push(migration);
    logger.info?.(`[db] 已应用迁移 ${migration.version}：${migration.name}`);
  }
  return applied;
}
