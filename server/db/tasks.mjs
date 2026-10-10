/**
 * 后台活儿记录（任务中心）的存储层。只记账，不做调度。
 */

import { newId, nowIso } from '../../core/ids.mjs';

const COLUMNS = 'id, kind, title, status, detail, error, started_at, finished_at, created_at';

function toObject(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    status: row.status ?? 'running',
    detail: row.detail ?? null,
    error: row.error ?? null,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
    createdAt: row.created_at,
  };
}

export function createTasksStore({ repo }) {
  if (!repo) throw new Error('createTasksStore 需要 repo');

  function start({ kind = 'task', title = '后台任务' } = {}) {
    const id = newId('task');
    const now = nowIso();
    repo.run(`INSERT INTO tasks (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      id,
      String(kind),
      String(title),
      'running',
      null,
      null,
      now,
      null,
      now,
    ]);
    return toObject(repo.get(`SELECT ${COLUMNS} FROM tasks WHERE id = ?`, [id]));
  }

  function finish(id, { status = 'done', detail = null, error = null } = {}) {
    repo.run('UPDATE tasks SET status = ?, detail = ?, error = ?, finished_at = ? WHERE id = ?', [
      String(status),
      detail === null || detail === undefined ? null : String(detail),
      error === null || error === undefined ? null : String(error),
      nowIso(),
      id,
    ]);
    return toObject(repo.get(`SELECT ${COLUMNS} FROM tasks WHERE id = ?`, [id]));
  }

  function list({ limit = 60 } = {}) {
    const lim = Math.max(1, Math.min(500, Number(limit) || 60));
    return repo
      .all(`SELECT ${COLUMNS} FROM tasks ORDER BY created_at DESC LIMIT ?`, [lim])
      .map(toObject);
  }

  /** 清掉已经结束的记录（在跑的留着）。 */
  function clearFinished() {
    const row = repo.get("SELECT COUNT(*) AS n FROM tasks WHERE status != 'running'");
    repo.run("DELETE FROM tasks WHERE status != 'running'");
    return Number(row?.n ?? 0);
  }

  /** 只留最近 N 条，免得这张表跟着用下去一直长。 */
  function prune(keep = 300) {
    const n = Math.max(20, Number(keep) || 300);
    repo.run(
      `DELETE FROM tasks WHERE id NOT IN (
         SELECT id FROM tasks ORDER BY created_at DESC LIMIT ?
       ) AND status != 'running'`,
      [n],
    );
  }

  return { start, finish, list, clearFinished, prune };
}
