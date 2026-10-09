/**
 * 卡内前端的存储层：自定义主题、代码片段、以及"我信任过这张卡的这段代码"。
 *
 * 主题是全局的（所有界面共用的 CSS 变量）；片段按 `scope` 存
 * （角色卡 id / 对话 id / `global`），这样一张卡的界面代码能跟着卡走。
 * 信任记录单独一张表、绑代码哈希 —— 绝不放进卡数据（那会跟着导出走，等于卡自证可信）。
 */

import { newId, nowIso } from '../../core/ids.mjs';
import { fromJson } from './repo.mjs';

const THEME_COLUMNS = 'id, name, tokens, created_at, updated_at';
const SNIPPET_COLUMNS = 'id, scope, name, html, css, js, capabilities, created_at, updated_at';

function themeToObject(row) {
  if (!row) return null;
  return { id: row.id, name: row.name, tokens: fromJson(row.tokens, {}), createdAt: row.created_at, updatedAt: row.updated_at, builtin: false };
}

function snippetToObject(row) {
  if (!row) return null;
  return {
    id: row.id,
    scope: row.scope ?? '',
    name: row.name,
    html: row.html ?? '',
    css: row.css ?? '',
    js: row.js ?? '',
    capabilities: fromJson(row.capabilities, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createFrontendStore({ repo }) {
  function listThemes() {
    return repo.all(`SELECT ${THEME_COLUMNS} FROM frontend_themes ORDER BY updated_at DESC`).map(themeToObject);
  }

  function getTheme(id) {
    return themeToObject(repo.get(`SELECT ${THEME_COLUMNS} FROM frontend_themes WHERE id = ?`, [id]));
  }

  function saveTheme(input = {}) {
    const id = input.id ?? newId('thm');
    const now = nowIso();
    repo.run(
      `INSERT INTO frontend_themes (id, name, tokens, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, tokens = excluded.tokens, updated_at = excluded.updated_at`,
      [id, input.name ?? '自定义主题', JSON.stringify(input.tokens ?? {}), now, now],
    );
    return getTheme(id);
  }

  function removeTheme(id) {
    const found = getTheme(id);
    if (!found) return false;
    repo.run('DELETE FROM frontend_themes WHERE id = ?', [id]);
    return true;
  }

  function listSnippets({ scope = null } = {}) {
    if (scope === null || scope === undefined) {
      return repo.all(`SELECT ${SNIPPET_COLUMNS} FROM frontend_snippets ORDER BY updated_at DESC`).map(snippetToObject);
    }
    return repo.all(`SELECT ${SNIPPET_COLUMNS} FROM frontend_snippets WHERE scope = ? ORDER BY updated_at DESC`, [String(scope)]).map(snippetToObject);
  }

  function getSnippet(id) {
    return snippetToObject(repo.get(`SELECT ${SNIPPET_COLUMNS} FROM frontend_snippets WHERE id = ?`, [id]));
  }

  function saveSnippet(input = {}) {
    const id = input.id ?? newId('snp');
    const now = nowIso();
    repo.run(
      `INSERT INTO frontend_snippets (id, scope, name, html, css, js, capabilities, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         scope = excluded.scope, name = excluded.name, html = excluded.html, css = excluded.css,
         js = excluded.js, capabilities = excluded.capabilities, updated_at = excluded.updated_at`,
      [
        id,
        String(input.scope ?? ''),
        input.name ?? '未命名片段',
        String(input.html ?? ''),
        String(input.css ?? ''),
        String(input.js ?? ''),
        JSON.stringify(input.capabilities ?? []),
        now,
        now,
      ],
    );
    return getSnippet(id);
  }

  function removeSnippet(id) {
    const found = getSnippet(id);
    if (!found) return false;
    repo.run('DELETE FROM frontend_snippets WHERE id = ?', [id]);
    return true;
  }

  // ---------------------------------------------------------------- 信任（绑代码哈希）

  function getTrust(characterId) {
    const row = repo.get('SELECT character_id, code_hash, granted_at FROM card_frontend_trust WHERE character_id = ?', [String(characterId)]);
    if (!row) return null;
    return { characterId: row.character_id, codeHash: row.code_hash, grantedAt: row.granted_at };
  }

  function grantTrust(characterId, codeHash) {
    const now = nowIso();
    repo.run(
      `INSERT INTO card_frontend_trust (character_id, code_hash, granted_at) VALUES (?, ?, ?)
       ON CONFLICT(character_id) DO UPDATE SET code_hash = excluded.code_hash, granted_at = excluded.granted_at`,
      [String(characterId), String(codeHash), now],
    );
    return getTrust(characterId);
  }

  function revokeTrust(characterId) {
    const found = getTrust(characterId);
    if (!found) return false;
    repo.run('DELETE FROM card_frontend_trust WHERE character_id = ?', [String(characterId)]);
    return true;
  }

  return {
    listThemes,
    getTheme,
    saveTheme,
    removeTheme,
    listSnippets,
    getSnippet,
    saveSnippet,
    removeSnippet,
    getTrust,
    grantTrust,
    revokeTrust,
  };
}
