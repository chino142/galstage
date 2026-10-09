/**
 * MCP 服务器管理：连接、列工具、把外部工具包装成 Agent 能调用的技能。
 *
 * 包装后的技能 id 形如 `mcp.<服务器>.<工具>`，于是 Agent 完全不用区分
 * "内置技能"和"外部工具" —— 写卡时它们出现在同一张工具表里。
 */

import { createMcpClient } from './client.mjs';
import { NotFoundError } from '../errors.mjs';

export function slugifyName(text) {
  const slug = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || 'tool';
}

export function createMcpRegistry({ logger = console, timeoutMs = 20000 } = {}) {
  /** @type {Map<string, {config: object, client: object|null, tools: Array}>} */
  const servers = new Map();

  function define(config) {
    servers.set(config.id, { config, client: null, tools: [] });
    return servers.get(config.id);
  }

  function entry(id) {
    const found = servers.get(id);
    if (!found) throw new NotFoundError(`MCP 服务器 ${id}`);
    return found;
  }

  async function connect(id) {
    const target = entry(id);
    if (target.client?.running) {
      target.tools = await target.client.listTools();
      return target.tools;
    }
    const client = createMcpClient({
      name: target.config.name ?? id,
      command: target.config.command,
      args: target.config.args ?? [],
      env: target.config.env ?? {},
      cwd: target.config.cwd ?? null,
      timeoutMs,
      logger,
    });
    await client.initialize();
    target.client = client;
    target.tools = await client.listTools();
    return target.tools;
  }

  function disconnect(id) {
    const target = entry(id);
    target.client?.close();
    target.client = null;
    target.tools = [];
  }

  function disconnectAll() {
    for (const id of [...servers.keys()]) disconnect(id);
  }

  async function call(id, toolName, args = {}) {
    const target = entry(id);
    if (!target.client?.running) await connect(id);
    return target.client.callTool(toolName, args);
  }

  /** MCP 的返回是 { content:[{type:'text',text}], isError }，这里压成一段文字。 */
  function normaliseResult(result) {
    const parts = Array.isArray(result?.content) ? result.content : [];
    const text = parts.map((part) => (part.type === 'text' ? part.text : `[${part.type ?? 'unknown'}]`)).join('\n');
    return { text, isError: Boolean(result?.isError), raw: result ?? null };
  }

  function status() {
    return [...servers.values()].map((target) => ({
      id: target.config.id,
      name: target.config.name ?? target.config.id,
      command: target.config.command,
      args: target.config.args ?? [],
      enabled: target.config.enabled !== false,
      connected: Boolean(target.client?.running),
      toolCount: target.tools.length,
      tools: target.tools.map((tool) => ({ name: tool.name, title: tool.title ?? null, description: tool.description ?? '' })),
    }));
  }

  /** 把已连接服务器的工具包装成技能，交给 Agent 使用。 */
  function toolsAsSkills() {
    const skills = [];
    for (const target of servers.values()) {
      if (target.config.enabled === false || !target.client?.running) continue;
      const prefix = slugifyName(target.config.name ?? target.config.id);
      for (const tool of target.tools) {
        const serverId = target.config.id;
        skills.push({
          id: `mcp.${prefix}.${slugifyName(tool.name)}`,
          title: tool.title ?? tool.name,
          description: tool.description ?? `来自 MCP 服务器 ${prefix} 的工具`,
          category: 'external',
          source: 'mcp',
          server: serverId,
          toolName: tool.name,
          parameters: tool.inputSchema ?? { type: 'object', properties: {} },
          handler: async ({ input }) => normaliseResult(await call(serverId, tool.name, input ?? {})),
        });
      }
    }
    return skills;
  }

  return {
    define,
    connect,
    disconnect,
    disconnectAll,
    call,
    status,
    toolsAsSkills,
    get size() {
      return servers.size;
    },
  };
}
