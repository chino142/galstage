/**
 * 多用户主机（蓝图「多用户 / 权限」的 A 方案）。
 *
 * 一个进程、一个网址：
 *   浏览器 → 主机（登录 / 会话 / 管理接口）→ 按会话挑出租户 → 交给那个租户自己的
 *   `createApp().handleRequest` 处理（租户各有各的 engine / 存储 / 路由）。
 *
 * 谁做什么：
 *   /api/auth/*   主机管（登录、登出、首次建号、改自己的口令）
 *   /api/host/*   主机管（仅管理员：账号管理、服务总览）
 *   其它 /api/*   要登录 → 转发给租户的 app（租户之间的数据完全分开）
 *   静态文件      主机管（就是同一份前端；没登录也能拿到壳，登录页要它）
 *
 * 安全取舍（写在明面上）：
 *   - 会话放内存 + HttpOnly Cookie（SameSite=Lax）；重启即全员重新登录。
 *   - 登录失败按 IP 限速；公网部署请配 HTTPS，并把 TAVERN_COOKIE_SECURE=1（或带
 *     x-forwarded-proto: https 的反代）打开 Secure。
 *   - 改数据的接口都要求 JSON body（配合 SameSite=Lax 挡掉跨站表单提交）。
 *   - 管理员能动账号与磁盘，**看不到**任何人的对话内容（那些在各自租户目录里，
 *     主机进程只是把它们交给对应的租户运行时去读）。
 */

import http from 'node:http';
import path from 'node:path';
import { existsSync, rmSync } from 'node:fs';

import { SESSION_COOKIE, newSessionToken, parseCookies, serializeCookie, publicAccount } from '../core/accounts.mjs';
import { createLogger } from './log.mjs';
import { createAccountStore } from './accounts.mjs';
import { createTenantManager } from './tenants.mjs';
import { createContext, errorMiddleware, requestLogMiddleware } from './http/middleware.mjs';
import { createStaticHandler } from './http/static.mjs';
import { toErrorPayload } from '../core/errors.mjs';

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket?.remoteAddress ?? null;
}

function wantsSecureCookie(req, force) {
  if (force) return true;
  return String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
}

/**
 * 路径参数解码。宿主这里是自己匹配 pathname（没走租户的路由器），所以得自己解一次；
 * 但 `%` 这种畸形转义会让 decodeURIComponent 抛 URIError，别让它变成 500 —— 解不开就
 * 原样返回，后面的账号查找自然 404。
 */
function decodeParam(value) {
  try {
    return decodeURIComponent(String(value ?? ''));
  } catch {
    return String(value ?? '');
  }
}

export function createHost({
  hostRoot,
  webRoot,
  logger = createLogger(process.env.TAVERN_LOG ?? 'info'),
  version = '0.0.0',
  trustProxy = process.env.TAVERN_TRUST_PROXY === '1',
  cookieSecure = process.env.TAVERN_COOKIE_SECURE === '1',
  pluginLoader = null,
  readAsset = null,
} = {}) {
  if (!hostRoot) throw new Error('createHost 需要 hostRoot（主机数据目录）');

  const accounts = createAccountStore({ hostRoot, logger });
  let plugins = null;
  const tenants = createTenantManager({
    hostRoot,
    logger,
    webRoot,
    // 角色决定租户要不要建本地代理托管（见 tenants.mjs）
    accounts,
    get plugins() {
      return plugins;
    },
  });
  const serveStatic = createStaticHandler({ root: webRoot ?? '.', readAsset });
  const startedAt = Date.now();

  const app = {
    engine: null,
    logger,
    router: null,
    hostRoot,
    accounts,
    tenants,
    multiUser: true,
    version,
    get plugins() {
      return plugins;
    },
  };

  /** 插件是主机级的：加载一次，所有租户共享（租户的运行时载入时会把接口挂到各自路由上）。 */
  async function initPlugins() {
    if (!pluginLoader) return null;
    try {
      plugins = await pluginLoader({ dataDir: hostRoot, logger, engine: null, agents: null });
    } catch (err) {
      logger.warn?.(`[host] 插件加载失败（不影响启动）：${err?.message ?? err}`);
      plugins = { loaded: [], errors: [{ name: '(host)', error: String(err?.message ?? err) }], routes: [], skills: [], tools: [], modules: [], views: [], styles: [] };
    }
    return plugins;
  }

  // ---------------------------------------------------------------- 主机路由

  function authStatus(ctx) {
    const session = ctx.state.session ?? null;
    const account = session ? accounts.find(session.name) : null;
    return {
      multiUser: true,
      setupRequired: accounts.count() === 0,
      authenticated: Boolean(account && !account.disabled),
      user: account ? publicAccount(account) : null,
      // 没登录就不暴露服务器路径
      hostRoot: account ? hostRoot : null,
      version,
    };
  }

  function requireUser(ctx) {
    const session = ctx.state.session ?? null;
    if (!session) {
      ctx.fail(401, 'UNAUTHORIZED', '先登录');
      return null;
    }
    return session;
  }

  function requireAdmin(ctx) {
    const session = requireUser(ctx);
    if (!session) return null;
    if (session.role !== 'admin') {
      ctx.fail(403, 'FORBIDDEN', '只有管理员能做这个');
      return null;
    }
    return session;
  }

  async function hostRoute(ctx) {
    const { path: pathname, method } = ctx;

    // ---- 登录相关（公开）----
    if (pathname === '/api/auth/status' && method === 'GET') return ctx.json(200, authStatus(ctx));

    // 主机级健康检查：给反代 / 监控用，不暴露账号与路径
    if (pathname === '/api/health' && method === 'GET') {
      return ctx.json(200, {
        ok: true,
        multiUser: true,
        version,
        setupRequired: accounts.count() === 0,
        uptime: Math.round((Date.now() - startedAt) / 1000),
      });
    }

    if (pathname === '/api/auth/setup' && method === 'POST') {
      if (accounts.count() > 0) return ctx.fail(409, 'CONFLICT', '已经有账号了，直接登录；要加人让管理员在总览里加');
      const body = (await ctx.body()) ?? {};
      const account = accounts.create({ name: body.name, password: body.password, role: 'admin', note: '第一个账号（管理员）' });
      const token = newSessionToken();
      accounts.startSession(account.name, { token, ip: clientIp(ctx.req, trustProxy) });
      ctx.state.session = { name: account.name, role: account.role, token };
      ctx.res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, token, { maxAge: 30 * 24 * 3600, secure: wantsSecureCookie(ctx.req, cookieSecure) }));
      return ctx.json(201, { user: account, ...authStatus(ctx) });
    }

    if (pathname === '/api/auth/login' && method === 'POST') {
      const ip = clientIp(ctx.req, trustProxy);
      if (accounts.isThrottled(ip)) {
        return ctx.fail(429, 'TOO_MANY_ATTEMPTS', '失败次数太多了，等十分钟再试');
      }
      const body = (await ctx.body()) ?? {};
      const account = accounts.authenticate(body.name, body.password);
      if (!account) {
        accounts.recordFailure(ip);
        return ctx.fail(401, 'BAD_CREDENTIALS', '账号或口令不对');
      }
      if (account.disabled) return ctx.fail(403, 'ACCOUNT_DISABLED', '这个账号被停用了');
      accounts.clearFailures(ip);
      const token = newSessionToken();
      accounts.startSession(account.name, { token, ip });
      ctx.state.session = { name: account.name, role: account.role, token };
      ctx.res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, token, { maxAge: 30 * 24 * 3600, secure: wantsSecureCookie(ctx.req, cookieSecure) }));
      return ctx.json(200, { user: account, ...authStatus(ctx) });
    }

    if (pathname === '/api/auth/logout' && method === 'POST') {
      const token = parseCookies(ctx.req.headers.cookie)[SESSION_COOKIE];
      if (token) accounts.destroySession(token);
      ctx.res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAge: 0, secure: wantsSecureCookie(ctx.req, cookieSecure) }));
      return ctx.json(200, { ok: true });
    }

    if (pathname === '/api/auth/password' && method === 'POST') {
      const session = requireUser(ctx);
      if (!session) return true;
      const body = (await ctx.body()) ?? {};
      const account = accounts.find(session.name);
      if (!account) return ctx.fail(404, 'NOT_FOUND', '账号不存在了');
      if (!accounts.authenticate(session.name, body.currentPassword)) {
        return ctx.fail(400, 'BAD_CREDENTIALS', '当前口令不对');
      }
      accounts.setPassword(session.name, body.newPassword);
      accounts.startSession(session.name, { token: session.token, ip: session.ip ?? null });
      return ctx.json(200, { ok: true });
    }

    // ---- 管理员：账号与服务总览 ----
    if (pathname === '/api/host/info' && method === 'GET') {
      const session = requireAdmin(ctx);
      if (!session) return true;
      return ctx.json(200, {
        multiUser: true,
        hostRoot,
        version,
        startedAt: new Date(startedAt).toISOString(),
        currentUser: session.name,
        accounts: accounts.list(),
        tenants: tenants.stats({ withDisk: ctx.query.disk === '1' }),
        loaded: tenants.listLoaded(),
        sessions: accounts.sessionStats(),
        plugins: (plugins?.loaded ?? []).map((item) => ({ name: item.name, version: item.version, hooks: item.hooks })),
      });
    }

    if (pathname === '/api/host/users' && method === 'POST') {
      const session = requireAdmin(ctx);
      if (!session) return true;
      const body = (await ctx.body()) ?? {};
      const account = accounts.create({ name: body.name, password: body.password, role: body.role, note: body.note });
      return ctx.json(201, account);
    }

    const userMatch = pathname.match(/^\/api\/host\/users\/([^/]+)$/);
    if (userMatch && (method === 'POST' || method === 'PATCH')) {
      const session = requireAdmin(ctx);
      if (!session) return true;
      const target = decodeParam(userMatch[1]);
      const body = (await ctx.body()) ?? {};
      const beingDemoted = body.role === 'user' || body.disabled === true;
      if (target === session.name && beingDemoted) {
        return ctx.fail(400, 'VALIDATION_ERROR', '别把自己停用或降级：先给另一个账号管理员权限再来改自己');
      }
      if (beingDemoted && accounts.adminCount() <= 1) {
        const found = accounts.find(target);
        if (found?.role === 'admin') return ctx.fail(400, 'VALIDATION_ERROR', '至少留一个管理员，先给别的账号加管理员权限');
      }
      let account = accounts.require(target);
      if (body.password) account = accounts.setPassword(target, body.password);
      if (body.role) account = accounts.setRole(target, body.role);
      if (body.disabled !== undefined) account = accounts.setDisabled(target, body.disabled);
      if (body.note !== undefined) account = accounts.setNote(target, body.note);
      // 改口令 / 停用 / 改角色都要把租户卸掉重建：角色决定它有没有本地代理托管
      if (body.disabled === true || body.password || body.role) tenants.unload(target);
      return ctx.json(200, account);
    }

    if (userMatch && method === 'DELETE') {
      const session = requireAdmin(ctx);
      if (!session) return true;
      const target = decodeParam(userMatch[1]);
      const body = (await ctx.body()) ?? {};
      if (target === session.name) return ctx.fail(400, 'VALIDATION_ERROR', '别删自己');
      if (body.confirm !== true) {
        return ctx.json(200, {
          needConfirm: true,
          message: `要删账号 ${target}${body.purge ? '，并且连它的数据一起删（不可恢复）' : '（数据目录会留着）'}。确认请再发一次带 confirm: true`,
        });
      }
      tenants.unload(target);
      accounts.remove(target);
      let purged = false;
      if (body.purge === true) {
        const dir = tenants.dataDirFor(target);
        const allowed = path.resolve(dir).startsWith(path.resolve(hostRoot) + path.sep);
        if (allowed && existsSync(dir)) {
          rmSync(dir, { recursive: true, force: true });
          purged = true;
        }
      }
      return ctx.json(200, { ok: true, removed: target, purged });
    }

    const unloadMatch = pathname.match(/^\/api\/host\/tenants\/([^/]+)\/unload$/);
    if (unloadMatch && method === 'POST') {
      const session = requireAdmin(ctx);
      if (!session) return true;
      const target = decodeParam(unloadMatch[1]);
      return ctx.json(200, { ok: true, unloaded: tenants.unload(target) });
    }

    return null;
  }

  // ---------------------------------------------------------------- 请求处理

  async function handleRequest(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const ctx = createContext({ req, res, url, app });

    // 会话先解析：登录/管理/转发都要用
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    ctx.state.session = accounts.resolveSession(token);

    try {
      await requestLogMiddleware(ctx);

      if (ctx.path.startsWith('/api/')) {
        const wrapped = errorMiddleware(ctx);
        let handled = false;
        await wrapped(async () => {
          const result = await hostRoute(ctx);
          if (result !== null) {
            handled = true;
            return;
          }
          // 落到租户：必须登录，然后把这个请求交给它自己的 app
          const session = ctx.state.session;
          if (!session) {
            ctx.fail(401, 'UNAUTHORIZED', '先登录');
            handled = true;
            return;
          }
          let tenant;
          try {
            tenant = tenants.get(session.name);
          } catch (err) {
            logger.error?.(`[host] 载入租户 ${session.name} 失败`, err);
            ctx.fail(500, 'TENANT_LOAD_FAILED', `这个账号的数据目录读不出来：${err?.message ?? err}`);
            handled = true;
            return;
          }
          tenant.app.app.auth = { user: { name: session.name, role: session.role }, multiUser: true };
          handled = true;
          await tenant.app.handleRequest(req, res);
        });
        if (!handled && !res.headersSent) ctx.fail(500, 'HANDLER_NO_RESPONSE', '处理函数没有返回响应');
        return undefined;
      }

      if ((ctx.method === 'GET' || ctx.method === 'HEAD') && (await serveStatic(ctx))) return undefined;
      return ctx.fail(404, 'NOT_FOUND', `找不到 ${ctx.path}`);
    } catch (err) {
      const { status, body } = toErrorPayload(err);
      logger?.debug?.(`[host] ${ctx.requestId} ${ctx.method} ${ctx.path} -> ${status} ${body?.error?.code}`);
      if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
      return undefined;
    }
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      logger?.error('[host] 请求处理彻底失败', err);
      if (!res.headersSent) res.writeHead(500).end();
      else res.end();
    });
  });
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return {
    server,
    app,
    accounts,
    tenants,
    handleRequest,
    initPlugins,
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
      tenants.stopAll();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
