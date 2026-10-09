/**
 * 把 Silver Tavern 当 MCP 服务器跑起来（stdio 传输）。
 *
 * 用法（在 Codex / Claude Code 的 MCP 配置里填这条命令）：
 *   node <项目目录>/server/mcp-stdio.mjs --data-dir <数据目录>
 *
 * 为什么选 stdio 而不是 HTTP：Codex CLI 与 Claude Code 都是"给一条命令、
 * 用 stdin/stdout 说话"的方式挂本地 MCP 服务器，不需要端口、不需要鉴权、
 * 也不会把酒馆的读写接口暴露到网络上。想要远程访问时可以以后再补 HTTP 传输。
 *
 * 重要：stdout 只用于 JSON-RPC，日志一律走 stderr（TAVERN_MCP_DEBUG=1 才出声）。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRuntime } from './runtime.mjs';
import { createMcpServer } from '../core/mcp/server.mjs';
import { createStdioTransport } from './mcp/stdio.mjs';
import { listXray } from './db/xray.mjs';
import { loadPlugins } from './plugins.mjs';
import { normaliseUsername } from '../core/accounts.mjs';
import { isSeaRuntime } from './sea.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(here, '..');
// 和 HTTP 入口同一条口径：单文件 exe 默认用 exe 旁边的 data/，普通 node 启动用项目根。
const BASE_DIR = isSeaRuntime() ? here : PROJECT_ROOT;

function argValue(argv, name) {
  const index = argv.indexOf(name);
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  const prefixed = argv.find((item) => item.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : null;
}

/** stderr 日志：stdout 留给 JSON-RPC，一点都不能污染。 */
function createStderrLogger(verbose) {
  const write = (...args) => process.stderr.write(`[mcp] ${args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')}\n`);
  return {
    setLevel() {},
    error: write,
    warn: write,
    info: verbose ? write : () => {},
    debug: verbose ? write : () => {},
  };
}

export function resolveMcpDataDir(argv = process.argv.slice(2)) {
  const explicit = argValue(argv, '--data-dir');
  const base = explicit
    ? path.resolve(explicit)
    : process.env.TAVERN_DATA_DIR
      ? path.resolve(process.env.TAVERN_DATA_DIR)
      : path.join(BASE_DIR, 'data');
  // 多用户模式：--user <账号> 直接指向那个人的租户目录（MCP 也一人一份）。
  // 账号名必须过一遍校验：否则 `--user ..` 之类会从 tenants/ 里穿出去，读到主机目录本身。
  const user = argValue(argv, '--user');
  if (user) {
    let name;
    try {
      name = normaliseUsername(user);
    } catch (err) {
      throw new Error(`--user 不是合法的账号名（${err?.message ?? err}）`);
    }
    return path.join(base, 'tenants', name);
  }
  return base;
}

export async function runMcpStdio({ dataDir = resolveMcpDataDir(), runtime: providedRuntime = null, input = process.stdin, output = process.stdout } = {}) {
  const verbose = process.env.TAVERN_MCP_DEBUG === '1';
  const logger = createStderrLogger(verbose);
  const runtime = providedRuntime ?? createRuntime({ dataDir, logger, withComfy: false });
  // MCP 进程也要认插件（这样插件注册的工具能一起暴露给 Codex / Claude Code）。
  const plugins = await loadPlugins({ dataDir: runtime.dataDir, logger, engine: runtime.engine, agents: runtime.agents });
  if (plugins.errors.length) logger.info(`[plugins] 有 ${plugins.errors.length} 个插件没加载成功（不影响启动）`);
  const server = createMcpServer({
    services: runtime.engine.services,
    stores: { ...runtime.stores, xrayList: (query) => listXray(runtime.repo, query) },
    repo: runtime.repo,
    version: runtime.engine.version,
    extraTools: plugins.tools,
  });
  const transport = createStdioTransport({ server, input, output, logger });
  if (verbose) logger.info(`Silver Tavern MCP 已就绪：${runtime.dataDir}（${server.toolCount} 个工具）`);
  await transport.start();
  transport.close();
  try {
    runtime.stop();
  } catch {
    // 关闭时的报错不值得让客户端看到
  }
  return { server, runtime };
}

/** 命令行入口（无顶层 await，方便单文件打包）。 */
export async function main() {
  await runMcpStdio().catch((err) => {
    process.stderr.write(`[mcp] 启动失败：${err?.stack ?? err}\n`);
    process.exitCode = 1;
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) void main();
