/**
 * 提供方注册表。
 *
 * 聊天、嵌入、图片、语音、转写都走同一套：每个提供方声明 kind + 能力，
 * 具体实现在 server/providers/ 下面。骨架阶段只有 null 提供方，
 * 调用会抛 NotImplementedError，而不是静默返回空结果。
 */

import { ValidationError, ConflictError, NotFoundError, NotImplementedError } from './errors.mjs';
import { assertShape, SHAPES } from './contracts.mjs';

export const PROVIDER_KINDS = [
  { id: 'chat', title: '聊天模型', summary: '生成角色回复' },
  { id: 'embedding', title: '嵌入模型', summary: '把文本变成向量' },
  { id: 'image', title: '图片生成', summary: '立绘、背景、CG' },
  { id: 'speech', title: '语音合成', summary: '把回复读出来' },
  { id: 'transcription', title: '语音识别', summary: '把说的话转成文字' },
];

export function getProviderKind(id) {
  const kind = PROVIDER_KINDS.find((k) => k.id === id);
  if (!kind) throw new NotFoundError(`提供方类型 ${id}`);
  return kind;
}

/** 空提供方：任何调用都明确报"没接"。 */
export function createNullProvider(kind) {
  const fail = () => {
    throw new NotImplementedError(`${getProviderKind(kind).title}（还没接入任何提供方）`);
  };
  return {
    descriptor: {
      kind,
      id: 'none',
      label: '未接入',
      status: 'planned',
      capabilities: {},
    },
    listModels: fail,
    chat: fail,
    embed: fail,
    generateImage: fail,
    synthesize: fail,
    transcribe: fail,
    test: fail,
  };
}

export function createProviderRegistry() {
  /** @type {Map<string, Map<string, object>>} */
  const byKind = new Map();

  for (const kind of PROVIDER_KINDS) {
    const nullProvider = createNullProvider(kind.id);
    byKind.set(kind.id, new Map([[nullProvider.descriptor.id, nullProvider]]));
  }

  function register(provider) {
    const descriptor = provider?.descriptor;
    assertShape(descriptor, SHAPES.provider, 'provider.descriptor');
    getProviderKind(descriptor.kind);
    const bucket = byKind.get(descriptor.kind);
    if (bucket.has(descriptor.id)) {
      throw new ConflictError(`提供方重复：${descriptor.kind}/${descriptor.id}`);
    }
    bucket.set(descriptor.id, provider);
    return provider;
  }

  function get(kind, id) {
    const bucket = byKind.get(kind);
    if (!bucket) throw new ValidationError(`未知提供方类型：${kind}`);
    const provider = bucket.get(id);
    if (!provider) throw new NotFoundError(`提供方 ${kind}/${id}`);
    return provider;
  }

  function list(kind) {
    if (kind) {
      getProviderKind(kind);
      return [...byKind.get(kind).values()].map((p) => p.descriptor);
    }
    return PROVIDER_KINDS.flatMap((k) => [...byKind.get(k.id).values()].map((p) => p.descriptor));
  }

  function kinds() {
    return PROVIDER_KINDS.map((kind) => ({
      ...kind,
      providers: list(kind.id),
      implemented: list(kind.id).some((p) => p.id !== 'none'),
    }));
  }

  return { register, get, list, kinds, byKind };
}
