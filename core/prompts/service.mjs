/**
 * 提示词服务：阶段管线 + 预设 / 宏 / 正则 / 片段的读写 + X 光机。
 *
 * 存储通过 ports.promptStore 注入（server/db/prompts.mjs）。
 * 没注入存储时：纯组装（render/preview）照常能用，列表返回空，写操作报未实现。
 *
 * X 光机（prompts.preview）有两种用法：
 *   1) 传完整输入（card/history/settings…）→ 真跑一遍组装，返回每段内容、token 与来源
 *   2) 传 sections（从已存快照里拿到的段落）→ 只重算 text / tokens，配合 dropSections
 *      实现蓝图的"手动踢掉一段再重发"
 */

import { emptyList } from '../contracts.mjs';
import { NotFoundError, NotImplementedError, ValidationError } from '../errors.mjs';
import { estimateTokens } from '../chat/tokens.mjs';
import { PROMPT_STAGES } from './stages.mjs';
import { assemblePrompt, STAGE_IDS } from './assemble.mjs';
import { normalizeScript, PLACEMENT_OPTIONS, substitute_find_regex } from './regex.mjs';
import { lintModuleCss } from './module-css.mjs';
import { moduleCodeHash, modulePlan, moduleTier, normalizeModule } from './modules.mjs';
import { parseNotationBlock } from '../worldbook/notation.mjs';
import { newId } from '../ids.mjs';

export function createPromptService({ settings, ports = {} } = {}) {
  void settings;
  const store = ports.promptStore ?? null;

  function requireStore(what) {
    if (!store) throw new NotImplementedError(what, { reason: '没有注入提示词存储端口（ports.promptStore）' });
    return store;
  }

  function normalizeSections(sections = []) {
    return sections
      .filter(Boolean)
      .map((section) => ({
        id: String(section.id ?? 'section'),
        title: String(section.title ?? section.id ?? '段落'),
        role: String(section.role ?? 'system'),
        content: String(section.content ?? ''),
        source: String(section.source ?? 'unknown'),
        stage: section.stage ?? (STAGE_IDS.includes(section.id) ? section.id : 'custom'),
        tokens: section.tokens ?? estimateTokens(String(section.content ?? '')),
      }));
  }

  /** 把组装结果或手改的段落列表变成 X 光结果。 */
  function toXray(sections, { notes = [], dropSections = [], budget = null, messages = [], system = null } = {}) {
    const drop = new Set(dropSections ?? []);
    let list = normalizeSections(sections);
    const dropped = [];
    if (drop.size) {
      for (const section of list) if (drop.has(section.id)) dropped.push(section.id);
      list = list.filter((section) => !drop.has(section.id));
    }
    const bySection = {};
    let total = 0;
    for (const section of list) {
      bySection[section.id] = section.tokens;
      total += section.tokens;
    }
    // 真正发出去的 system 由组装那边给（它会把"排在历史之后 / 深度注入"的段落排除掉，
    // 那些是以消息形式发出去的）。这里没有就按段落重算一个给手动改段的场景兜底。
    const systemText = system ?? list.filter((section) => section.role === 'system').map((section) => section.content).join('\n\n');
    const text = [systemText, ...messages.map((message) => `${message.role}: ${message.content}`)].filter(Boolean).join('\n\n');
    return {
      sections: list,
      text,
      tokens: { total, bySection, budget: budget ?? null },
      notes: [...notes, ...dropped.map((id) => `X 光机：手动丢掉了「${id}」这一段`)],
    };
  }

  /** 走一遍完整组装（带存储里的宏与正则）。 */
  function render(input = {}) {
    const merged = { ...input };
    const settingsIn = { ...(input.settings ?? {}) };
    const macros = { ...(store ? store.getMacros() : {}), ...(input.macros ?? {}) };
    const regex = store ? store.activeScripts() : [];
    settingsIn.regexScripts = [...regex, ...(Array.isArray(settingsIn.regexScripts) ? settingsIn.regexScripts : [])];
    if (!input.preset && input.presetId && store) merged.preset = store.getPreset(input.presetId)?.data ?? null;
    const assembled = assemblePrompt({ ...merged, settings: settingsIn, macros });
    return assembled;
  }

  return {
    // ---- 阶段与元数据 ----
    stages: () => PROMPT_STAGES,
    placements: () => PLACEMENT_OPTIONS,
    substituteModes: () => [
      { id: substitute_find_regex.NONE, title: '不替换' },
      { id: substitute_find_regex.RAW, title: '先展开宏' },
      { id: substitute_find_regex.ESCAPED, title: '先展开宏并转义' },
    ],

    // ---- 组装 / X 光 ----
    render: async (input = {}) => render(input),

    preview: async (input = {}) => {
      // 用法 2：给一组已有段落，只重算
      if (Array.isArray(input.sections)) {
        return toXray(input.sections, { notes: input.notes ?? [], dropSections: input.dropSections ?? [], budget: input.tokens?.budget ?? null, messages: input.messages ?? [] });
      }
      const assembled = render(input);
      return toXray(assembled.sections, {
        notes: assembled.notes,
        dropSections: input.dropSections ?? [],
        budget: assembled.tokens.budget,
        messages: assembled.messages,
        system: assembled.system,
      });
    },

    // ---- 预设 ----
    listPresets: async (query = {}) => (store ? store.listPresets(query ?? {}) : emptyList()),
    getPreset: async (id) => (store ? store.getPreset(id) : null),
    savePreset: async (payload = {}) => {
      const promptStore = requireStore('保存提示词预设');
      if (payload.id) return promptStore.updatePreset(payload.id, payload);
      return promptStore.insertPreset(payload);
    },
    removePreset: async (id) => requireStore('删除提示词预设').removePreset(id),
    importPreset: async (doc, { name = null, source = 'imported' } = {}) => {
      const promptStore = requireStore('导入酒馆预设');
      if (!doc || typeof doc !== 'object') throw new ValidationError('预设不是合法对象');
      const prompts = Array.isArray(doc.prompts) ? doc.prompts : Array.isArray(doc.prompt_order) ? doc.prompts : null;
      if (!prompts) throw new ValidationError('这个文件里没有 prompts 队列，不像酒馆预设');
      return promptStore.insertPreset({ name: name ?? doc.name ?? '导入的预设', kind: 'chat', data: doc, source });
    },
    exportPreset: async (id) => {
      const preset = await requireStore('导出预设').getPreset(id);
      if (!preset) return null;
      return { buffer: Buffer.from(JSON.stringify(preset.data ?? {}, null, 2), 'utf8'), mime: 'application/json; charset=utf-8', filename: `${preset.name}.json` };
    },

    // ---- 自定义宏 ----
    listMacros: async () => (store ? store.getMacros() : {}),
    saveMacro: async (name, value) => {
      const promptStore = requireStore('保存宏');
      const macros = { ...promptStore.getMacros() };
      const key = String(name ?? '').trim();
      if (!key) throw new ValidationError('宏名不能为空');
      macros[key] = String(value ?? '');
      return promptStore.saveMacros(macros);
    },
    removeMacro: async (name) => {
      const promptStore = requireStore('删除宏');
      const macros = { ...promptStore.getMacros() };
      delete macros[name];
      return promptStore.saveMacros(macros);
    },

    // ---- 正则脚本 ----
    listRegex: async (query = {}) => (store ? store.listRegex(query ?? {}) : emptyList()),
    saveRegex: async (payload = {}) => requireStore('保存正则脚本').saveRegex(payload),
    removeRegex: async (id) => requireStore('删除正则脚本').removeRegex(id),

    // ---- 模块（Mod）----
    // 一个模块 = 说明 + 提示词 + 可选 CSS / HTML / JS。限制规则见 core/prompts/modules.mjs。
    listModules: async (query = {}) => (store ? store.listModules(query ?? {}) : emptyList()),
    getModule: async (id) => (store?.getModule(id) ?? null),
    saveModule: async (payload = {}) => {
      const input = { ...(payload ?? {}) };
      // "一行语法"粘世界书条目：原文留着（下回编辑还能看见自己写的），解析结果也一起存。
      let worldbookNotes = [];
      if (input.worldbookText !== undefined) {
        const parsed = parseNotationBlock(String(input.worldbookText ?? ''));
        input.worldbook = parsed.entries ?? [];
        worldbookNotes = (parsed.errors ?? []).map((item) => (typeof item === 'string' ? item : item?.message ?? String(item)));
      }
      const normalized = normalizeModule(input);
      // 别人的模块不许带违规样式，存的时候就拦下来（自己的只提示，不拦）
      const check = lintModuleCss(normalized.css, { trusted: normalized.source !== 'imported' });
      const blocking = check.issues.filter((issue) => issue.severity === 'error');
      if (blocking.length) {
        throw new ValidationError(`模块样式有 ${blocking.length} 处不能这么写：${blocking.map((issue) => issue.message).join('；')}`);
      }
      const saved = requireStore('保存模块').saveModule({ ...normalized, id: payload?.id ?? normalized.id ?? undefined });
      return {
        ...saved,
        codeHash: moduleCodeHash(saved),
        tier: moduleTier(saved, store.getModuleTrust(saved.id)),
        validation: check,
        worldbookNotes,
      };
    },
    removeModule: async (id) => requireStore('删除模块').removeModule(id),

    /** 模块的信任档（自己写的 / 别人的 / 信任过的） */
    moduleTier: async (id) => {
      const found = store?.getModule(id) ?? null;
      if (!found) throw new NotFoundError(`没有这个模块：${id}`);
      return moduleTier(found, store.getModuleTrust(id));
    },
    trustModule: async (id) => {
      const promptStore = requireStore('信任模块');
      const found = promptStore.getModule(id);
      if (!found) throw new NotFoundError(`没有这个模块：${id}`);
      promptStore.grantModuleTrust(id, moduleCodeHash(found));
      return moduleTier(found, promptStore.getModuleTrust(id));
    },
    untrustModule: async (id) => {
      const promptStore = requireStore('取消信任');
      promptStore.revokeModuleTrust(id);
      const found = promptStore.getModule(id);
      return found ? moduleTier(found, null) : null;
    },
    /** 挂在某个对话上的模块清单（提示词按位置插，样式与沙箱面板由接口那边处理） */
    planFor: async (ids = []) => {
      const list = (Array.isArray(ids) ? ids : [])
        .map((id) => (store ? store.getModule(id) : null))
        .filter(Boolean);
      return modulePlan(list, { trustOf: (id) => store.getModuleTrust(id) });
    },

    // ---------------------------------------------------------------- 模块的导入 / 导出 / 存为模块

    /**
     * 导出成一个自包含的 JSON 文档：七样零件（提示词 / 前置词式的 body、CSS、HTML、JS、
     * 世界书条目、正则脚本、背景图）全在里面，别人导入就能直接用。
     */
    exportModule: async (id) => {
      const promptStore = requireStore('导出模块');
      const found = promptStore.getModule(id);
      if (!found) throw new NotFoundError(`没有这个模块：${id}`);
      return {
        kind: 'silver-tavern-module',
        version: 1,
        exportedAt: new Date().toISOString(),
        module: {
          title: found.title,
          description: found.description,
          body: found.body,
          css: found.css,
          html: found.html,
          js: found.js,
          position: found.position,
          worldbookText: found.worldbookText,
          worldbook: found.worldbook,
          regex: found.regex,
          background: found.background,
          capabilities: found.capabilities,
        },
      };
    },

    /**
     * 导入一个模块文档。
     *
     * 默认按"别人的模块"存（source=imported：样式收进消息区、脚本要信任、正则不跑），
     * 自己写的可以传 ?source=original。
     */
    importModule: async (document, { source = 'imported' } = {}) => {
      const promptStore = requireStore('导入模块');
      const raw = document?.module && typeof document.module === 'object' ? document.module : document;
      if (!raw || typeof raw !== 'object') throw new ValidationError('这个文件里没有模块数据');
      const normalized = normalizeModule({ ...raw, id: null, source: source === 'original' ? 'original' : 'imported' });
      if (!String(normalized.title ?? '').trim()) normalized.title = '导入的模块';
      const check = lintModuleCss(normalized.css, { trusted: normalized.source !== 'imported' });
      const blocking = check.issues.filter((issue) => issue.severity === 'error');
      if (blocking.length) {
        throw new ValidationError(`这次导入的模块样式有 ${blocking.length} 处不能这么写：${blocking.map((issue) => issue.message).join('；')}`);
      }
      const saved = promptStore.saveModule(normalized);
      return {
        ...saved,
        codeHash: moduleCodeHash(saved),
        tier: moduleTier(saved, promptStore.getModuleTrust(saved.id)),
      };
    },

    /**
     * 「存为模块」：把一份配置（对话级的提示词 / 前置词 / 后置词，或者卡上那三样）
     * 直接变成一个模块，之后能挂到任何对话上 —— 那个平台底部永远有的那个按钮就是这个意思。
     */
    moduleFromText: async ({ title, description = '', systemPrompt = '', prefix = '', suffix = '', position = 'after-history', source = 'original' } = {}) => {
      const promptStore = requireStore('存为模块');
      const parts = [
        String(prefix ?? '').trim() ? `【前置词】\n${String(prefix).trim()}` : '',
        String(systemPrompt ?? '').trim() ? `【提示词】\n${String(systemPrompt).trim()}` : '',
      ].filter(Boolean);
      const body = parts.join('\n\n');
      const suffixText = String(suffix ?? '').trim();
      if (!body && !suffixText) throw new ValidationError('这份配置里没有可存的内容（提示词 / 前置词 / 后置词都是空的）');
      const normalized = normalizeModule({
        id: newId('mod'),
        title: String(title ?? '').trim() || '存下来的配置',
        description: String(description ?? '').trim(),
        // 后置词也写进 body：模块的提示词位置选「用户输入之后」时它就落在用户原文后面
        body: [body, suffixText ? `【后置词】\n${suffixText}` : ''].filter(Boolean).join('\n\n'),
        position,
        source,
      });
      const saved = promptStore.saveModule(normalized);
      return {
        ...saved,
        codeHash: moduleCodeHash(saved),
        tier: moduleTier(saved, promptStore.getModuleTrust(saved.id)),
      };
    },
  };
}

export { normalizeScript };
