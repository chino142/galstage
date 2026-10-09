/**
 * 假的 MCP 服务器，用来测 stdio 客户端。
 * 协议：一行一个 JSON-RPC 消息；只实现 initialize / tools/list / tools/call。
 */

import process from 'node:process';

let buffer = '';

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(message) {
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1.0.0' } },
    });
    return;
  }
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          {
            name: 'echo',
            title: '回声',
            description: '把输入原样返回，用来验证链路',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          },
        ],
      },
    });
    return;
  }
  if (message.method === 'tools/call') {
    const text = message.params?.arguments?.text ?? '';
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `echo:${text}` }], isError: false } });
    return;
  }
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } });
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // 忽略坏帧
    }
  }
});
