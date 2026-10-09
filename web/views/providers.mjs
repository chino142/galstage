/**
 * 模型接入：配置提供方 + 把模型绑到角色/对话上（多模型协同）。
 *
 * 密钥只往服务端送，页面永远只显示"已保存"。
 */

import { h } from '../core/dom.mjs';
import { get, post, put, del } from '../core/api.mjs';
import { panel, field, loading, errorBox, emptyState, table } from '../ui/components.mjs';
import { toast, toastError } from '../ui/toast.mjs';
import { openModal } from '../ui/modal.mjs';

/** 把 "Name: value" 的多行文本解析成对象。 */
function parseHeaders(text) {
  const out = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf(':');
    if (index <= 0) continue;
    out[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return out;
}

/**
 * Google 系"放宽安全设置"的一键配方：四类都设成 BLOCK_NONE（最松档）。
 * 注意：这只是让**请求**要求放宽，个别类别（尤其涉及未成年人的）在 Google 那边是硬墙，关不掉。
 */
const SAFETY_RELAXED = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
];

export function createProvidersView(module, ctx) {
  const el = h('div', { class: 'view' });
  const listHost = h('div', {});
  const bindingHost = h('div', {});
  const planHost = h('div', {});

  let catalog = { items: [], presets: [], adapters: [], kinds: [] };

  const presetSelect = h('select', {}, h('option', { value: '' }, '自定义（手动填）'));
  const labelInput = h('input', { type: 'text', placeholder: '例如 DeepSeek' });
  const kindSelect = h('select', {});
  const adapterSelect = h('select', {});
  const baseUrlInput = h('input', { type: 'text', placeholder: 'https://api.deepseek.com/v1' });
  const modelInput = h('input', { type: 'text', placeholder: '照你服务商文档里的模型名填（可点右边「列模型」）' });
  const keyInput = h('input', { type: 'password', placeholder: 'sk-…（只往服务端送）' });
  const defaultCheck = h('input', { type: 'checkbox', style: { width: '18px', height: '18px' } });

  // —— 高级：给公益站 / 中转站 / 本地代理用 ——
  const authSelect = h('select', {}, h('option', { value: '' }, '跟随适配器默认'));
  const headersArea = h('textarea', {
    placeholder: '一行一个，例如\nHTTP-Referer: https://my.app\nX-Title: Silver Tavern',
    style: { minHeight: '72px' },
  });
  const launcherCommand = h('input', { type: 'text', placeholder: 'npx / node / python（留空表示不用本地代理）' });
  const launcherArgs = h('input', { type: 'text', placeholder: '参数，用空格分隔' });
  const launcherPort = h('input', { type: 'number', placeholder: '1234' });

  const advanced = h(
    'details',
    { style: { marginBottom: '12px' } },
    h('summary', { style: { cursor: 'pointer', color: 'var(--st-muted)', fontSize: '12.5px' } }, '高级：鉴权方式 / 自定义请求头 / 本地代理'),
    h(
      'div',
      { style: { marginTop: '10px' } },
      field('鉴权方式', authSelect, '和中转站对不上时改这里'),
      field('自定义请求头', headersArea, '一行一个 Name: value'),
      field('本地代理：启动命令', launcherCommand, 'CLI / 反重力那类渠道：酒馆会在调用前自动把它拉起来'),
      field('本地代理：参数', launcherArgs),
      field('本地代理：端口', launcherPort, '用来判断"起来了没"；不确定就留空'),
    ),
  );

  // —— 采样参数：按适配器动态生成 ——
  // 各家能填的字段本来就不一样（Gemini 是 topP/maxOutputTokens、Anthropic 有 top_k
  // 但没有 frequency_penalty、本地推理才有 min_p…）。所以这里不写死一排输入框，
  // 而是照服务端那份参数表渲染 —— 显示的就是真正会发出去的。
  const paramsHost = h('div', { style: { marginBottom: '12px' } });
  const extraParamsArea = h('textarea', {
    placeholder: '额外参数（JSON，可留空）\n用上面没列出来、但你这个后端认的字段，例如 { "custom_flag": true }',
    style: { minHeight: '56px' },
  });
  let paramInputs = new Map();
  let editingId = null;
  let lastModel = ''; // 记住上一次的模型名：换了模型就把参数清空，免得带过去
  // 这家的参数覆盖：不认哪些已知参数、有哪些专属参数（存服务端，见 V16）
  let paramOverrides = { disabled: [], custom: [], modelPolicy: { disable: [], notes: [], conflicts: [], ids: [] } };
  const editingHint = h('span', { class: 'panel-note' }, '');

  /** 存一次覆盖表（改完立刻生效：请求时会被应用，连预设带来的字段也一起过滤）。 */
  async function saveOverrides(patch = {}) {
    if (!editingId) {
      toast('先把这家提供方保存下来，再设参数覆盖', { tone: 'warn' });
      return;
    }
    try {
      paramOverrides = await put(`/api/providers/${editingId}/param-overrides`, { ...paramOverrides, ...patch });
      // 重画参数区，但把已经填好的值带上（别因为改一次覆盖就把填的东西弄丢）
      const keep = {};
      for (const [key, { input }] of paramInputs) {
        if (!input) continue;
        if (input.type === 'checkbox') keep[key] = input.checked;
        else if (String(input.value ?? '') !== '') keep[key] = input.value;
      }
      renderParams(keep);
    } catch (err) {
      toastError(err);
    }
  }

  function inputFor(spec, current) {
    if (spec.type === 'enum') {
      return h(
        'select',
        {},
        h('option', { value: '' }, '（用服务商默认）'),
        ...spec.options.map((option) => h('option', { value: option, selected: current === option }, spec.optionLabels?.[option] ?? option)),
      );
    }
    if (spec.type === 'boolean') {
      return h('input', { type: 'checkbox', checked: current === true, style: { width: '18px', height: '18px' } });
    }
    if (spec.type === 'list') {
      const value = Array.isArray(current) ? current.join('\n') : current ?? '';
      return h('textarea', { rows: 2, placeholder: '一行一个', value });
    }
    if (spec.type === 'json') {
      const value = current === undefined || current === null ? '' : typeof current === 'string' ? current : JSON.stringify(current);
      return h('textarea', { rows: 2, class: 'mono', placeholder: 'JSON', value });
    }
    if (spec.type === 'number' || spec.type === 'int') {
      // 滑块 + 数字框：新手不会填出界，老手也还能精确敲。
      // 只给"有范围"的参数上滑块（没有 min/max 的，滑块没意义）。
      const step = spec.step ?? (spec.type === 'int' ? 1 : 0.01);
      const hasRange = Number.isFinite(Number(spec.min)) && Number.isFinite(Number(spec.max));
      const value = current === undefined || current === null ? '' : String(current);
      const number = h('input', {
        type: 'number',
        value,
        min: spec.min ?? null,
        max: spec.max ?? null,
        step,
        placeholder: spec.default !== null && spec.default !== undefined ? `默认 ${spec.default}` : '留空 = 不填',
        style: { width: '104px' },
      });
      if (!hasRange) return number;
      const slider = h('input', {
        type: 'range',
        value: value === '' ? String(spec.default ?? spec.min) : value,
        min: spec.min,
        max: spec.max,
        step,
        style: { flex: '1', minWidth: '80px' },
      });
      // 两边同步：拖滑块改数字，敲数字动滑块
      slider.addEventListener('input', () => { number.value = slider.value; });
      number.addEventListener('input', () => {
        const num = Number(number.value);
        if (Number.isFinite(num)) slider.value = String(num);
      });
      const box = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, slider, number);
      // 范围和步进直接写在下面（不用你去猜能填多大）
      box.append(h('div', { class: 'hint', style: { marginTop: '2px' } }, `范围 ${spec.min} ~ ${spec.max}，步进 ${step}${spec.default !== null && spec.default !== undefined ? `，默认 ${spec.default}` : ''}`));
      return box;
    }
    return h('input', { type: 'text', value: current ?? '', placeholder: '' });
  }

  /** 照当前适配器重建参数区；values = 正在编辑的提供方已有的参数。 */
  function renderParams(values = {}) {
    const adapterId = adapterSelect.value || 'openai';
    const form = catalog.adapterParams?.[adapterId];
    paramInputs = new Map();
    if (!form) {
      paramsHost.replaceChildren(h('div', { class: 'panel-note' }, '这个适配器没有可选参数。'));
      return;
    }
    // 用户手动勾的 + 按模型名自动判定的（后者不用他管，模型换代也不用改代码）
    const autoDisabled = new Set(paramOverrides.modelPolicy?.disable ?? []);
    const disabledKeys = new Set([...(paramOverrides.disabled ?? []), ...autoDisabled]);
    // 这家的专属参数（比如 Gemini 3 的 thinking_level）也当成一行填进同一个网格
    const customDefs = (paramOverrides.custom ?? []).map((def) => ({
      key: def.key,
      label: def.label || def.key,
      type: def.type ?? 'number',
      options: def.options ?? null,
      help: `${def.help || '这家的专属参数'}（放：${def.path === 'top' ? '请求体顶层' : def.path}）`,
      custom: true,
    }));
    const grid = h('div', { style: { display: 'grid', gap: '0 14px', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' } });
    for (const spec of [...form.params, ...customDefs]) {
      if (disabledKeys.has(spec.key)) continue; // 这家不认的：连输入框都不显示
      const input = inputFor(spec, values[spec.key]);
      paramInputs.set(spec.key, { spec, input });
      // 能力位说"这个适配器多半不认"的参数：照旧能填，但明确标出来
      // （为什么不直接禁掉：能力位表是"大概"，有的后端其实认，禁了反而挡路）
      const warn = spec.supported === false ? h('span', { class: 'chip small partial', title: `这个适配器没有「${spec.flag}」这个能力位：填了可能被忽略或报错，按你的服务商文档来` }, '这个模型多半不认') : null;
      // Google 系（Gemini / Vertex）的安全设置：给个一键"放宽 / 清空"，省得手写那串 JSON
      if (spec.key === 'safetySettings') {
        const quick = h(
          'div',
          { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' } },
          h('button', {
            class: 'btn small',
            title: '四类都设成 BLOCK_NONE（最松档）。个别类别 Google 仍然是硬墙，关不掉；走中转站时对方可能忽略。',
            onclick: () => { input.value = JSON.stringify(SAFETY_RELAXED, null, 2); },
          }, '放宽到 BLOCK_NONE'),
          h('button', { class: 'btn small', onclick: () => { input.value = ''; } }, '清空（用 Google 默认）'),
        );
        grid.append(field(
          h('span', { style: { display: 'inline-flex', gap: '6px', alignItems: 'center' } }, spec.label, warn),
          h('div', {}, input, quick),
          spec.help,
        ));
        continue;
      }
      grid.append(field(h('span', { style: { display: 'inline-flex', gap: '6px', alignItems: 'center' } }, spec.label, warn), input, spec.help));
    }
    const overview = h(
      'div',
      { class: 'hint', style: { marginTop: '10px', display: 'grid', gap: '4px' } },
      h('b', {}, '参数说明总览（调高了会怎样）'),
      ...form.params.map((spec) =>
        h(
          'div',
          {},
          h('b', {}, `${spec.label}：`),
          spec.help || '（没写说明）',
          Number.isFinite(Number(spec.min)) && Number.isFinite(Number(spec.max)) ? ` 可填 ${spec.min} ~ ${spec.max}。` : '',
          spec.supported === false ? ' ⚠ 这个适配器多半不认。' : '',
        ),
      ),
      h('div', { style: { marginTop: '4px' } }, '留空 = 这个参数不发给提供方；对话挂了预设时，预设那套采样参数会先用，这里填了才盖过它。'),
    );
    const isGemini3 = /gemini[-_/ ]?3/i.test(modelInput.value.trim());
    const overridesBlock = h(
      'details',
      { style: { marginTop: '10px' } },
      h('summary', { class: 'hint' }, '这家模型不认哪些参数 / 有专属参数？（换了代就点这里）'),
      h('div', { class: 'hint', style: { marginTop: '6px' } }, '勾上的参数会被**彻底丢掉**，包括预设里带来的同名参数 —— 这就是"新模型不认老参数"的解法。'),
      (paramOverrides.modelPolicy?.disable ?? []).length
        ? h(
            'div',
            { class: 'hint', style: { marginTop: '6px' } },
            `系统按模型名自动禁用了：${paramOverrides.modelPolicy.disable.join('、')}（不用你勾）。`,
            ...(paramOverrides.modelPolicy.notes ?? []).map((note) => h('div', { class: 'hint' }, note)),
          )
        : null,
      h(
        'div',
        { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '6px' } },
        ...form.params.map((spec) =>
          h(
            'label',
            { class: 'switch-row', style: { gap: '6px' } },
            h('input', {
              type: 'checkbox',
              checked: disabledKeys.has(spec.key),
              style: { width: '15px', height: '15px' },
              onchange: (event) => {
                const next = new Set(paramOverrides.disabled ?? []);
                if (event.target.checked) next.add(spec.key);
                else next.delete(spec.key);
                void saveOverrides({ disabled: [...next] });
              },
            }),
            h('span', { class: 'hint' }, spec.key),
          ),
        ),
      ),
      h(
        'div',
        { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px', flexWrap: 'wrap' } },
        h('button', {
          class: 'btn small',
          title: 'Gemini 3+ 的思考档位（替代老的 thinking_budget），按 OpenAI 风格放顶层',
          onclick: () => void saveOverrides({ custom: [...(paramOverrides.custom ?? []), { key: 'thinking_level', label: '思考档位 thinking_level', type: 'enum', options: ['low', 'high'], path: 'top', help: 'Gemini 3+ 的思考档位' }] }),
        }, '＋ thinking_level（Gemini 3）'),
        h('button', {
          class: 'btn small',
          title: 'Gemini 原生写法：generationConfig.thinkingConfig.thinkingLevel',
          onclick: () => void saveOverrides({ custom: [...(paramOverrides.custom ?? []), { key: 'thinkingLevel', label: '思考档位 thinkingConfig.thinkingLevel', type: 'enum', options: ['low', 'high'], path: 'generationConfig.thinkingConfig.thinkingLevel', help: 'Gemini 原生写法' }] }),
        }, '＋ 原生 thinkingConfig'),
        h('button', {
          class: 'btn small',
          title: '逐个参数发一个最小请求，看这家到底认哪些、点名拒了哪些（会花几 token）',
          onclick: async () => {
            if (!editingId) { toast('先把这家保存下来再试探', { tone: 'warn' }); return; }
            try {
              toast('正在逐个试探参数…（每个一次极小请求）', { duration: 2500 });
              const result = await post(`/api/providers/${editingId}/probe-params`, {});
              openModal({
                title: `《${result.model ?? '这家'}》的参数试探结果`,
                width: 'min(680px, 92vw)',
                body: h(
                  'div',
                  { style: { display: 'grid', gap: '6px', maxHeight: '56vh', overflow: 'auto' } },
                  h('div', { class: 'hint' }, result.note),
                  ...(result.results ?? []).map((item) =>
                    h(
                      'div',
                      {},
                      `${item.ok ? '✅' : item.named ? '❌' : '⚠️'} ${item.key}`,
                      item.ok ? '：认' : `：${item.named ? '点名不认' : '出错'} —— ${item.error ?? ''}`,
                    ),
                  ),
                ),
                actions: [{ label: '知道了', primary: true }],
              });
            } catch (err) {
              toastError(err);
            }
          },
        }, '🔬 试探这家认哪些参数'),
        h('span', { class: 'hint' }, '加完它会出现在上面的参数列表里，填了才发出去'),
      ),
      h(
        'div',
        { class: 'hint', style: { marginTop: '6px', display: 'grid', gap: '4px' } },
        ...(paramOverrides.custom ?? []).map((def) =>
          h(
            'div',
            {},
            `· ${def.label || def.key}（${def.key} · ${def.type} · path=${def.path}）`,
            h('button', {
              class: 'link-btn',
              style: { marginLeft: '8px' },
              onclick: () => void saveOverrides({ custom: (paramOverrides.custom ?? []).filter((item) => item.key !== def.key) }),
            }, '删掉'),
          ),
        ),
        !(paramOverrides.custom ?? []).length ? '(还没加专属参数)' : null,
      ),
      isGemini3 && !(paramOverrides.modelPolicy?.disable ?? []).includes('temperature')
        ? h(
            'div',
            { class: 'hint', style: { marginTop: '8px' } },
            '⚠ Gemini 3 系列建议 temperature = 1.0：设小于 1.0 可能死循环 / 推理退化 / 复杂任务失败。'
            + '（注：3.6 / 3.7 Flash 这一代已经**根本不接受** temperature / topP / topK —— 那种情况下上面会自动禁用，不用管这条。）',
            h('button', {
              class: 'link-btn',
              style: { marginLeft: '8px' },
              onclick: () => { renderParams({ ...values, temperature: 1 }); toast('温度按建议钉成 1.0（记得点「保存提供方」保存）'); },
            }, '把温度钉成 1.0'),
          )
        : null,
    );
    paramsHost.replaceChildren(
      h('div', { class: 'panel-note', style: { marginBottom: '8px' } }, `采样参数 · ${form.title} —— 不同适配器能填的字段不一样，这里只列这个适配器真正会发出去的。大部分情况**不用你填**：对话挂了预设，预设那套采样参数会自动带上；这里留空 = 跟着走。`),
      form.note ? h('div', { class: 'hint', style: { marginBottom: '8px' } }, form.note) : null,
      grid,
      h(
        'div',
        { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px' } },
        h('button', {
          class: 'btn',
          title: '把这些参数清空，回到"跟随服务商 / 预设"的状态',
          onclick: () => { renderParams({}); toast('参数已恢复默认（留空 = 跟随服务商 / 预设）'); },
        }, '↺ 恢复默认设置'),
        h('span', { class: 'hint' }, '换模型后也会自动清空，免得把上一个模型的参数带过去'),
      ),
      field('额外参数（JSON）', extraParamsArea, '上面没列的字段写这里；会原样发给提供方'),
      overview,
      overridesBlock,
    );
  }

  // 换了模型 → 采样参数清空回到"跟随服务商"（别把 A 模型的参数顺手带到 B 上）
  modelInput.addEventListener('change', () => {
    const next = modelInput.value.trim();
    if (lastModel && next !== lastModel) {
      renderParams({});
      toast('换了模型：采样参数已恢复默认（免得把上一个模型的参数带过去）');
    }
    lastModel = next;
  });

  function collectParams() {
    const out = {};
    for (const [key, { spec, input }] of paramInputs) {
      if (spec.type === 'boolean') {
        if (input.checked) out[key] = true;
        continue;
      }
      const text = String(input.value ?? '').trim();
      if (!text) continue;
      if (spec.type === 'number' || spec.type === 'int') out[key] = Number(text);
      else if (spec.type === 'list') out[key] = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      else if (spec.type === 'json') {
        try {
          out[key] = JSON.parse(text);
        } catch {
          throw new Error(`${spec.label} 要填合法 JSON`);
        }
      } else out[key] = text;
    }
    const extra = extraParamsArea.value.trim();
    if (extra) {
      let parsed;
      try {
        parsed = JSON.parse(extra);
      } catch {
        throw new Error('额外参数不是合法 JSON');
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) Object.assign(out, parsed);
      else throw new Error('额外参数要是一个 JSON 对象');
    }
    return out;
  }

  presetSelect.addEventListener('change', () => {
    const preset = catalog.presets.find((item) => item.id === presetSelect.value);
    if (!preset) return;
    labelInput.value = preset.label;
    kindSelect.value = preset.kind;
    adapterSelect.value = preset.adapter;
    baseUrlInput.value = preset.baseUrl;
    modelInput.value = preset.model ?? '';
    renderParams();
  });

  // 换适配器 → 参数表跟着换（Anthropic 有 top_k、Gemini 叫 topP、本地那套有 min_p…）
  adapterSelect.addEventListener('change', () => renderParams());

  el.append(
    panel(
      module.title,
      null,
      h('div', { class: 'panel-note' }, '适配器决定"怎么说"，用途决定"干什么"。绝大多数服务商选 OpenAI 兼容就行。'),
      h('div', { style: { marginTop: '14px' } }, field('一键预设', presetSelect)),
      h(
        'div',
        { style: { display: 'grid', gap: '0 14px', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' } },
        field('名字', labelInput),
        field('用途', kindSelect),
        field('适配器', adapterSelect),
        field('接口地址', baseUrlInput, '本地服务也要填，例如 http://127.0.0.1:11434/v1；Vertex 可以留空，会自动用官方端点（express 用 aiplatform.googleapis.com，服务账号按 location 拼区域端点）'),
        field('模型', modelInput, 'Azure 填部署名'),
        field('API Key', keyInput),
      ),
      h('div', { class: 'switch-row', style: { marginBottom: '12px' } }, defaultCheck, h('span', { class: 'panel-note' }, '设为该用途的默认')),
      advanced,
      paramsHost,
      h(
        'div',
        { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
        h('button', { class: 'btn primary', onclick: () => void persist() }, '保存提供方'),
        h(
          'button',
          {
            class: 'btn',
            title: '先把这家存下来，再问它到底提供哪些模型，点一个就填进「模型」',
            onclick: () => void pickModelFromProvider(),
          },
          '🔍 列模型',
        ),
        h('span', { class: 'panel-note' }, '不知道模型名叫什么就点「列模型」——直接问这家'),
      ),
      h('div', { style: { marginTop: '8px', display: 'flex', gap: '8px', alignItems: 'center' } }, editingHint,
        h('button', { class: 'btn', onclick: () => { editingId = null; editingHint.textContent = ''; renderParams({}); } }, '清空参数')),
    ),
    listHost,
    bindingHost,
    planHost,
  );

  async function render() {
    catalog = await get('/api/providers');
    const authStyles = await get('/api/providers/auth-styles').catch(() => ({ items: [] }));
    authSelect.replaceChildren(
      h('option', { value: '' }, '跟随适配器默认'),
      ...authStyles.items.map((style) => h('option', { value: style.id }, style.title)),
    );

    kindSelect.replaceChildren(...catalog.kinds.map((kind) => h('option', { value: kind.id }, kind.title)));
    adapterSelect.replaceChildren(...catalog.adapters.map((adapter) => h('option', { value: adapter.id }, adapter.title)));
    if (!editingId) renderParams();
    presetSelect.replaceChildren(
      h('option', { value: '' }, '自定义（手动填）'),
      ...catalog.presets.map((preset) => h('option', { value: preset.id }, preset.label)),
    );

    listHost.replaceChildren(
      panel(
        '已配置',
        `${catalog.items.length} 个`,
        catalog.items.length
          ? h('div', { class: 'grid' }, catalog.items.map((item) => providerCard(item)))
          : emptyState({ icon: '🔗', title: '还没有配置模型', desc: '上面选一个预设，填上 key 就行。' }),
      ),
    );

    await renderBindings();
  }

  /** 把表单收成一个提供方并保存（新建或改）。返回保存后的记录。 */
  async function persist() {
    const payload = {
      label: labelInput.value.trim(),
      kind: kindSelect.value,
      adapter: adapterSelect.value,
      baseUrl: baseUrlInput.value.trim(),
      model: modelInput.value.trim(),
      apiKey: keyInput.value,
      isDefault: defaultCheck.checked,
      authStyle: authSelect.value || null,
      headers: parseHeaders(headersArea.value),
      params: collectParams(),
      launcher: launcherCommand.value.trim()
        ? {
            command: launcherCommand.value.trim(),
            args: launcherArgs.value.trim().split(/\s+/).filter(Boolean),
            port: launcherPort.value ? Number(launcherPort.value) : null,
          }
        : null,
    };
    try {
      let saved;
      if (editingId) {
        if (!payload.apiKey) delete payload.apiKey; // 留空 = 不改密钥
        saved = await put(`/api/providers/${editingId}`, payload);
      } else {
        saved = await post('/api/providers', payload);
      }
      keyInput.value = '';
      toast(editingId ? '已保存修改' : '已保存');
      if (!editingId) paramOverrides = { disabled: [], custom: [] }; // 新建的那家还没有覆盖
      editingId = null;
      await render();
      return saved;
    } catch (err) {
      toastError(err);
      return null;
    }
  }

  /**
   * 「列模型」：不猜型号名，直接问这家到底提供什么。
   *
   * 需要先有 provider id，所以先把表单存下来（这也是唯一一条"能列模型"的路，
   * 现有接口 /api/providers/:id/models 就是这么定的），再列出来点一个。
   */
  async function pickModelFromProvider() {
    const saved = await persist();
    if (!saved?.id) return;
    let items = [];
    try {
      const data = await get(`/api/providers/${saved.id}/models`);
      items = data.items ?? [];
    } catch (err) {
      toastError(err);
      return;
    }
    if (!items.length) {
      toast('这家没报出可用模型（有些中转站不提供列模型接口），手填模型名也行', { tone: 'warn', duration: 4200 });
      return;
    }
    openModal({
      title: `《${saved.label}》报出来的模型（${items.length}）`,
      width: 'min(560px, 90vw)',
      body: h(
        'div',
        { style: { display: 'grid', gap: '6px', maxHeight: '52vh', overflow: 'auto' } },
        h('div', { class: 'hint' }, '点一个就设成这家的模型。列出来的是这家自己报的，不用照文档抄。'),
        ...items.map((name) =>
          h(
            'button',
            {
              class: `btn${saved.model === name ? ' primary' : ''}`,
              style: { justifyContent: 'flex-start' },
              onclick: async () => {
                try {
                  await put(`/api/providers/${saved.id}`, { model: name });
                  toast(`模型设成 ${name}`);
                  await loadIntoForm(saved.id);
                } catch (err) {
                  toastError(err);
                }
              },
            },
            name,
          ),
        ),
      ),
      actions: [{ label: '知道了' }],
    });
  }

  /** 把一个已保存的提供方读回上面的表单（含采样参数），切到编辑模式。 */
  async function loadIntoForm(id) {
    const full = await get(`/api/providers/${id}`);
    editingId = id;
    labelInput.value = full.label ?? '';
    kindSelect.value = full.kind ?? 'chat';
    adapterSelect.value = full.adapter ?? 'openai';
    baseUrlInput.value = full.baseUrl ?? '';
    modelInput.value = full.model ?? '';
    lastModel = full.model ?? '';
    // 这家的参数覆盖（不认哪些 / 专属参数）也读回来
    try {
      paramOverrides = await get(`/api/providers/${id}/param-overrides`);
    } catch {
      paramOverrides = { disabled: [], custom: [] };
    }
    keyInput.value = '';
    defaultCheck.checked = Boolean(full.isDefault);
    authSelect.value = full.authStyle ?? '';
    headersArea.value = Object.entries(full.headers ?? {}).map(([key, value]) => `${key}: ${value}`).join('\n');
    launcherCommand.value = full.launcher?.command ?? '';
    launcherArgs.value = (full.launcher?.args ?? []).join(' ');
    launcherPort.value = full.launcher?.port ?? '';
    extraParamsArea.value = '';
    renderParams(full.params ?? {});
    editingHint.textContent = `正在编辑「${full.label}」：密钥留空 = 保持原样。`;
    window.scrollTo?.({ top: 0, behavior: 'smooth' });
    await render();
  }

  function providerCard(item) {
    const modelsBox = h('div', { class: 'panel-note', style: { marginTop: '8px' } });
    const launcherLog = h('pre', {
      class: 'mono',
      style: { marginTop: '8px', maxHeight: '160px', overflow: 'auto', fontSize: '11.5px', color: 'var(--st-hint)', whiteSpace: 'pre-wrap' },
    });
    const keyEditor = h('input', { type: 'password', placeholder: '换一把 key（留空不改）' });
    return h(
      'div',
      { class: 'tile' },
      h(
        'div',
        { class: 'tile-title' },
        item.label,
        h('span', { class: `chip ${item.enabled ? 'ready' : 'planned'}` }, item.isDefault ? '默认' : item.enabled ? '启用中' : '已停用'),
      ),
      h('div', { class: 'mono tile-desc' }, `${item.adapter} · ${item.model || '（未指定模型）'}`),
      h('div', { class: 'mono tile-desc' }, item.baseUrl),
      item.authStyle || Object.keys(item.headers ?? {}).length
        ? h(
            'div',
            { class: 'panel-note' },
            `鉴权：${item.authStyle ?? '默认'}${Object.keys(item.headers ?? {}).length ? ` · 自定义头 ${Object.keys(item.headers).length} 个` : ''}`,
          )
        : null,
      h('div', { class: 'panel-note' }, item.hasKey ? '密钥已保存' : '没有密钥（本地服务通常不需要）'),
      item.params && Object.keys(item.params).length
        ? h('div', { class: 'panel-note' }, `采样参数：${Object.entries(item.params).map(([key, value]) => `${key}=${Array.isArray(value) ? `[${value.join(', ')}]` : value}`).join(' · ')}`)
        : h('div', { class: 'panel-note' }, '采样参数：用的都是服务商默认'),
      item.lastTest
        ? h('div', { class: 'panel-note' }, item.lastTest.ok ? `上次测试：通过` : `上次测试：失败 — ${item.lastTest.error}`)
        : null,
      item.launcher
        ? h(
            'div',
            { style: { marginTop: '8px' } },
            h(
              'div',
              { class: 'panel-note' },
              `本地代理：${item.launcher.command} ${(item.launcher.args ?? []).join(' ')}${item.launcher.port ? ` （端口 ${item.launcher.port}）` : ''}`,
            ),
            h(
              'div',
              { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' } },
              h(
                'button',
                {
                  class: 'btn',
                  onclick: async () => {
                    launcherLog.textContent = '正在启动…';
                    try {
                      const status = await post(`/api/providers/${item.id}/start`, {});
                      launcherLog.textContent = [...(status.logs ?? [])].join('\n') || '（没有输出）';
                      await render();
                    } catch (err) {
                      launcherLog.textContent = err.message;
                      toastError(err);
                    }
                  },
                },
                '启动代理',
              ),
              h(
                'button',
                {
                  class: 'btn',
                  onclick: async () => {
                    await post(`/api/providers/${item.id}/stop`, {});
                    launcherLog.textContent = '已停止';
                    await render();
                  },
                },
                '停止代理',
              ),
              h(
                'button',
                {
                  class: 'btn',
                  onclick: async () => {
                    const info = await get(`/api/providers/${item.id}/launcher`);
                    const logs = info.status?.logs ?? [];
                    launcherLog.textContent = [info.status?.running ? '（运行中）' : '（未运行）', ...logs].join('\n') || '没有日志';
                  },
                },
                '看日志',
              ),
            ),
            launcherLog,
          )
        : null,
      keyEditor,
      h(
        'div',
        { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' } },
        h(
          'button',
          {
            class: 'btn',
            onclick: async () => {
              modelsBox.textContent = '测试中…';
              try {
                const result = await post(`/api/providers/${item.id}/test`, {});
                modelsBox.textContent = result.ok
                  ? `✓ 通过（${result.via === 'models' ? `${result.count} 个模型` : '直接对话成功'}）`
                  : `✗ ${result.error}`;
                await render();
              } catch (err) {
                modelsBox.textContent = `✗ ${err.message}`;
              }
            },
          },
          '测试',
        ),
        h(
          'button',
          {
            class: 'btn',
            onclick: async () => {
              try {
                const result = await get(`/api/providers/${item.id}/models`);
                modelsBox.textContent = result.items.slice(0, 12).join('、') + (result.items.length > 12 ? ' …' : '');
              } catch (err) {
                modelsBox.textContent = `取不到模型列表：${err.message}`;
              }
            },
          },
          '列模型',
        ),
        keyEditor.value
          ? h(
              'button',
              {
                class: 'btn',
                onclick: async () => {
                  await put(`/api/providers/${item.id}`, { apiKey: keyEditor.value });
                  keyEditor.value = '';
                  toast('密钥已更新');
                  await render();
                },
              },
              '保存 key',
            )
          : null,
        !item.isDefault
          ? h(
              'button',
              {
                class: 'btn',
                onclick: async () => {
                  await put(`/api/providers/${item.id}`, { isDefault: true });
                  await render();
                },
              },
              '设为默认',
            )
          : null,
        h(
          'button',
          {
            class: 'btn',
            // 把这一个提供方读回上面的表单（含采样参数），切到编辑模式
            onclick: () => void loadIntoForm(item.id),
          },
          '编辑',
        ),
        h(
          'button',
          {
            class: 'btn',
            onclick: async () => {
              try {
                await del(`/api/providers/${item.id}`);
                toast('已删除');
                await render();
              } catch (err) {
                toastError(err);
              }
            },
          },
          '删除',
        ),
      ),
      modelsBox,
    );
  }

  async function renderBindings() {
    const [bindingList, scopes, characters, chats] = await Promise.all([
      get('/api/models/bindings'),
      get('/api/models/scopes'),
      get('/api/characters').catch(() => ({ items: [] })),
      get('/api/chats').catch(() => ({ items: [] })),
    ]);
    // 批量改完要重新读一次，所以不能是 const
    let bindings = bindingList;
    const chatProviders = catalog.items.filter((item) => item.kind === 'chat');
    const cards = (characters.items ?? []).filter((item) => item?.id);
    const chatList = (chats.items ?? []).filter((item) => item?.id);
    const groups = chatList.filter((item) => item.isGroup);

    // 群聊成员：一边用来当"群聊成员覆盖"的候选，一边把已经绑好的 mem_xxx 翻译成人话。
    // 群聊一般就一两个，直接把成员拉全 —— 以前这一栏是让人手打 id，根本没法用。
    const memberChoices = [];
    const memberLabel = new Map();
    for (const group of groups) {
      const detail = await get(`/api/chats/${group.id}`).catch(() => null);
      for (const member of detail?.members ?? []) {
        if (!member?.id) continue;
        const label = `${group.title} / ${member.name ?? '角色'}`;
        memberLabel.set(member.id, label);
        memberChoices.push({ value: member.id, label });
      }
    }

    const providerLabel = (id) => catalog.items.find((item) => item.id === id)?.label ?? '（未绑定）';

    // ---------------------------------------------------------------- 分工总表
    // 一行 = 一个"对象"（全局默认 / 角色 / 对话 / 群聊成员），就地选提供方 + 模型。
    // 不选 = 跟随上级（这一行的绑定会被删掉），所以不需要"保存"按钮，改完就落库。
    //
    // 有意不做成"范围 / 对象 / 提供方 / 模型"四个字段的表单：模型一多，
    // 那样得来回切四次才知道谁在用哪个，而且"对象"还得手打 id。
    const scopeTitle = (id) => scopes.items.find((scope) => scope.id === id)?.title ?? id;
    const modelCache = new Map();
    let rowUid = 0;

    /** 问一次提供方有哪些模型，缓存在内存里（同一家只问一次）。问不到就让用户手填。 */
    async function modelsFor(providerId) {
      if (!providerId) return [];
      if (modelCache.has(providerId)) return modelCache.get(providerId);
      let items = [];
      try {
        const result = await get(`/api/providers/${providerId}/models`);
        items = Array.isArray(result?.items) ? result.items : [];
      } catch {
        items = [];
      }
      modelCache.set(providerId, items);
      return items;
    }

    const bindingFor = (scope, targetId = '') =>
      bindings.items.find((item) => item.scope === scope && String(item.targetId ?? '') === String(targetId)) ?? null;

    function defaultSummary() {
      const binding = bindingFor('default');
      return binding ? `${providerLabel(binding.providerId)} · ${binding.model || '提供方默认'}` : '还没设全局默认';
    }

    /** 这一行现在实际"从哪来"：自己有绑定就是自己，没有就说跟谁。 */
    function sourceText(scope, own) {
      // 全局默认那一行直接把"哪家·哪个模型"写出来 —— 这一行没有上级，写"全局默认"等于没说。
      if (own) {
        return scope === 'default'
          ? { text: `${providerLabel(own.providerId)} · ${own.model || '提供方默认'}`, own: true }
          : { text: scopeTitle(scope), own: true };
      }
      if (scope === 'chat') return { text: `跟随全局默认（${defaultSummary()}）`, own: false };
      if (scope === 'character') return { text: '跟随对话 / 全局默认', own: false };
      if (scope === 'chat_member') return { text: '跟随角色 / 对话 / 全局默认', own: false };
      return { text: '', own: false };
    }

    /** 一行：名字 + 现在是跟谁 + 提供方/模型两个控件。 */
    function bindingRow({ scope, targetId = '', label, hint = '' }) {
      const own = bindingFor(scope, targetId);
      const rowKey = `${scope}|${targetId}`;
      const selectedBox = h('input', { type: 'checkbox', title: '勾上可以一次改好几行' });
      selectedBox.checked = selected.has(rowKey);
      selectedBox.addEventListener('change', () => {
        if (selectedBox.checked) selected.add(rowKey);
        else selected.delete(rowKey);
        refreshBatchBar();
      });
      // 这一行自己的绑定会随操作变（选了就是新建、清空就是删掉），所以不能只认渲染时那一份。
      let current = own;
      const listId = `bind-models-${(rowUid += 1)}`;
      const datalist = h('datalist', { id: listId });
      const modelInput = h('input', { type: 'text', placeholder: '模型名（留空 = 提供方默认）', list: listId });
      modelInput.value = own?.model ?? '';
      const providerSelect = h(
        'select',
        {},
        h('option', { value: '' }, scope === 'default' ? '（选一家提供方）' : '（跟随上级）'),
        ...chatProviders.map((item) => h('option', { value: item.id }, item.label)),
      );
      providerSelect.value = own?.providerId ?? '';
      const initial = sourceText(scope, own);
      const sourceCell = h('span', { class: 'bind-source' }, initial.text);
      sourceCell.classList.toggle('own', initial.own);

      const refreshModels = async () => {
        const items = await modelsFor(providerSelect.value);
        datalist.replaceChildren(...items.map((name) => h('option', { value: name })));
      };
      void refreshModels();

      const save = async () => {
        try {
          if (!providerSelect.value) {
            if (current) await del(`/api/models/bindings/${current.id}`);
            current = null;
            const next = sourceText(scope, null);
            sourceCell.textContent = next.text;
            sourceCell.classList.toggle('own', false);
            toast(`${label}：改回跟随上级`);
            return;
          }
          const saved = await put('/api/models/bindings', {
            scope,
            targetId,
            providerId: providerSelect.value,
            model: modelInput.value.trim() || null,
            params: current?.params ?? {},
          });
          current = saved ?? { ...current, providerId: providerSelect.value, model: modelInput.value.trim() || null };
          const next = sourceText(scope, current);
          sourceCell.textContent = next.text;
          sourceCell.classList.toggle('own', true);
          toast(`${label}：${providerLabel(providerSelect.value)}${modelInput.value.trim() ? ` · ${modelInput.value.trim()}` : ''}`);
        } catch (err) {
          toastError(err);
        }
      };

      providerSelect.addEventListener('change', async () => {
        modelInput.value = '';
        await refreshModels();
        void save();
      });
      modelInput.addEventListener('change', () => void save());

      return h(
        'div',
        { class: 'bind-row', dataset: { key: rowKey } },
        h(
          'label',
          { class: 'bind-name', title: hint },
          selectedBox,
          h('span', { class: 'bind-name-text' }, h('span', {}, label), sourceCell),
        ),
        h(
          'div',
          { class: 'bind-pick' },
          providerSelect,
          modelInput,
          h('button', { class: 'link-btn', title: '调这一行的采样参数（要先给它绑一家）', onclick: () => void editParams(current, label) }, '⚙'),
          datalist,
        ),
      );
    }

    const searchInput = h('input', { type: 'text', placeholder: '搜角色 / 对话…', style: { maxWidth: '240px' } });
    const rowsHost = h('div', {});
    const collapsible = (title, rows) => h('details', { class: 'bind-group' }, h('summary', {}, title), ...rows);

    // ---------------------------------------------------------------- 批量
    // 勾几行 → 一次给它们绑同一家（"这几个配角都用便宜的那个"）。模型多起来以后
    // 一行行改太费事。
    const selected = new Set();
    const batchListId = `bind-batch-models-${(rowUid += 1)}`;
    const batchList = h('datalist', { id: batchListId });
    const batchProvider = h(
      'select',
      {},
      h('option', { value: '' }, '（选一家提供方）'),
      ...chatProviders.map((item) => h('option', { value: item.id }, item.label)),
    );
    const batchModel = h('input', { type: 'text', placeholder: '模型名（可留空 = 提供方默认）', list: batchListId });
    const batchCount = h('span', { class: 'bind-batch-count' }, '');
    const batchBar = h('div', { class: 'bind-batch', hidden: true });

    batchProvider.addEventListener('change', async () => {
      const items = await modelsFor(batchProvider.value);
      batchList.replaceChildren(...items.map((name) => h('option', { value: name })));
    });

    function refreshBatchBar() {
      batchBar.hidden = selected.size === 0;
      batchCount.textContent = `已选 ${selected.size} 项`;
    }

    /** 当前筛出来的行一键全勾（卡多的时候靠这个，不用一行行点）。 */
    const selectAllButton = h(
      'button',
      {
        class: 'link-btn',
        onclick: () => {
          for (const row of rowsHost.querySelectorAll('.bind-row')) {
            const key = row.dataset.key;
            // 全局默认那一行不参与全选：它是所有行的兜底，误伤范围太大
            if (!key || key.startsWith('default|')) continue;
            // 折叠起来的那些（对话 / 群聊成员）不算"当前显示的"
            const visible = row.checkVisibility ? row.checkVisibility() : row.getClientRects().length > 0;
            if (!visible) continue;
            selected.add(key);
            const box = row.querySelector('input[type=checkbox]');
            if (box) box.checked = true;
          }
          refreshBatchBar();
        },
      },
      '全选当前显示的',
    );

    /** 把选中的行一次性设成同一家（或者一次性改回"跟随上级"）。 */
    async function applyBatch({ clear = false } = {}) {
      const keys = [...selected];
      if (!keys.length) return;
      if (!clear && !batchProvider.value) {
        toast('先选一家提供方', { tone: 'warn' });
        return;
      }
      try {
        for (const key of keys) {
          const index = key.indexOf('|');
          const scope = key.slice(0, index);
          const targetId = key.slice(index + 1);
          const own = bindingFor(scope, targetId);
          if (clear) {
            if (own) await del(`/api/models/bindings/${own.id}`);
          } else {
            await put('/api/models/bindings', {
              scope,
              targetId,
              providerId: batchProvider.value,
              model: batchModel.value.trim() || null,
              params: own?.params ?? {},
            });
          }
        }
        toast(clear ? `已把 ${keys.length} 项改回跟随上级` : `已把 ${keys.length} 项设为 ${providerLabel(batchProvider.value)}`);
      } catch (err) {
        toastError(err);
      } finally {
        selected.clear();
        bindings = await get('/api/models/bindings').catch(() => bindings);
        renderRows();
        refreshBatchBar();
      }
    }

    batchBar.append(
      batchCount,
      batchProvider,
      batchModel,
      batchList,
      h('button', { class: 'btn primary', onclick: () => void applyBatch({}) }, '应用到选中'),
      h('button', { class: 'btn', onclick: () => void applyBatch({ clear: true }) }, '改回跟随上级'),
      h(
        'button',
        { class: 'link-btn', onclick: () => { selected.clear(); renderRows(); refreshBatchBar(); } },
        '清空选择',
      ),
    );

    function renderRows() {
      const keyword = searchInput.value.trim().toLowerCase();
      const match = (text) => !keyword || String(text ?? '').toLowerCase().includes(keyword);
      const parts = [
        h(
          'div',
          { class: 'bind-group' },
          h('div', { class: 'bind-group-title' }, '全局默认'),
          bindingRow({ scope: 'default', label: '没被别的规则命中时用它', hint: 'scope=default' }),
        ),
      ];
      const cardRows = cards.filter((card) => match(card.name)).map((card) =>
        bindingRow({ scope: 'character', targetId: card.id, label: card.name ?? card.id, hint: card.id }),
      );
      if (cardRows.length) {
        parts.push(h('div', { class: 'bind-group' }, h('div', { class: 'bind-group-title' }, `角色（${cards.length}）`), ...cardRows));
      }
      const chatRows = chatList.filter((chat) => match(chat.title)).map((chat) =>
        bindingRow({ scope: 'chat', targetId: chat.id, label: `${chat.isGroup ? '👥 ' : '💬 '}${chat.title}`, hint: chat.id }),
      );
      if (chatRows.length) parts.push(collapsible(`对话（${chatList.length}）`, chatRows));
      const memberRows = memberChoices.filter((item) => match(item.label)).map((item) =>
        bindingRow({ scope: 'chat_member', targetId: item.value, label: item.label, hint: item.value }),
      );
      if (memberRows.length) parts.push(collapsible(`群聊成员（${memberChoices.length}）`, memberRows));
      rowsHost.replaceChildren(...parts);
      refreshBatchBar();
    }
    searchInput.addEventListener('input', renderRows);

    // 同一个提供方下的不同模型，采样参数常常是两套（推理模型不吃 temperature）。
    // 想给某一行单独调参数，用行末的 ⚙ —— 默认不占地方。
    /** 分工预览：不手打 id，直接选一个群聊（或所有角色卡）让服务端算。 */
    async function computePlan() {
      try {
        const chatId = planTarget.value;
        const query = new URLSearchParams();
        if (chatId) query.set('chatId', chatId);
        else query.set('characters', cards.map((card) => `${card.id}::${card.name ?? card.id}`).join(','));
        const plan = await get(`/api/models/plan?${query.toString()}`);
        planBox.replaceChildren(
          h(
            'div',
            { class: 'panel-note', style: { marginTop: '10px' } },
            plan.multiModel ? `多模型协同已生效：这个范围里用到 ${plan.distinctProviders} 家模型` : '当前只用到 1 个模型',
          ),
          table(
            ['角色', '提供方', '模型', '来源'],
            (plan.items ?? []).map((item) => [item.member, providerLabel(item.providerId), item.model || '默认', item.sourceTitle]),
          ),
          h('div', { class: 'hint' }, '记忆和历史挂在对话上，跟模型无关 —— 所以几个模型看到的是同一份上下文。'),
        );
      } catch (err) {
        toastError(err);
      }
    }

    async function editParams(binding, label) {
      if (!binding) return toast('这一行还没有自己的绑定', { tone: 'warn' });
      const box = h('textarea', { style: { minHeight: '120px', width: '100%' } });
      box.value = JSON.stringify(binding.params ?? {}, null, 2);
      openModal({
        title: `参数覆盖 · ${label}`,
        body: h('div', {}, field('JSON', box, '只覆盖你写的那几个字段；和提供方的参数合并，绑定优先')),
        actions: [
          {
            label: '保存',
            primary: true,
            onClick: async () => {
              let params;
              try {
                params = JSON.parse(box.value || '{}');
              } catch {
                toast('要填合法 JSON', { tone: 'warn' });
                return false;
              }
              try {
                await put('/api/models/bindings', {
                  scope: binding.scope,
                  targetId: binding.targetId,
                  providerId: binding.providerId,
                  model: binding.model ?? null,
                  params,
                });
                toast('参数已保存');
              } catch (err) {
                toastError(err);
                return false;
              }
              return true;
            },
          },
        ],
      });
    }

    const planTarget = h(
      'select',
      {},
      h('option', { value: '' }, '所有角色卡'),
      ...groups.map((group) => h('option', { value: group.id }, `👥 ${group.title}`)),
    );
    const planBox = h('div', {});

    bindingHost.replaceChildren(
      panel(
        '模型分工（多模型协同）',
        `${bindings.total} 条绑定`,
        h(
          'div',
          { class: 'panel-note' },
          '优先级：群聊成员 > 角色 > 对话 > 全局默认 —— 没设置的行一律"跟随上级"。记忆和历史挂在对话上，所以换模型不会丢上下文。改完立刻生效，不用点保存。',
        ),
        h(
          'div',
          { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginTop: '10px' } },
          searchInput,
          selectAllButton,
          h('span', { class: 'panel-note' }, `${chatProviders.length} 家提供方 · ${cards.length} 张卡 · ${chatList.length} 个对话 · 勾几行可以一次改`),
        ),
        batchBar,
        rowsHost,
      ),
    );

    planHost.replaceChildren(
      panel(
        '分工预览',
        null,
        h(
          'div',
          { style: { display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' } },
          field('看谁的', planTarget, groups.length ? '选一个群聊，看这个群里谁用哪个模型；不选就按所有角色卡算' : '还没有群聊，先按所有角色卡算'),
          h('button', { class: 'btn', onclick: () => void computePlan() }, '算一下'),
        ),
        planBox,
      ),
    );

    renderRows();
  }

  async function mountView() {
    listHost.append(loading());
    try {
      await render();
    } catch (err) {
      listHost.replaceChildren(panel('模型接入', null, errorBox(err, { onRetry: mountView })));
    }
  }

  return { el, mount: mountView };
}
