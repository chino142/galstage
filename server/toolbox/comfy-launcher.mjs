/**
 * ComfyUI 启动托管：让酒馆自己在后台把 ComfyUI 拉起来，不用再点整合包的启动器。
 *
 * 复用「本地代理托管」那一套（spawn + 探端口 + 环形日志），额外做三件事：
 *   1) 认得出"端口上已经有人了"——你自己用启动器开着 ComfyUI 时，我们不去抢端口，
 *      更不会去停它（托管只停自己拉起来的那一份）；
 *   2) 启动完不只等端口，还等 /system_stats 真回话，免得第一张图撞在启动半路上；
 *   3) 闲置一段时间自动停掉，把显存还回去（还在出图就不停，等下一轮）。
 *
 * 安全口径和 providers.launcher 完全一致：它会以服务进程的身份执行配置里的命令，
 * 所以多用户模式下只有管理员能配 / 能启动（见 server/api/_helpers.mjs）。
 */

import net from 'node:net';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

import { createLauncher } from '../providers/launcher.mjs';

const ID = 'comfyui';
const START_TIMEOUT_MS = 180000;
const HTTP_READY_TIMEOUT_MS = 30000;

/**
 * 把 `main.py --listen 127.0.0.1 --port 8188` 这种串切成参数数组。
 * 双引号 / 单引号里的空格不切，方便写带空格的路径。
 */
export function parseLaunchArgs(text) {
  const out = [];
  let current = '';
  let quote = null;
  let started = false;
  for (const char of String(text ?? '')) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
      if (started) {
        out.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started) out.push(current);
  return out;
}

/**
 * 从设置里算出"要启动什么"。
 * 端口不单独配：直接取 `comfy.baseUrl` 的端口 —— 探活地址和启动参数里的端口永远不会打架。
 */
export function comfyLaunchSpec(settings = {}) {
  const command = String(settings['comfy.launcher.command'] ?? '').trim();
  const baseUrl = String(settings['comfy.baseUrl'] ?? 'http://127.0.0.1:8188');
  let url = null;
  try {
    url = new URL(baseUrl);
  } catch {
    url = null;
  }
  const port = url?.port ? Number(url.port) : url?.protocol === 'https:' ? 443 : 8188;
  const idleStopMinutes = Number(settings['comfy.idleStopMinutes'] ?? 15);
  return {
    configured: Boolean(command),
    command,
    args: parseLaunchArgs(settings['comfy.launcher.args']),
    cwd: String(settings['comfy.launcher.cwd'] ?? '').trim() || undefined,
    host: url?.hostname || '127.0.0.1',
    port,
    baseUrl,
    autoStart: settings['comfy.autoStart'] === true,
    idleStopMinutes: Number.isFinite(idleStopMinutes) && idleStopMinutes > 0 ? idleStopMinutes : 0,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function portOpen(host, port, timeoutMs = 800) {
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

export function createComfyLauncher({ logger = console, getSettings = () => ({}), hasActiveWork = null, stateFile = null } = {}) {
  const launcher = createLauncher({ logger });
  let idleTimer = null;
  let starting = null;

  const spec = () => comfyLaunchSpec(getSettings());

  /** 记下"这份 ComfyUI 是酒馆拉起来的"，下次开酒馆时好把它认回来。 */
  function remember(extra = {}) {
    if (!stateFile) return;
    try {
      writeFileSync(stateFile, JSON.stringify({ pid: entryPid(), startedAt: new Date().toISOString(), ...extra }), 'utf8');
    } catch {
      // 写不进去就算了，顶多下次认不出来
    }
  }

  function forget() {
    if (!stateFile) return;
    try {
      rmSync(stateFile, { force: true });
    } catch {
      // 忽略
    }
  }

  function entryPid() {
    return launcher.status(ID).pid ?? null;
  }

  /**
   * 上次酒馆没走退出流程（比如直接点了窗口的 ✕），它拉起来的 ComfyUI 会留在后台占显存。
   * 这里按记下的 PID 把它认回来：活着就接管（闲置到点 / 退出时会收掉），死了就把记录清掉。
   */
  function sweep() {
    if (!stateFile) return { adopted: false };
    let saved = null;
    try {
      saved = JSON.parse(readFileSync(stateFile, 'utf8'));
    } catch {
      return { adopted: false };
    }
    const adopted = launcher.adopt(ID, { pid: saved?.pid, port: saved?.port, startedAt: saved?.startedAt ? Date.parse(saved.startedAt) : null });
    if (!adopted) {
      forget();
      return { adopted: false };
    }
    logger.info?.(`接管了上次留下的 ComfyUI（PID ${saved.pid}）：闲置到点或酒馆退出时会把它收掉`);
    scheduleIdleStop();
    return { adopted: true, pid: saved.pid };
  }

  function clearIdle() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  /** 重新计时：每一轮出图都把"闲置时钟"拨回零。 */
  function scheduleIdleStop() {
    clearIdle();
    const { idleStopMinutes } = spec();
    if (!idleStopMinutes) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!launcher.status(ID).running) return;
      // 还在出图就再等一轮，别把正在跑的活掐了
      if (typeof hasActiveWork === 'function' && hasActiveWork()) {
        scheduleIdleStop();
        return;
      }
      stopMini('闲置自动停');
    }, idleStopMinutes * 60 * 1000);
    idleTimer.unref?.();
  }

  function stopMini(reason) {
    clearIdle();
    if (!launcher.status(ID).running) {
      forget();
      return false;
    }
    const stopped = launcher.stop(ID);
    forget();
    if (stopped) logger.info?.(`ComfyUI 已停掉（${reason}）`);
    return stopped;
  }

  /** 不只等端口，等 /system_stats 真回话 —— 免得第一张图撞在启动半路上。 */
  async function waitHttp(baseUrl, timeoutMs = HTTP_READY_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/system_stats`, { signal: AbortSignal.timeout(2000) });
        if (response.ok) return true;
      } catch {
        // 还没起来，继续等
      }
      await sleep(500);
    }
    return false;
  }

  /**
   * 保证在跑。
   *   force=false（出图前自动拉）：只有开了「出图前自动拉起」才动手；
   *   force=true（界面上点「启动」）：不管开关，配了就拉。
   * 端口上已经有人（你自己开的）时直接认账，不抢、不停。
   */
  async function ensure({ force = false } = {}) {
    const s = spec();
    if (!s.configured) return { ok: false, reason: 'not-configured' };
    if (!force && !s.autoStart) return { ok: false, reason: 'auto-off' };
    if (launcher.status(ID).running) {
      scheduleIdleStop();
      return { ok: true, mine: true, port: s.port };
    }
    if (await portOpen(s.host, s.port)) {
      scheduleIdleStop();
      return { ok: true, external: true, port: s.port };
    }
    if (starting) return starting;
    starting = (async () => {
      try {
        await launcher.start(ID, {
          command: s.command,
          args: s.args,
          cwd: s.cwd,
          host: s.host,
          port: s.port,
          timeoutMs: START_TIMEOUT_MS,
        });
        const ready = await waitHttp(s.baseUrl);
        remember({ port: s.port, command: s.command });
        scheduleIdleStop();
        if (!ready) {
          return { ok: false, reason: 'not-ready', port: s.port, logs: launcher.status(ID).logs.slice(-5) };
        }
        return { ok: true, started: true, port: s.port };
      } finally {
        starting = null;
      }
    })();
    return starting;
  }

  function status() {
    const s = spec();
    const mine = launcher.status(ID);
    return {
      configured: s.configured,
      command: s.command || null,
      args: s.args,
      cwd: s.cwd ?? null,
      host: s.host,
      port: s.port,
      autoStart: s.autoStart,
      idleStopMinutes: s.idleStopMinutes,
      starting: Boolean(starting),
      running: mine.running,
      ready: mine.ready,
      adopted: mine.adopted === true,
      pid: mine.pid ?? null,
      startedAt: mine.startedAt ?? null,
      uptimeMs: mine.uptimeMs ?? 0,
      exitCode: mine.exitCode ?? null,
      logs: mine.logs ?? [],
    };
  }

  /** 出完一张图拨一下闲置时钟。 */
  function touch() {
    if (launcher.status(ID).running) scheduleIdleStop();
  }

  const swept = sweep();

  return { ensure, stop: (reason = '手动') => stopMini(reason), status, touch, spec, clearIdle, sweep, swept };
}
