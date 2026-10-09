/**
 * 随机事件（蓝图 2.4 加分项）纯逻辑：按概率往剧情里插一点小插曲。
 *
 * 存储：`chat.settings.randomEvents = { enabled, chance, events: [{id,title,weight,prompt}] }`。
 * 抽签函数是纯的（传入 roll），所以能确定性地单测；真正的随机由调用方给。
 */

export const DEFAULT_EVENTS = [
  { id: 'ev-weather', title: '天气突变', weight: 1, prompt: '天色忽然变了，风把窗户吹得作响。' },
  { id: 'ev-stranger', title: '不速之客', weight: 1, prompt: '门外传来脚步声，有人来了。' },
  { id: 'ev-letter', title: '一封来信', weight: 1, prompt: '桌上不知什么时候多了一封没有署名的信。' },
  { id: 'ev-rumor', title: '街谈巷议', weight: 1, prompt: '路过的人压低了声音，似乎在议论什么。' },
];

function cleanText(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function clamp(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

export function normaliseEvents(raw) {
  const source = Array.isArray(raw) ? raw : DEFAULT_EVENTS;
  return source
    .map((event, index) => ({
      id: String(event?.id ?? `ev-${index + 1}`).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || `ev-${index + 1}`,
      title: cleanText(event?.title, 40) || `事件 ${index + 1}`,
      weight: clamp(event?.weight, 0.1, 100, 1),
      prompt: cleanText(event?.prompt, 300),
    }))
    .filter((event) => event.prompt)
    .slice(0, 50);
}

export function normaliseEventSettings(raw) {
  return {
    enabled: Boolean(raw?.enabled),
    chance: clamp(raw?.chance, 0, 1, 0.15),
    events: normaliseEvents(raw?.events),
  };
}

/** 这次该不该触发。roll ∈ [0,1)。 */
export function shouldFire({ chance = 0.15, roll = 0 } = {}) {
  const p = clamp(chance, 0, 1, 0);
  if (p <= 0) return false;
  return Number(roll) < p;
}

/** 按权重抽一个事件。roll ∈ [0,1)。 */
export function pickRandomEvent({ events = DEFAULT_EVENTS, roll = 0 } = {}) {
  const list = normaliseEvents(events);
  if (!list.length) return null;
  const total = list.reduce((sum, event) => sum + event.weight, 0);
  let cursor = clamp(roll, 0, 0.999999, 0) * total;
  for (const event of list) {
    cursor -= event.weight;
    if (cursor < 0) return { ...event };
  }
  return { ...list[list.length - 1] };
}

/** 事件落成一条旁白消息时用的正文。 */
export function formatEventMessage(event) {
  if (!event) return '';
  return `【随机事件·${event.title}】${event.prompt}`;
}
