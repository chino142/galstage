/**
 * 模块注册表。
 *
 * 每个功能模块在这里登记一次（见 core/modules.mjs）。登记之后：
 *   - 前端导航会自动多出这个入口；
 *   - /api/app 会把它连同 plan 一起吐给前端；
 *   - 依赖关系会在 finalize() 时校验，写错了直接报错，不会拖到运行时。
 */

import { ValidationError, NotFoundError, ConflictError } from './errors.mjs';

export const AREAS = [
  { id: 'writing', title: '写卡区', summary: '造角色、造世界、调配提示词' },
  { id: 'playing', title: '玩卡区', summary: '真的拿它演一场戏' },
  { id: 'galgame', title: 'Galgame', summary: '视觉小说演出、语音，以及你自己贴的前端' },
  { id: 'toolbox', title: '工具箱', summary: '图片、统计、外部工具' },
  { id: 'platform', title: '平台', summary: '设置、数据、模型接入' },
];

export const MODULE_STATUSES = ['planned', 'stub', 'partial', 'ready'];

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export function getArea(id) {
  const area = AREAS.find((a) => a.id === id);
  if (!area) throw new NotFoundError(`区域 ${id}`);
  return area;
}

export function createRegistry(specs = []) {
  /** @type {Map<string, object>} */
  const modules = new Map();
  let finalized = false;

  function register(spec) {
    if (finalized) throw new ConflictError('注册表已冻结，不能再注册模块');
    if (!spec || typeof spec !== 'object') throw new ValidationError('模块描述必须是对象');
    const { id } = spec;
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      throw new ValidationError(`模块 id 不合法：${JSON.stringify(id)}（要求 kebab-case）`);
    }
    if (modules.has(id)) throw new ConflictError(`模块 id 重复：${id}`);
    getArea(spec.area);
    if (!MODULE_STATUSES.includes(spec.status)) {
      throw new ValidationError(`模块 ${id} 的 status 不合法：${spec.status}`);
    }
    const normalized = {
      dependsOn: [],
      api: [],
      web: null,
      plan: [],
      blueprint: null,
      ...spec,
    };
    modules.set(id, normalized);
    return normalized;
  }

  function get(id) {
    const mod = modules.get(id);
    if (!mod) throw new NotFoundError(`模块 ${id}`);
    return mod;
  }

  function list({ area, status } = {}) {
    return [...modules.values()]
      .filter((m) => (area ? m.area === area : true))
      .filter((m) => (status ? m.status === status : true));
  }

  function areas() {
    return AREAS.map((area) => ({ ...area, modules: list({ area: area.id }).map((m) => m.id) }));
  }

  /** 按依赖排好序（被依赖的在前），有环或缺依赖会抛错。 */
  function dependencyOrder() {
    const order = [];
    const state = new Map(); // id -> 'visiting' | 'done'
    const visit = (id, chain) => {
      const current = state.get(id);
      if (current === 'done') return;
      if (current === 'visiting') {
        throw new ConflictError(`模块依赖成环：${[...chain, id].join(' -> ')}`);
      }
      state.set(id, 'visiting');
      const mod = get(id);
      for (const dep of mod.dependsOn) visit(dep, [...chain, id]);
      state.set(id, 'done');
      order.push(mod);
    };
    for (const id of modules.keys()) visit(id, []);
    return order;
  }

  function finalize() {
    if (finalized) return;
    for (const mod of modules.values()) {
      for (const dep of mod.dependsOn) {
        if (!modules.has(dep)) {
          throw new ValidationError(`模块 ${mod.id} 依赖了不存在的模块 ${dep}`);
        }
      }
    }
    dependencyOrder(); // 提前把环查出来
    finalized = true;
  }

  for (const spec of specs) register(spec);

  return {
    register,
    finalize,
    get,
    has: (id) => modules.has(id),
    list,
    areas,
    dependencyOrder,
    get size() {
      return modules.size;
    },
    get finalized() {
      return finalized;
    },
  };
}
