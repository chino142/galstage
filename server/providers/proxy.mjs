/**
 * 走 HTTP 代理出网。
 *
 * 为什么自己写：Node 24 不带可导入的 undici，`fetch` 也没有代理参数，
 * 所以这里用 node:http / node:net / node:tls 拼一个 **fetch 兼容**的版本：
 *   - http:// 目标 → 直接把完整 URL 当 path 发给代理（代理的标准做法）
 *   - https:// 目标 → 先 CONNECT 打隧道，再在隧道上跑 TLS 与 HTTP
 * 返回的 Response 带流式 body，所以 SSE 照样能用。
 *
 * 只做「HTTP 代理」这一种，不做 SOCKS。
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { Readable } from 'node:stream';

/**
 * 解析代理地址。支持 http://user:pass@host:port 与 host:port 简写。
 */
export function parseProxy(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`代理地址不合法：${raw}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`代理只支持 http / https，收到 ${url.protocol}`);
  }
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  const auth = url.username ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password ?? '')}` : null;
  return { protocol: url.protocol, host: url.hostname, port, auth, secure: url.protocol === 'https:' };
}

function authHeader(proxy) {
  return proxy.auth ? { 'Proxy-Authorization': `Basic ${Buffer.from(proxy.auth).toString('base64')}` } : {};
}

/** 出网失败时把原始错误包一层，至少让人知道"是代理的问题"。 */
function wrapProxyError(err, proxy) {
  const message = err?.message ?? String(err);
  const wrapped = new Error(`走代理 ${proxy.host}:${proxy.port} 出网失败：${message}`);
  wrapped.cause = err;
  return wrapped;
}

function normaliseBody(body) {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === 'object' && typeof body.pipe === 'function') return body;
  return Buffer.from(String(body), 'utf8');
}

function toWebResponse(message) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(message.headers ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(key, String(item));
    else headers.set(key, String(value));
  }
  const empty = message.statusCode === 204 || message.statusCode === 304;
  const body = empty ? null : Readable.toWeb(message);
  return new Response(body, { status: message.statusCode ?? 502, statusText: message.statusMessage ?? '', headers });
}

/** 打一条 CONNECT 隧道，返回已经连通的裸 socket（TLS 由调用方套）。 */
function openTunnel({ proxy, target, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
    const host = target.hostname;
    const socket = proxy.secure
      ? tls.connect({ host: proxy.host, port: proxy.port, servername: proxy.host })
      : net.connect({ host: proxy.host, port: proxy.port });

    const fail = (err) => {
      socket.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    socket.setTimeout(timeoutMs, () => fail(new Error(`连代理超时（${proxy.host}:${proxy.port}）`)));
    socket.once('error', fail);

    const start = () => {
      const lines = [
        `CONNECT ${host}:${port} HTTP/1.1`,
        `Host: ${host}:${port}`,
        ...Object.entries(authHeader(proxy)).map(([key, value]) => `${key}: ${value}`),
        '',
        '',
      ];
      socket.write(lines.join('\r\n'));
    };
    if (proxy.secure) socket.once('secureConnect', start);
    else socket.once('connect', start);

    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buffer.length > 16 * 1024) fail(new Error('代理应答异常（头部过长）'));
        return;
      }
      socket.off('data', onData);
      socket.off('error', fail);
      socket.setTimeout(0);
      const head = buffer.subarray(0, end).toString('latin1');
      const statusLine = head.split('\r\n')[0] ?? '';
      const code = Number(statusLine.split(/\s+/)[1]);
      if (code !== 200) {
        fail(new Error(`代理拒绝了 CONNECT：${statusLine || '(空应答)'}`));
        return;
      }
      const leftover = buffer.subarray(end + 4);
      if (leftover.length) socket.unshift(leftover);
      resolve(socket);
    };
    socket.on('data', onData);
  });
}

/** 在已建立的隧道上跑一次 HTTP 请求（https 目标这里跑的是隧道内的明文 HTTP）。 */
function requestOverSocket({ socket, target, method, headers, body, signal, proxy }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        path: `${target.pathname}${target.search}`,
        createConnection: () => socket,
        agent: false,
        headers: { host: target.host, ...headers },
      },
      (res) => resolve(toWebResponse(res)),
    );
    req.on('error', (err) => reject(wrapProxyError(err, proxy)));
    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error('aborted'));
        return;
      }
      signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    }
    if (body) req.write(body);
    req.end();
  });
}

/**
 * 造一个 fetch 兼容函数。
 * @param {string|object} proxyInput 代理地址或 parseProxy 的结果
 */
export function createProxyFetch(proxyInput) {
  const proxy = typeof proxyInput === 'string' ? parseProxy(proxyInput) : proxyInput;
  if (!proxy) throw new Error('createProxyFetch 需要一个代理地址');

  return async function proxyFetch(url, init = {}) {
    const target = new URL(String(url));
    const method = String(init.method ?? 'GET').toUpperCase();
    const headers = { ...(init.headers ?? {}) };
    const body = normaliseBody(init.body);
    if (body && !headers['Content-Length'] && !headers['content-length'] && Buffer.isBuffer(body)) {
      headers['Content-Length'] = String(body.length);
    }

    if (target.protocol === 'http:') {
      // 明文目标：把完整 URL 当路径交给代理。
      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            method,
            host: proxy.host,
            port: proxy.port,
            path: target.href,
            headers: { host: target.host, ...authHeader(proxy), ...headers },
          },
          (res) => resolve(toWebResponse(res)),
        );
        req.on('error', (err) => reject(wrapProxyError(err, proxy)));
        if (init.signal) {
          if (init.signal.aborted) return req.destroy(new Error('aborted'));
          init.signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
        }
        if (body) req.write(body);
        req.end();
      });
    }

    const tunnel = await openTunnel({ proxy, target, timeoutMs: init.timeoutMs ?? 20000 });
    const secureSocket = tls.connect({ socket: tunnel, servername: target.hostname, ALPNProtocols: ['http/1.1'] });
    await new Promise((resolve, reject) => {
      secureSocket.once('secureConnect', resolve);
      secureSocket.once('error', reject);
    });
    return requestOverSocket({ socket: secureSocket, target, method, headers, body, signal: init.signal, proxy });
  };
}

/** 只做连通性检查：能连上代理就算过（不请求外网）。 */
export async function testProxy(proxyInput, { timeoutMs = 5000 } = {}) {
  const proxy = typeof proxyInput === 'string' ? parseProxy(proxyInput) : proxyInput;
  if (!proxy) throw new Error('没有填代理地址');
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    const done = (err) => {
      socket.destroy();
      if (err) reject(err);
      else resolve({ ok: true, host: proxy.host, port: proxy.port });
    };
    socket.setTimeout(timeoutMs, () => done(new Error(`连不上代理 ${proxy.host}:${proxy.port}（超时）`)));
    socket.once('error', (err) => done(new Error(`连不上代理 ${proxy.host}:${proxy.port}：${err.message}`)));
    socket.once('connect', () => done(null));
  });
}
