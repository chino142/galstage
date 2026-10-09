/**
 * 模块（Mod）管理器：挂哪些、编辑、信任。
 *
 * 那套玩法的核心是"卡是骨架、功能靠模块补"——别人的卡缺总结/缺选项，就去模块库里找一个装上。
 * 一个模块 = 一句话说明 + 提示词 + 可选 CSS / HTML / JS，
 * 还能带三样零件：世界书条目 / 正则脚本 / 背景图：
 *   · 提示词按位置插（系统提示里 / 用户输入前后 / 历史之后）
 *   · 只带 CSS 的模块，样式直接进聊天页（别人的会自动收进消息区）
 *   · 带 HTML/JS 的模块，整块跑在沙箱 iframe 里（脚本永远不进主页面）
 *   · 世界书条目跟着这一轮一起触发；正则脚本并进这一轮的正则链（别人的要信任过才跑）；背景图铺在消息区后面
 *
 * 底部三个按钮：导出（一个 JSON 文件）/ 导入（别人的模块）/ 存为模块（把当前对话的配置存下来）。
 * 限制规则在服务端（core/prompts/module-css.mjs、modules.mjs），这里只负责让你看得见、点得动。
 */

import { h } from '../core/dom.mjs';
import { get, post, put, del } from '../core/api.mjs';
import { openModal, confirmDialog } from './modal.mjs';
import { field } from './components.mjs';
import { toast, toastError } from './toast.mjs';

export const MODULE_POSITION_LABELS = {
  system: '系统提示里',
  'before-user': '用户输入之前',
  'after-user': '用户输入之后',
  'after-history': '历史之后',
};

function sourceChip(module) {
  const mine = (module.source ?? 'original') !== 'imported';
  return h(
    'span',
    { class: `chip small ${mine ? 'ready' : 'partial'}` },
    mine ? '自己写的' : (module.tier?.trusted ? '别人的·已信任' : '别人的·受限'),
  );
}

/** 把一个模块导出成 JSON 文件（七样零件全在里面，别人拿走能直接导入）。 */
async function downloadModule(module) {
  const doc = await get(`/api/prompts/snippets/${module.id}/export`);
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: `${module.title || 'module'}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** 挂载/卸载：改的是对话上的 settings.modules */
export async function openModuleManager({ chatId, onChange = null } = {}) {
  let list;
  let chatModules;
  let positions;
  try {
    [list, positions, chatModules] = await Promise.all([
      get('/api/prompts/snippets'),
      get('/api/prompts/module-positions'),
      get(`/api/chats/${chatId}/modules`),
    ]);
  } catch (err) {
    toastError(err);
    return;
  }

  const attached = new Set(chatModules.attachedIds ?? []);
  const body = h('div', { style: { minWidth: 'min(560px, 80vw)' } });

  // 导入：选一个别人给的模块 JSON
  const importInput = h('input', {
    type: 'file',
    accept: '.json,application/json',
    style: { display: 'none' },
    onchange: async () => {
      const file = importInput.files?.[0];
      importInput.value = '';
      if (!file) return;
      try {
        const document = JSON.parse(await file.text());
        const created = await post('/api/prompts/snippets/import', { document });
        toast(`导入了模块「${created.title}」（别人的模块：样式收进消息区，脚本要信任）`);
        list = await get('/api/prompts/snippets');
        render();
      } catch (err) {
        toastError(err);
      }
    },
  });

  /** 「存为模块」：把当前对话的对话级配置（提示词 / 前置词 / 后置词）存成一个模块。 */
  const saveAsModule = async () => {
    try {
      const created = await post('/api/prompts/snippets/from-chat', { chatId });
      toast(`存成模块「${created.title}」了：想用就在上面勾上它`);
      list = await get('/api/prompts/snippets');
      render();
    } catch (err) {
      toastError(err);
    }
  };

  const save = async (ids) => {
    await put(`/api/chats/${chatId}/modules`, { ids });
    attached.clear();
    for (const id of ids) attached.add(id);
    await onChange?.();
  };

  const render = () => {
    const rows = (list.items ?? []).map((module) => {
      const box = h('input', {
        type: 'checkbox',
        checked: attached.has(module.id),
        onchange: async (event) => {
          const ids = new Set(attached);
          if (event.target.checked) ids.add(module.id);
          else ids.delete(module.id);
          try {
            await save([...ids]);
            toast(event.target.checked ? `挂上了「${module.title}」` : `摘掉了「${module.title}」`);
          } catch (err) {
            event.target.checked = !event.target.checked;
            toastError(err);
          }
        },
      });
      return h(
        'div',
        { class: 'tile', style: { marginTop: '8px' } },
        h(
          'div',
          { class: 'tile-title', style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          box,
          h('span', {}, module.title),
          sourceChip(module),
          h('span', { class: 'chip partial' }, MODULE_POSITION_LABELS[module.position] ?? module.position),
          (module.html || module.js) ? h('span', { class: 'chip stub' }, '带面板') : null,
          (module.worldbook ?? []).length ? h('span', { class: 'chip stub' }, `世界书 ${module.worldbook.length} 条`) : null,
          (module.regex ?? []).length ? h('span', { class: 'chip stub' }, `正则 ${module.regex.length} 条`) : null,
          module.background ? h('span', { class: 'chip stub' }, '带背景图') : null,
        ),
        module.description ? h('div', { class: 'hint', style: { marginTop: '2px' } }, module.description) : null,
        h(
          'div',
          { style: { display: 'flex', gap: '8px', marginTop: '6px', flexWrap: 'wrap' } },
          h('button', {
            class: 'link-btn',
            onclick: () => openModuleEditor({
              module,
              onSaved: async () => {
                list = await get('/api/prompts/snippets');
                render();
                await onChange?.();
              },
            }),
          }, '编辑'),
          h('button', {
            class: 'link-btn',
            title: '导出一个 JSON：七样零件都在里面，别人拿去「导入模块」就能用',
            onclick: () => downloadModule(module).catch(toastError),
          }, '导出'),
          (module.source ?? 'original') === 'imported'
            ? h('button', {
                class: 'link-btn',
                onclick: async () => {
                  try {
                    await post(`/api/prompts/snippets/${module.id}/trust`, {});
                    toast('已信任这个模块：样式不再收进消息区，脚本也会跑起来');
                    list = await get('/api/prompts/snippets');
                    render();
                    await onChange?.();
                  } catch (err) {
                    toastError(err);
                  }
                },
              }, '信任它（放开限制）')
            : null,
          h('button', {
            class: 'link-btn',
            onclick: async () => {
              const yes = await confirmDialog({ title: `删除模块「${module.title}」？`, message: '删了就没了（用到它的对话会自动摘掉）。', confirmLabel: '删除' });
              if (!yes) return;
              try {
                await del(`/api/prompts/snippets/${module.id}`);
                await save([...attached].filter((id) => id !== module.id));
                list = await get('/api/prompts/snippets');
                render();
              } catch (err) {
                toastError(err);
              }
            },
          }, '删除'),
        ),
      );
    });

    body.replaceChildren(
      h('div', { class: 'panel-note' },
        '模块 = 一个功能零件（总结 / 选项 / 记忆区 / 美化…），可以同时挂好几个：提示词、CSS、HTML/JS，'
        + '另外还能带世界书条目、正则脚本和背景图。自己写的模块样式能改整个聊天页；'
        + '别人的会被收进消息区，点「信任它」才放开脚本与正则。'),
      h('div', { class: 'hint', style: { marginTop: '8px' } },
        (list.items ?? []).length ? `共 ${list.items.length} 个模块，挂了 ${attached.size} 个` : '还没有模块，先新建一个。'),
      importInput,
      ...rows,
    );
  };

  render();
  openModal({
    title: '模块',
    body,
    actions: [
      { label: '⬆ 导入模块', onClick: () => { importInput.click(); return false; } },
      { label: '存为模块', onClick: () => { void saveAsModule(); return false; } },
      { label: '关闭' },
      {
        label: '＋ 新建模块',
        primary: true,
        // 返回 false：编辑器开在上一层，管理器别跟着关掉（不然新建完就回不到列表了）
        onClick: () => {
          openModuleEditor({
            onSaved: async () => {
              list = await get('/api/prompts/snippets');
              render();
            },
          });
          return false;
        },
      },
    ],
  });
  void positions;
}

/** 新建 / 编辑一个模块 */
export function openModuleEditor({ module = null, onSaved = null } = {}) {
  const title = h('input', { placeholder: '比如：剧情总结（记忆区）', value: module?.title ?? '' });
  const description = h('input', { placeholder: '一句话讲效果，比如「在结尾处生成短期和长期的剧情总结」', value: module?.description ?? '' });
  const position = h(
    'select',
    {},
    Object.entries(MODULE_POSITION_LABELS).map(([value, label]) =>
      h('option', { value, selected: (module?.position ?? 'after-history') === value }, label)),
  );
  const source = h(
    'select',
    {},
    [
      h('option', { value: 'original', selected: (module?.source ?? 'original') !== 'imported' }, '我自己写的（样式不限制）'),
      h('option', { value: 'imported', selected: (module?.source ?? 'original') === 'imported' }, '别人的（样式收进消息区，脚本要信任）'),
    ],
  );
  const bodyField = h('textarea', { rows: 8, placeholder: '提示词。比如：每次回复结尾用 <summary></summary> 写一段 100 字剧情总结。', value: module?.body ?? '' });
  const css = h('textarea', { rows: 6, placeholder: '.summary{ color:#8a6; border-left:3px solid #8a6; padding:6px 10px; }', value: module?.css ?? '' });
  const html = h('textarea', { rows: 4, placeholder: '可选。写了 HTML 或 JS，整块会跑在沙箱 iframe 里（脚本永远不进主页面）。', value: module?.html ?? '' });
  const js = h('textarea', { rows: 4, placeholder: "Tavern.vars.get('hp').then(function (v) { document.body.textContent = 'HP ' + v; });", value: module?.js ?? '' });
  // 另外三样零件：世界书条目（一行语法）/ 正则脚本（JSON）/ 背景图（素材库里的图）
  const worldbookText = h('textarea', {
    rows: 5,
    placeholder: '一行一条，例如：\n酒馆, tavern :: 镇上那家挂着银牌的酒馆，老板娘叫阿黛尔。\n[[常开]] 天色 :: 现在是傍晚。',
    value: module?.worldbookText ?? '',
  });
  const regexText = h('textarea', {
    rows: 4,
    placeholder: '一个 JSON 数组（留空 = 不带正则）。例如：\n[{"findRegex":"/<summary>[\\s\\S]*?<\\/summary>/g","replaceString":"","placement":[2]}]',
    value: Array.isArray(module?.regex) && module.regex.length ? JSON.stringify(module.regex, null, 2) : '',
  });
  const background = h('select', {}, h('option', { value: '' }, '（不设）'));
  void get('/api/assets?kind=image&limit=200')
    .then((data) => {
      for (const asset of data.items ?? []) {
        background.append(h('option', { value: asset.id, selected: module?.background === asset.id }, asset.name || asset.id));
      }
    })
    .catch(() => {});

  openModal({
    title: module ? `编辑模块：${module.title}` : '新建模块',
    body: h(
      'div',
      { style: { minWidth: 'min(620px, 82vw)' } },
      field('名字', title),
      field('一句话说明', description),
      h('div', { style: { display: 'flex', gap: '10px' } }, field('提示词插在哪', position), field('来源', source)),
      field('提示词', bodyField),
      field('CSS（美化）', css),
      field('HTML（可选）', html),
      field('JS（可选）', js),
      field('世界书条目（一行语法）', worldbookText, '挂上这个模块就等于带上这本小世界书：关键词命中才进提示词，和世界书那边一套规则'),
      field('正则脚本（JSON）', regexText, '并进这一轮的正则链（发送前改输入 / 收到后改输出）。别人的模块要信任过才会跑'),
      field('背景图', background, '从素材库挑一张，铺在聊天页消息区后面（图片要先传进「工具箱 → 素材库」）'),
    ),
    actions: [
      { label: '取消' },
      {
        label: '保存',
        primary: true,
        onClick: async () => {
          const payload = {
            title: title.value.trim() || '未命名模块',
            description: description.value.trim(),
            position: position.value,
            source: source.value,
            body: bodyField.value,
            css: css.value,
            html: html.value,
            js: js.value,
            worldbookText: worldbookText.value,
            background: background.value,
          };
          const rawRegex = regexText.value.trim();
          if (rawRegex) {
            try {
              const parsed = JSON.parse(rawRegex);
              if (!Array.isArray(parsed)) throw new Error('要是数组');
              payload.regex = parsed;
            } catch (err) {
              toast(`正则那栏要是 JSON 数组：${err.message}`, { tone: 'warn' });
              return false;
            }
          } else {
            payload.regex = [];
          }
          try {
            if (module?.id) await put(`/api/prompts/snippets/${module.id}`, payload);
            else await post('/api/prompts/snippets', payload);
            toast('模块已保存');
            await onSaved?.();
          } catch (err) {
            toastError(err);
            return false;
          }
        },
      },
    ],
  });
}
