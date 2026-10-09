/**
 * 角色卡列表（写卡区首页）。
 *
 * 能做：搜索、按标签 / 来源 / 收藏筛选、收藏开关、新建、删除、
 *       拖拽或选择文件导入（PNG / JSON）、批量导入整个文件夹、导出 PNG / JSON。
 * 编辑交给同一页下面的"编辑器"板块：ctx.openTab 把卡 id 带过去并滚到那一块。
 */

import { h, statusChip } from '../core/dom.mjs';
import { get, post, put, del } from '../core/api.mjs';
import { panel, table, emptyState, errorBox, kv, field } from '../ui/components.mjs';
import { openModal, confirmDialog } from '../ui/modal.mjs';
import { toast, toastError } from '../ui/toast.mjs';
import { createCardChat, openCardChat, openCardChatsModal } from './card-chats.mjs';

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

async function downloadExport(id, format, name) {
  const res = await fetch(`/api/characters/${id}/export?format=${format}`);
  if (!res.ok) throw new Error(`导出失败（${res.status}）`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: `${name}.${format === 'png' ? 'png' : 'json'}` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function createCardsView(module, ctx) {
  const el = h('div', { class: 'view' });
  const listHost = h('div', {});
  const statsHost = h('div', {});

  // mode：封面网格（默认，照 PotatoVN 那种一眼认得出）还是表格（批量管理方便）
  const state = { q: '', tag: '', favorite: null, source: '', items: [], total: 0, tags: [], mode: 'grid' };
  try {
    const saved = localStorage.getItem('st.cardView');
    if (saved === 'grid' || saved === 'list') state.mode = saved;
  } catch {}
  const fileInput = h('input', {
    type: 'file',
    multiple: true,
    accept: '.png,.json,.txt,application/json,image/png',
    style: { display: 'none' },
    onchange: () => importFiles([...fileInput.files]),
  });
  const folderInput = h('input', {
    type: 'file',
    multiple: true,
    webkitdirectory: '',
    style: { display: 'none' },
    onchange: () => importFiles([...folderInput.files]),
  });
  const platformInput = h('input', {
    type: 'file',
    accept: '.json,application/json',
    style: { display: 'none' },
    onchange: () => {
      const file = platformInput.files?.[0];
      if (file) void importPlatformCard(file);
      platformInput.value = '';
    },
  });

  const searchBox = h('input', {
    type: 'search',
    placeholder: '搜名字或简介……',
    style: { minWidth: '220px' },
    oninput: (event) => {
      state.q = event.target.value.trim();
      void refresh();
    },
  });

  const viewToggleBtn = h(
    'button',
    {
      class: 'btn',
      title: '封面网格 / 表格 两种看法（表格方便成批删改，网格方便认卡）',
      onclick: () => {
        state.mode = state.mode === 'grid' ? 'list' : 'grid';
        try { localStorage.setItem('st.cardView', state.mode); } catch {}
        void refresh();
      },
    },
    '☰ 表格',
  );

  const toolbar = h(
    'div',
    { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginTop: '14px' } },
    searchBox,
    h('button', { class: 'btn primary', onclick: () => fileInput.click() }, '⬆ 导入卡'),
    h('button', { class: 'btn', onclick: () => folderInput.click() }, '📁 导入文件夹'),
    h('button', { class: 'btn', onclick: () => platformInput.click() }, '🎮 从平台作品导入'),
    h('button', { class: 'btn', onclick: () => newCardDialog() }, '＋ 新建'),
    viewToggleBtn,
    h('button', {
      class: 'btn',
      onclick: () => {
        state.favorite = state.favorite === true ? null : true;
        void refresh();
      },
    }, '★ 只看收藏'),
  );

  const dropZone = h('div', { class: 'drop-zone' }, '把 PNG / JSON 卡拖到这里导入');

  el.append(
    panel(
      module.title,
      null,
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } }, statusChip(module.status), h('span', { class: 'panel-note' }, module.summary)),
      toolbar,
      dropZone,
    ),
    statsHost,
    listHost,
    fileInput,
    folderInput,
    platformInput,
  );

  wireDrop(el);

  function wireDrop(host) {
    host.addEventListener('dragover', (event) => {
      event.preventDefault();
      dropZone.classList.add('active');
    });
    host.addEventListener('dragleave', () => dropZone.classList.remove('active'));
    host.addEventListener('drop', (event) => {
      event.preventDefault();
      dropZone.classList.remove('active');
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length) void importFiles(files);
    });
  }

  async function importFiles(files) {
    if (!files.length) return;
    try {
      const payload = [];
      for (const file of files) {
        payload.push({ name: file.name, dataBase64: await fileToBase64(file) });
      }
      const result = await post('/api/characters/import', { files: payload });
      if (result.skipped) {
        toast(`导入 ${result.imported} 张，${result.skipped} 张没能读出来`, { tone: 'warn', duration: 4000 });
      } else {
        toast(`导入成功：${result.imported} 张`);
      }
      for (const err of result.errors ?? []) console.warn('导入失败', err.name, err.message);
      await refresh();
    } catch (err) {
      toastError(err);
    } finally {
      fileInput.value = '';
      folderInput.value = '';
    }
  }

  /**
   * 从那个闭源平台的「作品 JSON」导入。
   *
   * 它的字段名跟我们不是一回事：设定在 prpt（提示词）里、详细介绍其实是前端代码、
   * 还有两个我们没有历史包袱的字段（前置词 / 后置词）。映射细节在服务端的
   * core/cards/platform-import.mjs，这里只负责问一句"是你写的吗"和把报告摊开。
   */
  async function importPlatformCard(file) {
    let document;
    try {
      document = JSON.parse(await file.text());
    } catch {
      toastError(new Error('这个文件不是合法的 JSON'));
      return;
    }
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      toastError(new Error('这个文件里没有作品数据'));
      return;
    }

    const mine = await confirmDialog({
      title: `导入作品：${document.app_name || file.name}`,
      message: '这是你自己写的作品吗？\n\n'
        + '「是我写的」→ 当成自己的卡：直接能跑，不拦静态检查。\n'
        + '「别人的作品」→ 当成导入卡：跑之前要先点一次「信任这张卡」。\n\n'
        + '两种都能用，区别只是默认安全档。',
      confirmLabel: '是我写的',
      cancelLabel: '别人的作品',
    });

    try {
      const result = await post(`/api/characters/import-platform${mine ? '?source=original' : ''}`, { document });
      await refresh();
      showImportReport(result, mine);
    } catch (err) {
      toastError(err);
    }
  }

  /** 把导入报告摊开：搬过来了什么、哪些没搬、跑之前还要做什么。 */
  function showImportReport({ card, report }, mine) {
    const lines = [];
    const line = (label, value) => lines.push(h('div', { style: { marginTop: '4px' } }, h('b', {}, `${label}：`), value));

    line('提示词', `${report.promptChars} 字 → 系统提示`);
    line('世界书', `${report.worldbook.total} 条 → 卡内世界书`);
    line('卡内前端', `html ${report.frontend.html} 字 / css ${report.frontend.css} 字 / js ${report.frontend.js} 字`);
    line('前置词 / 后置词', `${report.prefix} / ${report.suffix} 字（拼在最后一条用户消息前后）`);
    line('开场白', report.firstMes ? '已导入' : '没有（或只是占位文案）');

    if (report.frontend.externalUrls) {
      lines.push(
        h('div', { class: 'hint', style: { marginTop: '10px' } },
          `界面代码里有 ${report.frontend.externalUrls} 条外链资源（图片 / 字体 / 音乐）。现在直接引用外网，能用但不可靠；`
          + '在「卡内前端」那块点一次「把外链抓进本地」，就能全部存进素材库。'),
      );
    }
    if (report.frontendCheck?.needsTrust) {
      lines.push(h('div', { class: 'hint', style: { marginTop: '6px' } },
        '这是导入卡：打开对话后要先点一次「信任这张卡」，卡内界面才会跑。'));
    }
    if (report.frontendCheck?.errors) {
      lines.push(h('div', { class: 'hint', style: { marginTop: '6px' } },
        `代码里有 ${report.frontendCheck.errors} 处会被沙箱拦（多半是 onclick="…" 这类内联事件）——信任之后就不拦了，但严格档下要改。`));
    }
    if (report.worldbook.notes?.length) {
      lines.push(h('div', { class: 'hint', style: { marginTop: '6px' } }, '世界书备注：'));
      for (const note of report.worldbook.notes.slice(0, 6)) {
        lines.push(h('div', { class: 'hint' }, `· ${note}`));
      }
    }
    if (report.notImported?.length) {
      lines.push(h('div', { class: 'hint', style: { marginTop: '6px' } },
        `没导过来的：${report.notImported.join('、')}`));
    }
    for (const warning of report.warnings ?? []) {
      lines.push(h('div', { class: 'hint', style: { marginTop: '4px' } }, `注意：${warning}`));
    }

    openModal({
      title: `导入完成：${card.name}`,
      body: h('div', { style: { fontSize: '13px', lineHeight: '1.7' } }, ...lines),
      actions: [
        { label: '知道了' },
        {
          label: '去编辑这张卡',
          primary: true,
          onClick: () => openEditor(card.id),
        },
      ],
    });
  }

  function newCardDialog() {
    const nameInput = h('input', { type: 'text', placeholder: '角色名字', value: '' });
    const descInput = h('textarea', { placeholder: '一句话简介（可稍后再写）' });
    openModal({
      title: '新建角色卡',
      body: h('div', {}, field('名字', nameInput), field('简介', descInput)),
      actions: [
        { label: '取消' },
        {
          label: '创建并编辑',
          primary: true,
          onClick: async () => {
            const name = nameInput.value.trim();
            if (!name) {
              toast('名字不能空着', { tone: 'warn' });
              return false;
            }
            try {
              const card = await post('/api/characters', { name, description: descInput.value.trim() });
              await refresh();
              openEditor(card.id);
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

  function openEditor(id) {
    if (ctx.openTab) ctx.openTab('editor', { cardId: id });
    else ctx.navigate('cards', 'editor');
  }

  async function toggleFavorite(card) {
    try {
      await put(`/api/characters/${card.id}`, { favorite: !card.favorite });
      await refresh();
    } catch (err) {
      toastError(err);
    }
  }

  async function removeCard(card) {
    const ok = await confirmDialog({ title: '删除角色卡', message: `确定删掉「${card.name}」吗？版本历史会一起删掉。`, confirmLabel: '删除' });
    if (!ok) return;
    try {
      await del(`/api/characters/${card.id}`);
      toast('已删除');
      await refresh();
    } catch (err) {
      toastError(err);
    }
  }

  /** 用这张卡开一个新对话，然后直接跳到玩卡区那个对话。 */
  async function startChat(card) {
    try {
      const created = await createCardChat(card);
      toast(`用《${card.name}》开了个新对话`);
      await refresh();
      openCardChat(ctx, created.id);
    } catch (err) {
      toastError(err);
    }
  }

  function tagFilter() {
    const tags = state.tags ?? [];
    if (!tags.length) return null;
    return h(
      'div',
      { class: 'chip-row', style: { marginTop: '10px' } },
      h('button', {
        class: `chip-btn${state.tag === '' ? ' active' : ''}`,
        onclick: () => { state.tag = ''; void refresh(); },
      }, '全部'),
      tags.map((entry) =>
        h('button', {
          class: `chip-btn${state.tag === entry.tag ? ' active' : ''}`,
          onclick: () => { state.tag = state.tag === entry.tag ? '' : entry.tag; void refresh(); },
        }, `${entry.tag} ${entry.count}`),
      ),
    );
  }

  function rows() {
    return state.items.map((card) => [
      h(
        'div',
        { class: 'card-name-cell' },
        card.avatarAssetId
          ? h('img', { class: 'card-avatar', src: `/api/characters/${card.id}/avatar`, alt: '' })
          : h('div', { class: 'card-avatar placeholder' }, '🃏'),
        h(
          'div',
          {},
          h('div', { style: { fontWeight: '600' } }, card.favorite ? `★ ${card.name}` : card.name),
          h('div', { class: 'panel-note', style: { fontSize: '12px' } }, (card.data?.description ?? '').slice(0, 46) || '（还没有简介）'),
        ),
      ),
      card.tags.length ? card.tags.map((tag) => h('span', { class: 'chip small' }, tag)) : h('span', { class: 'panel-note' }, '—'),
      `${card.specVersion?.toUpperCase() ?? ''} · ${card.versionCount ?? 0} 版`,
      (card.updatedAt ?? '').slice(0, 19).replace('T', ' '),
      h(
        'div',
        { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
        h('button', { class: 'btn small primary', onclick: () => startChat(card) }, '▶ 用这张卡开对话'),
        h(
          'button',
          { class: 'btn small', onclick: () => openCardChatsModal(card, ctx, { onChanged: () => void refresh() }) },
          `${card.chatCount ? '💬' : '＋'} ${card.chatCount ?? 0} 个对话`,
        ),
        h('button', { class: 'btn small', onclick: () => openEditor(card.id) }, '编辑'),
        h('button', { class: 'btn small', onclick: () => toggleFavorite(card) }, card.favorite ? '取消收藏' : '收藏'),
        h('button', { class: 'btn small', onclick: () => downloadExport(card.id, 'png', card.name).catch(toastError) }, 'PNG'),
        h('button', { class: 'btn small', onclick: () => downloadExport(card.id, 'json', card.name).catch(toastError) }, 'JSON'),
        h('button', { class: 'btn small danger', onclick: () => removeCard(card) }, '删除'),
      ),
    ]);
  }

  /**
   * 给某张卡选一张封面（头像）上传。
   *
   * 为什么要有：从平台搬过来的卡常常没有封面（我们只能显示占位图），自己拿一张图补上
   * 比"去编辑器里换头像"更顺手。图存进卡自己的素材位（avatar_asset_id），
   * 和 PotatoVN 那套"把封面复制进自己管的目录、模型里只存路径"是一个思路。
   */
  function pickCover(card) {
    const input = h('input', {
      type: 'file',
      class: 'card-cover-input',
      accept: 'image/png,image/jpeg,image/webp',
      style: { display: 'none' },
      onchange: async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          // 先把文件读完再拆 input —— 先 remove 的话 Chrome 会把读取打断
          // （真用户从磁盘挑一张几 MB 的图也会踩这个坑）
          const base64 = await fileToBase64(file);
          await put(`/api/characters/${card.id}`, { avatar: base64 });
          toast(`《${card.name}》的封面换好了`);
          await refresh();
        } catch (err) {
          toastError(err);
        } finally {
          input.remove();
        }
      },
    });
    document.body.append(input);
    input.click();
  }

  /**
   * 封面墙：竖版进海报墙，横版单独一块"横幅"。
   * 未测量 / 没封面 / 加载失败的一律先当竖版（放海报墙），这样不会闪。
   */
  function coverWall(items) {
    const portraits = h('div', { class: 'card-grid' });
    const banners = h('div', { class: 'card-grid landscape' });
    const bannerBlock = h(
      'div',
      { class: 'card-grid-split', hidden: true },
      h('div', { class: 'panel-note' }, `横幅封面（横版，${0} 张）`),
      banners,
    );
    const note = bannerBlock.querySelector?.('.panel-note') ?? null;
    const place = (node, landscape) => {
      if (!node) return;
      const target = landscape ? banners : portraits;
      if (node.parentElement === target) return;
      target.append(node);
      const count = banners.children.length;
      bannerBlock.hidden = count === 0;
      if (note) note.textContent = `横幅封面（横版，${count} 张）`;
    };
    for (const card of items) portraits.append(gridCard(card, { onMeasure: place }));
    return h('div', {}, portraits, bannerBlock);
  }

  /**
   * 封面网格：一眼认卡（照 PotatoVN 那种"海报墙"的排布）。
   *
   * 竖版和横版**分开放**：竖版进海报墙（3:4），横版单独进下面那块横幅排（16:9）。
   * 混在一起会一行高一行矮，看着乱 —— 分开两处各自整齐。
   * 比例要等图片加载完才知道，所以 onload 里回头把自己挪到该去的那块。
   */
  function gridCard(card, { onMeasure = null } = {}) {
    const chatCount = card.chatCount ?? 0;
    // 封面来源优先级：卡头像 → 导入时存下的封面素材（平台卡常常是 jpeg/webp，
    // 那种转不了 PNG 头像，就存成素材挂在这里）→ 占位
    const coverAsset = card.data?.extensions?.st_cover ?? null;
    const coverSrc = card.avatarAssetId
      ? `/api/characters/${card.id}/avatar?t=${card.updatedAt ?? ''}`
      : coverAsset
        ? `/api/assets/${encodeURIComponent(String(coverAsset))}/file`
        : null;
    const cover = coverSrc
      ? h('img', {
          class: 'card-grid-cover-img',
          src: coverSrc,
          alt: '',
          loading: 'lazy',
          onload: (event) => {
            const image = event.target;
            const landscape = Number(image.naturalWidth) > Number(image.naturalHeight);
            onMeasure?.(image.closest('.card-grid-item'), landscape);
          },
        })
      : h(
          'div',
          { class: 'card-grid-cover-img placeholder' },
          h('div', { class: 'card-grid-ph-icon' }, '🃏'),
          h('div', { class: 'card-grid-ph-text' }, '没有封面'),
        );
    return h(
      'div',
      { class: 'card-grid-item', dataset: { cardId: card.id } },
      h(
        'div',
        { class: 'card-grid-cover', title: '点封面 = 换一张', onclick: () => pickCover(card) },
        cover,
        card.favorite ? h('span', { class: 'card-grid-fav', title: '收藏' }, '★') : null,
        chatCount ? h('span', { class: 'card-grid-badge' }, `${chatCount} 个对话`) : null,
      ),
      h('div', { class: 'card-grid-title', title: card.name }, card.name),
      h(
        'div',
        { class: 'card-grid-sub' },
        `${card.specVersion?.toUpperCase() ?? ''} · ${(card.tags ?? []).slice(0, 2).join(' ') || '无标签'}`,
      ),
      h(
        'div',
        { class: 'card-grid-actions' },
        h('button', { class: 'btn small primary', onclick: () => startChat(card) }, '▶ 开对话'),
        h(
          'button',
          { class: 'btn small', onclick: () => openCardChatsModal(card, ctx, { onChanged: () => void refresh() }) },
          `💬 ${chatCount}`,
        ),
        h('button', { class: 'btn small', onclick: () => pickCover(card) }, '🖼 封面'),
        h('button', { class: 'btn small', onclick: () => openEditor(card.id) }, '编辑'),
        h('button', { class: 'btn small danger', onclick: () => removeCard(card) }, '删除'),
      ),
    );
  }

  async function refresh() {
    try {
      const params = new URLSearchParams();
      if (state.q) params.set('q', state.q);
      if (state.tag) params.set('tag', state.tag);
      if (state.favorite !== null) params.set('favorite', String(state.favorite));
      if (state.source) params.set('source', state.source);
      const data = await get(`/api/characters?${params.toString()}`);
      state.items = data.items;
      state.total = data.total;
      const stats = await get('/api/characters/stats');
      state.tags = stats.tags ?? [];

      statsHost.replaceChildren(
        panel(
          '统计',
          null,
          kv([
            ['角色卡总数', stats.total],
            ['收藏', stats.favorites],
            ['自定义标签', stats.tags.length],
          ]),
          tagFilter(),
        ),
      );

      listHost.replaceChildren(
        panel(
          '我的角色卡',
          state.total ? `筛选出 ${state.total} 张` : null,
          state.items.length
            ? state.mode === 'grid'
              ? coverWall(state.items)
              : table(['角色', '标签', '规格', '更新时间', '操作'], rows())
            : emptyState({
                icon: '🃏',
                title: state.q || state.tag || state.favorite !== null ? '没有符合条件的卡' : '还没有角色卡',
                desc: state.q || state.tag || state.favorite !== null ? '换个关键词或清掉筛选试试' : '把 PNG / JSON 卡拖进来导入，或者点「新建」从零写一张。',
              }),
        ),
      );
      viewToggleBtn.textContent = state.mode === 'grid' ? '☰ 表格' : '▦ 封面';
    } catch (err) {
      listHost.replaceChildren(panel('我的角色卡', null, errorBox(err, { onRetry: () => void refresh() })));
    }
  }

  return { el, mount: refresh };
}
