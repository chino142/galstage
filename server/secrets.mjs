/**
 * API Key 的落盘加密。
 *
 * 主密钥放在 <数据目录>/master.key（首次运行生成 32 字节随机数，权限 0600），
 * 密钥本身永远不出服务端，前端只能拿到掩码后的提示。
 * 密文格式：v1.<iv>.<tag>.<ciphertext>，全部 base64。
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ALGO = 'aes-256-gcm';

export function masterKeyPath(dataDir) {
  return join(dataDir, 'master.key');
}

export function loadOrCreateMasterKey(keyPath) {
  if (existsSync(keyPath)) {
    const key = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64');
    if (key.length === 32) return key;
    throw new Error(`主密钥损坏（应为 32 字节）：${keyPath}`);
  }
  mkdirSync(dirname(keyPath), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(keyPath, key.toString('base64'), { mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // Windows 上 chmod 基本无效，忽略
  }
  return key;
}

export function encryptSecret(masterKey, plaintext) {
  if (plaintext === undefined || plaintext === null || plaintext === '') return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, masterKey, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

export function decryptSecret(masterKey, payload) {
  if (!payload) return '';
  const parts = String(payload).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('密文格式不正确');
  const decipher = createDecipheriv(ALGO, masterKey, Buffer.from(parts[1], 'base64'));
  decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
  const data = Buffer.from(parts[3], 'base64');
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** 给界面看的掩码，绝不能把完整 key 发给浏览器。 */
export function maskSecret(plaintext) {
  if (!plaintext) return '';
  const text = String(plaintext);
  if (text.length <= 8) return '••••••••';
  return `${text.slice(0, 3)}••••${text.slice(-4)}`;
}
