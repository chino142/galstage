/**
 * 写卡技能。
 *
 * 每个技能都是"拼提示词 → 让模型输出 JSON → 解析"。
 * 提示词里明确要求 JSON，再配合 extractJson 的容错（代码块、前后带废话都能吃）。
 * 技能只依赖注入进来的 model.complete，不关心用的是哪家模型。
 */

import { extractJson } from './prompt.mjs';
import { ValidationError } from '../errors.mjs';

const JSON_RULES = '只输出一个 JSON 对象，不要输出解释、不要用 markdown 代码块。所有字段用简体中文（除非明确要求其它语言）。';

async function askJson(model, { system, user, temperature = 0.7, maxTokens = 2048 }) {
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
    `系统提示：${clip(card.system_prompt, 300)}`,
  ].join('\n');
}

export const WRITING_SKILLS = [
  {
    id: 'card.draft',
    title: '生成角色卡草稿',
    category: 'card',
    description: '给一句设定（或一段对图的内容描述），产出一张能直接开演的角色卡草稿。',
    parameters: {
      type: 'object',
      properties: {
        idea: { type: 'string', description: '角色想法，一句话也行' },
        name: { type: 'string', description: '已有名字时填这里' },
        tone: { type: 'string', description: '风格，例如治愈 / 悬疑 / 搞笑' },
      },
      required: ['idea'],
    },
    async handler({ input, model }) {
      if (!input.idea) throw new ValidationError('需要 idea');
      return askJson(model, {
        system: '你是资深的 AI 角色扮演角色卡设计师，懂得怎么写才能让模型容易扮演、不跑偏。',
        user: [
          `设定想法：${input.idea}`,
          input.name ? `名字：${input.name}` : '名字：请起一个合适的',
          input.tone ? `风格：${input.tone}` : '',
          '',
          '输出 JSON，字段如下：',
          '{"name":"","nickname":"","description":"人设与外貌，150-400字","personality":"性格要点",' +
            '"scenario":"故事发生的场景","first_mes":"开场白，要能直接把场景演起来",' +
            '"mes_example":"两到三组对话示例，以 {{user}}: 和 {{char}}: 开头","tags":["..."],' +
            '"system_prompt":"给模型的扮演指令","creator_notes":"创作备注"}',
        ]
          .filter(Boolean)
          .join('\n'),
      });
    },
  },

  {
    id: 'card.rewrite',
    title: '改写角色卡字段',
    category: 'card',
    description: '按你的要求改写某一个字段，例如"性格写得更冷淡一点"。',
    parameters: {
      type: 'object',
      properties: {
        field: { type: 'string', description: '字段名，如 description / personality / first_mes' },
        text: { type: 'string', description: '原文' },
        instruction: { type: 'string', description: '你想怎么改' },
      },
      required: ['field', 'text', 'instruction'],
    },
    async handler({ input, model }) {
      return askJson(model, {
        system: '你是角色卡编辑，擅长在保持人物一致性的前提下按指令改写文字。',
        user: [
          `字段：${input.field}`,
          `改写要求：${input.instruction}`,
          '',
          '原文：',
          clip(input.text, 4000),
          '',
          '输出 JSON：{"text":"改写后的内容","note":"一句话说明改了什么"}',
        ].join('\n'),
      });
    },
  },

  {
    id: 'card.inspect',
    title: '角色卡体检',
    category: 'card',
    description: '检查人设矛盾、称呼不一致、示例跑偏、信息缺失等问题。',
    parameters: {
      type: 'object',
      properties: { card: { type: 'object', description: '角色卡字段对象' } },
      required: ['card'],
    },
    async handler({ input, model }) {
      return askJson(model, {
        system: '你是角色卡校对，专门找出会让人物扮演崩掉的问题。',
        user: [
          '请体检这张卡：',
          cardBrief(input.card ?? {}),
          '',
          '输出 JSON：{"score":0-100,"issues":[{"field":"字段名","severity":"high|medium|low",' +
            '"problem":"问题","suggestion":"怎么改"}],"summary":"总体评价"}',
          '没问题时 issues 给空数组，不要硬凑。',
        ].join('\n'),
      });
    },
  },

  {
    id: 'card.greeting',
    title: '生成开场白',
    category: 'card',
    description: '为已有角色生成若干条开场白或替代开场白。',
    parameters: {
      type: 'object',
      properties: {
        card: { type: 'object' },
        count: { type: 'number', description: '要几条，默认 3' },
        style: { type: 'string', description: '例如 日常 / 冲突 / 悬念' },
      },
      required: ['card'],
    },
    async handler({ input, model }) {
      const count = Math.min(Math.max(Number(input.count ?? 3), 1), 6);
      return askJson(model, {
        system: '你写视觉小说风格的开场白：有画面、有动作、有台词，最后留一个让玩家能接话的口子。',
        user: [
          '角色：',
          cardBrief(input.card ?? {}),
          input.style ? `风格：${input.style}` : '',
          '',
          `输出 ${count} 条，JSON：{"greetings":["..."]}`,
          '每条 80-200 字。用 {{char}} 指角色、{{user}} 指玩家。',
        ]
          .filter(Boolean)
          .join('\n'),
      });
    },
  },

  {
    id: 'worldbook.extract',
    title: '从文本抽取世界书条目',
    category: 'worldbook',
    description: '把一段设定资料拆成一条条世界书条目，并给出触发关键词。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '设定原文' },
        maxEntries: { type: 'number', description: '最多几条，默认 12' },
      },
      required: ['text'],
    },
    async handler({ input, model }) {
      const maxEntries = Math.min(Math.max(Number(input.maxEntries ?? 12), 1), 40);
      return askJson(model, {
        system: '你把设定资料整理成世界书条目：一条只讲一件事，关键词要精确（专有名词优先），正文 40-200 字。',
        user: [
          clip(input.text, 12000),
          '',
          `最多 ${maxEntries} 条。输出 JSON：`,
          '{"entries":[{"comment":"条目标题","keys":["主关键词"],"secondary_keys":[],"content":"正文","constant":false}]}',
          '专有名词、人名、地名必须进 keys；通用词不要当关键词。',
        ].join('\n'),
        maxTokens: 4096,
      });
    },
  },

  {
    id: 'card.tags',
    title: '生成标签',
    category: 'card',
    description: '给角色卡生成便于检索的标签。',
    parameters: {
      type: 'object',
      properties: { card: { type: 'object' }, count: { type: 'number' } },
      required: ['card'],
    },
    async handler({ input, model }) {
      const count = Math.min(Math.max(Number(input.count ?? 8), 3), 15);
      return askJson(model, {
        system: '你给角色卡打标签，标签要短、可检索、能区分人物。',
        user: [cardBrief(input.card ?? {}), '', `输出 JSON：{"tags":["..."],"note":""}，共 ${count} 个。`].join('\n'),
      });
    },
  },

  {
    id: 'text.translate',
    title: '翻译',
    category: 'text',
    description: '中英互译，保留 {{char}} / {{user}} 这类占位符和换行结构。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        target: { type: 'string', description: 'zh 或 en' },
        style: { type: 'string' },
      },
      required: ['text', 'target'],
    },
    async handler({ input, model }) {
      return askJson(model, {
        system: '你是翻译。保留 {{char}} {{user}} 等占位符原样不动，保留换行与段落结构。',
        user: [
          `目标语言：${input.target === 'en' ? '英语' : '中文'}`,
          input.style ? `语气：${input.style}` : '',
          '',
          clip(input.text, 8000),
          '',
          '输出 JSON：{"text":"译文"}',
        ]
          .filter(Boolean)
          .join('\n'),
        maxTokens: 4096,
      });
    },
  },

  {
    id: 'text.summarize',
    title: '压缩文本',
    category: 'text',
    description: '把冗长的设定压缩成更短但信息不丢的版本。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        maxChars: { type: 'number', description: '目标字数，默认 400' },
        keep: { type: 'string', description: '必须保留的内容' },
      },
      required: ['text'],
    },
    async handler({ input, model }) {
      const maxChars = Math.min(Math.max(Number(input.maxChars ?? 400), 80), 4000);
      return askJson(model, {
        system: '你压缩设定文本：删冗余、留事实，不改写设定本身。',
        user: [
          `目标长度：约 ${maxChars} 字`,
          input.keep ? `必须保留：${input.keep}` : '',
          '',
          clip(input.text, 12000),
          '',
          '输出 JSON：{"text":"压缩后的文本"}',
        ]
          .filter(Boolean)
          .join('\n'),
        maxTokens: 4096,
      });
    },
  },
];
