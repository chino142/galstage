/**
 * MCP 的 stdio 传输层：一行一个 JSON-RPC 消息，stdin 读请求、stdout 写响应。
 *
 * 和 core/mcp/client.mjs 对称（那边是客户端）。规矩只有一条：
 * **stdout 上只能出现 JSON-RPC**，任何日志都得走 stderr，否则客户端解析会炸。
 *
 * 支持的方法：initialize / notifications/initialized / ping / tools/list / tools/call。
 * 未知方法返回 JSON-RPC 的 -32601（方便客户端知道是协议不支持，不是工具报错）。
 */

import { MCP_PROTOCOL_VERSION } from '../../core/mcp/server.mjs';

export const STDIO_MCP_VERSION = MCP_PROTOCOL_VERSION;

export function createStdioTransport({ server, input, output, logger = null }) {
  let buffer = '';
  let closed = false;

  function send(message) {
    if (closed) return;
    output.write(`${JSON.stringify(message)}\n`);
  }

  async function handle(message) {
    const { id, method, params } = message ?? {};
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? STDIO_MCP_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'silver-tavern', version: server.version ?? '0.0.0' },
          instructions:
            '这是 Silver Tavern（本地 AI 角色扮演平台）。用 tools/list 看能力：列角色卡、查对话、发消息触发回复、改世界书、切预设、看提示词快照。返回模式 summary / search / index 用来省 token，默认 summary。要改动数据的工具需要 confirm: true。',
        },
      };
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: server.listTools() } };
    if (method === 'tools/call') {
      const result = await server.callTool(params?.name, params?.arguments ?? {});
      return { jsonrpc: '2.0', id, result };
    }
    if (typeof method === 'string' && method.startsWith('notifications/')) return null;
    return { jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: `method not found: ${method}` } };
  }

  async function onLine(line) {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    try {
      const response = await handle(message);
      if (response) send(response);
    } catch (err) {
      logger?.error?.(`[mcp] 处理 ${message?.method} 失败：${err?.message ?? err}`);
      send({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32603, message: String(err?.message ?? err) } });
    }
  }

  function close() {
    closed = true;
  }

  return {
    /** 开始读 stdin；返回的 Promise 在 stdin 结束时 resolve。 */
    start() {
      input.setEncoding?.('utf8');
      return new Promise((resolve) => {
        input.on('data', (chunk) => {
          buffer += chunk;
          let index;
          while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            void onLine(line);
          }
        });
        input.on('end', () => {
          close();
          resolve();
        });
        input.on('error', () => {
          close();
          resolve();
        });
      });
    },
    close,
    handle,
  };
}
