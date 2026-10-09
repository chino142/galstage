/**
 * 章节管理（蓝图 2.4 加分项）纯逻辑：把一条长对话切成章，可命名、可跳转。
 *
 * 存储：`chat.settings.chapters = [{ id, title, summary, messageId }]`，
 * `messageId` 是"这一章从哪条消息开始"。没有章节时整条对话算一章。
 */

const MAX_CHAPTERS = 100;

export const DEFAULT_CHAPTER_TITLE = '未命名章节';

function cleanText(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function normaliseChapters(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((chapter, index) => ({
      id: String(chapter?.id ?? `chapter-${index + 1}`).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || `chapter-${index + 1}`,
      title: cleanText(chapter?.title, 60) || DEFAULT_CHAPTER_TITLE,
      summary: cleanText(chapter?.summary, 300),
      messageId: chapter?.messageId ? String(chapter.messageId) : null,
    }))
    .slice(0, MAX_CHAPTERS);
}

/**
 * 按消息顺序把章节算成区间：第 i 章从它的 messageId 开始，到下一章前一天结束。
 * 第一条消息之前没被任何章节认领时补一章「开头」，保证每一轮都落在某一章里。
 */
export function buildChapters({ chapters = [], messages = [] } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const positions = new Map(list.map((message, index) => [message.id, index]));
  const total = list.length;

  const parsed = normaliseChapters(chapters)
    .map((chapter) => {
      const index = chapter.messageId ? positions.get(chapter.messageId) : 0;
      return index === undefined ? null : { ...chapter, startIndex: index };
    })
    .filter(Boolean)
    .sort((a, b) => a.startIndex - b.startIndex);

  // 章节没覆盖开头时补一章（比如第一条消息之后的某条才开始分章）
  if (parsed.length && parsed[0].startIndex > 0) {
    parsed.unshift({ id: 'chapter-start', title: '开头', summary: '', messageId: list[0]?.id ?? null, startIndex: 0 });
  }
  if (!parsed.length) {
    return [{ id: 'chapter-all', title: total ? '全部' : '还没有内容', summary: '', messageId: list[0]?.id ?? null, startIndex: 0, endIndex: Math.max(0, total - 1), count: total }];
  }

  return parsed.map((chapter, index) => {
    const endIndex = index + 1 < parsed.length ? parsed[index + 1].startIndex - 1 : Math.max(0, total - 1);
    return { ...chapter, endIndex, count: Math.max(0, endIndex - chapter.startIndex + 1) };
  });
}

export function chapterFor({ chapters = [], messages = [], messageId = null } = {}) {
  const built = buildChapters({ chapters, messages });
  const index = (messages ?? []).findIndex((message) => message.id === messageId);
  if (index < 0) return built[built.length - 1] ?? null;
  return built.find((chapter) => index >= chapter.startIndex && index <= chapter.endIndex) ?? built[0] ?? null;
}

/** 加 / 改一章（同 id 覆盖）。返回规范化后的数组。 */
export function upsertChapter(list, entry = {}) {
  const clean = normaliseChapters([entry])[0];
  const rest = normaliseChapters(list).filter((chapter) => chapter.id !== clean.id);
  return normaliseChapters([...rest, clean]);
}

export function removeChapter(list, id) {
  return normaliseChapters(list).filter((chapter) => chapter.id !== id);
}

export function newChapterId(seed = Date.now()) {
  return `ch-${Number(seed).toString(36)}`;
}
