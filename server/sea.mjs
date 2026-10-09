/**
 * 单文件 exe（Node SEA）的小适配：web/ 被打进资源里，没有真实文件系统可读。
 * 不在 SEA 里（或拿不到 node:sea）就返回 null，调用方照常走磁盘。
 */

import { createRequire } from 'node:module';

/** 是不是跑在单文件 exe（Node SEA）里。普通 node 启动返回 false。 */
export function isSeaRuntime() {
  try {
    return Boolean(createRequire(import.meta.url)('node:sea')?.isSea?.());
  } catch {
    return false;
  }
}

export function seaAssetReader() {
  try {
    const sea = createRequire(import.meta.url)('node:sea');
    if (!sea?.isSea?.()) return null;
    return (relative) => {
      try {
        const asset = sea.getAsset(`web/${String(relative).replace(/\\/g, '/')}`);
        return asset ? { buffer: Buffer.from(asset) } : null;
      } catch {
        return null;
      }
    };
  } catch {
    return null;
  }
}
