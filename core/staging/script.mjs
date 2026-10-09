/**
 * 演出脚本（蓝图 2.5 的剧本层）：把"消息"编译成"演出时间线"。
 *
 * 剧本就是消息本身 —— 人可以手写、AI 可以生成、群聊时几个 AI 一起写，
 * 三种来源走同一条路。消息里可以夹带舞台指示，写法沿用已有的
 * `[换装: 泳装]` 那条路子（中文为主，英文别名也认）：
 *
 *   [场景: 旧书馆]          切背景（别名 背景 / BG / SCENE）
 *   [立绘: 诗音 微笑 左]    出场 / 换表情 / 站位；[立绘: 诗音 -] 退场
 *   [BGM: 雨夜]            换曲；[BGM: 停] 停掉
 *   [音效: 开门]
 *   [CG: 初雪]             弹全屏 CG（也是一次长廊解锁）
 *   [转场: 黑屏 800]
 *   [结局: 恋人线]
 *
 * 编译出来的是**逐条的帧**（frame）：
 *   - 每一帧都带"演到这一句时舞台上应该是什么样"（累积状态），
 *     所以往前翻、跳着播、读档回某一句，画面都能还原；
 *   - 帧自己也带这一句触发的动效（转场 / CG / 音效 / 结局），
 *     前端播到这一帧就直接照做，不用再猜。
 *
 * 名字 → 素材是分开的（`cast`，用户在「素材绑定」里挂）。没绑就保留名字，
 * 界面上如实说"「旧书馆」还没绑背景图"，不假装有图。
 */

// ------------------------------------------------------------------ 标记

const COLON = '\\s*[:：]\\s*';

/** 一条消息里能出现的全部舞台指示，一次扫完（顺序就是出现顺序）。 */
const MARKER_RE = new RegExp(
  `[\\[【]\\s*(${[
    '场景', '背景', 'SCENE', 'BG',
    '立绘', '角色', 'CHAR', 'PORTRAIT',
    'BGM', '音乐',
    '音效', 'SE', 'SFX',
    'CG', '事件图',
    '转场', 'TRANSITION', 'FX',
    '结局', 'ENDING',
    '章节', 'CHAPTER',
    '路线', 'ROUTE',
    '语音', 'VOICE', 'TTS',
  ].join('|')})\\s*[:：]\\s*([^\\]】]*)[\\]】]`,
  'gi',
);

/** 这两样是别的通道在管（出图 / 换装），演的时候不该出现在台词里。 */
const FOREIGN_MARKER_RE = /\[(?:IMG|换装|OUTFIT)\s*[:：][^\]]*\]/gi;

/** 卡爱把回复包成 `<game>…</game>` 再带上 `<options>` / `<summary>`：演戏只取正文。 */
const DROP_BLOCK_RE = /<\s*(options|summary|details|think[\w~.\-]*)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const GAME_BLOCK_RE = /<\s*game\s*>([\s\S]*?)<\s*\/\s*game\s*>/i;
const GAME_TAG_RE = /<\s*\/?\s*game\s*>/gi;

const TYPE_BY_KEYWORD = new Map([
  ['场景', 'scene'], ['背景', 'scene'], ['scene', 'scene'], ['bg', 'scene'],
  ['立绘', 'char'], ['角色', 'char'], ['char', 'char'], ['portrait', 'char'],
  ['bgm', 'bgm'], ['音乐', 'bgm'],
  ['音效', 'sfx'], ['se', 'sfx'], ['sfx', 'sfx'],
  ['cg', 'cg'], ['事件图', 'cg'],
  ['转场', 'transition'], ['transition', 'transition'], ['fx', 'transition'],
  ['结局', 'ending'], ['ending', 'ending'],
  ['章节', 'chapter'], ['chapter', 'chapter'],
  ['路线', 'route'], ['route', 'route'],
  ['语音', 'voice'], ['voice', 'voice'], ['tts', 'voice'],
]);

const POSITION_BY_NAME = new Map([
  ['左', 'left'], ['左边', 'left'], ['left', 'left'], ['l', 'left'],
  ['中', 'center'], ['中间', 'center'], ['中央', 'center'], ['center', 'center'], ['c', 'center'], ['mid', 'center'],
  ['右', 'right'], ['右边', 'right'], ['right', 'right'], ['r', 'right'],
]);

/** 立绘大小：近景 / 常规 / 远景（真 gal 常用同一张图缩放来演"靠近"）。 */
const SIZE_BY_NAME = new Map([
  ['大', 'big'], ['近', 'big'], ['近景', 'big'], ['big', 'big'], ['large', 'big'], ['near', 'big'],
  ['中', 'medium'], ['常规', 'medium'], ['medium', 'medium'], ['normal', 'medium'],
  ['小', 'small'], ['远', 'small'], ['远景', 'small'], ['small', 'small'], ['far', 'small'],
]);

const CLEAR_WORDS = /^(?:-|—|–|退场|退|消失|隐藏|清空|none|exit|clear|hide)$/i;
const STOP_WORDS = /^(?:停|停止|停掉|静音|无|不播|none|stop|off)$/i;

/** 解析一个立绘指示：`诗音 微笑 左` / `诗音,微笑,左` / `诗音 -`。 */
export function parseCharacterMarker(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (CLEAR_WORDS.test(raw)) return { action: 'clear' };
  const parts = raw.split(/[,，、|/\s]+/).filter(Boolean);
  const name = parts[0] ?? '';
  if (!name) return null;
  // `[立绘: 诗音 -]`：名字后面跟着"-"就是这一个角色退场
  if ((parts[1] && CLEAR_WORDS.test(parts[1])) || parts.slice(1).some((part) => CLEAR_WORDS.test(part))) {
    return { action: 'clear', name };
  }
  const rest = parts.slice(1);
  const positionPart = rest.find((part) => POSITION_BY_NAME.has(part.toLowerCase())) ?? '';
  const sizePart = rest.find((part) => SIZE_BY_NAME.has(part.toLowerCase())) ?? '';
  const emotion = rest.find((part) => !POSITION_BY_NAME.has(part.toLowerCase()) && !SIZE_BY_NAME.has(part.toLowerCase())) ?? '';
  return {
    action: 'show',
    name,
    emotion: emotion.slice(0, 40),
    position: POSITION_BY_NAME.get(positionPart.toLowerCase()) ?? 'center',
    size: SIZE_BY_NAME.get(sizePart.toLowerCase()) ?? 'medium',
  };
}

/** 解析一个转场指示：`黑屏 800` / `fade-black:1200` / `闪白`。 */
export function parseTransitionMarker(value, effectIds = []) {
  const raw = String(value ?? '').trim();
  const alias = new Map([
    ['黑屏', 'fade-black'], ['淡入', 'fade-black'], ['fade', 'fade-black'], ['fade-black', 'fade-black'],
    ['闪白', 'flash-white'], ['白闪', 'flash-white'], ['flash', 'flash-white'], ['flash-white', 'flash-white'],
    ['震动', 'shake'], ['抖', 'shake'], ['shake', 'shake'],
    ['左移', 'pan-left'], ['pan-left', 'pan-left'],
    ['右移', 'pan-right'], ['pan-right', 'pan-right'],
    ['不转场', 'none'], ['无', 'none'], ['none', 'none'],
  ]);
  const [namePart = '', numberPart = ''] = raw.split(/[,，:：\s]+/).filter(Boolean);
  const found = alias.get(namePart.toLowerCase()) ?? null;
  const effect = found && (!effectIds.length || effectIds.includes(found)) ? found : null;
  const duration = Math.round(Number(numberPart));
  return { effect, durationMs: Number.isFinite(duration) && duration > 0 ? Math.min(5000, duration) : null, raw };
}

/**
 * 扫一条消息里所有的舞台指示。返回 { markers, text }：
 *   markers —— [{ type, value, raw }]，按出现顺序
 *   text    —— 把指示全部剥掉之后的台词（空白收干净）
 */
export function parseScriptLine(content) {
  const source = String(content ?? '');
  const markers = [];
  const re = new RegExp(MARKER_RE.source, MARKER_RE.flags);
  let match;
  while ((match = re.exec(source)) !== null) {
    const type = TYPE_BY_KEYWORD.get(String(match[1] ?? '').toLowerCase());
    if (!type) continue;
    const value = String(match[2] ?? '').trim();
    if (!value) continue;
    markers.push({ type, value, raw: match[0] });
  }
  const cleaned = source
    .replace(new RegExp(MARKER_RE.source, MARKER_RE.flags), '')
    .replace(new RegExp(FOREIGN_MARKER_RE.source, FOREIGN_MARKER_RE.flags), '')
    .replace(DROP_BLOCK_RE, '');
  const game = GAME_BLOCK_RE.exec(cleaned);
  const text = (game ? game[1] : cleaned)
    .replace(GAME_TAG_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { markers, text };
}

/** 演出标记是否出现在这段文字里（写卡 / 提示词体检用）。 */
export function hasScriptMarkers(text) {
  return new RegExp(MARKER_RE.source, MARKER_RE.flags).test(String(text ?? ''));
}

/** 把标记用法写成一段说明 —— 直接塞进提示词，AI 就知道该怎么写。 */
export function scriptMarkerGuide() {
  return [
    '【演出指示】想指挥舞台时，在回复里另起一行写方括号指示（不写就沿用上一句）：',
    '[场景: 地点名] 切背景；[立绘: 角色名 表情 左/中/右] 出场或换表情，[立绘: 角色名 -] 退场；',
    '[BGM: 曲名] 换背景音乐（[BGM: 停] 停掉）；[音效: 音效名]；',
    '[CG: 图名] 弹一张全屏 CG；[转场: 黑屏/闪白/震动/左移/右移 毫秒]；[结局: 结局名]。',
    '[章节: 第一章 雪] 走一次章节标题卡；[路线: 恋人线] 进这条线（其它线锁上）。',
    '立绘还能带大小：[立绘: 阿狸 微笑 左 大]（大 / 中 / 小）。',
    '（[语音: 音色名] 这个位置先留着 —— 等接上语音合成再用。）',
    '指示单独占一行，不要写进对白句子里。',
  ].join('');
}

// ------------------------------------------------------------------ 时间线

function messageLabelOf(message) {
  if (message?.role === 'user') return message.name || '我';
  if (message?.role === 'system') return message.name || '旁白';
  return message.name || '角色';
}

/** 说话人名字：中英文数字加几个常用的间隔号，别的字符（括号、书名号）不算名字。 */
const SPEAKER_NAME_RE = /^[\p{L}\p{N}*·・_\-]{1,20}$/u;

/** 一段话开头是 `名字：「…」` 就算这个角色的台词，否则算旁白。 */
function splitSpeaker(paragraph) {
  const match = /^([^\s：:「」『』\n]{1,20})\s*[:：]\s*([\s\S]*)$/.exec(paragraph);
  if (!match || !SPEAKER_NAME_RE.test(match[1])) return { name: '', text: paragraph };
  const name = match[1];
  const body = match[2].trim();
  if (body.startsWith('「') || body.startsWith('『')) {
    const close = body.startsWith('「') ? '」' : '』';
    const end = body.indexOf(close);
    if (end > 0) {
      const inner = body.slice(1, end).trim();
      const trailing = body.slice(end + 1).trim();
      return { name, text: trailing ? `${inner}\n${trailing}` : inner };
    }
  }
  return { name, text: body };
}

/**
 * 一条消息切成"台词拍"。
 *
 * 真 gal 里旁白和角色台词是分开推进的，而 AI（和人）习惯把一段写成
 * `艾莉卡：「…」` 夹着旁白，全塞在一条消息里。所以按空行分段，每段单独成拍：
 * 认得出说话人的挂名字牌，认不出的当旁白（不挂名字牌）。一条消息最多切 12 拍，
 * 免得一整章塞在一条消息里把时间线撑爆。
 */
export function splitBeats(text, max = 12) {
  const blocks = String(text ?? '')
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  const beats = [];
  for (const block of blocks) {
    if (beats.length >= max) break;
    const { name, text: line } = splitSpeaker(block);
    if (!line) continue;
    beats.push({ name, text: line });
  }
  if (!beats.length) {
    const fallback = String(text ?? '').trim();
    if (fallback) beats.push({ name: '', text: fallback });
  }
  return beats;
}

/**
 * 这一拍该挂谁的名字。
 *   - 认得出说话人的就直接用；
 *   - 我发的言用我的人设名；
 *   - 括号开头（（旁白））永远算旁白；
 *   - 一段里既有台词又有旁白时，没名字的算旁白；
 *   - 整条只有一句话又没写名字（卡就爱这么写），还是算这个角色说的。
 */
function beatName(beat, message, totalBeats) {
  if (beat.name) return beat.name;
  if (message?.role === 'system') return '';
  if (message?.role === 'user') return messageLabelOf(message);
  if (/^[（(]/.test(String(beat.text ?? '').trim())) return '';
  if (totalBeats > 1) return '';
  return messageLabelOf(message);
}

/** 名单里挑一个素材：先精确（名字@表情），再只按名字，最后兜底 `*`。 */
function pickAsset(table, ...keys) {
  for (const key of keys) {
    if (!key) continue;
    const hit = table?.[key] ?? table?.[String(key).toLowerCase()];
    if (hit) return hit;
  }
  return table?.['*'] ?? null;
}

/**
 * 消息 → 演出时间线。
 *
 * `max` 是安全阀（一条超长对话不至于把界面拖垮），默认 600 帧。
 * 返回的 `cgs` 是"这部剧里出现过的所有 CG"，画廊拿它做剪影清单。
 */
export function buildTimeline({ messages = [], cast = {}, max = 600, transitionIds = [] } = {}) {
  const table = {
    backgrounds: cast?.backgrounds ?? {},
    portraits: cast?.portraits ?? {},
    cg: cast?.cg ?? {},
    bgm: cast?.bgm ?? {},
    sfx: cast?.sfx ?? {},
  };

  let scene = null;
  let background = null; // { name, assetId }
  let bgm = null; // { name, assetId }
  let cg = null; // { name, assetId } —— CG 是舞台的一部分，文字翻页时它不消失
  const characters = new Map(); // key → { key, name, emotion, position, assetId }
  const frames = [];
  const cgs = [];
  const seenCg = new Set();
  const endings = [];

  const snapshotCharacters = () => [...characters.values()].map((item) => ({ ...item }));

  for (const message of messages ?? []) {
    if (!message || message.hidden) continue;
    const { markers, text } = parseScriptLine(message.content);
    if (!markers.length && !text) continue;

    const effect = { transition: null, cg: null, sfx: [], ending: null, voice: [], chapter: null, route: null, sceneChanged: false, bgmChanged: false };
    let sceneLabel = null;

    for (const marker of markers) {
      if (marker.type === 'scene') {
        sceneLabel = marker.value;
        const assetId = pickAsset(table.backgrounds, marker.value);
        background = { name: marker.value, assetId: assetId ?? null };
        cg = null; // 换场景就把 CG 收掉，跟真 gal 一样
        scene = marker.value;
        effect.sceneChanged = true;
      } else if (marker.type === 'char') {
        const parsed = parseCharacterMarker(marker.value);
        if (!parsed) continue;
        if (parsed.action === 'clear') {
          // 写了名字就只退这一个；`[立绘: -]` 才是全部清场
          if (parsed.name) {
            for (const [key, entry] of characters) {
              if (entry.name === parsed.name) characters.delete(key);
            }
          } else {
            characters.clear();
          }
          continue;
        }
        const key = parsed.emotion ? `${parsed.name}@${parsed.emotion}` : parsed.name;
        const assetId = pickAsset(table.portraits, key, parsed.name) ?? characters.get(parsed.name)?.assetId ?? null;
        characters.delete(parsed.name);
        for (const [existingKey, entry] of characters) {
          if (entry.name === parsed.name) characters.delete(existingKey);
        }
        characters.set(key, {
          key,
          name: parsed.name,
          emotion: parsed.emotion,
          position: parsed.position,
          size: parsed.size ?? 'medium',
          assetId: assetId ?? null,
        });
      } else if (marker.type === 'bgm') {
        if (STOP_WORDS.test(marker.value)) {
          bgm = { name: '停', assetId: null, stop: true };
        } else {
          bgm = { name: marker.value, assetId: pickAsset(table.bgm, marker.value) ?? null, stop: false };
        }
        effect.bgmChanged = true;
      } else if (marker.type === 'sfx') {
        effect.sfx.push({ name: marker.value, assetId: pickAsset(table.sfx, marker.value) ?? null });
      } else if (marker.type === 'cg') {
        if (CLEAR_WORDS.test(marker.value) || STOP_WORDS.test(marker.value)) {
          cg = null;
        } else {
          const assetId = pickAsset(table.cg, marker.value) ?? null;
          cg = { name: marker.value, assetId };
          effect.cg = { name: marker.value, assetId, messageId: message.id ?? null };
          if (!seenCg.has(marker.value)) {
            seenCg.add(marker.value);
            cgs.push({ name: marker.value, assetId, messageId: message.id ?? null });
          }
        }
      } else if (marker.type === 'transition') {
        const parsed = parseTransitionMarker(marker.value, transitionIds);
        if (parsed.effect && parsed.effect !== 'none') effect.transition = parsed;
      } else if (marker.type === 'ending') {
        effect.ending = { name: marker.value };
        endings.push({ name: marker.value, messageId: message.id ?? null });
      } else if (marker.type === 'voice') {
        // 语音（蓝图 2.6）还没接：这里先把位置占住，标记也不会漏进台词。
        effect.voice.push({ name: marker.value });
      } else if (marker.type === 'chapter') {
        effect.chapter = { name: marker.value };
      } else if (marker.type === 'route') {
        effect.route = { name: marker.value };
      }
    }

    // 一条消息切成几拍：每拍单独推进，旁白不挂名字牌
    const beats = splitBeats(text);
    const sources = beats.length ? beats : [{ name: '', text: '' }];
    for (const [beatIndex, beat] of sources.entries()) {
      const speaker = beatName(beat, message, sources.length);
      frames.push({
        index: frames.length,
        messageId: message.id ?? null,
        beat: beatIndex,
        role: message.role ?? 'assistant',
        name: speaker,
        narration: !speaker,
        text: beat.text,
        silent: !beat.text,
        scene: sceneLabel ?? scene,
        stage: {
          background: background ? { ...background } : null,
          bgm: bgm ? { ...bgm } : null,
          cg: cg ? { ...cg } : null,
          characters: snapshotCharacters(),
        },
        // 指示挂在第一拍上：转场 / CG / 音效都是"这句话开始的时候"发生的事
        effect: beatIndex === 0 ? effect : { transition: null, cg: null, sfx: [], ending: null, voice: [], chapter: null, route: null, sceneChanged: false, bgmChanged: false },
        markers: beatIndex === 0 ? markers.map((marker) => ({ type: marker.type, value: marker.value })) : [],
        createdAt: message.createdAt ?? null,
      });
      if (frames.length >= Math.max(1, Number(max) || 600)) break;
    }

    if (frames.length >= Math.max(1, Number(max) || 600)) break;
  }

  return {
    frames,
    total: frames.length,
    cgs,
    endings,
    scenes: [...new Set(frames.map((frame) => frame.scene).filter(Boolean))],
  };
}
