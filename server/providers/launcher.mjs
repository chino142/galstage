/**
 * 本地代理进程托管。
 *
 * CLI（Claude Code / Gemini CLI / Qwen Code…）和反重力那类渠道的用法是：
 * 本机先跑一个转换代理，它在某个端口上提供 OpenAI / Anthropic 方言的接口。
 * 每次用之前手动开一遍太烦，所以让酒馆自己把它们拉起来：
 * 提供方上配一条启动命令 + 端口，调用前自动确保它在跑。
 *
 * 只做"启动一个我配置好的本地进程"，不做账号轮换、不做多号切换。
 */

import { spawn } from 'node:child_process';
import net from 'node:net';

const MAX_LOG_LINES = 200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canConnect(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

export function isValidLauncher(spec) {
  return Boolean(spec && typeof spec === 'object' && String(spec.command ?? '').trim());
}

export function createLauncher({ logger = console } = {}) {
  /** @type {Map<string, object>} */
  const entries = new Map();

  function pushLog(entry, stream, chunk) {
    for (const line of String(chunk).split(/\r?\n/)) {
      const text = line.trim();
      if (!text) continue;
      entry.logs.push(`[${stream}] ${text}`);
      if (entry.logs.length > MAX_LOG_LINES) entry.logs.shift();
    }
  }

  async function waitReady(entry, spec, timeoutMs) {
    const port = Number(spec.port ?? 0);
    if (!port) {
      // 没给端口就只等一小会儿，让进程有机会把错误吐出来
      await sleep(Number(spec.warmupMs ?? 600));
      if (entry.exited) throw new Error(exitMessage(entry));
      return true;
    }
    const host = spec.host ?? '127.0.0.1';
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (entry.exited) throw new Error(exitMessage(entry));
      if (await canConnect(host, port)) return true;
      await sleep(400);
    }
    throw new Error(
      `等待本地代理端口 ${host}:${port} 超时（${Math.round(timeoutMs / 1000)} 秒）。最近输出：${entry.logs.slice(-4).join(' / ') || '（没有输出）'}`,
    );
  }

  function exitMessage(entry) {
    return `本地代理启动后立刻退出（code ${entry.exitCode ?? '?'}）。最近输出：${entry.logs.slice(-4).join(' / ') || '（没有输出）'}`;
  }

  async function start(id, spec) {
    if (!isValidLauncher(spec)) throw new Error('没有配置启动命令');
    const existing = entries.get(id);
    if (existing && !existing.exited) return existing;

    const child = spawn(spec.command, spec.args ?? [], {
      cwd: spec.cwd ?? undefined,
      env: { ...process.env, ...(spec.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const entry = { id, spec, child, logs: [], startedAt: Date.now(), exited: false, ready: false, exitCode: null };
    entries.set(id, entry);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => pushLog(entry, 'out', chunk));
    child.stderr.on('data', (chunk) => pushLog(entry, 'err', chunk));
    child.on('error', (err) => {
      entry.exited = true;
      entry.exitCode = -1;
      pushLog(entry, 'err', err.message);
    });
    child.on('exit', (code) => {
      entry.exited = true;
      entry.exitCode = code;
      logger?.info?.(`本地代理 ${id} 已退出（code ${code}）`);
    });

    const timeoutMs = Number(spec.timeoutMs ?? 45000);
    await waitReady(entry, spec, timeoutMs);
    entry.ready = true;
    logger?.info?.(`本地代理 ${id} 已就绪${spec.port ? `（端口 ${spec.port}）` : ''}`);
    return entry;
  }

  /** 调用前调用它：没配 launcher 就返回 null，配了就保证在跑。 */
  async function ensure(id, spec) {
    if (!isValidLauncher(spec)) return null;
    const existing = entries.get(id);
    if (existing && !existing.exited && existing.ready) {
      // 端口可能被代理自己重启过，再确认一次
      if (!spec.port || (await canConnect(spec.host ?? '127.0.0.1', Number(spec.port)))) return existing;
      existing.ready = false;
    }
    return start(id, spec);
  }

  function stop(id) {
    const entry = entries.get(id);
    if (!entry || entry.exited) return false;
    const pid = entry.child.pid;
    try {
      if (process.platform === 'win32' && pid) {
        // 代理常常自己再拉起子进程，光 kill 父进程杀不干净
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      } else {
        entry.child.kill('SIGTERM');
      }
    } catch (err) {
      logger?.warn?.(`停止本地代理 ${id} 失败：${err.message}`);
    }
    entry.exited = true;
    entry.ready = false;
    return true;
  }

  function stopAll() {
    for (const id of [...entries.keys()]) stop(id);
  }

  function status(id) {
    const entry = entries.get(id);
    if (!entry) return { running: false, ready: false, logs: [] };
    // 接管的进程没有子进程事件可听，只能自己问一句"还活着吗"
    if (entry.adopted && !entry.exited && !isAlive(entry.child.pid)) {
      entry.exited = true;
      entry.ready = false;
    }
    return {
      running: !entry.exited,
      ready: Boolean(entry.ready) && !entry.exited,
      pid: entry.child.pid ?? null,
      startedAt: new Date(entry.startedAt).toISOString(),
      uptimeMs: Date.now() - entry.startedAt,
      exitCode: entry.exitCode,
      adopted: Boolean(entry.adopted),
      logs: entry.logs.slice(-30),
    };
  }

  /** pid 还活着吗。Windows 上 process.kill(pid, 0) 一样能问。 */
  function isAlive(pid) {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 接管一个"上一次酒馆留下、现在还活着"的进程。
   * 场景：酒馆窗口被直接关掉（没走退出流程），它拉起来的 ComfyUI 就留在后台占显存。
   * 下次开酒馆时把它认回来，这样闲置到点 / 退出时才能把它收掉；不是自己记下的 PID 不会碰。
   */
  function adopt(id, { pid, port = 0, startedAt = null, logs = [] } = {}) {
    if (!pid || !isAlive(pid)) return false;
    const existing = entries.get(id);
    if (existing && !existing.exited) return false;
    entries.set(id, {
      id,
      spec: { port: Number(port) || 0 },
      child: { pid, kill() {} },
      logs: [...logs],
      startedAt: startedAt ?? Date.now(),
      exited: false,
      ready: true,
      exitCode: null,
      adopted: true,
    });
    return true;
  }

  function all() {
    return [...entries.keys()].map((id) => ({ id, ...status(id) }));
  }

  return { start, ensure, stop, stopAll, status, all, adopt, isValidLauncher };
}
