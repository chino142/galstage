/**
 * 思维链的拆分与折叠。
 *
 * 有些模型会把「想什么」和「说什么」一起吐出来。玩卡时通常只想看后者，
 * 但调参数时又想看前者 —— 所以拆开存，界面上默认折叠。
 *
 * 认三种写法：` thinking…<｜end▁of▁thinking｜>`、`<reasoning>…</reasoning>`、
 * 以及常见的中文「思考过程：」分隔线。
 */

const BLOCK_PATTERNS = [
  { open: /<think(?:ing)?>/i, close: /<\/think(?:ing)?>/i },
  { open: /<reasoning>/i, close: /<\/reasoning>/i },
  { open: /<analysis>/i, close: /<\/analysis>/i },
];

const LABEL_SPLIT = /^(?:思考过程|推理过程|内心思考|thinking|reasoning)\s*[:：]\s*/i;
const LABEL_END = /^(?:正式回复|回复|正文|answer|output)\s*[:：]\s*/i;

/** 把一条消息拆成「思考」和「正文」。没有思考块时 reasoning 为空串。 */
export function splitReasoning(text) {
  let content = String(text ?? '');
  let reasoning = '';

  for (const pattern of BLOCK_PATTERNS) {
    const open = content.search(pattern.open);
    if (open === -1) continue;
    const afterOpen = content.slice(open).replace(pattern.open, '');
    const close = afterOpen.search(pattern.close);
    const body = close === -1 ? afterOpen : afterOpen.slice(0, close);
    const rest = close === -1 ? '' : afterOpen.slice(close).replace(pattern.close, '');
    reasoning += (reasoning ? '\n' : '') + body.trim();
    content = (content.slice(0, open) + rest).trim();
  }

  if (!reasoning) {
    const lines = content.split('\n');
    if (lines.length >= 2 && LABEL_SPLIT.test(lines[0].trim())) {
      const rest = lines.slice(1);
      const endIndex = rest.findIndex((line) => LABEL_END.test(line.trim()));
      if (endIndex !== -1) {
        reasoning = rest.slice(0, endIndex).join('\n').trim();
        content = rest.slice(endIndex).map((line) => line.replace(LABEL_END, '')).join('\n').trim();
      }
    }
  }

  return { reasoning: reasoning.trim(), content: content.trim() };
}

export function hasReasoning(text) {
  return splitReasoning(text).reasoning.length > 0;
}
