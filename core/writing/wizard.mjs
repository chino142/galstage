/**
 * 建卡向导：把「先定四元组，再动笔」落成一步。
 *
 * 社区方法论里，写卡的第一步永远是四元组选型（性向 / 赛道 / 洁度 / 情绪钩子），
 * 而且这四样**只能进 tags 和内部记录，不能出现在作者的话里**——出现产品词
 * 就是机器味实锤。所以向导生成的是「标签 + 骨架 + 内部定位注释」。
 */

import { ValidationError } from '../errors.mjs';
import { ORIENTATION_AXES } from './quality.mjs';

export const OPENING_PARADIGMS = [
  {
    id: 'event',
    title: 'A 事件现场型',
    fit: '单人卡默认',
    skeleton: [
      '【时间】{时间}　【地点】{地点}　【在场】{人物}',
      '{场景蒙太奇，两三句把环境与氛围立起来}',
      '{意外事件砸进来}',
      '「{角色的第一句话——这句就是性格证明}」',
      '<details><summary>状态</summary>心情：待载入／衣着：待载入／内心 OS：待载入</details>',
    ],
  },
  {
    id: 'dual-view',
    title: 'B 双视角心理型',
    fit: '网恋 / 纯爱',
    skeleton: [
      '{角色视角的忐忑微行为：发出去又撤回、已读不回、嘴硬}',
      '＆',
      '{切 user 视角，让 user 背着情感债务进场}',
      '「{台词}」',
    ],
  },
  {
    id: 'conflict',
    title: 'C 修罗场投放型',
    fit: '虐恋 / 追妻火葬场',
    skeleton: [
      '{开场即冲突：user 的物理位置就是关系隐喻}',
      '<narration>{插叙}</narration>',
      '「{台词}」',
    ],
  },
  {
    id: 'broadcast',
    title: 'D 世界观广播型',
    fit: '群像 / 无限流，正文可短到 600 字',
    skeleton: [
      '{环境细节铺世界观}',
      '{NPC 群像各一句立脸谱}',
      '{最后一句把镜头交给 user}',
    ],
  },
  {
    id: 'tutorial',
    title: 'E 引导器型',
    fit: '模拟器',
    skeleton: [
      '{三种开局输入示例}',
      '{能玩什么}',
      '{遇事不决请用括号大法：用（）包住你的动作与意图}',
    ],
  },
];

const DEFAULT_PICK = { orientation: '全性向', genre: '都市', purity: '不洁', hooks: ['难攻略', '反差'] };

function pickAxis(id, value, fallback) {
  const axis = ORIENTATION_AXES.find((item) => item.id === id);
  if (!axis) throw new ValidationError(`未知的选型轴：${id}`);
  const raw = value === undefined || value === null || value === '' ? fallback : value;
  if (axis.multiple) {
    const list = (Array.isArray(raw) ? raw : [raw]).map((item) => String(item).trim()).filter(Boolean);
    const unknown = list.filter((item) => !axis.options.includes(item));
    if (unknown.length) throw new ValidationError(`${axis.title}里有不认识的选项：${unknown.join('、')}`);
    if (axis.max && list.length > axis.max) throw new ValidationError(`${axis.title}最多选 ${axis.max} 个`);
    return list;
  }
  const single = String(raw).trim();
  if (!axis.options.includes(single)) throw new ValidationError(`${axis.title}里有不认识的选项：${single}`);
  return single;
}

/** 给一堆选型算出标签与定位注释（注释只进 frontmatter，不进作者的话）。 */
export function planCard(input = {}) {
  const orientation = pickAxis('orientation', input.orientation, DEFAULT_PICK.orientation);
  const genre = pickAxis('genre', input.genre, DEFAULT_PICK.genre);
  const purity = pickAxis('purity', input.purity, DEFAULT_PICK.purity);
  const hooks = pickAxis('hooks', input.hooks, DEFAULT_PICK.hooks);
  const tags = [orientation, genre, purity, ...hooks];
  return {
    tags,
    axes: { orientation, genre, purity, hooks },
    // 创作定位：只放卡文件 frontmatter 注释或归档文档
    positioning: [
      `# 创作定位（不要写进作者的话）`,
      `# 性向：${orientation}`,
      `# 赛道：${genre}`,
      `# 洁度：${purity}`,
      `# 情绪钩子：${hooks.join('、')}`,
    ].join('\n'),
  };
}

/** 作者的话骨架：七要素按社区契约排好序。 */
export const CREATOR_NOTES_TEMPLATE = [
  '{性向}/{洁度}/禁：{雷点，例如「禁撅」}',
  '',
  '图：{AI 生成 / 画师署名}',
  '推荐模型：{例如 claude / glm}',
  '',
  '怎么玩：{一两句大白话的玩法教学，比如「多注意她自报的疼痛数，跟实际不一样就是在逞强」}',
  '括号大法：用（）包住你的动作与意图。',
  '',
  'v1.0 {日期} 首版。',
  '爆代码就删空行重 roll。',
  '{一句带人设风味的吐槽}',
].join('\n');

/**
 * 生成一张卡的骨架（可直接送进卡编辑器继续写）。
 * @returns {{name:string, tags:string[], fields:object, notes:string, plan:object, openingParadigm:string, outline:string[]}}
 */
export function buildCardDraft(input = {}) {
  const name = String(input.name ?? '').trim();
  if (!name) throw new ValidationError('建卡向导需要先给角色起个名字');
  const plan = planCard(input);
  const paradigm = String(input.paradigm ?? 'event');
  if (!OPENING_PARADIGMS.some((item) => item.id === paradigm)) {
    throw new ValidationError(`不认识的开场白范式：${paradigm}`);
  }
  const chosen = OPENING_PARADIGMS.find((item) => item.id === paradigm);
  const fields = {
    name,
    description: [
      `【${name}设定】`,
      '身份: ',
      '外貌: （写具体品牌 / 单品 / 年份 / 地名，不要「昂贵的西装」这种抽象形容）',
      '音色: ',
      '穿衣习惯: ',
      '饮食偏好: ',
      '兴趣爱好: ',
      '性格: ',
      '对{{user}}的情感: ',
      '简介: ',
      '角色经历: ',
    ].join('\n'),
    personality: '（不要形容词堆砌：写「在什么场景会怎么做」，外加语言指纹——口癖、方言、标点习惯）',
    scenario: '（当下冲突现场：谁在哪、正发生什么、{{user}} 为什么在场）',
    first_mes: chosen.skeleton.join('\n'),
    mes_example: '<START>\n{{user}}: \n{{char}}: ',
    system_prompt: [
      `你就是${name}本人。`,
      '扮演风格：（台词句式约束、对{{user}}的态度基线）',
      '逆境处理：（被越界/羞辱/冷落时的具体独特反应，不崩溃不发疯）',
      '禁止：上帝视角透视{{user}}内心、替{{user}}说话行动、谈论 AI 或模型、每轮总结感情。',
      '认知防火墙：你对{{user}}的了解只能来自表面观察与已发生的对话；允许猜错、误读、会错意。',
      '收束：每轮以你自己的言行收尾，留戏剧缺口；不要写「他在等你回答」，不要每轮末尾提问拉客。',
      '',
      '输出节奏四律：',
      '1. 短回复律：默认单轮 ≤120 字（含旁白）。长叙述只出现在场景转换或剧情大节点。',
      '2. 零翻译律：旁白只写可观察的物理事实，不解说情绪含义。',
      '3. 反弹律：被冒犯时第一拍只输出情绪（≤40 字），不要同轮自证清白。',
      '4. 碎句律：短句、省略主语、单词句占对白三成以上。',
      '5. 挤牙膏律：每轮最多交出一层新信息；被表白不要对等长度回应。',
      '6. 收尾冷场权：结尾不递话头、不「对了/不过」找补。',
    ].join('\n'),
    creator_notes: CREATOR_NOTES_TEMPLATE.replace('{日期}', new Date().toISOString().slice(0, 10)),
  };
  return {
    name,
    tags: plan.tags,
    fields,
    plan,
    paradigm: chosen.id,
    outline: ['整体概述', '世界观设定', '势力设定', '角色设定（基本信息 / 小传 / 外貌 / 萌点 / 性格 / 技能 / 交流习惯）'],
  };
}
