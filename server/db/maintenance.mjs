/**
 * 数据维护：体检（scan）与清理（cleanup），外加一把数据统计（蓝图 3.2）。
 *
 * 先把问题查出来给用户看，用户勾哪些清哪些 —— 不做"点一下就自动删一堆东西"。
 * scan 只读，cleanup 才写，且只按照 scan 报出来的同一套规则删。
 */

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * 向量集合 → 它们的来源在哪张表。source_id 都等于那张表的主键 id
 * （世界书是 "bookId:uid"，但书被删了同样查不到，一样能报出来）。
 * databank 以前没地方存原文、没法校验；现在原文在 reference_docs，能一起查了。
 */
const VECTOR_SOURCES = [
  { collection: 'worldbook', table: 'worldbooks' },
  { collection: 'memory', table: 'memories' },
  { collection: 'history', table: 'chats' },
  { collection: 'databank', table: 'reference_docs' },
];

export function createMaintenanceStore({ repo, dataDir }) {
  function count(sql, params = []) {
    return Number(repo.get(sql, params)?.n ?? 0);
  }

  function stats() {
    const characters = count('SELECT COUNT(*) AS n FROM characters');
    const chats = count('SELECT COUNT(*) AS n FROM chats');
    const messages = count('SELECT COUNT(*) AS n FROM chat_messages');
    const charactersOfText = Number(repo.get('SELECT COALESCE(SUM(LENGTH(content)), 0) AS n FROM chat_messages')?.n ?? 0);
    const words = Number(
      repo.get("SELECT COALESCE(SUM(LENGTH(REPLACE(REPLACE(content, char(10), ''), ' ', ''))), 0) AS n FROM chat_messages")?.n ?? 0,
    );
    return {
      characters,
      chats,
      messages,
      words,
      charactersOfText,
      worldbooks: count('SELECT COUNT(*) AS n FROM worldbooks'),
      worldbookEntries: count('SELECT COUNT(*) AS n FROM worldbook_entries'),
      presets: count('SELECT COUNT(*) AS n FROM prompt_presets'),
      memories: count('SELECT COUNT(*) AS n FROM memories'),
      referenceDocs: count('SELECT COUNT(*) AS n FROM reference_docs'),
      vectors: count('SELECT COUNT(*) AS n FROM vector_items'),
      assets: count('SELECT COUNT(*) AS n FROM assets'),
      assetBytes: Number(repo.get('SELECT COALESCE(SUM(size), 0) AS n FROM assets')?.n ?? 0),
      comfyRuns: count('SELECT COUNT(*) AS n FROM comfy_runs'),
      usageTurns: count('SELECT COUNT(*) AS n FROM usage_log'),
      providers: count('SELECT COUNT(*) AS n FROM providers'),
      mcpServers: count('SELECT COUNT(*) AS n FROM mcp_servers'),
    };
  }

  /** 文件在磁盘上、但 assets 表里没有记录。 */
  function orphanFiles() {
    const target = path.join(dataDir ?? '', 'assets');
    if (!existsSync(target)) return [];
    const known = new Set(repo.all('SELECT path FROM assets').map((row) => String(row.path)));
    const out = [];
    for (const entry of readdirSync(target)) {
      const relative = path.join('assets', entry);
      if (known.has(relative)) continue;
      const absolute = path.join(target, entry);
      out.push({ path: relative, bytes: statSync(absolute).size });
    }
    return out;
  }

  /** assets 表里有记录、但文件已经不在磁盘上。 */
  function missingFiles() {
    const rows = repo.all('SELECT id, path, name, size FROM assets');
    const out = [];
    for (const row of rows) {
      const absolute = path.join(dataDir ?? '', String(row.path));
      if (!existsSync(absolute)) out.push({ id: row.id, path: row.path, name: row.name ?? null, size: Number(row.size ?? 0) });
    }
    return out;
  }

  /** 向量片指向的内容已经没了（那条世界书 / 记忆 / 对话被删了）。 */
  function staleVectors() {
    const out = [];
    for (const source of VECTOR_SOURCES) {
      const rows = repo.all(
        `SELECT collection, source_id, COUNT(*) AS n FROM vector_items
          WHERE collection = ? AND source_id NOT IN (SELECT id FROM ${source.table})
          GROUP BY source_id`,
        [source.collection],
      );
      for (const row of rows) out.push({ collection: row.collection, sourceId: row.source_id, items: Number(row.n ?? 0) });
    }
    // 空 source_id 的彻底没有归属，也一并报出来
    const blank = repo.all("SELECT collection, COUNT(*) AS n FROM vector_items WHERE source_id IS NULL OR source_id = '' GROUP BY collection");
    for (const row of blank) out.push({ collection: row.collection, sourceId: '', items: Number(row.n ?? 0) });
    return out;
  }

  /** 同一个对话里 role + 内容完全一样的消息（重复导入最容易产生）。 */
  function duplicateMessages({ minLength = 8 } = {}) {
    const rows = repo.all(
      `SELECT chat_id, role, content, COUNT(*) AS n, MIN(seq) AS keep_seq, GROUP_CONCAT(id) AS ids
         FROM chat_messages
        WHERE LENGTH(content) >= ?
        GROUP BY chat_id, role, content
       HAVING COUNT(*) > 1`,
      [minLength],
    );
    return rows.map((row) => {
      const ids = String(row.ids ?? '').split(',');
      const keep = repo.get('SELECT id FROM chat_messages WHERE chat_id = ? AND seq = ?', [row.chat_id, row.keep_seq])?.id;
      return {
        chatId: row.chat_id,
        role: row.role,
        count: Number(row.n ?? 0),
        preview: String(row.content ?? '').slice(0, 60),
        keepId: keep ?? ids[0],
        removeIds: ids.filter((id) => id !== (keep ?? ids[0])),
      };
    });
  }

  /** 没有任何成员的对话（建群后没加人就丢在那儿的）。 */
  function emptyChats() {
    return repo
      .all('SELECT c.id, c.title, c.created_at FROM chats c WHERE NOT EXISTS (SELECT 1 FROM chat_members m WHERE m.chat_id = c.id) AND NOT EXISTS (SELECT 1 FROM chat_messages g WHERE g.chat_id = c.id)')
      .map((row) => ({ id: row.id, title: row.title, createdAt: row.created_at }));
  }

  function scan() {
    const orphan = orphanFiles();
    const missing = missingFiles();
    const stale = staleVectors();
    const duplicates = duplicateMessages();
    const empties = emptyChats();
    const issues = [
      { id: 'orphanFiles', title: '孤立素材文件', count: orphan.length, summary: '文件在磁盘上，数据库里没有对应记录', bytes: orphan.reduce((sum, item) => sum + item.bytes, 0) },
      { id: 'missingFiles', title: '素材记录缺文件', count: missing.length, summary: '数据库里记着，但文件已经不在磁盘上' },
      { id: 'staleVectors', title: '失效向量', count: stale.reduce((sum, item) => sum + item.items, 0), summary: '指向的世界书 / 记忆 / 对话已经不存在了' },
      { id: 'duplicateMessages', title: '重复消息', count: duplicates.length, summary: '同一个对话里角色与内容完全相同的消息' },
      { id: 'emptyChats', title: '空对话', count: empties.length, summary: '既没有成员也没有消息的对话' },
    ];
    return {
      scannedAt: new Date().toISOString(),
      stats: stats(),
      issues,
      details: { orphanFiles: orphan.slice(0, 100), missingFiles: missing.slice(0, 100), staleVectors: stale, duplicateMessages: duplicates.slice(0, 100), emptyChats: empties.slice(0, 100) },
      totalIssues: issues.reduce((sum, item) => sum + item.count, 0),
    };
  }

  const DEFAULT_TARGETS = ['orphanFiles', 'missingFiles', 'staleVectors', 'duplicateMessages'];

  function cleanup({ targets = DEFAULT_TARGETS, plan = null } = {}) {
    const wanted = new Set(Array.isArray(targets) && targets.length ? targets : DEFAULT_TARGETS);
    const current = plan ?? scan();
    const removed = { orphanFiles: 0, missingFiles: 0, staleVectors: 0, duplicateMessages: 0, emptyChats: 0 };
    const bytesFreed = { value: 0 };

    if (wanted.has('orphanFiles')) {
      for (const file of current.details.orphanFiles ?? []) {
        try {
          rmSync(path.join(dataDir ?? '', file.path), { force: true });
          removed.orphanFiles += 1;
          bytesFreed.value += file.bytes ?? 0;
        } catch {
          // 删不掉就跳过，别让整个清理失败
        }
      }
    }
    if (wanted.has('missingFiles')) {
      for (const file of current.details.missingFiles ?? []) {
        repo.run('DELETE FROM assets WHERE id = ?', [file.id]);
        removed.missingFiles += 1;
      }
    }
    if (wanted.has('staleVectors')) {
      for (const item of current.details.staleVectors ?? []) {
        if (item.sourceId) {
          repo.run('DELETE FROM vector_items WHERE collection = ? AND source_id = ?', [item.collection, item.sourceId]);
        } else {
          repo.run("DELETE FROM vector_items WHERE collection = ? AND (source_id IS NULL OR source_id = '')", [item.collection]);
        }
        removed.staleVectors += item.items;
      }
    }
    if (wanted.has('duplicateMessages')) {
      for (const group of current.details.duplicateMessages ?? []) {
        for (const id of group.removeIds ?? []) {
          repo.run('DELETE FROM chat_messages WHERE id = ?', [id]);
          removed.duplicateMessages += 1;
        }
      }
    }
    if (wanted.has('emptyChats')) {
      for (const chat of current.details.emptyChats ?? []) {
        repo.run('DELETE FROM chats WHERE id = ?', [chat.id]);
        removed.emptyChats += 1;
      }
    }
    return { removed, bytesFreed: bytesFreed.value, stats: stats() };
  }

  return { stats, scan, cleanup };
}
