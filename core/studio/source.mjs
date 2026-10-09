/**
 * 抓料：从网页 / wiki 取一段文字，交给写卡助手生成设定与世界书。
 *
 * 分三步：URL 合法性（挡内网地址）→ HTML 转文本 → 切段。
 * 真正「生成设定」那一步复用已有的创作链路，这里只负责把网页变成干净文本。
 */

import { ValidationError } from '../errors.mjs';

const PRIVATE_HOST = /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|.*\.local$)/i;

/**
 * 校验要抓的地址。默认挡内网 —— 否则这个接口等于给外网开了个探测内网的洞。
 */
export function normaliseUrl(input, { allowPrivate = false } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new ValidationError('要填一个网址');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError(`这不是一个合法的网址：${raw}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ValidationError('只支持 http / https');
  if (!allowPrivate && PRIVATE_HOST.test(url.hostname)) {
    throw new ValidationError('不允许抓内网地址（这会被当成探测内网的口子）');
  }
  return url;
}

const ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&mdash;': '—', '&ndash;': '–', '&hellip;': '…',
};

export function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&#(\d+);/g, (whole, code) => {
      const value = Number(code);
      return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : whole;
    })
    .replace(/&[a-zA-Z]+;|&#39;/g, (entity) => ENTITIES[entity] ?? entity);
}

/** HTML → 纯文本。去掉脚本样式，块级标签转换行，再解码实体。 */
export function htmlToText(html) {
  const source = String(html ?? '');
  const title = (source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
  const body = source
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(body)
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .split('\n').map((line) => line.trim()).join('\n')
    .trim();
  return { title: decodeEntities(title), text };
}

/** 按段落切段，尽量在句子边界断开。 */
export function chunkText(text, { size = 1600, max = 40 } = {}) {
  const paragraphs = String(text ?? '').split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > size) {
      chunks.push(current);
      current = '';
      if (chunks.length >= max) break;
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current && chunks.length < max) chunks.push(current);
  return chunks;
}

/** 给模型的抽取提示词：只要设定，不要剧情复述。 */
export function buildExtractPrompt({ title = '', url = '', text = '', want = 'both' } = {}) {
  const scope = want === 'card'
    ? '只要角色设定（外貌、性格、说话方式、与主角的关系）。'
    : want === 'worldbook'
      ? '只要世界设定（地点、组织、专有名词、规则），每条独立可触发。'
      : '角色设定与世界设定都要。';
  return [
    `下面是从《${title || url}》抓来的资料，请提炼成可以直接用于角色扮演的设定。`,
    scope,
    '要求：只写资料里确实有的内容，不要发挥；分条写；每条一句到三句。',
    '',
    '资料：',
    String(text ?? '').slice(0, 12000),
  ].join('\n');
}
