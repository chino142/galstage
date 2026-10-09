/**
 * 极小的进程内事件总线。
 * 引擎和 HTTP 层用它广播"某件事发生了"（例如对话生成了新消息），
 * 前端通过 SSE 订阅转发过去的事件。
 */

export function createBus() {
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();

  return {
    on(type, fn) {
      if (typeof fn !== 'function') throw new TypeError('listener 必须是函数');
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => this.off(type, fn);
    },

    once(type, fn) {
      const off = this.on(type, (payload) => {
        off();
        fn(payload);
      });
      return off;
    },

    off(type, fn) {
      const set = listeners.get(type);
      if (!set) return;
      set.delete(fn);
      if (set.size === 0) listeners.delete(type);
    },

    emit(type, payload = null) {
      const set = listeners.get(type);
      if (!set || set.size === 0) return 0;
      for (const fn of [...set]) {
        try {
          fn(payload, type);
        } catch (err) {
          // 一个监听器出错不能影响其它监听器。
          console.error(`[bus] 监听 ${type} 时出错：`, err);
        }
      }
      return set.size;
    },

    clear(type) {
      if (type) listeners.delete(type);
      else listeners.clear();
    },

    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },

    types() {
      return [...listeners.keys()];
    },
  };
}

/** 进程级共享总线。测试里要隔离的话自己 createBus()。 */
export const appBus = createBus();
