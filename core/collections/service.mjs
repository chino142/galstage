/**
 * 剧本合集：把卡按"世界观 / 系列"归档 —— 分组（一级）→ 分类（二级）→ 卡。
 *
 * 纯逻辑 + 注入的存储端口（core 不碰数据库）：
 *   ports.collectionsStore  见 server/db/collections.mjs
 */

import { NotFoundError, ProviderError, ValidationError } from '../errors.mjs';

export function createCollectionsService(ctx) {
  const store = () => ctx.ports.collectionsStore ?? null;

  function requireStore() {
    const found = store();
    if (!found) throw new ProviderError('合集需要存储端口：请注入 collectionsStore');
    return found;
  }

  function list() {
    const found = store();
    return found ? found.list() : { items: [], total: 0 };
  }

  function save(input = {}) {
    const found = requireStore();
    const name = String(input.name ?? '').trim();
    if (!name) throw new ValidationError('合集得有个名字');
    const parentId = input.parentId ? String(input.parentId) : null;
    if (parentId) {
      const parent = found.get(parentId);
      if (!parent) throw new NotFoundError(`没有这个分组：${parentId}`);
      if (parent.parentId) throw new ValidationError('合集只分两级：分类不能再套分类');
    }
    return found.save({ ...input, name, parentId });
  }

  function remove(id) {
    const found = requireStore();
    if (!found.remove(id)) throw new NotFoundError(`没有这个合集：${id}`);
    return true;
  }

  function cards(id) {
    const found = requireStore();
    if (!found.get(id)) throw new NotFoundError(`没有这个合集：${id}`);
    return { items: found.cards(id) };
  }

  function addCards(id, characterIds = []) {
    const found = requireStore();
    if (!found.get(id)) throw new NotFoundError(`没有这个合集：${id}`);
    const ids = (Array.isArray(characterIds) ? characterIds : []).map(String).filter(Boolean);
    return { items: found.addCards(id, ids) };
  }

  function removeCards(id, characterIds = []) {
    const found = requireStore();
    if (!found.get(id)) throw new NotFoundError(`没有这个合集：${id}`);
    const ids = (Array.isArray(characterIds) ? characterIds : []).map(String).filter(Boolean);
    return { items: found.removeCards(id, ids) };
  }

  return { list, save, remove, cards, addCards, removeCards };
}
