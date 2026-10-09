/**
 * 素材库：图片 / 音频统一存放。按 sha256 去重，列表带引用计数
 * （被消息、出图记录、角色头像引用了多少次），删之前能看到有没有人在用。
 */

import { h, statusChip } from '../core/dom.mjs';
import { get, post, del } from '../core/api.mjs';
import { panel, field, errorBox, loading, emptyState } from '../ui/components.mjs';
import { confirmDialog } from '../ui/modal.mjs';
import { toast, toastError } from '../ui/toast.mjs';
import { openImageViewer } from './playing-common.mjs';

const KIND_LABEL = { image: '图片', audio: '音频', video: '视频', file: '文件' };

/** 缩略图边长上限。够列表看，又比原图小两个数量级。 */
const THUMB_MAX = 512;

/**
 * 在浏览器里把图缩小。为什么不在服务端做：本项目零第三方运行时依赖，
 * Node 没有内置图像处理；而浏览器有 canvas，顺手就干了。
 */
async function makeThumbnail(src) {
  const image = await new Promise((resolve, reject) => {
    const node = new Image();
    node.onload = () => resolve(node);
    node.onerror = () => reject(new Error('图片读不出来'));
    node.src = src;
  });
  const natural = Math.max(image.naturalWidth || 1, image.naturalHeight || 1);
  const scale = Math.min(1, THUMB_MAX / natural);
  const width = Math.max(1, Math.round((image.naturalWidth || 1) * scale));
  const height = Math.max(1, Math.round((image.naturalHeight || 1) * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(image, 0, 0, width, height);
  const dataUrl = canvas.toDataURL('image/webp', 0.82);
  return { data: dataUrl.replace(/^data:[^,]*,/, ''), mime: 'image/webp', width, height };
}

/** 给一个素材补缩略图；失败就算了（列表会回落到原图）。 */
async function buildThumbnail(asset) {
  try {
    const thumb = await makeThumbnail(`/api/assets/${encodeURIComponent(asset.id)}/file`);
    await post(`/api/assets/${encodeURIComponent(asset.id)}/thumbnail`, thumb);
    return true;
  } catch {
    return false;
  }
}

export function createAssetsView(module) {
  const el = h('div', { class: 'view' });
  const host = h('div', {});
  const state = { items: [], kind: '', busy: false };
  const uploadInput = h('input', { type: 'file', multiple: true });

  el.append(
    panel(
      module.title,
      null,
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } }, statusChip(module.status), h('span', { class: 'panel-note' }, module.summary ?? '')),
    ),
    host,
  );

  async function uploadFiles(files) {
    const list = [...(files ?? [])];
    if (!list.length) return;
    state.busy = true;
    try {
      for (const file of list) {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result ?? ''));
          reader.onerror = () => reject(new Error('读不了这个文件'));
          reader.readAsDataURL(file);
        });
        const saved = await post('/api/assets', {
          data: dataUrl.replace(/^data:[^,]*,/, ''),
          kind: file.type.startsWith('audio/') ? 'audio' : file.type.startsWith('video/') ? 'video' : 'image',
          name: file.name,
          mime: file.type || 'application/octet-stream',
        });
        // 图片顺手生成缩略图，省得列表里几百张原图一起加载
        if ((saved?.kind ?? 'image') === 'image') await buildThumbnail(saved);
      }
      toast(`上传了 ${list.length} 个文件（相同内容会自动去重）`);
      await refresh();
    } catch (err) {
      toastError(err);
    } finally {
      state.busy = false;
    }
  }

  async function removeAsset(asset) {
    const ok = await confirmDialog({
      title: '删除素材',
      message: `删掉「${asset.name ?? asset.id}」？引用计数：${asset.refCount ?? 0}${asset.refCount ? '（还有引用，删了消息里会变成裂图）' : ''}`,
    });
    if (!ok) return;
    try {
      await del(`/api/assets/${encodeURIComponent(asset.id)}`);
      toast('已删除');
      await refresh();
    } catch (err) {
      toastError(err);
    }
  }

  function render() {
    const items = state.kind ? state.items.filter((item) => item.kind === state.kind) : state.items;
    const kindSelect = h('select', {
      onchange: (event) => {
        state.kind = event.target.value;
        render();
      },
    }, h('option', { value: '' }, '全部'), ...['image', 'audio', 'video', 'file'].map((kind) => h('option', { value: kind }, KIND_LABEL[kind] ?? kind)));
    kindSelect.value = state.kind;

    host.replaceChildren(
      panel(
        '上传与筛选',
        `${items.length} / ${state.items.length}`,
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' } },
          field('上传文件', uploadInput, '图片 / 音频都可以；相同内容按 sha256 只存一份'),
          field('只看', kindSelect),
        ),
        h('div', { class: 'panel-note', style: { marginTop: '6px' } }, '引用计数 = 被多少条消息、出图记录、角色头像引用过。删之前先看一眼。'),
        h(
          'button',
          {
            class: 'link-btn',
            style: { marginTop: '6px' },
            onclick: async () => {
              const images = state.items.filter((item) => item.kind === 'image').slice(0, 40);
              if (!images.length) return;
              let made = 0;
              for (const asset of images) if (await buildThumbnail(asset)) made += 1;
              toast(`补了 ${made} 张缩略图（一次最多处理 40 张）`);
              await refresh();
            },
          },
          '补生成缩略图（列表改用小图加载，快很多）',
        ),
      ),
      panel(
        '素材',
        `${items.length} 个`,
        items.length
          ? h(
              'div',
              { class: 'gallery-grid' },
              items.map((asset) =>
                h(
                  'div',
                  { class: 'gallery-item', style: { position: 'relative' } },
                  asset.kind === 'audio'
                    ? h('div', { class: 'gallery-audio', style: { display: 'grid', placeItems: 'center', height: '110px', fontSize: '28px' } }, '🎵')
                    : h('img', {
                        // 优先缩略图；没有就回落到原图（服务端 404 时换一次源）
                        src: `/api/assets/${encodeURIComponent(asset.id)}/thumb`,
                        alt: asset.name ?? asset.id,
                        loading: 'lazy',
                        onerror: (event) => {
                          const node = event.target;
                          if (node.dataset.fallback === '1') return;
                          node.dataset.fallback = '1';
                          node.src = `/api/assets/${encodeURIComponent(asset.id)}/file`;
                        },
                        onclick: () => openImageViewer(asset.id, { name: asset.name ?? '' }),
                      }),
                  h('span', { class: 'gallery-kind' }, KIND_LABEL[asset.kind] ?? asset.kind),
                  h('span', { class: 'gallery-kind', style: { left: 'auto', right: '6px' } }, `引用 ${asset.refCount ?? 0}`),
                  h('button', { class: 'link-btn', style: { position: 'absolute', top: '4px', right: '6px' }, onclick: () => removeAsset(asset) }, '删'),
                ),
              ),
            )
          : emptyState({ icon: '🗂️', title: '还没有素材', desc: '上传图片 / 音频，或者让 ComfyUI 出一张图。' }),
      ),
    );
  }

  async function refresh() {
    try {
      state.items = (await get('/api/assets?limit=500')).items ?? [];
      render();
    } catch (err) {
      host.replaceChildren(panel('素材库', null, errorBox(err, { onRetry: refresh })));
    }
  }

  async function mount() {
    host.replaceChildren(loading());
    uploadInput.addEventListener('change', (event) => uploadFiles(event.target.files));
    await refresh();
  }

  return { el, mount };
}
