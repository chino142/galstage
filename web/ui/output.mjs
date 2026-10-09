/**
 * 生成结果的展示弹窗：一段长文本 + 复制 / 下载 .md。
 * 创作辅助（对话成章、剧本、素材抽取）都用它，避免每个视图各写一套。
 */

import { h } from '../core/dom.mjs';
import { openModal } from './modal.mjs';
import { toast } from './toast.mjs';
import { t } from '../core/i18n.mjs';

export function downloadText(filename, text, mime = 'text/markdown') {
  const blob = new Blob([String(text ?? '')], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename || 'output.md' });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * @param {{ title?: string, text?: string, filename?: string, meta?: any, extra?: any }} options
 */
export function openTextOutput({ title = '结果', text = '', filename = 'output.md', meta = null, extra = null } = {}) {
  const content = String(text ?? '');
  openModal({
    title,
    width: 'min(880px, 94vw)',
    body: h('div', { class: 'output-body' }, meta, extra, h('pre', { class: 'output-text' }, content || '（空）')),
    actions: [
      {
        label: t('btn.copy'),
        onClick: async () => {
          try {
            await navigator.clipboard?.writeText(content);
            toast('已复制');
          } catch {
            toast('浏览器不给复制权限，手动选中吧', { tone: 'warn' });
          }
          return false; // 不关窗，方便接着改 / 复制
        },
      },
      {
        label: '下载 .md',
        primary: true,
        onClick: () => downloadText(filename, content),
      },
    ],
  });
}
