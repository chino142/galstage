/**
 * 消息书签：给某条消息打个标记，随时跳回去。
 *
 * 和快照 / 章节不同 —— 那两样是「重」的（存整段状态、切段），
 * 书签是「轻」的：只记一个位置加一句备注，用来找"那句特别好的回复"。
 */

import { ValidationError } from '../errors.mjs';

export const BOOKMARK_COLORS = ['gold', 'rose', 'sky', 'leaf', 'violet'];

export function normaliseBookmark(raw = {}) {
  const chatId = String(raw.chatId ?? '').trim();
  const messageId = String(raw.messageId ?? '').trim();
  if (!chatId) throw new ValidationError('书签需要 chatId');
  if (!messageId) throw new ValidationError('书签需要 messageId');
  const color = String(raw.color ?? 'gold');
  return {
    chatId,
    messageId,
    label: String(raw.label ?? '').trim().slice(0, 80),
    note: String(raw.note ?? '').trim().slice(0, 400),
    color: BOOKMARK_COLORS.includes(color) ? color : 'gold',
    characterId: raw.characterId ? String(raw.characterId) : null,
  };
}

/** 书签在主界面上显示什么。 */
export function describeBookmark(bookmark = {}, { excerpt = '' } = {}) {
  const label = bookmark.label || String(excerpt).replace(/\s+/g, ' ').trim().slice(0, 30);
  return label || '（无标题书签）';
}

/** 按对话分组，方便界面直接渲染。 */
export function groupByChat(bookmarks = []) {
  const map = new Map();
  for (const item of Array.isArray(bookmarks) ? bookmarks : []) {
    if (!map.has(item.chatId)) map.set(item.chatId, []);
    map.get(item.chatId).push(item);
  }
  return [...map.entries()].map(([chatId, items]) => ({ chatId, items }));
}
