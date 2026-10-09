/**
 * 演出层（蓝图 2.5）的纯逻辑：把一条对话 + 已经出好的图，拼成一帧可以演的舞台。
 *
 * 有意复用而不重造（2.7 与 3.1 的关系）：
 *   - 图**不在这里生成**。背景 / 立绘 / CG 都是 ComfyUI（3.1）出的，
 *     落在素材库、绑在消息或出图记录（comfy_runs）上。这里只做"挑哪张图当背景、
 *     哪几张当立绘"，要出新图就去调 3.1 的那条通道。
 *   - 也不做语音（2.6）：那需要一个新的提供方适配器，而模型接入层这次不允许动，
 *     所以语音留接口、状态保持 planned，理由写在 docs/ARCHITECTURE.md。
 *
 * Ren'Py 导出是纯文本 + 一份"要打包哪些素材"的清单，真正的 zip 在 server 侧拼
 * （素材字节从素材库读，用的是 server/toolbox/zip.mjs）。
 */

function messageLabel(message) {
  if (message.role === 'user') return message.name || '我';
  if (message.role === 'system') return message.name || '旁白';
  return message.name || '角色';
}

/** 挑出这条对话最近的背景 / 立绘 / CG，以及要演的台词。 */
export function buildStage({ chat = null, messages = [], runs = [], options = [], dialogueLimit = 8, portraitLimit = 4, expressionPack = null } = {}) {
  const done = runs.filter((run) => run?.status === 'done' && Array.isArray(run.images) && run.images.length);
  const pick = (kinds) => done.filter((run) => kinds.includes(run.kind));

  const backgrounds = pick(['background']);
  const portraits = pick(['portrait', 'expression']);
  const cgs = pick(['cg']);

  const backgroundRun = backgrounds[0] ?? null;
  const cgRun = cgs[0] ?? null;

  const seen = new Set();
  const portraitItems = [];
  // 卡内表情差分包：当前情绪有绑好的图就用它当主立绘（对话里按情绪自动换）。
  if (expressionPack?.assetId) {
    seen.add(expressionPack.assetId);
    portraitItems.push({
      assetId: expressionPack.assetId,
      runId: null,
      kind: 'expression-pack',
      name: expressionPack.name || '角色',
      emotion: expressionPack.emotion ?? null,
      messageId: null,
    });
  }
  for (const run of portraits) {
    const owner = messages.find((message) => message.id === run.messageId) ?? null;
    for (const image of run.images) {
      if (!image?.assetId || seen.has(image.assetId)) continue;
      seen.add(image.assetId);
      portraitItems.push({
        assetId: image.assetId,
        runId: run.id,
        kind: run.kind,
        name: owner?.name || run.workflowName || '角色',
        emotion: run.params?.emotion ?? owner?.extra?.stateDelta?.emotion ?? null,
        messageId: run.messageId ?? null,
      });
      if (portraitItems.length >= portraitLimit) break;
    }
    if (portraitItems.length >= portraitLimit) break;
  }

  const visible = messages.filter((message) => !message.hidden && String(message.content ?? '').trim());
  const dialogue = visible.slice(-Math.max(1, Number(dialogueLimit) || 8)).map((message) => ({
    messageId: message.id,
    role: message.role,
    name: messageLabel(message),
    content: String(message.content ?? ''),
    createdAt: message.createdAt ?? null,
  }));

  return {
    chatId: chat?.id ?? null,
    title: chat?.title ?? '',
    isGroup: Boolean(chat?.isGroup),
    scene: { place: chat?.worldState?.place ?? null, time: chat?.worldState?.time ?? null },
    background: backgroundRun
      ? { assetId: backgroundRun.images[0].assetId, runId: backgroundRun.id, createdAt: backgroundRun.createdAt ?? null, place: chat?.worldState?.place ?? null }
      : null,
    portraits: portraitItems,
    cg: cgRun ? { assetId: cgRun.images[0].assetId, runId: cgRun.id, createdAt: cgRun.createdAt ?? null } : null,
    dialogue,
    options: (options ?? []).map((option) => ({ text: option?.text ?? String(option ?? '') })).filter((option) => option.text),
    counts: { backgrounds: backgrounds.length, portraits: portraits.length, cgs: cgs.length },
  };
}

function renpyEscape(text) {
  // Ren'Py 里双引号与反斜杠要转义，换行拆成多行对白
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => line.trim());
}

function safeName(text, fallback) {
  const cleaned = String(text ?? '').replace(/[^A-Za-z0-9_\u4e00-\u9fff]/g, '_').slice(0, 24);
  return cleaned || fallback;
}

/**
 * 对话线 → Ren'Py 工程。返回脚本与"要打包哪些素材"的清单（字节由调用方补）。
 * 生成的是能直接 `renpy.sh .` 跑起来的最小工程：script.rpy + options.rpy + 图片目录。
 */
export function buildRenpyProject({ chat = null, messages = [], stage = null, options = [], title = null, music = null } = {}) {
  const lines = [];
  const files = [];
  const assetRefs = [];
  const characters = new Map();

  const defineCharacter = (name) => {
    const key = safeName(name, 'char');
    if (!characters.has(key)) characters.set(key, { key, name });
    return characters.get(key).key;
  };

  // 素材：背景 + 立绘 + CG，各给一个稳定文件名
  const images = [];
  if (stage?.background?.assetId) {
    assetRefs.push({ assetId: stage.background.assetId, name: 'images/bg_scene.png' });
    images.push(['bg_scene', 'images/bg_scene.png']);
  }
  (stage?.portraits ?? []).forEach((portrait, index) => {
    if (!portrait.assetId) return;
    const file = `images/char_${index + 1}.png`;
    assetRefs.push({ assetId: portrait.assetId, name: file });
    images.push([`char_${index + 1}`, file]);
  });
  if (stage?.cg?.assetId) {
    assetRefs.push({ assetId: stage.cg.assetId, name: 'images/cg.png' });
    images.push(['cg', 'images/cg.png']);
  }

  const projectTitle = title || stage?.title || chat?.title || 'Silver Tavern 导出';
  lines.push(`# 由 Silver Tavern 导出（蓝图 2.5「一键导出 Ren\'Py 工程」）`);
  lines.push(`# 原对话：${projectTitle}`);
  lines.push('');
  lines.push('define user = Character("[user]", color="#7fb3f0")');
  lines.push('define narrator = Character(None, what_italic=True)');
  lines.push('');

  // 先收集所有角色名，再统一 define，避免边写边 define
  const dialogue = (messages ?? []).filter((message) => !message.hidden && String(message.content ?? '').trim());
  for (const message of dialogue) {
    if (message.role === 'user' || message.role === 'system') continue;
    defineCharacter(messageLabel(message));
  }
  for (const [key, entry] of characters) lines.push(`define ${key} = Character("${entry.name}", color="#e8a0bf")`);
  lines.push('');
  images.forEach(([key, file]) => lines.push(`image ${key} = "${file}"`));
  lines.push('');
  lines.push('label start:');
  lines.push(`    # ${projectTitle}`);
  if (music?.file) lines.push(`    play music "${music.file}" fadein 1.0`);
  if (images.some(([key]) => key === 'bg_scene')) lines.push('    scene bg_scene with fade');
  let shownChar = null;
  const shownPortrait = images.find(([key]) => key.startsWith('char_'));
  if (shownPortrait) {
    shownChar = shownPortrait[0];
  }

  for (const message of dialogue) {
    const name = messageLabel(message);
    const speaker = message.role === 'user' ? 'user' : message.role === 'system' ? 'narrator' : defineCharacter(name);
    if (message.role !== 'user' && message.role !== 'system' && shownChar) {
      lines.push(`    show ${shownChar} at center`);
      shownChar = null;
    }
    for (const chunk of renpyEscape(message.content)) lines.push(`    ${speaker} "${chunk}"`);
  }

  const menuOptions = (options ?? []).filter((option) => option?.text);
  if (menuOptions.length) {
    lines.push('');
    lines.push('    menu:');
    lines.push('        # 这一轮的候选行动');
    for (const option of menuOptions) lines.push(`        "${renpyEscape(option.text)[0] ?? ''}":`);
    lines.push('            pass');
  }
  lines.push('    return');

  files.push({ name: 'script.rpy', text: `${lines.join('\n')}\n` });
  files.push({
    name: 'options.rpy',
    text: [
      `define config.name = "${projectTitle.replace(/"/g, '\\"')}"`,
      'define config.version = "1.0"',
      'define gui.about = "由 Silver Tavern 导出"',
      '',
    ].join('\n'),
  });
  files.push({
    name: 'README.md',
    text: [
      `# ${projectTitle}`,
      '',
      '这是从 Silver Tavern 导出的一条对话线。',
      '',
      '跑起来：装好 Ren\'Py SDK，把整个文件夹放进工程目录，或直接 `renpy.sh .` / `renpy.exe .`。',
      '',
      `对白 ${dialogue.length} 条，素材 ${assetRefs.length} 张。`,
      '',
    ].join('\n'),
  });

  return { title: projectTitle, files, assetRefs, stats: { dialogue: dialogue.length, assets: assetRefs.length, characters: characters.size, music: music?.file ? 1 : 0 } };
}
