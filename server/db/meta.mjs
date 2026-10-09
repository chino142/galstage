/**
 * app_meta 的读写：一张 `key → JSON` 的小表，存不配进 settings schema 的运行时状态。
 * 目前只有定时任务用（任务清单 + 上次跑的时间），放这里是为了让它**重启后还在**。
 */

export function getMeta(repo, key, fallback = null) {
  const row = repo.get('SELECT value FROM app_meta WHERE key = ?', [key]);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

export function setMeta(repo, key, value) {
  repo.run(
    `INSERT INTO app_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, JSON.stringify(value ?? null)],
  );
  return value;
}

export function removeMeta(repo, key) {
  repo.run('DELETE FROM app_meta WHERE key = ?', [key]);
}
