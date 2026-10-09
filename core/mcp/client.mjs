/**
 * 极小的 MCP 客户端（stdio 传输，零依赖）。
 *
 * 协议本身很简单：一行一个 JSON-RPC 消息，stdin 写请求、stdout 读响应。
 * 这里只实现写卡用得上的四个方法：initialize / tools/list / tools/call / ping，
 * 外加超时处理与退出清理。
 */

import { spawn } from 'node:child_process';
import { NotFoundError } from '../errors.mjs';

export const MCP_PROTOCOL_VERSION = '2024-11-05';

export function createMcpClient({ name, command, args = [], env = {}, cwd = null, timeoutMs = 20000, logger = console }) {
  let child = null;
  let buffer = '';
  let nextId = 1;
  let initialized = false;
  const pending = new Map();

  function failAll(reason) {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      pending.delete(id);
    }
  }

  function handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return; // 有些服务器会往 stdout 打日志，非 JSON 行直接忽略
    }
    if (message.id === undefined || !pending.has(message.id)) return;
    const entry = pending.get(message.id);
    clearTimeout(entry.timer);
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message ?? 'MCP 调用失败'));
    else entry.resolve(message.result);
  }

  function onStdout(chunk) {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) handleLine(line);
    }
  }

  function connect() {
    if (child) return;
    child = spawn(command, args, {
      cwd: cwd ?? undefined,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onStdout);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => logger?.debug?.(`[mcp:${name}] ${String(chunk).trim()}`));
    child.on('error', (err) => {
      failAll(`MCP 服务 ${name} 启动失败：${err.message}`);
      child = null;
      initialized = false;
    });
    child.on('exit', (code) => {
      failAll(`MCP 服务 ${name} 已退出（code ${code}）`);
      child = null;
      initialized = false;
    });
  }

  function send(message) {
    connect();
    if (!child?.stdin?.writable) throw new Error(`MCP 服务 ${name} 无法写入`);
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP 调用超时：${method}（${timeoutMs}ms）`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      try {
        send({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });
  }

  function notify(method, params = {}) {
    send({ jsonrpc: '2.0', method, params });
  }

  async function initialize() {
    if (initialized) return { already: true };
    const result = await request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'silver-tavern', version: '0.3.0' },
    });
    notify('notifications/initialized', {});
    initialized = true;
    return result;
  }

  async function listTools() {
    await initialize();
    const result = await request('tools/list', {});
    return result?.tools ?? [];
  }

  async function callTool(toolName, toolArgs = {}) {
    await initialize();
    if (!toolName) throw new NotFoundError('MCP 工具名');
    return request('tools/call', { name: toolName, arguments: toolArgs });
  }

  function close() {
    failAll('客户端已关闭');
    try {
      child?.kill();
    } catch {
      // ignore
    }
    child = null;
    initialized = false;
  }

  return {
    initialize,
    listTools,
    callTool,
    close,
    get running() {
      return Boolean(child);
    },
    get initialized() {
      return initialized;
    },
  };
}
