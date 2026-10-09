/**
 * 卡内前端的信任模型（纯逻辑，不碰数据库 / DOM）。
 *
 * 两档，判定只看**这张卡是从哪来的**，不看卡自己说了什么：
 *   - `own`（自己的卡）：`characters.source === 'original'`，也就是在本机新建 / 编辑的。
 *     跳过静态检查、声明过的能力全放开，打开对话就自动跑。
 *   - `strict`（别人的卡）：导入进来的。静态检查全开、只能用声明过的能力、**默认不自动跑**，
 *     要你点一下；点过之后可以"信任这张卡"，信任**绑在代码哈希上**。
 *
 * 为什么信任一定要绑哈希：你信任的是"当时那段代码"，不是"这个卡名"。卡以后被更新、
 * 被重新导入、代码变了 → 哈希对不上 → 自动退回未信任，重新问你。
 *
 * 注意：信任记录**不能存在卡数据里**。卡数据会跟着 PNG / JSON 导出走，存进去等于让卡
 * 自己声明"请信任我"。所以它单独存一张表（`card_frontend_trust`）。
 */

import { createHash } from 'node:crypto';

export const FRONTEND_TIERS = [
  { id: 'own', title: '自己的卡', summary: '跳过静态检查、能力全开，打开对话就跑；仍然跑在沙箱 iframe 里' },
  { id: 'strict', title: '别人的卡', summary: '静态检查全开、只能用声明过的能力，默认要你点一下才跑' },
];

/** 代码指纹：只认这三段，改一个字就变。 */
export function frontendCodeHash({ html = '', css = '', js = '' } = {}) {
  return createHash('sha256')
    .update(`${String(html ?? '')}\u0000${String(css ?? '')}\u0000${String(js ?? '')}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * 定这张卡这次该按哪一档跑。
 * @param {{ source?: string, codeHash?: string, trust?: { codeHash?: string }|null }} input
 *   trust 是信任表里那条记录（可能为空）；`trust.codeHash` 跟当前代码对不上就等于没信任过。
 */
export function resolveFrontendPolicy({ source = 'original', codeHash = '', trust = null } = {}) {
  const own = String(source ?? 'original') === 'original';
  const trustedByUser = Boolean(trust && codeHash && trust.codeHash === codeHash);
  const trusted = own || trustedByUser;
  return {
    tier: own ? 'own' : 'strict',
    title: own ? '自己的卡' : '别人的卡',
    trusted,
    // 信任了就跳过静态检查（能力仍然只给桥认识的那些；沙箱 iframe 一直保留）
    skipLint: trusted,
    // 自己的卡自动跑；别人的卡要你先点一下
    autoRun: own,
    grantAll: trusted,
    // 允许卡加载外部图片 / 字体 / 音视频（CSP 放开 https:/http: 的 img / font / media / style）。
    // 自己的卡默认给；导入的卡要你先点过「信任这张卡」——卡片可以用"带参数的图片 URL"
    // 把聊天内容带出去，所以这个权限只该给来源确定的代码。
    allowExternalAssets: trusted,
    codeHash,
    trustedByUser,
    reason: own
      ? '本机新建的卡'
      : trustedByUser
        ? '你信任过这段代码（哈希对得上）'
        : '导入的卡：默认按最严处理，点了「运行」才跑',
  };
}
