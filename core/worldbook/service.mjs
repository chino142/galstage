/**
 * 世界书服务。
 *
 * 纯逻辑（归一、触发、形状转换）在 shapes.mjs / engine.mjs 里；
 * 数据库通过 ports.worldbookStore 注入（见 server/db/worldbook.mjs）。
 *
 * activate() 是给提示词管线每轮调用的：它按 characterId 取"全局书 + 这个角色的书"，
 * 拿最近几条历史 + 本轮文本去扫描，返回这轮该注入的条目。
 * 没注入存储时返回结构正确的空结果 —— 这是骨架阶段的约定，上层管线不会因为空结果崩掉。
 *
 * sticky / cooldown 需要在轮次之间记住状态。这里用进程内的 per-chat 表兜住
 * （自用单进程服务够用）；重启会丢，要跨重启就以后加一张表。
 */

import { emptyList } from '../contracts.mjs';
import { NotImplementedError, ValidationError } from '../errors.mjs';
import { activateWorldInfo } from './engine.mjs';
import { POSITION_OPTIONS, LOGIC_OPTIONS, MATCH_SOURCES, normalizeWorldBook, convertDocument, detectShape } from './shapes.mjs';

export function createWorldbookService({ settings, ports = {} } = {}) {
  void settings;
  const store = ports.worldbookStore ?? null;
  const stateByChat = new Map();
  const embed = ports.embed ?? null;

  // ------------------------------------------------------------------ 语义触发

  /** 零依赖兜底：中文按 2-gram、拉丁按词切，算 Jaccard 重叠。 */
  function tokenSet(text) {
    const source = String(text ?? '').toLowerCase();
    const tokens = new Set();
    for (const word of source.match(/[a-z0-9]{2,}/g) ?? []) tokens.add(word);
    const cjk = source.replace(/[^\u4e00-\u9fff]/g, '');
    for (let i = 0; i + 1 < cjk.length; i += 1) tokens.add(cjk.slice(i, i + 2));
    return tokens;
  }

  function overlapScore(a, b) {
    const left = tokenSet(a);
    const right = tokenSet(b);
    if (!left.size || !right.size) return 0;
    let hit = 0;
    for (const token of left) if (right.has(token)) hit += 1;
    return hit / Math.sqrt(left.size * right.size);
  }

  function cosine(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i += 1) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (!na || !nb) return 0;
    return dot / Math.sqrt(na * nb);
  }

  /**
   * 给标了 `vectorized` 的条目算语义相似度。有嵌入端口就用向量余弦，
   * 没有（或嵌入失败）就退化成零依赖的词重叠 —— 离线也能用，只是糙一点。
   */
  async function semanticScoresFor({ books = [], text = '', messages = [] } = {}) {
    const candidates = [];
    for (const book of books) {
      for (const entry of book.entries ?? []) {
        if (!entry?.vectorized) continue;
        candidates.push({ uid: entry.uid, text: [entry.comment, entry.content, ...(entry.keys ?? [])].filter(Boolean).join(' ') });
      }
    }
    if (!candidates.length) return {};
    const query = [String(text ?? ''), ...(messages ?? []).slice(-2).map((message) => message?.content ?? '')].filter(Boolean).join('\n');
    const scores = {};
    if (embed) {
      try {
        const vectors = await embed([query, ...candidates.map((item) => item.text)]);
        if (Array.isArray(vectors) && vectors.length === candidates.length + 1 && vectors.every((vector) => Array.isArray(vector))) {
          const [base, ...rest] = vectors;
          candidates.forEach((item, index) => {
            scores[item.uid] = cosine(base, rest[index]);
          });
          return scores;
        }
      } catch {
        // 嵌入不可用：退回词重叠
      }
    }
    for (const item of candidates) scores[item.uid] = overlapScore(query, item.text);
    return scores;
  }

  function requireStore(what) {
    if (!store) throw new NotImplementedError(what, { reason: '没有注入世界书存储端口（ports.worldbookStore）' });
    return store;
  }

  function loadBooks({ characterId = null } = {}) {
    const { items } = store.list({});
    const applicable = items.filter((book) => !book.characterId || (characterId && book.characterId === characterId));
    return applicable.map((book) => ({ id: book.id, name: book.name, entries: store.entries(book.id) }));
  }

  return {
    // ---- 界面元数据 ----
    positions: () => POSITION_OPTIONS,
    logics: () => LOGIC_OPTIONS,
    matchSources: () => MATCH_SOURCES,
    shapes: () => [
      { id: 'tavern', title: '酒馆导出', summary: '以 uid 为键的对象，字段是 key / keysecondary / order / disable' },
      { id: 'card', title: '卡内嵌', summary: '数组，字段是 keys / secondary_keys / insertion_order / enabled' },
    ],

    // ---- 读 ----
    list: async (query = {}) => (store ? store.list(query ?? {}) : emptyList()),
    get: async (id) => (store ? store.get(id) : null),
    entries: async (id) => {
      if (!store) return emptyList();
      const items = store.entries(id);
      return { items, total: items.length };
    },

    /** 这轮该激活哪些条目。 */
    activate: async (input = {}) => {
      if (!store) return { entries: [], reasons: [] };
      const { chatId = null, characterId = null, text = '', messages = null, scanSources = {}, variables = {} } = input;
      const history = Array.isArray(messages)
        ? messages
        : text
          ? [{ role: 'user', content: text }]
          : [];
      const state = input.state ?? stateByChat.get(chatId ?? '__anonymous__') ?? {};
      const books = loadBooks({ characterId });
      // 角色卡自带的 character_book（卡内嵌形状）也要跟着这张卡生效。
      const embedBooks = (Array.isArray(input.embedBooks) ? input.embedBooks : [])
        .filter((doc) => doc && typeof doc === 'object')
        .map((doc, index) => {
          const normalized = normalizeWorldBook(doc, doc.name ?? '卡内世界书');
          return { id: `embed-${index}`, name: normalized.name, entries: normalized.entries };
        });
      const allBooks = [...books, ...embedBooks];
      const semanticScores = {
        ...(await semanticScoresFor({ books: allBooks, text, messages: history })),
        ...(input.semanticScores ?? {}),
      };
      const result = activateWorldInfo({
        books: allBooks,
        messages: history,
        text,
        settings: input.settings ?? {},
        state,
        scanSources,
        semanticScores,
        rng: input.rng,
      });
      stateByChat.set(chatId ?? '__anonymous__', result.state);
      void variables;
      return result;
    },

    /**
     * 试触发面板：给一段话，看会激活哪些条目、为什么。
     * 既支持测一本已存在的书，也支持直接测一段临时条目（input.entries）。
     */
    testTrigger: async (bookId, input = {}) => {
      if (!store) return { entries: [], reasons: [], scanned: 0 };
      let books = [];
      if (bookId && store.get(bookId)) {
        books = [{ id: bookId, name: store.get(bookId).name, entries: store.entries(bookId) }];
      } else if (Array.isArray(input.entries)) {
        books = [{ id: 'ad-hoc', name: '临时条目', entries: normalizeWorldBook({ entries: input.entries }).entries }];
      } else {
        return { entries: [], reasons: [], scanned: 0 };
      }

      const text = String(input.text ?? '');
      const messages = Array.isArray(input.messages)
        ? input.messages
        : text
          ? [{ role: 'user', content: text }]
          : [];

      const semanticScores = {
        ...(await semanticScoresFor({ books, text, messages })),
        ...(input.semanticScores ?? {}),
      };
      const result = activateWorldInfo({
        books,
        messages,
        text,
        settings: { scanDepth: input.scanDepth ?? 2, tokenBudget: input.tokenBudget ?? 4096, ...(input.settings ?? {}) },
        state: input.state ?? {},
        scanSources: input.scanSources ?? {},
        semanticScores,
        rng: () => 0.5,
      });

      const activatedUids = new Set(result.entries.map((entry) => String(entry.uid)));
      const reasons = result.reasons.map((reason) => ({ ...reason, activated: reason.activated && activatedUids.has(String(reason.uid)) }));
      return { entries: result.entries, reasons, scanned: books[0].entries.length, before: result.before, after: result.after, atDepth: result.atDepth, tokenCount: result.tokenCount };
    },

    // ---- 写 ----
    save: async (payload = {}) => {
      const bookStore = requireStore('保存世界书');
      if (payload.id) {
        const updated = bookStore.update(payload.id, {
          name: payload.name,
          data: payload.data,
          characterId: payload.characterId,
          source: payload.source,
        });
        if (!updated) return null;
        return updated;
      }
      return bookStore.insert({
        name: payload.name ?? '未命名世界书',
        spec: payload.spec ?? null,
        data: payload.data ?? null,
        characterId: payload.characterId ?? null,
        source: payload.source ?? 'original',
      });
    },

    remove: async (id) => requireStore('删除世界书').remove(id),

    saveEntry: async (bookId, entry = {}) => requireStore('保存世界书条目').saveEntry(bookId, entry),
    removeEntry: async (bookId, uid) => requireStore('删除世界书条目').removeEntry(bookId, uid),

    // ---- 导入导出 / 形状转换 ----
    importFiles: async (files = [], { characterId = null, source = 'imported' } = {}) => {
      const bookStore = requireStore('导入世界书');
      const items = [];
      const errors = [];
      for (const file of files) {
        try {
          const text = Buffer.isBuffer(file.buffer) ? file.buffer.toString('utf8').replace(/^\uFEFF/, '') : String(file.text ?? '');
          let doc;
          try {
            doc = JSON.parse(text);
          } catch {
            throw new ValidationError('世界书必须是 JSON 文件');
          }
          items.push(bookStore.importDocument(doc, { name: file.name ? stripExt(file.name) : null, characterId, source }));
        } catch (err) {
          errors.push({ name: file.name ?? '（无名文件）', message: err?.message ?? String(err) });
        }
      }
      return { items, total: items.length, imported: items.length, skipped: errors.length, errors };
    },

    exportFile: async (id, { shape = null } = {}) => {
      const bookStore = requireStore('导出世界书');
      const doc = bookStore.exportDocument(id, { shape });
      if (!doc) return null;
      const name = bookStore.get(id)?.name ?? 'worldbook';
      return {
        buffer: Buffer.from(JSON.stringify(doc, null, 2), 'utf8'),
        mime: 'application/json; charset=utf-8',
        filename: `${name}.json`,
      };
    },

    /** 把任意一份世界书文档转成另一种形状（不落库）。 */
    convertShape: async (doc, shape) => {
      if (!doc || typeof doc !== 'object') throw new ValidationError('要转换的世界书文档不合法');
      const target = shape === 'card' ? 'card' : 'tavern';
      const source = doc.data ?? doc.document ?? doc;
      return { shape: target, sourceShape: detectShape(source?.character_book && !source.entries ? source.character_book : source), document: convertDocument(source, target) };
    },
  };
}

function stripExt(name) {
  return String(name).replace(/\.(json|txt)$/i, '');
}
