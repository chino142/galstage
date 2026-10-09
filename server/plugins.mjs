/**
 * 插件加载器（蓝图 3.2「扩展性」）。
 *
 * 扫 `<数据目录>/plugins/<名字>/`，读 manifest、import 入口、跑 register(api)，
 * 把四种钩子的产出收集起来交给调用方装配：
 *   - routes  → HTTP 入口（server/index.mjs）注册进路由器
 *   - skills  → 直接塞进 agent 运行时
 *   - tools   → MCP 服务器（server/mcp-stdio.mjs）作为额外工具
 *   - views   → `/api/app` 带给前端，由 app.js 动态 import 插件自己的浏览器模块
 *
 * 硬要求：**任何一个插件坏掉都不能影响主服务启动** —— 每个插件单独 try/catch，
 * 失败只进 errors 列表并记一条警告。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createPluginHost, normaliseManifest } from '../core/plugins.mjs';

export function pluginsDir(dataDir) {
  return path.join(dataDir ?? '', 'plugins');
}

/**
 * @returns {{ loaded:Array, errors:Array, routes:Array, skills:Array, tools:Array, modules:Array, views:Array, styles:Array }}
 */
export async function loadPlugins({ dataDir, logger = console, engine = null, agents = null } = {}) {
  const result = { loaded: [], errors: [], routes: [], skills: [], tools: [], modules: [], views: [], styles: [] };
  const dir = pluginsDir(dataDir);
  if (!dataDir || !existsSync(dir)) return result;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pluginDir = path.join(dir, entry.name);
    try {
      const manifest = normaliseManifest(JSON.parse(readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8')), entry.name);
      if (!manifest.enabled) {
        result.loaded.push({ ...manifest, enabled: false, skipped: true, hooks: { routes: 0, skills: 0, tools: 0, views: 0 } });
        continue;
      }

      const mod = await import(pathToFileURL(path.join(pluginDir, manifest.main)).href);
      const register = mod.default ?? mod.register;
      if (typeof register !== 'function') {
        throw new Error('插件入口要 default export 一个 register(api) 函数');
      }

      const host = createPluginHost({
        manifest,
        logger,
        engine,
        dataDir,
        pluginDir,
        settings: () => engine?.settings ?? {},
      });
      await register(host.api);

      for (const route of host.routes) result.routes.push({ ...route, plugin: manifest.name });
      for (const skill of host.skills) {
        const withSource = { ...skill, source: 'plugin', plugin: manifest.name };
        result.skills.push(withSource);
        try {
          agents?.addSkill?.(withSource);
        } catch (err) {
          host.errors.push(`技能 ${skill.id} 注册失败：${err?.message ?? err}`);
        }
      }
      for (const tool of host.tools) result.tools.push({ ...tool, plugin: manifest.name });
      // 插件自己声明的模块（进 /api/app 的模块清单，但不动 core/modules.mjs 的校验）
      result.modules.push(...manifest.modules);
      result.views.push(...manifest.views.map((view) => ({ ...view, plugin: manifest.name })));
      result.styles.push(...manifest.styles.map((file) => ({ plugin: manifest.name, file })));

      const hooks = host.summary();
      result.loaded.push({
        name: manifest.name,
        title: manifest.title,
        version: manifest.version,
        description: manifest.description,
        enabled: true,
        order: manifest.order,
        requires: manifest.requires,
        optional: manifest.optional,
        hooks,
        errors: host.errors,
      });
      logger?.info?.(`[plugins] 已加载 ${manifest.name}@${manifest.version}（接口 ${hooks.routes} / 技能 ${hooks.skills} / 工具 ${hooks.tools} / 视图 ${hooks.views}）`);
    } catch (err) {
      const message = err?.message ?? String(err);
      result.errors.push({ name: entry.name, error: message });
      logger?.warn?.(`[plugins] 跳过 ${entry.name}：${message}`);
    }
  }
  // 按插件的 order 排序（数字小的在前），再按名字兜底 —— 视图 / 模块在导航里的先后就稳定了。
  // 这相当于 SillyTavern 的 loading_order；以前只能靠给文件加数字前缀。
  const orderOf = new Map(result.loaded.map((item) => [item.name, Number(item.order ?? 100)]));
  const byOrder = (a, b) => (orderOf.get(a.plugin) ?? 100) - (orderOf.get(b.plugin) ?? 100) || String(a.plugin).localeCompare(String(b.plugin));
  result.views.sort(byOrder);
  result.modules.sort(byOrder);
  result.loaded.sort((a, b) => Number(a.order ?? 100) - Number(b.order ?? 100) || String(a.name).localeCompare(String(b.name)));

  // 依赖检查：缺依赖不阻断启动（坏插件不能拖垮服务），只在清单里标出来。
  const names = new Set(result.loaded.map((item) => item.name));
  for (const item of result.loaded) {
    const missing = (item.requires ?? []).filter((dep) => !names.has(dep));
    if (missing.length) {
      item.missingRequires = missing;
      result.errors.push({ name: item.name, error: `缺少依赖插件：${missing.join('、')}` });
      logger?.warn?.(`[plugins] ${item.name} 缺少依赖：${missing.join('、')}`);
    }
  }
  return result;
}

/** 读插件自己的静态文件（视图 / 样式）。只允许单层文件名，防路径逃逸。 */
export function readPluginFile(dataDir, name, file) {
  const cleanName = String(name ?? '');
  const cleanFile = String(file ?? '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(cleanName)) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(cleanFile) || cleanFile.includes('..')) return null;
  const absolute = path.join(pluginsDir(dataDir), cleanName, cleanFile);
  if (!existsSync(absolute)) return null;
  return { buffer: readFileSync(absolute), file: cleanFile };
}

export function pluginContentType(file = '') {
  if (file.endsWith('.mjs') || file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  if (file.endsWith('.png')) return 'image/png';
  return 'text/plain; charset=utf-8';
}
