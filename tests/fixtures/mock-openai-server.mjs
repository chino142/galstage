/**
 * 假的本地代理：模拟 CLI 渠道那类"本机起一个 OpenAI 兼容服务"的形态。
 * 用法：node mock-openai-server.mjs <端口>
 */

import http from 'node:http';

const port = Number(process.argv[2] ?? 0);

const server = http.createServer(async (req, res) => {
  const url = req.url ?? '';
  if (url.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'mock' }] }));
    return;
  }
  if (url.includes('/chat/completions')) {
    for await (const _chunk of req) {
      // 读干净请求体，避免连接被挂住
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const piece of ['p', 'o', 'n', 'g']) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  res.writeHead(404).end();
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`mock-openai-server listening on ${server.address().port}\n`);
});
