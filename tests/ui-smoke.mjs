/**
 * 前端冒烟（work/ 草稿区，不是交付物）。
 *
 * 本机浏览器权限被策略挡着点不了，所以用最小 DOM shim 把每个视图的
 * 工厂 + mount 真跑一遍：真的去请求临时服务上的接口，能抓出 import 错、
 * 字段名写错、mount 阶段抛异常这类问题（点不了界面至少证明它挂得上去）。
 *
 * 用法：node work/ui-smoke.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this._class = '';
    this._text = '';
  }

  get className() { return this._class; }
  set className(value) { this._class = String(value); }
  set innerHTML(value) { this._text = String(value); }
  get innerHTML() { return this._text; }
  get textContent() { return this._text; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get firstChild() { return this.children[0] ?? null; }

  get classList() {
    const self = this;
    const read = () => new Set(self._class.split(/\s+/).filter(Boolean));
    return {
      add: (...names) => { const set = read(); names.forEach((n) => set.add(n)); self._class = [...set].join(' '); },
      remove: (...names) => { const set = read(); names.forEach((n) => set.delete(n)); self._class = [...set].join(' '); },
      contains: (name) => read().has(name),
      toggle: (name, force) => {
        const set = read();
        const on = force === undefined ? !set.has(name) : Boolean(force);
        if (on) set.add(name); else set.delete(name);
        self._class = [...set].join(' ');
        return on;
      },
    };
  }

  append(...nodes) {
    for (const node of nodes.flat(Infinity)) {
      if (node === null || node === undefined || node === false) continue;
      this.children.push(node);
    }
    return this;
  }
  appendChild(node) { this.children.push(node); return node; }
  removeChild(node) { const i = this.children.indexOf(node); if (i >= 0) this.children.splice(i, 1); return node; }
  replaceChildren(...nodes) { this.children = []; return this.append(...nodes); }
  remove() { this.removed = true; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  getAttribute(key) { return this.attributes.get(key); }
  addEventListener() {}
  removeEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  click() {}
  focus() {}
  blur() {}
  scrollIntoView() {}
}

const byId = new Map();
globalThis.Node = El;
globalThis.document = {
  body: new El('body'),
  title: '',
  createElement: (tag) => new El(tag),
  createTextNode: (text) => { const node = new El('#text'); node.textContent = text; return node; },
  createDocumentFragment: () => new El('#fragment'),
  getElementById: (id) => { if (!byId.has(id)) byId.set(id, new El('div')); return byId.get(id); },
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
};
globalThis.window = {
  location: { hash: '', href: '' },
  history: { replaceState() {}, pushState() {} },
  addEventListener() {},
  open() {},
};
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.URL.createObjectURL ??= () => 'blob:stub';
globalThis.URL.revokeObjectURL ??= () => {};

const { startTavern } = await import('../server/index.mjs');
const silent = { info() {}, warn() {}, error() {}, debug() {}, setLevel() {} };
const dir = mkdtempSync(path.join(process.env.TEMP ?? process.cwd(), 'ui-smoke-'));
const tavern = await startTavern({ port: 0, host: '127.0.0.1', dataDir: dir, logger: silent });
const base = `http://127.0.0.1:${tavern.address.port}`;

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => (typeof input === 'string' && input.startsWith('/') ? realFetch(base + input, init) : realFetch(input, init));

const { VIEW_FACTORIES } = await import('../web/views/index.mjs');
const appData = await (await fetch('/api/app')).json();
const moduleById = new Map(appData.modules.map((mod) => [mod.id, mod]));

const results = [];
for (const [key, factory] of Object.entries(VIEW_FACTORIES)) {
  const moduleId = key.split(':')[0];
  const module = moduleById.get(moduleId) ?? { id: moduleId, title: key, summary: '', status: 'partial', web: { view: key } };
  const ctx = {
    appData,
    viewKey: key.includes(':') ? key.split(':')[1] : null,
    views: VIEW_FACTORIES,
    navigate() {},
    params: {},
    openTab() {},
    writeBoard: true,
  };
  try {
    const view = factory(module, ctx);
    if (typeof view?.mount === 'function') await view.mount();
    const nodes = view?.el?.children?.length ?? 0;
    results.push({ key, ok: true, nodes });
  } catch (err) {
    results.push({ key, ok: false, error: `${err?.name}: ${err?.message}` });
  }
}

// 写卡区：顶上一级只留「角色卡 / 写卡助手」两枚，没有二级标签；
// 跟一张卡相关的板块（卡库 / 编辑器 / 世界书 / 提示词 / 快照 / 记忆 / 向量 / 卡内前端）
// 全部摞在「角色卡」这一页里，滚一滚就都在。
try {
  const writingModule = moduleById.get('writing');
  const view = VIEW_FACTORIES.writing(writingModule, {
    appData,
    views: VIEW_FACTORIES,
    navigate() {},
    params: {},
    openTab() {},
  });
  await view.mount();
  const nodes = walk(view.el);
  const text = (node) =>
    (node.children ?? [])
      .map((child) => (child?.tagName === '#TEXT' ? child._text : text(child)))
      .join('');
  const rows = nodes.filter((node) => String(node.className).split(/\s+/).includes('tabs'));
  if (rows.length !== 1) throw new Error(`写卡区只该有一排标签，实际 ${rows.length} 排`);
  const top = rows[0].children.filter((node) => String(node.className).includes('tab')).map(text);
  if (top.join(',') !== '角色卡,写卡助手') throw new Error(`一级标签应只剩两枚，实际 ${top.join('/')}`);

  const sections = nodes
    .filter((node) => String(node.className).split(/\s+/).includes('work-section'))
    .map((node) => node.dataset?.section);
  const want = ['cards', 'editor', 'worldbook', 'prompts', 'xray', 'memory', 'vectors', 'frontend'];
  if (sections.join(',') !== want.join(',')) throw new Error(`角色卡这一页的板块不对：${sections.join('/')}`);
  // 每块都要真挂上视图（不是空壳）：里面至少有一个 .panel
  const empty = [];
  for (const section of nodes.filter((node) => String(node.className).split(/\s+/).includes('work-section'))) {
    if (!walk(section).some((node) => String(node.className).split(/\s+/).includes('panel'))) empty.push(section.dataset?.section);
  }
  if (empty.length) throw new Error(`这些板块没挂上界面：${empty.join('/')}`);

  // 折叠：每块头上一条栏，默认只把 X 光机 / 向量 / 卡内前端收起来
  const bars = nodes.filter((node) => String(node.className).split(/\s+/).includes('work-fold'));
  if (bars.length !== want.length) throw new Error(`折叠栏应有 ${want.length} 条，实际 ${bars.length}`);
  if (!bars.every((bar) => walk(bar).some((node) => String(node.className).includes('work-fold-caret')))) {
    throw new Error('折叠栏缺箭头');
  }
  const folded = nodes
    .filter((node) => String(node.className).split(/\s+/).includes('work-section'))
    .filter((node) => node.dataset?.folded === 'true')
    .map((node) => node.dataset?.section);
  if (folded.join(',') !== 'xray,vectors,frontend') throw new Error(`默认收起的板块不对：${folded.join('/')}`);
  results.push({ key: 'writing:one-page', ok: true, nodes: top.length + sections.length });
} catch (err) {
  results.push({ key: 'writing:one-page', ok: false, error: `${err?.name}: ${err?.message}` });
}

// 消息气泡里的出图（缩略图 / 进度 / 失败原因）。浏览器点不了，至少证明拼装不炸、
// 该有的节点都在（src 指向 /api/assets/:id/file，失败要带可读原因）。
function walk(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  out.push(node);
  for (const child of node.children ?? []) walk(child, out);
  return out;
}

try {
  const { messageBubble, messageImageIds, hasPendingRuns, truncatedByLimit } = await import('../web/views/playing-common.mjs');
  const bubble = messageBubble(
    { id: 'm1', role: 'assistant', name: '阿狸', content: '喵', extra: { images: ['ast_abc', { assetId: 'ast_def' }] } },
    {
      onAction() {},
      runs: [{ status: 'running', percent: 40, workflowName: '立绘' }, { status: 'error', error: 'ComfyUI 没启动：端口没人监听' }],
      onRunAction() {},
    },
  );
  const nodes = walk(bubble);
  const imgs = nodes.filter((node) => node.tagName === 'IMG');
  if (imgs.length !== 2) throw new Error(`期望 2 张缩略图，实际 ${imgs.length}`);
  if (!imgs.every((img) => String(img.getAttribute('src') ?? '').includes('/api/assets/'))) throw new Error('缩略图地址不对');
  if (!nodes.some((node) => String(node.className).includes('msg-run-error'))) throw new Error('出图失败要显示原因');
  if (messageImageIds({ extra: { images: ['a', { assetId: 'b' }] } }).join(',') !== 'a,b') throw new Error('messageImageIds 兼容两种写法');
  if (!hasPendingRuns([{ status: 'queued' }]) || hasPendingRuns([{ status: 'done' }])) throw new Error('hasPendingRuns 判断不对');

  // 被回复上限截断：三家写法不同，都要认出来，而且消息里要给出提示（以前完全没提示）
  if (!truncatedByLimit({ extra: { finish: 'length' } })) throw new Error('OpenAI 的 length 要认出来');
  if (!truncatedByLimit({ extra: { finish: 'MAX_TOKENS' } })) throw new Error('Gemini 的 MAX_TOKENS 要认出来');
  if (!truncatedByLimit({ extra: { finish: 'max_tokens' } })) throw new Error('Anthropic 的 max_tokens 要认出来');
  if (truncatedByLimit({ extra: { finish: 'stop' } }) || truncatedByLimit({})) throw new Error('正常结束不该报截断');
  const truncatedBubble = messageBubble(
    { id: 'm2', role: 'assistant', name: '阿狸', content: '话说到一半', extra: { finish: 'length' } },
    { onAction() {} },
  );
  const truncatedNodes = walk(truncatedBubble);
  if (!truncatedNodes.some((node) => String(node.className).includes('msg-warn'))) throw new Error('被截断要给出提示');

  // 点开大图走的是 modal：这里真的调一次，确认弹窗能拼出来
  const { openImageViewer } = await import('../web/views/playing-common.mjs');
  openImageViewer('ast_abc', { name: '大图' });
  results.push({ key: 'playing-common:message-images', ok: true, nodes: nodes.length });
} catch (err) {
  results.push({ key: 'playing-common:message-images', ok: false, error: `${err?.name}: ${err?.message}` });
}

// 命令面板（Ctrl/Cmd+K）与 i18n：真的建一次、开一次、关一次
try {
  const { createCommandPalette } = await import('../web/ui/command-palette.mjs');
  const { setLocale } = await import('../web/core/i18n.mjs');
  setLocale('en');
  const palette = createCommandPalette({ appData, onNavigate() {}, getTheme: () => 'dark' });
  palette.open();
  if (!palette.isOpen()) throw new Error('命令面板没打开');
  const items = palette.buildItems();
  if (!items.length) throw new Error('命令面板没有可选项');
  if (!items.some((item) => item.id.startsWith('module:'))) throw new Error('命令面板缺模块跳转');
  palette.close();
  if (palette.isOpen()) throw new Error('命令面板没关掉');
  setLocale('zh-CN');
  results.push({ key: 'ui:command-palette', ok: true, nodes: items.length });
} catch (err) {
  results.push({ key: 'ui:command-palette', ok: false, error: `${err?.name}: ${err?.message}` });
}

// 插件视图：契约是 (module, ctx) => ({ el, mount? })，这里真跑一遍示例插件的 view.mjs
try {
  const mod = await import('../tests/fixtures/plugins/hello/view.mjs');
  const view = mod.default({ title: 'Hello 插件' }, { ui: {} });
  if (!view?.el) throw new Error('插件视图没有返回 el');
  await view.mount?.();
  results.push({ key: 'plugin:hello-view', ok: true, nodes: view.el.children.length });
} catch (err) {
  results.push({ key: 'plugin:hello-view', ok: false, error: `${err?.name}: ${err?.message}` });
}

// ComfyUI 浏览器直连：对假的 ComfyUI 真跑一遍「提交 → WS 进度 → 取图 → 上传素材 → 绑消息」。
// 浏览器点检做不了，但原生 fetch + WebSocket 在 Node 里是同一套实现，能测到全流程。
try {
  const { createMockComfy } = await import('../tests/fixtures/mock-comfy-server.mjs');
  const { runClientImage } = await import('../web/ui/comfy-client.mjs');
  const comfy = createMockComfy({ latencyMs: 300 });
  await comfy.listen();
  const jsonHeaders = { 'Content-Type': 'application/json' };
  const chat = await (
    await fetch('/api/chats', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ title: '直连', character: { name: '阿狸', first_mes: '喵。' }, persona: { name: '我' } }) })
  ).json();
  const workflow = await (
    await fetch('/api/comfy/workflows', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        name: '立绘',
        kind: 'portrait',
        workflow: {
          3: { class_type: 'KSampler', inputs: { seed: 1, steps: 20, cfg: 7, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
          4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
          5: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 768, batch_size: 1 } },
          6: { class_type: 'CLIPTextEncode', inputs: { text: '{{char}}, 白狐，雪夜', clip: ['4', 1] } },
          7: { class_type: 'CLIPTextEncode', inputs: { text: 'lowres', clip: ['4', 1] } },
          9: { class_type: 'SaveImage', inputs: { filename_prefix: 'tavern', images: ['8', 0] } },
        },
      }),
    })
  ).json();
  const message = (await (await fetch(`/api/chats/${chat.id}/messages`)).json()).items[0];
  const run = await runClientImage({ baseUrl: comfy.url, workflowId: workflow.id, chatId: chat.id, messageId: message.id, reason: 'smoke' });
  if (run.status !== 'done') throw new Error(`浏览器直连没跑完：${run.error ?? run.status}`);
  if (!run.images?.length) throw new Error('没有图片进素材库');
  const after = (await (await fetch(`/api/chats/${chat.id}/messages`)).json()).items.find((item) => item.id === message.id);
  if (!after?.extra?.images?.includes(run.images[0].assetId)) throw new Error('图片没绑到那条消息');
  if (comfy.state.submitted.length !== 1) throw new Error('应该只向 ComfyUI 提交一次');
  await comfy.close();
  results.push({ key: 'comfy-client:direct-run', ok: true, nodes: run.images.length });
} catch (err) {
  results.push({ key: 'comfy-client:direct-run', ok: false, error: `${err?.name}: ${err?.message}` });
}

// 演出层加分项：有条对话时把舞台 + 转场 / BGM / CG 回廊 / 路线面板一起挂出来
try {
  const jsonHeaders = { 'Content-Type': 'application/json' };
  const chat = await (
    await fetch('/api/chats', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ title: '演出冒烟', character: { name: '阿狸', first_mes: '你来了。' }, persona: { name: '我' } }) })
  ).json();
  await fetch(`/api/state/${chat.id}`, { method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ worldState: { place: '旧书馆', affection: { 阿狸: 42 } } }) });
  const module = moduleById.get('performance') ?? { id: 'performance', title: '演出层', summary: '', status: 'partial', web: { view: 'performance' } };
  const view = VIEW_FACTORIES.performance(module, { appData, views: VIEW_FACTORIES, navigate() {} });
  await view.mount();
  const nodes = walk(view.el);
  const text = nodes.map((node) => String(node.textContent ?? '')).join(' ');
  if (!nodes.some((node) => String(node.className ?? '').includes('stage'))) throw new Error('没看到舞台');
  if (!text.includes('CG 回廊')) throw new Error('没看到 CG 回廊面板');
  if (!text.includes('好感度与路线')) throw new Error('没看到路线面板');
  if (!text.includes('BGM')) throw new Error('没看到 BGM 面板');
  results.push({ key: 'performance:extras', ok: true, nodes: nodes.length });
} catch (err) {
  results.push({ key: 'performance:extras', ok: false, error: `${err?.name}: ${err?.message}` });
}

// 工具箱加分项：批量表情 / 参考图 / 角色绑定三块面板要能挂出来
try {
  const module = moduleById.get('comfyui') ?? { id: 'comfyui', title: 'ComfyUI 接入', summary: '', status: 'partial', web: { view: 'comfyui' } };
  const view = VIEW_FACTORIES.comfyui(module, { appData, views: VIEW_FACTORIES, navigate() {} });
  await view.mount();
  const nodes = walk(view.el);
  const text = nodes.map((node) => String(node.textContent ?? '')).join(' ');
  if (!text.includes('出图加分项')) throw new Error('没看到加分项面板');
  if (!text.includes('批量表情差分')) throw new Error('没看到批量表情');
  if (!text.includes('图生图')) throw new Error('没看到参考图面板');
  if (!text.includes('角色绑定与表情包')) throw new Error('没看到角色绑定面板');
  results.push({ key: 'comfyui:extras', ok: true, nodes: nodes.length });
} catch (err) {
  results.push({ key: 'comfyui:extras', ok: false, error: `${err?.name}: ${err?.message}` });
}

// 叙事加分项：章节 / 结局收集 / 随机事件三块面板
try {
  const module = moduleById.get('narration') ?? { id: 'narration', title: '叙事控制', summary: '', status: 'partial', web: { view: 'narration' } };
  const view = VIEW_FACTORIES.narration(module, { appData, views: VIEW_FACTORIES, navigate() {} });
  await view.mount();
  const nodes = walk(view.el);
  const text = nodes.map((node) => String(node.textContent ?? '')).join(' ');
  if (!text.includes('章节管理')) throw new Error('没看到章节面板');
  if (!text.includes('结局收集')) throw new Error('没看到结局收集');
  if (!text.includes('随机事件')) throw new Error('没看到随机事件');
  results.push({ key: 'narration:extras', ok: true, nodes: nodes.length });
} catch (err) {
  results.push({ key: 'narration:extras', ok: false, error: `${err?.name}: ${err?.message}` });
}

// 写卡区加分项：卡编辑器里的剧本大纲 / 关系图 / BGM / 一致性锁定面板
try {
  const jsonHeaders = { 'Content-Type': 'application/json' };
  const card = await (
    await fetch('/api/characters', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ name: '加分项卡', description: '一只猫', personality: '安静' }) })
  ).json();
  const module = moduleById.get('card-editor') ?? { id: 'cards', title: '卡编辑器', summary: '', status: 'partial', web: { view: 'cards', }, };
  const view = VIEW_FACTORIES['cards:editor'](module, { appData, views: VIEW_FACTORIES, navigate() {}, params: { cardId: card.id } });
  await view.mount();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const nodes = walk(view.el);
  const text = nodes.map((node) => String(node.textContent ?? '')).join(' ');
  if (!text.includes('卡内加分项')) throw new Error('没看到卡内加分项面板');
  if (!text.includes('剧本大纲')) throw new Error('没看到剧本大纲');
  if (!text.includes('角色关系图')) throw new Error('没看到关系图');
  if (!text.includes('一致性锁定')) throw new Error('没看到一致性锁定');
  results.push({ key: 'card-editor:extras', ok: true, nodes: nodes.length });
} catch (err) {
  results.push({ key: 'card-editor:extras', ok: false, error: `${err?.name}: ${err?.message}` });
}

let failed = 0;
for (const item of results) {
  if (item.ok) console.log(`  ok  ${item.key} (${item.nodes} 个顶层节点)`);
  else { failed += 1; console.log(`FAIL  ${item.key}: ${item.error}`); }
}
console.log(`\n前端冒烟：${results.length - failed} 通过 / ${failed} 失败（共 ${results.length} 个视图）`);

await tavern.stop();
rmSync(dir, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
