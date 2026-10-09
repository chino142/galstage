/**
 * 路由层的小工具。
 *
 * 两种写法：
 *   - 服务已经有方法：直接 await 它，抛出的错误由最外层统一转成响应；
 *   - 还没实现：用 stubs() 批量登记，统一回 501 + 标准错误形状。
 */

import { NotImplementedError } from '../../core/errors.mjs';

/**
 * @param {import('../http/router.mjs').createRouter} router
 * @param {Array<[string, string, string, object?]>} entries  [方法, 路径, 说明, meta?]
 */
export function stubs(router, entries) {
  for (const [method, path, what, meta] of entries) {
    router[method.toLowerCase()](path, async (ctx) => {
      throw new NotImplementedError(what, { path: ctx.path, method: ctx.method });
    }, meta);
  }
}

export function registerAll(router, registrars, deps) {
  for (const register of registrars) register(router, deps);
  return router;
}

/**
 * 多用户模式下，"让主机去连 ComfyUI"（`comfy.executionMode = 'server'`）只有管理员能用。
 *
 * 成员的 ComfyUI 地址是他自己填的，主机代连 = 他能让**主机进程**去请求内网任意地址，
 * 还能从 `/system_stats` 把版本 / 设备读回来（SSRF，顺带信息泄露）。
 * 成员一律走「浏览器直连」；管理员就是主机主人，照旧可用。
 * 单个租户运行时的强制点在 `server/tenants.mjs`（forceClientComfy），这里是写入侧的同一条闸。
 */
export function deniesServerComfy(ctx) {
  return deniesHostActions(ctx);
}

export const SERVER_COMFY_DENIED =
  '多用户模式下成员只能用「浏览器直连」的 ComfyUI：让主机进程去连你填的地址等于开了个 SSRF 口子。要主机代连就用管理员账号。';

/**
 * 多用户模式下，"让主机替你执行命令 / 替你出网"的东西只有管理员能用：
 * 本地代理托管、MCP stdio 服务器、ComfyUI 主机代连。
 * 成员拿到的都是 403 —— 这几样一旦放开，等于把租户隔离作废（能在主机上执行任意命令）。
 */
export function deniesHostActions(ctx) {
  if (!ctx.app.multiUser) return false;
  return ctx.app.auth?.user?.role !== 'admin';
}

export const MCP_STDIO_DENIED =
  '多用户模式下只有管理员能加 / 连接本地 MCP 服务器：它会在主机上启动一个进程。';

/** 这几条设置是"让主机执行命令"（ComfyUI 启动托管），多用户模式下只给管理员。 */
export const COMFY_LAUNCHER_KEYS = ['comfy.autoStart', 'comfy.launcher.command', 'comfy.launcher.args', 'comfy.launcher.cwd'];

export const COMFY_LAUNCH_DENIED =
  '多用户模式下只有管理员能配置 / 启动本地 ComfyUI：那等于在主机上执行命令。要自己用，就在单机模式（或管理员账号）下跑。';

/**
 * 破坏性操作前自动备份（蓝图 3.2「每次大改动前各留一份」）。
 *
 * 只在"批量导入 / 批量删除 / 清空 / 跑迁移"这类路径上调用；只读和每轮对话这种
 * 高频路径**不要**调，不然备份会把磁盘写满。备份失败不阻断操作（空间不够之类的问题
 * 不该让用户连卡都导不进来），只写一条警告。
 */
export function safeAutoBackup({ engine, logger, reason, kind = 'auto' }) {
  try {
    const made = engine?.services?.maintenance?.autoBackup?.(reason, kind);
    if (made?.backup?.name) logger?.info?.(`[backup] ${reason}：已留 ${made.backup.name}`);
    return made ?? null;
  } catch (err) {
    logger?.warn?.(`[backup] ${reason} 自动备份失败（不影响这次操作）：${err?.message ?? err}`);
    return null;
  }
}
