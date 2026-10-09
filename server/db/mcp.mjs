/** MCP 服务器配置的读写。进程本身是懒启动的：点"连接"或 Agent 用到时才拉起。 */

import { newId, nowIso } from '../../core/ids.mjs';
import { ValidationError, NotFoundError } from '../../core/errors.mjs';

function rowToServer(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    command: row.command,
    args: row.args ? JSON.parse(row.args) : [],
    env: row.env ? JSON.parse(row.env) : {},
    cwd: row.cwd ?? null,
    enabled: Boolean(row.enabled),
    autoConnect: Boolean(row.auto_connect),
    note: row.note ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listMcpServers(repo) {
  return repo.all('SELECT * FROM mcp_servers ORDER BY created_at').map(rowToServer);
}

export function getMcpServer(repo, id) {
  return rowToServer(repo.get('SELECT * FROM mcp_servers WHERE id = ?', [id]));
}

function validate(input, existing = null) {
  const name = String(input.name ?? existing?.name ?? '').trim();
  if (!name) throw new ValidationError('服务器需要一个名字');
  const command = String(input.command ?? existing?.command ?? '').trim();
  if (!command) throw new ValidationError('需要填写启动命令，例如 npx 或 python');
  const args = input.args ?? existing?.args ?? [];
  if (!Array.isArray(args)) throw new ValidationError('args 必须是数组');
  const env = input.env ?? existing?.env ?? {};
  if (env && typeof env !== 'object') throw new ValidationError('env 必须是对象');
  return { name, command, args, env: env ?? {}, cwd: input.cwd ?? existing?.cwd ?? null };
}

export function createMcpServer(repo, input) {
  const clean = validate(input);
  const id = newId('mcp');
  const now = nowIso();
  repo.run(
    `INSERT INTO mcp_servers (id, name, command, args, env, cwd, enabled, auto_connect, note, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      clean.name,
      clean.command,
      JSON.stringify(clean.args),
      JSON.stringify(clean.env),
      clean.cwd,
      input.enabled === false ? 0 : 1,
      input.autoConnect ? 1 : 0,
      input.note ?? null,
      now,
      now,
    ],
  );
  return getMcpServer(repo, id);
}

export function updateMcpServer(repo, id, input) {
  const existing = getMcpServer(repo, id);
  if (!existing) throw new NotFoundError(`MCP 服务器 ${id}`);
  const clean = validate(input, existing);
  repo.run(
    `UPDATE mcp_servers SET name = ?, command = ?, args = ?, env = ?, cwd = ?, enabled = ?, auto_connect = ?, note = ?, updated_at = ?
     WHERE id = ?`,
    [
      clean.name,
      clean.command,
      JSON.stringify(clean.args),
      JSON.stringify(clean.env),
      clean.cwd,
      (input.enabled ?? existing.enabled) ? 1 : 0,
      (input.autoConnect ?? existing.autoConnect) ? 1 : 0,
      input.note ?? existing.note,
      nowIso(),
      id,
    ],
  );
  return getMcpServer(repo, id);
}

export function deleteMcpServer(repo, id) {
  if (!getMcpServer(repo, id)) throw new NotFoundError(`MCP 服务器 ${id}`);
  repo.run('DELETE FROM mcp_servers WHERE id = ?', [id]);
  return true;
}
