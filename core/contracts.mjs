/**
 * 全项目的接口契约。
 *
 * 骨架阶段最重要的一件事：把"每个模块对外长什么样"钉死。实现可以慢慢补，
 * 但形状不能各写各的。这里用 JSDoc 描述类型，用 SHAPES + assertShape 做运行时
 * 校验（测试里会逐个跑一遍）。
 *
 * @typedef {'planned'|'stub'|'partial'|'ready'} ModuleStatus
 *
 * @typedef {object} ModuleSpec
 * @property {string} id          唯一标识，kebab-case
 * @property {string} area        所属区域 id（见 core/registry.mjs 的 AREAS）
 * @property {string} title       界面上的名字
 * @property {string} summary     一句话说明
 * @property {ModuleStatus} status
 * @property {string[]} [dependsOn]
 * @property {string[]} [api]     它负责的 API 路径前缀
 * @property {object} [web]       { view, icon }
 * @property {string[]} [plan]    计划中的子功能，未实现时显示在界面上
 * @property {string} [blueprint] 对应 docs/功能蓝图.txt 的章节号
 *
 * @typedef {object} ProviderDescriptor
 * @property {string} kind        chat | embedding | image | speech | transcription
 * @property {string} id
 * @property {string} label
 * @property {ModuleStatus} status
 * @property {object} capabilities  支持哪些能力，例如 { streaming:true, vision:false }
 *
 * @typedef {object} CardRecord
 * @property {string} id
 * @property {string} name
 * @property {string} specVersion   v1 | v2 | v3
 * @property {object} data          原样的卡数据（未知字段不许丢）
 * @property {string|null} avatarAssetId
 * @property {string[]} tags
 * @property {boolean} favorite
 * @property {string} createdAt
 * @property {string} updatedAt
 *
 * @typedef {object} PromptXray
 * @property {Array<{id:string,title:string,role:string,content:string,tokens:number,source:string}>} sections
 * @property {string} text           真正发给模型的那一坨
 * @property {{total:number, bySection:Record<string,number>, budget:number|null}} tokens
 * @property {string[]} notes        裁剪、跳过、警告之类的说明
 */

import { ValidationError } from './errors.mjs';

/**
 * 形状表：值里带 `?` 表示可选。
 * 支持的类型：string / number / boolean / array / object / function / any。
 */
export const SHAPES = {
  module: {
    id: 'string',
    area: 'string',
    title: 'string',
    summary: 'string',
    status: 'string',
    dependsOn: 'array?',
    api: 'array?',
    web: 'object?',
    plan: 'array?',
    blueprint: 'string?',
    nav: 'boolean?',
  },
  area: {
    id: 'string',
    title: 'string',
    summary: 'string',
  },
  provider: {
    kind: 'string',
    id: 'string',
    label: 'string',
    status: 'string',
    capabilities: 'object',
  },
  cardRecord: {
    id: 'string',
    name: 'string',
    specVersion: 'string',
    data: 'object',
    tags: 'array',
    favorite: 'boolean',
    createdAt: 'string',
    updatedAt: 'string',
  },
  promptXray: {
    sections: 'array',
    text: 'string',
    tokens: 'object',
    notes: 'array',
  },
  worldInfoResult: {
    entries: 'array',
    reasons: 'array',
  },
  vectorStats: {
    collections: 'array',
    total: 'number',
  },
  listResult: {
    items: 'array',
    total: 'number',
  },
};

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

export function satisfiesShape(value, shape) {
  if (typeOf(value) !== 'object') return false;
  for (const [key, spec] of Object.entries(shape)) {
    const optional = spec.endsWith('?');
    const expected = optional ? spec.slice(0, -1) : spec;
    const actual = typeOf(value[key]);
    if (optional && (actual === 'undefined' || actual === 'null')) continue;
    if (expected === 'any') continue;
    if (actual !== expected) return false;
  }
  return true;
}

export function assertShape(value, shape, label = 'value') {
  if (typeOf(value) !== 'object') {
    throw new ValidationError(`${label} 必须是对象，实际是 ${typeOf(value)}`);
  }
  for (const [key, spec] of Object.entries(shape)) {
    const optional = spec.endsWith('?');
    const expected = optional ? spec.slice(0, -1) : spec;
    const actual = typeOf(value[key]);
    if (optional && (actual === 'undefined' || actual === 'null')) continue;
    if (expected === 'any') continue;
    if (actual !== expected) {
      throw new ValidationError(`${label}.${key} 应该是 ${expected}，实际是 ${actual}`);
    }
  }
  return value;
}

/** 一个"结构对、内容空"的列表结果，占位实现统一返回它。 */
export function emptyList() {
  return { items: [], total: 0 };
}
