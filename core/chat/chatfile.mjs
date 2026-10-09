/**
 * 对话存档兼容：读写酒馆的 JSONL 聊天文件。
 *
 * 移植自本项目早期版本 `core/chatfile.mjs`（那一版按 SillyTavern `release`
 * 分支 `src/endpoints/chats.js` 里各个 importer 实际构造的对象核对过）。
 * 那一版存的是 epoch 毫秒，这里改成 ISO 字符串，与 schema 的约定一致；
 * 酒馆自己也用 `new Date().toISOString()` 写 `send_date`，所以没丢兼容性。
 *
 * 形状：
 *   第一行是头 `{ user_name, character_name, create_date, chat_metadata }`
 *   之后每行一条 `{ name, is_user, is_system, send_date, mes, extra, swipes?, swipe_id? }`
 *
 * 能读：酒馆 JSONL、本项目早期的富 JSON（version/messages/character/…）、
 *       酒馆中性导出的 `{ chat: [...] }`、裸的消息数组。
 * 不读：Agnai / CAI Tools / Kobold Lite / ooba / Risu —— 酒馆为每种都写了转换器，
 *       一次移植五种一次性形状不划算，报错里会写清楚。
 */

export const MAX_IMPORT_MESSAGES = 5000;
export const MAX_MESSAGE_CHARS = 400_000;

const isPlaceholderName = (value) => {
  const name = String(value ?? '').trim();
  return !name || name.toLowerCase() === 'unused';
};

/** 酒馆把 `mes` 当字符串；有的工具把它当对象，两种都摊平。 */
function flattenText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    for (const key of ['mes', 'message', 'text', 'data']) {
      if (typeof value[key] === 'string') return value[key];
    }
  }
  return String(value);
}

/** 统一成 ISO 字符串；给不出就退回 fallback。 */
function toIso(value, fallback) {
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 秒级时间戳（酒馆旧档偶尔这么写）与毫秒级都容忍
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  return fallback;
}

/** 一行酒馆消息 → 本项目的存储形状。 */
export function readChatMessage(raw, fallbackTimestamp = new Date().toISOString()) {
  if (!raw || typeof raw !== 'object') return null;
  const role = raw.is_user
    ? 'user'
    : raw.is_system
      ? 'system'
      : raw.role === 'user'
        ? 'user'
        : raw.role === 'system'
          ? 'system'
          : raw.role === 'narrator'
            ? 'narrator'
            : 'assistant';
  const content = flattenText(raw.mes ?? raw.content ?? raw.message);
  if (!content.trim()) return null;
  const swipes = Array.isArray(raw.swipes) && raw.swipes.length ? raw.swipes.map((s) => flattenText(s)) : [content];
  const rawSwipeId = Number(raw.swipe_id ?? raw.swipeId);
  const swipeId = Number.isFinite(rawSwipeId) && rawSwipeId >= 0 && rawSwipeId < swipes.length ? rawSwipeId : 0;
  const extra = raw.extra && typeof raw.extra === 'object' ? raw.extra : {};
  return {
    role,
    name: String(raw.name ?? '').slice(0, 200),
    content,
    swipes,
    swipeId,
    hidden: Boolean(raw.hidden ?? extra.hidden),
    extra,
    createdAt: toIso(raw.send_date ?? raw.createdAt, fallbackTimestamp),
  };
}

function parseJsonl(text) {
  const lines = String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) throw new Error('对话文件是空的');

  let header = {};
  let start = 0;
  try {
    const first = JSON.parse(lines[0]);
    // 头里没有消息体，这就是和消息的区别。
    if (first && typeof first === 'object' && !('mes' in first) && !('is_user' in first)) {
      header = first;
      start = 1;
    }
  } catch {
    throw new Error('不是合法的对话文件：第一行不是 JSON');
  }

  const fallback = toIso(header.create_date, new Date().toISOString());
  const messages = [];
  for (let i = start; i < lines.length; i++) {
    let raw;
    try {
      raw = JSON.parse(lines[i]);
    } catch {
      throw new Error(`不是合法的对话文件：第 ${i + 1} 行不是 JSON`);
    }
    const message = readChatMessage(raw, fallback);
    if (message) messages.push(message);
  }
  return { header, messages };
}

/** 早期版本的富 JSON。 */
function parseRichJson(data) {
  const fallback = toIso(data.exportedAt, new Date().toISOString());
  const messages = [];
  for (const raw of data.messages ?? []) {
    const message = readChatMessage(
      {
        name: raw.name,
        role: raw.role,
        is_user: raw.role === 'user',
        is_system: raw.role === 'system',
        mes: raw.content,
        swipes: raw.swipes,
        swipe_id: raw.swipeId,
        extra: raw.extra,
        hidden: raw.hidden,
        send_date: raw.createdAt,
      },
      fallback,
    );
    if (message) messages.push(message);
  }
  return {
    messages,
    header: {},
    title: typeof data.title === 'string' ? data.title : '',
    userName: data.persona?.name ?? '',
    characterName: data.character?.name ?? data.character?.data?.name ?? '',
    character: data.character ?? null,
    persona: data.persona ?? null,
    settings: data.settings && typeof data.settings === 'object' ? data.settings : {},
    worldState: data.worldState && typeof data.worldState === 'object' ? data.worldState : {},
  };
}

/**
 * 解析一份对话文件。
 * @returns {{messages:Array, title:string, userName:string, characterName:string,
 *   character:object|null, persona:object|null, settings:object, worldState:object,
 *   format:'jsonl'|'json'}}
 */
export function parseChatFile(text) {
  const raw = String(text ?? '').replace(/^\uFEFF/, '').trim();
  if (!raw) throw new Error('对话文件是空的');

  let parsed = null;
  let looksLikeJson = true;
  try {
    parsed = JSON.parse(raw);
  } catch {
    looksLikeJson = false;
  }

  let out;
  if (looksLikeJson) {
    if (Array.isArray(parsed)) {
      const messages = parsed.map((m) => readChatMessage(m)).filter(Boolean);
      out = { messages, header: {}, title: '', userName: '', characterName: '', character: null, persona: null, settings: {}, worldState: {} };
    } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.messages)) {
      out = parseRichJson(parsed);
    } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.chat)) {
      const messages = parsed.chat.map((m) => readChatMessage(m)).filter(Boolean);
      out = {
        messages,
        header: parsed.chat_metadata ? { chat_metadata: parsed.chat_metadata } : {},
        title: '',
        userName: '',
        characterName: '',
        character: null,
        persona: null,
        settings: parsed.chat_metadata && typeof parsed.chat_metadata === 'object' ? parsed.chat_metadata : {},
        worldState: {},
      };
    } else {
      throw new Error('认不出这个 JSON 对话格式：只支持酒馆 JSONL 和 Silver Tavern 导出的富 JSON');
    }
  } else {
    const { header, messages } = parseJsonl(raw);
    out = {
      messages,
      header,
      title: '',
      userName: '',
      characterName: '',
      character: null,
      persona: null,
      settings: header.chat_metadata && typeof header.chat_metadata === 'object' ? header.chat_metadata : {},
      worldState: {},
    };
  }

  if (!out.messages.length) throw new Error('这个文件里没有可导入的消息');
  if (out.messages.length > MAX_IMPORT_MESSAGES) {
    throw new Error(`消息太多（${out.messages.length} 条），一次最多导入 ${MAX_IMPORT_MESSAGES} 条`);
  }
  for (const message of out.messages) {
    if (message.content.length > MAX_MESSAGE_CHARS) throw new Error('有消息超过长度上限，无法导入');
  }

  const header = out.header ?? {};
  const userName = !isPlaceholderName(header.user_name) ? String(header.user_name) : out.userName ?? '';
  const fromMessages = out.messages.find((m) => m.role === 'assistant' && m.name)?.name ?? '';
  const characterName = !isPlaceholderName(header.character_name)
    ? String(header.character_name)
    : out.characterName || fromMessages;

  return {
    messages: out.messages,
    title: out.title || '',
    userName,
    characterName,
    character: out.character ?? null,
    persona: out.persona ?? null,
    settings: { ...(header.chat_metadata && typeof header.chat_metadata === 'object' ? header.chat_metadata : {}), ...(out.settings ?? {}) },
    worldState: out.worldState ?? {},
    format: looksLikeJson ? 'json' : 'jsonl',
  };
}

/** 写出酒馆 JSONL。`messages` 用本项目的存储形状。 */
export function chatFileJsonl({ messages = [], userName = 'User', characterName = 'Character', settings = {}, createdAt = new Date().toISOString() } = {}) {
  const created = toIso(createdAt, new Date().toISOString());
  const lines = [
    JSON.stringify({
      user_name: userName,
      character_name: characterName,
      create_date: created,
      chat_metadata: settings,
    }),
  ];
  for (const m of messages) {
    lines.push(
      JSON.stringify({
        name: m.role === 'user' ? userName : m.name || characterName,
        is_user: m.role === 'user',
        is_system: m.role === 'system',
        send_date: toIso(m.createdAt, created),
        mes: m.content,
        extra: m.extra ?? {},
        ...(m.hidden ? { hidden: true } : {}),
        ...(Array.isArray(m.swipes) && m.swipes.length > 1 ? { swipes: m.swipes, swipe_id: m.swipeId ?? 0 } : {}),
      }),
    );
  }
  return `${lines.join('\n')}\n`;
}

/** 本项目的富 JSON，备份时用，多带状态与卡。 */
export function chatFileRich({
  title = 'chat',
  settings = {},
  worldState = {},
  character = null,
  persona = null,
  messages = [],
  exportedAt = new Date().toISOString(),
} = {}) {
  return {
    version: 1,
    exportedAt: toIso(exportedAt, new Date().toISOString()),
    title,
    settings,
    worldState,
    character,
    persona,
    messages: messages.map((m) => ({
      role: m.role,
      name: m.name,
      content: m.content,
      hidden: Boolean(m.hidden),
      swipes: m.swipes ?? [],
      swipeId: m.swipeId ?? 0,
      extra: m.extra ?? {},
      createdAt: toIso(m.createdAt, new Date().toISOString()),
    })),
  };
}
