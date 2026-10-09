/**
 * 静态文件服务（web/ 目录）。
 *
 * 规则：
 *   - 路径不许逃出根目录；
 *   - 目录 → index.html；
 *   - 文件不存在且是 GET 导航请求 → 回 index.html（单页应用兜底）；
 *   - 带 ETag，命中 If-None-Match 直接 304。
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
};

export function createStaticHandler({ root, spaFallback = 'index.html', readAsset = null }) {
  async function resolveFile(pathname) {
    // 去掉开头斜杠：SEA 资源 key 是 `web/app.js` 这种，带前导斜杠会查不到
    const relative = path.posix.normalize(pathname).replace(/^(\.\.\/)+/, '').replace(/^\/+/, '');
    // 单文件 exe（SEA）模式下 web/ 被打进资源里，没有真实文件可 stat
    if (readAsset) {
      const found = await readAsset(relative);
      if (!found) return null;
      return { file: relative, info: { size: found.buffer.length, mtimeMs: 0 }, buffer: found.buffer };
    }
    let target = path.join(root, relative);
    if (!target.startsWith(root)) return null;
    let info;
    try {
      info = await stat(target);
    } catch {
      return null;
    }
    if (info.isDirectory()) {
      target = path.join(target, 'index.html');
      try {
        info = await stat(target);
      } catch {
        return null;
      }
    }
    return info.isFile() ? { file: target, info } : null;
  }

  return async function serveStatic(ctx) {
    const found = await resolveFile(ctx.path === '/' ? '/index.html' : ctx.path);
    const fallback = found ?? (ctx.method === 'GET' ? await resolveFile(spaFallback) : null);
    if (!fallback) return false;

    const { file, info, buffer } = fallback;
    const ext = path.extname(file).toLowerCase();
    const etag = `W/"${info.size}-${Math.floor(info.mtimeMs)}"`;

    ctx.res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
    ctx.res.setHeader('ETag', etag);
    ctx.res.setHeader('Cache-Control', ext === '.html' ? 'no-cache' : 'no-cache, must-revalidate');

    if (ctx.req.headers['if-none-match'] === etag) {
      ctx.res.writeHead(304).end();
      return true;
    }

    ctx.res.writeHead(200, { 'Content-Length': info.size });
    if (ctx.method === 'HEAD') {
      ctx.res.end();
      return true;
    }
    if (buffer) {
      ctx.res.end(buffer);
      return true;
    }
    createReadStream(file).pipe(ctx.res);
    return true;
  };
}
