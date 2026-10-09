/**
 * 模型路由：决定"这句话该由哪个模型来答"。
 *
 * 多模型协同的关键就在优先级上。同一个对话里，男主、女主、配角可以各用各的模型：
 *
 *   chat_member（群聊成员覆盖）  优先级最高
 *   character（角色覆盖）        ← "女主用 Claude" 就是这条
 *   chat（对话默认）
 *   default（全局默认）          优先级最低
 *
 * 注意：模型决定的是"谁来生成"，记忆和上下文属于**对话**，不属于模型。
 * 所以不管换多少个模型，它们看到的是同一份历史、同一份世界书、同一份记忆 ——
 * 这就是"所有模型共享记忆"的实现方式（记忆存在 chat 上，模型只是执行者）。
 */

import { ValidationError } from '../errors.mjs';

export const BINDING_SCOPES = [
  { id: 'default', title: '全局默认', priority: 10, hint: '没被任何规则命中时用它' },
  { id: 'chat', title: '对话默认', priority: 20, hint: '这个对话里的默认模型' },
  { id: 'character', title: '角色覆盖', priority: 30, hint: '这个角色说话时换模型' },
  { id: 'chat_member', title: '群聊成员覆盖', priority: 40, hint: '只在这个群里生效，优先级最高' },
];

export const BINDING_SCOPE_IDS = BINDING_SCOPES.map((scope) => scope.id);

export function scopePriority(scopeId) {
  return BINDING_SCOPES.find((scope) => scope.id === scopeId)?.priority ?? 0;
}

/**
 * 纯函数：给一堆绑定和当前上下文，算出用哪个。
 *
 * @param {object} input
 * @param {Array<{scope:string,targetId:string,kind:string,providerId:string,model?:string,params?:object}>} input.bindings
 * @param {string} [input.characterId] 正在说话的角色
 * @param {string} [input.chatId]
 * @param {string} [input.memberId] 群聊成员记录 id（没有就用 characterId 当成员标识）
 * @param {string} [input.kind] 默认 chat
 * @returns {{providerId:string|null, model:string|null, params:object, source:string, sourceTitle:string, considered:Array}}
 */
export function resolveModel({ bindings = [], characterId = null, chatId = null, memberId = null, kind = 'chat' } = {}) {
  const relevant = bindings.filter((binding) => (binding.kind ?? 'chat') === kind);

  const candidates = [
    { scope: 'chat_member', targetId: memberId ?? characterId },
    { scope: 'character', targetId: characterId },
    { scope: 'chat', targetId: chatId },
    { scope: 'default', targetId: '' },
  ];

  const considered = [];
  let winner = null;
  let winnerScope = null;

  for (const candidate of candidates) {
    // 只有 default 这一档是"兜底"；其它档没给对象 id 就等于没命中，
    // 否则 chatId 为空时会错误地掉到全局默认上。
    const matched =
      candidate.scope === 'default'
        ? relevant.find((binding) => binding.scope === 'default')
        : candidate.targetId
          ? relevant.find(
              (binding) => binding.scope === candidate.scope && String(binding.targetId) === String(candidate.targetId),
            )
          : null;
    considered.push({ scope: candidate.scope, targetId: candidate.targetId ?? '', matched: matched?.providerId ?? null });
    if (matched && !winner) {
      winner = matched;
      winnerScope = candidate.scope;
    }
  }

  if (!winner) {
    return { providerId: null, model: null, params: {}, source: 'none', sourceTitle: '未绑定', considered };
  }
  const scope = BINDING_SCOPES.find((item) => item.id === winnerScope);
  return {
    providerId: winner.providerId,
    model: winner.model || null,
    params: winner.params ?? {},
    source: winnerScope,
    sourceTitle: scope?.title ?? winnerScope,
    considered,
  };
}

/**
 * 给一个对话排一遍"谁会用什么模型"，用于界面上的预览。
 * members: [{ id, characterId, name }]
 */
export function planForChat({ bindings = [], chatId = null, members = [], kind = 'chat' } = {}) {
  const list = (members.length ? members : [{ id: null, characterId: null, name: '默认' }]).map((member) => {
    const resolved = resolveModel({ bindings, chatId, characterId: member.characterId, memberId: member.id, kind });
    return { member: member.name, characterId: member.characterId, ...resolved };
  });
  const distinct = new Set(list.map((item) => item.providerId ?? 'none'));
  return {
    items: list,
    distinctProviders: distinct.size,
    multiModel: distinct.size > 1,
    sharedMemory: true, // 记忆挂在对话上，与模型无关
  };
}

export function assertScope(scope) {
  if (!BINDING_SCOPE_IDS.includes(scope)) throw new ValidationError(`未知绑定范围：${scope}`);
  return scope;
}
