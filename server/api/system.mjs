/**
 * 系统级接口：健康检查、应用元信息、设置。
 * 设置是骨架阶段唯一"真能用"的功能：它证明了 HTTP → 校验 → 数据库 → 前端 这条链路是通的。
 */

import { SETTINGS_SCHEMA } from '../../core/config.mjs';
import { readSettings, writeSettings, resetSettings } from '../db/settings.mjs';
import { COMFY_LAUNCH_DENIED, COMFY_LAUNCHER_KEYS, SERVER_COMFY_DENIED, deniesHostActions, deniesServerComfy } from './_helpers.mjs';
import { setProxy } from '../providers/http.mjs';
import { checkForUpdate, installUpdate } from '../update.mjs';
import { isSeaRuntime } from '../sea.mjs';

/**
 * 多用户模式下管理员才会看到的一个模块（主机级基础设施）。
 * 不写进 core/modules.mjs：那是对单机产品功能的清单，主机管理是"部署方式"多出来的东西，
 * 跟插件模块一样由运行时追加。
 */
const HOST_MODULE = {
  id: 'host',
  area: 'platform',
  title: '主机管理',
  summary: '账号、服务总览、租户数据占用',
  status: 'ready',
  web: { view: 'host', icon: '🛡️' },
  api: ['/api/host'],
  plan: ['账号管理：加人 / 停用 / 重置口令 / 删除（可连数据一起删）', '服务总览：会话数、租户载入状态与磁盘占用', '插件与版本信息'],
};

export function register(router, { engine, repo, logger, dataDir, runtime }) {
  router.get('/api/health', (ctx) =>
    ctx.json(200, {
      ok: true,
      version: engine.version,
      uptime: Math.round(process.uptime()),
      schemaVersion: ctx.app.schemaVersion ?? null,
      modules: engine.registry.size,
    }),
  );

  /** 前端启动时拉一次：模块地图、区域、提供方、设置 schema 全在这。 */
  router.get('/api/app', (ctx) => {
    const plugins = ctx.app.plugins ?? { loaded: [], errors: [], modules: [], views: [], styles: [] };
    const auth = ctx.app.auth ?? null;
    const hostMode = Boolean(ctx.app.multiUser);
    const extraModules = [...(plugins.modules ?? [])];
    if (hostMode && auth?.user?.role === 'admin') extraModules.push(HOST_MODULE);
    return ctx.json(200, {
      version: engine.version,
      areas: engine.registry.areas(),
      // 插件模块追加在模块地图后面：模块地图自身的校验不受影响
      modules: [...engine.registry.list(), ...extraModules],
      providerKinds: engine.providers.kinds(),
      settingsSchema: SETTINGS_SCHEMA,
      settings: readSettings(repo),
      // 多用户模式下每个请求带上"这是谁"（单机模式是 null）
      auth,
      hostMode,
      plugins: {
        items: plugins.loaded ?? [],
        errors: plugins.errors ?? [],
        views: plugins.views ?? [],
        styles: plugins.styles ?? [],
      },
    });
  });

  router.get('/api/settings', (ctx) => ctx.json(200, { settings: readSettings(repo) }));

  router.get('/api/settings/schema', (ctx) => ctx.json(200, { items: SETTINGS_SCHEMA }));

  router.put('/api/settings', async (ctx) => {
    const patch = await ctx.body();
    // 设置里也能改 comfy.executionMode：成员不许改回 server（同一条 SSRF 闸）
    if ((patch ?? {})['comfy.executionMode'] === 'server' && deniesServerComfy(ctx)) {
      return ctx.fail(403, 'FORBIDDEN', SERVER_COMFY_DENIED);
    }
    // 「让主机执行命令」那几条同样只有管理员能写（ComfyUI 启动托管）
    if (COMFY_LAUNCHER_KEYS.some((key) => (patch ?? {})[key] !== undefined) && deniesHostActions(ctx)) {
      return ctx.fail(403, 'FORBIDDEN', COMFY_LAUNCH_DENIED);
    }
    const next = writeSettings(repo, patch ?? {});
    // 代理改了要立刻生效（不用重启）。
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'net.proxy')) setProxy(next['net.proxy']);
    logger?.debug(`设置已更新：${Object.keys(patch ?? {}).join(', ') || '（空）'}`);
    return ctx.json(200, { settings: next });
  });

  router.post('/api/settings/reset', (ctx) => ctx.json(200, { settings: resetSettings(repo) }));

  /** 路由清单：调试用，能一眼看出哪些接口已经接上、哪些还是 501。 */
  router.get('/api/routes', (ctx) =>
    ctx.json(200, { items: ctx.app.router.list(), total: ctx.app.router.size }),
  );

  // ---- 检查更新 / 自动替换 exe（蓝图 3.2）----
  router.get('/api/system/update', async (ctx) => {
    const url = readSettings(repo)['system.updateUrl'] ?? '';
    const result = await checkForUpdate({ url, current: engine.version });
    return ctx.json(200, {
      ...result,
      packaged: isSeaRuntime(),
      execPath: isSeaRuntime() ? process.execPath : null,
    });
  });

  router.post('/api/system/update/install', async (ctx) => {
    const url = readSettings(repo)['system.updateUrl'] ?? '';
    let result;
    try {
      result = await installUpdate({
        url,
        current: engine.version,
        currentExe: process.execPath,
        packaged: isSeaRuntime(),
        pid: process.pid,
        dataDir,
      });
    } catch (err) {
      return ctx.fail(400, 'UPDATE_INSTALL_FAILED', err?.message ?? String(err));
    }
    if (result.restarting) {
      // 先把响应发出去（前端要显示"即将重启"），再延迟退出，让 helper 能覆盖 exe。
      setTimeout(() => {
        try {
          runtime?.stop?.();
        } catch {
          // 关库失败也不拦退出
        }
        setTimeout(() => process.exit(0), 120);
      }, 600);
    }
    return ctx.json(200, result);
  });
}
