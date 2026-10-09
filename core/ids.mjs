/** id、时间戳、哈希之类的小工具。全项目共用，避免各处自己写一套。 */

import { randomUUID, randomBytes, createHash } from 'node:crypto';

export function newId(prefix = '') {
  const id = randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}

export function shortId(bytes = 6) {
  return randomBytes(bytes).toString('hex');
}

export function nowIso() {
  return new Date().toISOString();
}

/** 把任意文本变成适合做文件名/标识符的短串。 */
export function slugify(text, fallback = 'item') {
  const slug = String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

export function contentHash(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}
