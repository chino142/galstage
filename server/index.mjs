/**
 * HTTP 启动入口。
 *
 * 装配在 server/runtime.mjs（和 MCP stdio 入口共用），这里只负责
 * 装 HTTP、注册接口、监听、以及信号处理。
 * 被测试 import 时不会自动启动（见文件末尾的 isMain 判断）。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRuntime } from './runtime.mjs';
import { createApp } from './http/server.mjs';
import { registerApi } from './api/index.mjs';
import { loadPlugins } from './plugins.mjs';
import { isSeaRuntime, seaAssetReader } from './sea.mjs';
import { decideAutoOpen, openBrowser } from './browser.mjs';
import { createHost } from './host.mjs';
import { createAccountStore } from './accounts.mjs';
import { createLogger } from './log.mjs';
import { ENGINE_VERSION } from '../core/index.mjs';
import { normaliseUsername } from '../core/accounts.mjs';
import { randomBytes } from 'node:crypto';
import { setProxy } from './providers/http.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(here, '..');
export const WEB_ROOT = path.join(PROJECT_ROOT, 'web');

/**
 * 默认数据目录的"落脚点"：
 *   - 普通 node 启动：项目根（`node server/index.mjs` → <项目>/data）；
 *   - 单文件 exe：exe 所在的目录（Node SEA 里 `import.meta.url` 就是 exe 的路径）。
 *     这样 exe 拷到哪，data/ 就跟着落在哪，搬机器 / 放桌面都符合直觉。
 * 想自己指定就设 TAVERN_DATA_DIR，优先级最高。
 */
const BASE_DIR = isSeaRuntime() ? here : PROJECT_ROOT;

export function defaultDataDir() {
  return path.resolve(process.env.TAVERN_DATA_DIR ?? path.join(BASE_DIR, 'data'));
}

/** 端口被占时，先确认占着的是不是"我们自己的另一个实例"：是的话没必要报错。 */
async function probeTavern(url) {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.ok && data?.version ? data : null;
  } catch {
    return null;
  }
}

/**
 * 双击启动时，控制台是唯一能看到提示的地方 —— 一闪就没了等于没提示。
 * 只有挂在交互式控制台上才等一次回车；脚本 / 测试（stdin 不是 TTY）不会被卡住。
 */
function keepWindowOpen() {
  if (!process.stdin?.isTTY) return Promise.resolve();
  console.error('按回车关闭这个窗口…');
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', () => {
      process.stdin.pause();
      resolve();
    });
    const timer = setTimeout(resolve, 120000);
    timer.unref?.();
  });
}

/** 多用户模式（TAVERN_MULTI_USER=1 或 options.multiUser）：一个网址 + 登录，每人一个数据目录。 */
export async function startMultiUser(options = {}) {
  const hostRoot = path.resolve(options.dataDir ?? defaultDataDir());
  const logger = options.logger ?? createLogger(process.env.TAVERN_LOG ?? 'info');
  const host = createHost({
    hostRoot,
    webRoot: options.webRoot ?? WEB_ROOT,
    logger,
    version: ENGINE_VERSION,
    pluginLoader: loadPlugins,
    readAsset: options.readAsset ?? seaAssetReader(),
  });
  await host.initPlugins();
  if (host.accounts.count() === 0) {
    logger.info('[host] 还没有账号：浏览器打开首页会先让你建第一个（管理员）账号');
  }
  const port = options.port ?? Number(process.env.TAVERN_PORT ?? 8788);
  const bindHost = options.host ?? process.env.TAVERN_HOST ?? '127.0.0.1';
  const address = await host.listen({ port, host: bindHost });
  const url = `http://${bindHost === '0.0.0.0' ? '127.0.0.1' : bindHost}:${address.port}`;
  const stop = async () => {
    await host.close();
  };
  return {
    multiUser: true,
    server: host.server,
    address,
    url,
    hostRoot,
    dataDir: hostRoot,
    logger,
    accounts: host.accounts,
    tenants: host.tenants,
    plugins: host.app.plugins,
    handleRequest: host.handleRequest,
    listen: host.listen,
    close: host.close,
    stop,
  };
}

export async function startTavern(options = {}) {
  const dataDir = path.resolve(options.dataDir ?? defaultDataDir());
  if (options.multiUser ?? process.env.TAVERN_MULTI_USER === '1') {
    return startMultiUser({ ...options, dataDir });
  }
  const runtime = createRuntime({ dataDir, logger: options.logger ?? null, withComfy: true });
  const { engine, db, settings, logger, models, masterKey, mcp, agents, comfyRunner, comfyStore, assetStore, costStore } = runtime;

  // 启动自动备份（蓝图 3.2）：留一份"上次还好好的"状态，出事了能回去。
  // 备份失败不影响启动 —— 空间不够之类的问题不该让服务起不来。
  if (settings['data.autoBackupOnStart'] !== false) {
    try {
      const made = engine.services.maintenance.createBackup({ label: '启动自动备份', kind: 'auto' });
      const keep = Number(settings['data.autoBackupKeep'] ?? 10);
      const pruned = keep > 0 ? runtime.stores.backupStore.prune(keep + 1) : { removed: [] };
      logger.debug?.(`[backup] 启动备份 ${made.name}，清理了 ${pruned.removed.length} 份旧备份`);
    } catch (err) {
      logger.warn?.(`[backup] 启动自动备份失败（不影响启动）：${err?.message ?? err}`);
    }
  }

  // 启动时按设置里的代理配置出网口（没配就直连）。配错了不阻断启动，只记一条警告。
  try {
    const applied = setProxy(settings['net.proxy'] ?? '');
    if (applied?.error) logger.warn?.(`[net] 代理配置没生效：${applied.error}`);
  } catch (err) {
    logger.warn?.(`[net] 代理配置没生效（不阻断启动）：${err?.message ?? err}`);
  }

  const app = createApp({
    engine,
    logger,
    models,
    mcp,
    agents,
    webRoot: options.webRoot ?? WEB_ROOT,
    readAsset: options.readAsset ?? seaAssetReader(),
    schemaVersion: db.schemaVersion,
    dataDir,
  });
  registerApi(app.router, {
    engine,
    repo: db.repo,
    logger,
    dataDir,
    models,
    masterKey,
    mcp,
    agents,
    chatStore: runtime.stores.chatStore,
    referenceStore: runtime.stores.referenceStore,
    comfyStore,
    comfyRunner,
    comfyLauncher: runtime.comfyLauncher,
    assets: assetStore,
    runtime,
  });

  // 插件（蓝图 3.2）：扫 <数据目录>/plugins，坏插件只记警告，不影响启动。
  const plugins = await loadPlugins({ dataDir, logger, engine: runtime.engine, agents: runtime.agents });
  for (const route of plugins.routes) {
    try {
      app.router[route.method](route.path, route.handler, route.meta);
    } catch (err) {
      logger.warn?.(`[plugins] 接口 ${route.method.toUpperCase()} ${route.path} 注册失败：${err?.message ?? err}`);
    }
  }
  app.app.plugins = plugins;
  if (plugins.loaded.length) logger.info(`[plugins] 共加载 ${plugins.loaded.length} 个插件，注册 ${plugins.routes.length} 条接口`);

  const port = options.port ?? Number(process.env.TAVERN_PORT ?? 8788);
  const host = options.host ?? process.env.TAVERN_HOST ?? '127.0.0.1';
  const address = await app.listen({ port, host });
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${address.port}`;

  // 重启前还有没跑完的出图任务就继续盯着，不然那几张图永远停在"排队中"。
  const resumed = comfyRunner?.resume();
  if (resumed?.resumed) logger.info(`[comfy] 接回 ${resumed.resumed} 个没跑完的出图任务`);

  const stop = async () => {
    await app.close();
    runtime.stop();
  };

  return {
    ...app,
    engine,
    db,
    runtime,
    settings,
    dataDir,
    url,
    address,
    stop,
    logger,
    models,
    masterKey,
    mcp,
    agents,
    launcher: runtime.launcher,
    comfyRunner,
    comfyStore,
    assetStore,
    costStore,
  };
}

/**
 * 命令行入口。抽成函数是为了：
 *   - `--mcp` 时直接进 stdio 模式（单文件 exe 也只有这一个入口）；
 *   - 打包成单文件时没有顶层 await，能塞进 CommonJS 的 SEA 脚本。
 */
let cliPromise = null;

/**
 * runCli 做成幂等：打包后的产物里，入口模块自己的 `isMain` 判断和打包器的
 * autorun 会各调一次 runCli（两边都认为"我就是主入口"），不拦的话会起两个服务 ——
 * 同一个端口第二个 EADDRINUSE、同一个数据目录两份运行时（重复自动备份、两个调度器）。
 * 第二次调用直接返回第一次的 Promise。
 */
export function runCli(options = {}) {
  if (!cliPromise) {
    cliPromise = runCliOnce(options).catch((err) => {
      cliPromise = null;
      throw err;
    });
  }
  return cliPromise;
}

async function runCliOnce({ argv = process.argv.slice(2) } = {}) {
  if (argv.includes('--mcp') || argv[0] === 'mcp') {
    const { runMcpStdio } = await import('./mcp-stdio.mjs');
    return runMcpStdio();
  }
  const valueOf = (flag, fallback = null) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : fallback;
  };
  const dataDir = path.resolve(valueOf('--data-dir') ?? defaultDataDir());
  const multiUser = argv.includes('--multi-user') || process.env.TAVERN_MULTI_USER === '1';

  // 主机模式下的账号运维：加人 / 查人 / 重置口令，都不需要把服务起起来。
  if (multiUser && (argv.includes('--add-user') || argv.includes('--list-users') || argv.includes('--set-password'))) {
    const logger = createLogger(process.env.TAVERN_LOG ?? 'info');
    const accounts = createAccountStore({ hostRoot: dataDir, logger });
    try {
      if (argv.includes('--list-users')) {
        const items = accounts.list();
        if (!items.length) console.log('还没有账号。用 --add-user <名字> 加一个。');
        for (const account of items) {
          console.log(`${account.disabled ? '[停用] ' : ''}${account.name}\t${account.role}\t上次登录 ${account.lastLoginAt ?? '—'}`);
        }
        return null;
      }
      if (argv.includes('--set-password')) {
        const name = normaliseUsername(valueOf('--set-password'));
        const password = valueOf('--password') ?? randomBytes(9).toString('base64url');
        accounts.setPassword(name, password);
        console.log(`已重置 ${name} 的口令：${password}`);
        return null;
      }
      const name = normaliseUsername(valueOf('--add-user'));
      const password = valueOf('--password') ?? randomBytes(9).toString('base64url');
      const role = valueOf('--role', 'user');
      const account = accounts.create({ name, password, role });
      console.log(`已建账号：${account.name}（${account.role === 'admin' ? '管理员' : '成员'}）`);
      console.log(`  口令：${password}`);
      console.log(`  数据目录：${path.join(dataDir, 'tenants', account.name)}`);
      console.log('把它给朋友；他登录后可以在右上角改自己的口令。');
      return null;
    } catch (err) {
      console.error(`没做成：${err?.message ?? err}`);
      process.exitCode = 1;
      return null;
    }
  }

  const port = Number(process.env.TAVERN_PORT ?? 8788);
  const bindHost = process.env.TAVERN_HOST ?? '127.0.0.1';
  const url = `http://${bindHost === '0.0.0.0' ? '127.0.0.1' : bindHost}:${port}`;
  // 要不要启动后自动开浏览器。判据见 server/browser.mjs —— 只有"双击 exe"才开，
  // 开发和测试（node server/index.mjs、脚本 spawn）都不会弹窗。
  const autoOpen = decideAutoOpen({
    argv,
    env: process.env,
    packaged: isSeaRuntime(),
    interactive: Boolean(process.stdin?.isTTY),
  });

  /** 端口上已经有一个 Silver Tavern 在跑的话，告诉用户就行，不用报错。 */
  async function sayAlreadyRunning() {
    const running = await probeTavern(url);
    if (!running) return false;
    console.log(`Silver Tavern 已经在运行了：${url}`);
    console.log(`（版本 ${running.version}）浏览器打开这个地址就行；不用再点一次。`);
    console.log('想重启：先把正在运行的那个窗口关掉（或结束 silver-tavern.exe 进程），再启动。');
    // 再点一次 exe 的时候也顺手把浏览器拉起来——用户的本意就是"我要用"，不是"我要看报错"。
    if (autoOpen.open) openBrowser(url);
    await keepWindowOpen();
    return true;
  }

  // 先问一句"是不是已经在跑"：免得白开一次数据库、白做一份启动备份。
  if (port !== 0 && (await sayAlreadyRunning())) return null;

  const tavern = await startTavern({ dataDir, multiUser }).catch(async (err) => {
    if (err?.code === 'EADDRINUSE') {
      // 双击第二次 / 没关掉旧实例时最常见的场景：再起一个会撞端口。
      if (await sayAlreadyRunning()) return null;
      console.error(`端口 ${port} 被别的程序占用了。换一个端口再启动，例如：`);
      console.error(`  $env:TAVERN_PORT='8789'; .\\SilverTavern.exe`);
      await keepWindowOpen();
      process.exitCode = 1;
      return null;
    }
    console.error('启动失败：', err);
    await keepWindowOpen();
    process.exitCode = 1;
    return null;
  });

  if (tavern) {
    tavern.logger.info(`Silver Tavern ${ENGINE_VERSION} 已启动：${tavern.url}`);
    if (autoOpen.open) {
      if (openBrowser(tavern.url)) tavern.logger.info('已经帮你打开浏览器了；这个窗口别关，关掉就等于停服。');
    } else {
      tavern.logger.debug?.(`没有自动打开浏览器：${autoOpen.reason}`);
    }
    if (tavern.multiUser) {
      tavern.logger.info(`多用户模式 · 主目录：${tavern.hostRoot} · 账号 ${tavern.accounts.count()} 个（数据在 tenants/<账号>/）`);
      if (tavern.accounts.count() === 0) tavern.logger.info('还没有账号：浏览器打开首页先建管理员；或者 node server/index.mjs --multi-user --add-user <名字>');
    } else {
      tavern.logger.info(`数据目录：${tavern.dataDir}`);
      tavern.logger.info(`接口：${tavern.router.size} 条，模块：${tavern.engine.registry.size} 个`);
    }

    const shutdown = async (signal) => {
      tavern.logger.info(`收到 ${signal}，正在退出…`);
      await tavern.stop();
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }
  return tavern;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) void runCli();
