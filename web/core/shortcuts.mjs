/**
 * 快捷键（蓝图 3.2「使用体验」）。
 *
 * 组合键写法：`Enter` / `Ctrl+Enter` / `Alt+Shift+R` / `Cmd+K`。
 * 解析与匹配是纯函数（可以在没有 DOM 的地方单测），挂监听在 createShortcutManager。
 * 绑定值来自设置里的 `ui.shortcut.*`，改了设置重新 register 一次即可生效。
 */

const MODIFIER_ALIASES = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
};

export function parseCombo(combo) {
  if (typeof combo !== 'string') return null;
  const parts = combo.split('+').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return null;
  const out = { ctrl: false, alt: false, shift: false, meta: false, key: '' };
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()];
    if (modifier) out[modifier] = true;
    else out.key = part;
  }
  return out.key ? out : null;
}

/** 浏览器给的 event.key 五花八门，统一一下再比。 */
export function normaliseKey(key) {
  const value = String(key ?? '');
  if (value === ' ' || value === 'Spacebar' || value === 'Space') return 'space';
  const alias = { Esc: 'escape', Return: 'enter', Del: 'delete', Left: 'arrowleft', Right: 'arrowright', Up: 'arrowup', Down: 'arrowdown' };
  if (alias[value]) return alias[value];
  return value.toLowerCase();
}

export function matchesCombo(event, combo) {
  const parsed = typeof combo === 'string' ? parseCombo(combo) : combo;
  if (!parsed || !event) return false;
  if (Boolean(event.ctrlKey) !== parsed.ctrl) return false;
  if (Boolean(event.altKey) !== parsed.alt) return false;
  if (Boolean(event.shiftKey) !== parsed.shift) return false;
  if (Boolean(event.metaKey) !== parsed.meta) return false;
  return normaliseKey(event.key) === normaliseKey(parsed.key);
}

/**
 * 登记一张 action → combo 表；`handle(event)` 命中就调对应处理器。
 * 处理器返回 false 表示"这次不处理"，继续往后找。
 */
export function createShortcutManager() {
  const bindings = new Map();

  function register(action, combo, handler) {
    if (!combo || !handler) bindings.delete(action);
    else bindings.set(action, { combo, handler });
    return manager;
  }

  function handle(event) {
    for (const { combo, handler } of bindings.values()) {
      if (!matchesCombo(event, combo)) continue;
      if (handler(event) !== false) return true;
    }
    return false;
  }

  function attach(target = window) {
    const listener = (event) => {
      if (handle(event)) event.preventDefault();
    };
    target.addEventListener('keydown', listener);
    return () => target.removeEventListener('keydown', listener);
  }

  const manager = { register, handle, attach, bindings };
  return manager;
}
