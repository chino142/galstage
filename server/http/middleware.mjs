/**
 * 中间件与请求上下文。
 *
 * 没有引入任何框架：handler 拿到一个 ctx，回复用 ctx.json / ctx.text，
 * 出错直接 throw，最外层统一转成 JSON 错误响应。
 */

import { randomUUID } from 'node:crypto';
import { toErrorPayload, ValidationError } from '../../core/errors.mjs';

export const DEFAULT_BODY_LIMIT = 2 * 1024 * 1024;

export async function readBody(req, limit = DEFAULT_BODY_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new ValidationError(`请求体超过上限（${Math.round(limit / 1024)} KB）`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createContext({ req, res, url, params = {}, app }) {
  const ctx = {
    app,
    req,
    res,
    url,
    params,
    method: req.method ?? 'GET',
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    requestId: randomUUID(),
    state: {},
    rawBody: null,
    bodyLimit: DEFAULT_BODY_LIMIT,
    logger: app.logger,

    async readRawBody() {
      if (this.rawBody) return this.rawBody;
      this.rawBody = await readBody(this.req, this.bodyLimit);
      return this.rawBody;
    },

    /** 解析 JSON 请求体；空体返回 null。 */
    async body() {
      const raw = await this.readRawBody();
      if (raw.length === 0) return null;
      const type = String(this.req.headers['content-type'] ?? '');
      if (!type.includes('json')) {
        throw new ValidationError(`不支持的请求体类型：${type || '（空）'}`);
      }
      try {
        return JSON.parse(raw.toString('utf8'));
      } catch {
        throw new ValidationError('请求体不是合法 JSON');
      }
    },

    json(status, payload) {
      const text = JSON.stringify(payload ?? null);
      this.res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
      });
      this.res.end(this.method === 'HEAD' ? undefined : text);
      return true;
    },

    text(status, body, type = 'text/plain; charset=utf-8') {
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
      this.res.writeHead(status, { 'Content-Type': type, 'Content-Length': buffer.length });
      this.res.end(this.method === 'HEAD' ? undefined : buffer);
      return true;
    },

    noContent() {
      this.res.writeHead(204).end();
      return true;
    },

    /** 统一的失败出口，前端拿到的错误形状永远一致。 */
    fail(status, code, message, details = null) {
      return this.json(status, { error: { code, message, details } });
    },
  };
  return ctx;
}

/** 依次跑中间件，任一返回 false 表示"我处理完了，别往下走"。 */
export async function runMiddleware(ctx, middlewares) {
  for (const middleware of middlewares) {
    const result = await middleware(ctx);
    if (result === false) return false;
  }
  return true;
}

/** 全局错误兜底：把异常转成 JSON 响应，写日志。 */
export function errorMiddleware(ctx) {
  return async (next) => {
    try {
      return await next();
    } catch (err) {
      const { status, body } = toErrorPayload(err);
      if (status >= 500) ctx.logger?.error(`[${ctx.requestId}] ${ctx.method} ${ctx.path}`, err);
      else ctx.logger?.debug(`[${ctx.requestId}] ${ctx.method} ${ctx.path} -> ${status} ${body.error.code}`);
      if (!ctx.res.headersSent) ctx.json(status, body);
      else ctx.res.end();
      return false;
    }
  };
}

export function requestLogMiddleware(ctx) {
  const started = Date.now();
  ctx.res.on('finish', () => {
    const ms = Date.now() - started;
    ctx.logger?.debug(`${ctx.method} ${ctx.path} -> ${ctx.res.statusCode} (${ms}ms)`);
  });
  return true;
}
