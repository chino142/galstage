/**
 * MCP 接口，两个方向：
 *   1) 客户端方向：配置、连接外面那些 MCP 服务器，把它们变成写卡技能；
 *   2) 服务器方向（蓝图 3.2）：把酒馆自己暴露成 MCP 服务器，给 Codex /
 *      Claude Code 读写。这里只提供"看暴露了哪些能力 + 当场试调一次"，
 *      真正的 stdio 入口是 server/mcp-stdio.mjs。
 */

import { listMcpServers, getMcpServer, createMcpServer, updateMcpServer, deleteMcpServer } from '../db/mcp.mjs';
import { createMcpServer as createTavernMcpServer, MCP_RETURN_MODES } from '../../core/mcp/server.mjs';
import { listXray } from '../db/xray.mjs';
import { MCP_STDIO_DENIED, deniesHostActions } from './_helpers.mjs';

export function register(router, { repo, mcp, runtime }) {
  // MCP 客户端方向会在**主机上启动一个进程**（`spawn(command, args)`）—— 多用户模式下只有管理员能碰。
  const deny = (ctx) => (deniesHostActions(ctx) ? ctx.fail(403, 'FORBIDDEN', MCP_STDIO_DENIED) : null);

  router.get('/api/mcp/servers', (ctx) => {
    const configured = listMcpServers(repo);
    const runtime = new Map(mcp.status().map((item) => [item.id, item]));
    const items = configured.map((server) => ({ ...server, runtime: runtime.get(server.id) ?? null }));
    return ctx.json(200, { items, total: items.length });
  });

  router.post('/api/mcp/servers', async (ctx) => {
    const denied = deny(ctx);
    if (denied) return denied;
    const created = createMcpServer(repo, await ctx.body());
    mcp.define(created);
    return ctx.json(201, created);
  });

  router.put('/api/mcp/servers/:id', async (ctx) => {
    const denied = deny(ctx);
    if (denied) return denied;
    const updated = updateMcpServer(repo, ctx.params.id, await ctx.body());
    mcp.disconnect(ctx.params.id);
    mcp.define(updated);
    return ctx.json(200, updated);
  });

  router.delete('/api/mcp/servers/:id', (ctx) => {
    mcp.disconnect(ctx.params.id);
    deleteMcpServer(repo, ctx.params.id);
    return ctx.noContent();
  });

  router.post('/api/mcp/servers/:id/connect', async (ctx) => {
    const denied = deny(ctx);
    if (denied) return denied;
    const tools = await mcp.connect(ctx.params.id);
    return ctx.json(200, { ok: true, tools: tools.map((tool) => ({ name: tool.name, description: tool.description ?? '' })) });
  });

  router.post('/api/mcp/servers/:id/disconnect', (ctx) => {
    mcp.disconnect(ctx.params.id);
    return ctx.json(200, { ok: true });
  });

  router.post('/api/mcp/servers/:id/call', async (ctx) => {
    const denied = deny(ctx);
    if (denied) return denied;
    const body = (await ctx.body()) ?? {};
    const result = await mcp.call(ctx.params.id, body.tool, body.args ?? {});
    const parts = Array.isArray(result?.content) ? result.content : [];
    return ctx.json(200, {
      isError: Boolean(result?.isError),
      text: parts.map((part) => (part.type === 'text' ? part.text : `[${part.type ?? 'unknown'}]`)).join('\n'),
      raw: result ?? null,
    });
  });

  router.get('/api/mcp/tools', (ctx) => {
    const items = mcp.status().flatMap((server) =>
      server.tools.map((tool) => ({ server: server.id, serverName: server.name, ...tool })),
    );
    return ctx.json(200, { items, total: items.length, servers: mcp.status() });
  });

  // ---- 把酒馆自己当 MCP 服务器 ----

  const tavernServer = runtime
    ? createTavernMcpServer({
        services: runtime.engine.services,
        stores: { ...runtime.stores, xrayList: (query) => listXray(runtime.repo, query) },
        repo: runtime.repo,
        version: runtime.engine.version,
      })
    : null;

  router.get('/api/mcp/server', (ctx) => {
    const tools = tavernServer ? tavernServer.listTools() : [];
    return ctx.json(200, {
      enabled: Boolean(tavernServer),
      transport: 'stdio',
      command: 'node',
      args: ['server/mcp-stdio.mjs', '--data-dir', runtime?.dataDir ?? '<数据目录>'],
      version: runtime?.engine.version ?? null,
      returnModes: MCP_RETURN_MODES,
      items: tools,
      total: tools.length,
      note: '把这条命令填进 Codex / Claude Code 的 MCP 配置即可。破坏性操作要带 confirm: true。',
    });
  });

  /** 界面上的"试一下"：直接调一个工具，看看会返回什么。 */
  router.post('/api/mcp/server/call', async (ctx) => {
    if (!tavernServer) return ctx.fail(501, 'NOT_IMPLEMENTED', '这一版没有把酒馆暴露成 MCP 服务器');
    const body = (await ctx.body()) ?? {};
    if (!body.tool) return ctx.fail(400, 'VALIDATION_ERROR', '要带 tool（工具名）');
    const result = await tavernServer.callTool(body.tool, body.args ?? {});
    const parts = Array.isArray(result?.content) ? result.content : [];
    return ctx.json(200, {
      isError: Boolean(result?.isError),
      text: parts.map((part) => (part.type === 'text' ? part.text : `[${part.type ?? 'unknown'}]`)).join('\n'),
      raw: result ?? null,
    });
  });
}
