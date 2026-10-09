/**
 * 写卡助手。
 *
 * 三种用法：
 *   1) 多步 Agent：给一个目标，它自己想、自己调工具
 *   2) 单跑技能：选一个技能、填参数，直接出结果
 *   3) 看技能清单：内置技能 + 来自 MCP 的工具
 *
 * Agent 的运行过程是 SSE 推过来的，每一步都会出现在右侧日志里。
 */

import { h } from '../core/dom.mjs';
import { get, post, streamPost } from '../core/api.mjs';
import { panel, field, loading, errorBox, emptyState } from '../ui/components.mjs';
import { toast, toastError } from '../ui/toast.mjs';

function eventLine(event, data) {
  const tone = event === 'error' ? 'error' : event === 'result' ? 'ok' : 'info';
  const label = {
    step: `第 ${data?.n ?? '?'} 步`,
    thought: '想法',
    tool: '调用',
    result: '结果',
    final: '完成',
    error: '出错',
    ready: '就绪',
  }[event] ?? event;
  let text = '';
  if (event === 'thought') text = data.text;
  else if (event === 'tool') text = `${data.id}(${JSON.stringify(data.args ?? {}).slice(0, 200)})`;
  else if (event === 'result') text = data.ok ? JSON.stringify(data.data ?? {}).slice(0, 500) : `失败：${data.error}`;
  else if (event === 'final') text = data.text;
  else if (event === 'error') text = data.message;
  else if (event === 'ready') text = `工具 ${data.toolCount} 个 · 模型 ${data.target?.sourceTitle ?? ''}`;
  else if (event === 'step') text = '';
  return h(
    'div',
    { class: `agent-line ${tone}` },
    h('span', { class: 'agent-badge' }, label),
    h('span', { class: 'agent-text' }, text),
  );
}

export function createAgentView(module, ctx) {
  const el = h('div', { class: 'view' });
  const skillsHost = h('div', {});
  const logHost = h('div', { class: 'agent-log' });

  const goal = h('textarea', { placeholder: '例如：帮我写一个冷淡的女仆角色，名字叫琥珀，世界观是近未来都市' });
  const context = h('textarea', { placeholder: '可选：把已有设定粘进来，助手会基于它工作', style: { minHeight: '60px' } });
  const providerSelect = h('select', {}, h('option', { value: '' }, '用默认 / 按角色绑定'));
  const runBtn = h('button', { class: 'btn primary' }, '▶ 开始');
  const stopBtn = h('button', { class: 'btn', disabled: true }, '■ 停止');
  let controller = null;

  runBtn.addEventListener('click', async () => {
    if (!goal.value.trim()) return toast('先写个目标', { tone: 'warn' });
    logHost.replaceChildren();
    controller = new AbortController();
    runBtn.disabled = true;
    stopBtn.disabled = false;
    try {
      await streamPost(
        '/api/agent/run',
        { goal: goal.value.trim(), context: context.value.trim(), providerId: providerSelect.value || null },
        (event, data) => {
          logHost.append(eventLine(event, data));
          logHost.scrollTop = logHost.scrollHeight;
        },
        { signal: controller.signal },
      );
    } catch (err) {
      if (err?.name !== 'AbortError') {
        logHost.append(eventLine('error', { message: err.message }));
        toastError(err);
      }
    } finally {
      runBtn.disabled = false;
      stopBtn.disabled = true;
      controller = null;
    }
  });

  stopBtn.addEventListener('click', () => controller?.abort());

  el.append(
    panel(
      module.title,
      null,
      h('div', { class: 'panel-note' }, '给一个目标，助手会自己决定调哪个技能；也可以直接在下面单跑某个技能。'),
      h('div', { style: { marginTop: '14px' } }, field('目标', goal), field('上下文（可选）', context), field('用哪个模型', providerSelect)),
      h('div', { style: { display: 'flex', gap: '8px' } }, runBtn, stopBtn),
    ),
    panel('运行日志', null, logHost),
    skillsHost,
  );

  async function renderSkills() {
    skillsHost.append(loading());
    try {
      const data = await get('/api/agent/skills');
      const groups = new Map();
      for (const skill of data.items) {
        if (!groups.has(skill.category)) groups.set(skill.category, []);
        groups.get(skill.category).push(skill);
      }
      skillsHost.replaceChildren(
        panel(
          '技能',
          `${data.items.length} 个（内置 ${data.builtin} · MCP ${data.fromMcp}）`,
          data.fromMcp === 0
            ? h('div', { class: 'panel-note' }, '还没有连接 MCP 服务器。连上之后，它的工具会自动出现在这里。')
            : null,
          ...[...groups.entries()].map(([categoryId, items]) => {
            const category = data.categories.find((item) => item.id === categoryId);
            return h(
              'div',
              { style: { marginTop: '14px' } },
              h('div', { class: 'nav-group-title' }, category?.title ?? categoryId),
              h('div', { class: 'grid' }, items.map((skill) => skillCard(skill))),
            );
          }),
        ),
      );
    } catch (err) {
      skillsHost.replaceChildren(panel('技能', null, errorBox(err)));
    }
  }

  function skillCard(skill) {
    const params = Object.keys(skill.parameters?.properties ?? {});
    const input = h('textarea', { placeholder: params.length ? `参数：${params.join(', ')}` : '这个技能不需要参数', style: { minHeight: '56px' } });
    const resultBox = h('div', { class: 'panel-note', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } });
    const run = h(
      'button',
      {
        class: 'btn',
        onclick: async () => {
          let parsed = {};
          if (input.value.trim()) {
            try {
              parsed = JSON.parse(input.value);
            } catch {
              return toast('参数得是 JSON，例如 {"idea":"冷淡的女仆"}', { tone: 'warn' });
            }
          } else if (params.length === 1) {
            parsed = { [params[0]]: context.value.trim() || goal.value.trim() || '（空）' };
          }
          run.disabled = true;
          resultBox.textContent = '运行中…';
          try {
            const result = await post(`/api/agent/skills/${skill.id}/run`, {
              input: parsed,
              providerId: providerSelect.value || null,
            });
            resultBox.textContent = result.ok
              ? JSON.stringify(result.data, null, 2)
              : `失败：${result.error}`;
          } catch (err) {
            resultBox.textContent = `失败：${err.message}`;
          } finally {
            run.disabled = false;
          }
        },
      },
      '跑一次',
    );
    return h(
      'div',
      { class: 'tile' },
      h('div', { class: 'tile-title' }, skill.title, skill.source === 'mcp' ? h('span', { class: 'chip stub' }, 'MCP') : null),
      h('div', { class: 'tile-desc' }, skill.description),
      h('div', { class: 'mono', style: { margin: '6px 0', color: 'var(--st-hint)' } }, skill.id),
      input,
      h('div', { style: { marginTop: '8px' } }, run),
      resultBox,
    );
  }

  async function mountView() {
    try {
      const providers = await get('/api/providers');
      for (const item of providers.items.filter((provider) => provider.kind === 'chat' && provider.enabled)) {
        providerSelect.append(h('option', { value: item.id }, `${item.label}（${item.model || '默认模型'}）`));
      }
    } catch {
      // 没配模型也不影响打开这一页
    }
    await renderSkills();
    void ctx;
  }

  void emptyState;
  return { el, mount: mountView };
}
