/**
 * 鉴权方式。
 *
 * 官方服务商都有固定写法，但公益站和各类中转站千奇百怪：有的要 key 放 `api-key`，
 * 有的要裸 key 不带 Bearer，有的干脆把 key 拼在 URL 上。所以把"密钥放哪"做成选项，
 * 默认值按适配器给（见 DEFAULT_AUTH_STYLE）。
 */

export const AUTH_STYLES = [
  { id: 'bearer', title: 'Authorization: Bearer <key>', hint: 'OpenAI 系默认' },
  { id: 'raw', title: 'Authorization: <key>', hint: '有些中转站不要 Bearer 前缀' },
  { id: 'api-key', title: 'api-key: <key>', hint: 'Azure 默认' },
  { id: 'x-api-key', title: 'x-api-key: <key>', hint: 'Anthropic 默认' },
  { id: 'x-goog-api-key', title: 'x-goog-api-key: <key>', hint: 'Gemini 默认' },
  { id: 'query', title: 'URL 参数 ?key=<key>', hint: 'Vertex express 模式' },
  { id: 'none', title: '不带密钥', hint: '本地服务，或代理自己带登录态' },
];

export const DEFAULT_AUTH_STYLE = {
  openai: 'bearer',
  text: 'bearer',
  azure: 'api-key',
  anthropic: 'x-api-key',
  gemini: 'x-goog-api-key',
  vertex: 'query',
};

export function authStyleById(id) {
  return AUTH_STYLES.find((style) => style.id === id) ?? null;
}

/** 没填 key 一律当"不带密钥"，不要发一个空的 Authorization 头出去。 */
export function resolveAuth(style, apiKey) {
  const key = apiKey ? String(apiKey) : '';
  const effective = key ? style || 'bearer' : 'none';
  switch (effective) {
    case 'bearer':
      return { headers: { Authorization: `Bearer ${key}` }, query: '' };
    case 'raw':
      return { headers: { Authorization: key }, query: '' };
    case 'api-key':
      return { headers: { 'api-key': key }, query: '' };
    case 'x-api-key':
      return { headers: { 'x-api-key': key }, query: '' };
    case 'x-goog-api-key':
      return { headers: { 'x-goog-api-key': key }, query: '' };
    case 'query':
      return { headers: {}, query: `key=${encodeURIComponent(key)}` };
    case 'none':
    default:
      return { headers: {}, query: '' };
  }
}

export function withQuery(url, query) {
  if (!query) return url;
  return url.includes('?') ? `${url}&${query}` : `${url}?${query}`;
}
