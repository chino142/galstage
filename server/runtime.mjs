/**
 * 运行时装配：数据目录 → 数据库 → 设置 → 存储 → 引擎。
 *
 * 抽出来是因为现在有两个入口要用同一套装配：
 *   - server/index.mjs      HTTP 服务（界面 + 接口）
 *   - server/mcp-stdio.mjs  把本服务当成 MCP 服务器，给 Codex / Claude Code 用
 * 两边共用一份装配，才不会出现"界面里能做、MCP 里行为不一样"的漂移。
 *
 * withComfy=false 时不建 ComfyUI 执行器（MCP 进程不需要连 ComfyUI、
 * 更不该在后台挂着 WebSocket），其余能力照旧。
 */

import { createEngine } from '../core/index.mjs';
import path from 'node:path';
import { createLogger } from './log.mjs';
import { loadOrCreateMasterKey, masterKeyPath } from './secrets.mjs';
import { openDatabase } from './db/index.mjs';
import { readSettings, writeSettings } from './db/settings.mjs';
import { createModelGateway } from './providers/registry.mjs';
import { pickDeclaredParams } from './providers/params.mjs';
import { createLauncher } from './providers/launcher.mjs';
import { createMcpRegistry } from '../core/mcp/registry.mjs';
import { createAgentRuntime } from './agent/runtime.mjs';
import { listMcpServers } from './db/mcp.mjs';
import { createChatStore } from './db/chat.mjs';
import { createCardStore } from './db/cards.mjs';
import { createWorldbookStore } from './db/worldbook.mjs';
import { createPromptStore } from './db/prompts.mjs';
import { createVectorStore } from './db/vectors.mjs';
import { createMemoryStore } from './db/memory.mjs';
import { createReferenceStore } from './db/databank.mjs';
import { createQdrantBackend } from './vectors/qdrant.mjs';
import { createComfyStore } from './db/comfy.mjs';
import { createAssetStore } from './db/assets.mjs';
import { createComfyLauncher } from './toolbox/comfy-launcher.mjs';
import { createCostStore } from './db/cost.mjs';
import { createReviewStore } from './db/review.mjs';
import { createPlansStore } from './db/plans.mjs';
import { createCollectionsStore } from './db/collections.mjs';
import { createTasksStore } from './db/tasks.mjs';
import { createComfyRunner } from './toolbox/runner.mjs';
import { createBackupStore } from './db/backup.mjs';
import { createMaintenanceStore } from './db/maintenance.mjs';
import { createFrontendStore } from './db/frontend.mjs';
import { createScheduler } from './scheduler.mjs';
import { ProviderError } from '../core/errors.mjs';
import { listXray, saveXray, pruneXray } from './db/xray.mjs';
import { listBindings, providerConfig } from './db/providers.mjs';
import { resolveModel } from '../core/models/router.mjs';

export function createRuntime({ dataDir, logger: providedLogger = null, withComfy = true, withLauncher = true, forceClientComfy = false, multiUser = false } = {}) {
  if (!dataDir) throw new Error('createRuntime 需要 dataDir');

  const bootstrapLogger = providedLogger ?? createLogger(process.env.TAVERN_LOG ?? 'info');
  const db = openDatabase({ dataDir, logger: bootstrapLogger });
  const settings = readSettings(db.repo);
  // 多用户模式默认「浏览器直连」：朋友的 ComfyUI 不该让主机进程去连（既连不上，
  // 也把主机网络暴露给用户可控地址 → SSRF）。只在用户没显式设过时才写默认值，
  // 写进设置表后行为与其他设置一致（可在界面上改回 server）。
  if (multiUser && !db.repo.get('SELECT key FROM settings WHERE key = ?', ['comfy.executionMode'])) {
    writeSettings(db.repo, { 'comfy.executionMode': 'client' });
    settings['comfy.executionMode'] = 'client';
  }
  const logger = providedLogger ?? createLogger(settings['logging.level'] ?? 'info');
  logger.setLevel?.(settings['logging.level'] ?? 'info');

  // 主密钥只用来加解密提供方密钥；模型网关每次调用都现读配置，改完立即生效。
  const masterKey = loadOrCreateMasterKey(masterKeyPath(dataDir));
  // withLauncher=false 时不建本地代理托管：它会以服务进程的身份执行配置里的命令，
  // 所以多用户模式下只给管理员账号的租户建（见 server/tenants.mjs）。
  const launcher = withLauncher ? createLauncher({ logger }) : null;
  const models = createModelGateway({ repo: db.repo, masterKey, launcher, logger });
  const mcp = createMcpRegistry({ logger });
  for (const server of listMcpServers(db.repo)) mcp.define(server);
  const agents = createAgentRuntime({ repo: db.repo, models, mcp, logger });

  // 玩卡区的端口：把存储、模型网关、绑定解析交给 core，core 保持不碰数据库。
  const chatStore = createChatStore({ repo: db.repo });
  const cardStore = createCardStore({ repo: db.repo, dataDir });
  const worldbookStore = createWorldbookStore({ repo: db.repo });
  const promptStore = createPromptStore({ repo: db.repo });
  const vectorStore = createVectorStore({ repo: db.repo });
  const memoryStore = createMemoryStore({ repo: db.repo });
  const referenceStore = createReferenceStore({ repo: db.repo });
  const comfyStore = createComfyStore({ repo: db.repo });
  const assetStore = createAssetStore({ repo: db.repo, dataDir });
  const costStore = createCostStore({ repo: db.repo });
  const reviewStore = createReviewStore({ repo: db.repo });
  const plansStore = createPlansStore({ repo: db.repo });
  const collectionsStore = createCollectionsStore({ repo: db.repo });
  const tasksStore = createTasksStore({ repo: db.repo });
  // allowExecutableConfig：只有能执行 launcher 的运行时（单机 / 管理员）才允许把
  // 备份里的 providers.launcher、mcp_servers 原样恢复回去；成员租户恢复时把它们剥掉，
  // 否则成员能靠"导一份改过的备份"把启动命令塞进自己的数据目录，等这个目录被以启用
  // launcher 的方式打开时在主机上执行（详见 docs/SECURITY.md 的本地代理那一节）。
  const backupStore = createBackupStore({ rawDb: db.db, repo: db.repo, dataDir, logger, allowExecutableConfig: withLauncher });
  const maintenanceStore = createMaintenanceStore({ repo: db.repo, dataDir });
  const frontendStore = createFrontendStore({ repo: db.repo });

  // 工具箱要读"当前的"设置（改了立即生效），所以传函数而不是快照。
  const currentSettings = () => readSettings(db.repo);
  // forceClientComfy：多用户模式下"成员"的租户必须走浏览器直连。
  // 否则他可以把 baseUrl 指到内网任意地址、执行模式改回 server，让**主机进程**去连
  // 那个地址（盲扫端口，还能从 /system_stats 读回版本与设备信息）= SSRF。
  const settingsForPorts = forceClientComfy
    ? () => ({ ...currentSettings(), 'comfy.executionMode': 'client' })
    : currentSettings;
  // ComfyUI 启动托管：和 providers.launcher 同一条安全口径 —— 它会以服务进程的身份
  // 执行设置里的命令，所以 withLauncher=false 的租户（多用户模式下的成员）干脆不建。
  const comfyLauncher =
    withComfy && withLauncher
      ? createComfyLauncher({
          logger,
          getSettings: currentSettings,
          stateFile: path.join(dataDir, 'comfy-launcher.json'),
          hasActiveWork: () => comfyStore.listRuns({ status: 'queued', limit: 1 }).length > 0 || comfyStore.listRuns({ status: 'running', limit: 1 }).length > 0,
        })
      : null;
  const comfyRunner = withComfy
    ? createComfyRunner({
        store: comfyStore,
        assets: assetStore,
        launcher: comfyLauncher,
        getConfig: () => {
          const live = currentSettings();
          return {
            baseUrl: live['comfy.baseUrl'],
            enabled: live['comfy.enabled'],
            timeoutMs: live['comfy.timeoutMs'],
            executionMode: live['comfy.executionMode'],
          };
        },
        logger,
        attachImages: ({ chatId, messageId, images }) => {
          if (!chatId || !messageId) return;
          const message = chatStore.getMessage(chatId, messageId);
          if (!message) return;
          const existing = Array.isArray(message.extra?.images) ? message.extra.images : [];
          const merged = [...existing];
          for (const image of images) if (!merged.includes(image.assetId)) merged.push(image.assetId);
          chatStore.updateMessage(chatId, messageId, { extra: { ...message.extra, images: merged } });
        },
      })
    : null;

  const embeddingProviderId = () => {
    const row = db.repo.get("SELECT id FROM providers WHERE kind = 'embedding' AND enabled = 1 ORDER BY is_default DESC, created_at ASC LIMIT 1");
    return row?.id ?? null;
  };

  const ports = {
    chatStore,
    cardStore,
    worldbookStore,
    promptStore,
    vectorStore,
    memoryStore,
    referenceStore,
    comfyStore,
    comfyRunner,
    assetStore,
    costStore,
    reviewStore,
    plansStore,
    collectionsStore,
    tasksStore,
    backupStore,
    maintenanceStore,
    frontendStore,
    models,
    logger,
    getSettings: settingsForPorts,
    // ComfyUI 出图的占位符上下文：当前对话 + 在场角色 + 对话变量 + 场景状态
    chatContext: (chatId, memberId = null) => {
      const chat = chatId ? chatStore.getChat(chatId) : null;
      const members = chat ? chatStore.listMembers(chat.id) : [];
      const member = memberId ? members.find((item) => item.id === memberId) ?? null : members.find((item) => !item.muted) ?? members[0] ?? null;
      const variables = {};
      for (const row of chatId ? chatStore.listVariables(chatId, { scope: 'chat' }) : []) variables[row.key] = row.value;
      return { chat, member, variables, worldState: chat?.worldState ?? {} };
    },
    resolveBinding: ({ characterId = null, chatId = null, memberId = null, kind = 'chat' } = {}) =>
      resolveModel({ bindings: listBindings(db.repo, { kind }), characterId, chatId, memberId, kind }),
    // 采样参数（含单价）。价目表里配了这一家 / 这个模型的价就覆盖提供方自带的。
    providerParams: (providerId, model = null) => {
      const base = providerConfig(db.repo, masterKey, providerId)?.params ?? {};
      if (!providerId) return base;
      const override = costStore.findPricing(providerId, model);
      if (!override) return base;
      return {
        ...base,
        ...(override.priceIn === null ? {} : { priceIn: override.priceIn }),
        ...(override.priceOut === null ? {} : { priceOut: override.priceOut }),
        cacheDiscount: override.cacheDiscount,
      };
    },
    // 酒馆预设里搬过来的采样参数：按这个提供方的适配器过滤一遍，只留它认的键
    // （预设是给别的后端写的，有些字段发过去会被拒）。
    presetParams: (providerId, params = {}) =>
      pickDeclaredParams(providerConfig(db.repo, masterKey, providerId)?.adapter ?? 'openai', params),
    // 记账（蓝图 3.2）：一轮回复跑完时把用量落库
    recordUsage: (entry) => engine.services.cost.record(entry),
    // 嵌入端口：没配嵌入模型时返回 null，向量服务就退化成"只做关键词索引"
    embed: async (texts, providerId) => {
      const id = providerId ?? embeddingProviderId();
      if (!id) return null;
      return models.embed(id, texts);
    },
    /**
     * 可选的外部向量库（Qdrant）。没配 vector.backend=qdrant 时这里就是 null，
     * 检索一切走内置的暴力余弦；配了也只是"候选生成器"，打分口径仍在 core 里统一。
     */
    vectorBackend: settings['vector.backend'] === 'qdrant' && settings['vector.url']
      ? createQdrantBackend({
        url: settings['vector.url'],
        apiKey: settings['vector.apiKey'] || null,
        collection: settings['vector.collection'] || 'silver_tavern',
        logger,
      })
      : null,
    // 记忆摘要：借聊天模型写一段总结
    summarize: async ({ kind = 'small', chatId = null, characterId = null, messages = [] } = {}) => {
      const resolved = resolveModel({ bindings: listBindings(db.repo, { kind: 'chat' }), characterId, chatId, kind: 'chat' });
      if (!resolved?.providerId) throw new ProviderError('还没有可用模型，生成不了记忆摘要：去「模型接入」加一个并设为默认');
      const system =
        kind === 'large'
          ? '你在整理长篇角色扮演的长期档案。把下面这些小总结再总结成一份不失控的档案，重点保留：人物关系变化、重要设定、伏笔、承诺、未完成的事。直接给档案正文。'
          : '你在为角色扮演做前情提要。把下面这段对话压缩成一段简洁的总结，写清楚：发生了什么、谁说了什么、场景切换、当前目标。直接给总结正文。';
      const text = messages
        .map((message) => `${message.role === 'user' ? '用户' : message.role === 'system' ? '旁白' : '角色'}：${message.content ?? ''}`)
        .join('\n');
      let out = '';
      for await (const chunk of models.chat(resolved.providerId, { model: resolved.model ?? null, system, messages: [{ role: 'user', content: text }], params: {} })) {
        if (chunk.type === 'text') out += chunk.text;
      }
      return out.trim();
    },
    /**
     * 报告页的「AI 旁白」：把这期的统计丢给聊天模型，让它写一段回顾。
     * 会花 token，所以只有前端点按钮才走这里；没配模型就抛错。
     */
    narrate: async (text) => {
      const resolved = resolveModel({ bindings: listBindings(db.repo, { kind: 'chat' }), kind: 'chat' });
      if (!resolved?.providerId) throw new ProviderError('还没有可用的聊天模型，写不了回顾旁白：去「模型接入」加一个');
      const system =
        '你在给一份"角色扮演月度回顾"写卷首语。照给定的统计写 2~4 句中文，语气温暖、具体、不煽情，'
        + '不要提"数据""统计""token"这些词，也不要罗列数字清单。直接给正文。';
      let out = '';
      for await (const chunk of models.chat(resolved.providerId, { model: resolved.model ?? null, system, messages: [{ role: 'user', content: text }], params: {} })) {
        if (chunk.type === 'text') out += chunk.text;
      }
      return out.trim();
    },
    memoryMessages: (chatId) => chatStore.listMessages(chatId),
    // 聊天里挂的提示词预设（「切预设」靠它生效）
    getPreset: (presetId) => (presetId ? promptStore.getPreset(presetId)?.data ?? null : null),
    // 模块（Mod）：挂在对话上的零件。提示词插进提示词，样式/沙箱面板由接口那边发给前端。
    getModule: (id) => promptStore.getModule(id),
    moduleTrust: (id) => promptStore.getModuleTrust(id),
    // 存下来、启用的正则脚本：发送前改用户输入，收到后改 AI 输出（core/chat 的完整正则链）
    getRegexScripts: () => promptStore.activeScripts(),
    saveXray: (entry) => {
      if (settings['data.keepPromptXray'] === false) return null;
      const saved = saveXray(db.repo, entry);
      pruneXray(db.repo, settings['data.keepPromptXrayLimit']);
      return saved;
    },
    // 一轮回复结束后问一句"要不要出图"（ComfyUI 的半自动 / 全自动触发）。
    // 这里引用 engine 是安全的：端口只在聊天真跑起来之后才会被调用。
    imageTrigger: withComfy ? (info) => engine.services.comfy.triggerForMessage(info) : null,
    // 剧情换装：AI 在回复里写 [换装: 套装名] 就换衣服（跟出图触发同一处调用）。
    outfitTrigger: withComfy ? (info) => engine.services.comfy.applyOutfitMarkers(info) : null,
  };

  const engine = createEngine({ settings, ports });

  const stores = { chatStore, cardStore, worldbookStore, promptStore, vectorStore, memoryStore, referenceStore, comfyStore, assetStore, costStore, reviewStore, backupStore, maintenanceStore, frontendStore, repo: db.repo };

  // 定时任务（蓝图 3.2）：只有 HTTP 入口需要它，MCP stdio 进程不跑后台备份。
  const scheduler = withComfy
    ? createScheduler({ engine, repo: db.repo, chatStore, logger })
    : null;
  scheduler?.start();

  function stop() {
    scheduler?.stop();
    mcp.disconnectAll();
    launcher?.stopAll();
    comfyRunner?.stop();
    // 托管起来的 ComfyUI 跟着酒馆一起收掉，别留一个 python 在后台占显存
    comfyLauncher?.stop('酒馆退出');
    comfyLauncher?.clearIdle?.();
    db.close();
  }

  return {
    dataDir,
    db,
    repo: db.repo,
    settings,
    logger,
    engine,
    models,
    masterKey,
    launcher,
    mcp,
    agents,
    stores,
    ports,
    comfyRunner,
    comfyLauncher,
    comfyStore,
    assetStore,
    costStore,
    reviewStore,
    backupStore,
    maintenanceStore,
    frontendStore,
    scheduler,
    xray: (query) => listXray(db.repo, query),
    stop,
  };
}
