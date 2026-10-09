/**
 * 卡内前端的宿主侧沙箱：渲染 iframe + postMessage 桥。
 *
 * 写卡区的「预览」和对话页的「卡内界面」都用这一份 —— 来源校验、能力校验、聊天数据读写
 * 只有一处实现。这是安全相关的代码，抄成两份就多一个漏的地方。
 *
 * 三道闸（缺一不可）：
 *   1) 只认自己那个 iframe 发来的消息（`event.source` 对得上）；
 *   2) 方法要在服务端给的 `methods` 表里，而且这张卡声明并拿到了那个能力；
 *   3) 读写都走接口，卡拿不到你的 DOM / cookie / localStorage（沙箱 iframe 是 opaque origin）。
 */

import { h } from '../core/dom.mjs';
import { get, post, put } from '../core/api.mjs';

export function createCardSandbox({ getChatId, frameHeight = 260 } = {}) {
  const host = h('div', { class: 'sandbox-host' });
  let frame = null;
  let handle = null;
  let methods = {};
  let granted = [];
  let chatCache = null;
  let height = Number(frameHeight) || 260;
  let followCard = true;
  let reportedHeight = 0;
  let heightSubscribers = [];

  const clampHeight = (px) => Math.max(96, Math.min(Number(px) || height, 6000));

  function applyHeight() {
    if (frame) frame.style.height = `${height}px`;
  }

  /** 用户手动定的高度：不再跟随卡片报的高度。 */
  function setHeight(px) {
    followCard = false;
    height = clampHeight(px);
    applyHeight();
    emitHeight();
  }

  /** 回到"卡片自己报高度"模式（没报过就用默认档）。 */
  function followCardHeight() {
    followCard = true;
    height = reportedHeight || (Number(frameHeight) || 260);
    applyHeight();
    emitHeight();
  }

  /** 卡片通过 ui.resize 报自然高度。只在跟随模式下生效。 */
  function onResizeReported(px) {
    reportedHeight = clampHeight(px);
    if (followCard) {
      height = reportedHeight;
      applyHeight();
    }
    emitHeight();
  }

  function emitHeight() {
    const snapshot = { height, followCard, reportedHeight };
    for (const fn of heightSubscribers) {
      try {
        fn(snapshot);
      } catch {
        // 订阅方的回调不该拖垮沙箱
      }
    }
  }

  function onChangeHeight(fn) {
    if (typeof fn === 'function') heightSubscribers.push(fn);
    return () => {
      heightSubscribers = heightSubscribers.filter((item) => item !== fn);
    };
  }

  /** 桥读写哪个对话：由宿主决定（写卡区=下拉选的；对话页=当前对话），卡内脚本说了不算。 */
  async function currentChat() {
    const chatId = getChatId?.();
    if (!chatId) throw new Error('先在前面选一个对话，卡界面才有地方读写');
    if (!chatCache || chatCache.id !== chatId) {
      const chat = await get(`/api/chats/${chatId}`);
      chatCache = { id: chatId, characterId: chat.characterId ?? '' };
    }
    return chatCache;
  }

  async function handleCall(method, payload = {}) {
    const chat = await currentChat();
    const chatId = chat.id;
    if (method === 'vars.get' || method === 'charVars.get') {
      const wanted = method === 'vars.get' ? 'chat' : 'character';
      const snapshot = await get(`/api/state/${chatId}`);
      const found = (snapshot.variables ?? []).find((item) => item.scope === wanted && item.key === payload.key);
      return found ? found.value : null;
    }
    if (method === 'vars.set') {
      await put(`/api/state/${chatId}`, { variables: [{ scope: 'chat', key: payload.key, value: payload.value }] });
      return true;
    }
    if (method === 'charVars.set') {
      await put(`/api/state/${chatId}`, {
        // 服务端按 scope 区分对话变量 / 角色变量；写成 n:'character' 会被当成对话变量落库，
        // 之后 charVars.get（读 scope==='character'）就再也读不回来。
        variables: [{ scope: 'character', characterId: chat.characterId, key: payload.key, value: payload.value }],
      });
      return true;
    }
    if (method === 'messages.list') {
      const messages = (await get(`/api/chats/${chatId}/messages`)).items ?? [];
      return messages
        .slice(-(Number(payload.limit) || 20))
        .map((message) => ({ role: message.role, name: message.name, content: message.content }));
    }
    if (method === 'chat.send') {
      await post(`/api/chats/${chatId}/send`, { text: String(payload.text ?? '') });
      return true;
    }
    throw new Error(`宿主没有实现方法：${method}`);
  }

  function onMessage(event) {
    const data = event?.data ?? {};
    if (data.source !== 'tavern-card') return;
    // 只认自己那个沙箱 iframe：别的窗口（或早就卸载的旧视图）postMessage 过来一概不理
    if (!frame || !frame.contentWindow || event.source !== frame.contentWindow) return;
    // ui.resize 不需要能力，也不带 id：卡片在报告自己的自然高度
    if (data.method === 'ui.resize') {
      const px = Number(data.payload?.height);
      if (Number.isFinite(px) && px > 0) onResizeReported(px);
      return;
    }
    if (!data.method || !data.id) return;
    const reply = (payload) => frame?.contentWindow?.postMessage?.({ source: 'tavern-host', id: data.id, ...payload }, '*');
    // 能力检查必须在宿主侧再挡一道：卡内脚本可以绕过它自己的 Tavern 存根，直接 postMessage 过来
    const needed = methods?.[data.method];
    if (!needed || !granted.includes(needed)) {
      reply({ error: `这张卡没有声明能力：${needed ?? data.method}` });
      return;
    }
    handleCall(data.method, data.payload)
      .then((result) => reply({ result }))
      .catch((err) => reply({ error: err?.message ?? String(err) }));
  }

  window.addEventListener('message', onMessage);

  /** 装上服务端渲染好的沙箱。`rendered` 就是 `/api/.../frontend` 或 `/api/frontend/render` 的结果。 */
  function mount(rendered) {
    chatCache = null;
    if (!rendered?.srcdoc) {
      clear();
      return false;
    }
    methods = rendered.methods ?? methods;
    granted = Array.isArray(rendered.capabilities) ? rendered.capabilities : [];
    reportedHeight = 0;
    frame = h('iframe', {
      class: 'sandbox-frame',
      sandbox: rendered.sandbox ?? 'allow-scripts',
      referrerpolicy: rendered.referrerPolicy ?? 'no-referrer',
      srcdoc: rendered.srcdoc,
      style: { width: '100%', height: `${height}px`, border: '1px dashed var(--st-border)', borderRadius: '10px', background: 'transparent' },
    });
    handle = h('div', {
      class: 'sandbox-resize-handle',
      title: '按住上下拖动调整高度',
    });
    host.replaceChildren(frame, handle);
    wireDrag(handle, frame);
    applyHeight();
    return true;
  }

  function clear() {
    frame = null;
    handle = null;
    chatCache = null;
    height = Number(frameHeight) || 260;
    followCard = true;
    reportedHeight = 0;
    host.replaceChildren();
  }

  /** 底部拖动条：按住上下拖 = 手动改高度（改完就不再跟随卡片）。 */
  function wireDrag(handleEl, frameEl) {
    handleEl.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      const startY = event.clientY;
      const startHeight = height;
      const move = (moveEvent) => {
        setHeight(startHeight + (moveEvent.clientY - startY));
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  /**
   * 给卡推一个事件（现在只有回合事件）。卡必须声明过 `turn.events` 才收得到。
   * 卡的 UI 一般靠它知道"这轮又长了新内容，该重新读一次变量 / 消息了"。
   */
  function notify(event, detail = {}) {
    const needed = methods?.['turn.on'];
    if (!needed || !granted.includes(needed)) return false;
    if (!frame?.contentWindow?.postMessage) return false;
    frame.contentWindow.postMessage({ source: 'tavern-host', event, detail }, '*');
    return true;
  }

  return {
    el: host,
    mount,
    clear,
    notify,
    setHeight,
    followCardHeight,
    onChangeHeight,
    state: () => ({ height, followCard, reportedHeight }),
    get mounted() {
      return Boolean(frame);
    },
  };
}
