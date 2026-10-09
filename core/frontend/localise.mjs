/**
 * 卡内前端的「资源本地化」：把 html / css / js 里引用的外链资源抓下来存进卡资源库，
 * 再把代码里的 URL 换成我们自己的地址。
 *
 * 为什么要这一步：外链图片是"活的但不可靠"——图床会限速、抽风、作者会删图，
 * ComfyUI 的输出目录也会被清理。抓下来之后卡才算真正自持。
 *
 * 这里只放**纯逻辑**（找 URL、嗅探类型、重写文本），真正发请求和落盘在 server 侧，
 * 所以这一份能拿假数据直接单测。
 */

/** 默认额度。慢是常态（实测那张卡的图床有一张 15 秒超时），所以超时给得宽一点。 */
export const LOCALISE_LIMITS = {
  maxFileBytes: 12 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxFiles: 400,
  timeoutMs: 20000,
  concurrency: 4,
};

/**
 * 认 URL。排除引号、括号、尖括号、反斜杠、反引号——这些在 CSS / HTML / JS 里都是分隔符，
 * 留着会把尾巴上的标点吃进来。协议只认 http(s)：协议相对的 `//host/x.png` 先不管，
 * 真碰到了会在报告里以"抓不到"的形式暴露出来，不会静默改错。
 */
const URL_RE = /https?:\/\/[^\s'"()<>\\`]+/g;

/** URL 尾巴上跟着的句读不是 URL 的一部分（中文标点也要剥，不然中文备注里的链接会带个句号）。 */
function trimTail(url) {
  return String(url).replace(/[.,;:!?。，、；：！？]+$/, '');
}

/**
 * 从若干段文本里找出所有外链，去重且保持出现顺序。
 * @param {...(string|null|undefined)} texts
 * @returns {string[]}
 */
export function findExternalUrls(...texts) {
  const seen = new Set();
  const out = [];
  for (const text of texts) {
    for (const match of String(text ?? '').matchAll(URL_RE)) {
      const url = trimTail(match[0]);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

/**
 * 按映射表把文本里的 URL 换掉。**长的先换**：`https://a/b.png` 和 `https://a/b.png?v=2`
 * 同时存在时，先换短的会把长的拆坏。
 */
export function rewriteExternalUrls(text, mapping = {}) {
  let out = String(text ?? '');
  const keys = Object.keys(mapping).filter((key) => mapping[key]).sort((a, b) => b.length - a.length);
  for (const key of keys) out = out.split(key).join(mapping[key]);
  return out;
}

const MAGIC = [
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/bmp', bytes: [0x42, 0x4d] },
  { mime: 'image/x-icon', bytes: [0x00, 0x00, 0x01, 0x00] },
  { mime: 'audio/mpeg', bytes: [0x49, 0x44, 0x33] },
  { mime: 'audio/ogg', bytes: [0x4f, 0x67, 0x67, 0x53] },
  { mime: 'video/webm', bytes: [0x1a, 0x45, 0xdf, 0xa3] },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
];

const EXT_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  cur: 'image/x-icon',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
};

/**
 * 认这张图到底是什么。
 *
 * 为什么不能只信响应头：实测 `img.remit.ee` 那批图回的是 `application/octet-stream`，
 * 存成这个类型之后 `/api/assets/:id/file` 也会带这个头，`<img>` 就不认了。
 * 所以顺序是：**魔数 > 响应头 > 扩展名**。
 *
 * @param {{buffer?: Buffer, url?: string, contentType?: string}} input
 * @returns {string} mime
 */
export function sniffMime({ buffer, url = '', contentType = '' } = {}) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  for (const item of MAGIC) {
    if (bytes.length >= item.bytes.length && item.bytes.every((byte, index) => bytes[index] === byte)) return item.mime;
  }
  // WEBP / WAV / MP4 这些要靠偏移量认
  const head = bytes.slice(0, 12);
  const ascii = head.toString('latin1');
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE') return 'audio/wav';
  if (head.length >= 12 && head.slice(4, 8).toString('latin1') === 'ftyp') return 'video/mp4';
  if (ascii.startsWith('wOFF2')) return 'font/woff2';
  if (ascii.startsWith('wOFF')) return 'font/woff';
  if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return 'font/ttf';
  // SVG 是文本，没有魔数，看开头
  const textHead = bytes.slice(0, 200).toString('utf8').trim().toLowerCase();
  if (textHead.startsWith('<svg') || (textHead.startsWith('<?xml') && textHead.includes('<svg'))) return 'image/svg+xml';

  const given = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  if (given && given !== 'application/octet-stream' && given !== 'binary/octet-stream') return given;

  const ext = String(url ?? '').split(/[?#]/)[0].split('.').pop()?.toLowerCase() ?? '';
  return EXT_MIME[ext] ?? 'application/octet-stream';
}

/** 存进 assets 时的粗分类（界面上要按 kind 过滤）。 */
export function kindFromMime(mime = '') {
  const type = String(mime);
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('font/') || /font|woff|ttf|otf/.test(type)) return 'font';
  return 'file';
}

/** 从 URL 里抠个像样的文件名，纯粹给人在资源库里看。 */
export function nameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const last = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '');
    if (last && last.length <= 80) return last;
    return `${parsed.hostname.replace(/\./g, '_')}${parsed.pathname.replace(/[^\w.-]/g, '_').slice(0, 60)}`;
  } catch {
    return 'asset';
  }
}

/**
 * 按并发上限跑一批任务，保持结果顺序。
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
export async function mapWithConcurrency(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const size = Math.max(1, Math.min(16, Number(limit) || 1));
  const results = new Array(list.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(size, list.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= list.length) return;
      results[index] = await worker(list[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
