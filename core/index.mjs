/**
 * 引擎入口。
 *
 * core/ 不碰 HTTP、不碰数据库、不读环境变量：给它配置，它给你服务和定义。
 * server/ 负责把两者接起来。这样引擎能单独测试。
 */

import { createRegistry, AREAS } from './registry.mjs';
import { MODULES } from './modules.mjs';
import { createProviderRegistry } from './providers.mjs';
import { defaultSettings, validateSettings, mergeSettings, SETTINGS_SCHEMA } from './config.mjs';
import { appBus, createBus } from './events.mjs';

import { CARD_FIELDS, CARD_GROUPS, CARD_SPEC_VERSIONS, CARD_PNG_CHUNKS } from './cards/schema.mjs';
import { createCardService } from './cards/service.mjs';
import { createWorldbookService } from './worldbook/service.mjs';
import { PROMPT_STAGES } from './prompts/stages.mjs';
import { createPromptService } from './prompts/service.mjs';
import { createMemoryService, fallbackRank, memoryHeat } from './memory/service.mjs';
import { createVectorService } from './vectors/service.mjs';
import { createFrontendService, THEME_TOKENS } from './frontend/service.mjs';
import { createPlayingServices } from './chat/service.mjs';
import { createToolboxServices } from './toolbox/service.mjs';
import { createPlansService } from './plans/service.mjs';
import { createCollectionsService } from './collections/service.mjs';

export const ENGINE_VERSION = '0.6.0';

export function createEngine({ settings = {}, bus = appBus, ports = {} } = {}) {
  const registry = createRegistry(MODULES);
  registry.finalize();

  const providers = createProviderRegistry();
  const resolvedSettings = mergeSettings(settings);

  const vectorService = createVectorService({ settings: resolvedSettings, ports });

  /**
   * 记忆的相关性排序：先按关键词算一遍（零成本），再拿向量检索的结果加成。
   * 向量那一份要求记忆条目已经建过索引（写卡区 → 记忆 → 向量与检索 → 重建）；
   * 没建过就纯关键词，照样比"只看最近 3 条"强。
   */
  async function rankMemories({ query = '', items = [] } = {}) {
    const keyword = new Map(fallbackRank(query, items).map((hit) => [hit.id, hit.score]));
    let semantic = new Map();
    try {
      const hits = await vectorService.search({ query, collections: ['memory'], topK: 60, keywordWeight: 0.35, minScore: 0, diversify: false });
      semantic = new Map(hits.map((hit) => [hit.sourceId, hit.score]));
    } catch {
      /* 没有索引 / 没有嵌入模型：只用关键词 */
    }
    const hasSemantic = semantic.size > 0;
    return items
      .map((item) => {
        const kw = keyword.get(item.id) ?? 0;
        const vec = semantic.get(item.id) ?? 0;
        const heat = memoryHeat(item);
        const score = hasSemantic ? kw * 0.45 + vec * 0.45 + heat * 0.1 : kw;
        return { id: item.id, score: Number(score.toFixed(4)), keyword: Number(kw.toFixed(4)), vector: Number(vec.toFixed(4)) };
      })
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  const writing = {
    cards: createCardService({ settings: resolvedSettings, ports }),
    worldbook: createWorldbookService({ settings: resolvedSettings, ports }),
    prompts: createPromptService({ settings: resolvedSettings, ports }),
    memory: createMemoryService({ settings: resolvedSettings, ports: { ...ports, rank: rankMemories } }),
    vectors: vectorService,
    frontend: createFrontendService({ settings: resolvedSettings, ports }),
  };

  // 玩卡区：纯逻辑 + 注入的存储/模型端口。worldbook / memory / vectors 直接复用写卡区的服务：
  //   worldbook → 关键词/正则/语义触发选条目
  //   memory   → 基线 + 按当前输入相关性补充
  //   vectors  → 每轮的 databank 召回（参考资料 / 历史 / 记忆片段）
  const playing = createPlayingServices({
    settings: resolvedSettings,
    ports: { ...ports, worldbook: writing.worldbook, memory: writing.memory, databank: writing.vectors },
  });

  // 工具箱：ComfyUI 等。真正发请求 / 落盘的动作通过端口注入，core 只做判断。
  const toolbox = createToolboxServices({ settings: resolvedSettings, ports });

  // 坑本：自己的存储 + 借写卡区的卡服务（"开演"就是拿设定建一张卡）。
  const plans = createPlansService({ settings: resolvedSettings, ports: { ...ports, cards: writing.cards } });
  const collections = createCollectionsService({ settings: resolvedSettings, ports });

  const services = { ...writing, ...playing, ...toolbox, plans, collections };

  return {
    version: ENGINE_VERSION,
    registry,
    providers,
    services,
    settings: resolvedSettings,
    bus,
    areas: AREAS,
    modules: registry.list(),
    blueprint: {
      cards: { fields: CARD_FIELDS, groups: CARD_GROUPS, specVersions: CARD_SPEC_VERSIONS, pngChunks: CARD_PNG_CHUNKS },
      prompts: { stages: PROMPT_STAGES },
      frontend: { themeTokens: THEME_TOKENS },
    },
  };
}

export {
  AREAS,
  MODULES,
  createRegistry,
  createProviderRegistry,
  SETTINGS_SCHEMA,
  defaultSettings,
  validateSettings,
  mergeSettings,
  appBus,
  createBus,
  CARD_FIELDS,
  CARD_GROUPS,
  CARD_SPEC_VERSIONS,
  CARD_PNG_CHUNKS,
  PROMPT_STAGES,
  THEME_TOKENS,
};

export * from './errors.mjs';
export * from './ids.mjs';
export * from './contracts.mjs';
