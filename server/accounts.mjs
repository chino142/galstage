/**
 * 主机级账号表与会话（多用户模式）。
 *
 * - 账号表是主机目录下的 `accounts.json`（只存口令哈希，不存明文）；
 *   写入走"临时文件 + 重命名"，别半个文件把账号表写坏。
 * - 会话只放内存：重启后所有人重新登录（简单、不会留下长期有效的票据）。
 * - 登录失败按 IP 限速，公网暴露时挡一下暴力破解。
 *
 * 这里**不碰任何租户数据**：账号表里没有对话、卡、设置，那些都在各自的租户目录里。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  ACCOUNTS_FILE,
  SESSION_TTL_MS,
  hashPassword,
  normaliseAccount,
  normaliseUsername,
  publicAccount,
  validatePassword,
  verifyPassword,
} from '../core/accounts.mjs';
import { ConflictError, NotFoundError, ValidationError } from '../core/errors.mjs';

const THROTTLE_WINDOW_MS = 10 * 60 * 1000;
const THROTTLE_MAX_FAILURES = 10;

// 账号不存在时也跑一次哈希，避免"账号存不存在"从响应时间上被看出来
const DUMMY_HASH = hashPassword('dummy-password-for-timing');

export function createAccountStore({ hostRoot, logger = console }) {
  const file = path.join(hostRoot, ACCOUNTS_FILE);
  let cache = null;
  const sessions = new Map(); // token → { name, createdAt, lastSeen, ip }
  const failures = new Map(); // ip → { count, firstAt }
  let lastPrune = 0;

  /**
   * 账号表**存在、但读不出来**时的原因（文件坏了 / 权限不对 / 被删了一半）。
   *
   * 这时候绝不能当成空表：空表会让「首次建号」重新开放（任何能访问端口的人都能抢到管理员），
   * 而且随后的建号会把原来的账号表整个覆盖掉。所以只读操作照旧返回空表
   * （界面不至于 500），但**一切写入都被拒绝**。
   */
  let unreadable = null;

  function readAll() {
    if (cache) return cache;
    if (!existsSync(file)) {
      cache = { version: 1, accounts: [] };
      return cache;
    }
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      const accounts = Array.isArray(parsed?.accounts) ? parsed.accounts.map((entry) => normaliseAccount(entry)) : [];
      cache = { version: 1, accounts };
      unreadable = null;
    } catch (err) {
      unreadable = err?.message ?? String(err);
      logger?.warn?.(`[accounts] 账号表读不出来：${unreadable}。已停用一切账号写入，先把它修好`);
      cache = { version: 1, accounts: [] };
    }
    return cache;
  }

  function writeAll(state) {
    const temp = `${file}.tmp`;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(temp, `${JSON.stringify({ version: 1, accounts: state.accounts }, null, 2)}\n`);
    renameSync(temp, file);
    cache = state;
    return state;
  }

  function find(name) {
    const wanted = String(name ?? '').toLowerCase();
    return readAll().accounts.find((account) => account.name === wanted) ?? null;
  }

  function require(name) {
    const account = find(name);
    if (!account) throw new NotFoundError(`没有这个账号：${name}`);
    return account;
  }

  function list() {
    return readAll().accounts.map((account) => publicAccount(account));
  }

  function count() {
    return readAll().accounts.length;
  }

  function create({ name, password, role = 'user', note = '' } = {}) {
    const username = normaliseUsername(name);
    readAll();
    if (unreadable) {
      throw new ValidationError(`账号表读不出来，先修好 ${ACCOUNTS_FILE} 再建账号 —— 现在建号会把原来的账号表覆盖掉`);
    }
    if (find(username)) throw new ConflictError(`账号 ${username} 已经存在了`);
    const account = normaliseAccount({
      name: username,
      role,
      note,
      passwordHash: hashPassword(validatePassword(password)),
    });
    const state = readAll();
    state.accounts.push(account);
    writeAll(state);
    logger?.info?.(`[accounts] 建了账号 ${username}（${account.role}）`);
    return publicAccount(account);
  }

  function setPassword(name, password) {
    const account = require(name);
    account.passwordHash = hashPassword(validatePassword(password));
    writeAll(readAll());
    destroySessionsFor(account.name);
    return publicAccount(account);
  }

  function setDisabled(name, disabled) {
    const account = require(name);
    account.disabled = Boolean(disabled);
    writeAll(readAll());
    if (account.disabled) destroySessionsFor(account.name);
    return publicAccount(account);
  }

  function setRole(name, role) {
    const account = require(name);
    account.role = role === 'admin' ? 'admin' : 'user';
    writeAll(readAll());
    return publicAccount(account);
  }

  function setNote(name, note) {
    const account = require(name);
    account.note = String(note ?? '');
    writeAll(readAll());
    return publicAccount(account);
  }

  function adminCount() {
    return readAll().accounts.filter((account) => account.role === 'admin' && !account.disabled).length;
  }

  function remove(name) {
    const account = require(name);
    const state = readAll();
    state.accounts = state.accounts.filter((entry) => entry.name !== account.name);
    writeAll(state);
    destroySessionsFor(account.name);
    return true;
  }

  /** 校验用户名 + 口令。任何失败都返回 null（调用方统一回"账号或口令不对"）。 */
  function authenticate(name, password) {
    const account = find(name);
    if (!account) {
      verifyPassword(String(password ?? ''), DUMMY_HASH);
      return null;
    }
    if (!verifyPassword(String(password ?? ''), account.passwordHash)) return null;
    if (account.disabled) return { ...publicAccount(account), disabled: true };
    account.lastLoginAt = new Date().toISOString();
    writeAll(readAll());
    return publicAccount(account);
  }

  // ---------------------------------------------------------------- 会话

  function prune(now = Date.now()) {
    if (now - lastPrune < 60_000) return;
    lastPrune = now;
    for (const [token, session] of sessions) {
      if (now - session.lastSeen > SESSION_TTL_MS) sessions.delete(token);
    }
    for (const [ip, entry] of failures) {
      if (now - entry.firstAt > THROTTLE_WINDOW_MS) failures.delete(ip);
    }
  }

  function startSession(name, { token, ip = null } = {}) {
    const now = Date.now();
    sessions.set(token, { name, createdAt: now, lastSeen: now, ip });
    return { token, name, expiresAt: new Date(now + SESSION_TTL_MS).toISOString() };
  }

  function resolveSession(token) {
    if (!token) return null;
    const now = Date.now();
    prune(now);
    const session = sessions.get(token);
    if (!session) return null;
    if (now - session.lastSeen > SESSION_TTL_MS) {
      sessions.delete(token);
      return null;
    }
    const account = find(session.name);
    if (!account || account.disabled) {
      sessions.delete(token);
      return null;
    }
    session.lastSeen = now;
    return { name: account.name, role: account.role, token };
  }

  function destroySession(token) {
    return sessions.delete(token);
  }

  function destroySessionsFor(name) {
    let removed = 0;
    for (const [token, session] of sessions) {
      if (session.name !== name) continue;
      sessions.delete(token);
      removed += 1;
    }
    return removed;
  }

  function sessionStats() {
    return { sessions: sessions.size };
  }

  // ---------------------------------------------------------------- 登录限速

  /**
   * 失败计数按「IP + 目标账号」分桶，而不是按 IP 一个桶。
   *
   * 按 IP 一个桶时，任何持有一个有效账号的人都能「9 次猜管理员 + 正常登录自己」
   * 把额度刷回去 —— 管理员口令就只剩长度约束了。分桶之后，成功登录只清
   * 自己这个账号的额度，别人账号的失败数照旧累计。
   */
  function bucketKey(ip, name) {
    if (!ip) return null;
    return `${ip}|${String(name ?? '').trim().toLowerCase()}`;
  }

  function isThrottled(ip, name) {
    const key = bucketKey(ip, name);
    if (!key) return false;
    prune();
    const entry = failures.get(key);
    if (!entry) return false;
    if (Date.now() - entry.firstAt > THROTTLE_WINDOW_MS) {
      failures.delete(key);
      return false;
    }
    return entry.count >= THROTTLE_MAX_FAILURES;
  }

  function recordFailure(ip, name) {
    const key = bucketKey(ip, name);
    if (!key) return false;
    prune();
    const entry = failures.get(key);
    if (!entry || Date.now() - entry.firstAt > THROTTLE_WINDOW_MS) {
      failures.set(key, { count: 1, firstAt: Date.now() });
      return false;
    }
    entry.count += 1;
    return entry.count >= THROTTLE_MAX_FAILURES;
  }

  function clearFailures(ip, name) {
    const key = bucketKey(ip, name);
    if (key) failures.delete(key);
  }

  return {
    file,
    list,
    count,
    has: (name) => Boolean(find(name)),
    find,
    require,
    create,
    setPassword,
    setDisabled,
    setRole,
    setNote,
    remove,
    adminCount,
    authenticate,
    startSession,
    resolveSession,
    destroySession,
    destroySessionsFor,
    sessionStats,
    isThrottled,
    recordFailure,
    clearFailures,
    unreadable: () => unreadable,
    _internal: { readAll, writeAll, sessions },
  };
}
