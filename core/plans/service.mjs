/**
 * 坑本：还没成卡的想法先记着，想开的时候一键开演变成角色卡。
 *
 * 纯逻辑 + 注入端口（core 不碰数据库）：
 *   ports.plansStore  存储，见 server/db/plans.mjs
 *   ports.cards       开演时用来建卡，见 core/cards/service.mjs
 */

import { NotFoundError, ProviderError, ValidationError } from '../errors.mjs';

export const PLAN_STATUSES = [
  { id: 'idea', title: '只是个想法' },
  { id: 'drafting', title: '在写设定' },
  { id: 'ready', title: '可以开演' },
  { id: 'archived', title: '搁下了' },
];

const PLAN_STATUS_IDS = new Set(PLAN_STATUSES.map((item) => item.id));

/** 认不出来的状态一律当"只是个想法"。 */
export function normalizePlanStatus(value) {
  const id = String(value ?? '').trim();
  return PLAN_STATUS_IDS.has(id) ? id : 'idea';
}

export function createPlansService(ctx) {
  const store = () => ctx.ports.plansStore ?? null;
  const cards = () => ctx.ports.cards ?? null;

  function list(query = {}) {
    const found = store();
    if (!found) return { items: [], total: 0 };
    return found.list({ status: query.status ?? '' });
  }

  function get(id) {
    const found = store();
    return found ? found.get(id) : null;
  }

  function save(input = {}) {
    const found = store();
    if (!found) throw new ProviderError('坑本需要存储端口：请注入 plansStore');
    const title = String(input.title ?? '').trim();
    if (!title) throw new ValidationError('坑本得有个标题');
    return found.save({
      ...input,
      title,
      status: normalizePlanStatus(input.status ?? 'idea'),
      tags: Array.isArray(input.tags) ? input.tags.map((tag) => String(tag).trim()).filter(Boolean) : [],
    });
  }

  function remove(id) {
    const found = store();
    if (!found) throw new ProviderError('坑本需要存储端口：请注入 plansStore');
    if (!found.remove(id)) throw new NotFoundError(`没有这个坑：${id}`);
    return true;
  }

  /**
   * 开演：把坑本里的设定（标题 / 简介 / 备注 / 标签）建成一张角色卡，
   * 并在坑本上记下 card_id —— 记录不删，回头还看得见自己攒过什么。
   */
  async function promote(id) {
    const found = store();
    if (!found) throw new ProviderError('坑本需要存储端口：请注入 plansStore');
    const cardService = cards();
    if (!cardService) throw new ProviderError('开演需要卡服务');
    const plan = found.get(id);
    if (!plan) throw new NotFoundError(`没有这个坑：${id}`);
    const card = await cardService.create({
      name: plan.title,
      data: { name: plan.title, description: plan.summary, scenario: plan.note, tags: plan.tags },
      tags: plan.tags,
      source: 'original',
    });
    found.save({ ...plan, status: 'ready', cardId: card.id });
    return card;
  }

  return { list, get, save, remove, promote, statuses: () => PLAN_STATUSES };
}
