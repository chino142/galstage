/**
 * 通用占位视图。
 *
 * 还没实现的模块用它：显示说明、状态、计划清单、接口路径，
 * 另外能顺手把服务端已经有的"元数据"拉下来显示（例如提示词的阶段表），
 * 这样界面看上去不是一片空白，也证明接口是通的。
 */

import { h, statusChip } from '../core/dom.mjs';
import { get } from '../core/api.mjs';
import { panel, planList, paths, loading, errorBox, emptyState } from '../ui/components.mjs';

const DETAILS = {
  prompts: [{ title: '提示词管线的阶段', url: '/api/prompts/stages', line: (item) => `${item.title} —— ${item.note}` }],
  'prompt-xray': [{ title: '快照结构', url: '/api/chats/stream-protocol', line: (item) => `事件类型：${item}` }],
  memory: [{ title: '记忆的三层结构', url: '/api/memory/layers', line: (item) => `${item.title} —— ${item.summary}` }],
  vectors: [{ title: '四类向量集合', url: '/api/vectors/collections', line: (item) => item.title }],
  'card-frontend': [
    { title: '卡内脚本可用的能力', url: '/api/frontend/capabilities', line: (item) => `${item.title}（风险：${item.risk}）` },
    { title: '主题变量', url: '/api/frontend/theme-tokens', line: (item) => `${item.id} —— ${item.label}，默认 ${item.default}` },
  ],
  providers: [
    {
      title: '提供方类型',
      url: '/api/providers',
      pick: (data) => data.kinds,
      line: (item) => `${item.title}：${item.providers.map((p) => p.label).join(' / ')}`,
    },
  ],
  worldbook: [],
  chat: [{ title: '流式事件协议', url: '/api/chats/stream-protocol', line: (item) => `事件类型：${item}` }],
};

export function createPlaceholderView(module, ctx) {
  const el = h('div', { class: 'view' });
  const detailHost = h('div', {});

  el.append(
    panel(
      module.title,
      null,
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
        statusChip(module.status),
        h('span', { class: 'panel-note' }, module.summary),
      ),
      module.api?.length
        ? h('div', { style: { marginTop: '12px' } }, h('div', { class: 'panel-note' }, '接口'), paths(module.api))
        : null,
      module.blueprint
        ? h('div', { class: 'panel-note', style: { marginTop: '10px' } }, `对应功能蓝图 第 ${module.blueprint} 节`)
        : null,
    ),
    module.plan?.length ? panel('计划实现的内容', `${module.plan.length} 项`, planList(module.plan)) : null,
    detailHost,
  );

  async function mount() {
    const sources = DETAILS[module.web?.view] ?? [];
    if (!sources.length) {
      detailHost.append(
        panel('当前状态', null, emptyState({ icon: '🚧', title: '这是骨架', desc: '接口已经定好，功能还没写。' })),
      );
      return;
    }
    detailHost.append(loading());
    for (const source of sources) {
      try {
        const data = await get(source.url);
        const items = source.pick ? source.pick(data) : (data.items ?? []);
        detailHost.replaceChildren(
          ...(detailHost.querySelectorAll('.panel')),
          panel(
            source.title,
            `${items.length} 条`,
            items.length
              ? h('ul', { class: 'plan-list' }, items.map((item) => h('li', {}, source.line(item))))
              : emptyState({ icon: '🌾', title: '还没有数据' }),
          ),
        );
      } catch (err) {
        detailHost.append(panel(source.title, null, errorBox(err)));
      }
    }
    const stale = detailHost.querySelector('.empty');
    if (stale && detailHost.querySelectorAll('.panel').length > sources.length) stale.remove();
    void ctx;
  }

  return { el, mount };
}
