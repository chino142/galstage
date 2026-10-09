/**
 * 提示词快照的逐轮 diff。
 *
 * X 光机已经能看到"这一轮真正发出去的是什么"。这一层回答的是下一个问题：
 * **跟上一轮比，变了什么** —— 出问题时能定位到"从第几轮开始跑偏"，
 * 而不是只看到一堆静态的段。
 *
 * 纯函数：喂两份快照，出差异。
 */

function keyOf(section) {
  return String(section?.id ?? section?.title ?? '');
}

function byId(sections = []) {
  const map = new Map();
  for (const section of Array.isArray(sections) ? sections : []) {
    const key = keyOf(section);
    if (key) map.set(key, section);
  }
  return map;
}

function contentOf(section) {
  return String(section?.content ?? '');
}

/** 逐行对比，给出"新增行 / 删除行"的简版 diff（够用且不需要依赖）。 */
export function diffLines(before, after, { maxLines = 40 } = {}) {
  const a = contentOf({ content: before }).split('\n');
  const b = contentOf({ content: after }).split('\n');
  // 最长公共子序列太长，这里用"行集合 + 顺序"的近似：先按行去重计数
  const countOf = (lines) => {
    const map = new Map();
    for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const beforeCount = countOf(a);
  const afterCount = countOf(b);
  const added = [];
  const removed = [];
  for (const [line, count] of afterCount) {
    const delta = count - (beforeCount.get(line) ?? 0);
    for (let index = 0; index < delta; index += 1) added.push(line);
  }
  for (const [line, count] of beforeCount) {
    const delta = count - (afterCount.get(line) ?? 0);
    for (let index = 0; index < delta; index += 1) removed.push(line);
  }
  return {
    added: added.filter(Boolean).slice(0, maxLines),
    removed: removed.filter(Boolean).slice(0, maxLines),
    addedCount: added.filter(Boolean).length,
    removedCount: removed.filter(Boolean).length,
  };
}

/**
 * 两份快照的差异。
 * @param {{sections?:Array, text?:string, tokens?:object, notes?:Array, createdAt?:string}} previous
 * @param {{sections?:Array, text?:string, tokens?:object, notes?:Array, createdAt?:string}} next
 */
export function diffSnapshots(previous = {}, next = {}) {
  const before = byId(previous.sections);
  const after = byId(next.sections);
  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];

  for (const [key, section] of after) {
    if (!before.has(key)) {
      added.push({ id: key, title: section.title ?? key, tokens: Number(section.tokens ?? 0), content: contentOf(section) });
      continue;
    }
    const old = before.get(key);
    if (contentOf(old) === contentOf(section)) {
      unchanged.push({ id: key, title: section.title ?? key });
    } else {
      changed.push({
        id: key,
        title: section.title ?? key,
        tokensBefore: Number(old.tokens ?? 0),
        tokensAfter: Number(section.tokens ?? 0),
        ...diffLines(contentOf(old), contentOf(section)),
      });
    }
  }
  for (const [key, section] of before) {
    if (!after.has(key)) removed.push({ id: key, title: section.title ?? key, tokens: Number(section.tokens ?? 0) });
  }

  const tokensBefore = Number(previous.tokens?.total ?? 0);
  const tokensAfter = Number(next.tokens?.total ?? 0);
  const notesAdded = (next.notes ?? []).filter((note) => !(previous.notes ?? []).includes(note));
  const notesRemoved = (previous.notes ?? []).filter((note) => !(next.notes ?? []).includes(note));

  return {
    added,
    removed,
    changed,
    unchanged,
    notes: { added: notesAdded, removed: notesRemoved },
    tokens: { before: tokensBefore, after: tokensAfter, delta: tokensAfter - tokensBefore },
    identical: added.length === 0 && removed.length === 0 && changed.length === 0,
    summary: [
      added.length ? `新增 ${added.length} 段` : null,
      removed.length ? `去掉 ${removed.length} 段` : null,
      changed.length ? `改动 ${changed.length} 段` : null,
    ].filter(Boolean).join('，') || '与上一轮一致',
  };
}
