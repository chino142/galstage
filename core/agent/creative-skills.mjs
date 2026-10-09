/**
 * 创作辅助技能（蓝图 3.2「创作辅助」）。
 *
 * 和 writing-skills.mjs 一个套路：拼提示词 → 让模型输出 JSON → extractJson 容错解析。
 * 三个技能分别对应蓝图里的三件事：
 *   chapter.polish        一段对话 → 小说章节（润色 + 分段 + 排版）
 *   script.from_card       角色卡 → 世界书条目 + 分场剧本（一条龙）
 *   chat.extract_entities  对话 / 文本 → 人物 / 地点 / 物品的结构化条目
 *
 * 素材抽取的做法说明（蓝图要求"看源码确认，能参考就参考，不能就自己定一版并注明"）：
 * 参考了 flizzywine/dsh-tavern `tavern-plugin/prompts/card-task-extract.md` 与
 * `card-task-worldbook.md` 的思路（信息够就直接做、专有名词必须进触发键、
 * 一条只讲一件事），以及它世界书条目的字段形状（title/keys/content/constant）。
 * 那两个文件是提示词而不是可移植的实现，所以这里是自己写的一版；条目最终落成
 * 我们自己的世界书条目（酒馆形状），没有代码移植，未登记进 NOTICE 的移植表。
 */

import { extractJson } from './prompt.mjs';
import { ValidationError } from '../errors.mjs';

const JSON_RULES = '只输出一个 JSON 对象，不要输出解释、不要用 markdown 代码块。文字内容用简体中文。';

async function askJson(model, { system, user, temperature = 0.75, maxTokens = 4096 }) {
  const reply = await model.complete({
    system: `${system}\n\n输出要求：${JSON_RULES}`,
    messages: [{ role: 'user', content: user }],
    params: { temperature, max_tokens: maxTokens },
  });
  const parsed = extractJson(reply.text);
  if (!parsed) {
    throw new ValidationError(`模型没有返回可解析的 JSON：${String(reply.text ?? '').slice(0, 200)}`);
  }
  return parsed;
}

function clip(value, limit) {
  return String(value ?? '').slice(0, limit);
}

function cardBrief(card = {}) {
  return [
    `名字：${clip(card.name, 80)}`,
    `简介：${clip(card.description, 900)}`,
    `性格：${clip(card.personality, 400)}`,
    `场景：${clip(card.scenario, 400)}`,
    `开场白：${clip(card.first_mes, 400)}`,
    `对话示例：${clip(card.mes_example, 600)}`,
    `标签：${(card.tags ?? []).join('、')}`,
  ].join('\n');
}

/** 把"人物 / 地点 / 物品"三组条目统一成世界书能存的样子。 */
export function entitiesToWorldbookEntries(entities = {}, { prefix = '' } = {}) {
  const out = [];
  const add = (kind, item) => {
    if (!item) return;
    const name = String(item.name ?? item.title ?? '').trim();
    const content = String(item.description ?? item.content ?? '').trim();
    if (!name || !content) return;
    const keys = (Array.isArray(item.keys) ? item.keys : []).map((key) => String(key).trim()).filter(Boolean);
    const aliases = (Array.isArray(item.aliases) ? item.aliases : []).map((alias) => String(alias).trim()).filter(Boolean);
    const merged = [...new Set([name, ...aliases, ...keys])].slice(0, 20);
    out.push({
      comment: `${prefix}${kind}：${name}`,
      keys: merged,
      content,
      constant: item.constant === true,
    });
  };
  for (const item of entities.characters ?? []) add('人物', item);
  for (const item of entities.places ?? []) add('地点', item);
  for (const item of entities.items ?? []) add('物品', item);
  return out;
}

export const CREATIVE_SKILLS = [
  {
    id: 'chapter.polish',
    title: '把对话变成小说章节',
    category: 'novel',
    description: '把一段角色扮演对话润色成小说：补描写、分段落、定标题，输出可以直接复制或导出的正文。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '对话原文（服务端会自动拼好，也可以手写）' },
        title: { type: 'string', description: '章节标题，留空让模型起' },
        style: { type: 'string', description: '文风，例如 轻小说 / 冷峻 / 温馨' },
        pov: { type: 'string', description: '视角，例如 第三人称限定 / 第一人称' },
        words: { type: 'number', description: '目标字数，默认按原文长度决定' },
      },
      required: ['text'],
    },
    async handler({ input, model }) {
      if (!input.text) throw new ValidationError('需要 text（对话原文）');
      const words = Math.min(Math.max(Number(input.words ?? 0) || Math.round(String(input.text).length * 0.8), 300), 6000);
      return askJson(model, {
        system: '你是小说章节编辑：把角色扮演对话改写成小说章节。保留对话里的信息与人物口吻，补足动作、环境与心理描写，删掉"用户：""角色："这类聊天痕迹。',
        user: [
          input.title ? `章节标题（沿用）：${input.title}` : '章节标题：请起一个',
          input.style ? `文风：${input.style}` : '',
          input.pov ? `视角：${input.pov}` : '视角：第三人称限定',
          `目标长度：约 ${words} 字`,
          '',
          '原文：',
          clip(input.text, 24000),
          '',
          '输出 JSON：',
          '{"title":"章节标题","chapters":[{"heading":"小标题（可空）","text":"正文段落"}],' +
            '"text":"完整正文（段落之间用空行分开，不要 markdown 标题符号）","notes":"一句话说明改动"}',
          '正文要分段：每段聚焦一个动作或一次对话来回，不要写成一大坨。',
        ]
          .filter(Boolean)
          .join('\n'),
        maxTokens: 8192,
      });
    },
  },

  {
    id: 'script.from_card',
    title: '角色卡 → 世界书 → 剧本',
    category: 'novel',
    description: '一张角色卡一条龙：抽出该进世界书的设定，再排出分场剧本与关键节拍。',
    parameters: {
      type: 'object',
      properties: {
        card: { type: 'object', description: '角色卡字段对象' },
        acts: { type: 'number', description: '要几幕，默认 3' },
        length: { type: 'string', description: '想要的长短，例如 短篇 / 十话' },
      },
      required: ['card'],
    },
    async handler({ input, model }) {
      const acts = Math.min(Math.max(Number(input.acts ?? 3), 1), 8);
      return askJson(model, {
        system: '你是剧本策划：先把角色卡里"模型会忘记但剧情需要"的设定整理成世界书条目，再把故事排成分场剧本。',
        user: [
          '角色卡：',
          cardBrief(input.card ?? {}),
          input.length ? `预计篇幅：${input.length}` : '',
          '',
          `输出 JSON：{"title":"剧本名","logline":"一句话故事","worldbook":[{"comment":"条目标题",` +
            '"keys":["触发关键词"],"content":"40-200字正文","constant":false}],' +
            '"scenes":[{"act":"第几幕","scene":"场次标题","goal":"这场要达成什么","beats":["节拍1","节拍2"]}],' +
            '"script":"分场剧本正文（按场次分段，每场给场景、人物、对白与动作）"}',
          `worldbook 最多 12 条，scenes 排 ${acts} 幕。专有名词、人名、地名必须进 keys。`,
        ]
          .filter(Boolean)
          .join('\n'),
        maxTokens: 8192,
      });
    },
  },

  {
    id: 'chat.extract_entities',
    title: '从对话抽取素材',
    category: 'novel',
    description: '从一段对话里提炼人物、地点、物品，给好触发关键词，可一键存进世界书。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '对话或资料原文' },
        maxPerKind: { type: 'number', description: '每类最多几条，默认 12' },
      },
      required: ['text'],
    },
    async handler({ input, model }) {
      if (!input.text) throw new ValidationError('需要 text');
      const maxPerKind = Math.min(Math.max(Number(input.maxPerKind ?? 12), 1), 30);
      return askJson(model, {
        system: '你在做素材抽取：从对话里整理人物、地点、物品。只写文本里出现过或能明确推出来的信息，不要编。专有名词必须进 keys。',
        user: [
          clip(input.text, 24000),
          '',
          `每类最多 ${maxPerKind} 条。输出 JSON：`,
          '{"characters":[{"name":"","aliases":[],"keys":["专有名词"],"description":"30-150字：身份、外貌、性格、与其它人的关系"}],' +
            '"places":[{"name":"","aliases":[],"keys":["专有名词"],"description":"30-150字：在哪、什么样子、发生过什么"}],' +
            '"items":[{"name":"","aliases":[],"keys":["专有名词"],"description":"30-150字：是什么、在谁手里、有什么意义"}],' +
            '"relations":[{"from":"","to":"","type":"关系类型","note":"一句话"}]}',
          '没提到的类别给空数组，不要硬凑。',
        ].join('\n'),
      });
    },
  },
];
