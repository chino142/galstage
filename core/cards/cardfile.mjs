/**
 * 角色卡的解析与写回（纯逻辑，不碰数据库、不读文件）。
 *
 * 覆盖社区实际在发的东西：
 *   - PNG 里的 `chara`（V2）与 `ccv3`（V3）文本块，读的时候 ccv3 优先
 *   - 裸 JSON：V1（扁平挂在根上）、V2（spec: chara_card_v2）、V3（chara_card_v3）
 *   - 卡内嵌世界书（data.character_book），原样带着走
 *
 * 未知字段一律原样保留：解析时把整份原始文档留在 raw 里，写回时以 raw 打底，
 * 只覆盖我们认识的那几个字段。这样没实现的社区扩展（表情差分、STscript 等）
 * 经过这个程序往返也不会丢。
 *
 * 行为对照 SillyTavern `release` 分支 `src/character-card-parser.js`：
 *   - 读：优先 `ccv3`，退回 `chara`；都是 base64 文本块
 *   - 写：只认 `chara` / `ccv3` 两个关键字，其它 tEXt 不动
 *   - 写 PNG 时顺带生成一份 V3（spec/spec_version 改掉）塞进 `ccv3`
 * 有意偏离：SillyTavern 只把同一份 JSON 写进 chara 再派生 ccv3；这里把
 * V3 那份的 spec/spec_version 显式规范成 3.0，其余字段保持字节一致。
 */

import { inflateSync } from 'node:zlib';
import { ValidationError } from '../errors.mjs';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const CARD_PNG_KEYWORDS = ['chara', 'ccv3'];

// ---------------------------------------------------------------- CRC32

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------- PNG 块

export function isPng(buf) {
  return Buffer.isBuffer(buf) && buf.length > 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE);
}

export function readPngChunks(buf) {
  if (!isPng(buf)) throw new ValidationError('这不是 PNG 文件');
  const chunks = [];
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) break;
    chunks.push({ type, data: buf.subarray(dataStart, dataEnd), start: offset, end: dataEnd + 4 });
    offset = dataEnd + 4;
    if (type === 'IEND') break;
  }
  return chunks;
}

function decodeTextChunk(chunk) {
  const { type, data } = chunk;
  if (type === 'tEXt') {
    const nul = data.indexOf(0);
    if (nul < 0) return null;
    return { keyword: data.toString('latin1', 0, nul), text: data.toString('latin1', nul + 1) };
  }
  if (type === 'zTXt') {
    const nul = data.indexOf(0);
    if (nul < 0 || nul + 2 > data.length) return null;
    const keyword = data.toString('latin1', 0, nul);
    try {
      return { keyword, text: inflateSync(data.subarray(nul + 2)).toString('latin1') };
    } catch {
      return null;
    }
  }
  if (type === 'iTXt') {
    const nul = data.indexOf(0);
    if (nul < 0) return null;
    const keyword = data.toString('latin1', 0, nul);
    const compFlag = data[nul + 1];
    let cursor = nul + 3;
    const langEnd = data.indexOf(0, cursor);
    cursor = langEnd < 0 ? cursor : langEnd + 1;
    const transEnd = data.indexOf(0, cursor);
    cursor = transEnd < 0 ? cursor : transEnd + 1;
    let payload = data.subarray(cursor);
    if (compFlag === 1) {
      try {
        payload = inflateSync(payload);
      } catch {
        return null;
      }
    }
    return { keyword, text: payload.toString('utf8') };
  }
  return null;
}

/** PNG 里所有卡数据文本块（chara / ccv3），按文件里出现的顺序返回。 */
export function readCardTextChunks(buf) {
  const out = [];
  for (const chunk of readPngChunks(buf)) {
    if (!/tEXt|zTXt|iTXt/.test(chunk.type)) continue;
    const decoded = decodeTextChunk(chunk);
    if (decoded && CARD_PNG_KEYWORDS.includes(decoded.keyword.toLowerCase())) {
      out.push({ keyword: decoded.keyword, text: decoded.text });
    }
  }
  return out;
}

/**
 * 取 PNG 里的卡 JSON（ccv3 优先，退回 chara）。
 * @returns {{json: object, keyword: string}|null}
 */
export function extractCardJsonFromPng(buf) {
  const chunks = readCardTextChunks(buf);
  // ccv3 是较新的块，优先；找不到再退回 chara。
  for (const wanted of ['ccv3', 'chara']) {
    for (const chunk of chunks) {
      if (chunk.keyword.toLowerCase() !== wanted) continue;
      try {
        const json = JSON.parse(Buffer.from(chunk.text.trim(), 'base64').toString('utf8'));
        if (json && typeof json === 'object') return { json, keyword: wanted };
      } catch {
        // 这个块坏了就试下一个
      }
    }
  }
  return null;
}

function buildTextChunk(keyword, text) {
  const payload = Buffer.concat([Buffer.from(`${keyword}\0`, 'latin1'), Buffer.from(text, 'utf8')]);
  const typeAndData = Buffer.concat([Buffer.from('tEXt', 'latin1'), payload]);
  const out = Buffer.allocUnsafe(12 + payload.length);
  out.writeUInt32BE(payload.length, 0);
  out.write('tEXt', 4, 'latin1');
  payload.copy(out, 8);
  out.writeUInt32BE(crc32(typeAndData), 8 + payload.length);
  return out;
}

const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * 把卡 JSON 写进 PNG（chara + ccv3 双块），替换掉原有的卡数据块。
 * 没有提供图片（或提供的不是 PNG）时用 1x1 透明图兜底。
 */
export function embedCardInPng(imageBuffer, cardJson) {
  const source = isPng(imageBuffer) ? imageBuffer : TRANSPARENT_PNG;
  const chunks = readPngChunks(source);
  const charaText = Buffer.from(JSON.stringify(cardJson), 'utf8').toString('base64');
  const v3 = { ...cardJson, spec: 'chara_card_v3', spec_version: '3.0' };
  const ccv3Text = Buffer.from(JSON.stringify(v3), 'utf8').toString('base64');

  const parts = [PNG_SIGNATURE];
  let inserted = false;
  for (const chunk of chunks) {
    if (chunk.type === 'IEND' && !inserted) {
      parts.push(buildTextChunk('chara', charaText));
      parts.push(buildTextChunk('ccv3', ccv3Text));
      inserted = true;
    }
    if (/tEXt|zTXt|iTXt/.test(chunk.type)) {
      const decoded = decodeTextChunk(chunk);
      if (decoded && CARD_PNG_KEYWORDS.includes(decoded.keyword.toLowerCase())) continue;
    }
    parts.push(source.subarray(chunk.start, chunk.end));
  }
  if (!inserted) {
    parts.push(buildTextChunk('chara', charaText));
    parts.push(buildTextChunk('ccv3', ccv3Text));
    parts.push(Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- 规格归一

/** V1 的字段直接挂在根上；这是唯一一份需要摊平的名字表。 */
const V1_ROOT_FIELDS = [
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'creator_notes',
  'system_prompt',
  'post_history_instructions',
  'tags',
  'creator',
  'character_version',
  'alternate_greetings',
  'group_only_greetings',
  'extensions',
  'character_book',
  'nickname',
];

/** 我们认识、且有默认值的字段（其余原样保留）。 */
const KNOWN_DEFAULTS = {
  description: '',
  personality: '',
  scenario: '',
  first_mes: '',
  mes_example: '',
  creator_notes: '',
  system_prompt: '',
  post_history_instructions: '',
  creator: '',
  character_version: '',
  nickname: '',
};

const LIST_FIELDS = ['tags', 'alternate_greetings', 'group_only_greetings'];
const OBJECT_FIELDS = { extensions: {} };

/**
 * 把任意形状的卡数据归一成内部结构。
 * @returns {{spec:'v1'|'v2'|'v3', specVersion:string, data:object, raw:object, sourceSpec:string}}
 */
export function normalizeCard(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('角色卡数据必须是一个对象');
  }

  const specField = typeof input.spec === 'string' ? input.spec : '';
  const hasData = input.data && typeof input.data === 'object' && !Array.isArray(input.data);
  let spec;
  if (specField === 'chara_card_v3') spec = 'v3';
  else if (specField === 'chara_card_v2') spec = 'v2';
  else if (hasData && (input.data.name || input.data.description || specField.includes('card_v'))) spec = 'v2';
  else spec = 'v1';

  const sourceSpec = spec;
  const source = hasData ? { ...input.data } : pickV1Fields(input);
  const specVersion = String(input.spec_version ?? (spec === 'v3' ? '3.0' : spec === 'v2' ? '2.0' : '1.0'));

  const data = { ...source };
  for (const [key, value] of Object.entries(KNOWN_DEFAULTS)) {
    if (data[key] === undefined || data[key] === null) data[key] = value;
  }
  for (const key of LIST_FIELDS) {
    if (!Array.isArray(data[key])) data[key] = [];
  }
  for (const [key, value] of Object.entries(OBJECT_FIELDS)) {
    if (!data[key] || typeof data[key] !== 'object' || Array.isArray(data[key])) data[key] = { ...value };
  }
  if (!data.name) data.name = 'Unnamed';
  // 卡内世界书要么是对象，要么就得是 null；别让坏数据把整个编辑器带崩。
  if (data.character_book !== undefined && data.character_book !== null && typeof data.character_book !== 'object') {
    data.character_book = null;
  }

  return { spec, specVersion, data, raw: input, sourceSpec };
}

function pickV1Fields(root) {
  const out = {};
  for (const field of V1_ROOT_FIELDS) {
    if (root[field] !== undefined) out[field] = root[field];
  }
  // V1 的作者备注叫 creatorcomment，V2 起才叫 creator_notes。
  if (out.creator_notes === undefined && root.creatorcomment !== undefined) out.creator_notes = root.creatorcomment;
  // V1 里散落的其它键也带着走，导出回 V1 时原样还回去。
  for (const [key, value] of Object.entries(root)) {
    if (key === 'spec' || key === 'spec_version' || key === 'data') continue;
    if (out[key] === undefined) out[key] = value;
  }
  return out;
}

/**
 * 生成一份可分享/可写出的卡文档。
 *
 * - spec 缺省 = 保持原规格（V1 还是 V1），保证往返不变形
 * - 以 raw 打底，只覆盖已知字段，未知字段原样保留
 * - V1→V2/V3 时把根上的已知字段搬进 data，避免同一份数据出现两遍
 */
export function toShareableCard(card, { spec } = {}) {
  const raw = card.raw && typeof card.raw === 'object' && !Array.isArray(card.raw) ? card.raw : {};
  const target = spec ?? card.spec ?? 'v2';
  const data = { ...(card.data ?? {}) };

  if (target === 'v1') {
    const out = { ...raw };
    delete out.spec;
    delete out.spec_version;
    delete out.data;
    for (const field of V1_ROOT_FIELDS) out[field] = data[field] ?? out[field] ?? '';
    for (const key of LIST_FIELDS) out[key] = Array.isArray(data[key]) ? data[key] : [];
    // creator_notes 在 V1 里有自己的名字，两个都写上最保险。
    out.creatorcomment = data.creator_notes ?? raw.creatorcomment ?? '';
    if (!out.extensions || typeof out.extensions !== 'object') out.extensions = {};
    if (out.character_book === undefined) out.character_book = null;
    return out;
  }

  const rawData = raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : {};
  const out = { ...raw };
  for (const field of V1_ROOT_FIELDS) delete out[field];
  delete out.creatorcomment;
  delete out.spec;
  delete out.spec_version;
  out.spec = target === 'v3' ? 'chara_card_v3' : 'chara_card_v2';
  out.spec_version = target === 'v3' ? '3.0' : '2.0';
  out.data = { ...rawData, ...data };
  return out;
}

// ---------------------------------------------------------------- 文件级入口

/**
 * 解析上传的文件。
 * @returns {{spec, specVersion, data, raw, image, name, keyword}}
 */
export function parseCardBuffer(buffer, filename = '') {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '');
  const lower = String(filename ?? '').toLowerCase();

  if (isPng(buf) || lower.endsWith('.png')) {
    const found = extractCardJsonFromPng(buf);
    if (!found) throw new ValidationError('这张 PNG 里没有角色卡数据（找不到 chara / ccv3 块）');
    return { ...normalizeCard(found.json), image: buf, name: found.json.data?.name ?? found.json.name ?? '未命名', keyword: found.keyword };
  }

  const text = buf.toString('utf8').replace(/^\uFEFF/, '').trim();
  if (!text) throw new ValidationError('文件是空的');
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ValidationError('这个文件既不是 PNG 卡也不是合法 JSON');
  }
  return { ...normalizeCard(json), image: null, name: json.data?.name ?? json.name ?? '未命名', keyword: null };
}

/**
 * 把卡序列化成文件。
 * @param {object} card  normalizeCard 的结果（需要 raw/data/spec）
 * @param {{format?:'json'|'png', spec?:'v1'|'v2'|'v3', image?:Buffer, filename?:string}} options
 * @returns {{buffer:Buffer, mime:string, filename:string, format:string, spec:string}}
 */
export function writeCardBuffer(card, { format = 'json', spec, image = null, filename = null } = {}) {
  const target = spec ?? card.spec ?? 'v2';
  const document = toShareableCard(card, { spec: target });
  const base = safeBaseName(filename ?? card.data?.name ?? 'character');

  if (format === 'png') {
    return {
      buffer: embedCardInPng(image ?? card.image ?? null, document),
      mime: 'image/png',
      filename: `${base}.png`,
      format: 'png',
      spec: target,
    };
  }
  return {
    buffer: Buffer.from(JSON.stringify(document, null, 2), 'utf8'),
    mime: 'application/json; charset=utf-8',
    filename: `${base}.json`,
    format: 'json',
    spec: target,
  };
}

function safeBaseName(name) {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .trim();
  return cleaned || 'character';
}
