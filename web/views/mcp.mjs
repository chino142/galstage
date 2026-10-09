/**
 * MCP 工具页：配置外部工具服务器，连上之后它们会变成写卡助手的技能。
 * 常见用法是接一个文件系统或搜索类的 MCP 服务器，写卡时让助手去查资料。
 */

import { h } from '../core/dom.mjs';
import { get, post, put, del } from '../core/api.mjs';
import { panel, field, loading, errorBox, emptyState, table } from '../ui/components.mjs';
import { toast, toastError } from '../ui/toast.mjs';

export function createMcpView(module, ctx) {
  const el = h('div', { class: 'view' });
  const listHost = h('div', {});
  const detailHost = h('div', {});
  const serverHost = h('div', {});

  const nameInput = h('input', { type: 'text', placeholder: 'filesystem' });
  const commandInput = h('input', { type: 'text', placeholder: 'npx' });
  const argsInput = h('input', { type: 'text', placeholder: '-y @modelcontextprotocol/server-filesystem D:\\\\卡库' });

  const addBtn = h(
    'button',
    {
      class: 'btn primary',
      onclick: async () => {
        const args = argsInput.value.trim() ? argsInput.value.trim().split(/\s+/) : [];
        try {
          await post('/api/mcp/servers', {
            name: nameInput.value.trim() || 'mcp',
            command: commandInput.value.trim(),
            args,
          });
          nameInput.value = '';
          commandInput.value = '';
          argsInput.value = '';
          toast('已保存');
          await render();
        } catch (err) {
          toastError(err);
        }
      },
    },
    '添加服务器',
  );

  el.append(
    panel(
      module.title,
      null,
      h('div', { class: 'panel-note' }, '填一个能通过 stdio 通信的 MCP 服务器命令。连上之后，它的工具会自动出现在「写卡助手」的技能列表里。'),
      h('div', { style: { marginTop: '14px' } }, field('名字', nameInput), field('命令', commandInput), field('参数', argsInput, '用空格分隔')),
      h('div', null, addBtn),
    ),
    listHost,
    detailHost,
    serverHost,
  );

  // ---- 反方向：把酒馆自己暴露成 MCP 服务器（蓝图 3.2）----
  const tryTool = h('select', {});
  const tryArgs = h('textarea', { rows: '3', placeholder: '{"mode":"summary"}' });
  const tryResult = h('pre', { class: 'mono', style: { whiteSpace: 'pre-wrap', maxHeight: '260px', overflow: 'auto', fontSize: '12px' } });

  async function renderServer() {
    serverHost.replaceChildren(loading());
    try {
      const info = await get('/api/mcp/server');
      if (!info.enabled) {
        serverHost.replaceChildren(panel('把酒馆当 MCP 服务器', null, errorBox(new Error('这一版没启用'))));
        return;
      }
      const command = `${info.command} ${info.args.join(' ')}`;
      tryTool.replaceChildren(...info.items.map((tool) => h('option', { value: tool.name }, `${tool.name} —— ${tool.title}`)));
      serverHost.replaceChildren(
        panel(
          '把酒馆当 MCP 服务器',
          `${info.total} 个工具`,
          h('div', { class: 'panel-note' }, '反过来用：让 Codex / Claude Code 这类工具直接读写酒馆。把下面这条命令填进它们的 MCP 配置即可（stdio 传输，不用开端口）。'),
          h('pre', { class: 'mono', style: { margin: '10px 0', whiteSpace: 'pre-wrap' } }, command),
          h('div', { class: 'panel-note' }, `返回模式：${(info.returnModes ?? []).map((mode) => `${mode.id}（${mode.summary}）`).join(' · ')}`),
          table(
            ['工具', '说明', ''],
            info.items.map((tool) => [h('span', { class: 'mono' }, tool.name), tool.title, tool.annotations?.destructiveHint ? h('span', { class: 'chip planned' }, '要确认') : '']),
          ),
          h('div', { style: { marginTop: '14px' } }, h('div', { class: 'panel-note' }, '试一下'), field('工具', tryTool), field('参数（JSON）', tryArgs), h('button', { class: 'btn', onclick: runTool }, '调用'), tryResult),
        ),
      );
    } catch (err) {
      serverHost.replaceChildren(panel('把酒馆当 MCP 服务器', null, errorBox(err, { onRetry: renderServer })));
    }
  }

  async function runTool() {
    try {
      let args = {};
      const raw = tryArgs.value.trim();
      if (raw) {
        try {
          args = JSON.parse(raw);
        } catch {
          toastError(new Error('参数不是合法 JSON'));
          return;
        }
      }
      const result = await post('/api/mcp/server/call', { tool: tryTool.value, args });
      tryResult.replaceChildren(document.createTextNode(`${result.isError ? '[错误] ' : ''}${result.text}`));
    } catch (err) {
      toastError(err);
    }
  }

  async function render() {
    listHost.replaceChildren(loading());
    try {
      const data = await get('/api/mcp/servers');
      if (!data.items.length) {
        listHost.replaceChildren(
          panel('已配置的服务器', '0 个', emptyState({ icon: '🔌', title: '还没有 MCP 服务器', desc: '不加也能用写卡助手，只是少一批外部工具。' })),
        );
        return;
      }
      listHost.replaceChildren(
        panel(
          '已配置的服务器',
          `${data.items.length} 个`,
          ...data.items.map((server) => serverCard(server)),
        ),
      );
    } catch (err) {
      listHost.replaceChildren(panel('已配置的服务器', null, errorBox(err, { onRetry: render })));
    }
  }

  function serverCard(server) {
    const status = server.runtime?.connected ? `已连接 · ${server.runtime.toolCount} 个工具` : '未连接';
    const toolsBox = h('div', {});
    const actions = h(
      'div',
      { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' } },
      h(
        'button',
        {
          class: 'btn',
          onclick: async () => {
            try {
              const result = await post(`/api/mcp/servers/${server.id}/connect`, {});
              toolsBox.replaceChildren(
                table(['工具', '说明'], result.tools.map((tool) => [h('span', { class: 'mono' }, tool.name), tool.description ?? ''])),
              );
              toast(`连上了，${result.tools.length} 个工具`);
              await render();
            } catch (err) {
              toastError(err);
              toolsBox.replaceChildren(h('div', { class: 'panel-note' }, `连接失败：${err.message}`));
            }
          },
        },
        '连接',
      ),
      h(
        'button',
        {
          class: 'btn',
          onclick: async () => {
            await post(`/api/mcp/servers/${server.id}/disconnect`, {});
            toolsBox.replaceChildren();
            await render();
          },
        },
        '断开',
      ),
      h(
        'button',
        {
          class: 'btn',
          onclick: async () => {
            try {
              await put(`/api/mcp/servers/${server.id}`, { enabled: !server.enabled });
              await render();
            } catch (err) {
              toastError(err);
            }
          },
        },
        server.enabled ? '停用' : '启用',
      ),
      h(
        'button',
        {
          class: 'btn',
          onclick: async () => {
            try {
              await del(`/api/mcp/servers/${server.id}`);
              toast('已删除');
              await render();
            } catch (err) {
              toastError(err);
            }
          },
        },
        '删除',
      ),
    );

    if (server.runtime?.tools?.length) {
      toolsBox.append(
        table(['工具', '说明'], server.runtime.tools.map((tool) => [h('span', { class: 'mono' }, tool.name), tool.description ?? ''])),
      );
    }

    return h(
      'div',
      { class: 'tile', style: { marginBottom: '12px' } },
      h('div', { class: 'tile-title' }, server.name, h('span', { class: `chip ${server.runtime?.connected ? 'ready' : 'planned'}` }, status)),
      h('div', { class: 'mono tile-desc' }, `${server.command} ${(server.args ?? []).join(' ')}`),
      actions,
      toolsBox,
    );
  }

  async function mountView() {
    await render();
    await renderServer();
    void ctx;
  }

  return { el, mount: mountView };
}
