/**
 * 租户管理器（多用户模式）：账号名 → 一整套运行时 + 路由器，按需载入、常驻。
 *
 * 关键点：每个租户都是**独立的 `createRuntime` + `createApp` + `registerApi`**。
 * 各接口模块是在注册时闭包捕获 engine / 存储的，所以"按请求换租户"不能去改
 * 全局 engine，而是每个租户各自建一套 —— 现有功能模块一行都不用改，隔离天然成立。
 *
 * 载入后就常驻（不自动卸载）：租户的定时任务、ComfyUI 连接、记忆摘要是跟着运行时走的，
 * 卸载了它们就停了。几个朋友 × 几十 MB 内存，比"定时任务静默失效"划算。
 * 管理员可以在总览里手动卸载某个租户（下次访问会重新载入）。
 */

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { TENANTS_DIR } from '../core/accounts.mjs';
import { createRuntime } from './runtime.mjs';
import { createApp } from './http/server.mjs';
import { registerApi } from './api/index.mjs';

function dirSize(target) {
  if (!existsSync(target)) return 0;
  let total = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else {
        try {
          total += statSync(absolute).size;
        } catch {
          // 读不到就算 0，统计用不着为这个失败
        }
      }
    }
  };
  walk(target);
  return total;
}

export function createTenantManager(options = {}) {
  const { hostRoot, logger = console, webRoot } = options;
  const tenantsRoot = path.join(hostRoot, TENANTS_DIR);
  const tenants = new Map();

  /** 插件是主机级的，而且是"启动时才加载完"的 —— 所以每次现读，别在构造时快照成 null。 */
  function currentPlugins() {
    return options.plugins ?? null;
  }

  function dataDirFor(name) {
    const dir = path.join(tenantsRoot, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function build(name) {
    const dataDir = dataDirFor(name);
    // multiUser: true → 租户默认走「浏览器直连」（见 server/runtime.mjs）。
    // 本地代理托管会以服务进程的身份执行命令 → 多用户模式下只给管理员账号的租户建；
    // 没传 accounts（单机 / 测试直接建）时按"允许"处理，跟以前一致。
    const account = options.accounts?.find?.(name) ?? null;
    const withLauncher = options.accounts ? account?.role === 'admin' : true;
    // 同理：成员不让主机替他连 ComfyUI（那是 SSRF 口子），强制浏览器直连
    const forceClientComfy = options.accounts ? account?.role !== 'admin' : false;
    const runtime = createRuntime({ dataDir, logger, withComfy: true, withLauncher, forceClientComfy, multiUser: true });
    const app = createApp({
      engine: runtime.engine,
      logger,
      webRoot,
      schemaVersion: runtime.db.schemaVersion,
      dataDir,
      models: runtime.models,
      mcp: runtime.mcp,
      agents: runtime.agents,
    });
    const plugins = currentPlugins();

    // 插件是主机级的（代码，不是数据）：所有租户共享同一份，各租户路由都能用
    app.app.plugins = plugins;
    app.app.pluginRoot = hostRoot;
    app.app.multiUser = true;
    app.app.hostRoot = hostRoot;

    registerApi(app.router, {
      engine: runtime.engine,
      repo: runtime.db.repo,
      logger,
      dataDir,
      models: runtime.models,
      masterKey: runtime.masterKey,
      mcp: runtime.mcp,
      agents: runtime.agents,
      chatStore: runtime.stores.chatStore,
      referenceStore: runtime.stores.referenceStore,
      comfyStore: runtime.stores.comfyStore,
      comfyRunner: runtime.comfyRunner,
      assets: runtime.stores.assetStore,
      runtime,
    });
    for (const route of plugins?.routes ?? []) {
      try {
        app.router[route.method](route.path, route.handler, route.meta);
      } catch (err) {
        logger?.warn?.(`[tenants] 插件接口 ${route.method.toUpperCase()} ${route.path} 挂到 ${name} 失败：${err?.message ?? err}`);
      }
    }
    // 插件注册的写卡技能也要装进这个租户的 agent 运行时（否则技能清单里看不到）
    for (const skill of plugins?.skills ?? []) {
      try {
        runtime.agents?.addSkill?.(skill);
      } catch (err) {
        logger?.warn?.(`[tenants] 插件技能 ${skill?.id} 装到 ${name} 失败：${err?.message ?? err}`);
      }
    }
    // 接着上次没跑完的出图（没有进行中的任务时它不会连 WebSocket）
    runtime.comfyRunner?.resume?.();

    return { name, dataDir, runtime, app, createdAt: Date.now(), lastUsed: Date.now() };
  }

  function get(name) {
    let tenant = tenants.get(name);
    if (!tenant) {
      tenant = build(name);
      tenants.set(name, tenant);
      logger?.info?.(`[tenants] 载入 ${name}`);
    }
    tenant.lastUsed = Date.now();
    return tenant;
  }

  function unload(name) {
    const tenant = tenants.get(name);
    if (!tenant) return false;
    tenants.delete(name);
    try {
      tenant.runtime.stop();
    } catch (err) {
      logger?.warn?.(`[tenants] 卸载 ${name} 出错：${err?.message ?? err}`);
    }
    logger?.info?.(`[tenants] 卸载 ${name}`);
    return true;
  }

  function stopAll() {
    for (const name of [...tenants.keys()]) unload(name);
  }

  /** 管理员总览：已载入的 + 磁盘占用（磁盘统计按需走，别放在热路径上）。 */
  function stats({ withDisk = false } = {}) {
    const items = [...tenants.values()].map((tenant) => ({
      name: tenant.name,
      dataDir: tenant.dataDir,
      loaded: true,
      createdAt: tenant.createdAt,
      lastUsed: tenant.lastUsed,
      ...(withDisk ? { bytes: dirSize(tenant.dataDir) } : {}),
    }));
    if (!withDisk) return items;
    const known = new Set(items.map((item) => item.name));
    if (existsSync(tenantsRoot)) {
      for (const entry of readdirSync(tenantsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || known.has(entry.name)) continue;
        items.push({
          name: entry.name,
          dataDir: path.join(tenantsRoot, entry.name),
          loaded: false,
          createdAt: null,
          lastUsed: null,
          bytes: dirSize(path.join(tenantsRoot, entry.name)),
        });
      }
    }
    return items;
  }

  function listLoaded() {
    return [...tenants.keys()];
  }

  return { get, unload, stopAll, stats, listLoaded, tenantsRoot, dataDirFor };
}
