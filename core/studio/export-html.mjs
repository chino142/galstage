/**
 * 对话导出成单文件 HTML：双击就能看，方便分享与存档。
 *
 * 自带样式、不引外部资源，所以一个文件就是全部。
 */

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 极简 Markdown 行内：**粗**、*斜*、`代码`。够用而且不引依赖。 */
function inline(text) {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

export function chatToHtml({ title = '对话', card = {}, messages = [], meta = {} } = {}) {
  const charName = card.name ?? '角色';
  const rows = (Array.isArray(messages) ? messages : [])
    .filter((message) => message && message.hidden !== true)
    .map((message) => {
      const who = message.role === 'user' ? '我' : message.role === 'system' ? '系统' : charName;
      const cls = message.role === 'user' ? 'me' : message.role === 'system' ? 'sys' : 'char';
      const time = message.createdAt ? `<time>${escapeHtml(String(message.createdAt).replace('T', ' ').slice(0, 16))}</time>` : '';
      return `<div class="msg ${cls}"><div class="who">${escapeHtml(who)}${time}</div><div class="body">${inline(message.content)}</div></div>`;
    })
    .join('\n');

  const subtitle = [card.character_version ? `v${escapeHtml(card.character_version)}` : null, card.creator ? `by ${escapeHtml(card.creator)}` : null]
    .filter(Boolean).join(' · ');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:dark light}
body{margin:0;background:#14151a;color:#e6e6ea;font:15px/1.7 -apple-system,"Segoe UI",system-ui,"Noto Sans SC",sans-serif}
.wrap{max-width:820px;margin:0 auto;padding:28px 18px 60px}
header{border-bottom:1px solid #2c2e37;padding-bottom:14px;margin-bottom:22px}
h1{margin:0 0 6px;font-size:22px}
.sub{color:#9aa0ae;font-size:13px}
.msg{margin:0 0 16px;padding:10px 14px;border-radius:12px;background:#1c1e26}
.msg.me{background:#1d2433}
.msg.sys{background:#241d1d;color:#c9b8b8;font-size:13px}
.who{font-size:12px;color:#8f96a6;margin-bottom:4px;display:flex;justify-content:space-between;gap:10px}
.who time{color:#6d7383}
.body{white-space:normal}
code{background:#252833;padding:1px 5px;border-radius:4px;font-size:13px}
footer{margin-top:36px;color:#6d7383;font-size:12px;text-align:center}
</style>
</head>
<body>
<div class="wrap">
<header><h1>${escapeHtml(title)}</h1><div class="sub">${escapeHtml(charName)}${subtitle ? ' · ' + subtitle : ''}${meta.exportedAt ? ' · 导出于 ' + escapeHtml(meta.exportedAt) : ''}</div></header>
${rows}
<footer>由 Silver Tavern 导出 · ${(Array.isArray(messages) ? messages.length : 0)} 条消息</footer>
</div>
</body>
</html>
`;
}

/** Markdown 版（给喜欢纯文本的）。 */
export function chatToMarkdown({ title = '对话', card = {}, messages = [] } = {}) {
  const charName = card.name ?? '角色';
  const lines = [`# ${title}`, '', `> ${charName}${card.character_version ? ` v${card.character_version}` : ''}`, ''];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.hidden === true) continue;
    const who = message.role === 'user' ? '我' : message.role === 'system' ? '（系统）' : charName;
    lines.push(`**${who}**：${String(message.content ?? '').trim()}`, '');
  }
  return lines.join('\n');
}
