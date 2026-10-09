/**
 * 启动后自动把浏览器拉到 http://127.0.0.1:8788。
 *
 * 什么时候开、什么时候不开，是这个文件里唯一需要小心的地方：
 *   开：双击 exe（打了包的、挂在交互式控制台上）。
 *   不开：`node server/index.mjs`（开发和测试）、`--mcp`（当 MCP 服务器用）、
 *         被脚本 spawn 起来的时候（stdin 不是 TTY）、显式 `--no-open` 或 TAVERN_NO_OPEN=1。
 *
 * 为什么用"stdin 是不是 TTY"当判据：跟 `keepWindowOpen()` 里那个"要不要等你按回车"
 * 是同一个依据，项目里已经这么用了。测试脚本 spawn exe 时 stdio 是管道，天生不满足，
 * 所以不用给每个测试脚本加开关。
 */

import { spawn } from 'node:child_process';

/**
 * 纯判断，方便单测。
 * @param {{argv?: string[], env?: Record<string,string>, packaged?: boolean, interactive?: boolean}} input
 * @returns {{open: boolean, reason: string}}
 */
export function decideAutoOpen({ argv = [], env = {}, packaged = false, interactive = false } = {}) {
  if (argv.includes('--mcp') || argv[0] === 'mcp') return { open: false, reason: 'MCP 模式' };
  if (argv.includes('--no-open')) return { open: false, reason: '命令行要求不开' };
  if (String(env.TAVERN_NO_OPEN ?? '') === '1') return { open: false, reason: '环境变量要求不开' };
  if (argv.includes('--open')) return { open: true, reason: '命令行要求开' };
  if (!packaged) return { open: false, reason: '不是单文件 exe（开发 / 测试）' };
  if (!interactive) return { open: false, reason: '不是交互式控制台（多半是被脚本拉起来的）' };
  return { open: true, reason: '双击启动' };
}

/**
 * 真正去开。开不了不报错——这是锦上添花的事，绝不能因为它让服务起不来。
 * @param {string} url
 * @returns {boolean} 有没有把命令发出去
 */
export function openBrowser(url) {
  const target = String(url ?? '');
  if (!/^https?:\/\//i.test(target)) return false;
  try {
    if (process.platform === 'win32') {
      // `start` 是 cmd 的内建命令；第一个引号参数会被当成窗口标题，所以必须给个空的。
      spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
    }
    return true;
  } catch {
    return false;
  }
}
