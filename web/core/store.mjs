/** 极小的响应式状态容器：改了就通知订阅者，界面自己决定重绘哪块。 */

export function createStore(initial = {}) {
  let state = { ...initial };
  const listeners = new Set();

  function notify(changed) {
    for (const listener of [...listeners]) listener(state, changed);
  }

  return {
    get() {
      return state;
    },
    get(key) {
      return state[key];
    },
    set(patch) {
      const changed = Object.keys(patch);
      state = { ...state, ...patch };
      notify(changed);
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
