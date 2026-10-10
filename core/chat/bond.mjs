/**
 * 羁绊：把"你和这个角色认识多久了、上次见面是什么时候、一共聊了多少"算成一句话，
 * 插进这一轮的提示词里 —— 角色就会自然地说出"好久不见"这类话，而不是每次都像第一次见面。
 *
 * 纯计算，时区用服务器本地（跟报告页一套口径）。宁可少说也不要算错：
 * 没有历史、时间戳读不出来，就直接返回 null（调用方跳过注入）。
 */

function dayStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function describeBond({ name = '', firstAt = null, lastAt = null, count = 0, now = new Date() } = {}) {
  const total = Number(count) || 0;
  const first = toDate(firstAt);
  const current = toDate(now);
  if (!total || !first || !current) return null;
  const last = toDate(lastAt) ?? first;

  const dayMs = 86400000;
  // "认识第 N 天"：第一天算第 1 天，所以 +1。
  const daysKnown = Math.max(1, Math.round((dayStart(current) - dayStart(first)) / dayMs) + 1);
  const sinceLast = Math.max(0, Math.round((dayStart(current) - dayStart(last)) / dayMs));
  const who = String(name || '这个角色');

  const parts = [`你和「${who}」认识第 ${daysKnown} 天`, `一共聊过 ${total} 条`];
  if (sinceLast === 0) parts.push('今天已经聊过了');
  else if (sinceLast === 1) parts.push('上次见面是昨天');
  else parts.push(`上次见面是 ${sinceLast} 天前`);

  return `【羁绊】${parts.join('；')}。（这是背景信息，不用刻意复述，除非正好接得上。）`;
}
