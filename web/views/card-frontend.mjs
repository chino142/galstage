/**
 * 卡内前端（蓝图 1.3）：写 HTML / CSS / JS，声明要用的能力，校验后在沙箱里预览，
 * 并且可以**存到某张角色卡上** —— 存进卡数据，导出 PNG / JSON 时一起带走，
 * 玩卡区打开这张卡的对话时会自动用它（自己的卡自动跑，别人的卡要你点一下）。
 *
 * 边界（core/frontend/service.mjs 的 SANDBOX_POLICY）：
 *   iframe sandbox="allow-scripts"（没有 same-origin）+ 一张只允许内联脚本的 CSP，
 *   脚本只能通过 postMessage 桥调被声明的能力。宿主侧的桥在 web/ui/card-sandbox.mjs。
 */

import { h, statusChip } from '../core/dom.mjs';
import { get, post, del, streamPost } from '../core/api.mjs';
import { panel, field, errorBox, loading } from '../ui/components.mjs';
import { toast, toastError } from '../ui/toast.mjs';
import { createCardSandbox } from '../ui/card-sandbox.mjs';
import { confirmDialog } from '../ui/modal.mjs';

const DEFAULT_HTML = '<div class="card-box">\n  <h3>角色状态栏</h3>\n  <div id="mood">心情：—</div>\n</div>';
const DEFAULT_CSS = '.card-box { padding: 12px; border: 1px solid var(--st-border, #333); border-radius: 10px; }\n#mood { margin-top: 6px; color: var(--st-accent, #a78bfa); }';
const DEFAULT_JS = "Tavern.vars.get('mood').then(function (value) {\n  document.getElementById('mood').textContent = '心情：' + (value ?? '未知');\n}).catch(function (err) {\n  console.warn(err.message);\n});\nTavern.ready();";

export function createCardFrontendView(module, ctx) {
  const el = h('div', { class: 'view' });
  const host = h('div', {});
  const state = {
    capabilities: [],
    chats: [],
    chatId: '',
    issues: [],
    rendered: null,
    policy: null,
    tokens: [],
    themes: [],
    snippets: [],
    activeSnippetId: null,
    cards: [],
    cardId: '',
    cardFrontend: null,
  };

  const htmlInput = h('textarea', { rows: 6, value: DEFAULT_HTML });
  const cssInput = h('textarea', { rows: 5, value: DEFAULT_CSS });
  const jsInput = h('textarea', { rows: 8, value: DEFAULT_JS });
  const capsHost = h('div', { class: 'chip-row', style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } });
  const chatSelect = h('select', { onchange: (event) => { state.chatId = event.target.value; } });
  const issueHost = h('div', {});
  const previewHost = h('div', {});
  const cardHost = h('div', {});

  // 宿主侧沙箱：渲染 + 桥。跟对话页共用同一份实现（web/ui/card-sandbox.mjs）。
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
    return [...capsHost.querySelectorAll?.('input[type=checkbox]') ?? []]
      .filter((input) => input.checked)
      .map((input) => input.dataset.capability);
  }

  function renderIssues() {
    if (!state.issues.length) {
      issueHost.replaceChildren(h('div', { class: 'panel-note' }, '没有发现问题。'));
      return;
    }
    issueHost.replaceChildren(
      ...state.issues.map((issue) =>
        h(
          'div',
          { class: 'reason-row' },
          h('span', { class: `chip small ${issue.severity === 'error' ? 'error' : 'partial'}` }, issue.severity === 'error' ? '禁止' : '提示'),
          h('span', { class: 'mono panel-note' }, issue.rule),
          h('span', {}, issue.message),
          issue.sample ? h('span', { class: 'mono panel-note' }, issue.sample) : null,
        ),
      ),
    );
  }

  function renderPreview(result) {
    if (!result) {
      sandbox.clear();
      previewHost.replaceChildren(h('div', { class: 'panel-note' }, '点「校验并预览」试试。'));
      return;
    }
    sandbox.mount(result);
    previewHost.replaceChildren(
      h('div', { class: 'panel-note' }, `sandbox="${result.sandbox}" · CSP：${result.csp}${result.lintSkipped ? ' · 静态检查已跳过（你自己的卡）' : ''}`),
      sandbox.el,
    );
  }

  async function validateAndPreview() {
    try {
      const payload = {
        html: htmlInput.value,
        css: cssInput.value,
        js: jsInput.value,
        capabilities: declaredCapabilities(),
        // 带卡 id：服务端按"这张卡是谁的 / 你信不信这段代码"决定要不要跳过静态检查
        characterId: state.cardId || undefined,
      };
      const check = await post('/api/frontend/validate', payload);
      state.issues = check.issues ?? [];
      renderIssues();
      // 存到卡上时由服务端按"这张卡是谁的"决定拦不拦；这里预览先按当前卡自己的档走
      const strict = state.cardFrontend ? !state.cardFrontend.policy.trusted : true;
      if (!check.ok && strict) {
        toast(`有 ${check.errors} 处违反沙箱边界，先改掉`, { tone: 'warn', duration: 4200 });
        return;
      }
      state.rendered = await post('/api/frontend/render', payload);
      renderPreview(state.rendered);
      toast(check.ok ? '在沙箱里跑起来了' : `跑起来了（跳过 ${check.errors} 处静态检查）`);
    } catch (err) {
      toastError(err);
    }
  }

  // ---------------------------------------------------------------- 存到哪张卡上（跟着卡走）

  const cardSelect = h('select', {
    onchange: (event) => {
      state.cardId = event.target.value;
      void loadCardFrontend();
    },
  });
  const cardStatus = h('div', { class: 'panel-note' }, '');
  // 资源本地化的进度行：抓 98 张图要一两分钟，没进度就是在干瞪眼。
  const localiseStatus = h('div', { class: 'hint', style: { marginTop: '6px' } }, '');

  function applyCode(code = {}, capabilities = []) {
    htmlInput.value = code.html ?? '';
    cssInput.value = code.css ?? '';
    jsInput.value = code.js ?? '';
    for (const box of capsHost.querySelectorAll?.('input[type=checkbox]') ?? []) {
      box.checked = capabilities.includes(box.dataset.capability);
    }
  }

  function renderCardStatus() {
    const data = state.cardFrontend;
    if (!data) {
      cardStatus.replaceChildren('没有选卡：下面的代码只是草稿，不会跟着任何卡走。');
      return;
    }
    cardStatus.replaceChildren(
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
        h('span', { class: `chip small ${data.policy.trusted ? 'ready' : 'partial'}` }, data.policy.trusted ? '已信任（打开对话就跑）' : '未信任（打开对话要你点一下）'),
        h('span', { class: 'mono panel-note' }, `指纹 ${String(data.codeHash).slice(0, 8)}`),
      ),
      h('div', { class: 'hint', style: { marginTop: '6px' } }, `${data.policy.title}：${data.policy.reason}`),
      h(
        'div',
        { class: 'hint', style: { marginTop: '4px' } },
        data.policy.allowExternalAssets
          ? '外部资源：允许 —— CSP 放开了图片 / 字体 / 音视频 / 样式表的外链，可以直接贴图床 URL，也可以贴 ComfyUI 出的图地址。'
          : '外部资源：已拦截 —— CSP 只放行 data: / blob:。导入的卡点过「信任这张卡」之后会自动放开。',
      ),
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' } },
        h('button', { class: 'btn primary', onclick: () => saveToCard() }, '存到这张卡'),
        data.policy.trustedByUser
          ? h('button', {
              class: 'btn',
              onclick: async () => {
                try {
                  state.cardFrontend = await del(`/api/characters/${encodeURIComponent(state.cardId)}/frontend/trust`);
                  renderCardStatus();
                  toast('已取消信任');
                } catch (err) {
                  toastError(err);
                }
              },
            }, '取消信任')
          : h('button', {
              class: 'btn',
              onclick: async () => {
                try {
                  state.cardFrontend = await post(`/api/characters/${encodeURIComponent(state.cardId)}/frontend/trust`, {});
                  renderCardStatus();
                  toast('已信任这张卡的当前代码（改了代码会自动失效）');
                } catch (err) {
                  toastError(err);
                }
              },
            }, '信任这张卡'),
        h('button', { class: 'btn', onclick: () => void localiseAssets() }, '把外链抓进本地'),
      ),
      localiseStatus,
    );
  }

  /**
   * 把代码里的外链资源抓下来存进素材库，再把 URL 换成本地地址。
   * 走 SSE：98 张图要一两分钟，进度得能看见。
   */
  async function localiseAssets() {
    if (!state.cardId) {
      toast('先选一张卡，本地化是改这张卡上的代码', { tone: 'warn' });
      return;
    }
    const answer = await confirmDialog({
      title: '把外链资源抓进本地',
      message: '代码里所有 http(s) 资源会被抓下来存进素材库，然后把 URL 换成本地地址。'
        + '\n\n好处：图床挂了、ComfyUI 输出被清了都不怕，请求也不再出网。'
        + '\n注意：会用掉磁盘空间（有张 98 张图的卡大概 90 MB）；改完代码后信任会失效，要重新点一次「信任这张卡」。',
      confirmLabel: '开始抓',
    });
    if (!answer) return;

    localiseStatus.textContent = '正在读取外链清单…';
    let ok = 0;
    let fail = 0;
    try {
      await streamPost(`/api/characters/${encodeURIComponent(state.cardId)}/frontend/localise`, {}, (event, data) => {
        if (event === 'start') {
          localiseStatus.textContent = data.total
            ? `共 ${data.total} 条外链，开始抓…`
            : '这段代码里没有外链。';
        } else if (event === 'item') {
          if (data.ok) ok++;
          else fail++;
          localiseStatus.textContent = `第 ${data.done}/${data.total} 条 ${data.ok ? '✓' : '✗'} ${fail ? `（失败 ${fail}）` : ''}`;
        } else if (event === 'done') {
          const mb = (Number(data.bytes ?? 0) / 1048576).toFixed(1);
          localiseStatus.textContent = data.total
            ? `抓完：成功 ${data.downloaded} 条 / 失败 ${data.failed.length} 条，共 ${mb} MB${data.saved ? '，代码已改并写回卡里' : '，代码没有写回（见下）'}`
            : '这段代码里没有外链。';
          if (data.failed.length) {
            localiseStatus.textContent += `；失败示例：${data.failed[0].url.slice(0, 60)}（${data.failed[0].reason}）`;
          }
          if (data.note) toast(data.note, { tone: 'warn', duration: 5000 });
          if (data.trustInvalidated) toast('代码改过了，信任已失效，要重新点一次「信任这张卡」', { tone: 'warn', duration: 6000 });
          if (data.downloaded) toast(`本地化完成：${data.downloaded} 条资源已存进素材库`);
        } else if (event === 'error') {
          toastError(new Error(data.message ?? '本地化失败'));
        }
      });
    } catch (err) {
      toastError(err);
      localiseStatus.textContent = '';
      return;
    }
    // 抓完要重新拉一次卡上的代码，界面上才是改写后的版本
    await loadCardFrontend();
    renderCardStatus();
  }

  async function saveToCard() {
    if (!state.cardId) {
      toast('先选一张角色卡', { tone: 'warn' });
      return;
    }
    try {
      state.cardFrontend = await post(`/api/characters/${encodeURIComponent(state.cardId)}/frontend`, {
        html: htmlInput.value,
        css: cssInput.value,
        js: jsInput.value,
        capabilities: declaredCapabilities(),
      });
      applyCode(state.cardFrontend.code, state.cardFrontend.code.capabilities);
      state.issues = state.cardFrontend.validation.issues ?? [];
      renderIssues();
      renderCardStatus();
      toast('已存到卡上：导出这张卡时界面代码会一起走');
    } catch (err) {
      toastError(err);
    }
  }

  async function loadCardFrontend() {
    if (!state.cardId) {
      state.cardFrontend = null;
      renderCardStatus();
      return;
    }
    try {
      const data = await get(`/api/characters/${encodeURIComponent(state.cardId)}/frontend`);
      state.cardFrontend = data;
      if (data.hasCode) applyCode(data.code, data.code.capabilities);
      state.issues = data.validation.issues ?? [];
      renderIssues();
      renderCardStatus();
    } catch (err) {
      toastError(err);
    }
  }

  async function refreshCards() {
    const list = await get('/api/characters?limit=200').catch(() => ({ items: [] }));
    state.cards = list.items ?? [];
    cardSelect.replaceChildren(
      h('option', { value: '' }, state.cards.length ? '（先选一张卡）' : '（卡库是空的：先去「角色卡」新建一张）'),
      ...state.cards.map((card) => h('option', { value: card.id }, `${card.name}（${card.source === 'original' ? '自己的卡' : '导入的'}）`)),
    );
    cardSelect.value = state.cardId;
  }

  // ---------------------------------------------------------------- 主题保存 / 代码持久化（蓝图 1.3 剩余部分）

  const themeListHost = h('div', {});
  const snippetListHost = h('div', {});
  const snippetName = h('input', { placeholder: '片段名字，比如 阿狸的状态栏' });
  const snippetScope = h('input', { placeholder: 'scope：角色卡 id 或 global（留空 = global）' });

  function applyTokens(tokens = {}) {
    for (const [key, value] of Object.entries(tokens)) {
      document?.documentElement?.style?.setProperty?.(key, value);
    }
  }

  function themePanel() {
    const nameInput = h('input', { placeholder: '主题名字，比如 雪夜紫' });
    const inputs = state.tokens.map((token) => {
      const input = h('input', { type: String(token.default).startsWith('#') ? 'color' : 'text' });
      input.value = token.default;
      input.dataset.token = token.id;
      input.dataset.label = token.label;
      return field(`${token.label}（${token.id}）`, input);
    });
    const readTokens = () => {
      const tokens = {};
      for (const input of inputs) tokens[input.dataset.token] = input.value;
      return tokens;
    };
    async function saveTheme() {
      try {
        const saved = await post('/api/frontend/themes', { name: nameInput.value.trim() || '自定义主题', tokens: readTokens() });
        state.themes = (await get('/api/frontend/themes')).items ?? [];
        renderThemeList();
        toast(`主题已保存：${saved.name}`);
      } catch (err) {
        toastError(err);
      }
    }
    return panel(
      '全局主题',
      `${state.themes.length} 个`,
      h('div', { class: 'hint' }, '改 CSS 变量、起个名字保存；「试一下」会立刻套用到当前界面。'),
      h('div', { class: 'grid-2' }, ...inputs),
      field('主题名', nameInput),
      h(
        'div',
        { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' } },
        h('button', { class: 'btn primary', onclick: () => saveTheme() }, '保存主题'),
        h('button', { class: 'btn', onclick: () => applyTokens(readTokens()) }, '试一下'),
      ),
      themeListHost,
    );
  }

  function renderThemeList() {
    const custom = state.themes.filter((theme) => !theme.builtin);
    themeListHost.replaceChildren(
      h('div', { class: 'hint', style: { marginTop: '10px' } }, custom.length ? '已保存的主题：' : '还没有保存过主题。'),
      ...custom.map((theme) =>
        h(
          'div',
          { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '4px' } },
          h('span', {}, theme.name),
          h('button', { class: 'btn', onclick: () => { applyTokens(theme.tokens); toast(`已应用：${theme.name}`); } }, '应用'),
          h('button', {
            class: 'link-btn',
            onclick: async () => {
              await del(`/api/frontend/themes/${encodeURIComponent(theme.id)}`);
              state.themes = (await get('/api/frontend/themes')).items ?? [];
              renderThemeList();
            },
          }, '删掉'),
        ),
      ),
    );
  }

  function snippetPanel() {
    async function refreshList() {
      state.snippets = (await get('/api/frontend/snippets')).items ?? [];
      renderSnippetList();
    }
    return panel(
      '卡内代码持久化',
      `${state.snippets.length} 个片段`,
      h('div', { class: 'hint' }, '把当前 HTML / CSS / JS 存下来；同一个 scope 的片段可以随角色卡走。'),
      field('片段名', snippetName),
      field('scope', snippetScope, '角色卡 id / 对话 id / global'),
      h(
        'div',
        { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        h('button', {
          class: 'btn primary',
          onclick: async () => {
            try {
              const saved = await post('/api/frontend/snippets', {
                id: state.activeSnippetId ?? undefined,
                name: snippetName.value.trim() || '未命名片段',
                scope: snippetScope.value.trim() || 'global',
                html: htmlInput.value,
                css: cssInput.value,
                js: jsInput.value,
                capabilities: declaredCapabilities(),
              });
              state.activeSnippetId = saved.id;
              await refreshList();
              toast(`片段已保存：${saved.name}`);
            } catch (err) {
              toastError(err);
            }
          },
        }, '保存当前代码'),
        h('button', { class: 'btn', onclick: () => { state.activeSnippetId = null; snippetName.value = ''; snippetScope.value = ''; toast('已新开一份（下次保存会新建）'); } }, '新建一份'),
      ),
      snippetListHost,
    );
  }

  function renderSnippetList() {
    snippetListHost.replaceChildren(
      h('div', { class: 'hint', style: { marginTop: '10px' } }, state.snippets.length ? '已保存的片段：' : '还没有保存过片段。'),
      ...state.snippets.map((snippet) =>
        h(
          'div',
          { class: 'tile', style: { marginTop: '6px' } },
          h('div', { class: 'tile-title' }, snippet.name, h('span', { class: 'chip partial' }, snippet.scope || 'global')),
          h(
            'div',
            { style: { display: 'flex', gap: '8px', marginTop: '6px' } },
            h('button', {
              class: 'btn',
              onclick: () => {
                htmlInput.value = snippet.html ?? '';
                cssInput.value = snippet.css ?? '';
                jsInput.value = snippet.js ?? '';
                state.activeSnippetId = snippet.id;
                snippetName.value = snippet.name ?? '';
                snippetScope.value = snippet.scope ?? '';
                for (const box of capsHost.querySelectorAll?.('input[type=checkbox]') ?? []) {
                  box.checked = (snippet.capabilities ?? []).includes(box.dataset.capability);
                }
                toast(`已载入：${snippet.name}`);
              },
            }, '载入'),
            h('button', {
              class: 'link-btn',
              onclick: async () => {
                await del(`/api/frontend/snippets/${encodeURIComponent(snippet.id)}`);
                if (state.activeSnippetId === snippet.id) state.activeSnippetId = null;
                state.snippets = (await get('/api/frontend/snippets')).items ?? [];
                renderSnippetList();
              },
            }, '删掉'),
          ),
        ),
      ),
    );
  }

  async function mount() {
    host.replaceChildren(loading());
    try {
      const [caps, chats, policy, tokenData, themes, snippets, cards] = await Promise.all([
        get('/api/frontend/capabilities'),
        get('/api/chats').catch(() => ({ items: [] })),
        get('/api/frontend/policy'),
        get('/api/frontend/theme-tokens').catch(() => ({ items: [] })),
        get('/api/frontend/themes').catch(() => ({ items: [] })),
        get('/api/frontend/snippets').catch(() => ({ items: [] })),
        get('/api/characters?limit=200').catch(() => ({ items: [] })),
      ]);
      state.capabilities = caps.items ?? [];
      state.chats = chats.items ?? [];
      state.policy = policy;
      state.tokens = tokenData.items ?? [];
      state.themes = themes.items ?? [];
      state.snippets = snippets.items ?? [];
      state.cards = cards.items ?? [];
      state.cardId = state.cards[0]?.id ?? '';
      state.chatId = state.chats[0]?.id ?? '';
      chatSelect.replaceChildren(
        state.chats.length ? state.chats.map((chat) => h('option', { value: chat.id }, chat.title)) : h('option', { value: '' }, '（还没有对话）'),
      );
      capsHost.replaceChildren(
        ...state.capabilities.map((cap) =>
          h(
            'label',
            { class: 'chip small', style: { display: 'inline-flex', gap: '4px', cursor: 'pointer' } },
            h('input', { type: 'checkbox', dataset: { capability: cap.id } }),
            `${cap.title}（${cap.risk === 'low' ? '低风险' : '中风险'}）`,
          ),
        ),
      );
      renderIssues();
      renderPreview(null);
      host.replaceChildren(
        panel(
          '存到哪张卡上',
          '界面代码跟着卡走',
          h('div', { class: 'panel-note' }, '存到卡上之后，玩卡区打开这张卡的对话时会带上它：自己的卡自动跑，导入的卡默认要你点一下（可以「信任这张卡」，信任绑在这段代码的指纹上，改了代码就失效）。导出 PNG / JSON 时界面代码一起走。'),
          h('div', { style: { marginTop: '10px' } }, field('角色卡', cardSelect)),
          cardStatus,
        ),
        panel(
          '能力边界',
          '先定死再写代码',
          h('div', { class: 'panel-note' }, `iframe sandbox="${state.policy?.iframe?.sandbox ?? 'allow-scripts'}"；脚本永远不能联网（connect-src 'none'），只能通过 postMessage 桥调下面声明过的能力；外部图片 / 字体 / 音视频只在「自己的卡」或「信任过的卡」上放行。`),
          h('div', { style: { marginTop: '10px' } }, field('预览用的对话（桥读写它）', chatSelect)),
          h('div', { style: { marginTop: '10px' } }, h('div', { class: 'hint' }, '声明这张卡要用的能力：'), capsHost),
        ),
        panel(
          '代码',
          'HTML / CSS / JS',
          field('HTML', htmlInput, '直接写结构体，不能引入外部脚本'),
          field('CSS', cssInput),
          field('JS', jsInput, '用 Tavern.vars.get / messages.list / send 这些桥方法'),
          h(
            'div',
            { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            h('button', { class: 'btn primary', onclick: () => validateAndPreview() }, '校验并预览'),
            h('button', { class: 'btn', onclick: () => { state.issues = []; state.rendered = null; renderIssues(); renderPreview(null); } }, '清空结果'),
          ),
        ),
        panel('校验结果', null, issueHost),
        panel('沙箱预览', null, previewHost),
        themePanel(),
        snippetPanel(),
      );
      renderThemeList();
      renderSnippetList();
      await refreshCards();
      await loadCardFrontend();
    } catch (err) {
      host.replaceChildren(panel('卡内前端', null, errorBox(err, { onRetry: () => mount() })));
    }
  }

  void ctx;
  return { el, mount };
}
