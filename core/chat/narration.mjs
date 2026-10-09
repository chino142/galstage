/**
 * 叙事控制：每轮候选行动、导演插话、分支。
 *
 * 候选行动的做法参考了 flizzywine/dsh-tavern 的思路：与其让模型调用工具去推进剧情，
 * 不如让它顺手给我 3~4 个"我接下来可以怎么做"的按钮 —— 便宜、快、而且我仍然在掌舵。
 * 这里不照抄它的实现，只借这个交互形态。
 */

import { extractJson } from '../agent/prompt.mjs';

export const OPTION_COUNT_DEFAULT = 4;
export const OPTION_COUNT_RANGE = [3, 4];

export const OPTIONS_INSTRUCTION = [
  '在回复的最后另起一行，输出一个 ```options 代码块，里面是一个 JSON 数组，',
  `给我 3~4 个接下来可以做的事（第一人称、每个不超过 20 个字、彼此要有明显区别）。`,
  '例：```options\n["追问她昨晚去了哪","悄悄检查柜台下面","先回房间休息"]\n```。',
  '不要复述这段说明。',
].join('');

/**
 * 候选行动。两种来源都要认：
 *   1) 我们自己提示词要求的 ```options JSON 数组；
 *   2) 酒馆预设常用的 `<options><option>…</option></options>` —— 只认 JSON 的话，
 *      这个块会原样留在正文里，接着被预设的"把 options 渲染成 HTML 面板"那条正则
 *      炸成一份完整的 HTML 文档（实测 68 KB），最后在聊天里显示成一堆源码。
 */
export function parseOptions(text) {
  const source = String(text ?? '');
  const fenced = source.match(/```options?\s*([\s\S]*?)```/i);
  const htmlish = source.match(/<options\b[^>]*>([\s\S]*?)<\/options>/i);
  const block = fenced ?? htmlish;
  const body = block ? block[1] : source;

  let items = [];
  const tagged = [...body.matchAll(/<option\b[^>]*>([\s\S]*?)<\/option>/gi)].map((match) => match[1]);
  if (tagged.length) {
    items = tagged;
  } else {
    let parsed = extractJson(body);
    if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.options)) parsed = parsed.options;
    if (Array.isArray(parsed)) {
      items = parsed.map((item) => (typeof item === 'string' ? item : item?.text ?? item?.label ?? item?.title));
    } else if (htmlish) {
      // `<options>` 里一行一条的散装写法（预设作者之间也常见）
      items = body
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !/^<\/?[a-z][\w-]*\s*\/?>$/i.test(line));
    }
  }

  const options = items
    .map((item) => String(item ?? '').replace(/<[^>]*>/g, ' '))
    .map((item) => item.trim().replace(/^[-*\d.、）)\s]+/, ''))
    .filter(Boolean)
    .slice(0, OPTION_COUNT_RANGE[1])
    .map((text2, index) => ({ id: `opt_${index + 1}`, text: text2 }));
  if (!options.length) return { options: [], text: source };
  return { options, text: block ? source.replace(block[0], '').trimEnd() : source };
}

/** 没有模型 / 模型没给选项时的兜底，保证按钮永远有东西可点。 */
export function fallbackOptions({ worldState = {}, members = [] } = {}) {
  const options = [];
  const place = worldState.place ? `四周（${worldState.place}）` : '四周';
  options.push(`观察${place}`);
  const quest = Array.isArray(worldState.quests) ? worldState.quests.find((item) => (item.status ?? 'active') === 'active') : null;
  if (quest?.title) options.push(`推进「${quest.title}」`);
  const speaker = members.find((member) => !member.muted)?.name;
  if (speaker) options.push(`继续和${speaker}说话`);
  options.push('说点别的');
  return options.slice(0, OPTION_COUNT_DEFAULT).map((text, index) => ({ id: `opt_${index + 1}`, text, fallback: true }));
}

/** 让模型顺手生成候选行动时的附加指令。 */
export function buildOptionsRequest({ messages = [], count = OPTION_COUNT_DEFAULT } = {}) {
  return [
    ...messages,
    {
      role: 'system',
      content: `只输出 ${count} 个候选行动，用 \`\`\`options 代码块包一个 JSON 数组，不要输出别的。`,
    },
  ];
}

export const DIRECTOR_MODES = [
  { id: 'narrator', title: '旁白', summary: '以旁白身份插一句，进历史、所有模型都看得见' },
  { id: 'director', title: '导演指令', summary: '只影响这一轮：作为系统提示塞进提示词，不留在历史里' },
  { id: 'ooc', title: '场外括号', summary: '以我自己的身份插话（OOC），角色会看到' },
];

/**
 * 导演插话 → 一条消息或一段本轮注入。
 * @returns {{message:object|null, injection:string|null}}
 */
export function buildDirectorMessage(text, { mode = 'narrator', userName = '我' } = {}) {
  const content = String(text ?? '').trim();
  if (!content) throw new Error('导演插话不能是空的');
  if (mode === 'director') {
    return { message: null, injection: `【导演指令】${content}` };
  }
  if (mode === 'ooc') {
    return { message: { role: 'user', name: userName, content: `（${content}）`, extra: { ooc: true } }, injection: null };
  }
  return { message: { role: 'narrator', name: '旁白', content, extra: { narrator: true } }, injection: null };
}

/** 开分支时的标题：父标题 + 分支标记。 */
export function branchTitle(parentTitle, label = '') {
  const base = String(parentTitle ?? '对话').trim() || '对话';
  const suffix = String(label ?? '').trim();
  return suffix ? `${base} · ${suffix}` : `${base} · 分支`;
}
