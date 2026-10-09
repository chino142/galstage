/**
 * HTTP 服务装配。
 *
 * 请求流程：建 ctx → 日志 → /api/* 交给路由器 → 其余走静态文件 →
 * 出错了统一转 JSON。没有第三方框架，全部用 node:http。
 */

import http from 'node:http';

import { createRouter } from './router.mjs';
import { createStaticHandler } from './static.mjs';
import { createContext, errorMiddleware, requestLogMiddleware } from './middleware.mjs';
import { toErrorPayload } from '../../core/errors.mjs';

export function createApp({ engine, logger, webRoot, schemaVersion = null, dataDir = null, models = null, mcp = null, agents = null, readAsset = null }) {
  const router = createRouter();
  // app 会挂到每个 ctx 上，接口模块从这里取引擎、数据库句柄之类的东西。
  // router 是同一个引用，所以后注册的路由在请求到达时已经在了。
  const app = { engine, logger, router, schemaVersion, dataDir, models, mcp, agents };

  const serveStatic = webRoot || readAsset ? createStaticHandler({ root: webRoot ?? '.', readAsset }) : null;

  async function handleRequest(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const ctx = createContext({ req, res, url, app });

    try {
      await requestLogMiddleware(ctx);

      if (ctx.path.startsWith('/api/')) {
        const matched = router.match(ctx.method, ctx.path);
        if (!matched) return ctx.fail(404, 'NOT_FOUND', `没有这个接口：${ctx.method} ${ctx.path}`);
        if (matched.methodNotAllowed) {
          res.setHeader('Allow', [...matched.allowed, 'OPTIONS'].join(', '));
          return ctx.fail(405, 'METHOD_NOT_ALLOWED', `${ctx.method} 不被支持`);
        }
        ctx.params = matched.params;
        ctx.route = matched.route;
        if (matched.route.meta?.bodyLimit) ctx.bodyLimit = matched.route.meta.bodyLimit;

        const wrapped = errorMiddleware(ctx);
        let handled = false;
        await wrapped(async () => {
          await matched.route.handler(ctx);
          handled = true;
        });
        if (!handled && !res.headersSent) {
          ctx.fail(500, 'HANDLER_NO_RESPONSE', '处理函数没有返回响应');
        }
        return undefined;
      }

      if (serveStatic && (ctx.method === 'GET' || ctx.method === 'HEAD')) {
        const done = await serveStatic(ctx);
        if (done) return undefined;
      }
      return ctx.fail(404, 'NOT_FOUND', `找不到 ${ctx.path}`);
    } catch (err) {
      const { status, body } = toErrorPayload(err);
      logger?.error(`[${ctx.requestId}] 未捕获的错误`, err);
      if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
      return undefined;
    }
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      logger?.error('请求处理彻底失败', err);
      if (!res.headersSent) res.writeHead(500).end();
      else res.end();
    });
  });

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return {
    server,
    router,
    app,
    handleRequest,
    listen({ port = 0, host = '127.0.0.1' } = {}) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address());
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
