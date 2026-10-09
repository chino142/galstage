/** 设置的读写。校验规则来自 core/config.mjs 的 schema，这里只管落库。 */

import { mergeSettings, validateSettings, defaultSettings } from '../../core/config.mjs';

export function readSettings(repo) {
  const rows = repo.all('SELECT key, value FROM settings');
  const stored = {};
  for (const row of rows) {
    try {
      stored[row.key] = JSON.parse(row.value);
    } catch {
      // 坏数据直接忽略，用默认值兜住
    }
  }
  return mergeSettings(stored);
}

export function writeSettings(repo, patch) {
  const clean = validateSettings(patch);
  const now = new Date().toISOString();
  repo.transaction(() => {
    for (const [key, value] of Object.entries(clean)) {
      repo.run(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [key, JSON.stringify(value), now],
      );
    }
  });
  return readSettings(repo);
}

export function resetSettings(repo) {
  repo.run('DELETE FROM settings');
  return defaultSettings();
}
