/**
 * 工具箱服务（纯逻辑 + 端口注入）。
 *
 * 和 `core/chat` 一个路子：这一层决定"该做什么"，真正发 HTTP / 写数据库
 * 的动作交给注入的端口，所以能脱离服务器单测。
 *
 * 端口：
 *   ports.comfyStore   工作流与出图记录的存储（server/db/comfy.mjs）
 *   ports.comfyRunner  真正和 ComfyUI 说话的人（server/toolbox/runner.mjs）
 *   ports.assetStore   素材库（server/db/assets.mjs），runner 用它把图落盘
 *   ports.chatContext  (chatId, memberId) → 当前对话的上下文，用来填占位符
 *   ports.getSettings  () → 当前设置（改了设置立即生效，不用重启）
 *
 * 设计取舍：core 只做"把工作流传成能发出去的 prompt"。HTTP、WebSocket、
 * 落盘、把图绑回消息，全在 server 侧，因为那些都要碰网络和文件系统。
 */

import { emptyList } from '../contracts.mjs';
import { NotFoundError, ProviderError, ValidationError } from '../errors.mjs';
import { newId, nowIso } from '../ids.mjs';
import {
  activeOutfit,
  applyLoras,
  appendNegativePrompt,
  COMFY_PLACEHOLDERS,
  COMFY_EXECUTION_MODES,
  COMFY_WORKFLOW_KINDS,
  buildPlaceholderContext,
  buildPrompt,
  deriveLoaderProfile,
  detectPlaceholders,
  detectPromptSlots,
  getComfyExecutionMode,
  listExpressions,
  getWorkflowPreset,
  getWorkflowKind,
  listWorkflowPresets,
  makeAssetRef,
  normaliseLoras,
  normaliseOutfits,
  parseOutfitMarkers,
  parseApiWorkflow,
  parseImageMarkers,
  planExpressionBatch,
  planImageTrigger,
  presetsFromProfile,
  progressPercent,
  suggestBindings,
  summariseQueue,
  tidyPrompt,
  workflowInputs,
} from './comfy.mjs';
import { PRICE_PRESETS, cacheSavings, describeTotals, fillDays, normaliseUsage } from './cost.mjs';
import { REVIEW_SCOPES, buildReport, normalisePeriod, previousPeriod } from './review.mjs';
import { applyPromptKit, describePromptKit } from './prompt-kit.mjs';
import { computeCost } from '../chat/tokens.mjs';
import { BACKUP_KINDS, CLEANUP_TARGETS, defaultCleanupTargets, describeBackups, describeStats, formatBytes } from './maintenance.mjs';

const NEEDS_RUNNER = 'ComfyUI 还没接上：请通过 createEngine({ ports }) 注入 comfyRunner';

function defaultConfig(settings = {}) {
  return {
    baseUrl: settings['comfy.baseUrl'] ?? 'http://127.0.0.1:8188',
    enabled: settings['comfy.enabled'] ?? false,
    trigger: settings['comfy.trigger'] ?? 'manual',
    marker: settings['comfy.marker'] ?? '[IMG:',
    timeoutMs: Number(settings['comfy.timeoutMs'] ?? 10000),
    executionMode: settings['comfy.executionMode'] ?? 'server',
  };
}

/** 浏览器直连模式下的"待办"状态：主机只登记，不出请求，等前端来领。 */
export const CLIENT_PENDING_STATUS = 'pending-client';

export function createComfyService(ctx) {
  const store = () => ctx.ports.comfyStore ?? null;
  const runner = () => {
    const found = ctx.ports.comfyRunner ?? null;
    if (!found) throw new ProviderError(NEEDS_RUNNER);
    return found;
  };
  const settings = () => {
    const live = ctx.ports.getSettings?.();
    return { ...ctx.settings, ...(live ?? {}) };
  };
  const config = () => defaultConfig(settings());

  function requireStore() {
    const found = store();
    if (!found) throw new ProviderError('工具箱需要存储端口：请通过 createEngine({ ports }) 注入 comfyStore');
    return found;
  }

  function kinds() {
    return COMFY_WORKFLOW_KINDS.map((kind) => ({
      ...kind,
      workflows: store() ? store().listWorkflows({ kind: kind.id }).length : 0,
    }));
  }

  function listWorkflows(query = {}) {
    if (!store()) return emptyList();
    const items = store().listWorkflows(query).map(decorate);
    return { items, total: items.length };
  }

  /** 列表里带上"有几个可填参数""用到哪些占位符""正负提示词填在哪个节点"，界面不用再解析一遍。 */
  function decorate(workflow) {
    let prompt = {};
    try {
      prompt = parseApiWorkflow(workflow.workflow).prompt;
    } catch {
      prompt = {};
    }
    const prompts = detectPromptSlots(prompt);
    const bindings = workflow.bindings ?? [];
    // 界面上那两个提示词框要显示"当前实际会用到的值"：绑定过的以绑定值为准
    for (const key of ['positive', 'negative']) {
      const slot = prompts[key];
      if (!slot) continue;
      const bound = bindings.find((item) => item.nodeId === slot.nodeId && item.input === slot.input);
      if (bound && bound.value !== undefined && bound.value !== null) slot.value = String(bound.value);
    }
    return {
      ...workflow,
      bindings,
      placeholders: detectPlaceholders(prompt),
      nodeCount: Object.keys(prompt).length,
      prompts,
    };
  }

  function getWorkflow(id) {
    const found = requireStore().getWorkflow(id);
    if (!found) throw new NotFoundError(`ComfyUI 工作流 ${id}`);
    return decorate(found);
  }

  function importWorkflow(input = {}) {
    const text = input.workflow ?? input.text ?? input.json;
    if (!text) throw new ValidationError('导入工作流要带上 workflow（API 格式 JSON 的文本或对象）');
    const { prompt, nodeCount } = parseApiWorkflow(text);
    const kind = input.kind ? getWorkflowKind(input.kind).id : 'custom';
    const record = {
      id: newId('cwf'),
      name: String(input.name ?? '').trim() || `工作流 ${nodeCount} 个节点`,
      kind,
      workflow: JSON.stringify(prompt),
      bindings: input.bindings ?? suggestBindings(prompt),
      seed: input.seed ?? null,
      note: input.note ?? null,
      enabled: input.enabled !== false,
    };
    return decorate(requireStore().insertWorkflow(record));
  }

  function saveWorkflow(id, patch = {}) {
    const existing = requireStore().getWorkflow(id);
    if (!existing) throw new NotFoundError(`ComfyUI 工作流 ${id}`);
    const next = {};
    if (patch.name !== undefined) next.name = String(patch.name);
    if (patch.kind !== undefined) next.kind = getWorkflowKind(patch.kind).id;
    if (patch.note !== undefined) next.note = patch.note;
    if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
    if (patch.seed !== undefined) next.seed = patch.seed === null ? null : Number(patch.seed);
    if (patch.workflow !== undefined) next.workflow = JSON.stringify(parseApiWorkflow(patch.workflow).prompt);
    if (patch.bindings !== undefined) {
      if (!Array.isArray(patch.bindings)) throw new ValidationError('bindings 应该是数组');
      next.bindings = patch.bindings.map(normaliseBinding);
    }
    if (!Object.keys(next).length) return decorate(existing);
    return decorate(requireStore().updateWorkflow(id, next));
  }

  function removeWorkflow(id) {
    return requireStore().removeWorkflow(id);
  }

  /**
   * 内置示例工作流（蓝图 3.1「预设几个常用工作流」）。
   * `installed` 用"同名同用途"粗略判断，界面据此把已加过的标出来（不拦着再加一遍）。
   */
  function presets() {
    const existing = store() ? store().listWorkflows({}) : [];
    const items = listWorkflowPresets().map((preset) => ({
      ...preset,
      installed: existing.some((workflow) => workflow.name === preset.title && workflow.kind === preset.kind),
    }));
    return { items, total: items.length };
  }

  /** 把一份示例工作流落库：走正常的 importWorkflow，自动标好可填参数。 */
  function importPreset(id, { name = null } = {}) {
    const preset = getWorkflowPreset(id);
    return importWorkflow({
      workflow: preset.workflow,
      kind: preset.kind,
      name: String(name ?? '').trim() || preset.title,
      note: preset.note,
    });
  }

  function normaliseBinding(raw = {}) {
    if (!raw.nodeId || !raw.input) throw new ValidationError('每个可填参数都要有 nodeId 和 input');
    const type = ['text', 'number', 'seed', 'boolean'].includes(raw.type) ? raw.type : 'text';
    return {
      nodeId: String(raw.nodeId),
      input: String(raw.input),
      label: String(raw.label ?? `${raw.nodeId}.${raw.input}`),
      type,
      value: raw.value ?? (type === 'number' || type === 'seed' ? 0 : ''),
      enabled: raw.enabled !== false,
    };
  }

  /** 工作流里所有可填输入（含没被绑定的），界面用它做参数选择器。 */
  function inputs(id) {
    const found = getWorkflow(id);
    const raw = parseApiWorkflow(found.workflow).prompt;
    const items = workflowInputs(raw).map((entry) => ({
      ...entry,
      bound: (found.bindings ?? []).some((binding) => binding.nodeId === entry.nodeId && binding.input === entry.input),
    }));
    return { items, total: items.length, placeholders: COMFY_PLACEHOLDERS };
  }

  function context(chatId, memberId = null, extra = {}) {
    const info = ctx.ports.chatContext?.(chatId, memberId) ?? {};
    // 这个角色的「衣柜」：现在穿哪套 → 填进 {{outfit}}；角色专属负面词单独带出去。
    const characterId = info.member?.characterId ?? null;
    const wardrobe = characterId ? store()?.getOutfits?.(characterId) ?? null : null;
    const outfit = activeOutfit(wardrobe?.outfits ?? [], wardrobe?.activeId ?? null);
    const values = buildPlaceholderContext({ ...info, outfit: outfit?.prompt || outfit?.name || '', ...extra });
    values.characterId = characterId;
    values.characterNegative = String(wardrobe?.negative ?? '');
    values.outfitName = outfit?.name ?? '';
    values.outfitId = outfit?.id ?? null;
    return values;
  }

  /** 把工作流 + 绑定 + 占位符上下文渲染成"真正会发出去的那份 prompt"。 */
  function buildFor({ workflow, values = {}, chatId = null, memberId = null, extra = {}, seed = null, loraSetId = null } = {}) {
    const raw = parseApiWorkflow(workflow.workflow).prompt;
    const ctxValues = context(chatId, memberId, extra);
    const built = buildPrompt({
      workflow: raw,
      bindings: workflow.bindings,
      values,
      context: ctxValues,
      seed: seed ?? workflow.seed ?? null,
    });
    // LoRA 不是请求参数，是节点 —— 所以在"渲染完之后"再插进这份 prompt 里。
    const loraSet = resolveLoraSet(loraSetId);
    const loraResult = applyLoras(built.prompt, loraSet?.loras ?? [], { appendTriggers: true });
    // 加工台（词替换 / 风格预设 / 质量词）最后套：它改的是正负提示词的文字。
    const kitResult = applyPromptKit(loraResult.prompt, promptKitFromSettings());
    // 角色的专属负面词：接到负向提示词后面（"这个角色永远不要出现什么"）。
    const negativeResult = appendNegativePrompt(kitResult.prompt, ctxValues.characterNegative);
    return {
      prompt: negativeResult.prompt,
      applied: built.applied,
      missing: built.missing,
      placeholders: built.placeholders,
      context: ctxValues,
      values: Object.fromEntries(built.applied.map((item) => [`${item.nodeId}.${item.input}`, item.value])),
      seed: seed ?? workflow.seed ?? null,
      loras: {
        setId: loraSet?.id ?? null,
        name: loraSet?.name ?? null,
        injected: loraResult.injected.map((item) => ({ id: item.id, name: item.name, strengthModel: item.strengthModel, strengthClip: item.strengthClip })),
        triggers: loraResult.triggers,
        warnings: loraResult.warnings,
      },
      promptKit: kitResult.summary,
      character: {
        characterId: ctxValues.characterId ?? null,
        outfitId: ctxValues.outfitId ?? null,
        outfitName: ctxValues.outfitName ?? '',
        negativeApplied: negativeResult.appended,
      },
    };
  }

  /**
   * 自动出图 / 批量表情要把文字接到哪一段：优先用"采样器正面对着的那个 CLIPTextEncode"。
   * 光按输入名猜会猜错 —— CLIPLoader 的 clip_name 也匹配 /clip/，
   * 结果会把这一张图的场景描述接到模型文件名上（工作流里文本节点一多就更容易踩）。
   */
  function positivePromptBinding(workflow) {
    const bindings = workflow.bindings ?? [];
    let slot = null;
    try {
      slot = detectPromptSlots(parseApiWorkflow(workflow.workflow).prompt).positive;
    } catch {
      slot = null;
    }
    if (slot) {
      const exact = bindings.find((binding) => binding.nodeId === slot.nodeId && binding.input === slot.input);
      if (exact) return exact;
    }
    return (
      bindings.find((binding) => binding.type === 'text' && String(binding.label ?? '').startsWith('CLIPTextEncode.')) ??
      bindings.find((binding) => binding.type === 'text' && /text|prompt|positive/i.test(binding.input)) ??
      bindings.find((binding) => binding.type === 'text') ??
      null
    );
  }

  /** 只算不发：把工作流 + 上下文渲染成最终会发出去的 prompt，界面拿它预览。 */
  function preview({ workflowId, values = {}, chatId = null, memberId = null, context: extra = {}, seed = null, loraSetId = null } = {}) {
    const workflow = getWorkflow(workflowId);
    const built = buildFor({ workflow, values, chatId, memberId, extra, seed, loraSetId });
    return {
      workflowId,
      prompt: built.prompt,
      applied: built.applied,
      missing: built.missing,
      placeholders: built.placeholders,
      context: built.context,
      loras: built.loras,
      promptKit: built.promptKit,
      character: built.character,
    };
  }

  async function run({ workflowId, chatId = null, messageId = null, memberId = null, values = {}, context: extra = {}, seed = null, reason = 'manual', loraSetId = null } = {}) {
    if (config().executionMode === 'client') {
      throw new ProviderError(
        '当前是「浏览器直连」模式：出图由你自己的浏览器执行，主机不会去连这个地址。要走主机出图，把「ComfyUI 连接方式」改成「服务器执行」。',
      );
    }
    const workflow = getWorkflow(workflowId);
    const built = buildFor({ workflow, values, chatId, memberId, extra, seed, loraSetId });
    const runnerInstance = runner();
    return runnerInstance.submit({
      workflowId: workflow.id,
      workflowName: workflow.name,
      kind: workflow.kind,
      prompt: built.prompt,
      values: built.values,
      placeholders: built.context,
      missing: built.missing,
      seed: built.seed,
      chatId,
      messageId,
      reason,
    });
  }

  async function pickWorkflow(kind) {
    if (!store()) return null;
    const candidates = store().listWorkflows({ kind });
    const enabled = candidates.find((item) => item.enabled !== false);
    if (enabled) return enabled;
    const any = store().listWorkflows({}).find((item) => item.enabled !== false);
    return any ?? null;
  }

  /**
   * 一轮回复之后决定要不要出图。这是"半自动 / 全自动"两个触发方式的入口，
   * 由 core/chat 在消息落库后调用（端口注入，失败不影响聊天）。
   */
  async function triggerForMessage({ chatId, messageId = null, memberId = null, characterId = null, memberName = null, content = '', stateDelta = null, kind = 'normal', workflowId = null } = {}) {
    const conf = config();
    if (!conf.enabled) return { trigger: false, reason: 'ComfyUI 未启用' };
    const plan = planImageTrigger({ mode: conf.trigger, content, stateDelta, kind, workflowId });
    if (!plan.trigger) return plan;
    const extraContext = { emotion: stateDelta?.emotion };
    // 角色绑定（v8）：这个角色有自己的工作流 / LoRA 就优先用。
    const binding = getCharacterBinding(characterId);
    const loraText = binding?.loraText ? String(binding.loraText).trim() : '';
    const started = [];
    for (const request of plan.requests ?? []) {
      const wantedId = request.workflowId ?? binding?.workflowId ?? null;
      const workflow = wantedId ? requireStore().getWorkflow(wantedId) : await pickWorkflow(request.kind ?? 'custom');
      if (!workflow) {
        started.push({ ok: false, reason: `没有可用的「${getWorkflowKind(request.kind ?? 'custom').title}」工作流` });
        continue;
      }
      const values = {};
      // 标记里的正文补到工作流自己的正向提示词后面，而不是把它整段替换掉 ——
      // 工作流里那串 {{char}} / 角色 LoRA 触发词是保证"同一个角色长得一样"的关键，
      // AI 在标记里写的通常只是这一张图的场景描述。
      if (request.prompt || loraText) {
        const promptBinding = positivePromptBinding(workflow);
        if (promptBinding) {
          const key = `${promptBinding.nodeId}.${promptBinding.input}`;
          const base = baseTextFor(workflow, promptBinding, { chatId, memberId, context: extraContext });
          values[key] = [base, request.prompt, loraText].filter(Boolean).join(', ');
        }
      }
      // 浏览器直连：主机只登记一条"待办"，把已经替换好占位符的最终 prompt 也存进去，
      // 等前端打开时自己领走执行（没有前端在线就一直挂着，下次打开再跑）。
      if (conf.executionMode === 'client') {
        try {
          const record = enqueueClientRun({
            workflowId: workflow.id,
            chatId,
            messageId,
            memberId,
            values,
            context: extraContext,
            seed: workflow.seed ?? null,
            reason: plan.reason,
          });
          started.push({ ok: true, pending: true, run: record });
        } catch (err) {
          started.push({ ok: false, reason: err?.message ?? String(err) });
        }
        continue;
      }
      try {
        const record = await run({
          workflowId: workflow.id,
          chatId,
          messageId,
          memberId,
          values,
          context: extraContext,
          reason: plan.reason,
        });
        started.push({ ok: true, run: record });
      } catch (err) {
        started.push({ ok: false, reason: err?.message ?? String(err) });
      }
    }
    return { ...plan, started };
  }

  /**
   * 登记一条"交给浏览器执行"的出图：服务端把最终 prompt 算好存进 run，前端领走时
   * 直接 POST 给 ComfyUI 即可。marker / 场景变化触发、演出层"出一张背景"都走它。
   */
  function enqueueClientRun({ workflowId, chatId = null, messageId = null, memberId = null, values = {}, context: extra = {}, seed = null, reason = 'client', loraSetId = null } = {}) {
    const workflow = getWorkflow(workflowId);
    const built = buildFor({ workflow, values, chatId, memberId, extra, seed, loraSetId });
    const record = requireStore().insertRun({
      workflowId: workflow.id,
      workflowName: workflow.name,
      kind: workflow.kind,
      chatId,
      messageId,
      status: CLIENT_PENDING_STATUS,
      values: {
        prompt: built.prompt,
        applied: built.values,
        context: built.context,
        missing: built.missing,
        seed: built.seed,
        loras: built.loras,
        memberId,
      },
      reason,
    });
    return { ...record, percent: null };
  }

  /** 取某个文本参数"按当前对话替换好占位符"之后的值，用来把 AI 的提示词接在后面。 */
  function baseTextFor(workflow, binding, { chatId, memberId, context: extra }) {
    try {
      const raw = parseApiWorkflow(workflow.workflow).prompt;
      const built = buildPrompt({
        workflow: raw,
        bindings: [binding],
        values: {},
        context: context(chatId, memberId, extra),
        seed: null,
      });
      const applied = built.applied.find((item) => item.nodeId === binding.nodeId && item.input === binding.input);
      return typeof applied?.value === 'string' ? applied.value : '';
    } catch {
      return '';
    }
  }

  // ------------------------------------------------------------------ 加分项：角色绑定 / 批量表情 / 参考图

  function expressions() {
    return listExpressions();
  }

  function getCharacterBinding(characterId) {
    if (!characterId) return null;
    return store()?.getBinding?.(characterId) ?? null;
  }

  function listCharacterBindings() {
    const items = store()?.listBindings?.() ?? [];
    return { items, total: items.length };
  }

  function saveCharacterBinding(characterId, patch = {}) {
    if (!characterId) throw new ValidationError('要指定 characterId');
    const clean = {};
    if (patch.workflowId !== undefined) clean.workflowId = patch.workflowId ? String(patch.workflowId) : null;
    if (patch.loraText !== undefined) clean.loraText = patch.loraText ? String(patch.loraText).slice(0, 500) : null;
    if (patch.note !== undefined) clean.note = patch.note ? String(patch.note).slice(0, 500) : null;
    if (patch.expressions !== undefined) {
      if (!patch.expressions || typeof patch.expressions !== 'object' || Array.isArray(patch.expressions)) {
        throw new ValidationError('expressions 应该是对象（表情名 → assetId）');
      }
      const out = {};
      for (const [key, value] of Object.entries(patch.expressions)) {
        const label = String(key).slice(0, 40);
        const assetId = typeof value === 'string' ? value : String(value?.assetId ?? '');
        if (label && assetId) out[label] = assetId;
      }
      clean.expressions = out;
    }
    if (!Object.keys(clean).length) return getCharacterBinding(characterId);
    return requireStore().saveBinding(characterId, clean);
  }

  function removeCharacterBinding(characterId) {
    return requireStore().removeBinding(characterId);
  }

  /** 角色表情差分包：按表情名 / 表情 id / 中文标签找一张绑好的图。 */
  function expressionAssetFor({ characterId = null, emotion = null } = {}) {
    const binding = getCharacterBinding(characterId);
    const map = binding?.expressions ?? {};
    const key = String(emotion ?? '').trim();
    if (!key) return null;
    if (map[key]) return { assetId: map[key], emotion: key };
    const preset = listExpressions().find((item) => item.id === key || item.label === key);
    if (preset && map[preset.id]) return { assetId: map[preset.id], emotion: preset.id };
    if (preset && map[preset.label]) return { assetId: map[preset.label], emotion: preset.label };
    return null;
  }

  /** 这个角色绑了工作流就用它（没绑就按用途挑一个）。 */
  function workflowForCharacter(characterId) {
    const binding = getCharacterBinding(characterId);
    if (!binding?.workflowId) return null;
    return store()?.getWorkflow?.(binding.workflowId) ?? null;
  }

  /** 批量表情差分：一次把几个表情都提交了（client 模式下就落成多条待办）。 */
  async function runBatchExpressions({ workflowId, emotions = null, chatId = null, messageId = null, memberId = null, values = {}, context: extra = {}, seed = null, reason = 'batch-expression', loraSetId = null } = {}) {
    const workflow = getWorkflow(workflowId);
    const promptBinding = positivePromptBinding(workflow);
    const baseText = promptBinding ? baseTextFor(workflow, promptBinding, { chatId, memberId, context: extra }) : '';
    const plan = planExpressionBatch({ emotions, baseText });
    const items = [];
    for (const item of plan) {
      const nextValues = { ...values };
      if (promptBinding) nextValues[`${promptBinding.nodeId}.${promptBinding.input}`] = item.text;
      try {
        const run_ =
          config().executionMode === 'client'
            ? enqueueClientRun({ workflowId: workflow.id, chatId, messageId, memberId, values: nextValues, context: extra, seed, reason: `${reason}:${item.emotion}`, loraSetId })
            : await run({ workflowId: workflow.id, chatId, messageId, memberId, values: nextValues, context: extra, seed, reason: `${reason}:${item.emotion}`, loraSetId });
        items.push({ ok: true, emotion: item.emotion, label: item.label, run: run_ });
      } catch (err) {
        items.push({ ok: false, emotion: item.emotion, label: item.label, reason: err?.message ?? String(err) });
      }
    }
    return { workflowId: workflow.id, items };
  }

  function imageBindings(workflow) {
    return (workflow?.bindings ?? []).filter((binding) => binding.type === 'image');
  }

  /** 图生图 / 局部重绘 / 扩图：参考图（和可选的蒙版）从素材库来，执行方负责上传给 ComfyUI。 */
  async function runWithReference({ workflowId, referenceAssetId, maskAssetId = null, chatId = null, messageId = null, memberId = null, values = {}, context: extra = {}, seed = null, reason = 'img2img', loraSetId = null } = {}) {
    const workflow = getWorkflow(workflowId);
    const images = imageBindings(workflow);
    if (!images.length) {
      throw new ValidationError(
        '这个工作流没有参考图输入（需要 LoadImage.image 这种参数）。去「工具箱 → ComfyUI」一键添加「图生图 / 扩图」示例工作流。',
      );
    }
    if (!referenceAssetId) throw new ValidationError('要指定参考图（referenceAssetId）');
    const nextValues = { ...values, [`${images[0].nodeId}.${images[0].input}`]: makeAssetRef(referenceAssetId) };
    if (maskAssetId && images[1]) nextValues[`${images[1].nodeId}.${images[1].input}`] = makeAssetRef(maskAssetId);
    if (config().executionMode === 'client') {
      return enqueueClientRun({ workflowId: workflow.id, chatId, messageId, memberId, values: nextValues, context: extra, seed, reason, loraSetId });
    }
    return run({ workflowId: workflow.id, chatId, messageId, memberId, values: nextValues, context: extra, seed, reason, loraSetId });
  }

  function runs(query = {}) {
    if (!store()) return emptyList();
    const items = store().listRuns(query).map((run) => ({ ...run, percent: progressPercent(run) }));
    return { items, total: items.length };
  }

  function getRun(id) {
    const found = requireStore().getRun(id);
    if (!found) throw new NotFoundError(`出图记录 ${id}`);
    return { ...found, percent: progressPercent(found) };
  }

  /** 这张图是哪次出的 —— 顺带把当时的正向提示词取出来，给「改提示词重出」预填。 */
  function runByAsset(assetId) {
    const run = store()?.findRunByAsset?.(assetId) ?? null;
    if (!run) return null;
    const graph = run.values?.prompt ?? null;
    let positive = '';
    if (graph && typeof graph === 'object') {
      const slot = detectPromptSlots(graph)?.positive ?? null;
      if (slot) positive = String(graph[slot.nodeId]?.inputs?.[slot.input] ?? '');
    }
    return { run: { ...run, percent: progressPercent(run) }, positive };
  }

  /**
   * 重出：拿这条记录当时那一份 prompt 再发一次。
   * 可以顺手改正向提示词；种子默认换一个（不换的话 ComfyUI 命中缓存，等于没重跑）。
   */
  async function rerunRun(runId, { prompt = null, seed = null } = {}) {
    const run = requireStore().getRun(runId);
    if (!run) throw new NotFoundError(`出图记录 ${runId}`);
    const graph = run.values?.prompt;
    if (!graph || typeof graph !== 'object') throw new ValidationError('这条记录里没有可重跑的提示词');
    const edited = prompt === null || prompt === undefined ? null : tidyPrompt(String(prompt));
    const nextSeed =
      seed !== null && seed !== undefined && seed !== '' && Number.isFinite(Number(seed))
        ? Math.trunc(Number(seed))
        : Math.floor(Math.random() * 2147483647);

    if (config().executionMode === 'client') {
      const workflow = requireStore().getWorkflow(run.workflowId);
      const values = { ...(run.values?.applied ?? {}) };
      if (edited !== null) {
        const slot = workflow ? positivePromptBinding(workflow) : null;
        if (!slot) throw new ValidationError('这张工作流里找不到正向提示词节点，改不了提示词');
        values[`${slot.nodeId}.${slot.input}`] = edited;
      }
      return enqueueClientRun({
        workflowId: run.workflowId,
        chatId: run.chatId,
        messageId: run.messageId,
        memberId: run.values?.memberId ?? null,
        values,
        context: run.values?.context ?? {},
        seed: nextSeed,
        reason: 'rerun',
      });
    }

    const next = JSON.parse(JSON.stringify(graph));
    if (edited !== null) {
      const slot = detectPromptSlots(next)?.positive ?? null;
      const node = slot ? next[slot.nodeId] : null;
      if (!slot || !node?.inputs || !(slot.input in node.inputs)) {
        throw new ValidationError('这张工作流里找不到正向提示词节点，改不了提示词');
      }
      node.inputs[slot.input] = edited;
    }
    for (const node of Object.values(next)) {
      if (!node?.inputs) continue;
      for (const key of Object.keys(node.inputs)) if (/^seed$/i.test(key) && typeof node.inputs[key] === 'number') node.inputs[key] = nextSeed;
    }
    return runner().submit({
      workflowId: run.workflowId,
      workflowName: run.workflowName,
      kind: run.kind,
      prompt: next,
      values: run.values?.applied ?? {},
      placeholders: run.values?.context ?? {},
      missing: run.values?.missing ?? [],
      seed: nextSeed,
      chatId: run.chatId,
      messageId: run.messageId,
      reason: 'rerun',
    });
  }

  function normaliseRunImage(image = {}) {
    if (typeof image === 'string') return { assetId: image };
    return {
      assetId: image.assetId ?? null,
      filename: image.filename ?? null,
      subfolder: image.subfolder ?? '',
      type: image.type ?? 'output',
      nodeId: image.nodeId ?? null,
      mime: image.mime ?? null,
      size: image.size ?? null,
    };
  }

  /**
   * 浏览器直连的"登记"入口：前端已经拿到 promptId 了，这里把它落进本租户的
   * comfy_runs，界面上的队列 / 历史 / 花费面板照旧能看到。
   * runId 存在时表示"领一条 pending-client 任务"，直接把它推进到 running。
   */
  function registerClientRun(input = {}) {
    const s = requireStore();
    const promptId = input.promptId ?? null;
    if (!promptId) throw new ValidationError('client-runs 要带上 promptId');
    if (input.runId) {
      const existing = s.getRun(input.runId);
      if (!existing) throw new NotFoundError(`出图记录 ${input.runId}`);
      const updated = s.updateRun(existing.id, {
        status: 'running',
        promptId,
        ...(input.values !== undefined ? { values: input.values } : {}),
        ...(input.messageId ? { messageId: input.messageId } : {}),
      });
      return { ...updated, percent: progressPercent(updated) };
    }
    const workflow = input.workflowId ? s.getWorkflow(input.workflowId) : null;
    const record = s.insertRun({
      workflowId: input.workflowId ?? null,
      workflowName: input.workflowName ?? workflow?.name ?? null,
      kind: input.kind ?? workflow?.kind ?? null,
      chatId: input.chatId ?? null,
      messageId: input.messageId ?? null,
      promptId,
      status: 'running',
      values: input.values ?? {},
      reason: input.reason ?? 'client',
    });
    return { ...record, percent: progressPercent(record) };
  }

  /** 浏览器直连回写：进度、状态、图片、错误。 */
  function updateClientRun(id, patch = {}) {
    const s = requireStore();
    const existing = s.getRun(id);
    if (!existing) throw new NotFoundError(`出图记录 ${id}`);
    const allowed = ['queued', 'running', 'done', 'error', 'cancelled', CLIENT_PENDING_STATUS];
    const next = {};
    if (patch.status !== undefined) {
      if (!allowed.includes(patch.status)) throw new ValidationError(`不认识的出图状态：${patch.status}`);
      next.status = patch.status;
    }
    if (patch.progress !== undefined) next.progress = patch.progress === null ? null : Number(patch.progress);
    if (patch.progressMax !== undefined) next.progressMax = patch.progressMax === null ? null : Number(patch.progressMax);
    if (patch.nodeId !== undefined) next.nodeId = patch.nodeId;
    if (patch.messageId !== undefined) next.messageId = patch.messageId;
    if (patch.error !== undefined) next.error = patch.error;
    if (patch.values !== undefined) next.values = patch.values;
    if (patch.images !== undefined) {
      if (!Array.isArray(patch.images)) throw new ValidationError('images 应该是数组');
      next.images = patch.images.map(normaliseRunImage);
    }
    if (patch.status === 'done' && next.progressMax === undefined) {
      // 跑完直接满格，进度条停在中间会让人以为还没结束
      const max = existing.progressMax;
      next.progressMax = max ?? existing.progress ?? null;
      next.progress = max ?? existing.progress ?? null;
    }
    const updated = s.updateRun(id, next);
    return { ...updated, percent: progressPercent(updated) };
  }

  async function cancelRun(runId) {
    const s = requireStore();
    const found = s.getRun(runId);
    if (!found) return null;
    // 浏览器直连模式下不能由主机去发 /interrupt（那又是主机碰用户地址），
    // 只把记录标成取消，前端下次拿到状态就停。
    if (config().executionMode === 'client') return { ...s.updateRun(runId, { status: 'cancelled' }), percent: null };
    try {
      await runner().cancel(runId);
    } catch {
      // 连不上 ComfyUI 也照样把本地状态收掉
    }
    return { ...s.updateRun(runId, { status: 'cancelled' }), percent: null };
  }

  /**
   * 把某张出图从记录里摘掉（素材文件本身由上层删，消息附件由上层清）。
   * 返回改动过的记录 id；界面删图时靠它把"最近的出图"里的裂图一起收干净。
   */
  function detachImage(assetId) {
    const s = store();
    if (!s || typeof s.detachImage !== 'function') return [];
    return s.detachImage(assetId);
  }

  /** 把"一张图都不剩"的出图记录删掉（空壳卡片）；返回删了几条。 */
  function pruneRuns(ids = []) {
    const s = store();
    if (!s || typeof s.pruneEmptyRuns !== 'function') return 0;
    return s.pruneEmptyRuns(ids);
  }

  /** 手动删掉一条出图记录（图留在素材库，只清记录）。 */
  function removeRun(runId) {
    const s = requireStore();
    const found = s.getRun(runId);
    if (!found) throw new NotFoundError(`出图记录 ${runId}`);
    return s.removeRun(runId);
  }

  function pendingClientCount() {
    const s = store();
    if (!s) return 0;
    try {
      return s.listRuns({ status: CLIENT_PENDING_STATUS, limit: 200 }).length;
    } catch {
      return 0;
    }
  }

  async function status() {
    const conf = config();
    const base = {
      configured: Boolean(conf.baseUrl),
      enabled: conf.enabled,
      baseUrl: conf.baseUrl,
      trigger: conf.trigger,
      marker: conf.marker,
      executionMode: conf.executionMode,
      kinds: kinds(),
      pendingClient: pendingClientCount(),
    };
    // 浏览器直连：主机**不**去碰这个地址（这正是"别人的连接不经过主机"那条），
    // 连接状态由前端在自己的浏览器里测。
    if (conf.executionMode === 'client') {
      return {
        ...base,
        ok: null,
        client: true,
        error: null,
        stats: null,
        queue: summariseQueue({}),
        note: '浏览器直连模式：主机不会向这个地址发请求，连接状态在浏览器里测。',
      };
    }
    if (!ctx.ports.comfyRunner) return { ...base, ok: false, error: '这一版没有启用 ComfyUI 客户端', queue: summariseQueue({}) };
    try {
      // 并行探活：地址填错或对端不通时，别让状态接口等两倍超时
      const [probe, queue] = await Promise.all([ctx.ports.comfyRunner.test(), ctx.ports.comfyRunner.queue()]);
      return { ...base, ok: Boolean(probe.ok), error: probe.error ?? null, stats: probe.stats ?? null, queue };
    } catch (err) {
      return { ...base, ok: false, error: err?.message ?? String(err), queue: summariseQueue({}) };
    }
  }

  // ------------------------------------------------------------------ LoRA 组合

  /** 这次用哪套 LoRA：本次指定 > 设置里的「当前组合」 > 一套都不用。 */
  function resolveLoraSet(overrideId = null) {
    const id = String(overrideId ?? settings()['comfy.activeLoraSet'] ?? '').trim();
    if (!id || !store()) return null;
    return store().getLoraSet?.(id) ?? null;
  }

  function listLoraSets() {
    const items = store()?.listLoraSets?.() ?? [];
    return { items, total: items.length, activeId: String(settings()['comfy.activeLoraSet'] ?? '') };
  }

  function saveLoraSet(input = {}) {
    return requireStore().saveLoraSet({ ...input, loras: normaliseLoras(input.loras) });
  }

  function removeLoraSet(id) {
    return requireStore().removeLoraSet(id);
  }

  /** 这台 ComfyUI 上有哪些 LoRA（浏览器直连模式下由前端自己去拉）。 */
  async function listLoras() {
    if (config().executionMode === 'client') {
      return { items: [], client: true, error: null };
    }
    const result = await runner().loras();
    return { items: result.items ?? [], error: result.error ?? null };
  }

  // ------------------------------------------------------------------ 出图提示词加工台

  /** 加工台存在设置里的一个 JSON 字符串（不加表）：词替换 + 风格预设 + 质量词。 */
  function promptKitFromSettings() {
    try {
      return JSON.parse(settings()['comfy.promptKit'] || '{}');
    } catch {
      return {};
    }
  }

  /** 加工台当前长什么样（界面拿它渲染开关与预览）。 */
  function promptKit() {
    return describePromptKit(promptKitFromSettings());
  }

  /**
   * 按某份已导入工作流的"模型来源"，生成一套跟本机对得上的预设。
   * 为什么：内置示例是按 checkpoint 写的；机器上是"拆开加载"（UNET/CLIP/VAE）的人用不了。
   */
  function derivePresets(workflowId, { import: shouldImport = true } = {}) {
    const source = getWorkflow(workflowId);
    const profile = deriveLoaderProfile(source.workflow);
    if (!profile || (profile.style !== 'checkpoint' && profile.style !== 'split')) {
      throw new ValidationError(
        '这份工作流里认不出模型加载器：要么得有 CheckpointLoaderSimple，'
          + '要么得有 UNETLoader + CLIPLoader + VAELoader 三件套。',
      );
    }
    const presets = presetsFromProfile(profile, { sourceName: source.name });
    if (!shouldImport) {
      return { sourceName: source.name, style: profile.style, items: presets.map((item) => ({ id: item.id, title: item.title, kind: item.kind, summary: item.summary, note: item.note })) };
    }
    const created = presets.map((preset) => {
      const raw = parseApiWorkflow(preset.workflow).prompt;
      return requireStore().insertWorkflow({
        name: preset.title,
        kind: preset.kind,
        workflow: JSON.stringify(raw),
        bindings: suggestBindings(raw),
        note: preset.note,
      });
    });
    return { sourceName: source.name, style: profile.style, items: created };
  }

  // ------------------------------------------------------------------ 衣柜（换装）

  function getOutfits(characterId) {
    const found = characterId ? store()?.getOutfits?.(characterId) ?? null : null;
    const list = normaliseOutfits(found?.outfits ?? []);
    const active = activeOutfit(list, found?.activeId ?? null);
    return {
      characterId: characterId ?? null,
      outfits: list,
      activeId: found?.activeId && list.some((item) => item.id === found.activeId) ? found.activeId : active?.id ?? null,
      active,
      negative: String(found?.negative ?? ''),
    };
  }

  function saveOutfits(characterId, patch = {}) {
    if (!characterId) throw new ValidationError('要指定 characterId');
    requireStore().saveOutfits(characterId, {
      ...patch,
      ...(patch.outfits !== undefined ? { outfits: normaliseOutfits(patch.outfits) } : {}),
    });
    return getOutfits(characterId);
  }

  function removeOutfits(characterId) {
    requireStore().removeOutfits(characterId);
    return { characterId, outfits: [], activeId: null, active: null, negative: '' };
  }

  /**
   * 剧情换装：AI 在回复里写了 `[换装: 套装名]`（或 `[OUTFIT: …]`），就把这个角色换成那一套。
   * 名字对不上、或者这个角色还没衣柜，都如实报出来，不改任何东西。
   */
  async function applyOutfitMarkers({ characterId = null, content = '', messageId = null } = {}) {
    const markers = parseOutfitMarkers(content);
    if (!markers.length) return { applied: [], changed: false };
    if (!characterId) return { applied: markers.map((item) => ({ ok: false, name: item.name, reason: '这条消息没有对应的角色' })), changed: false };
    const found = store()?.getOutfits?.(characterId) ?? null;
    const list = normaliseOutfits(found?.outfits ?? []);
    if (!list.length) return { applied: markers.map((item) => ({ ok: false, name: item.name, reason: '这个角色还没有衣柜' })), changed: false };

    const applied = [];
    let activeId = found?.activeId ?? null;
    for (const marker of markers) {
      const key = marker.name.toLowerCase();
      const outfit = list.find((item) => item.id === marker.name || item.name.toLowerCase() === key) ?? null;
      if (!outfit) {
        applied.push({ ok: false, name: marker.name, reason: '衣柜里没有这套' });
        continue;
      }
      activeId = outfit.id;
      applied.push({ ok: true, name: marker.name, outfitId: outfit.id, outfitName: outfit.name, messageId });
    }
    const changed = applied.some((item) => item.ok) && activeId !== (found?.activeId ?? null);
    if (changed) requireStore().saveOutfits(characterId, { ...found, activeId });
    return { applied, changed, activeId };
  }

  return {
    kinds,
    placeholders: () => COMFY_PLACEHOLDERS,
    executionModes: () => COMFY_EXECUTION_MODES.map((item) => ({ ...item })),
    executionMode: () => getComfyExecutionMode(config().executionMode).id,
    config,
    status,
    // LoRA：清单（问 ComfyUI）+ 组合（存下来的几套）+ 当前用哪套
    listLoras,
    listLoraSets,
    saveLoraSet,
    removeLoraSet,
    activeLoraSet: () => resolveLoraSet(),
    promptKit,
    derivePresets,
    getOutfits,
    saveOutfits,
    removeOutfits,
    applyOutfitMarkers,
    // client 模式下 test / queue 都**不**去碰用户地址，直接给前端一个"由浏览器测"的答复，
    // 这样服务端在这条路径上彻底不发起请求（SSRF 收敛点）。
    test: () =>
      config().executionMode === 'client'
        ? Promise.resolve({ ok: null, client: true, note: '浏览器直连模式：连接测试在浏览器里做' })
        : runner().test(),
    queue: () =>
      config().executionMode === 'client'
        ? Promise.resolve({ ...summariseQueue({}), client: true })
        : runner().queue(),
    listWorkflows,
    getWorkflow,
    importWorkflow,
    saveWorkflow,
    removeWorkflow,
    presets,
    importPreset,
    inputs,
    preview,
    run,
    runBatchExpressions,
    runWithReference,
    expressions,
    getCharacterBinding,
    listCharacterBindings,
    saveCharacterBinding,
    removeCharacterBinding,
    expressionAssetFor,
    workflowForCharacter,
    runs,
    getRun,
    runByAsset,
    rerunRun,
    enqueueClientRun,
    registerClientRun,
    updateClientRun,
    pendingClientCount,
    cancel: cancelRun,
    detachImage,
    pruneRuns,
    removeRun,
    triggerForMessage,
    markers: parseImageMarkers,
  };
}

/**
 * 花费与统计（蓝图 3.2）。
 *
 * 记账发生在"一轮回复跑完"那一步：core/chat 把真实用量 + 我们的估算一起丢进来，
 * 这里算好钱（含缓存节省）再落库。汇总交给存储层做 GROUP BY。
 */
export function createCostService(ctx) {
  const store = () => ctx.ports.costStore ?? null;

  function requireStore() {
    const found = store();
    if (!found) throw new ProviderError('花费统计需要存储端口：请通过 createEngine({ ports }) 注入 costStore');
    return found;
  }

  /** 提供方当前生效的单价：价目表命中就覆盖提供方 params 里的 priceIn / priceOut。 */
  function pricesFor(providerId, model = null) {
    const base = ctx.ports.providerParams?.(providerId) ?? {};
    const override = store()?.findPricing?.(providerId ?? '', model) ?? null;
    const priceIn = override?.priceIn ?? (Number.isFinite(Number(base.priceIn)) ? Number(base.priceIn) : null);
    const priceOut = override?.priceOut ?? (Number.isFinite(Number(base.priceOut)) ? Number(base.priceOut) : null);
    return {
      priceIn,
      priceOut,
      cacheDiscount: override?.cacheDiscount ?? 0.1,
      currency: override?.currency ?? 'CNY',
      source: override ? 'pricing' : priceIn !== null || priceOut !== null ? 'provider' : 'none',
    };
  }

  /** 记一轮用量。估算值也一起存，才能做"预估 vs 实际"。 */
  function record(entry = {}) {
    const found = requireStore();
    const usage = normaliseUsage(entry.usage ?? {});
    const prices = entry.prices ?? pricesFor(entry.providerId, entry.model);
    const cost = computeCost(usage, prices);
    const savings = cacheSavings({ cachedTokens: usage.cachedTokens, priceIn: prices.priceIn, discount: prices.cacheDiscount });
    return found.insertUsage({
      chatId: entry.chatId ?? null,
      characterId: entry.characterId ?? null,
      memberId: entry.memberId ?? null,
      providerId: entry.providerId ?? null,
      model: entry.model ?? null,
      kind: entry.kind ?? null,
      source: entry.source ?? null,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      cachedTokens: usage.cachedTokens,
      estPromptTokens: entry.estPromptTokens ?? 0,
      estCompletionTokens: entry.estCompletionTokens ?? 0,
      priceIn: prices.priceIn,
      priceOut: prices.priceOut,
      cost,
      cacheSavings: savings || null,
      reported: Boolean(entry.reported),
      createdAt: entry.createdAt,
    });
  }

  function summary(query = {}) {
    if (!store()) return { range: {}, totals: describeTotals({}), byModel: [], byProvider: [], byDay: [] };
    const filter = normaliseRange(query);
    const totals = describeTotals(store().totals(filter));
    return {
      range: { from: filter.from ?? null, to: filter.to ?? null },
      totals,
      byModel: store().groupBy('model', filter).map((row) => ({ model: row.key, ...describeTotals(row) })),
      byProvider: store().groupBy('provider', filter).map((row) => ({ providerId: row.key, ...describeTotals(row) })),
      byDay: fillDays(store().byDay(filter).map((row) => ({ ...row })), Number(query.days ?? 14)).map((row) => ({ day: row.key, ...describeTotals(row) })),
      pricing: store().listPricing(),
      presets: PRICE_PRESETS,
    };
  }

  function byChat(query = {}) {
    if (!store()) return emptyList();
    const filter = normaliseRange(query);
    const items = store().groupBy('chat', filter).map((row) => ({ chatId: row.key, ...describeTotals(row) }));
    return { items, total: items.length };
  }

  function byCharacter(query = {}) {
    if (!store()) return emptyList();
    const filter = normaliseRange(query);
    const items = store().groupBy('character', filter).map((row) => ({ characterId: row.key, ...describeTotals(row) }));
    return { items, total: items.length };
  }

  function byDay(query = {}) {
    if (!store()) return emptyList();
    const filter = normaliseRange(query);
    const items = fillDays(store().byDay(filter).map((row) => ({ ...row })), Number(query.days ?? 30)).map((row) => ({ day: row.key, ...describeTotals(row) }));
    return { items, total: items.length };
  }

  function recent(query = {}) {
    if (!store()) return emptyList();
    const items = store().listUsage({ limit: query.limit ?? 50, ...normaliseRange(query) }).map((row) => ({
      ...row,
      prices: pricesFor(row.providerId, row.model),
    }));
    return { items, total: items.length };
  }

  function listPricing() {
    if (!store()) return { items: PRICE_PRESETS.map((preset) => ({ ...preset, providerId: '', currency: 'CNY', cacheDiscount: 0.1, id: null })), presets: PRICE_PRESETS };
    const items = store().listPricing();
    return { items, presets: PRICE_PRESETS };
  }

  function savePricing(input = {}) {
    return requireStore().upsertPricing(input);
  }

  function removePricing(id) {
    return requireStore().removePricing(id);
  }

  function stats() {
    if (!store()) return { turns: 0, firstAt: null, lastAt: null };
    return store().stats();
  }

  function normaliseRange(query = {}) {
    const out = {};
    if (query.from) out.from = String(query.from);
    if (query.to) out.to = String(query.to);
    if (query.chatId) out.chatId = String(query.chatId);
    if (query.characterId) out.characterId = String(query.characterId);
    if (query.providerId) out.providerId = String(query.providerId);
    if (query.model) out.model = String(query.model);
    return out;
  }

  return { record, pricesFor, summary, byChat, byCharacter, byDay, recent, listPricing, savePricing, removePricing, stats, presets: () => PRICE_PRESETS };
}

/**
 * 备份与维护（蓝图 3.2）。
 *
 * 备份/恢复/清理都动文件系统和数据库，所以核心动作在 server 侧
 * （server/db/backup.mjs、server/db/maintenance.mjs），这里只做
 * "什么时候该动、动了之后怎么汇报"。
 */
export function createMaintenanceService(ctx) {
  const backups = () => ctx.ports.backupStore ?? null;
  const store = () => ctx.ports.maintenanceStore ?? null;
  const settings = () => ({ ...ctx.settings, ...(ctx.ports.getSettings?.() ?? {}) });

  function autoBackup(reason, kind = 'auto') {
    const found = backups();
    if (!found) return null;
    const record = found.create({ label: reason, kind });
    const keep = Number(settings()['data.autoBackupKeep'] ?? 5);
    const pruned = found.prune(keep > 0 ? keep + 1 : 0); // 手动备份也算在内，留点余量
    return { backup: record, pruned: pruned.removed };
  }

  function listBackups() {
    const found = backups();
    if (!found) return { items: [], total: 0, kinds: BACKUP_KINDS, directory: null };
    const items = describeBackups(found.list());
    return { items, total: items.length, kinds: BACKUP_KINDS, directory: found.dir(), autoBackupOnStart: settings()['data.autoBackupOnStart'] !== false, keep: settings()['data.autoBackupKeep'] ?? 5 };
  }

  function createBackup({ label = null, kind = 'manual' } = {}) {
    const found = backups();
    if (!found) throw new ProviderError('备份需要存储端口：请通过 createEngine({ ports }) 注入 backupStore');
    return found.create({ label: label ?? '手动备份', kind });
  }

  function restoreBackup({ name } = {}) {
    const found = backups();
    if (!found) throw new ProviderError('恢复需要存储端口');
    if (!name) throw new ValidationError('要指定备份名');
    return found.restore({ name });
  }

  function removeBackup(name) {
    const found = backups();
    if (!found) throw new ProviderError('备份需要存储端口');
    return found.remove(name);
  }

  function stats() {
    if (!store()) return { items: [], raw: {} };
    const raw = store().stats();
    return { items: describeStats(raw), raw };
  }

  function scan() {
    if (!store()) return { scannedAt: nowIso(), stats: {}, issues: [], details: {}, totalIssues: 0, targets: CLEANUP_TARGETS };
    return { ...store().scan(), targets: CLEANUP_TARGETS };
  }

  function cleanup({ targets = null, backupFirst = true } = {}) {
    const found = store();
    if (!found) throw new ProviderError('清理需要存储端口');
    const wanted = Array.isArray(targets) && targets.length ? targets : defaultCleanupTargets();
    const plan = found.scan();
    const safety = backupFirst ? autoBackup('清理前自动备份', 'pre-cleanup') : null;
    const result = found.cleanup({ targets: wanted, plan });
    return { ...result, targets: wanted, safetyBackup: safety?.backup?.name ?? null, bytesText: formatBytes(result.bytesFreed) };
  }

  return { listBackups, createBackup, restoreBackup, removeBackup, autoBackup, stats, scan, cleanup, targets: () => CLEANUP_TARGETS, describeBackups, formatBytes };
}

/**
 * 月度与年度报告（蓝图 3.2 加页）。
 *
 * 数据全在已有表里（usage_log / chat_messages / characters / character_versions /
 * comfy_runs / …），这里只负责"选区间 → 让存储层做聚合 → 交给纯函数算成报告"。
 * 不花 token：报告里的"一句话总结"是本地拼的（要 AI 写以后另说）。
 */
export function createReviewService(ctx) {
  const store = () => ctx.ports.reviewStore ?? null;

  function periods() {
    const found = store();
    const base = found ? found.availablePeriods() : { months: [], years: [] };
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    return {
      scopes: REVIEW_SCOPES,
      months: base.months,
      years: base.years,
      currentMonth,
      currentYear: String(now.getFullYear()),
    };
  }

  function report(query = {}) {
    const meta = normalisePeriod(query.scope, query.period);
    const found = store();
    if (!found) return buildReport({}, meta);
    const range = { from: meta.from, to: meta.to };
    const prevMeta = previousPeriod(meta);
    const prevRange = prevMeta ? { from: prevMeta.from, to: prevMeta.to } : null;
    const raw = {
      usage: {
        totals: found.usageTotals(range),
        byCharacter: found.usageByCharacter(range),
        byModel: found.usageByModel(range),
        byDay: found.usageByDay(range),
      },
      activity: {
        totals: found.activityTotals(range),
        byDay: found.activityByDay(range),
        byHour: found.activityByHour(range),
        byWeekday: found.activityByWeekday(range),
      },
      chats: found.chatsCreated(range),
      creation: found.creationTotals(range),
      images: { ...found.imagesByStatus(range), gallery: found.galleryAssets(range) },
      charactersPlayed: found.charactersPlayed(range),
      regenerations: found.regenerations(range),
      companion: found.companionTime(range),
      lifelines: found.lifelines(range),
      previousLifelines: prevRange ? found.lifelines(prevRange) : [],
      unlocks: found.showUnlocks(range),
    };
    const previousTotals = prevRange ? found.usageTotals(prevRange) : null;
    const previous = prevRange
      ? {
          tokens: previousTotals.totalTokens,
          turns: previousTotals.turns,
          cost: previousTotals.cost,
          activeDays: found.activityByDay(prevRange).length,
          cardsPlayed: found.charactersPlayed(prevRange),
        }
      : null;
    return buildReport(raw, meta, {
      previous,
      previousLabel: prevMeta?.label ?? '上一期',
      lifetime: found.lifetime(),
      allTimeLifelines: found.lifelines({}),
    });
  }

  /**
   * AI 旁白：把这期的数字交给聊天模型写一段回顾。会花 token，所以只有前端点了才跑。
   * 没配模型就明确报错，别假装写了。
   */
  async function narration(query = {}) {
    const data = report(query);
    const narrate = ctx.ports.narrate ?? null;
    if (!narrate) throw new ProviderError('还没有可用的聊天模型，写不了回顾旁白');
    const top = data.usage?.topCharacters?.[0];
    const payload = [
      `时间范围：${data.meta?.label ?? ''}`,
      `聊了 ${data.headline.turns} 轮、${data.headline.messages} 条消息，消耗 ${data.headline.tokens} token`,
      `活跃 ${data.headline.activeDays} 天，最长连续 ${data.headline.longestStreak} 天`,
      top ? `陪得最多的是「${top.name}」` : '',
      data.activity?.peak?.date ? `最投入的一天是 ${data.activity.peak.date}` : '',
      data.lifelines?.fresh?.length ? `这期新认识：${data.lifelines.fresh.map((item) => item.name).join('、')}` : '',
      data.lifelines?.returning?.length ? `久别重逢：${data.lifelines.returning.map((item) => item.name).join('、')}` : '',
      data.unlocks?.endings ? `解锁了 ${data.unlocks.endings} 个结局` : '',
      data.wordCloud?.length ? `常出现的标签：${data.wordCloud.slice(0, 6).map((item) => item.tag).join('、')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const text = await narrate(payload);
    return { text, label: data.meta?.label ?? '' };
  }

  return { periods, report, narration, scopes: () => REVIEW_SCOPES };
}

/** 组装工具箱的各个服务。 */
export function createToolboxServices({ settings = {}, ports = {} } = {}) {
  const ctx = { settings, ports };
  return {
    comfy: createComfyService(ctx),
    cost: createCostService(ctx),
    maintenance: createMaintenanceService(ctx),
    review: createReviewService(ctx),
  };
}

export { progressPercent, summariseQueue, parseImageMarkers };
