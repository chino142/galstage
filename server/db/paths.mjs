/**
 * 数据目录里的路径拼装。
 *
 * 数据库里存的那几个相对路径（`assets.path`、`characters.avatar_asset_id`）
 * **不是可信输入**：它们会跟着加密备份走进来（备份是用户自己造的、口令自己选的），
 * 所以 `../../../../<别处>` 这种必须挡住 —— 否则「删一个素材」就变成
 * 「以服务身份删任意文件」。
 */

import path from 'node:path';

/**
 * 把相对路径安全地拼到根目录下；跑出根目录就返回 `null`，调用方自己决定跳过还是报错。
 *
 * 和 `server/db/backup.mjs` 里那份是同一个实现 —— 原来它只在那儿本地可用，
 * 于是别处只能各写各的（`assets` / `cards` 就漏了）。
 */
export function safeResolve(root, relative) {
  const base = path.resolve(root);
  const absolute = path.resolve(base, String(relative ?? ''));
  if (absolute === base) return null;
  return absolute.startsWith(base + path.sep) ? absolute : null;
}
