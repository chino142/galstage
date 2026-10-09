/**
 * 分支图：把一堆平铺的对话按内容前缀自动归成一棵树。
 *
 * 抄自 RisuAI 的做法 —— 那边**没有"创建分支"按钮**：把所有聊天按
 * 「首条消息 + 每条消息内容」的哈希建树，前缀相同的自然落进同一分支，
 * 然后算出坐标渲染成图。分支是"聊出来"的，不是"操作出来"的。
 *
 * 需要明确说清的取舍：改了某条消息的文案，它就会落到另一个分支。
 * 所以哈希前会先做一次归一化（去首尾空白、折叠空白）。
 */

const EMPTY_HASH = '0';

/** 稳定的 32 位字符串哈希（和 Risu 一样用简单的移位加法，够用且无依赖）。 */
export function hashText(text) {
  const input = String(text ?? '');
  if (!input) return EMPTY_HASH;
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(index);
    hash |= 0;
  }
  return (hash >>> 0).toString(36);
}

function normalise(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function messageKey(message) {
  const role = message?.role ?? message?.is_user ? 'user' : 'assistant';
  return `${role}:${hashText(normalise(message?.content ?? message?.mes ?? ''))}`;
}

/**
 * 建树。
 * @param {Array<{id:string, title?:string, firstMessage?:string, messages?:Array}>} chats
 * @returns {{root:object, nodes:object[], depth:number}}
 */
export function buildBranchTree(chats = []) {
  const root = { key: '__root__', children: new Map(), chats: [], depth: 0, label: '开场' };

  for (const chat of Array.isArray(chats) ? chats : []) {
    if (!chat) continue;
    const keys = [messageKey({ role: 'assistant', content: chat.firstMessage ?? '' })];
    for (const message of chat.messages ?? []) keys.push(messageKey(message));

    let node = root;
    for (const key of keys) {
      if (!node.children.has(key)) {
        node.children.set(key, { key, children: new Map(), chats: [], depth: node.depth + 1, label: '' });
      }
      node = node.children.get(key);
      if (!node.label) node.label = normalise(chat.title ?? '') || describeKey(key);
    }
    node.chats.push({ id: String(chat.id ?? ''), title: String(chat.title ?? '') });
  }

  const { nodes, links, maxDepth } = flatten(root);
  return { root, nodes, links, depth: maxDepth };
}

function describeKey(key) {
  const [, hash] = String(key).split(':');
  return hash === EMPTY_HASH ? '空消息' : `…${hash}`;
}

function flatten(root) {
  const nodes = [];
  const links = [];
  let maxDepth = 0;
  const walk = (node, parentId) => {
    maxDepth = Math.max(maxDepth, node.depth);
    const id = parentId === null ? 'root' : `${parentId}/${node.key}`;
    nodes.push({
      id,
      key: node.key,
      label: node.label || '（无标题）',
      depth: node.depth,
      isLeaf: node.children.size === 0,
      isBranch: node.children.size > 1 || node.chats.length > 1,
      chats: node.chats,
    });
    if (parentId !== null) links.push({ from: parentId, to: id });
    for (const child of node.children.values()) walk(child, id);
  };
  walk(root, null);
  return { nodes, links, maxDepth };
}

/** 给渲染用的坐标：同一深度的节点横向铺开，父节点居中于子节点之间。 */
export function layoutBranchTree(tree = {}) {
  const nodes = Array.isArray(tree.nodes) ? tree.nodes : [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const childrenOf = new Map();
  for (const link of tree.links ?? []) {
    if (!childrenOf.has(link.from)) childrenOf.set(link.from, []);
    childrenOf.get(link.from).push(link.to);
  }

  let cursor = 0;
  const positions = new Map();
  const place = (id) => {
    const kids = childrenOf.get(id) ?? [];
    const node = byId.get(id);
    if (!node) return cursor;
    if (kids.length === 0) {
      const x = cursor;
      cursor += 1;
      positions.set(id, { x, y: node.depth });
      return x;
    }
    const childXs = kids.map(place);
    const x = childXs.reduce((sum, value) => sum + value, 0) / childXs.length;
    positions.set(id, { x, y: node.depth });
    return x;
  };
  place('root');

  return {
    nodes: nodes.map((node) => ({ ...node, ...(positions.get(node.id) ?? { x: 0, y: node.depth }) })),
    links: (tree.links ?? []).map((link) => ({
      ...link,
      fromPos: positions.get(link.from) ?? { x: 0, y: 0 },
      toPos: positions.get(link.to) ?? { x: 0, y: 0 },
    })),
    width: Math.max(1, cursor),
    depth: tree.depth ?? 0,
  };
}

/** 概览数字。 */
export function branchStats(tree = {}) {
  const nodes = tree.nodes ?? [];
  return {
    chats: nodes.reduce((sum, node) => sum + (node.chats?.length ?? 0), 0),
    nodes: nodes.length,
    // 分叉 = 这里有两条以上的后续（多个子节点），或者同一节点上挂着多个对话
    forks: nodes.filter((node) => node.id !== 'root' && node.isBranch).length,
    depth: tree.depth ?? 0,
    tips: nodes.filter((node) => node.isLeaf).length,
  };
}
