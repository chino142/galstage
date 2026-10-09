/**
 * 提供方与模型绑定的读写。
 *
 * 对外返回的提供方**永远不带明文 key**：带 key 的那份只有网关内部拿得到。
 */

import { newId, nowIso } from '../../core/ids.mjs';
import { ValidationError, NotFoundError } from '../../core/errors.mjs';
import { encryptSecret, decryptSecret, maskSecret } from '../secrets.mjs';
import { adapterSupports, adapterById } from '../providers/catalog.mjs';
import { AUTH_STYLES } from '../providers/auth.mjs';
import { PROVIDER_KINDS, getProviderKind } from '../../core/providers.mjs';

const PUBLIC_COLUMNS =
  'id, label, kind, adapter, base_url, model, params, preset, enabled, is_default, headers, auth_style, launcher, last_test_at, last_test_ok, last_test_error, created_at, updated_at';

/** 自定义请求头：只收字符串值，键去掉首尾空格。 */
export function normaliseHeaders(input) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    const name = String(key).trim();
    if (!name) continue;
    out[name] = String(value ?? '');
  }
  return out;
}

/** 本地代理进程配置。命令必填，没有命令就当没配。 */
/**
 * 自定义请求体：存成一份 JSON，调用时并进请求体里。
 * 放在单独一张表（provider_extra），这样不用给 providers 加列。
 */
export function getProviderExtraBody(repo, id) {
  try {
    const row = repo.get('SELECT extra_body FROM provider_extra WHERE provider_id = ?', [String(id)]);
    if (!row) return {};
    const parsed = JSON.parse(row.extra_body || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function setProviderExtraBody(repo, id, body = {}) {
  const clean = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  repo.run(
    `INSERT INTO provider_extra (provider_id, extra_body, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(provider_id) DO UPDATE SET extra_body = excluded.extra_body, updated_at = excluded.updated_at`,
    [String(id), JSON.stringify(clean), new Date().toISOString()],
  );
  return clean;
}

/**
 * 参数覆盖表（V16）：这家提供方的模型不认哪些参数、又有哪些专属参数。
 * 形状：{ disabled: string[], custom: [{ key, label, type, options?, path?, help? }] }
 */
export function getProviderParamOverrides(repo, id) {
  try {
    const row = repo.get('SELECT disabled, custom FROM provider_param_overrides WHERE provider_id = ?', [String(id)]);
    if (!row) return { disabled: [], custom: [] };
    const disabled = JSON.parse(row.disabled || '[]');
    const custom = JSON.parse(row.custom || '[]');
    return {
      disabled: Array.isArray(disabled) ? disabled.map(String) : [],
      custom: Array.isArray(custom) ? custom.filter((item) => item && typeof item === 'object') : [],
    };
  } catch {
    return { disabled: [], custom: [] };
  }
}

export function setProviderParamOverrides(repo, id, input = {}) {
  const disabled = Array.isArray(input?.disabled) ? [...new Set(input.disabled.map((key) => String(key ?? '').trim()).filter(Boolean))] : [];
  const custom = Array.isArray(input?.custom)
    ? input.custom
        .filter((item) => item && typeof item === 'object' && String(item.key ?? '').trim())
        .map((item) => ({
          key: String(item.key).trim(),
          label: String(item.label ?? item.key).trim().slice(0, 40),
          type: ['number', 'int', 'boolean', 'enum', 'string', 'json'].includes(String(item.type)) ? String(item.type) : 'number',
          options: Array.isArray(item.options) ? item.options.map(String).slice(0, 12) : null,
          // 放哪个路径：'top' = 请求体顶层（OpenAI 风格的中转认这个）；
          // 点号路径 = 嵌进去（Gemini 原生是 generationConfig.thinkingConfig.thinkingLevel）
          path: String(item.path ?? 'top').trim().slice(0, 120) || 'top',
          help: String(item.help ?? '').slice(0, 300),
        }))
        .slice(0, 24)
    : [];
  repo.run(
    `INSERT INTO provider_param_overrides (provider_id, disabled, custom, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(provider_id) DO UPDATE SET disabled = excluded.disabled, custom = excluded.custom, updated_at = excluded.updated_at`,
    [String(id), JSON.stringify(disabled), JSON.stringify(custom), new Date().toISOString()],
  );
  return { disabled, custom };
}

export function normaliseLauncher(input) {
  if (!input || typeof input !== 'object') return null;
  const command = String(input.command ?? '').trim();
  if (!command) return null;
  return {
    command,
    args: Array.isArray(input.args) ? input.args.map(String) : String(input.args ?? '').split(/\s+/).filter(Boolean),
    env: input.env && typeof input.env === 'object' ? input.env : {},
    cwd: input.cwd ? String(input.cwd) : null,
    host: input.host ? String(input.host) : '127.0.0.1',
    port: input.port ? Number(input.port) : null,
    timeoutMs: input.timeoutMs ? Number(input.timeoutMs) : 45000,
  };
}

function rowToPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    adapter: row.adapter,
    baseUrl: row.base_url ?? '',
    model: row.model ?? '',
    params: row.params ? JSON.parse(row.params) : {},
    headers: row.headers ? JSON.parse(row.headers) : {},
    authStyle: row.auth_style ?? null,
    launcher: row.launcher ? JSON.parse(row.launcher) : null,
    preset: row.preset ?? null,
    enabled: Boolean(row.enabled),
    isDefault: Boolean(row.is_default),
    hasKey: Boolean(row.api_key),
    keyHint: '',
    lastTest: row.last_test_at
      ? { at: row.last_test_at, ok: Boolean(row.last_test_ok), error: row.last_test_error ?? null }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 网关用：带明文 key 的完整配置。 */
export function providerConfig(repo, masterKey, id) {
  const row = repo.get('SELECT * FROM providers WHERE id = ?', [id]);
  if (!row) return null;
  let apiKey = '';
  try {
    apiKey = decryptSecret(masterKey, row.api_key);
  } catch {
    apiKey = '';
  }
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    adapter: row.adapter,
    baseUrl: row.base_url ?? '',
    model: row.model ?? '',
    apiKey,
    params: row.params ? JSON.parse(row.params) : {},
    headers: row.headers ? JSON.parse(row.headers) : {},
    authStyle: row.auth_style ?? null,
    launcher: row.launcher ? JSON.parse(row.launcher) : null,
    enabled: Boolean(row.enabled),
    isDefault: Boolean(row.is_default),
  };
}

export function listProviders(repo, { kind } = {}) {
  const rows = kind
    ? repo.all(`SELECT ${PUBLIC_COLUMNS}, api_key FROM providers WHERE kind = ? ORDER BY is_default DESC, created_at`, [kind])
    : repo.all(`SELECT ${PUBLIC_COLUMNS}, api_key FROM providers ORDER BY kind, is_default DESC, created_at`);
  return rows.map((row) => ({ ...rowToPublic(row), keyHint: row.api_key ? '已保存' : '' }));
}

export function getProvider(repo, id) {
  const row = repo.get(`SELECT ${PUBLIC_COLUMNS}, api_key FROM providers WHERE id = ?`, [id]);
  if (!row) return null;
  const publicRow = rowToPublic(row);
  publicRow.keyHint = row.api_key ? '已保存' : '';
  return publicRow;
}

function validateInput(repo, input, { existing = null } = {}) {
  const label = String(input.label ?? existing?.label ?? '').trim();
  if (!label) throw new ValidationError('提供方需要一个名字');

  const kind = String(input.kind ?? existing?.kind ?? 'chat');
  if (!PROVIDER_KINDS.some((item) => item.id === kind)) {
    throw new ValidationError(`未知用途：${kind}`);
  }

  const adapter = String(input.adapter ?? existing?.adapter ?? 'openai');
  if (!adapterById(adapter)) throw new ValidationError(`未知适配器：${adapter}`);
  if (!adapterSupports(adapter, kind)) {
    throw new ValidationError(`${adapterById(adapter).title} 不支持「${getProviderKind(kind).title}」`);
  }

  const baseUrl = String(input.baseUrl ?? existing?.baseUrl ?? '').trim();
  // Vertex 服务账号模式可以不填地址（按 location 拼），其余必须有
  const vertexLocal = adapter === 'vertex' && String(input.params?.vertexMode ?? existing?.params?.vertexMode ?? '') === 'serviceAccount';
  if (!baseUrl && !vertexLocal) throw new ValidationError('需要填写接口地址（base URL）');

  if (input.authStyle) {
    if (!AUTH_STYLES.some((style) => style.id === input.authStyle)) {
      throw new ValidationError(`未知鉴权方式：${input.authStyle}`);
    }
  }

  return { label, kind, adapter, baseUrl, model: String(input.model ?? existing?.model ?? '').trim() };
}

export function createProvider(repo, masterKey, input) {
  const clean = validateInput(repo, input);
  const id = newId('prov');
  const now = nowIso();
  const params = input.params && typeof input.params === 'object' ? input.params : {};
  repo.run(
    `INSERT INTO providers (id, label, kind, adapter, base_url, model, api_key, params, preset, enabled, is_default, headers, auth_style, launcher, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      clean.label,
      clean.kind,
      clean.adapter,
      clean.baseUrl,
      clean.model,
      encryptSecret(masterKey, input.apiKey ?? ''),
      JSON.stringify(params),
      input.preset ?? null,
      input.enabled === false ? 0 : 1,
      input.isDefault ? 1 : 0,
      JSON.stringify(normaliseHeaders(input.headers)),
      input.authStyle ?? null,
      input.launcher ? JSON.stringify(normaliseLauncher(input.launcher)) : null,
      now,
      now,
    ],
  );
  if (input.isDefault) setDefault(repo, id, clean.kind);
  return getProvider(repo, id);
}

export function updateProvider(repo, masterKey, id, input) {
  const existing = getProvider(repo, id);
  if (!existing) throw new NotFoundError(`提供方 ${id}`);
  const merged = { ...existing, ...input, kind: input.kind ?? existing.kind, adapter: input.adapter ?? existing.adapter };
  const clean = validateInput(repo, merged, { existing });
  const now = nowIso();

  // apiKey 不传 = 保持原样；传空串 = 清除
  const params = [clean.label, clean.kind, clean.adapter, clean.baseUrl, clean.model];
  if (input.params !== undefined) {
    params.push(JSON.stringify(input.params ?? {}));
  }
  let sql = `UPDATE providers SET label = ?, kind = ?, adapter = ?, base_url = ?, model = ?`;
  if (input.params !== undefined) sql += ', params = ?';
  if (input.apiKey !== undefined) {
    sql += ', api_key = ?';
    params.push(encryptSecret(masterKey, input.apiKey));
  }
  if (input.preset !== undefined) {
    sql += ', preset = ?';
    params.push(input.preset);
  }
  if (input.enabled !== undefined) {
    sql += ', enabled = ?';
    params.push(input.enabled ? 1 : 0);
  }
  if (input.headers !== undefined) {
    sql += ', headers = ?';
    params.push(JSON.stringify(normaliseHeaders(input.headers)));
  }
  if (input.authStyle !== undefined) {
    sql += ', auth_style = ?';
    params.push(input.authStyle ?? null);
  }
  if (input.launcher !== undefined) {
    sql += ', launcher = ?';
    params.push(input.launcher ? JSON.stringify(normaliseLauncher(input.launcher)) : null);
  }
  sql += ', updated_at = ? WHERE id = ?';
  params.push(now, id);
  repo.run(sql, params);

  if (input.isDefault) setDefault(repo, id, clean.kind);
  return getProvider(repo, id);
}

function setDefault(repo, id, kind) {
  repo.transaction(() => {
    repo.run('UPDATE providers SET is_default = 0 WHERE kind = ?', [kind]);
    repo.run('UPDATE providers SET is_default = 1 WHERE id = ?', [id]);
  });
}

export function deleteProvider(repo, id) {
  const existing = getProvider(repo, id);
  if (!existing) throw new NotFoundError(`提供方 ${id}`);
  repo.run('DELETE FROM providers WHERE id = ?', [id]);
  return true;
}

export function recordTest(repo, id, { ok, error = null }) {
  repo.run('UPDATE providers SET last_test_at = ?, last_test_ok = ?, last_test_error = ? WHERE id = ?', [
    nowIso(),
    ok ? 1 : 0,
    error,
    id,
  ]);
}

export function defaultProviderFor(repo, kind) {
  return repo.get('SELECT * FROM providers WHERE kind = ? AND enabled = 1 ORDER BY is_default DESC, created_at LIMIT 1', [kind]);
}

// ---------------------------------------------------------------- 绑定

function bindingRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    scope: row.scope,
    targetId: row.target_id,
    kind: row.kind,
    providerId: row.provider_id,
    model: row.model ?? '',
    params: row.params ? JSON.parse(row.params) : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listBindings(repo, { kind } = {}) {
  const rows = kind
    ? repo.all('SELECT * FROM model_bindings WHERE kind = ? ORDER BY scope, target_id', [kind])
    : repo.all('SELECT * FROM model_bindings ORDER BY scope, target_id');
  return rows.map(bindingRow);
}

export function setBinding(repo, input) {
  const scope = String(input.scope ?? 'default');
  if (!['default', 'chat', 'character', 'chat_member'].includes(scope)) {
    throw new ValidationError(`未知绑定范围：${scope}`);
  }
  const providerId = String(input.providerId ?? '');
  if (!getProvider(repo, providerId)) throw new NotFoundError(`提供方 ${providerId}`);

  const targetId = scope === 'default' ? '' : String(input.targetId ?? '');
  if (scope !== 'default' && !targetId) throw new ValidationError(`${scope} 绑定必须给出对象 id`);

  const kind = String(input.kind ?? 'chat');
  const now = nowIso();
  const existing = repo.get('SELECT id FROM model_bindings WHERE scope = ? AND target_id = ? AND kind = ?', [scope, targetId, kind]);
  const id = existing?.id ?? newId('bind');

  repo.run(
    `INSERT INTO model_bindings (id, scope, target_id, kind, provider_id, model, params, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET provider_id = excluded.provider_id, model = excluded.model, params = excluded.params, updated_at = excluded.updated_at`,
    [id, scope, targetId, kind, providerId, input.model ?? null, JSON.stringify(input.params ?? {}), now, now],
  );
  return bindingRow(repo.get('SELECT * FROM model_bindings WHERE id = ?', [id]));
}

export function deleteBinding(repo, id) {
  const row = repo.get('SELECT id FROM model_bindings WHERE id = ?', [id]);
  if (!row) throw new NotFoundError(`绑定 ${id}`);
  repo.run('DELETE FROM model_bindings WHERE id = ?', [id]);
  return true;
}
