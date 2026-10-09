/**
 * 提示词存储：预设（prompt_presets）、片段（prompt_snippets）、正则脚本（regex_scripts）。
 *
 * 自定义宏没有单独建表（已发布的迁移不许改，新表要走 migration 且容易和别的
 * 改动撞车）：存在 prompt_presets 里一条 `kind='macro'`、id 固定为 `__macros__`
 * 的隐藏行里，data = { macros: {名字: 值} }。列表接口会把它排除掉。
 */

import { newId, nowIso } from '../../core/ids.mjs';
import { fromJson } from './repo.mjs';
import { NotFoundError } from '../../core/errors.mjs';
import { normalizeScript } from '../../core/prompts/regex.mjs';

const MACRO_ROW_ID = '__macros__';

function rowToPreset(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind ?? 'chat',
    data: fromJson(row.data, {}),
    source: row.source ?? 'original',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRegex(row) {
  if (!row) return null;
  const data = fromJson(row.data, {});
  return {
    ...normalizeScript({ ...data, id: row.id, scriptName: row.name ?? data.scriptName }),
    id: row.id,
    name: row.name,
    scope: row.scope ?? 'global',
    ownerId: row.owner_id ?? null,
    enabled: Boolean(row.enabled) && !data.disabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createPromptStore({ repo }) {
  // ---------------------------------------------------------------- 预设

  function listPresets({ q = '', kind = 'chat' } = {}) {
    const where = ["kind != 'macro'"];
    const params = [];
    if (kind) {
      where.push('kind = ?');
      params.push(kind);
    }
    if (q) {
      where.push('name LIKE ?');
      params.push(`%${q}%`);
    }
    const rows = repo.all(`SELECT * FROM prompt_presets WHERE ${where.join(' AND ')} ORDER BY updated_at DESC`, params);
    const items = rows.map(rowToPreset);
    return { items, total: items.length };
  }

  function getPreset(id) {
    if (id === MACRO_ROW_ID) return null;
    return rowToPreset(repo.get('SELECT * FROM prompt_presets WHERE id = ?', [id]));
  }

  function insertPreset({ name = '未命名预设', kind = 'chat', data = {}, source = 'original' } = {}) {
    const id = newId('preset');
    const now = nowIso();
    repo.run(
      'INSERT INTO prompt_presets (id, name, kind, data, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, name, kind, JSON.stringify(data ?? {}), source, now, now],
    );
    return getPreset(id);
  }

  function updatePreset(id, patch = {}) {
    const existing = getPreset(id);
    if (!existing) throw new NotFoundError(`提示词预设 ${id}`);
    const fields = [];
    const params = [];
    if (patch.name !== undefined) { fields.push('name = ?'); params.push(String(patch.name)); }
    if (patch.kind !== undefined) { fields.push('kind = ?'); params.push(String(patch.kind)); }
    if (patch.data !== undefined) { fields.push('data = ?'); params.push(JSON.stringify(patch.data ?? {})); }
    if (patch.source !== undefined) { fields.push('source = ?'); params.push(String(patch.source)); }
    fields.push('updated_at = ?');
    params.push(nowIso(), id);
    repo.run(`UPDATE prompt_presets SET ${fields.join(', ')} WHERE id = ?`, params);
    return getPreset(id);
  }

  function removePreset(id) {
    if (!getPreset(id)) throw new NotFoundError(`提示词预设 ${id}`);
    repo.run('DELETE FROM prompt_presets WHERE id = ?', [id]);
    return true;
  }

  // ---------------------------------------------------------------- 自定义宏

  function getMacros() {
    const row = repo.get('SELECT data FROM prompt_presets WHERE id = ?', [MACRO_ROW_ID]);
    const data = fromJson(row?.data, {});
    return data && typeof data.macros === 'object' && data.macros ? data.macros : {};
  }

  function saveMacros(macros = {}) {
    const now = nowIso();
    const clean = {};
    for (const [key, value] of Object.entries(macros ?? {})) {
      const name = String(key).trim();
      if (name) clean[name] = String(value ?? '');
    }
    const existing = repo.get('SELECT id FROM prompt_presets WHERE id = ?', [MACRO_ROW_ID]);
    if (existing) {
      repo.run('UPDATE prompt_presets SET data = ?, updated_at = ? WHERE id = ?', [JSON.stringify({ macros: clean }), now, MACRO_ROW_ID]);
    } else {
      repo.run(
        'INSERT INTO prompt_presets (id, name, kind, data, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [MACRO_ROW_ID, '自定义宏', 'macro', JSON.stringify({ macros: clean }), 'original', now, now],
      );
    }
    return clean;
  }

  // ---------------------------------------------------------------- 正则脚本

  function listRegex({ scope = null } = {}) {
    const rows = scope
      ? repo.all('SELECT * FROM regex_scripts WHERE scope = ? ORDER BY created_at ASC', [scope])
      : repo.all('SELECT * FROM regex_scripts ORDER BY created_at ASC');
    return { items: rows.map(rowToRegex), total: rows.length };
  }

  function getRegex(id) {
    return rowToRegex(repo.get('SELECT * FROM regex_scripts WHERE id = ?', [id]));
  }

  function saveRegex(payload = {}) {
    const now = nowIso();
    const id = payload.id ?? newId('regex');
    const script = normalizeScript({ ...payload, id }, 0);
    const name = String(payload.name ?? script.scriptName ?? '正则脚本');
    const scope = String(payload.scope ?? 'global');
    const ownerId = payload.ownerId ?? null;
    const enabled = payload.enabled === false ? 0 : script.disabled ? 0 : 1;
    const existing = repo.get('SELECT id FROM regex_scripts WHERE id = ?', [id]);
    if (existing) {
      repo.run(
        'UPDATE regex_scripts SET name = ?, scope = ?, owner_id = ?, data = ?, enabled = ?, updated_at = ? WHERE id = ?',
        [name, scope, ownerId, JSON.stringify(script), enabled, now, id],
      );
    } else {
      repo.run(
        'INSERT INTO regex_scripts (id, name, scope, owner_id, data, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [id, name, scope, ownerId, JSON.stringify(script), enabled, now, now],
      );
    }
    return getRegex(id);
  }

  function removeRegex(id) {
    if (!getRegex(id)) throw new NotFoundError(`正则脚本 ${id}`);
    repo.run('DELETE FROM regex_scripts WHERE id = ?', [id]);
    return true;
  }

  /** 引擎用：拿到所有启用脚本（已归一化），按 scope 全局在先。 */
  function activeScripts() {
    return repo.all(
      "SELECT * FROM regex_scripts WHERE enabled = 1 ORDER BY CASE scope WHEN 'global' THEN 0 WHEN 'character' THEN 1 ELSE 2 END, created_at ASC",
    )
      .map(rowToRegex)
      .map((row) => ({ ...row, disabled: !row.enabled, placement: Array.isArray(row.placement) ? row.placement : [] }));
  }

  // ---------------------------------------------------------------- 模块（Mod）
  // 一个模块 = 一句话说明 + 提示词 + 可选 CSS / HTML / JS，
  // 另外还能带三样"零件"：世界书条目 / 正则脚本 / 背景图（在 module_parts 里，见 V15）。
  // 提示词按 position 插进提示词；CSS 注入聊天页；HTML/JS 走沙箱 iframe。
  // 限制规则见 core/prompts/module-css.mjs 的说明。

  /** 模块的零件（世界书 / 正则 / 背景图）—— 一次把一批模块的都读出来，别 N 次查库。 */
  const PART_KINDS = ['worldbook', 'worldbookText', 'regex', 'background'];

  function partsOf(ids = []) {
    const map = new Map();
    if (!ids.length) return map;
    const placeholders = ids.map(() => '?').join(',');
    for (const row of repo.all(
      `SELECT module_id, kind, payload FROM module_parts WHERE module_id IN (${placeholders})`,
      ids,
    )) {
      if (!PART_KINDS.includes(row.kind)) continue;
      if (!map.has(row.module_id)) map.set(row.module_id, {});
      const bag = map.get(row.module_id);
      bag[row.kind] = row.kind === 'worldbookText' || row.kind === 'background' ? String(row.payload ?? '') : fromJson(row.payload, []);
    }
    return map;
  }

  function writeParts(id, parts = {}) {
    for (const kind of PART_KINDS) {
      if (parts[kind] === undefined) continue;
      const value = parts[kind];
      const empty = kind === 'worldbookText' || kind === 'background'
        ? !String(value ?? '').trim()
        : !Array.isArray(value) || !value.length;
      if (empty) {
        repo.run('DELETE FROM module_parts WHERE module_id = ? AND kind = ?', [id, kind]);
        continue;
      }
      repo.run(
        `INSERT INTO module_parts (module_id, kind, payload, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(module_id, kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
        [id, kind, kind === 'worldbookText' || kind === 'background' ? String(value) : JSON.stringify(value), nowIso()],
      );
    }
  }

  function rowToModule(row, extra = {}) {
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      description: row.description ?? '',
      body: row.body ?? '',
      css: row.css ?? '',
      html: row.html ?? '',
      js: row.js ?? '',
      capabilities: fromJson(row.capabilities, []),
      position: row.position ?? 'after-history',
      source: row.source ?? 'original',
      tags: fromJson(row.tags, []),
      worldbook: Array.isArray(extra.worldbook) ? extra.worldbook : [],
      worldbookText: typeof extra.worldbookText === 'string' ? extra.worldbookText : '',
      regex: Array.isArray(extra.regex) ? extra.regex : [],
      background: typeof extra.background === 'string' ? extra.background : '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function listModules({ q = '' } = {}) {
    const rows = q
      ? repo.all(
          'SELECT * FROM modules WHERE title LIKE ? OR body LIKE ? OR description LIKE ? ORDER BY updated_at DESC',
          [`%${q}%`, `%${q}%`, `%${q}%`],
        )
      : repo.all('SELECT * FROM modules ORDER BY updated_at DESC');
    const parts = partsOf(rows.map((row) => row.id));
    const items = rows.map((row) => rowToModule(row, parts.get(row.id) ?? {}));
    return { items, total: items.length };
  }

  function getModule(id) {
    return rowToModule(repo.get('SELECT * FROM modules WHERE id = ?', [id]), partsOf([id]).get(id) ?? {});
  }

  function saveModule(payload = {}) {
    const now = nowIso();
    const id = payload.id ?? newId('mod');
    const existing = repo.get('SELECT * FROM modules WHERE id = ?', [id]);
    const before = existing ? getModule(id) : {};
    const pick = (key, fallback) => (payload[key] === undefined ? (before[key] ?? fallback) : payload[key]);
    const title = String(pick('title', '未命名模块'));
    const description = String(pick('description', ''));
    const body = String(pick('body', ''));
    const css = String(pick('css', ''));
    const html = String(pick('html', ''));
    const js = String(pick('js', ''));
    const position = String(pick('position', 'after-history'));
    // 来源也只认两个值：自己写的 original / 别人给的 imported（导入时按这个决定限制档）
    const source = String(pick('source', 'original')) === 'imported' ? 'imported' : 'original';
    const tags = Array.isArray(payload.tags) ? payload.tags.map(String) : (before.tags ?? []);
    const capabilities = Array.isArray(payload.capabilities)
      ? payload.capabilities.map(String)
      : (before.capabilities ?? []);
    if (existing) {
      repo.run(
        `UPDATE modules SET title = ?, description = ?, body = ?, css = ?, html = ?, js = ?,
           capabilities = ?, position = ?, source = ?, tags = ?, updated_at = ? WHERE id = ?`,
        [title, description, body, css, html, js, JSON.stringify(capabilities), position, source, JSON.stringify(tags), now, id],
      );
    } else {
      repo.run(
        `INSERT INTO modules (id, title, description, body, css, html, js, capabilities, position, source, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, title, description, body, css, html, js, JSON.stringify(capabilities), position, source, JSON.stringify(tags), now, now],
      );
    }
    // 世界书 / 正则 / 背景图：没传的键保持原样（和上面 pick 的规矩一致）
    writeParts(id, {
      worldbook: payload.worldbook,
      worldbookText: payload.worldbookText,
      regex: payload.regex,
      background: payload.background,
    });
    return getModule(id);
  }

  function removeModule(id) {
    repo.run('DELETE FROM modules WHERE id = ?', [id]);
    repo.run('DELETE FROM module_trust WHERE module_id = ?', [id]);
    repo.run('DELETE FROM module_parts WHERE module_id = ?', [id]);
    return true;
  }

  // ---- 模块信任：跟卡内前端一个路子，绑在代码哈希上 ----

  function getModuleTrust(id) {
    const row = repo.get('SELECT module_id, code_hash, granted_at FROM module_trust WHERE module_id = ?', [id]);
    return row ? { id: row.module_id, codeHash: row.code_hash, grantedAt: row.granted_at } : null;
  }

  function grantModuleTrust(id, codeHash) {
    repo.run(
      `INSERT INTO module_trust (module_id, code_hash, granted_at) VALUES (?, ?, ?)
       ON CONFLICT(module_id) DO UPDATE SET code_hash = excluded.code_hash, granted_at = excluded.granted_at`,
      [id, String(codeHash), nowIso()],
    );
    return getModuleTrust(id);
  }

  function revokeModuleTrust(id) {
    repo.run('DELETE FROM module_trust WHERE module_id = ?', [id]);
    return true;
  }

  return {
    listPresets, getPreset, insertPreset, updatePreset, removePreset,
    getMacros, saveMacros,
    listRegex, getRegex, saveRegex, removeRegex, activeScripts,
    listModules, getModule, saveModule, removeModule,
    getModuleTrust, grantModuleTrust, revokeModuleTrust,
  };
}
