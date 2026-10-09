/**
 * Server-Sent Events。
 * 聊天流式输出、图片生成进度这类"服务端主动推"的场景都走它。
 * 协议事件名与 core/chat/service.mjs 里的 STREAM_EVENT_TYPES 对应。
 */

export function openSse(ctx, { heartbeatMs = 25000 } = {}) {
  const { res } = ctx;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  let closed = false;
  const timer = heartbeatMs
    ? setInterval(() => {
        if (!closed) res.write(': ping\n\n');
      }, heartbeatMs)
    : null;
  if (timer?.unref) timer.unref();

  function send(event, data = null) {
    if (closed) return;
    const payload = data === null ? '' : `data: ${JSON.stringify(data)}\n`;
    res.write(`event: ${event}\n${payload}\n`);
  }

  function comment(text) {
    if (!closed) res.write(`: ${text}\n\n`);
  }

  function close() {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    res.end();
  }

  res.on('close', () => {
    closed = true;
    if (timer) clearInterval(timer);
  });

  return { send, comment, close, get closed() { return closed; } };
}
