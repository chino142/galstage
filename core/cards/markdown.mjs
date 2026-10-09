/**
 * 模块化卡：用 Markdown 写整张卡，再转成卡数据。
 *
 * 抄自社区那套 `card.md` 中间格式。理由很实在：
 * **角色卡是散文**。一个 2000 字的开场白塞在 JSON 字符串里没法评审 ——
 * 没有有意义的 diff、没有行内注释、到处是转义换行。写成 Markdown 之后
 * 可读、可 diff、可分工（世界观和角色设定两个人并行写）。
 *
 * 形状：
 *   ---
 *   name: 角色名
 *   scenario: 一句话场景
 *   tags: [限左, 都市]
 *   ---
 *   ## Description
 *   ## First Message
 *   ## Lorebook
 *   ### 条目名 | keys: a, b | order: 250
 */

import { ValidationError } from '../errors.mjs';
import { parseNotationBlock, toNotationBlock } from '../worldbook/notation.mjs';

/** 章节名（大小写不敏感）→ 卡字段。 */
const SECTION_TO_FIELD = {
  description: 'description',
  'character description': 'description',
  personality: 'personality',
  'personality summary': 'personality',
  scenario: 'scenario',
  'first message': 'first_mes',
  'first message / 开场白': 'first_mes',
  'opening message': 'first_mes',
  'example dialogue': 'mes_example',
  examples: 'mes_example',
  'examples of dialogue': 'mes_example',
  "creator's notes": 'creator_notes',
  'creator notes': 'creator_notes',
  'author notes': 'creator_notes',
  'system prompt': 'system_prompt',
  'post-history instructions': 'post_history_instructions',
};

const ALTERNATE = /^alternate greeting(?:s)?\s*(\d+)?$/i;

function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { meta: {}, comments: [], body: text };
  const meta = {};
  const comments = [];
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      comments.push(line.replace(/^#\s?/, ''));
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*)\s*[:：]\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].trim();
    let value = kv[2].trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value
        .slice(1, -1)
        .split(/[,，]/)
        .map((item) => item.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else if (/^\d+$/.test(value)) {
      value = Number(value);
    } else {
      value = value.replace(/^["']|["']$/g, '');
    }
    meta[key] = value;
  }
  return { meta, comments, body: text.slice(match[0].length) };
}

/** 把 Markdown 切成 `## 章节`。 */
export function splitSections(body) {
  const sections = [];
  let current = null;
  for (const rawLine of String(body ?? '').split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(rawLine);
    if (heading) {
      current = { title: heading[1].trim(), lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(rawLine);
  }
  return sections.map((section) => ({ title: section.title, text: section.lines.join('\n').trim() }));
}

/**
 * Markdown → 卡数据。
 * @returns {{card:object, lorebook:Array, comments:string[], unknowns:string[]}}
 */
export function cardFromMarkdown(markdown) {
  const text = String(markdown ?? '');
  if (!text.trim()) throw new ValidationError('Markdown 是空的');
  const { meta, comments, body } = parseFrontmatter(text);
  const sections = splitSections(body);

  const data = { extensions: {} };
  const lorebook = [];
  const unknowns = [];
  const alternateGreetings = [];

  for (const section of sections) {
    const key = section.title.toLowerCase().trim();
    if (key === 'lorebook' || key === 'worldbook' || key === '世界书') {
      const { entries } = parseNotationBlock(section.text);
      lorebook.push(...entries);
      continue;
    }
    const alt = ALTERNATE.exec(section.title.trim());
    if (alt) {
      alternateGreetings.push(section.text);
      continue;
    }
    const field = SECTION_TO_FIELD[key];
    if (field) {
      data[field] = section.text;
      continue;
    }
    unknowns.push(section.title);
    // 不认识的章节当作创作笔记，塞进 extensions 里不丢
    data.extensions[`md_${key.replace(/[^\w]+/g, '_')}`] = section.text;
  }

  if (meta.name) data.name = String(meta.name);
  if (meta.scenario) data.scenario = String(meta.scenario);
  if (meta.system_prompt) data.system_prompt = String(meta.system_prompt);
  if (meta.creator) data.creator = String(meta.creator);
  if (meta.character_version) data.character_version = String(meta.character_version);
  if (Array.isArray(meta.tags)) data.tags = meta.tags;
  if (meta.image_prompt) data.extensions.image_prompt = String(meta.image_prompt);
  if (alternateGreetings.length) data.alternate_greetings = alternateGreetings;
  if (lorebook.length) data.character_book = { entries: lorebook, name: `${data.name ?? '未命名'}的世界书` };
  if (comments.length) data.extensions.md_positioning = comments.join('\n');
  if (!Object.keys(data.extensions).length) delete data.extensions;

  return { card: data, lorebook, comments, unknowns };
}

/** 卡数据 → Markdown（导出给别人继续写）。 */
export function markdownFromCard(card = {}, { lorebook = null } = {}) {
  const data = card.data && typeof card.data === 'object' ? card.data : card;
  const lines = ['---'];
  lines.push(`name: ${data.name ?? '未命名'}`);
  if (data.scenario) lines.push(`scenario: ${String(data.scenario).replace(/\n/g, ' ')}`);
  if (Array.isArray(data.tags) && data.tags.length) lines.push(`tags: [${data.tags.join(', ')}]`);
  if (data.creator) lines.push(`creator: ${data.creator}`);
  if (data.character_version) lines.push(`character_version: "${data.character_version}"`);
  if (data.extensions?.image_prompt) lines.push(`image_prompt: ${data.extensions.image_prompt}`);
  if (data.system_prompt) lines.push(`system_prompt: ${String(data.system_prompt).replace(/\n/g, ' ')}`);
  if (data.extensions?.md_positioning) {
    for (const line of String(data.extensions.md_positioning).split('\n')) lines.push(`# ${line}`);
  }
  lines.push('---', '');

  const push = (title, value) => {
    const text = String(value ?? '').trim();
    if (!text) return;
    lines.push(`## ${title}`, text, '');
  };
  push('Description', data.description);
  push('Personality', data.personality);
  push('Scenario', data.scenario);
  push('First Message', data.first_mes);
  (data.alternate_greetings ?? []).forEach((greeting, index) => push(`Alternate Greeting ${index + 1}`, greeting));
  push('Example Dialogue', data.mes_example);
  push('System Prompt', data.system_prompt);
  push('Post-History Instructions', data.post_history_instructions);

  const entries = lorebook ?? data.character_book?.entries ?? [];
  if (Array.isArray(entries) && entries.length) {
    lines.push('## Lorebook', '', toNotationBlock(entries), '');
  }
  push("Creator's Notes", data.creator_notes);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
