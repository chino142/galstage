/**
 * Galgame 板块 · 自定义前端。
 *
 * 一个入口：把你自己（或 AI 帮你写）的 HTML / CSS / JS 贴进来 —— 先点「审查」体检一遍，
 * 再点「运行」在沙箱里跑起来。这个板块按"你自己的代码"处理，权限全开：
 * 跳过静态检查、沙箱能力全给、允许加载外链图片 / 字体 / 音频。
 *
 * 隔离本身还在（沙箱 iframe + CSP + 宿主侧能力校验），只是不再拦你写的东西。
 */

import { h, statusChip } from '../core/dom.mjs';
import { get, post, put } from '../core/api.mjs';
import { panel, field, loading, errorBox } from '../ui/components.mjs';
import { toast, toastError } from '../ui/toast.mjs';
import { createCardSandbox } from '../ui/card-sandbox.mjs';

const PLACEHOLDER_HTML = '<div class="gl-stage">\n  <h2>我的 galgame 界面</h2>\n  <div id="line">（把这里换成你自己的界面）</div>\n  <button id="next" type="button">继续</button>\n</div>';
const PLACEHOLDER_CSS = '.gl-stage { font-family: system-ui, sans-serif; padding: 16px; color: var(--st-text, #1b1b1f); }\n.gl-stage h2 { margin: 0 0 8px; font-size: 16px; }\n#next { margin-top: 10px; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--st-border, #ccc); cursor: pointer; }';
const PLACEHOLDER_JS = "var line = document.getElementById('line');\nvar n = 0;\ndocument.getElementById('next').addEventListener('click', function () {\n  n += 1;\n  line.textContent = '第 ' + n + ' 句：故事继续。';\n});\nTavern.ready();";

const SEVERITY_LABEL = { error: '会报错', warn: '要留心', info: '提示' };

export function createGalgameFrontendView(module, ctx) {
  const el = h('div', { class: 'view' });
  const host = h('div', {});
  const state = { kit: null, capabilities: [], chats: [], chatId: '', review: null };

  const htmlInput = h('textarea', { rows: 8, class: 'mono', spellcheck: 'false' });
  const cssInput = h('textarea', { rows: 6, class: 'mono', spellcheck: 'false' });
  const jsInput = h('textarea', { rows: 10, class: 'mono', spellcheck: 'false' });
  const capsHost = h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } });
  const reviewHost = h('div', {});
  const previewHost = h('div', {});
  const saveStatus = h('span', { class: 'panel-note' }, '');
  const chatSelect = h('select', { onchange: (event) => { state.chatId = event.target.value; } });
  const promptSystem = h('textarea', { rows: 5, spellcheck: 'false' });
  const promptBefore = h('textarea', { rows: 3, spellcheck: 'false' });
  const promptAfter = h('textarea', { rows: 3, spellcheck: 'false' });

  const sandbox = createCardSandbox({ getChatId: () => state.chatId });

  el.append(
    panel(
      module.title,
      null,
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } }, statusChip(module.status), h('span', { class: 'panel-note' }, module.summary)),
    ),
    host,
  );

  function declaredCapabilities() {
    return [...(capsHost.querySelectorAll?.('input[type=checkbox]') ?? [])]
      .filter((input) => input.checked)
      .map((input) => input.dataset.capability);
  }

  function renderReview() {
    const result = state.review;
    if (!result) {
      reviewHost.replaceChildren(h('div', { class: 'panel-note' }, '点上面的「审查」，先把代码体检一遍再跑。'));
      return;
    }
    reviewHost.replaceChildren(
      h('div', { class: 'panel-note', style: { marginBottom: '8px' } }, `${result.ok ? '✅' : '⚠'} ${result.summary}`),
      ...result.issues.map((issue) =>
        h(
          'div',
          { class: 'reason-row' },
          h('span', { class: `chip small ${issue.severity === 'error' ? 'error' : 'partial'}` }, SEVERITY_LABEL[issue.severity] ?? issue.severity),
          h('span', { class: 'mono panel-note' }, `${issue.where ? `${issue.where} ` : ''}${issue.rule}`),
          h(
            'div',
            {},
            h('div', {}, issue.message),
            issue.hint ? h('div', { class: 'panel-note' }, `→ ${issue.hint}`) : null,
            issue.sample ? h('div', { class: 'mono panel-note' }, issue.sample) : null,
          ),
        ),
      ),
    );
  }

  async function doReview() {
    try {
      state.review = await post('/api/galgame/review', {
        html: htmlInput.value,
        css: cssInput.value,
        js: jsInput.value,
        capabilities: declaredCapabilities(),
      });
      renderReview();
      toast(state.review.ok ? '审查通过，可以跑了' : `查出 ${state.review.counts.error} 处会报错的问题`, {
        tone: state.review.ok ? 'info' : 'warn',
        duration: state.review.ok ? 2600 : 4200,
      });
    } catch (err) {
      toastError(err);
    }
  }

  async function doRun() {
    try {
      const rendered = await post('/api/galgame/render', {
        html: htmlInput.value,
        css: cssInput.value,
        js: jsInput.value,
        capabilities: declaredCapabilities(),
      });
      sandbox.mount(rendered);
      previewHost.replaceChildren(sandbox.el);
      toast('跑起来了（权限全开）');
    } catch (err) {
      toastError(err);
    }
  }

  async function doSave() {
    try {
      state.kit = await put('/api/galgame/kit', {
        frontend: {
          html: htmlInput.value,
          css: cssInput.value,
          js: jsInput.value,
          capabilities: declaredCapabilities(),
        },
        prompts: {
          system: promptSystem.value,
          beforeUser: promptBefore.value,
          afterUser: promptAfter.value,
        },
      });
      saveStatus.textContent = `已保存 · ${new Date().toLocaleTimeString()}`;
      toast('已保存');
    } catch (err) {
      toastError(err);
    }
  }

  /** 把这套提示词套到某个对话上（写进那条对话的提示词覆盖，对话页 ⚙ 里能看到）。 */
  async function applyPrompts() {
    if (!state.chatId) {
      toast('先在下面选一个对话', { tone: 'warn' });
      return;
    }
    if (!promptSystem.value.trim() && !promptBefore.value.trim() && !promptAfter.value.trim()) {
      toast('提示词都还空着', { tone: 'warn' });
      return;
    }
    try {
      const chat = await get(`/api/chats/${state.chatId}`);
      const settings = { ...(chat.settings ?? {}) };
      if (promptSystem.value.trim()) settings.cardSystemPrompt = promptSystem.value.trim();
      if (promptBefore.value.trim()) settings.prefixText = promptBefore.value.trim();
      if (promptAfter.value.trim()) settings.suffixText = promptAfter.value.trim();
      await put(`/api/chats/${state.chatId}`, { settings });
      toast('galgame 提示词已套到这个对话上（对话页 ⚙ 对话配置里能看到）');
    } catch (err) {
      toastError(err);
    }
  }

  async function mount() {
    host.replaceChildren(loading());
    try {
      const [kit, caps, chats] = await Promise.all([
        get('/api/galgame/kit'),
        get('/api/frontend/capabilities'),
        get('/api/chats').catch(() => ({ items: [] })),
      ]);
      state.kit = kit;
      state.capabilities = caps.items ?? [];
      state.chats = chats.items ?? [];

      const fe = kit.frontend ?? {};
      htmlInput.value = fe.html || PLACEHOLDER_HTML;
      cssInput.value = fe.css || PLACEHOLDER_CSS;
      jsInput.value = fe.js || PLACEHOLDER_JS;
      const saved = Array.isArray(fe.capabilities) ? fe.capabilities : [];
      // 第一次用（还没存过能力）：默认全勾 —— 这个板块就是"权限全开"
      const useAll = saved.length === 0;
      capsHost.replaceChildren(
        ...state.capabilities.map((cap) =>
          h(
            'label',
            { class: 'chip small', style: { display: 'inline-flex', gap: '4px', cursor: 'pointer' }, title: cap.risk === 'low' ? '低风险' : '中风险' },
            h('input', { type: 'checkbox', dataset: { capability: cap.id }, checked: useAll || saved.includes(cap.id) }),
            cap.title,
          ),
        ),
      );

      promptSystem.value = kit.prompts?.system ?? '';
      promptBefore.value = kit.prompts?.beforeUser ?? '';
      promptAfter.value = kit.prompts?.afterUser ?? '';
      chatSelect.replaceChildren(
        h('option', { value: '' }, state.chats.length ? '（选一个对话）' : '（还没有对话）'),
        ...state.chats.map((chat) => h('option', { value: chat.id }, chat.title)),
      );
      state.chatId = state.chats[0]?.id ?? '';
      chatSelect.value = state.chatId;

      renderReview();
      previewHost.replaceChildren(h('div', { class: 'panel-note' }, '点「运行」在这里预览。'));
      host.replaceChildren(
        panel(
          '代码',
          'HTML / CSS / JS',
          h('div', { class: 'panel-note' }, 'AI 写完先点「审查」——它会告诉你哪里会报错、哪里会被沙箱挡、哪句桥调用少了能力。'),
          field('HTML', htmlInput, '结构体。外链 <script src> / <link> 会被沙箱挡住，脚本请放 JS 那栏。'),
          field('CSS', cssInput),
          field('JS', jsInput, '可以用 Tavern.vars / charVars / messages / send / onTurn；脚本就绪后调一下 Tavern.ready()。'),
          h('div', { class: 'hint', style: { marginTop: '8px' } }, '这个界面要用到哪些能力（这个板块默认全给）：'),
          capsHost,
          h(
            'div',
            { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginTop: '10px' } },
            h('button', { class: 'btn primary', onclick: () => void doReview() }, '🔍 审查'),
            h('button', { class: 'btn', onclick: () => void doRun() }, '▶ 运行'),
            h('button', { class: 'btn', onclick: () => void doSave() }, '💾 保存这一套'),
            saveStatus,
          ),
        ),
        panel('审查结果', null, reviewHost),
        panel('沙箱预览', null, previewHost),
        panel(
          'galgame 提示词',
          '这个板块自带的一套',
          h('div', { class: 'panel-note' }, '想让 AI 按视觉小说的方式写（旁白 + 角色台词 + 每轮给几个选项），就写在这儿；点「套到这个对话上」会写进那条对话的提示词覆盖，只影响那一条对话。'),
          field('系统提示（盖过卡里的 system prompt）', promptSystem, '角色的说话方式、叙事口吻、格式要求都写这儿。'),
          field('前置词（拼在你这一句之前）', promptBefore, '每轮的即时要求，比如"用 galgame 格式回，最后给 3 个选项"。'),
          field('后置词（拼在你这一句之后）', promptAfter),
          h('div', { class: 'hint', style: { marginTop: '8px' } }, '套到哪个对话：'),
          h(
            'div',
            { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginTop: '6px' } },
            chatSelect,
            h('button', { class: 'btn', onclick: () => void applyPrompts() }, '套到这个对话上'),
          ),
        ),
      );
    } catch (err) {
      host.replaceChildren(panel('自定义前端', null, errorBox(err, { onRetry: () => mount() })));
    }
  }

  void ctx;
  return { el, mount };
}
