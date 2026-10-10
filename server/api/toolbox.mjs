/**
 * 工具箱接口。
 *
 * 业务都在 engine.services.* 里，这里只做"收参数 → 调服务 → 出响应"。
 * ComfyUI（3.1）已实现；花费统计与备份维护（3.2）在后面的迁移里补上。
 */

import { readSettings, writeSettings } from '../db/settings.mjs';
import { createComfyClient, normaliseBaseUrl } from '../toolbox/comfy.mjs';
import { ENCRYPTED_BACKUP_EXT, decryptBuffer, encryptBuffer } from '../backup-crypto.mjs';
import { COMFY_LAUNCH_DENIED, COMFY_LAUNCHER_KEYS, SERVER_COMFY_DENIED, deniesHostActions, deniesServerComfy } from './_helpers.mjs';
import { listBindings, listProviders } from '../db/providers.mjs';
import { describePromptKit, normalisePromptKit } from '../../core/toolbox/prompt-kit.mjs';

const COMFY_KEYS = [
  'comfy.enabled',
  'comfy.baseUrl',
  'comfy.trigger',
  'comfy.marker',
  'comfy.timeoutMs',
  'comfy.executionMode',
  'comfy.autoStart',
  'comfy.launcher.command',
  'comfy.launcher.args',
  'comfy.launcher.cwd',
  'comfy.idleStopMinutes',
  'comfy.activeLoraSet',
  'comfy.promptKit',
];

function pickComfySettings(all = {}) {
  const out = {};
  for (const key of COMFY_KEYS) out[key] = all[key];
  return out;
}

export function register(router, { engine, repo, comfyRunner, comfyLauncher = null, runtime }) {
  const comfy = engine.services.comfy;
  const scheduler = runtime?.scheduler ?? null;

  // ------------------------------------------------------------------ ComfyUI

  router.get('/api/comfy/config', (ctx) =>
    ctx.json(200, {
      settings: pickComfySettings(readSettings(repo)),
      kinds: comfy.kinds(),
      placeholders: comfy.placeholders(),
      executionModes: comfy.executionModes(),
      expressions: comfy.expressions(),
      clientId: comfyRunner?.clientId ?? null,
      launcher: { available: Boolean(comfyLauncher) },
    }),
  );

  router.put('/api/comfy/config', async (ctx) => {
    const patch = (await ctx.body()) ?? {};
    const clean = {};
    for (const key of COMFY_KEYS) if (patch[key] !== undefined) clean[key] = patch[key];
    // 成员不许把执行模式改回 server（那是让主机去连他填的地址 = SSRF）
    if (clean['comfy.executionMode'] === 'server' && deniesServerComfy(ctx)) {
      return ctx.fail(403, 'FORBIDDEN', SERVER_COMFY_DENIED);
    }
    // 启动命令同理：那是"在主机上执行命令"，成员一律 403
    if (COMFY_LAUNCHER_KEYS.some((key) => clean[key] !== undefined) && deniesHostActions(ctx)) {
      return ctx.fail(403, 'FORBIDDEN', COMFY_LAUNCH_DENIED);
    }
    return ctx.json(200, { settings: pickComfySettings(writeSettings(repo, clean)) });
  });

  /**
   * 酒馆托管 ComfyUI 的启动。
   * 「启动」按钮走 force=true（配了就拉，不看自动开关）；出图前那条路走 force=false，
   * 只有开了「出图前自动拉起」才动手。
   */
  router.get('/api/comfy/launcher', (ctx) => {
    if (!comfyLauncher) return ctx.json(200, { available: false, status: null });
    return ctx.json(200, { available: true, status: comfyLauncher.status() });
  });

  router.post('/api/comfy/launch', async (ctx) => {
    if (deniesHostActions(ctx)) return ctx.fail(403, 'FORBIDDEN', COMFY_LAUNCH_DENIED);
    if (!comfyLauncher) return ctx.fail(501, 'NOT_IMPLEMENTED', '这一版没有启用 ComfyUI 启动托管');
    const result = await comfyLauncher.ensure({ force: true });
    if (!result?.ok) {
      const why =
        result?.reason === 'not-configured'
          ? '还没配「ComfyUI 启动命令」：在下面填好命令 / 参数 / 工作目录再点启动。'
          : `ComfyUI 没起来：${(result?.logs ?? []).join(' / ') || '没拿到输出'}`;
      return ctx.fail(400, 'VALIDATION_ERROR', why);
    }
    return ctx.json(200, { ...result, status: comfyLauncher.status() });
  });

  router.post('/api/comfy/stop', (ctx) => {
    if (deniesHostActions(ctx)) return ctx.fail(403, 'FORBIDDEN', COMFY_LAUNCH_DENIED);
    if (!comfyLauncher) return ctx.fail(501, 'NOT_IMPLEMENTED', '这一版没有启用 ComfyUI 启动托管');
    const stopped = comfyLauncher.stop('手动');
    return ctx.json(200, { stopped, status: comfyLauncher.status() });
  });

  /** 连接状态：连不上也返回 200 + ok:false + 人话原因，界面直接显示。 */
  router.get('/api/comfy/status', async (ctx) => ctx.json(200, await comfy.status()));

  router.post('/api/comfy/test', async (ctx) => {
    // 浏览器直连模式下这一条不能由主机代测：那又变成"主机去请求用户填的地址"。
    if (comfy.executionMode() === 'client') {
      return ctx.json(200, { ok: null, client: true, note: '浏览器直连模式：连接测试在浏览器里做，主机不向这个地址发请求。' });
    }
    const body = (await ctx.body()) ?? {};
    if (body.baseUrl) {
      // 允许"先试一下这个地址"而不必先保存
      const probe = createComfyClient({ baseUrl: normaliseBaseUrl(body.baseUrl), timeoutMs: body.timeoutMs ?? 8000 });
      return ctx.json(200, { ...(await probe.test()), baseUrl: probe.baseUrl });
    }
    return ctx.json(200, await comfy.test());
  });

  router.get('/api/comfy/queue', async (ctx) => {
    const queue = await comfy.queue();
    const runs = comfy.runs({ limit: 20 }).items.filter((run) => run.status === 'queued' || run.status === 'running');
    return ctx.json(200, { ...queue, runs });
  });

  router.get('/api/comfy/workflows', (ctx) =>
    ctx.json(200, comfy.listWorkflows({ kind: ctx.query.kind ?? null, search: ctx.query.search ?? '' })),
  );

  router.post('/api/comfy/workflows', async (ctx) => ctx.json(201, comfy.importWorkflow(await ctx.body())));

  /** 内置示例工作流（蓝图 3.1「预设几个常用工作流」）。 */
  router.get('/api/comfy/presets', (ctx) => ctx.json(200, comfy.presets()));

  /** 以某份已导入工作流为母版，按它的模型来源生成一套"跟本机对得上"的预设。 */
  router.post('/api/comfy/presets/derive', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    if (!body.workflowId) return ctx.fail(400, 'VALIDATION_ERROR', '要指定以哪份工作流为母版');
    return ctx.json(201, comfy.derivePresets(body.workflowId, { import: body.dryRun !== true }));
  });

  router.post('/api/comfy/presets/:id', async (ctx) =>
    ctx.json(201, comfy.importPreset(ctx.params.id, (await ctx.body()) ?? {})),
  );

  router.get('/api/comfy/workflows/:id', (ctx) => ctx.json(200, comfy.getWorkflow(ctx.params.id)));

  router.put('/api/comfy/workflows/:id', async (ctx) => ctx.json(200, comfy.saveWorkflow(ctx.params.id, await ctx.body())));

  router.delete('/api/comfy/workflows/:id', (ctx) => {
    comfy.removeWorkflow(ctx.params.id);
    return ctx.noContent();
  });

  /** 工作流里所有可填输入 + 可用的占位符，界面拿它做参数绑定面板。 */
  router.get('/api/comfy/workflows/:id/inputs', (ctx) => ctx.json(200, comfy.inputs(ctx.params.id)));

  // ------------------------------------------------------------------ LoRA（目录 + 组合）

  /** 这台 ComfyUI 上有哪些 LoRA（问它的节点定义，扫的是 models/loras 目录）。 */
  router.get('/api/comfy/loras', async (ctx) => ctx.json(200, await comfy.listLoras()));

  /** 存下来的几套 LoRA 组合（一套 = 选中的 LoRA + 权重 + 触发词）。 */
  router.get('/api/comfy/lora-sets', (ctx) => ctx.json(200, comfy.listLoraSets()));
  router.post('/api/comfy/lora-sets', async (ctx) => ctx.json(201, comfy.saveLoraSet((await ctx.body()) ?? {})));
  router.put('/api/comfy/lora-sets/:id', async (ctx) => ctx.json(200, comfy.saveLoraSet({ ...((await ctx.body()) ?? {}), id: ctx.params.id })));
  router.delete('/api/comfy/lora-sets/:id', (ctx) => {
    comfy.removeLoraSet(ctx.params.id);
    return ctx.noContent();
  });

  /** 当前出图套哪套 LoRA（留空 = 不用）。 */
  router.put('/api/comfy/lora-active', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    const next = writeSettings(repo, { 'comfy.activeLoraSet': String(body.id ?? '') });
    return ctx.json(200, { activeId: next['comfy.activeLoraSet'] ?? '' });
  });

  // ------------------------------------------------------------------ 出图提示词加工台

  /** 词替换 + 风格预设 + 质量词（照酒馆那套扩展的做法）。 */
  router.get('/api/comfy/prompt-kit', (ctx) => ctx.json(200, comfy.promptKit()));

  router.put('/api/comfy/prompt-kit', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    const merged = normalisePromptKit({ ...comfy.promptKit(), ...body });
    writeSettings(repo, { 'comfy.promptKit': JSON.stringify(merged) });
    return ctx.json(200, describePromptKit(merged));
  });

  /** 只算不发：预览替换后的 prompt，调参数时能立刻看到效果。 */
  router.post('/api/comfy/workflows/:id/preview', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    return ctx.json(
      200,
      comfy.preview({
        workflowId: ctx.params.id,
        values: body.values ?? {},
        chatId: body.chatId ?? null,
        memberId: body.memberId ?? null,
        seed: body.seed ?? null,
        context: body.context ?? {},
        loraSetId: body.loraSetId ?? null,
      }),
    );
  });

  router.post('/api/comfy/run', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    if (!body.workflowId) return ctx.fail(400, 'VALIDATION_ERROR', '出图要指定 workflowId');
    const run = await comfy.run({
      workflowId: body.workflowId,
      chatId: body.chatId ?? null,
      messageId: body.messageId ?? null,
      memberId: body.memberId ?? null,
      values: body.values ?? {},
      context: body.context ?? {},
      seed: body.seed ?? null,
      reason: body.reason ?? 'manual',
      loraSetId: body.loraSetId ?? null,
    });
    return ctx.json(202, run);
  });

  router.get('/api/comfy/runs', (ctx) =>
    ctx.json(
      200,
      comfy.runs({
        chatId: ctx.query.chatId ?? null,
        messageId: ctx.query.messageId ?? null,
        workflowId: ctx.query.workflowId ?? null,
        status: ctx.query.status ?? null,
        limit: ctx.query.limit ?? 50,
      }),
    ),
  );

  router.get('/api/comfy/runs/:id', (ctx) => ctx.json(200, comfy.getRun(ctx.params.id)));

  /** 这张图是哪次出的 + 当时的正向提示词（双击重出 / 改提示词重出靠它）。 */
  router.get('/api/comfy/runs/by-asset/:assetId', (ctx) => {
    const found = comfy.runByAsset(ctx.params.assetId);
    if (!found) return ctx.fail(404, 'NOT_FOUND', '找不到这张图对应的出图记录（可能是手动上传的素材）');
    return ctx.json(200, found);
  });

  /** 重出：同一份工作流再发一次；可以顺手改提示词（种子会自动换一个）。 */
  router.post('/api/comfy/runs/:id/rerun', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    return ctx.json(202, await comfy.rerunRun(ctx.params.id, {
      prompt: body.prompt ?? null,
      seed: body.seed ?? null,
    }));
  });

  /** 删掉一条出图记录（图留在素材库，只清记录）。界面上的「删除记录」走这里。 */
  router.delete('/api/comfy/runs/:id', (ctx) => {
    comfy.removeRun(ctx.params.id);
    return ctx.noContent();
  });

  /** 让界面能"立刻刷一下"，不用等轮询。 */
  router.post('/api/comfy/runs/:id/refresh', async (ctx) => {
    const run = comfy.getRun(ctx.params.id);
    // client 模式下主机不能去请求用户地址，刷新只是把本地记录原样返回。
    if (comfyRunner && comfy.executionMode() !== 'client') await comfyRunner.refreshRun(run.id);
    return ctx.json(200, comfy.getRun(ctx.params.id));
  });

  router.post('/api/comfy/runs/:id/cancel', async (ctx) => ctx.json(200, await comfy.cancel(ctx.params.id)));

  // ------------------------------------------------------------------ 浏览器直连（client 模式）

  /** 浏览器已经拿到 promptId，登记这次执行（runId 存在表示"领走一条 pending-client"）。 */
  router.post('/api/comfy/client-runs', async (ctx) => ctx.json(201, comfy.registerClientRun((await ctx.body()) ?? {})));

  /** 浏览器回写进度 / 状态 / 图片 / 错误。 */
  router.put('/api/comfy/client-runs/:id', async (ctx) => ctx.json(200, comfy.updateClientRun(ctx.params.id, (await ctx.body()) ?? {})));

  // ------------------------------------------------------------------ 加分项（3.1）：批量表情 / 参考图 / 角色绑定

  /** 表情清单（批量差分与表情包都用它）。 */
  router.get('/api/comfy/expressions', (ctx) => ctx.json(200, { items: comfy.expressions() }));

  /** 一次出多个表情差分。 */
  router.post('/api/comfy/batch-expressions', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    if (!body.workflowId) return ctx.fail(400, 'VALIDATION_ERROR', '批量表情要指定 workflowId');
    return ctx.json(202, await comfy.runBatchExpressions({
      workflowId: body.workflowId,
      emotions: body.emotions ?? null,
      chatId: body.chatId ?? null,
      messageId: body.messageId ?? null,
      memberId: body.memberId ?? null,
      values: body.values ?? {},
      context: body.context ?? {},
      seed: body.seed ?? null,
      loraSetId: body.loraSetId ?? null,
    }));
  });

  /** 图生图 / 局部重绘 / 扩图：参考图从素材库来。 */
  router.post('/api/comfy/img2img', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    if (!body.workflowId) return ctx.fail(400, 'VALIDATION_ERROR', '要指定 workflowId');
    if (!body.referenceAssetId) return ctx.fail(400, 'VALIDATION_ERROR', '要指定 referenceAssetId（参考图）');
    return ctx.json(202, await comfy.runWithReference({
      workflowId: body.workflowId,
      referenceAssetId: body.referenceAssetId,
      maskAssetId: body.maskAssetId ?? null,
      chatId: body.chatId ?? null,
      messageId: body.messageId ?? null,
      memberId: body.memberId ?? null,
      values: body.values ?? {},
      context: body.context ?? {},
      seed: body.seed ?? null,
      reason: body.reason ?? 'img2img',
      loraSetId: body.loraSetId ?? null,
    }));
  });

  /** 角色 → 工作流 / LoRA / 表情差分包。 */
  router.get('/api/comfy/character-bindings', (ctx) => ctx.json(200, comfy.listCharacterBindings()));
  router.get('/api/comfy/character-bindings/:characterId', (ctx) => ctx.json(200, comfy.getCharacterBinding(ctx.params.characterId)));
  router.put('/api/comfy/character-bindings/:characterId', async (ctx) =>
    ctx.json(200, comfy.saveCharacterBinding(ctx.params.characterId, (await ctx.body()) ?? {})),
  );
  router.delete('/api/comfy/character-bindings/:characterId', (ctx) => {
    comfy.removeCharacterBinding(ctx.params.characterId);
    return ctx.noContent();
  });

  /** 角色的衣柜：多套装（每套一段提示词）+ 现在穿哪套 + 角色专属负面词。 */
  router.get('/api/comfy/outfits/:characterId', (ctx) => ctx.json(200, comfy.getOutfits(ctx.params.characterId)));
  router.put('/api/comfy/outfits/:characterId', async (ctx) =>
    ctx.json(200, comfy.saveOutfits(ctx.params.characterId, (await ctx.body()) ?? {})),
  );
  router.delete('/api/comfy/outfits/:characterId', (ctx) => {
    comfy.removeOutfits(ctx.params.characterId);
    return ctx.noContent();
  });

  // ------------------------------------------------------------------ 花费与统计

  const cost = engine.services.cost;
  const rangeQuery = (ctx) => ({
    from: ctx.query.from ?? null,
    to: ctx.query.to ?? null,
    days: ctx.query.days ?? undefined,
  });

  router.get('/api/cost/summary', (ctx) => ctx.json(200, cost.summary(rangeQuery(ctx))));
  router.get('/api/cost/by-chat', (ctx) => ctx.json(200, cost.byChat(rangeQuery(ctx))));
  router.get('/api/cost/by-character', (ctx) => ctx.json(200, cost.byCharacter(rangeQuery(ctx))));
  router.get('/api/cost/by-day', (ctx) => ctx.json(200, cost.byDay(rangeQuery(ctx))));
  router.get('/api/cost/usage', (ctx) => ctx.json(200, cost.recent({ ...rangeQuery(ctx), chatId: ctx.query.chatId ?? null, limit: ctx.query.limit ?? 50 })));

  /**
   * 界面上那排「+ 模型名」的候选。
   *
   * 以前这里写死一张常见价目表（GPT-4o / Claude 3.5 / Gemini 1.5 那一代），
   * 过一阵就全是老型号。现在改成**从你自己配的提供方和模型绑定里现取** ——
   * 你在「模型接入」里换模型，这边跟着变，永远不会老。
   * 价格取提供方 params 里的 priceIn / priceOut（填过就带上），没填就留空让你照账单填。
   */
  function pricingSuggestions() {
    const out = [];
    const seen = new Set();
    const push = (provider, model) => {
      const name = String(model ?? '').trim();
      const key = `${provider.id}|${name.toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      const params = provider.params && typeof provider.params === 'object' ? provider.params : {};
      const priceIn = Number(params.priceIn);
      const priceOut = Number(params.priceOut);
      out.push({
        providerId: provider.id,
        providerLabel: provider.label ?? '',
        model: name,
        label: name || `${provider.label ?? '提供方'}（默认模型）`,
        hasPrice: Number.isFinite(priceIn) && Number.isFinite(priceOut),
        priceIn: Number.isFinite(priceIn) ? priceIn : null,
        priceOut: Number.isFinite(priceOut) ? priceOut : null,
      });
    };
    const chatProviders = listProviders(repo, { kind: 'chat' }).filter((provider) => provider.enabled !== false);
    for (const provider of chatProviders) push(provider, provider.model);
    // 绑定里写过的模型（一个对话单独绑过的那种）也要出现
    for (const binding of listBindings(repo, { kind: 'chat' })) {
      const provider = chatProviders.find((item) => item.id === binding.providerId);
      if (provider && binding.model) push(provider, binding.model);
    }
    return out;
  }

  router.get('/api/cost/pricing', (ctx) => ctx.json(200, { ...cost.listPricing(), suggestions: pricingSuggestions() }));
  router.put('/api/cost/pricing', async (ctx) => ctx.json(200, cost.savePricing(await ctx.body())));
  router.post('/api/cost/pricing', async (ctx) => ctx.json(201, cost.savePricing(await ctx.body())));
  router.delete('/api/cost/pricing/:id', (ctx) => {
    cost.removePricing(ctx.params.id);
    return ctx.noContent();
  });

  // ------------------------------------------------------------------ 月度 / 年度报告
  const review = engine.services.review;

  /** 可选区间：有过数据的月份 / 年份，外加"现在"。 */
  router.get('/api/review/periods', (ctx) => ctx.json(200, review.periods()));

  /** 一份报告：scope = month | year | all，period = 'YYYY-MM' | 'YYYY'（all 时忽略）。 */
  router.get('/api/review/report', (ctx) =>
    ctx.json(200, review.report({ scope: ctx.query.scope ?? 'month', period: ctx.query.period ?? null })),
  );

  /** AI 旁白：前端点按钮才调，会花 token。没配模型会明确报错。 */
  router.post('/api/review/narration', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    return ctx.json(200, await review.narration({ scope: body.scope ?? 'month', period: body.period ?? null }));
  });

  // ------------------------------------------------------------------ 备份与维护

  const maintenance = engine.services.maintenance;

  router.get('/api/maintenance/backups', (ctx) => ctx.json(200, maintenance.listBackups()));

  router.post('/api/maintenance/backup', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    return ctx.json(
      201,
      await engine.services.tasks.run(
        { kind: 'backup', title: `一键备份${body.label ? `（${body.label}）` : ''}` },
        () => maintenance.createBackup({ label: body.label ?? null, kind: body.kind ?? 'manual' }),
      ),
    );
  });

  router.post('/api/maintenance/restore', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    if (!body.name) return ctx.fail(400, 'VALIDATION_ERROR', '要指定要恢复的备份（name）');
    return ctx.json(
      200,
      await engine.services.tasks.run(
        { kind: 'restore', title: `恢复备份 ${body.name}` },
        () => maintenance.restoreBackup({ name: body.name }),
      ),
    );
  });

  router.delete('/api/maintenance/backups/:name', (ctx) => {
    if (!maintenance.removeBackup(ctx.params.name)) return ctx.fail(404, 'NOT_FOUND', `没有这份备份：${ctx.params.name}`);
    return ctx.noContent();
  });

  router.get('/api/maintenance/stats', (ctx) => ctx.json(200, maintenance.stats()));

  router.get('/api/maintenance/scan', (ctx) => ctx.json(200, maintenance.scan()));

  router.post('/api/maintenance/scan', (ctx) => ctx.json(200, maintenance.scan()));

  router.post('/api/maintenance/cleanup', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    return ctx.json(
      200,
      await engine.services.tasks.run(
        { kind: 'cleanup', title: '体检与清理' },
        () => maintenance.cleanup({ targets: body.targets ?? null, backupFirst: body.backupFirst !== false }),
      ),
    );
  });

  /**
   * 加密导出：先做一份普通全量备份，再用**你自己给的口令**加密成 .stbk 下载。
   * 主机管理员也解不开（口令不落盘）—— 这就是多用户模式下"数据在你手里"的兑现方式。
   */
  router.post(
    '/api/maintenance/export-encrypted',
    async (ctx) => {
      const body = (await ctx.body()) ?? {};
      const made = maintenance.createBackup({ label: body.label ?? '加密导出', kind: 'export' });
      const bytes = runtime?.backupStore?.readBytes?.(made.name) ?? null;
      if (!bytes) return ctx.fail(500, 'BACKUP_READ_FAILED', '备份文件读不出来');
      const encrypted = encryptBuffer(bytes, String(body.passphrase ?? ''));
      const filename = `${made.name}${ENCRYPTED_BACKUP_EXT}`;
      ctx.res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': encrypted.length,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      });
      ctx.res.end(encrypted);
      return undefined;
    },
    { bodyLimit: 4 * 1024 * 1024 },
  );

  /** 从加密备份恢复：解密 → 收进备份目录 → 走正常的恢复流程（恢复前照样自动留一份）。 */
  router.post(
    '/api/maintenance/import-encrypted',
    async (ctx) => {
      const body = (await ctx.body()) ?? {};
      const data = String(body.data ?? '').replace(/^data:[^,]*,/, '');
      if (!data) return ctx.fail(400, 'VALIDATION_ERROR', '要带上 data（加密备份文件的 base64）');
      const decrypted = decryptBuffer(Buffer.from(data, 'base64'), String(body.passphrase ?? ''));
      const adopted = runtime?.backupStore?.adoptZip?.({
        buffer: decrypted,
        label: body.label ?? '导入的加密备份',
        kind: 'imported',
      });
      if (!adopted) return ctx.fail(500, 'BACKUP_IMPORT_FAILED', '备份收不进备份目录');
      const restored = maintenance.restoreBackup({ name: adopted.name });
      return ctx.json(200, { imported: adopted.name, ...restored });
    },
    { bodyLimit: 256 * 1024 * 1024 },
  );

  // ------------------------------------------------------------------ 定时任务（3.2）

  if (scheduler) {
    router.get('/api/scheduler', (ctx) => ctx.json(200, scheduler.list()));

    router.post('/api/scheduler', async (ctx) => ctx.json(201, scheduler.save((await ctx.body()) ?? {})));

    router.put('/api/scheduler/:id', async (ctx) => ctx.json(200, scheduler.save({ ...((await ctx.body()) ?? {}), id: ctx.params.id })));

    router.delete('/api/scheduler/:id', (ctx) => {
      if (!scheduler.remove(ctx.params.id)) return ctx.fail(404, 'NOT_FOUND', `没有这条定时任务：${ctx.params.id}`);
      return ctx.noContent();
    });

    /** 不等时间点，立刻按这条任务跑一遍（用于"试一下"和测试）。 */
    router.post('/api/scheduler/:id/run', async (ctx) => ctx.json(200, await scheduler.runTask(ctx.params.id)));
  }
}
