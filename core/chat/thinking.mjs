/**
 * 从模型输出里把"思维链"摘出来。
 *
 * 为什么要专门做这件事：思维链的写法各家完全不同 ——
 *   · 服务端直接给 reasoning 字段（DeepSeek-R1 / Anthropic thinking / Gemini thought）
 *     —— 那条路走适配器的 thinking 事件，不经过这里
 *   · 模型自己在正文里写  thinking…  —— 这里处理
 *   · 酒馆预设更野：用 <think_nya~></think_nya~> 这种自定义标签，再配一条正则
 *     把它折成一大坨 HTML；不摘出来的话，正文里就是一整页 HTML
 *
 * 所以这里用"标签名像不像思维链"来判断（think / reasoning / analysis / 思维链 / 思考 / 内心），
 * 成对的和"只开了头、被截断"的都认。摘出来的内容交给上层存进 message.extra.reasoning，
 * 界面上默认折叠、不进上下文。
 */

const THINKING_NAME = 'think[\\w~^-]*|thinking|reasoning|analysis|思维链|思考|内心';

/** @returns {{text: string, thinking: string}} text = 去掉思维链之后的正文 */
export function splitThinkingTags(input) {
  const source = String(input ?? '');
  const paired = new RegExp(`<(${THINKING_NAME})>([\\s\\S]*?)<\\/\\1>`, 'gi');
  const parts = [];
  let rest = '';
  let last = 0;
  let match;
  while ((match = paired.exec(source))) {
    parts.push(match[2]);
    rest += source.slice(last, match.index);
    last = match.index + match[0].length;
  }
  rest += source.slice(last);

  // 只开了头没闭合（模型被 max_tokens 截断时很常见）：从那个标签起算思维链
  const dangling = new RegExp(`<(${THINKING_NAME})>`, 'i').exec(rest);
  if (dangling) {
    const tail = rest.slice(dangling.index + dangling[0].length);
    if (tail.trim()) {
      parts.push(tail);
      rest = rest.slice(0, dangling.index);
    }
  }

  return {
    text: rest.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
    thinking: parts.map((part) => String(part).trim()).filter(Boolean).join('\n\n').trim(),
  };
}
