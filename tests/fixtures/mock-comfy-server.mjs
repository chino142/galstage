/**
 * 假的 ComfyUI，用来测端到端链路（不联网，也不需要真的装 ComfyUI）。
 *
 * 照着真 ComfyUI 的协议做（见 core/toolbox/comfy.mjs 文件头的出处说明）：
 *   POST /prompt              → {prompt_id, number, node_errors}
 *   GET  /queue               → {queue_running, queue_pending}
 *   GET  /history/{prompt_id} → 跑完之前是 {}，跑完才有 outputs / status
 *   GET  /view?filename=…     → 一张 1x1 的 PNG
 *   GET  /system_stats        → 探活用
 *   GET  /ws?clientId=…       → WebSocket；先把 status/executing/progress 推过去，
 *                               再在一个"模拟耗时"之后推 execution_success
 *
 * WebSocket 服务端是手写的（Node 只有 WebSocket 客户端，没有服务端）：
 * 握手用 node:crypto 算 Sec-WebSocket-Accept，数据帧按 RFC6455 编。
 * 只实现测试用得到的：发文本帧、读客户端的关闭/心跳帧。
 */

import http from 'node:http';
import { createHash } from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

function acceptKey(key) {
  return createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
}

function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** 解析客户端发来的帧；只关心 opcode（8=close、9=ping）。 */
function readFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const opcode = first & 0x0f;
    const masked = (buffer[offset + 1] & 0x80) !== 0;
    let length = buffer[offset + 1] & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (buffer.length - cursor < 2) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }
    let mask = null;
    if (masked) {
      if (buffer.length - cursor < 4) break;
      mask = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (buffer.length - cursor < length) break;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    offset = cursor + length;
    frames.push({ opcode, payload });
  }
  return { frames, rest: buffer.subarray(offset) };
}

export function createMockComfy({ latencyMs = 1000 } = {}) {
  const state = {
    mode: 'ok',
    latencyMs,
    submitted: [],
    uploads: [],
    seq: 0,
    readyAt: new Map(),
    sockets: new Set(),
    requests: [],
  };

  function historyEntry(promptId) {
    const ready = Date.now() >= (state.readyAt.get(promptId) ?? 0);
    if (!ready) return null;
    if (state.mode === 'error') {
      return {
        prompt: [],
        outputs: {},
        status: { status_str: 'error', messages: [['execution_error', { prompt_id: promptId, exception_message: 'mock: 显存不够了' }]] },
      };
    }
    return {
      prompt: [],
      outputs: { 9: { images: [{ filename: `mock_${promptId.slice(0, 6)}.png`, subfolder: '', type: 'output' }] } },
      status: { status_str: 'success', messages: [] },
    };
  }

  function sendJson(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  }

  async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    state.requests.push({ method: req.method, path: url.pathname });

    if (url.pathname === '/system_stats') {
      return sendJson(res, 200, {
        system: { os: 'mock-os', comfyui_version: '0.3.99-mock', python_version: '3.12.0' },
        devices: [{ name: 'mock-gpu', type: 'cuda', vram_total: 1024, vram_free: 512 }],
      });
    }
    if (url.pathname === '/object_info') return sendJson(res, 200, { KSampler: { input: { required: { seed: ['INT'] } } } });
    if (url.pathname === '/queue') {
      const pending = state.submitted.filter((item) => !item.picked).map((item, index) => [index, item.promptId, {}, {}, ['9']]);
      return sendJson(res, 200, { queue_running: [], queue_pending: state.mode === 'stuck' ? pending : [] });
    }
    if (url.pathname === '/upload/image' && req.method === 'POST') {
      // 真 ComfyUI 收 multipart 的 image 字段；测试里不用解析内容，记一下请求即可。
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const name = `mock_ref_${state.uploads.length + 1}.png`;
      state.uploads.push({ name, contentType: req.headers['content-type'] ?? '', bytes: Buffer.concat(chunks).length });
      return sendJson(res, 200, { name, subfolder: '', type: 'input' });
    }
    if (url.pathname === '/prompt' && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      state.seq += 1;
      const promptId = `mock-prompt-${state.seq}`;
      const record = { promptId, body, number: state.seq };
      state.submitted.push(record);
      state.readyAt.set(promptId, Date.now() + state.latencyMs);
      return sendJson(res, 200, { prompt_id: promptId, number: state.seq, node_errors: {} });
    }
    if (url.pathname.startsWith('/history/')) {
      const promptId = decodeURIComponent(url.pathname.slice('/history/'.length));
      const entry = historyEntry(promptId);
      return sendJson(res, 200, entry ? { [promptId]: entry } : {});
    }
    if (url.pathname === '/view') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG_1X1.length });
      return res.end(PNG_1X1);
    }
    if (url.pathname === '/interrupt') {
      for (const item of state.submitted) item.picked = true;
      return sendJson(res, 200, {});
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  function onUpgrade(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    if (!key) return socket.destroy();
    socket.write(
      ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptKey(key)}`, '', ''].join('\r\n'),
    );
    state.sockets.add(socket);
    void head;

    const latest = state.submitted[state.submitted.length - 1];
    const promptId = latest?.promptId ?? 'mock-prompt-0';
    const send = (type, data) => {
      if (socket.destroyed) return;
      socket.write(encodeTextFrame(JSON.stringify({ type, data })));
    };
    send('status', { status: { exec_info: { queue_remaining: 1 } }, sid: 'mock' });
    send('execution_start', { prompt_id: promptId, timestamp: Date.now() });
    send('executing', { node: '3', display_node: '3', prompt_id: promptId });
    send('progress', { value: 3, max: 10, node: '3', prompt_id: promptId });
    send('progress_state', { prompt_id: promptId, nodes: { 3: { value: 3, max: 10, state: 'running', node_id: '3' } } });
    setTimeout(() => {
      if (state.mode === 'error') {
        send('execution_error', { prompt_id: promptId, node_id: '3', exception_type: 'RuntimeError', exception_message: 'mock: 显存不够了' });
      } else if (state.mode !== 'stuck') {
        send('executed', { node: '9', display_node: '9', prompt_id: promptId, output: { images: [{ filename: 'mock.png', subfolder: '', type: 'output' }] } });
        send('execution_success', { prompt_id: promptId, timestamp: Date.now() });
      }
    }, state.latencyMs).unref?.();

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const parsed = readFrames(buffer);
      buffer = Buffer.from(parsed.rest);
      for (const frame of parsed.frames) {
        if (frame.opcode === 8) socket.end();
        else if (frame.opcode === 9) socket.write(Buffer.concat([Buffer.from([0x8a, frame.payload.length]), frame.payload]));
      }
    });
    socket.on('close', () => state.sockets.delete(socket));
    socket.on('error', () => state.sockets.delete(socket));
  }

  const server = http.createServer((req, res) => {
    void handler(req, res);
  });
  server.on('upgrade', onUpgrade);

  return {
    server,
    state,
    get url() {
      return `http://127.0.0.1:${server.address().port}`;
    },
    listen() {
      return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
    },
    close() {
      for (const socket of state.sockets) socket.destroy();
      state.sockets.clear();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
