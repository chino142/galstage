/**
 * 口令加密的全量备份（多用户模式下的"数据在你手里"那一条）。
 *
 * 文件就是一个自包含的二进制：`STBK1` + scrypt 盐 + AES-GCM 的 iv + tag + 密文。
 * 拿到文件的人只有知道口令才能解开；主机管理员也解不开（因为口令不落在磁盘上）。
 * 零依赖，只用 node:crypto。
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

import { ValidationError } from '../core/errors.mjs';

const MAGIC = Buffer.from('STBK1', 'ascii');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const KDF = { N: 16384, r: 8, p: 1 };
const MIN_PASSPHRASE = 8;

export const BACKUP_MAGIC = MAGIC;
export const ENCRYPTED_BACKUP_EXT = '.stbk';

function deriveKey(passphrase, salt) {
  return scryptSync(String(passphrase), salt, KEY_LEN, KDF);
}

export function encryptBuffer(buffer, passphrase) {
  const secret = String(passphrase ?? '');
  if (secret.length < MIN_PASSPHRASE) throw new ValidationError(`导出口令至少 ${MIN_PASSPHRASE} 位`);
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new ValidationError('没有要加密的内容');
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret, salt), iv);
  const body = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

export function decryptBuffer(buffer, passphrase) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  const minimum = MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN + 1;
  if (buf.length < minimum) throw new ValidationError('这不是一个加密备份文件（太短了）');
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new ValidationError('这不是 Silver Tavern 的加密备份（文件头不对）');
  }
  let offset = MAGIC.length;
  const salt = buf.subarray(offset, (offset += SALT_LEN));
  const iv = buf.subarray(offset, (offset += IV_LEN));
  const tag = buf.subarray(offset, (offset += TAG_LEN));
  const body = buf.subarray(offset);
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(String(passphrase ?? ''), salt), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new ValidationError('口令不对，或者这个文件被改过');
  }
}
