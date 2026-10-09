/**
 * 写卡质检：把社区那套"怎么写才不像 AI 写的"做成能跑的检查。
 *
 * 来源是 SillyTavern 生态里 `foreverse-app/character-card-skills` 那份方法论：
 *   - 七病灶配额制（卡面可见文案的句式纪律）
 *   - 开场白九项硬性检查
 *   - 八维评分表
 *   - 四元组选型（性向 / 赛道 / 洁度 / 情绪钩子）
 *   - 作者的话七要素
 *
 * 两条必须说清楚的话：
 *
 * 1. 这里是**启发式**检查，不是评审。原方法论的结论是"别拿 LLM 当人味评委"
 *    （双盲实验里多基座评委的正确率只有 12–33%）。所以本模块只做**规则检测**：
 *    报"命中了哪条规则、在哪一段"，不报"这卡好不好"。
 * 2. 台词（引号内角色说的话）不受句式纪律约束 —— 毒舌人设的台词就该扎人。
 *    所以扫描时默认跳过被引号包住的内容。
 */

import { ValidationError } from '../errors.mjs';

// ---------------------------------------------------------------- 七病灶

/**
 * 每条规则：id / 标题 / 配额（超过就报）/ 说明 / 正则。
 * `scope: 'quote'` 表示允许在引号内出现，只统计引号外的。
 */
export const AI_FLAVOR_RULES = [
  {
    id: 'quote-capping',
    title: '引语点题',
    quota: 1,
    advice: '把设定包装成角色俏皮引语盖章的微结构，全卡最多留一处当梗位，其余改信息平铺。',
    // 这条规则审的就是"引号结构"本身，所以必须在带引号的文本上跑
    keepQuotes: true,
    pattern: /(?:说|叫|称为|管这叫|自称|美其名曰)[^。！？\n]{0,14}[「“"][^」”"\n]{1,14}[」”"]/g,
  },
  {
    id: 'antithesis-flip',
    title: '对仗翻转',
    quota: 1,
    advice: '「不带 X，全是 Y」「不是 X，而是 Y」这类磨过的金句，读起来是精修过的痕迹。',
    pattern: /(?:不带[^，。！？\n]{0,10}，[^，。！？\n]{0,4}全是|不是[^，。！？\n]{0,12}，(?:而是|是)[^，。！？\n]{0,12})/g,
  },
  {
    id: 'invented-concept',
    title: '生造概念词',
    quota: 0,
    advice: '机制词只许在 system_prompt 和世界书里活动，出现在可见文案即穿帮，改用大白话。',
    // 词汇类问题不分旁白还是台词 —— 引号里的「胜利锚点」一样穿帮，所以不去引号
    keepQuotes: true,
    pattern: /(?:[\u4e00-\u9fa5]{2,4}(?:锚点|反向指标|进度条|行为道谢|闭环)|保护色|信任度(?:分级|体系))/g,
  },
  {
    id: 'aphorism-addiction',
    title: '金句癖 / 意味深长空镜',
    quota: 1,
    advice: '段落允许平收甚至烂尾。三连排比一张卡最多一次，空镜隐喻全删。',
    pattern: /(?:欲言又止|意味深长|空气仿佛凝固|时间仿佛静止|沉默震耳欲聋|没有说出口的)/g,
  },
  {
    id: 'fake-precision',
    title: '伪精确数字 / 半X 量词模具',
    quota: 3,
    advice: '数字轰炸是"具体性表演"。保留的数字要口语化；「半 X」模具实测 AI 簇状出现、人类基线为 0。',
    pattern: /(?:\d+\s*秒\s*\d+|第\s*\d+\s*天|[−-]\s*\d+\s*天|\d+\.\d+\s*倍速|(?:停了|退后|快了|慢了|弹出|顿|怔)了?半(?:秒|步|拍|寸|响|句))/g,
  },
  {
    id: 'spec-sheet-leak',
    title: '说明书腔外漏',
    quota: 0,
    advice: '「破功瞬间：…」这类是给模型的行为规格，只准写进 system_prompt / 世界书指导条。',
    keepQuotes: true,
    pattern: /(?:破功瞬间|触发条件|数值设定|增益效果|减益效果|冷却时间|判定规则|机制说明)[：:]/g,
  },
  {
    id: 'zero-idle-detail',
    title: '零闲笔',
    quota: 1,
    advice: '全卡至少留一处不服务任何设定的白长细节。每个细节都是功能件的卡，信息压强均匀，一读就是生成的。',
    // 反着检测：只有当"设定功能词"出现、且找不到任何闲笔候选时才报。
    functional: /(?:锚点|信号|证明|进度|伏笔|铺垫|暗示|线索|触发)/g,
    idleCandidates: /[。！？\n]([^。！？\n]{6,40})[。！？]/g,
  },
  {
    id: 'cliche-phrases',
    title: '烂大街短语',
    quota: 0,
    advice: '这批短语在模型输出里出现率极高，写在卡面上等于自己盖章。',
    pattern: /(?:眼中闪过一丝|嘴角勾起(?:一抹|一丝)|低沉磁性|张了张嘴|指节泛白|呼吸一滞|不易察觉的|几不可闻|似笑非笑|眼底划过)/g,
  },
];

/** 引号（中英文都算）—— 台词不受句式纪律约束，扫描前先挖掉。 */
const QUOTED = /[「“"][^」”"\n]*[」”"]/g;

/** 去掉 HTML / Markdown 标记，只留可见文字。 */
export function visibleText(input) {
  return String(input ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\{\{[^}]*\}\}/g, ' ')
    .replace(/[*_`#>|]/g, ' ')
    .replace(/[ \t]+/g, ' ');
}

/**
 * 扫描一段卡面文案。
 * @returns {{hits: Array<{id:string,title:string,count:number,quota:number,over:number,samples:string[],advice:string}>, total:number}}
 */
export function scanAiFlavor(text, { keepQuotes = false } = {}) {
  const raw = String(text ?? '');
  const withQuotes = visibleText(raw);
  // 台词不受句式纪律约束 —— 默认把引号里的内容挖掉再扫。
  // 例外是"引语点题"那条：它审的正是引号结构，所以标了 keepQuotes。
  const prose = withQuotes.replace(QUOTED, ' ');
  const hits = [];
  for (const rule of AI_FLAVOR_RULES) {
    const haystack = keepQuotes || rule.keepQuotes ? withQuotes : prose;
    if (rule.pattern) {
      const found = [...haystack.matchAll(rule.pattern)].map((match) => match[0]);
      if (found.length > rule.quota) {
        hits.push({
          id: rule.id,
          title: rule.title,
          count: found.length,
          quota: rule.quota,
          over: found.length - rule.quota,
          samples: [...new Set(found)].slice(0, 4),
          advice: rule.advice,
        });
      }
      continue;
    }
    if (rule.id === 'zero-idle-detail') {
      const functional = [...haystack.matchAll(rule.functional)].length;
      const sentences = [...haystack.matchAll(rule.idleCandidates)].map((match) => match[1].trim());
      // 闲笔候选：不包含任何设定功能词的句子
      const idle = sentences.filter((sentence) => !rule.functional.test(sentence) && sentence.length >= 6);
      if (functional > 0 && idle.length === 0) {
        hits.push({
          id: rule.id,
          title: rule.title,
          count: 1,
          quota: 1,
          over: 1,
          samples: [`设定功能词 ${functional} 处，找不到一处闲笔`],
          advice: rule.advice,
        });
      }
    }
  }
  return { hits, total: hits.reduce((sum, hit) => sum + hit.over, 0) };
}

// ---------------------------------------------------------------- 开场白九项

/** 去 HTML 之后的正文长度（中文字符按 1 计）。 */
export function proseLength(text) {
  return visibleText(text).replace(/\s+/g, '').length;
}

export const OPENING_CHECKS = [
  { id: 'status-bar', title: '顶部状态条', hint: '时间 / 地点 / 在场人物（emoji 行或 HTML div）' },
  { id: 'unfinished-event', title: '正在发生的未完成事件', hint: '不是静态自我介绍' },
  { id: 'character-line', title: '角色台词带性格证明', hint: '至少一句，用引号或高亮 span' },
  { id: 'user-hook', title: 'user 钩子', hint: '第二人称「你」被卷入' },
  { id: 'details-panel', title: '折叠状态面板', hint: '<details> 里放心情 / 衣着 / 内心 OS' },
  { id: 'private-life', title: '私生活证据', hint: '和别人的聊天记录 / 朋友圈 / 群聊片段' },
  { id: 'length', title: '正文长度', hint: '去 HTML 后 800–2600 字（世界观/引导器型可到 600）' },
  { id: 'open-ending', title: '结尾开放收束', hint: '以角色言行停住，不写「他在等你」' },
  { id: 'first-turn-guide', title: '首轮引导', hint: '给 2 条「第一句可以这样接」的示例' },
];

const TESTERS = {
  'status-bar': (text) => /(?:📅|🕐|🕒|📍|⌚|【\s*(?:时间|地点)|时间[:：]|地点[:：]|在场[:：])/.test(text) || /class="[^"]*(?:status|scene)[^"]*"/i.test(text),
  'unfinished-event': (text) => /(?:正在|刚刚|突然|就要|还没|尚未|即将|这时|门被|话没说完|话音未落)/.test(text),
  'character-line': (text) => /[「“"][^」”"\n]{2,}[」”"]/.test(text),
  'user-hook': (text) => /你(?:的|被|在|正|已|还|要|会|是|得|把)/.test(text),
  'details-panel': (text) => /<details[\s>]/i.test(text),
  'private-life': (text) => /(?:聊天记录|朋友圈|群聊|微博|短信|留言|动态|帖子|通话记录|私信)/.test(text),
  'open-ending': (text) => !/(?:他在等你的回答|等着你(?:的)?(?:回答|开口)|空气仿佛凝固|你打算怎么做|你会怎么做)[。？!！]?\s*$/.test(text.replace(/<[^>]*>/g, ' ').trim()),
  'first-turn-guide': (text) => /(?:可以这样接|第一句|开场建议|示例回复|这样回)/.test(text),
};

/**
 * 开场白硬性检查。
 * @param {string} firstMessage 开场白正文
 * @param {string} [creatorNotes] 作者的话（首轮引导那一项在这里找）
 * @returns {{items: Array<{id:string,title:string,ok:boolean,hint:string,detail?:string}>, passed:number, total:number}}
 */
export function checkOpening(firstMessage, creatorNotes = '') {
  const text = String(firstMessage ?? '');
  const length = proseLength(text);
  const items = OPENING_CHECKS.map((check) => {
    let ok;
    let detail;
    if (check.id === 'length') {
      ok = length >= 600 && length <= 3200;
      detail = `${length} 字`;
      if (length < 600) detail += '（偏短）';
      else if (length > 3200) detail += '（偏长，建议拆到世界书）';
    } else if (check.id === 'first-turn-guide') {
      ok = TESTERS['first-turn-guide'](`${text}\n${creatorNotes}`);
      if (!ok) detail = '建议在作者的话里补两条示例';
    } else {
      ok = TESTERS[check.id](text);
    }
    return { id: check.id, title: check.title, ok, hint: check.hint, ...(detail ? { detail } : {}) };
  });
  return { items, passed: items.filter((item) => item.ok).length, total: items.length };
}

// ---------------------------------------------------------------- 四元组

export const ORIENTATION_AXES = [
  {
    id: 'orientation',
    title: '性向',
    required: true,
    options: ['BL', 'BG', 'GL', 'GB', '女性向', '男性向', '全性向', '限左', '限右', '不限左右'],
  },
  {
    id: 'genre',
    title: '赛道',
    options: ['校园', '都市', '古风', '修仙', '娱乐圈', '星际', 'ABO', '系统', '无限流', '同人', '模拟器'],
  },
  {
    id: 'purity',
    title: '洁度',
    options: ['洁', '不洁'],
  },
  {
    id: 'hooks',
    title: '情绪钩子（1–3 个）',
    multiple: true,
    max: 3,
    options: ['难攻略', '救赎', '酸涩', '冷脸萌', '反差', '追妻火葬场', '背德', '毒舌', '年上', '年下', '青梅竹马', '万人迷'],
  },
];

const ORIENTATION_TAGS = new Set(['BL', 'BG', 'GL', 'GB', '女性向', '男性向', '全性向', '限左', '限右', '不限左右']);

/** 四元组是不是齐全：性向是硬性要求（缺了就是不合格卡）。 */
export function checkFourTuple(tags = []) {
  const list = (Array.isArray(tags) ? tags : String(tags ?? '').split(/[,，]/)).map((tag) => String(tag).trim()).filter(Boolean);
  const hasOrientation = list.some((tag) => ORIENTATION_TAGS.has(tag));
  const hasPurity = list.some((tag) => tag === '洁' || tag === '不洁');
  const hooks = list.filter((tag) => !ORIENTATION_TAGS.has(tag) && tag !== '洁' && tag !== '不洁');
  return {
    ok: hasOrientation && hasPurity,
    hasOrientation,
    hasPurity,
    hookCount: hooks.length,
    tags: list,
    missing: [...(hasOrientation ? [] : ['性向']), ...(hasPurity ? [] : ['洁度'])],
  };
}

// ---------------------------------------------------------------- 作者的话七要素

export const CREATOR_NOTE_PARTS = [
  { id: 'flag', title: '性向 / 洁度 / 雷点声明', hint: '第一行，例如「限左/洁/禁撅」' },
  { id: 'credit', title: '图源署名', hint: 'AI 生图就写「AI 生成」，不冒充画师' },
  { id: 'model', title: '模型推荐', hint: '哪家模型跑这张卡更顺' },
  { id: 'howto', title: '玩法教学', hint: '指令清单 + 括号大法' },
  { id: 'changelog', title: '更新日志', hint: '首版写 v1.0 + 日期' },
  { id: 'recovery', title: '故障自救', hint: '「爆代码就删空行重 roll」这类' },
  { id: 'voice', title: '一句带人设风味的吐槽', hint: '作者的话本身也演戏' },
];

const BANNED_PRODUCT_WORDS = /(?:对标|差异化|玩法核心|机制体系|系统命名|产品设计|用户画像)/g;

export function checkCreatorNotes(text) {
  const raw = String(text ?? '');
  const items = CREATOR_NOTE_PARTS.map((part) => {
    const ok = {
      flag: /(?:限左|限右|洁|不洁|禁|雷点|性向|BL|BG|GL)/.test(raw),
      credit: /(?:AI\s*生成|图源|绘|画师|作者\s*[:：]|avatar|封面)/i.test(raw),
      model: /(?:模型|推荐|用\s*(?:claude|gpt|gemini|deepseek|glm|kimi|qwen))/i.test(raw),
      howto: /(?:玩法|指令|可以|请|括号|输入|直接)/.test(raw),
      changelog: /(?:v?\d+\.\d+|更新|首版|版次)/.test(raw),
      recovery: /(?:爆|删|重\s*roll|重开|自救|异常|崩)/.test(raw),
      voice: raw.length > 0,
    }[part.id];
    return { id: part.id, title: part.title, hint: part.hint, ok };
  });
  const productWords = [...new Set([...raw.matchAll(BANNED_PRODUCT_WORDS)].map((match) => match[0]))];
  return {
    items,
    passed: items.filter((item) => item.ok).length,
    total: items.length,
    productWords,
    clean: productWords.length === 0,
  };
}

// ---------------------------------------------------------------- 活人感九写法

export const ALIVE_PATTERNS = [
  { id: 'micro-flaw', title: '微行为瑕疵', pattern: /(?:顿了一下|说错|改口|没接住|愣|手滑|咳|含糊|含糊过去|笨拙)/ },
  { id: 'inconsistency', title: '言行不一致', pattern: /(?:嘴上|却说|明明|偏要|口是心非|OS[:：]|心里)/ },
  { id: 'boundary', title: '拒绝与边界', pattern: /(?:不行|不要|别|拒绝|不愿意|懒得|随你|随便你)/ },
  { id: 'private-life', title: '私生活在场', pattern: /(?:朋友|同事|家里|室友|群|朋友圈|同事|老板|妈妈|爸爸)/ },
  { id: 'language-print', title: '语言指纹', pattern: /(?:口癖|方言|嘛|咧|噢|呗|咯|呀|啦|啧)/ },
  { id: 'physical-anchor', title: '物理细节锚定', pattern: /(?:攥|拎|搁|靠|贴|蹭|踢|塞|捏|压|推)/ },
  { id: 'unfinished-event', title: '未完成事件驱动', pattern: /(?:正在|还没|尚未|等下|待会|一会儿|明早|下周)/ },
  { id: 'misread', title: '认知局限与误读', pattern: /(?:以为|误认|猜|估计|大概|似乎|难道|原来不是)/ },
  { id: 'emotion-inertia', title: '情绪惯性', pattern: /(?:还在|仍然|依旧|没缓过来|余怒|缓了缓|回过神)/ },
];

export function checkAlive(text) {
  const prose = visibleText(text);
  const items = ALIVE_PATTERNS.map((item) => ({ id: item.id, title: item.title, ok: item.pattern.test(prose) }));
  return { items, passed: items.filter((item) => item.ok).length, total: items.length };
}

// ---------------------------------------------------------------- 八维评分

/**
 * 八维评分表。分值见原方法论的工具 `tools/score_card.py`。
 * 「图片提示词」这一维在本项目里读 `data.extensions.image_prompt`；
 * 没有就标成 skipped，总分按剩余维度折算到 100，不硬扣。
 */
export const CARD_DIMENSIONS = [
  { id: 'fields', title: '字段完整度', max: 13 },
  { id: 'opening', title: '开场白结构', max: 18 },
  { id: 'alive', title: '活人感九写法', max: 24 },
  { id: 'tags', title: '标签与赛道', max: 10 },
  { id: 'style', title: '卡面句式纪律', max: 12 },
  { id: 'worldbook', title: '世界书', max: 8 },
  { id: 'image', title: '图片提示词', max: 10 },
  { id: 'aiFlavor', title: '反 AI 味', max: 5 },
];

/** 卡数据可能带一层 data（V2/V3），也可能扁平（V1）。 */
export function cardBody(card = {}) {
  const data = card.data && typeof card.data === 'object' ? card.data : card;
  return data ?? {};
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * 给一张卡打分。
 * @param {object} card 卡数据（V1 扁平 / V2 / V3 都行）
 * @returns {{total:number, raw:number, scaled:boolean, dimensions:Array, issues:Array, notes:string[]}}
 */
export function scoreCard(card = {}) {
  const body = cardBody(card);
  const notes = [];
  const issues = [];

  const description = String(body.description ?? '');
  const personality = String(body.personality ?? '');
  const scenario = String(body.scenario ?? '');
  const firstMes = String(body.first_mes ?? '');
  const examples = String(body.mes_example ?? '');
  const systemPrompt = String(body.system_prompt ?? '');
  const creatorNotes = String(body.creator_notes ?? '');
  const tags = Array.isArray(body.tags) ? body.tags : String(body.tags ?? '').split(/[,，]/).filter(Boolean);
  const book = body.character_book ?? null;

  const scored = [];
  const push = (id, earned, detail) => {
    const dim = CARD_DIMENSIONS.find((item) => item.id === id);
    scored.push({ id, title: dim.title, max: dim.max, earned: clamp(Math.round(earned), 0, dim.max), detail });
  };

  // 1. 字段完整度
  const requiredFields = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'];
  const presentFields = requiredFields.filter((key) => String(body[key] ?? '').trim().length > 0);
  let fieldScore = (presentFields.length / requiredFields.length) * 9;
  if (Array.isArray(body.alternate_greetings) && body.alternate_greetings.length > 0) fieldScore += 2;
  if (systemPrompt) fieldScore += 1;
  if (creatorNotes) fieldScore += 1;
  push('fields', fieldScore, `${presentFields.length}/${requiredFields.length} 个基础字段非空`);
  for (const key of requiredFields) {
    if (!String(body[key] ?? '').trim()) issues.push({ level: 'warn', field: key, message: `字段「${key}」是空的` });
  }

  // 2. 开场白结构
  const opening = checkOpening(firstMes, creatorNotes);
  push('opening', (opening.passed / opening.total) * 18, `${opening.passed}/${opening.total} 项硬检通过`);
  for (const item of opening.items) {
    if (!item.ok) issues.push({ level: 'warn', field: 'first_mes', message: `开场白缺「${item.title}」：${item.hint}` });
  }

  // 3. 活人感九写法（在开场白 + 示例对话 + 简介上一起看）
  const alive = checkAlive(`${firstMes}\n${examples}\n${description}`);
  push('alive', (alive.passed / alive.total) * 24, `九写法命中 ${alive.passed}/${alive.total}`);
  for (const item of alive.items) {
    if (!item.ok) issues.push({ level: 'info', field: 'first_mes', message: `活人感缺「${item.title}」` });
  }

  // 4. 标签与赛道
  const tuple = checkFourTuple(tags);
  let tagScore = 0;
  if (tuple.hasOrientation) tagScore += 4;
  else issues.push({ level: 'error', field: 'tags', message: '缺少性向标签（这是不合格卡）' });
  if (tuple.hasPurity) tagScore += 2;
  tagScore += clamp(tuple.hookCount, 0, 3) * 1.3;
  if (tags.length >= 4) tagScore += 1;
  push('tags', tagScore, `${tags.length} 个标签，钩子 ${tuple.hookCount} 个`);

  // 5. 卡面句式纪律
  const flavor = scanAiFlavor(`${description}\n${personality}\n${scenario}\n${firstMes}\n${creatorNotes}`);
  push('style', 12 - Math.min(12, flavor.total * 2.5), flavor.hits.length ? `命中 ${flavor.hits.length} 类病灶` : '没有命中病灶');
  for (const hit of flavor.hits) {
    issues.push({ level: 'warn', field: 'text', message: `句式纪律：${hit.title} 出现 ${hit.count} 次（配额 ${hit.quota}）—— ${hit.advice}` });
  }

  // 6. 世界书
  const entries = Array.isArray(book?.entries) ? book.entries.length : Number(book?.entries ? Object.keys(book.entries).length : 0);
  const worldbookScore = clamp(entries, 0, 8);
  push('worldbook', worldbookScore, entries ? `${entries} 条世界书条目` : '卡内没有世界书');
  if (entries === 0) issues.push({ level: 'info', field: 'character_book', message: '没有卡内世界书；单人卡一般 8–15 条起步' });

  // 7. 图片提示词（可跳过）
  const imagePrompt = body.extensions?.image_prompt ?? body.extensions?.imagePrompt ?? '';
  const imageSkipped = !String(imagePrompt).trim();
  push('image', imageSkipped ? 0 : 10, imageSkipped ? '没有图片提示词（本维不计入折算）' : '有图片提示词');

  // 8. 反 AI 味
  push('aiFlavor', flavor.total === 0 ? 5 : 0, flavor.total === 0 ? '满分' : `扣分：${flavor.total} 处超配额`);

  const counted = scored.filter((dim) => !(dim.id === 'image' && imageSkipped));
  const raw = scored.reduce((sum, dim) => sum + dim.earned, 0);
  const max = counted.reduce((sum, dim) => sum + dim.max, 0);
  const total = imageSkipped ? Math.round((counted.reduce((sum, dim) => sum + dim.earned, 0) / max) * 100) : raw;
  if (imageSkipped) notes.push('没有图片提示词，总分按其余七维折算到 100');

  const grade = total >= 85 ? 'publish' : total >= 75 ? 'usable' : 'revise';
  return { total, raw, scaled: imageSkipped, grade, dimensions: scored, issues, notes, opening, flavor, tuple };
}

/** 总入口：一次给全（评分 + 开场白 + 句式 + 标签 + 作者的话）。 */
export function lintCard(card = {}) {
  if (!card || typeof card !== 'object') throw new ValidationError('lintCard 需要一个卡对象');
  const body = cardBody(card);
  const report = scoreCard(card);
  return {
    ...report,
    creatorNotes: checkCreatorNotes(body.creator_notes ?? ''),
    summary: {
      total: report.total,
      grade: report.grade,
      errors: report.issues.filter((issue) => issue.level === 'error').length,
      warns: report.issues.filter((issue) => issue.level === 'warn').length,
      infos: report.issues.filter((issue) => issue.level === 'info').length,
    },
  };
}
