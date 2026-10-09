/**
 * ComfyUI 页：连地址、导入工作流、标可填参数、看队列与进度、手动出一张图。
 *
 * 服务没开的时候不报错、不弹栈：连接区显示"ComfyUI 未启动 + 原因"，
 * "出一张图"按钮直接禁用（蓝图 3.1 的加分项，也是最基本的体验）。
 */

import { h, statusChip } from '../core/dom.mjs';
import { get, post, put, del } from '../core/api.mjs';
import { panel, field, loading, errorBox, emptyState } from '../ui/components.mjs';
import { confirmDialog } from '../ui/modal.mjs';
import { toast, toastError } from '../ui/toast.mjs';
import { clientQueue, runClientImage, runPendingClientRuns, testComfyBrowser } from '../ui/comfy-client.mjs';
import { openImageViewer } from './playing-common.mjs';

const TRIGGER_LABEL = { manual: '手动', marker: '标记触发', auto: '场景变化自动' };
const MODE_LABEL = { server: '服务器执行', client: '浏览器直连' };
const STATUS_LABEL = {
  queued: '排队中',
  running: '进行中',
  'pending-client': '待浏览器执行',
  done: '已完成',
  error: '失败',
  cancelled: '已取消',
};

export function createComfyView(module) {
  const el = h('div', { class: 'view' });
  const connectHost = h('div', {});
  const launchHost = h('div', {});
  const workflowHost = h('div', {});
  const liveHost = h('div', {});
  const extraHost = h('div', {});

  const status = { config: null, ok: false, error: null, queue: null, mode: 'server' };
  const launch = { status: null, busy: false };
  const inputs = {
    enabled: h('input', { type: 'checkbox' }),
    executionMode: h('select', {}),
    baseUrl: h('input', { type: 'text', placeholder: 'http://127.0.0.1:8188' }),
    trigger: h('select', {}),
    marker: h('input', { type: 'text', placeholder: '[IMG:' }),
    autoStart: h('input', { type: 'checkbox' }),
    launchCommand: h('input', { type: 'text', placeholder: 'E:\\ComfyUI-WorkFisher-V2\\python\\python.exe' }),
    launchArgs: h('input', { type: 'text', placeholder: 'main.py --listen 127.0.0.1 --port 8188 --disable-auto-launch' }),
    launchCwd: h('input', { type: 'text', placeholder: 'E:\\ComfyUI-WorkFisher-V2\\ComfyUI' }),
    idleStop: h('input', { type: 'number', min: '0', max: '1440' }),
    name: h('input', { type: 'text', placeholder: '立绘' }),
    kind: h('select', {}),
    seed: h('input', { type: 'text', placeholder: '固定种子（留空则不固定）' }),
    json: h('textarea', { rows: '6', placeholder: '把 ComfyUI 里「Export (API)」出来的 JSON 粘进来' }),
  };

  el.append(
    panel(
      module.title,
      null,
      h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } }, statusChip(module.status), h('span', { class: 'panel-note' }, module.summary)),
    ),
    connectHost,
    launchHost,
    workflowHost,
    liveHost,
    extraHost,
  );

  const extra = { cards: [], assets: [], bindings: [], expressions: [], workflows: [], loaded: false };

  function renderConnect() {
    if (!status.config) return;
    const conf = status.config.settings ?? {};
    const mode = conf['comfy.executionMode'] ?? 'server';
    const isClient = mode === 'client';
    inputs.enabled.checked = Boolean(conf['comfy.enabled']);
    inputs.executionMode.replaceChildren(
      ...(status.config.executionModes ?? [{ id: 'server', title: MODE_LABEL.server }, { id: 'client', title: MODE_LABEL.client }]).map((item) =>
        h('option', { value: item.id }, item.title),
      ),
    );
    inputs.executionMode.value = mode;
    inputs.baseUrl.value = conf['comfy.baseUrl'] ?? '';
    inputs.marker.value = conf['comfy.marker'] ?? '[IMG:';
    inputs.kind.replaceChildren(...(status.config.kinds ?? []).map((kind) => h('option', { value: kind.id }, `${kind.title}（${kind.workflows}）`)));
    inputs.trigger.replaceChildren(
      ...['manual', 'marker', 'auto'].map((id) => h('option', { value: id }, TRIGGER_LABEL[id])),
    );
    inputs.trigger.value = conf['comfy.trigger'] ?? 'manual';

    const verdict = status.ok
      ? h('span', { class: 'chip ready' }, isClient ? '浏览器已连上' : '已连接')
      : h('span', { class: 'chip planned' }, isClient ? '浏览器未连上' : '未连接');

    const modeHelp = isClient
      ? '浏览器直连：由你自己这台机器的浏览器去连 ComfyUI，主机不会向这个地址发任何请求（多用户模式下别人的 ComfyUI 不需要主机能访问）。需要 ComfyUI 以 --enable-cors-header 启动。半自动 / 全自动触发的出图会先记成「待浏览器执行」，你打开着页面时自动跑，没打开就一直挂着。'
      : '服务器执行：由主机进程去连这个地址。这个地址由服务器访问 —— 多用户模式下等于「主机要能连到它」，填内网地址会让主机的网络被探测。';

    connectHost.replaceChildren(
      panel(
        '连接',
        null,
        h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '10px' } }, verdict, h('span', { class: 'panel-note mono' }, status.config.settings?.['comfy.baseUrl'] ?? '')),
        !status.ok && status.error ? h('div', { class: 'panel-note' }, `ComfyUI 未启动或连不上：${status.error}`) : null,
        h('div', { class: 'panel-note' }, modeHelp),
        h(
          'div',
          { class: 'grid', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '10px' } },
          field('启用 ComfyUI', inputs.enabled),
          field('连接方式', inputs.executionMode, isClient ? '多用户模式默认「浏览器直连」' : '地址由服务器访问'),
          field('地址', inputs.baseUrl, isClient ? '由你的浏览器访问，例如 http://127.0.0.1:8188' : '由服务器访问，本地一般是 http://127.0.0.1:8188'),
          field('出图触发方式', inputs.trigger, '标记触发：回复里出现 [IMG: 提示词] 就出图'),
          field('标记', inputs.marker),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' } },
          h('button', { class: 'btn primary', onclick: saveConfig }, '保存'),
          h('button', { class: 'btn', onclick: testConnection }, '测试连接'),
          status.queue ? h('span', { class: 'panel-note' }, `队列：运行 ${status.queue.running ?? 0} · 排队 ${status.queue.pending ?? 0}`) : null,
        ),
      ),
    );
  }

  async function saveConfig() {
    try {
      await put('/api/comfy/config', {
        'comfy.enabled': Boolean(inputs.enabled.checked),
        'comfy.executionMode': inputs.executionMode.value,
        'comfy.baseUrl': inputs.baseUrl.value.trim(),
        'comfy.trigger': inputs.trigger.value,
        'comfy.marker': inputs.marker.value,
      });
      toast('已保存');
      await refreshStatus();
      void refreshLauncher();
      void refreshExtra();
    } catch (err) {
      toastError(err);
    }
  }

  async function testConnection() {
    try {
      const mode = inputs.executionMode.value;
      const result =
        mode === 'client'
          ? await testComfyBrowser(inputs.baseUrl.value.trim())
          : await post('/api/comfy/test', { baseUrl: inputs.baseUrl.value.trim() });
      if (result.ok) {
        toast(`连上了：ComfyUI ${result.stats?.comfyuiVersion ?? ''}`.trim());
        // 连上之后要把"出一张图"的按钮解禁，所以顺手刷一次状态
        await refreshStatus();
      } else {
        toastError(new Error(result.error ?? '连不上'));
      }
    } catch (err) {
      toastError(err);
    }
  }

  // ------------------------------------------------------------------ 启动托管

  /**
   * 让酒馆自己在后台把 ComfyUI 拉起来。
   * 已经开着的（不管是启动器开的还是别处开的）一律不动它 —— 托管只停自己拉起来的那一份。
   */
  function renderLaunch() {
    if (!status.config) return;
    const available = status.config.launcher?.available !== false;
    if (!available) {
      launchHost.replaceChildren(
        panel('启动 ComfyUI（酒馆托管）', null, h('div', { class: 'panel-note' }, '多用户模式下只有管理员能配置 / 启动本地 ComfyUI。')),
      );
      return;
    }
    const conf = status.config.settings ?? {};
    const info = launch.status;
    if (!launch.busy) {
      inputs.autoStart.checked = Boolean(conf['comfy.autoStart']);
      inputs.launchCommand.value = conf['comfy.launcher.command'] ?? '';
      inputs.launchArgs.value = conf['comfy.launcher.args'] ?? '';
      inputs.launchCwd.value = conf['comfy.launcher.cwd'] ?? '';
      inputs.idleStop.value = String(conf['comfy.idleStopMinutes'] ?? 15);
    }

    const mine = Boolean(info?.running);
    const external = !mine && Boolean(status.ok);
    const chip = launch.busy
      ? h('span', { class: 'chip partial' }, '正在启动…（第一次要等十几秒到一分钟）')
      : info?.starting
        ? h('span', { class: 'chip partial' }, '正在启动…')
        : mine
          ? h('span', { class: 'chip ready' }, info?.ready ? '酒馆拉起来的 · 就绪' : '酒馆拉起来的 · 还在起')
          : external
            ? h('span', { class: 'chip planned' }, '已经有一份在跑了（托管不碰它）')
            : h('span', { class: 'chip planned' }, '没在跑');

    const logs = (info?.logs ?? []).slice(-8);
    launchHost.replaceChildren(
      panel(
        '启动 ComfyUI（酒馆托管）',
        mine && info?.pid ? `PID ${info.pid}` : null,
        h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '8px' } }, chip),
        h(
          'div',
          { class: 'panel-note' },
          conf['comfy.launcher.command']
            ? '配好命令后，酒馆能替你把这台机器上的 ComfyUI 在后台拉起来（不弹它的界面）。开着的时候你就不用去点启动器了。'
            : '填好下面三条就能用：装了整合包的话，命令是包里的 python.exe，参数是 main.py --listen 127.0.0.1 --port 8188 --disable-auto-launch（最后那个是不弹浏览器），工作目录是包里的 ComfyUI 文件夹。',
        ),
        h(
          'div',
          { class: 'grid', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '10px' } },
          field('启动命令', inputs.launchCommand, '一般是 <包目录>\\python\\python.exe；留空 = 不托管'),
          field('启动参数', inputs.launchArgs, '空格分隔；带空格的路径用引号包起来'),
          field('工作目录', inputs.launchCwd, 'main.py 所在目录'),
          field('闲置多久自动停（分钟）', inputs.idleStop, '0 = 一直留着；只停酒馆自己拉起来的那份'),
        ),
        h('div', { style: { marginTop: '6px' } }, field('出图前自动拉起', inputs.autoStart, '打开后连不上就自动拉，不用手动点')),
        h(
          'div',
          { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' } },
          h('button', { class: 'btn primary', disabled: launch.busy, onclick: startComfy }, launch.busy ? '正在启动…' : '启动 ComfyUI'),
          h('button', { class: 'btn', disabled: !mine || launch.busy, onclick: stopComfy }, '停掉（把显存还回去）'),
          h('button', { class: 'btn', disabled: launch.busy, onclick: saveLaunchConfig }, '保存设置'),
          h('button', { class: 'btn', onclick: refreshLauncher }, '刷新状态'),
        ),
        logs.length ? h('div', { class: 'mono', style: { marginTop: '8px', fontSize: '11.5px', maxHeight: '120px', overflow: 'auto', opacity: '0.8' } }, ...logs.map((line) => h('div', {}, line))) : null,
      ),
    );
  }

  async function refreshLauncher() {
    if (!status.config || status.config.launcher?.available === false) {
      renderLaunch();
      return;
    }
    try {
      const data = await get('/api/comfy/launcher');
      launch.status = data?.status ?? null;
    } catch {
      launch.status = null;
    }
    renderLaunch();
  }

  async function saveLaunchConfig() {
    try {
      await put('/api/comfy/config', {
        'comfy.autoStart': Boolean(inputs.autoStart.checked),
        'comfy.launcher.command': inputs.launchCommand.value.trim(),
        'comfy.launcher.args': inputs.launchArgs.value.trim(),
        'comfy.launcher.cwd': inputs.launchCwd.value.trim(),
        'comfy.idleStopMinutes': Number(inputs.idleStop.value === '' ? 15 : inputs.idleStop.value),
      });
      toast('启动设置已保存');
      await refreshStatus();
      await refreshLauncher();
    } catch (err) {
      toastError(err);
    }
  }

  async function startComfy() {
    launch.busy = true;
    renderLaunch();
    try {
      const result = await post('/api/comfy/launch', {});
      toast(
        result?.mine
          ? '已经在跑了'
          : result?.external
            ? '端口上已经有一份 ComfyUI 了，直接用'
            : 'ComfyUI 已经起来了',
      );
    } catch (err) {
      toastError(err);
    } finally {
      launch.busy = false;
      await refreshStatus();
      // 工作流卡片是拿 status.ok 决定「出一张图」能不能点的：启动完必须重画一遍，
      // 否则按钮会一直是灰的（要等下一次别的刷新才亮）。
      await refreshWorkflows();
      await refreshLauncher();
    }
  }

  async function stopComfy() {
    try {
      const result = await post('/api/comfy/stop', {});
      toast(result?.stopped ? '已停掉' : '这份不是酒馆拉起来的，没动它');
    } catch (err) {
      toastError(err);
    } finally {
      await refreshStatus();
      await refreshWorkflows();
      await refreshLauncher();
    }
  }

  // ------------------------------------------------------------------ 工作流

  // ------------------------------------------------------------------ LoRA（清单 + 组合 + 切换）

  const loraState = { available: [], sets: [], activeId: '', draft: [], loaded: false, loading: false, error: null };
  const loraName = h('input', { type: 'text', placeholder: '组合名字，比如「阿狸 + 赛璐璐」' });
  const loraPick = h('select', {});
  const loraManual = h('input', { type: 'text', placeholder: '清单拉不到时，手动填 LoRA 文件名' });
  const loraBody = h('div', {});

  function draftRows() {
    return loraState.draft.map((item, index) => {
      const model = h('input', { type: 'number', value: String(item.strengthModel ?? 1), step: '0.05', style: { width: '76px' }, oninput: (event) => { item.strengthModel = Number(event.target.value); } });
      const clip = h('input', { type: 'number', value: String(item.strengthClip ?? 1), step: '0.05', style: { width: '76px' }, oninput: (event) => { item.strengthClip = Number(event.target.value); } });
      const trigger = h('input', { type: 'text', value: item.trigger ?? '', placeholder: '触发词（可留空）', oninput: (event) => { item.trigger = event.target.value; } });
      return h(
        'div',
        { class: 'binding-row', style: { display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' } },
        h('div', { style: { flex: '1 1 220px' } }, field('LoRA', h('div', { class: 'mono' }, item.name))),
        field('模型权重', model),
        field('CLIP 权重', clip),
        h('div', { style: { flex: '1 1 200px' } }, field('触发词', trigger)),
        h('button', { class: 'link-btn', style: { marginBottom: '6px' }, onclick: () => { loraState.draft.splice(index, 1); renderLoras(); } }, '删掉'),
      );
    });
  }

  async function saveLoraSetRequest(body) {
    try {
      await post('/api/comfy/lora-sets', body);
      toast(`已保存组合「${body.name}」`);
      loraName.value = '';
      await refreshLoras();
    } catch (err) {
      toastError(err);
    }
  }

  function saveLoraSet() {
    if (!loraState.draft.length) {
      toast('先挑几个 LoRA', { tone: 'warn' });
      return;
    }
    void saveLoraSetRequest({ name: loraName.value.trim() || `组合 ${loraState.sets.length + 1}`, loras: loraState.draft });
  }

  async function setActiveLora(id) {
    try {
      const result = await put('/api/comfy/lora-active', { id });
      loraState.activeId = result.activeId ?? '';
      renderLoras();
      toast(id ? '出图时会套用这套 LoRA' : '已改成不用 LoRA');
    } catch (err) {
      toastError(err);
    }
  }

  async function removeLoraSet(id) {
    const ok = await confirmDialog({ title: '删除组合', message: '删掉这套 LoRA 组合？', confirmLabel: '删除' });
    if (!ok) return;
    try {
      await del(`/api/comfy/lora-sets/${id}`);
      if (loraState.activeId === id) loraState.activeId = '';
      await refreshLoras();
    } catch (err) {
      toastError(err);
    }
  }

  function addLoraToDraft(name) {
    const clean = String(name ?? '').trim();
    if (!clean) return;
    if (loraState.draft.some((item) => item.name === clean)) {
      toast('这个已经在草稿里了', { tone: 'warn' });
      return;
    }
    loraState.draft.push({ name: clean, strengthModel: 1, strengthClip: 1, trigger: '', enabled: true });
    renderLoras();
  }

  function renderLoras() {
    const clientMode = inputs.executionMode.value === 'client';
    const activeSet = loraState.sets.find((item) => item.id === loraState.activeId) ?? null;
    loraBody.replaceChildren(
      h('div', { class: 'panel-note' }, clientMode
        ? '浏览器直连模式：清单由浏览器自己去问 ComfyUI，这里的组合照样能存、能选。'
        : `这台 ComfyUI 上认到 ${loraState.available.length} 个 LoRA${loraState.error ? `（拉不到：${loraState.error}）` : ''}。`),
      h('div', { class: 'hint', style: { marginTop: '6px' } }, 'ComfyUI 的 LoRA 不是请求参数、是要插进工作流的节点 —— 这里选好之后，出图前自动往工作流里插 LoraLoader。'),
      h(
        'div',
        { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginTop: '10px' } },
        h('button', { class: 'btn', onclick: () => void refreshLoras() }, '↻ 刷新清单与组合'),
        h('span', { class: 'hint' }, '出图时用：'),
        loraPick,
        h('button', { class: 'btn primary', onclick: () => void setActiveLora(loraPick.value) }, '设为当前'),
      ),
      activeSet
        ? h('div', { class: 'hint', style: { marginTop: '6px' } }, `当前：${activeSet.name} —— ${(activeSet.loras ?? []).map((item) => `${item.name}${Number(item.strengthModel) === 1 ? '' : `@${item.strengthModel}`}`).join('、')}`)
        : h('div', { class: 'hint', style: { marginTop: '6px' } }, '当前：不用 LoRA。'),
      h('div', { class: 'hint', style: { marginTop: '14px' } }, '编辑中的组合：'),
      ...(loraState.draft.length ? draftRows() : [h('div', { class: 'panel-note' }, '还没挑 LoRA。从下面选一个加进来。')]),
      h(
        'div',
        { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginTop: '10px' } },
        loraPick,
        h('button', { class: 'btn', onclick: () => addLoraToDraft(loraPick.value) }, '＋ 加入草稿'),
        loraManual,
        h('button', { class: 'btn', onclick: () => { addLoraToDraft(loraManual.value); loraManual.value = ''; } }, '＋ 手动加入'),
      ),
      h(
        'div',
        { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginTop: '10px' } },
        loraName,
        h('button', { class: 'btn primary', onclick: () => void saveLoraSet() }, '💾 保存为组合'),
        h('button', { class: 'btn', onclick: () => { loraState.draft = []; renderLoras(); } }, '清空草稿'),
      ),
      loraState.sets.length
        ? h(
            'div',
            { style: { marginTop: '14px', display: 'grid', gap: '6px' } },
            h('div', { class: 'hint' }, '已保存的组合：'),
            ...loraState.sets.map((set) =>
              h(
                'div',
                { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
                h('span', { class: `chip small ${set.id === loraState.activeId ? 'ready' : ''}` }, set.id === loraState.activeId ? '当前' : `${(set.loras ?? []).length} 个`),
                h('b', {}, set.name),
                h('button', { class: 'btn small', onclick: () => { loraState.draft = (set.loras ?? []).map((item) => ({ ...item })); renderLoras(); } }, '载入到草稿'),
                set.id === loraState.activeId
                  ? h('button', { class: 'btn small', onclick: () => void setActiveLora('') }, '取消当前')
                  : h('button', { class: 'btn small primary', onclick: () => void setActiveLora(set.id) }, '设为当前'),
                h('button', { class: 'link-btn', onclick: () => void removeLoraSet(set.id) }, '删掉'),
              ),
            ),
          )
        : null,
    );
  }

  async function refreshLoras() {
    loraState.loading = true;
    renderLoras();
    try {
      const [list, sets] = await Promise.all([
        get('/api/comfy/loras').catch((err) => ({ items: [], error: err?.message ?? String(err) })),
        get('/api/comfy/lora-sets').catch(() => ({ items: [], activeId: '' })),
      ]);
      loraState.available = list.items ?? [];
      loraState.error = list.error ?? null;
      loraState.sets = sets.items ?? [];
      loraState.activeId = sets.activeId ?? '';
      loraState.loaded = true;
      loraPick.replaceChildren(
        ...(loraState.available.length
          ? loraState.available.map((name) => h('option', { value: name }, name))
          : [h('option', { value: '' }, loraState.error ? '（清单拉不到，手动填）' : '（这台机器上没有 LoRA）')]),
      );
    } finally {
      loraState.loading = false;
      renderLoras();
    }
  }

  function loraPanel() {
    if (!loraState.loaded && !loraState.loading) void refreshLoras();
    return panel('LoRA', `${loraState.sets.length} 套组合`, loraBody);
  }

  // ------------------------------------------------------------------ 提示词加工（词替换 + 风格预设 + 质量词）

  const kitState = {
    loaded: false,
    draft: { replacements: [], styles: [], activeStyleId: '', quality: { enabled: false, positive: '', negative: '' } },
  };
  const kitBody = h('div', {});

  async function refreshKit() {
    try {
      const kit = await get('/api/comfy/prompt-kit');
      kitState.draft = {
        replacements: (kit.replacements ?? []).map((item) => ({ ...item })),
        styles: (kit.styles ?? []).map((item) => ({ ...item })),
        activeStyleId: kit.activeStyleId ?? '',
        quality: { ...(kit.quality ?? { enabled: false, positive: '', negative: '' }) },
      };
      kitState.loaded = true;
    } catch (err) {
      toastError(err);
    }
    renderKit();
  }

  async function saveKit() {
    try {
      const saved = await put('/api/comfy/prompt-kit', kitState.draft);
      kitState.draft = {
        replacements: (saved.replacements ?? []).map((item) => ({ ...item })),
        styles: (saved.styles ?? []).map((item) => ({ ...item })),
        activeStyleId: saved.activeStyleId ?? '',
        quality: { ...(saved.quality ?? kitState.draft.quality) },
      };
      renderKit();
      toast('加工台已保存：出图时会按它加工提示词');
    } catch (err) {
      toastError(err);
    }
  }

  function renderKit() {
    const d = kitState.draft;
    const styleRows = d.styles.map((style, index) =>
      h(
        'div',
        { class: 'binding-row', style: { display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap', marginTop: '8px' } },
        h('div', { style: { flex: '1 1 160px' } }, field('风格名', h('input', { type: 'text', value: style.name, oninput: (e) => { style.name = e.target.value; } }))),
        h('div', { style: { flex: '2 1 240px' } }, field('正向', h('input', { type: 'text', value: style.positive, oninput: (e) => { style.positive = e.target.value; } }))),
        h('div', { style: { flex: '2 1 240px' } }, field('负向', h('input', { type: 'text', value: style.negative, oninput: (e) => { style.negative = e.target.value; } }))),
        h(
          'div',
          { style: { marginBottom: '6px', display: 'flex', gap: '6px' } },
          h('button', { class: `btn small ${d.activeStyleId === style.id ? 'primary' : ''}`, onclick: () => { d.activeStyleId = d.activeStyleId === style.id ? '' : style.id; renderKit(); } }, d.activeStyleId === style.id ? '当前' : '设为当前'),
          h('button', { class: 'link-btn', onclick: () => { d.styles.splice(index, 1); if (d.activeStyleId === style.id) d.activeStyleId = ''; renderKit(); } }, '删掉'),
        ),
      ),
    );
    const ruleRows = d.replacements.map((rule, index) =>
      h(
        'div',
        { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px', flexWrap: 'wrap' } },
        h('input', { type: 'text', value: rule.from, placeholder: '替换掉', style: { width: '140px' }, oninput: (e) => { rule.from = e.target.value; } }),
        h('span', { class: 'hint' }, '→'),
        h('input', { type: 'text', value: rule.to, placeholder: '换成', style: { flex: '1 1 200px' }, oninput: (e) => { rule.to = e.target.value; } }),
        h('button', { class: 'link-btn', onclick: () => { d.replacements.splice(index, 1); renderKit(); } }, '删掉'),
      ),
    );
    kitBody.replaceChildren(
      h('div', { class: 'panel-note' }, '出图前对**工作流自己的正 / 负提示词**做三件事：把聊天里的词换成绘画 tag、套一套画风、加一段保底质量词。都不覆盖工作流原来的提示词，角色 LoRA 触发词、场景描写都还在。'),
      h(
        'label',
        { style: { display: 'flex', gap: '6px', alignItems: 'center', marginTop: '10px', cursor: 'pointer' } },
        h('input', { type: 'checkbox', checked: d.quality.enabled, onchange: (e) => { d.quality.enabled = e.target.checked; renderKit(); } }),
        '加质量词（保底正 / 负词）',
      ),
      d.quality.enabled
        ? h(
            'div',
            { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '6px' } },
            h('div', { style: { flex: '1 1 260px' } }, field('正向质量词', h('input', { type: 'text', value: d.quality.positive, oninput: (e) => { d.quality.positive = e.target.value; } }))),
            h('div', { style: { flex: '1 1 260px' } }, field('负向质量词', h('input', { type: 'text', value: d.quality.negative, oninput: (e) => { d.quality.negative = e.target.value; } }))),
          )
        : null,
      h('div', { class: 'hint', style: { marginTop: '14px' } }, '画风预设（一次换整套正 / 负词）：'),
      ...(styleRows.length ? styleRows : [h('div', { class: 'panel-note' }, '还没有预设。下面加一个。')]),
      h('button', { class: 'btn', style: { marginTop: '8px' }, onclick: () => { d.styles.push({ id: `style-${Date.now().toString(36)}`, name: '新画风', positive: '', negative: '' }); renderKit(); } }, '＋ 加一套画风'),
      h('div', { class: 'hint', style: { marginTop: '14px' } }, '词替换（把聊天里的词换成绘画 tag）：'),
      ...(ruleRows.length ? ruleRows : [h('div', { class: 'panel-note' }, '还没有替换规则。比如「马尾 → ponytail」。')]),
      h('button', { class: 'btn', style: { marginTop: '8px' }, onclick: () => { d.replacements.push({ from: '', to: '' }); renderKit(); } }, '＋ 加一条替换'),
      h(
        'div',
        { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '12px' } },
        h('button', { class: 'btn primary', onclick: () => void saveKit() }, '💾 保存加工台'),
        h('span', { class: 'hint' }, '保存后：手动出图 / 标记触发 / 自动出图都会按它加工'),
      ),
    );
  }

  function kitPanel() {
    if (!kitState.loaded) void refreshKit();
    return panel('提示词加工', '词替换 + 画风 + 质量词', kitBody);
  }

  function renderWorkflows(workflows, presets = []) {
    const importBox = h(
      'div',
      {},
      field('名字', inputs.name),
      field('用途', inputs.kind),
      field('固定种子', inputs.seed, '同一个角色出一致的图，靠这个'),
      field('工作流 JSON', inputs.json, '在 ComfyUI 里用 Workflow → Export (API) 导出'),
      h('button', { class: 'btn primary', onclick: importWorkflow }, '导入工作流'),
    );

    // 内置示例：一键添加，改一下模型名（ckpt_name）就能用
    const derivePick = h('select', {}, ...workflows.map((workflow) => h('option', { value: workflow.id }, workflow.name)));
    derivePick.value = workflows[0]?.id ?? '';
    const deriveBlock = h(
      'div',
      { style: { marginTop: '12px', paddingTop: '10px', borderTop: '1px solid var(--st-border)' } },
      h('div', { class: 'hint' }, '模型有两种装法：① 一体化 checkpoint（SD1.5 / SDXL，上面示例用的就是这种）；② 拆开加载（UNETLoader + CLIPLoader + VAELoader，Flux / Qwen 系那种）。你这台要是没有 checkpoint，就选一份自己已经能跑的工作流当母版，按它生成一套。'),
      h(
        'div',
        { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginTop: '6px' } },
        derivePick,
        h('button', { class: 'btn primary', disabled: !workflows.length, onclick: () => void derivePresets(derivePick.value) }, '⬇ 按它为母版生成预设'),
      ),
    );
    const presetBox = h(
      'div',
      {},
      h('div', { class: 'hint', style: { marginBottom: '8px' } }, '最简骨架工作流，加完把 CheckpointLoaderSimple 的模型名改成你机器上的那个。'),
      ...presets.map((preset) =>
        h(
          'div',
          { class: 'tile', style: { marginBottom: '10px' } },
          h('div', { class: 'tile-title' }, preset.title, h('span', { class: 'chip ready' }, preset.kind)),
          h('div', { class: 'mono tile-desc' }, preset.summary),
          h(
            'div',
            { class: 'panel-note' },
            `${preset.nodeCount} 个节点 · 占位符：${preset.placeholders?.length ? preset.placeholders.map((key) => `{{${key}}}`).join(' ') : '（无）'}`,
          ),
          h('button', { class: 'btn primary', onclick: () => addPreset(preset) }, preset.installed ? '再加一份' : '一键添加示例工作流'),
        ),
      ),
      deriveBlock,
    );

    workflowHost.replaceChildren(
      panel('示例工作流', `${presets.length} 个内置`, presetBox),
      panel('工作流', `${workflows.length} 个`, importBox),
      panel(
        '已导入',
        `${workflows.length} 个`,
        workflows.length
          ? h('div', {}, ...workflows.map((workflow) => workflowCard(workflow)))
          : emptyState({ icon: '🧩', title: '还没有工作流', desc: '先把上面那段 API 格式 JSON 粘进来。' }),
      ),
      loraPanel(),
      kitPanel(),
    );
  }

  async function addPreset(preset) {
    try {
      const created = await post(`/api/comfy/presets/${preset.id}`, {});
      toast(`已添加「${created.name}」：记得把模型名改成你自己的`);
      await refreshWorkflows();
      await refreshStatus();
    } catch (err) {
      toastError(err);
    }
  }

  /** 按一份已有工作流的模型来源，生成一套跟本机对得上的预设。 */
  async function derivePresets(workflowId) {
    if (!workflowId) {
      toast('先选一份母版工作流', { tone: 'warn' });
      return;
    }
    try {
      const result = await post('/api/comfy/presets/derive', { workflowId });
      toast(`按「${result.sourceName}」生成了 ${result.items.length} 套预设（${result.style === 'split' ? '拆开加载' : '一体化'}）`);
      await refreshWorkflows();
      await refreshStatus();
    } catch (err) {
      toastError(err);
    }
  }

  /**
   * 正向 / 负向提示词。
   *
   * 值来自工作流里采样器正负条件连到的那个 CLIPTextEncode（服务端算好放在 workflow.prompts 里），
   * 所以这里改的就是 ComfyUI 里那两个文本编码框本身，不是另存一份。
   * 工作流里找不到可填文本节点时整块不显示。
   */
  function promptBlock(workflow) {
    const positive = workflow.prompts?.positive ?? null;
    const negative = workflow.prompts?.negative ?? null;
    if (!positive && !negative) return null;
    const editor = (slot, label, placeholder) => {
      if (!slot) return null;
      const input = h('textarea', { rows: '3', placeholder });
      input.value = slot.value ?? '';
      return { slot, input, node: field(label, input, `写进 ${slot.classType} #${slot.nodeId}`) };
    };
    const pos = editor(positive, '正向提示词', '想让画面里出现什么');
    const neg = editor(negative, '负向提示词', '不想让画面里出现什么');
    const entries = [pos, neg].filter(Boolean);
    return h(
      'div',
      { style: { marginTop: '10px' } },
      h(
        'div',
        { class: 'tile-title' },
        '提示词',
        h('span', { class: 'chip partial' }, `节点 ${[positive?.nodeId, negative?.nodeId].filter(Boolean).join(' / ')}`),
      ),
      h(
        'div',
        { class: 'panel-note' },
        '就是工作流里那两个文本编码框，改了在这里回车保存即可。自动 / 标记触发出图时，角色的场景描述会接在正向提示词后面。',
      ),
      ...entries.map((entry) => entry.node),
      h(
        'button',
        { class: 'btn primary', style: { marginTop: '8px' }, onclick: () => savePrompts(workflow, entries) },
        '保存提示词',
      ),
    );
  }

  /** 提示词存成绑定值（没有绑定就现加一条），出图时和普通参数走同一条路。 */
  async function savePrompts(workflow, entries) {
    try {
      const bindings = (workflow.bindings ?? []).map((binding) => ({ ...binding }));
      for (const { slot, input } of entries) {
        const value = input.value;
        const found = bindings.find((binding) => binding.nodeId === slot.nodeId && binding.input === slot.input);
        if (found) found.value = value;
        else
          bindings.push({
            nodeId: slot.nodeId,
            input: slot.input,
            label: `${slot.classType}.${slot.input}`,
            type: 'text',
            value,
            enabled: true,
          });
      }
      await put(`/api/comfy/workflows/${workflow.id}`, { bindings });
      toast('提示词已保存');
      await refreshWorkflows();
    } catch (err) {
      toastError(err);
    }
  }

  function workflowCard(workflow) {
    const bindingsBox = h('div', {});
    const toggleBindings = h(
      'button',
      { class: 'btn', onclick: () => toggleBindingPanel(workflow, bindingsBox) },
      `参数（${(workflow.bindings ?? []).length}）`,
    );

    const seedInput = h('input', { type: 'text', value: workflow.seed === null || workflow.seed === undefined ? '' : String(workflow.seed) });
    const canRun = status.ok;

    return h(
      'div',
      { class: 'tile', style: { marginBottom: '12px' } },
      h(
        'div',
        { class: 'tile-title' },
        workflow.name,
        h('span', { class: 'chip ready' }, workflow.kind),
        workflow.placeholders?.length ? h('span', { class: 'panel-note' }, `占位符：${workflow.placeholders.map((key) => `{{${key}}}`).join(' ')}`) : null,
      ),
      h('div', { class: 'mono tile-desc' }, `${workflow.nodeCount} 个节点 · ${(workflow.bindings ?? []).length} 个可填参数`),
      promptBlock(workflow),
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'end', marginTop: '10px' } },
        field('固定种子', seedInput),
        h('button', { class: 'btn', onclick: () => saveSeed(workflow, seedInput.value) }, '存种子'),
        toggleBindings,
        h('button', { class: 'btn primary', disabled: !canRun, onclick: () => runWorkflow(workflow) }, '出一张图'),
        h('button', { class: 'btn', onclick: () => toggleEnabled(workflow) }, workflow.enabled ? '停用' : '启用'),
        h('button', { class: 'btn', onclick: () => removeWorkflow(workflow) }, '删除'),
      ),
      !canRun ? h('div', { class: 'panel-note' }, status.mode === 'client' ? '浏览器还没连上 ComfyUI，先在上面点"测试连接"。' : 'ComfyUI 未启动，先在上面点"测试连接"。') : null,
      bindingsBox,
    );
  }

  /** 参数面板：既能改值，也能从工作流的全部输入里加绑定 / 删绑定。 */
  async function toggleBindingPanel(workflow, box) {
    if (box.children.length) {
      box.replaceChildren();
      return;
    }
    box.replaceChildren(loading());
    try {
      const data = await get(`/api/comfy/workflows/${workflow.id}/inputs`);
      renderBindingPanel(workflow, box, data.items ?? []);
    } catch (err) {
      box.replaceChildren(errorBox(err, { onRetry: () => { box.replaceChildren(); void toggleBindingPanel(workflow, box); } }));
    }
  }

  function guessBindingType(item) {
    if (/seed/i.test(String(item.input))) return 'seed';
    if (item.type === 'boolean') return 'boolean';
    if (item.type === 'number') return 'number';
    return 'text';
  }

  function renderBindingPanel(workflow, box, allInputs) {
    const draft = (workflow.bindings ?? []).map((binding) => ({ ...binding }));

    const draw = () => {
      const boundKeys = new Set(draft.map((binding) => `${binding.nodeId}.${binding.input}`));
      const rows = draft.map((binding, index) => {
        const input = h('input', {
          type: 'text',
          value: String(binding.value ?? ''),
          oninput: (event) => {
            binding.value = event.target.value;
          },
        });
        return h(
          'div',
          { class: 'binding-row', style: { display: 'flex', gap: '8px', alignItems: 'flex-end' } },
          h('div', { style: { flex: '1' } }, field(binding.label ?? `${binding.nodeId}.${binding.input}`, input, binding.type)),
          h(
            'button',
            {
              class: 'link-btn',
              style: { marginBottom: '6px' },
              onclick: () => {
                draft.splice(index, 1);
                draw();
              },
            },
            '删掉',
          ),
        );
      });

      const addable = allInputs.filter((item) => !boundKeys.has(`${item.nodeId}.${item.input}`));
      box.replaceChildren(
        h('div', { class: 'panel-note' }, `已绑定 ${draft.length} 个参数，工作流里还有 ${addable.length} 个输入没绑定。`),
        ...rows,
        addable.length
          ? h(
              'div',
              { style: { marginTop: '8px' } },
              h('div', { class: 'hint' }, '点一个加为可填参数：'),
              h(
                'div',
                { class: 'chip-row', style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '6px' } },
                ...addable.slice(0, 60).map((item) =>
                  h(
                    'button',
                    {
                      class: 'chip-btn',
                      onclick: () => {
                        draft.push({
                          nodeId: item.nodeId,
                          input: item.input,
                          label: `${item.classType}.${item.input}`,
                          type: guessBindingType(item),
                          value: item.value ?? '',
                        });
                        draw();
                      },
                    },
                    `＋ ${item.classType}.${item.input}`,
                  ),
                ),
              ),
            )
          : null,
        h('button', { class: 'btn primary', style: { marginTop: '10px' }, onclick: () => saveBindings(workflow, draft) }, '保存参数'),
      );
    };
    draw();
  }

  async function importWorkflow() {
    try {
      const seed = inputs.seed.value.trim();
      const created = await post('/api/comfy/workflows', {
        name: inputs.name.value.trim() || '工作流',
        kind: inputs.kind.value || 'custom',
        seed: seed === '' ? null : Number(seed),
        workflow: inputs.json.value,
      });
      inputs.json.value = '';
      inputs.seed.value = '';
      toast(`导入了「${created.name}」，标出 ${created.bindings.length} 个可填参数`);
      await refreshWorkflows();
      await refreshStatus();
    } catch (err) {
      toastError(err);
    }
  }

  async function saveBindings(workflow, bindingList) {
    try {
      const bindings = bindingList.map((binding) => {
        const raw = binding.value;
        const value = binding.type === 'number' || binding.type === 'seed' ? Number(raw === '' ? 0 : raw) : raw;
        return { nodeId: binding.nodeId, input: binding.input, label: binding.label, type: binding.type, value, enabled: binding.enabled !== false };
      });
      await put(`/api/comfy/workflows/${workflow.id}`, { bindings });
      toast('参数已保存');
      await refreshWorkflows();
    } catch (err) {
      toastError(err);
    }
  }

  async function saveSeed(workflow, value) {
    try {
      await put(`/api/comfy/workflows/${workflow.id}`, { seed: String(value).trim() === '' ? null : Number(value) });
      toast('种子已保存');
      await refreshWorkflows();
    } catch (err) {
      toastError(err);
    }
  }

  async function toggleEnabled(workflow) {
    try {
      await put(`/api/comfy/workflows/${workflow.id}`, { enabled: !workflow.enabled });
      await refreshWorkflows();
    } catch (err) {
      toastError(err);
    }
  }

  async function removeWorkflow(workflow) {
    try {
      await del(`/api/comfy/workflows/${workflow.id}`);
      toast('已删除');
      await refreshWorkflows();
    } catch (err) {
      toastError(err);
    }
  }

  async function runWorkflow(workflow) {
    try {
      if (status.mode === 'client') {
        // 浏览器直连：提交后由 WS/轮询盯着，不在这里干等
        toast('已提交到你的浏览器，进度会显示在下面');
        void runClientImage({
          baseUrl: status.config?.settings?.['comfy.baseUrl'] ?? '',
          workflowId: workflow.id,
          seed: workflow.seed ?? null,
          reason: 'manual',
        })
          .then(() => refreshRuns())
          .catch((err) => toastError(err));
        await refreshRuns();
        return;
      }
      const run = await post('/api/comfy/run', { workflowId: workflow.id, seed: workflow.seed ?? null });
      toast(`已提交（${run.promptId?.slice(0, 8)}），在下面看进度`);
      await refreshRuns();
    } catch (err) {
      toastError(err);
    }
  }

  // ------------------------------------------------------------------ 队列 / 出图记录

  function renderRuns(runs) {
    const active = runs.filter((run) => ['queued', 'running', 'pending-client'].includes(run.status));
    const done = runs.filter((run) => !active.includes(run));
    liveHost.replaceChildren(
      panel('队列与进度', active.length ? `${active.length} 个进行中 / 待执行` : '空闲', active.length ? h('div', {}, ...active.map(runCard)) : emptyState({ icon: '🌙', title: '现在没在出图' })),
      panel('最近的出图', `${done.length} 条`, done.length ? h('div', {}, ...done.map(runCard)) : emptyState({ icon: '🖼️', title: '还没有出过图' })),
    );
  }

  function runCard(run) {
    const percent = run.percent ?? (run.status === 'queued' ? 0 : null);
    const label = STATUS_LABEL[run.status] ?? run.status;
    return h(
      'div',
      { class: 'tile', style: { marginBottom: '10px' } },
      h(
        'div',
        { class: 'tile-title' },
        run.workflowName ?? '工作流',
        h('span', { class: `chip ${run.status === 'done' ? 'ready' : run.status === 'error' ? 'planned' : 'partial'}` }, label),
        run.reason ? h('span', { class: 'panel-note' }, run.reason) : null,
      ),
      run.status === 'pending-client'
        ? h('div', { class: 'panel-note' }, '浏览器直连模式：等服务端把这条待办交给浏览器执行（打开着页面就会自动跑）。')
        : null,
      percent !== null
        ? h('div', { class: 'panel-note' }, `进度 ${percent}%${run.nodeId ? ` · 节点 ${run.nodeId}` : ''}`)
        : null,
      run.error ? h('div', { class: 'panel-note' }, `失败：${run.error}`) : null,
      run.images?.length
        ? h(
            'div',
            { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' } },
            ...run.images.map((image) =>
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                h('img', {
                  src: `/api/assets/${image.assetId}/file`,
                  alt: image.filename,
                  title: '点开看大图',
                  style: { maxWidth: '160px', borderRadius: '10px', cursor: 'zoom-in' },
                  onclick: () => openImageViewer(image.assetId, { name: image.filename ?? '' }),
                }),
                h(
                  'div',
                  { style: { display: 'flex', gap: '6px', alignItems: 'center', maxWidth: '160px' } },
                  h('span', { class: 'hint', style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, image.filename ?? ''),
                  h('button', { class: 'link-btn', title: '删掉这张图', onclick: () => removeImage(image) }, '删除'),
                ),
              ),
            ),
          )
        : null,
      run.status === 'queued' || run.status === 'running'
        ? h('div', { style: { marginTop: '8px' } }, h('button', { class: 'btn', onclick: () => cancelRun(run) }, '取消'))
        : h(
            'div',
            { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px' } },
            run.status === 'pending-client' ? h('button', { class: 'btn', onclick: () => cancelRun(run) }, '取消这条待办') : null,
            h('button', { class: 'link-btn', title: '只清这条记录，图还在素材库里', onclick: () => removeRunRecord(run) }, '删除记录'),
          ),
    );
  }

  async function cancelRun(run) {
    try {
      await post(`/api/comfy/runs/${run.id}/cancel`, {});
      await refreshRuns();
    } catch (err) {
      toastError(err);
    }
  }

  /** 删掉一张出图：素材 + 缩略图 + 出图记录 / 消息里的引用，服务端一次收干净。 */
  async function removeImage(image) {
    const name = image.filename ?? image.assetId;
    const ok = await confirmDialog({
      title: '删除这张图',
      message: `删掉「${name}」？文件会从素材库一起删除，出图记录和聊天里对它的引用也会清掉。`,
    });
    if (!ok) return;
    try {
      const result = await del(`/api/comfy/images/${encodeURIComponent(image.assetId)}`);
      const cleaned = [];
      if (result?.messages) cleaned.push(`${result.messages} 条消息`);
      if (result?.pruned) cleaned.push(`${result.pruned} 条出图记录`);
      toast(cleaned.length ? `已删除（顺带清掉 ${cleaned.join('、')}）` : '已删除');
      await refreshRuns();
      await refreshExtra();
    } catch (err) {
      toastError(err);
    }
  }

  /** 删掉一条出图记录（只清记录，图还在素材库）。 */
  async function removeRunRecord(run) {
    const ok = await confirmDialog({
      title: '删除这条记录',
      message: `删掉「${run.workflowName ?? '这条记录'}」？只清这条出图记录，图还在素材库里。`,
    });
    if (!ok) return;
    try {
      await del(`/api/comfy/runs/${encodeURIComponent(run.id)}`);
      toast('记录已删除');
      await refreshRuns();
      await refreshStatus();
    } catch (err) {
      toastError(err);
    }
  }

  // ------------------------------------------------------------------ 数据

  // ------------------------------------------------------------------ 加分项：批量表情 / 参考图 / 角色绑定与表情包

  /** client 模式下提交/登记完的 run：立刻在浏览器里跑，不然就只是刷新记录。 */
  async function handleRunResult(run) {
    if (status.mode === 'client' && run?.status === 'pending-client') {
      void runPendingClientRuns({ baseUrl: status.config?.settings?.['comfy.baseUrl'] })
        .then(() => refreshRuns())
        .catch(() => refreshRuns());
    }
    await refreshRuns();
  }

  function imageWorkflows() {
    return extra.workflows.filter((workflow) => (workflow.bindings ?? []).some((binding) => binding.type === 'image'));
  }

  function assetName(assetId) {
    return extra.assets.find((asset) => asset.id === assetId)?.name ?? assetId;
  }

  function batchExpressionBlock() {
    const workflowSelect = h('select', {}, ...extra.workflows.map((workflow) => h('option', { value: workflow.id }, `${workflow.name}（${workflow.kind}）`)));
    workflowSelect.value = extra.workflows[0]?.id ?? '';
    const checks = extra.expressions.map((item) => {
      const box = h('input', { type: 'checkbox' });
      box.checked = ['happy', 'sad', 'angry', 'shy'].includes(item.id);
      box.dataset.emotion = item.id;
      return h('label', { style: { display: 'inline-flex', gap: '4px', alignItems: 'center', marginRight: '10px' } }, box, item.label);
    });
    return h(
      'div',
      { style: { marginBottom: '14px' } },
      h('div', { class: 'tile-title' }, '批量表情差分', h('span', { class: 'chip partial' }, '一次出多个表情')),
      h('div', { class: 'panel-note' }, '勾几个表情，一次全部提交；关键词会接在工作流自己的提示词后面（角色 LoRA / 触发词不会被冲掉）。'),
      field('工作流', workflowSelect),
      h('div', { style: { marginTop: '8px' } }, ...checks),
      h('button', {
        class: 'btn primary',
        style: { marginTop: '8px' },
        onclick: async () => {
          const emotions = checks.filter((label) => label.children?.[0]?.checked).map((label) => label.children[0].dataset.emotion).filter(Boolean);
          if (!emotions.length) return toast('先勾几个表情', { tone: 'warn' });
          if (!workflowSelect.value) return toast('先导入一个工作流', { tone: 'warn' });
          try {
            const result = await post('/api/comfy/batch-expressions', { workflowId: workflowSelect.value, emotions });
            const ok = result.items.filter((item) => item.ok).length;
            toast(`已提交 ${ok} 个表情差分`);
            await handleRunResult(result.items.find((item) => item.ok)?.run);
          } catch (err) {
            toastError(err);
          }
        },
      }, '批量出图'),
    );
  }

  function referenceBlock() {
    const capable = imageWorkflows();
    const workflowSelect = h('select', {}, ...capable.map((workflow) => h('option', { value: workflow.id }, `${workflow.name}（${workflow.kind}）`)));
    workflowSelect.value = capable[0]?.id ?? '';
    const refSelect = h('select', {}, h('option', { value: '' }, '选一张素材…'), ...extra.assets.map((asset) => h('option', { value: asset.id }, `${asset.name ?? asset.id}`)));
    const maskSelect = h('select', {}, h('option', { value: '' }, '（不用蒙版）'), ...extra.assets.map((asset) => h('option', { value: asset.id }, `${asset.name ?? asset.id}`)));
    return h(
      'div',
      { style: { marginBottom: '14px' } },
      h('div', { class: 'tile-title' }, '图生图 / 局部重绘 / 扩图', h('span', { class: 'chip partial' }, '用素材当参考图')),
      h('div', { class: 'panel-note' },
        capable.length
          ? '参考图会先上传到 ComfyUI 的 input 目录再提交（服务器执行 / 浏览器直连都支持）。局部重绘与扩图用参考图的透明通道当蒙版。'
          : '还没有带参考图输入（LoadImage.image）的工作流：先去「示例工作流」加一个「图生图」或「扩图」。',
      ),
      h('div', { class: 'grid', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' } },
        field('工作流', workflowSelect),
        field('参考图', refSelect),
        field('蒙版（可选）', maskSelect),
      ),
      h('button', {
        class: 'btn primary',
        style: { marginTop: '8px' },
        disabled: !capable.length || !extra.assets.length,
        onclick: async () => {
          if (!workflowSelect.value || !refSelect.value) return toast('先选工作流和参考图', { tone: 'warn' });
          try {
            const run = await post('/api/comfy/img2img', {
              workflowId: workflowSelect.value,
              referenceAssetId: refSelect.value,
              maskAssetId: maskSelect.value || null,
            });
            toast('已提交，跑完会进素材库');
            await handleRunResult(run);
          } catch (err) {
            toastError(err);
          }
        },
      }, '提交参考图出图'),
    );
  }

  function characterBindingBlock() {
    const cardSelect = h('select', {}, ...extra.cards.map((card) => h('option', { value: card.id }, card.name ?? card.id)));
    cardSelect.value = extra.cards[0]?.id ?? '';
    const workflowSelect = h('select', {}, h('option', { value: '' }, '（不指定，按用途挑）'), ...extra.workflows.map((workflow) => h('option', { value: workflow.id }, `${workflow.name}（${workflow.kind}）`)));
    const loraInput = h('input', { type: 'text', placeholder: 'LoRA 触发词，比如 <lora:alice:0.8>' });
    const expressionRows = [];
    const buildExpressionRows = (characterId) => {
      const binding = extra.bindings.find((item) => item.characterId === characterId) ?? null;
      workflowSelect.value = binding?.workflowId ?? '';
      loraInput.value = binding?.loraText ?? '';
      const mapping = binding?.expressions ?? {};
      expressionRows.splice(0, expressionRows.length, ...extra.expressions.map((item) => {
        const select = h('select', {}, h('option', { value: '' }, '（未绑）'), ...extra.assets.map((asset) => h('option', { value: asset.id }, asset.name ?? asset.id)));
        select.value = mapping[item.label] ?? mapping[item.id] ?? '';
        return h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '4px' } },
          h('span', { class: 'hint', style: { width: '48px' } }, item.label),
          h('div', { style: { flex: '1' } }, select),
        );
      }));
    };
    // 衣柜：一个角色多套衣服，出图时把「当前这套」填进 {{outfit}}
    const wardrobeHost = h('div', {});
    const wardrobeNegative = h('input', { type: 'text', placeholder: '这个角色永远不要出现什么（角色专属负面词）' });
    const wardrobe = { outfits: [], activeId: null };
    const drawWardrobe = () => {
      wardrobeHost.replaceChildren(
        h(
          'div',
          { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '6px' } },
          ...(wardrobe.outfits.length
            ? wardrobe.outfits.map((outfit) =>
                h(
                  'button',
                  {
                    class: `chip small ${wardrobe.activeId === outfit.id ? 'ready' : ''}`,
                    title: outfit.prompt || '（没写提示词）',
                    onclick: () => {
                      wardrobe.activeId = outfit.id;
                      drawWardrobe();
                    },
                  },
                  wardrobe.activeId === outfit.id ? `✓ ${outfit.name}` : outfit.name,
                ),
              )
            : [h('span', { class: 'hint' }, '还没有套装，下面加一套')]),
        ),
        ...wardrobe.outfits.map((outfit, index) =>
          h(
            'div',
            { style: { display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '6px' } },
            h('div', { style: { flex: '0 0 120px' } }, field('套装名', h('input', { type: 'text', value: outfit.name, oninput: (event) => { outfit.name = event.target.value; } }))),
            h(
              'div',
              { style: { flex: '1 1 240px' } },
              field('提示词', h('input', { type: 'text', value: outfit.prompt, placeholder: '比如 school uniform, red skirt（工作流里用 {{outfit}} 引用）', oninput: (event) => { outfit.prompt = event.target.value; } })),
            ),
            h(
              'button',
              {
                class: 'link-btn',
                style: { marginBottom: '6px' },
                onclick: () => {
                  wardrobe.outfits.splice(index, 1);
                  if (wardrobe.activeId === outfit.id) wardrobe.activeId = null;
                  drawWardrobe();
                },
              },
              '删掉',
            ),
          ),
        ),
      );
    };
    const loadWardrobe = async (characterId) => {
      wardrobe.outfits = [];
      wardrobe.activeId = null;
      wardrobeNegative.value = '';
      if (characterId) {
        try {
          const data = await get(`/api/comfy/outfits/${encodeURIComponent(characterId)}`);
          wardrobe.outfits = (data.outfits ?? []).map((item) => ({ ...item }));
          wardrobe.activeId = data.activeId ?? null;
          wardrobeNegative.value = data.negative ?? '';
        } catch {
          // 读不到就当空的，别挡着保存
        }
      }
      drawWardrobe();
    };
    cardSelect.addEventListener('change', () => {
      buildExpressionRows(cardSelect.value);
      void loadWardrobe(cardSelect.value);
    });
    buildExpressionRows(cardSelect.value);
    void loadWardrobe(cardSelect.value);
    return h(
      'div',
      {},
      h('div', { class: 'tile-title' }, '角色绑定与表情包', h('span', { class: 'chip partial' }, '不同角色不同工作流 / LoRA')),
      h('div', { class: 'panel-note' }, '给角色固定一个工作流与 LoRA 触发词；再绑一组表情图，演出时会按当前情绪自动换立绘。'),
      h('div', { class: 'grid', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' } },
        field('角色卡', cardSelect),
        field('工作流', workflowSelect),
        field('LoRA / 触发词', loraInput, '会接在该角色出图的提示词后面'),
      ),
      extra.expressions.length ? h('div', { style: { marginTop: '10px' } }, h('div', { class: 'hint' }, '表情差分包：每个表情绑一张素材'), ...expressionRows) : null,
      h(
        'div',
        { style: { marginTop: '10px' } },
        h('div', { class: 'hint' }, '衣柜（换装）：出图时把「当前这套」的描写填进 {{outfit}}；工作流的正/负提示词里写 {{outfit}} 就会跟着换。'),
        h('div', { class: 'hint' }, '剧情换装：让 AI 在回复里写 [换装: 套装名]（或 [OUTFIT: 名字]），它就会自己换——galgame 里"剧情推进到换衣服了"不用你动手。'),
        wardrobeHost,
        h('button', { class: 'btn', onclick: () => { wardrobe.outfits.push({ id: `outfit-${Date.now().toString(36)}`, name: '新套装', prompt: '', negative: '' }); drawWardrobe(); } }, '＋ 加一套衣服'),
        h('div', { style: { marginTop: '6px', maxWidth: '420px' } }, field('角色专属负面词', wardrobeNegative, '会接到这个角色出图的负向提示词后面')),
      ),
      h('button', {
        class: 'btn primary',
        style: { marginTop: '8px' },
        disabled: !extra.cards.length,
        onclick: async () => {
          if (!cardSelect.value) return toast('先选一张角色卡', { tone: 'warn' });
          const expressions = {};
          expressionRows.forEach((row, index) => {
            const item = extra.expressions[index];
            const select = row.children?.[1]?.children?.[0] ?? null;
            if (item && select?.value) expressions[item.label] = select.value;
          });
          try {
            await put(`/api/comfy/character-bindings/${encodeURIComponent(cardSelect.value)}`, {
              workflowId: workflowSelect.value || null,
              loraText: loraInput.value.trim() || null,
              expressions,
            });
            await put(`/api/comfy/outfits/${encodeURIComponent(cardSelect.value)}`, {
              outfits: wardrobe.outfits,
              activeId: wardrobe.activeId,
              negative: wardrobeNegative.value,
            });
            toast('角色绑定已保存');
            await refreshExtra();
          } catch (err) {
            toastError(err);
          }
        },
      }, '保存角色绑定'),
      extra.bindings.length ? h('div', { class: 'panel-note', style: { marginTop: '8px' } }, `已绑定 ${extra.bindings.length} 个角色`) : null,
    );
  }

  function renderExtra() {
    extraHost.replaceChildren(
      panel('出图加分项', null, batchExpressionBlock(), referenceBlock(), characterBindingBlock()),
    );
  }

  async function refreshExtra() {
    try {
      const [cards, assets, bindings, config, workflows] = await Promise.all([
        get('/api/characters?limit=200').catch(() => ({ items: [] })),
        get('/api/assets?kind=image&limit=200').catch(() => ({ items: [] })),
        get('/api/comfy/character-bindings').catch(() => ({ items: [] })),
        get('/api/comfy/config').catch(() => null),
        get('/api/comfy/workflows').catch(() => ({ items: [] })),
      ]);
      extra.cards = cards.items ?? [];
      extra.assets = assets.items ?? [];
      extra.bindings = bindings.items ?? [];
      extra.expressions = config?.expressions ?? [];
      extra.workflows = workflows.items ?? [];
      extra.loaded = true;
      renderExtra();
    } catch (err) {
      extraHost.replaceChildren(panel('出图加分项', null, errorBox(err, { onRetry: refreshExtra })));
    }
  }

  async function refreshStatus() {
    try {
      const config = await get('/api/comfy/config');
      status.config = config;
      const conf = config?.settings ?? {};
      const mode = conf['comfy.executionMode'] ?? 'server';
      status.mode = mode;
      if (mode === 'client') {
        // 浏览器直连：连接状态由浏览器测（主机不会去碰这个地址）
        const timeoutMs = Number(conf['comfy.timeoutMs'] ?? 8000);
        const probe = await testComfyBrowser(conf['comfy.baseUrl'], { timeoutMs });
        status.ok = Boolean(probe.ok);
        status.error = probe.error ?? null;
        status.queue = await clientQueue(conf['comfy.baseUrl'], { timeoutMs });
      } else {
        const statusPayload = await get('/api/comfy/status');
        status.ok = Boolean(statusPayload.ok);
        status.error = statusPayload.error ?? null;
        status.queue = statusPayload.queue ?? null;
      }
    } catch (err) {
      status.ok = false;
      status.error = err?.message ?? String(err);
    }
    renderConnect();
    renderLaunch();
  }

  async function refreshWorkflows() {
    try {
      const [data, presetData] = await Promise.all([get('/api/comfy/workflows'), get('/api/comfy/presets')]);
      renderWorkflows(data.items ?? [], presetData.items ?? []);
      void refreshExtra();
    } catch (err) {
      workflowHost.replaceChildren(panel('工作流', null, errorBox(err, { onRetry: refreshWorkflows })));
    }
  }

  async function refreshRuns() {
    try {
      const data = await get('/api/comfy/runs?limit=20');
      renderRuns(data.items ?? []);
    } catch (err) {
      liveHost.replaceChildren(panel('队列与进度', null, errorBox(err, { onRetry: refreshRuns })));
    }
  }

  async function mount() {
    connectHost.append(loading());
    launchHost.append(loading());
    workflowHost.append(loading());
    liveHost.append(loading());
    extraHost.append(loading());
    await refreshStatus();
    await Promise.all([refreshWorkflows(), refreshRuns(), refreshExtra()]);
    await refreshLauncher();
    // 出图要好几十秒，隔一会儿刷一次进度。这里只刷本地的出图记录（读数据库），
    // 不刷 /api/comfy/status —— 那个会去探 ComfyUI，地址不通时会一直挂着请求。
    // 连接状态由「测试连接」「保存」按钮触发刷新。
    // unref 是为了别拖住进程退出（Node 里 setInterval 返回的对象有 unref；浏览器里没有，可选调用）。
    let ticks = 0;
    const timer = setInterval(() => {
      void refreshRuns();
      // 顺带瞄一眼托管状态（本地内存里的东西，很便宜），闲置自动停掉之后图标才不会一直显示在跑
      if ((ticks += 1) % 4 === 0) void refreshLauncher();
    }, 2500);
    timer.unref?.();
  }

  return { el, mount };
}
