/**
 * 极小的日志器。级别来自 settings 的 logging.level，但进程启动那一刻
 * 数据库还没打开，所以先用环境变量兜底，打开数据库之后再切。
 */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export function createLogger(level = 'info') {
  let current = LEVELS[level] ?? LEVELS.info;

  function write(minimum, stream, args) {
    if (current < minimum) return;
    const stamp = new Date().toISOString().slice(11, 19);
    stream(`[${stamp}]`, ...args);
  }

  return {
    setLevel(level) {
      current = LEVELS[level] ?? current;
    },
    get level() {
      return Object.keys(LEVELS).find((key) => LEVELS[key] === current) ?? 'info';
    },
    error: (...args) => write(LEVELS.error, console.error, args),
    warn: (...args) => write(LEVELS.warn, console.warn, args),
    info: (...args) => write(LEVELS.info, console.log, args),
    debug: (...args) => write(LEVELS.debug, console.log, args),
  };
}

export const log = createLogger(process.env.TAVERN_LOG ?? 'info');
