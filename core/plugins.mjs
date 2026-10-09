/**
 * 插件机制（蓝图 3.2「扩展性」）。纯逻辑：这里只负责"清单怎么算合法、钩子怎么登记"，
 * 真正读目录、import 代码、往路由/技能表里塞东西都在 server/plugins.mjs。
 *
 * 设计要点：
 *   - 插件放在 `<数据目录>/plugins/<名字>/`：一个 `plugin.json`（manifest）+ 一个入口 `index.mjs`。
 *   - 入口 default export 一个 `register(api)` 函数，通过 api 装四种钩子：
 *       api.routes.get/post/put/delete(path, handler, meta)  注册 HTTP 接口（必须是 /api/ 开头）
 *       api.skills.register(skill)                           注册写卡技能（和内置技能同格式）
 *       api.tools.register(tool)                             注册 MCP 工具（把酒馆当 MCP 服务器时暴露出去）
 *       api.views.register({ key, title, icon })             登记界面视图（客户端按 manifest.views 里的 file 动态 import）
 *   - 视图模块是纯浏览器 ESM，由 `/api/plugins/<名字>/<file>` 提供，和主前端一样无构建。
 *   - 不碰 core/modules.mjs：插件的模块清单在 `/api/app` 里追加，模块地图自身的校验不受影响。
 *   - 任何插件加载失败都只记一条警告，绝不拖垮主服务。
 */

import { ValidationError } from './errors.mjs';

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const FILE_RE = /^[a-zA-Z0-9._-]+$/;

export const PLUGIN_HOOKS = ['routes', 'skills', 'tools', 'views'];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function normaliseManifest(raw = {}, folderName = null) {
  const name = String(raw.name ?? folderName ?? '').trim();
  if (!NAME_RE.test(name)) {
    throw new ValidationError(`插件名字不合法：${name || '(空)'}（只允许字母、数字、- 和 _）`);
  }
  const main = String(raw.main ?? 'index.mjs').trim();
  if (!FILE_RE.test(main)) throw new ValidationError(`插件入口文件名不合法：${main}`);

  const views = asArray(raw.views).map((view) => {
    const key = String(view?.key ?? '').trim();
    if (!key) throw new ValidationError(`插件 ${name} 有一个视图没写 key`);
    const file = String(view?.file ?? '').trim();
    if (!FILE_RE.test(file)) throw new ValidationError(`插件 ${name} 的视图 ${key} 文件名不合法`);
    return { key, file, title: String(view?.title ?? key), icon: view?.icon ?? '🧩' };
  });

  const modules = asArray(raw.modules).map((mod) => {
    const id = String(mod?.id ?? '').trim();
    if (!id) throw new ValidationError(`插件 ${name} 有一个模块没写 id`);
    return {
      id,
      area: mod.area ?? 'platform',
      title: String(mod.title ?? id),
      summary: String(mod.summary ?? ''),
      status: ['planned', 'stub', 'partial', 'ready'].includes(mod.status) ? mod.status : 'partial',
      web: mod.web ?? (views.some((view) => view.key === id) ? { view: id } : undefined),
      api: asArray(mod.api),
      plan: asArray(mod.plan),
      plugin: name,
    };
  });

  const styles = asArray(raw.styles).map((file) => {
    const clean = String(file ?? '').trim();
    if (!FILE_RE.test(clean)) throw new ValidationError(`插件 ${name} 的样式文件名不合法：${clean}`);
    return clean;
  });

  return {
    name,
    title: String(raw.title ?? name),
    version: String(raw.version ?? '0.0.0'),
    description: String(raw.description ?? ''),
    main,
    enabled: raw.enabled !== false,
    // 加载顺序：数字小的先装配（视图 / 模块在导航里的先后就按它排）。
    // 不写默认 100，和 SillyTavern 的 loading_order 是同一个意思。
    order: Number.isFinite(Number(raw.order ?? raw.loading_order)) ? Number(raw.order ?? raw.loading_order) : 100,
    // 依赖：声明依赖了哪些插件。缺了不阻断启动，只在清单里标出来（坏插件不能拖垮服务）。
    requires: asArray(raw.requires).map((item) => String(item ?? '').trim()).filter(Boolean),
    optional: asArray(raw.optional).map((item) => String(item ?? '').trim()).filter(Boolean),
    modules,
    views,
    styles,
  };
}

/** 插件能拿到的钩子集合。`options` 里带 manifest / logger / pluginDir 等上下文。 */
export function createPluginHost(options = {}) {
  const { manifest = null, logger = console, ...context } = options;
  const routes = [];
  const skills = [];
  const tools = [];
  const views = [...(manifest?.views ?? [])];
  const errors = [];

  const method = (httpMethod) => (path, handler, meta = undefined) => {
    if (typeof path !== 'string' || !path.startsWith('/api/')) {
      throw new ValidationError(`插件接口必须以 /api/ 开头：${path}`);
    }
    if (typeof handler !== 'function') throw new ValidationError(`插件接口 ${path} 少了处理函数`);
    routes.push({ method: httpMethod, path, handler, meta });
  };

  const api = {
    manifest,
    get name() {
      return manifest?.name ?? null;
    },
    routes: { get: method('get'), post: method('post'), put: method('put'), delete: method('delete'), list: () => routes },
    skills: {
      register(skill) {
        if (!skill || typeof skill.handler !== 'function' || !skill.id) throw new ValidationError('技能要有 id 和 handler');
        skills.push(skill);
      },
    },
    tools: {
      register(tool) {
        if (!tool || typeof tool.handler !== 'function' || !tool.name) throw new ValidationError('MCP 工具要有 name 和 handler');
        tools.push(tool);
      },
    },
    views: {
      register(view) {
        if (!view?.key) throw new ValidationError('视图要有一个 key');
        if (!views.some((item) => item.key === view.key)) views.push({ icon: '🧩', title: view.key, ...view });
      },
    },
    logger,
    ...context,
  };

  return {
    api,
    routes,
    skills,
    tools,
    views,
    errors,
    summary() {
      return { routes: routes.length, skills: skills.length, tools: tools.length, views: views.length };
    },
  };
}

