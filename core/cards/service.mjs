/**
 * 角色卡服务。
 *
 * 纯逻辑在这里：卡数据归一、字段合并、导入导出、版本编排。
 * 数据库与文件系统通过 ports.cardStore 注入（见 server/db/cards.mjs），
 * 所以这个服务在 tests/run.mjs 里可以不带存储单独测，接口形状保持稳定。
 *
 * 没注入存储时：读操作返回结构正确的空结果（界面能显示空状态），
 * 写操作抛 NotImplementedError（骨架阶段的约定）。
 */

import { emptyList } from '../contracts.mjs';
import { NotImplementedError } from '../errors.mjs';
import { CARD_FIELDS } from './schema.mjs';
import {
  normalizeCard,
  parseCardBuffer,
  toShareableCard,
  writeCardBuffer,
  embedCardInPng,
} from './cardfile.mjs';

const SPEC_ALIASES = {
  '1': 'v1',
  '2': 'v2',
  '3': 'v3',
  v1: 'v1',
  v2: 'v2',
  v3: 'v3',
  '1.0': 'v1',
  '2.0': 'v2',
  '3.0': 'v3',
};

/** '2.0' / 'chara_card_v2' / 'V3' 都归一成 'v1'|'v2'|'v3'。 */
export function normalizeSpec(value, fallback = 'v2') {
  if (value === undefined || value === null || value === '') return fallback;
  const raw = String(value).trim().toLowerCase();
  const key = raw
    .replace(/^chara_card_/, '')
    .replace(/^spec[_-]?/, '')
    .replace(/^v(?=\d)/, '');
  return SPEC_ALIASES[key] ?? SPEC_ALIASES[raw] ?? fallback;
}

const FIELD_KEYS = CARD_FIELDS.map((field) => field.key).filter((key) => key !== 'avatar');

/** 剧本状态：卡一多就靠它筛和看进度。'' = 没标。 */
export const CARD_STATUSES = [
  { id: '', title: '未标记' },
  { id: 'wish', title: '想玩' },
  { id: 'playing', title: '在玩' },
  { id: 'done', title: '已完结' },
  { id: 'paused', title: '搁置' },
];

const CARD_STATUS_IDS = new Set(CARD_STATUSES.map((item) => item.id));

/** 认不出来的状态一律当"没标"，别让脏数据进库。 */
export function normalizeStatus(value) {
  const id = String(value ?? '').trim();
  return CARD_STATUS_IDS.has(id) ? id : '';
}

/** 标签去重、去空白，保持用户写的顺序。 */
export function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    const tag = String(raw ?? '').trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/** 把 patch 里散着的卡字段挑出来，合并到已有 data 上。 */
function mergeFields(data, patch) {
  const out = { ...data };
  for (const key of FIELD_KEYS) {
    if (patch[key] !== undefined && key !== 'tags') out[key] = patch[key];
  }
  if (patch.tags !== undefined) out.tags = normalizeTags(patch.tags);
  if (patch.name !== undefined) out.name = patch.name;
  return out;
}

function hasCardFields(patch) {
  return patch.card !== undefined || patch.data !== undefined || FIELD_KEYS.some((key) => patch[key] !== undefined);
}

export function createCardService({ settings, ports = {} } = {}) {
  void settings;
  const store = ports.cardStore ?? null;

  function requireStore(what) {
    if (!store) throw new NotImplementedError(what, { reason: '没有注入角色卡存储端口（ports.cardStore）' });
    return store;
  }

  return {
    /** 字段表，给界面生成表单用。 */
    fields: () => CARD_FIELDS,

    // ---------------------------------------------------------------- 读

    list: async (query = {}) => (store ? store.list(query ?? {}) : emptyList()),
    get: async (id) => (store ? store.get(id) : null),
    stats: async () => (store ? store.stats() : { total: 0, favorites: 0, tags: [] }),

    // ---------------------------------------------------------------- 写

    create: async (payload = {}) => {
      const cardStore = requireStore('新建角色卡');
      let data;
      let specVersion;
      if (payload.data || payload.card) {
        const normalized = normalizeCard(payload.card ?? { spec: 'chara_card_v2', spec_version: '2.0', data: payload.data ?? {} });
        data = payload.card ? normalized.data : normalizeCard({ spec: 'chara_card_v2', spec_version: '2.0', data: payload.data }).data;
        specVersion = normalizeSpec(payload.specVersion ?? normalized.spec, normalized.spec);
      } else {
        data = normalizeCard({ spec: 'chara_card_v2', spec_version: '2.0', data: mergeFields({}, payload) }).data;
        specVersion = normalizeSpec(payload.specVersion, 'v2');
      }
      data.tags = normalizeTags(data.tags);
      return cardStore.insert({
        name: payload.name ?? data.name,
        specVersion,
        data,
        source: payload.source ?? 'original',
        tags: normalizeTags(payload.tags ?? data.tags),
        favorite: Boolean(payload.favorite),
        status: normalizeStatus(payload.status),
        avatar: payload.avatar ?? null,
      });
    },

    update: async (id, patch = {}) => {
      const cardStore = requireStore('保存角色卡');
      const existing = cardStore.get(id);
      if (!existing) return null;

      const next = {};
      if (hasCardFields(patch)) {
        let data;
        if (patch.card) data = normalizeCard(patch.card).data;
        else if (patch.data) data = normalizeCard({ spec: 'chara_card_v2', spec_version: '2.0', data: patch.data }).data;
        else data = normalizeCard({ spec: 'chara_card_v2', spec_version: '2.0', data: mergeFields(existing.data, patch) }).data;
        data.tags = normalizeTags(patch.tags ?? data.tags ?? []);
        next.data = data;
        next.name = data.name;
      }
      if (patch.specVersion !== undefined) next.specVersion = normalizeSpec(patch.specVersion, existing.specVersion);
      if (patch.favorite !== undefined) next.favorite = Boolean(patch.favorite);
      if (patch.status !== undefined) next.status = normalizeStatus(patch.status);
      if (patch.tags !== undefined) next.tags = normalizeTags(patch.tags);
      if (patch.source !== undefined) next.source = patch.source;
      if (patch.avatar !== undefined) next.avatar = patch.avatar;

      const updated = cardStore.update(id, next);
      if (next.data === undefined) return updated;
      // 先留档再取一遍，返回的 versionCount 才是最新的。
      cardStore.addVersion(id, updated.data, String(patch.note ?? '保存'));
      return cardStore.get(id);
    },

    remove: async (id) => {
      const cardStore = requireStore('删除角色卡');
      cardStore.remove(id);
      return true;
    },

    // ---------------------------------------------------------------- 解析 / 导入 / 导出

    /** 解析一段卡文件，但不落库（编辑器预览、导入确认用）。 */
    parse: async (buffer, { name = '' } = {}) => {
      const parsed = parseCardBuffer(buffer, name);
      return {
        spec: parsed.spec,
        specVersion: parsed.specVersion,
        data: parsed.data,
        name: parsed.name,
        keyword: parsed.keyword,
        hasImage: Boolean(parsed.image),
      };
    },

    /** 把一张卡序列化成文件字节。 */
    write: async (id, { format = 'json', spec = null } = {}) => {
      const cardStore = requireStore('导出角色卡');
      const card = cardStore.get(id);
      if (!card) return null;
      const image = format === 'png' ? cardStore.readAvatar(id) : null;
      const doc = { spec: card.specVersion, data: card.data, raw: null };
      return writeCardBuffer(doc, { format, spec: spec ? normalizeSpec(spec) : card.specVersion, image, filename: card.name });
    },

    exportPng: async (id) => {
      const cardStore = requireStore('导出 PNG 卡');
      const card = cardStore.get(id);
      if (!card) return null;
      const image = cardStore.readAvatar(id);
      return {
        buffer: embedCardInPng(image, toShareableCard({ spec: card.specVersion, data: card.data }, { spec: 'v2' })),
        mime: 'image/png',
        filename: `${card.name}.png`,
      };
    },

    /**
     * 批量导入。files: [{ name, buffer }]
     * 单个文件坏掉不影响其它，错误逐条收集返回给界面。
     */
    importFiles: async (files = [], { source = 'imported' } = {}) => {
      const cardStore = requireStore('批量导入角色卡');
      const items = [];
      const errors = [];
      for (const file of files) {
        try {
          const parsed = parseCardBuffer(file.buffer, file.name ?? '');
          parsed.data.tags = normalizeTags(parsed.data.tags);
          items.push(
            cardStore.insert({
              name: parsed.data.name,
              specVersion: parsed.spec,
              data: parsed.data,
              source,
              tags: parsed.data.tags ?? [],
              avatar: parsed.image,
            }),
          );
        } catch (err) {
          errors.push({ name: file.name ?? '（无名文件）', message: err?.message ?? String(err) });
        }
      }
      return { items, total: items.length, imported: items.length, skipped: errors.length, errors };
    },

    // ---------------------------------------------------------------- 版本

    listVersions: async (id) => {
      const cardStore = requireStore('角色卡版本历史');
      const items = cardStore.listVersions(id);
      return { items, total: items.length };
    },

    restoreVersion: async (id, versionId) => {
      const cardStore = requireStore('回滚角色卡版本');
      return cardStore.restoreVersion(id, versionId);
    },

    /** 头像 PNG 字节（PNG 卡导入时存下来的）。 */
    avatar: async (id) => (store ? store.readAvatar(id) : null),

    // 给编辑器看的原始文档（保留 unknown 字段），方便"另存为"。
    document: async (id, { spec = null } = {}) => {
      const cardStore = requireStore('读取角色卡文档');
      const card = cardStore.get(id);
      if (!card) return null;
      return toShareableCard({ spec: card.specVersion, data: card.data }, { spec: spec ? normalizeSpec(spec) : card.specVersion });
    },
  };
}
