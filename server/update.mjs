/**
 * 检查更新 / 自动替换 exe（蓝图 3.2「使用体验」里的自动更新）。
 * 更新源是一份 JSON 清单（http(s) 或本地文件），格式：
 *   { "version": "0.5.1", "url": "<新 exe 的地址或本地路径>", "size": 123456, "sha256": "hex（可选）", "notes": "更新说明（可选）" }
 * 为什么分成"检查"和"安装"两步：检查只读清单、比版本；安装要下载整包、校验、
 * 再拉起一个独立进程替自己换文件 —— 这两步失败代价差很多，界面也各给一个按钮。
 * 自替换只发生在跑在单文件 exe（Node SEA）里：正在运行的 exe 被 Windows 锁着，
 * 得先退出、再由 helper 覆盖。开发模式（node 直跑）只报"有更新"，不碰文件。
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 极简 semver 比较：按点拆开逐段比数字。返回 -1 / 0 / 1。 */
export function compareVersions(a, b) {
  const parse = (value) => String(value ?? '0')
    .trim()
    .replace(/^v/, '')
    .split(/[.-]/)
    .map((part) => {
      const num = Number.parseInt(part, 10);
      return Number.isFinite(num) ? num : 0;
    });
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }
  return 0;
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value ?? ''));
}

function resolveSourceUrl(manifest) {
  const url = String(manifest?.url ?? '').trim();
  if (!url) throw new Error('更新清单里没有 url');
  return url;
}

function readManifest(url) {
  if (isHttpUrl(url)) {
    return fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'follow' })
      .then((response) => {
        if (!response.ok) throw new Error(`更新源返回 ${response.status}`);
        return response.json();
      });
  }
  return Promise.resolve(JSON.parse(readFileSync(url, 'utf8')));
}

function sha256Of(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function downloadExe(sourceUrl, tempFile) {
  if (isHttpUrl(sourceUrl)) {
    const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(300000), redirect: 'follow' });
    if (!response.ok) throw new Error(`下载失败：${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error('下载回来是空的');
    mkdirSync(path.dirname(tempFile), { recursive: true });
    writeFileSync(tempFile, buffer);
    return { file: tempFile, size: buffer.length, sha256: sha256Of(buffer) };
  }
  mkdirSync(path.dirname(tempFile), { recursive: true });
  copyFileSync(sourceUrl, tempFile);
  const buffer = readFileSync(tempFile);
  return { file: tempFile, size: buffer.length, sha256: sha256Of(buffer) };
}

/** 检查有没有更新。不下载、不写文件。 */
export async function checkForUpdate({ url, current } = {}) {
  if (!String(url ?? '').trim()) {
    return { ok: true, configured: false, current, latest: current, hasUpdate: false, note: '还没配置更新源' };
  }
  let manifest;
  try {
    manifest = await readManifest(url);
  } catch (err) {
    return { ok: false, configured: true, current, error: err?.message ?? String(err) };
  }
  const latest = String(manifest?.version ?? '').trim();
  if (!latest) return { ok: false, configured: true, current, error: '更新清单里没有 version' };
  const hasUpdate = compareVersions(latest, current) > 0;
  return {
    ok: true,
    configured: true,
    current,
    latest,
    hasUpdate,
    size: Number(manifest.size) || null,
    notes: String(manifest.notes ?? ''),
  };
}

/**
 * 下载并安装。真正"替换 exe"这一步在跑 SEA 时才会做；开发模式只校验下载，不碰文件。
 */
export async function installUpdate({ url, current, currentExe, packaged = false, pid = process.pid, dataDir } = {}) {
  if (!String(url ?? '').trim()) throw new Error('还没配置更新源');
  const manifest = await readManifest(url);
  const latest = String(manifest?.version ?? '').trim();
  if (!latest) throw new Error('更新清单里没有 version');
  if (compareVersions(latest, current) <= 0) throw new Error('已经是最新版了');

  const sourceUrl = resolveSourceUrl(manifest);
  const tempFile = path.join(dataDir ?? os.tmpdir(), 'update', `silver-tavern-${latest}.exe`);
  const downloaded = await downloadExe(sourceUrl, tempFile);

  if (manifest.size && Math.abs(Number(manifest.size) - downloaded.size) > 4) {
    rmSync(tempFile, { force: true });
    throw new Error(`下载大小对不上：清单写 ${manifest.size}，实际 ${downloaded.size}`);
  }
  if (manifest.sha256 && downloaded.sha256.toLowerCase() !== String(manifest.sha256).toLowerCase()) {
    rmSync(tempFile, { force: true });
    throw new Error('校验和不匹配，下载的包可能坏了');
  }

  if (!packaged) {
    return { ok: true, restarting: false, downloaded: downloaded.size, note: '开发模式下不自动替换：已校验下载完成，请手动覆盖 exe' };
  }
  if (process.platform !== 'win32') {
    return { ok: true, restarting: false, downloaded: downloaded.size, note: '当前系统不是 Windows，请手动替换 exe' };
  }

  spawnSwapper({ tempFile, target: currentExe, pid });
  return { ok: true, restarting: true, downloaded: downloaded.size };
}

/** 拉起一个独立 PowerShell，等本进程退出后覆盖 exe 并重启。 */
function spawnSwapper({ tempFile, target, pid }) {
  const psTarget = String(target).replace(/'/g, "''");
  const psTemp = String(tempFile).replace(/'/g, "''");
  const script = [
    `Start-Sleep -Milliseconds 900`,
    `try { Wait-Process -Id ${pid} -Timeout 90 -ErrorAction SilentlyContinue } catch {}`,
    `$ok = $false`,
    `foreach ($i in 1..5) {`,
    `  try { [System.IO.File]::Copy('${psTemp}', '${psTarget}', $true); $ok = $true; break } catch { Start-Sleep -Milliseconds 700 }`,
    `}`,
    `if ($ok) { try { Remove-Item -LiteralPath '${psTemp}' -Force -ErrorAction SilentlyContinue } catch {}; Start-Process -FilePath '${psTarget}' }`,
  ].join('; ');
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.unref();
}
