/**
 * 多用户（蓝图「多用户 / 权限」）的纯逻辑：账号规则、口令哈希、会话令牌、cookie 解析。
 *
 * 隔离模型（重要）：**一个账号 = 一个完整的数据目录**（`<主机目录>/tenants/<账号>/`），
 * 各自一套 SQLite / 素材 / 备份 / 主密钥。没有"同一张表按 owner_id 过滤"这回事，
 * 所以不存在漏一个 WHERE 就串号的漏洞。
 *
 * 用户名一律小写规范化：Windows 文件系统大小写不敏感，`Alice` 与 `alice` 会落到同一个
 * 目录里 —— 那等于把两个账号的数据放进一个库。所以注册时就只允许小写并统一转换。
 */

import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

import { ValidationError } from './errors.mjs';

export const ACCOUNT_ROLES = [
  { id: 'admin', title: '管理员', summary: '能管账号、看服务总览' },
  { id: 'user', title: '成员', summary: '只有自己的那一份数据' },
];

export const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

// Windows 上这些名字不能当目录名；另外别让人用 . / .. 这种
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
  'tenants', 'plugins', 'backups', 'assets', 'cards',
]);

export const SESSION_COOKIE = 'st_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
export const MIN_PASSWORD_LENGTH = 8;

export const TENANTS_DIR = 'tenants';
export const ACCOUNTS_FILE = 'accounts.json';

/** 账号名规范化 + 校验（永远返回小写）。 */
export function normaliseUsername(input) {
  const name = String(input ?? '').trim().toLowerCase();
  if (!name) throw new ValidationError('账号名不能为空');
  if (!USERNAME_RE.test(name)) {
    throw new ValidationError('账号名只能用 2~32 位小写字母、数字、- 和 _，且以字母或数字开头');
  }
  if (RESERVED_NAMES.has(name)) throw new ValidationError(`账号名 ${name} 是保留名，换一个`);
  return name;
}

export function validatePassword(password) {
  const value = String(password ?? '');
  if (value.length < MIN_PASSWORD_LENGTH) throw new ValidationError(`口令至少要 ${MIN_PASSWORD_LENGTH} 位`);
  if (value.length > 200) throw new ValidationError('口令太长了');
  return value;
}

export function normaliseRole(role) {
  const id = String(role ?? '').trim();
  return ACCOUNT_ROLES.some((item) => item.id === id) ? id : 'user';
}

/** scrypt 哈希，格式：scrypt$N$r$p$salt$hash（都是 base64url）。 */
export function hashPassword(password, { N = 16384, r = 8, p = 1, keylen = 64 } = {}) {
  const value = validatePassword(password);
  const salt = randomBytes(16);
  const hash = scryptSync(value, salt, keylen, { N, r, p });
  return ['scrypt', N, r, p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  let expected;
  try {
    expected = Buffer.from(hash, 'base64url');
  } catch {
    return false;
  }
  let actual;
  try {
    actual = scryptSync(String(password ?? ''), Buffer.from(salt, 'base64url'), expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
  } catch {
    return false;
  }
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** 账号记录（落进 accounts.json 的形状）。 */
export function normaliseAccount(input = {}) {
  const name = normaliseUsername(input.name);
  return {
    name,
    role: normaliseRole(input.role),
    disabled: input.disabled === true,
    createdAt: input.createdAt ?? new Date().toISOString(),
    lastLoginAt: input.lastLoginAt ?? null,
    note: String(input.note ?? ''),
    passwordHash: String(input.passwordHash ?? ''),
  };
}

export function publicAccount(account = {}, extra = {}) {
  return {
    name: account.name,
    role: account.role ?? 'user',
    disabled: Boolean(account.disabled),
    createdAt: account.createdAt ?? null,
    lastLoginAt: account.lastLoginAt ?? null,
    note: account.note ?? '',
    ...extra,
  };
}

export function tenantDataDir(hostRoot, name) {
  return `${hostRoot}/${TENANTS_DIR}/${normaliseUsername(name)}`;
}

export function newSessionToken() {
  return randomBytes(32).toString('base64url');
}

export function newSessionId() {
  return randomUUID();
}

/** Cookie 头解析：`a=1; b=2` → { a: '1', b: '2' }（值做 URL 解码）。 */
export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export function serializeCookie(name, value, { maxAge = null, secure = false, path = '/', sameSite = 'Lax', httpOnly = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(value ?? '')}`];
  parts.push(`Path=${path}`);
  if (httpOnly) parts.push('HttpOnly');
  parts.push(`SameSite=${sameSite}`);
  if (secure) parts.push('Secure');
  if (maxAge !== null) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  return parts.join('; ');
}
