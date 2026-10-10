/**
 * 卡文件来源适配器：不管卡是从哪儿来的，都先归一成 [{ name, buffer }] 再交给卡片服务。
 *
 * 现在支持的来源形状：
 *   1) 原始字节（拖一张 PNG / JSON / ZIP 上来）
 *   2) JSON 批量（界面选文件夹：`{ files: [{ name, dataBase64 }] }`）
 *   3) zip 卡包（里面套不套文件夹都行）
 *
 * 为什么要单独一层：接口、MCP、写卡助手、以后"从对话导出"都要走"给一堆文件 → 导入"，
 * 以后加来源只动这里，别在每个入口各写一遍。
 */

import { ValidationError } from '../../core/errors.mjs';
import { readZip } from '../toolbox/zip.mjs';

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** 是不是 zip（卡包常这么发）：看头四个字节。 */
export function looksLikeZip(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 4 && buffer.subarray(0, 4).equals(ZIP_MAGIC);
}

/**
 * 把一个 zip 摊成卡片文件列表：只挑 PNG / JSON，跳过目录和 macOS 的垃圾（__MACOSX / 点开头）。
 * 卡包通常还套一层文件夹，所以取 basename 当卡名。
 */
export function expandCardZip(name, buffer) {
  let entries;
  try {
    entries = readZip(buffer);
  } catch (err) {
    throw new ValidationError(`${name} 打不开：${err?.message ?? '不是有效的 zip'}`);
  }
  const out = [];
  for (const entry of entries) {
    const entryName = String(entry?.name ?? '').replace(/\\/g, '/');
    if (!entryName || entryName.endsWith('/')) continue;
    if (entryName.startsWith('__MACOSX/')) continue;
    if (entryName.split('/').some((segment) => segment.startsWith('.'))) continue;
    if (!/\.(png|json)$/i.test(entryName)) continue;
    out.push({ name: entryName.split('/').pop(), buffer: entry.data });
  }
  if (!out.length) throw new ValidationError(`${name} 里没有 PNG / JSON 卡`);
  return out;
}

/** JSON 批量那一路：`{ files: [{ name, dataBase64 }] }` 或单份 `{ name, dataBase64 }`。 */
function fromJsonBatch(json, fallbackName) {
  const incoming = Array.isArray(json?.files) ? json.files : json?.dataBase64 ? [json] : [];
  if (!incoming.length) throw new ValidationError('没有收到任何卡文件（files 为空）');
  return incoming.flatMap((file) => {
    const base64 = String(file.dataBase64 ?? file.data ?? '');
    if (!base64) throw new ValidationError(`文件 ${file.name ?? '（无名）'} 没有内容`);
    const item = { name: file.name ?? fallbackName, buffer: Buffer.from(base64, 'base64') };
    return looksLikeZip(item.buffer) ? expandCardZip(item.name, item.buffer) : [item];
  });
}

/**
 * 归一入口。
 * @param {{ raw?: Buffer|null, json?: object|null, name?: string }} input
 * @returns {Array<{ name: string, buffer: Buffer }>}
 */
export function collectCardFiles({ raw = null, json = null, name = '未命名' } = {}) {
  if (json) return fromJsonBatch(json, name);
  if (!Buffer.isBuffer(raw) || !raw.length) throw new ValidationError('请求体是空的，没有卡文件');
  return looksLikeZip(raw) ? expandCardZip(name, raw) : [{ name, buffer: raw }];
}
