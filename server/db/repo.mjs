/**
 * 数据库小工具。
 *
 * node:sqlite 只接受 null / number / bigint / string / Uint8Array 作为参数，
 * 布尔、undefined、对象都得先转换，否则会直接抛错 —— 这里统一处理，
 * 免得每个仓储各写一遍。
 */

export function dbValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

export function fromJson(text, fallback = null) {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function createRepo(db) {
  function run(sql, params = []) {
    return db.prepare(sql).run(...params.map(dbValue));
  }
  function get(sql, params = []) {
    return db.prepare(sql).get(...params.map(dbValue)) ?? null;
  }
  function all(sql, params = []) {
    return db.prepare(sql).all(...params.map(dbValue));
  }
  function exec(sql) {
    return db.exec(sql);
  }
  function transaction(fn) {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return { db, run, get, all, exec, transaction };
}
