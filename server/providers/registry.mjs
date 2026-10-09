/**
 * 模型网关：把数据库里的提供方配置变成可以真正调用的东西。
 *
 * 每次调用都现读配置（改完地址或换完模型立刻生效）。调用前会先确保
 * 本地代理在跑 —— CLI、反重力那类渠道就是靠这一步自动拉起来的。
 */

import { NotFoundError, ProviderError, TavernError } from '../../core/errors.mjs';
import { providerConfig, listProviders, recordTest, getProviderExtraBody, getProviderParamOverrides } from '../db/providers.mjs';
import { applyParamOverrides, mergeDeep } from '../../core/providers-params-override.mjs';
import { streamChat, listModels, embedTexts, collectStream } from './adapters.mjs';
import { streamVertex, listVertexModels, embedVertexTexts } from './vertex.mjs';

/** 文本补全适配器没有角色概念，把对话拍成一整段提示词。 */
export function flattenPrompt(messages = [], system = '') {
  const parts = [];
  if (system) parts.push(system);
  for (const message of messages) {
    const prefix = message.role === 'assistant' ? 'Assistant' : message.role === 'user' ? 'User' : message.role === 'system' ? 'System' : 'Message';
    parts.push(`${prefix}: ${message.content ?? ''}`);
  }
  parts.push('Assistant:');
  return parts.join('\n\n');
}

export function createModelGateway({ repo, masterKey, launcher = null, logger = console }) {
  function config(id) {
    const found = providerConfig(repo, masterKey, id);
    if (!found) throw new NotFoundError(`提供方 ${id}`);
    if (!found.enabled) throw new ProviderError(`提供方「${found.label}」已被停用`);
    // Vertex 两种模式都能不填 baseUrl：express 默认 aiplatform.googleapis.com，
    // 服务账号模式按 location 拼区域端点。只有别家适配器才必须填地址。
    if (!found.baseUrl && found.adapter !== 'vertex') {
      throw new ProviderError(`提供方「${found.label}」没有填接口地址`);
    }
    // 自定义请求体：并进请求体里（各家都在 payload 末尾展开，所以能覆盖默认字段）。
    return { ...found, extraBody: getProviderExtraBody(repo, id), paramOverrides: getProviderParamOverrides(repo, id) };
  }

  /** 配了本地代理就先确保它在跑；失败会把代理的最近输出带出来。 */
  async function ensureProxy(id, cfg) {
    if (!cfg.launcher || !launcher) return;
    try {
      await launcher.ensure(id, cfg.launcher);
    } catch (err) {
      throw new ProviderError(`提供方「${cfg.label}」的本地代理没起来：${err.message}`);
    }
  }

  /** 自定义请求头 + 鉴权方式，交给适配层。 */
  function authOptions(cfg) {
    return { authStyle: cfg.authStyle, headers: cfg.headers ?? {} };
  }

  /**
   * 适配层抛的是普通 Error（HTTP 失败、JSON 解析失败、服务账号配置有误……）。
   * 这些是"上游的问题"，不是我们自己的 bug，所以统一转成 502，别报成 500。
   */
  function asProviderError(err, cfg) {
    if (err instanceof TavernError) return err;
    return new ProviderError(`提供方「${cfg.label}」调用失败：${err?.message ?? err}`, null);
  }

  function descriptors() {
    return listProviders(repo).map((item) => ({
      kind: item.kind,
      id: item.id,
      label: item.label,
      status: item.enabled ? 'ready' : 'planned',
      capabilities: {
        adapter: item.adapter,
        model: item.model,
        baseUrl: item.baseUrl,
        hasKey: item.hasKey,
        isDefault: item.isDefault,
        authStyle: item.authStyle,
        headerCount: Object.keys(item.headers ?? {}).length,
        hasLauncher: Boolean(item.launcher),
        lastTest: item.lastTest,
      },
    }));
  }

  async function* chat(id, { model = null, messages = [], system = '', prompt, params = {}, signal, prefill = '', tools = null, toolChoice = null } = {}) {
    const cfg = config(id);
    await ensureProxy(id, cfg);

    // 提供方的参数覆盖表：丢掉这家不认的（连预设带来的也丢），
    // 把这家的专属参数按路径拼进请求体（顶层 or 嵌套，例如 Gemini 的 generationConfig）
    const effectiveModel = model || cfg.model || '';
    // 提供方的参数覆盖表：丢掉这家不认的（连预设带来的也丢，含"按模型名自动禁用"那层），
    // 把这家的专属参数按路径拼进请求体（顶层 or 嵌套，例如 Gemini 的 generationConfig）
    const overridden = applyParamOverrides(
      { ...cfg.params, ...params },
      cfg.paramOverrides,
      { model: effectiveModel, adapter: cfg.adapter },
    );
    const mergedParams = overridden.params;
    const extraBody = mergeDeep(cfg.extraBody ?? {}, overridden.extraPatch);
    if (!effectiveModel && cfg.adapter !== 'text') {
      throw new ProviderError(`提供方「${cfg.label}」还没指定模型`);
    }

    const base = {
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: effectiveModel,
      params: mergedParams,
      signal,
      prefill,
      extraBody,
      ...authOptions(cfg),
    };

    try {
      if (cfg.adapter === 'vertex') {
        yield* streamVertex({ ...base, messages, system, tools, toolChoice });
        return;
      }
      // 工具（函数调用）走单独的两个口子，不塞进 params：它不是一个"采样参数"，
      // 而且各家的字段名/形状差别太大，交给适配器自己翻译。
      const payload = cfg.adapter === 'text'
        ? { prompt: prompt ?? flattenPrompt(messages, system) }
        : { messages, system, tools, toolChoice };
      yield* streamChat({ ...base, ...payload, adapter: cfg.adapter });
    } catch (err) {
      throw asProviderError(err, cfg);
    }
  }

  async function complete(id, options) {
    return collectStream(chat(id, options));
  }

  async function embed(id, inputs, { model = null } = {}) {
    const cfg = config(id);
    await ensureProxy(id, cfg);
    const effectiveModel = model || cfg.model || '';
    if (!effectiveModel) throw new ProviderError(`提供方「${cfg.label}」还没指定嵌入模型`);

    const base = {
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: effectiveModel,
      inputs,
      params: cfg.params,
      ...authOptions(cfg),
    };
    try {
      if (cfg.adapter === 'vertex') return await embedVertexTexts(base);
      return await embedTexts({ ...base, adapter: cfg.adapter });
    } catch (err) {
      throw asProviderError(err, cfg);
    }
  }

  async function models(id) {
    const cfg = config(id);
    await ensureProxy(id, cfg);
    try {
      if (cfg.adapter === 'vertex') return await listVertexModels();
      return await listModels({ adapter: cfg.adapter, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, params: cfg.params, ...authOptions(cfg) });
    } catch (err) {
      throw asProviderError(err, cfg);
    }
  }

  /** 连通性测试：先列举模型，不行就真发一次极短的请求。 */
  async function test(id) {
    const cfg = config(id);
    try {
      await ensureProxy(id, cfg);
    } catch (err) {
      recordTest(repo, id, { ok: false, error: err.message });
      return { ok: false, error: err.message, stage: 'launcher' };
    }
    try {
      const list = await listModels({
        adapter: cfg.adapter === 'vertex' ? 'vertex' : cfg.adapter,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        params: cfg.params,
        ...authOptions(cfg),
      });
      recordTest(repo, id, { ok: true });
      return { ok: true, via: 'models', count: list.length, models: list.slice(0, 30) };
    } catch (listError) {
      try {
        const result = await complete(id, {
          messages: [{ role: 'user', content: 'ping' }],
          params: { max_tokens: 1 },
        });
        recordTest(repo, id, { ok: true });
        return { ok: true, via: 'chat', sample: (result.text ?? '').slice(0, 40) };
      } catch (chatError) {
        const message = String(chatError?.message ?? chatError);
        recordTest(repo, id, { ok: false, error: message });
        logger?.debug?.(`提供方 ${cfg.label} 测试失败：${message}`);
        return { ok: false, error: message, listError: String(listError?.message ?? listError) };
      }
    }
  }

  return {
    config,
    descriptors,
    chat,
    complete,
    embed,
    models,
    test,
    launcher: launcher ? { start: (id) => startProxy(id), stop: (id) => launcher.stop(id), status: (id) => launcher.status(id), all: () => launcher.all() } : null,
  };

  async function startProxy(id) {
    const cfg = config(id);
    if (!cfg.launcher) throw new ProviderError(`提供方「${cfg.label}」没有配置本地代理`);
    await launcher.ensure(id, cfg.launcher);
    return launcher.status(id);
  }
}
