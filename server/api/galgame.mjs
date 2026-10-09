/**
 * Galgame 板块 · 自定义前端：存你自己的前端代码 + galgame 提示词，跑之前先审一遍。
 *
 * 为什么单独开一组接口、不塞进卡内前端：
 *   - **权限口径不一样**。卡内前端要按"这张卡从哪来"分档；这个板块是你一个人的，
 *     直接按"自己的代码"处理 —— 跳过静态检查、沙箱能力全给、允许外链资源。
 *   - 它还要存"这一套东西"（前端 + 提示词），所以单独一份文件，不污染卡数据。
 *
 * 存储：<数据目录>/galgame-kit.json。加文件不加表，不用迁移。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { reviewFrontend } from '../../core/frontend/review.mjs';

const KIT_FILE = 'galgame-kit.json';
const CODE_LIMIT = 256 * 1024;

const DEFAULT_KIT = {
  frontend: { html: '', css: '', js: '', capabilities: [] },
  prompts: { system: '', beforeUser: '', afterUser: '' },
};

function str(value, max) {
  return String(value ?? '').slice(0, max);
}

/** 收一收：代码限长、能力去重限量，坏数据不让它进文件。 */
export function normaliseKit(raw = {}) {
  const fe = raw.frontend ?? {};
  const seen = new Set();
  const capabilities = [];
  for (const item of Array.isArray(fe.capabilities) ? fe.capabilities : []) {
    const id = str(item, 60).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    capabilities.push(id);
    if (capabilities.length >= 16) break;
  }
  return {
    frontend: {
      html: str(fe.html, CODE_LIMIT),
      css: str(fe.css, CODE_LIMIT),
      js: str(fe.js, CODE_LIMIT),
      capabilities,
    },
    prompts: {
      system: str(raw.prompts?.system, 20000),
      beforeUser: str(raw.prompts?.beforeUser, 20000),
      afterUser: str(raw.prompts?.afterUser, 20000),
    },
    updatedAt: raw.updatedAt ?? null,
  };
}

export function register(router, { engine, logger, dataDir }) {
  const frontend = engine.services.frontend;
  const file = path.join(dataDir ?? '.', KIT_FILE);

  function readKit() {
    try {
      if (existsSync(file)) return normaliseKit(JSON.parse(readFileSync(file, 'utf8')));
    } catch (err) {
      logger?.warn?.(`[galgame] 读取自定义前端失败：${err?.message ?? err}`);
    }
    return normaliseKit(DEFAULT_KIT);
  }

  router.get('/api/galgame/kit', (ctx) => ctx.json(200, readKit()));

  router.put('/api/galgame/kit', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    const next = normaliseKit({ ...readKit(), ...body, updatedAt: new Date().toISOString() });
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
    logger?.debug?.('[galgame] 自定义前端已保存');
    return ctx.json(200, next);
  }, { bodyLimit: 4 * 1024 * 1024 });

  /** 审查：语法 + 沙箱规则 + 桥能力 + 常见坑，返回一份能直接读的报告。 */
  router.post('/api/galgame/review', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    return ctx.json(200, reviewFrontend({
      html: body.html ?? '',
      css: body.css ?? '',
      js: body.js ?? '',
      capabilities: body.capabilities ?? [],
      allowExternalAssets: true,
    }));
  }, { bodyLimit: 4 * 1024 * 1024 });

  /**
   * 渲染沙箱：这个板块按"你自己的代码"处理 —— 跳过静态检查、允许外链资源。
   * 注意：真正的隔离（沙箱 iframe + CSP + 宿主侧能力校验）照样在，只是不再拦你写的东西。
   */
  router.post('/api/galgame/render', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    const policy = {
      tier: 'own',
      title: 'Galgame 自定义前端',
      trusted: true,
      trustedByUser: false,
      skipLint: true,
      grantAll: true,
      autoRun: true,
      allowExternalAssets: true,
      codeHash: '',
      reason: '这个板块按"你自己的代码"处理，权限全开',
    };
    return ctx.json(200, await frontend.renderSandbox(body, { policy }));
  }, { bodyLimit: 4 * 1024 * 1024 });
}
