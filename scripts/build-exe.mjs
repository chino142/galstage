/**
 * 单文件 exe 打包（蓝图「工程收尾」：Node SEA + postject）。
 *
 * 四步：
 *   1. scripts/bundle.mjs 把 core/ + server/ 合成一个 CommonJS 文件（SEA 的入口必须是 CJS）；
 *   2. 把 web/** 列进 SEA 的 assets（打进 exe，运行时用 node:sea 的 getAsset 读，
 *      所以 exe 是真正的单文件 —— 见 server/index.mjs 的 seaAssetReader 与
 *      server/http/static.mjs 的 readAsset 钩子）；
 *   3. node --experimental-sea-config 生成 sea-prep.blob；
 *   4. 复制一份 node 可执行文件，用 postject 把 blob 注进去。
 *
 * postject 只是**构建期**工具（不是运行时依赖），用 `npx --yes postject` 拉一次。
 * 拿不到 postject 时脚本会留下 bundle 与 blob，并打印手动注入的命令。
 *
 * 用法：npm run build:exe   （可加 --out build/silver-tavern.exe --no-postject）
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildBundle } from './bundle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function walkFiles(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(absolute, relative));
    else out.push(relative);
  }
  return out;
}

function argValue(args, flag, fallback = null) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
}

const args = process.argv.slice(2);
const outExe = path.resolve(ROOT, argValue(args, '--out', path.join('build', process.platform === 'win32' ? 'silver-tavern.exe' : 'silver-tavern')));
const buildDir = path.dirname(outExe);
const bundlePath = path.join(buildDir, 'silver-tavern.cjs');
const blobPath = path.join(buildDir, 'sea-prep.blob');
const configPath = path.join(buildDir, 'sea-config.json');
mkdirSync(buildDir, { recursive: true });

console.log('[1/4] 打包 core + server …');
const bundle = buildBundle({ entry: 'server/index.mjs', out: bundlePath });
console.log(`      ${bundle.modules} 个模块 → ${path.relative(ROOT, bundlePath)}（${(bundle.bytes / 1024).toFixed(0)} KB）`);

console.log('[2/4] 收集 web/ 资源 …');
const webRoot = path.join(ROOT, 'web');
const assets = {};
for (const relative of walkFiles(webRoot)) {
  // SEA 的 assets key 不能有反斜杠；值相对配置文件所在目录
  assets[`web/${relative}`] = path.relative(ROOT, path.join(webRoot, relative)).split(path.sep).join('/');
}
writeFileSync(
  configPath,
  `${JSON.stringify(
    {
      // SEA 的 main / output / assets 都按"运行 node 时的当前目录"解析，这里统一用项目根
      main: path.relative(ROOT, bundlePath).split(path.sep).join('/'),
      output: path.relative(ROOT, blobPath).split(path.sep).join('/'),
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
      assets,
    },
    null,
    2,
  )}\n`,
);
console.log(`      ${Object.keys(assets).length} 个文件`);

console.log('[3/4] 生成 SEA blob …');
const blobRun = spawnSync(process.execPath, ['--experimental-sea-config', configPath], { cwd: ROOT, stdio: 'inherit' });
if (blobRun.status !== 0) {
  console.error('生成 SEA blob 失败。');
  process.exit(blobRun.status ?? 1);
}

console.log('[4/4] 复制可执行文件并注入 …');
copyFileSync(process.execPath, outExe);
if (process.platform === 'darwin') spawnSync('codesign', ['--remove-signature', outExe], { stdio: 'ignore' });

if (args.includes('--no-postject')) {
  console.log(`跳过注入。手动注入命令：\n  npx --yes postject "${outExe}" NODE_SEA_BLOB "${blobPath}" --sentinel-fuse ${FUSE}`);
  process.exit(0);
}

const postjectArgs = ['--yes', 'postject', outExe, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', FUSE];
// 优先用 node 同目录下的 npx（Windows 上 PATH 里不一定有，且 .cmd 需要 shell 才能起）
const npxName = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const localNpx = path.join(path.dirname(process.execPath), npxName);
const npx = existsSync(localNpx) ? localNpx : npxName;
const injected = spawnSync(npx, postjectArgs, {
  cwd: ROOT,
  stdio: 'inherit',
  shell: npxName.endsWith('.cmd'),
  // npx.cmd 自己会去调 node：把 node 所在目录塞进 PATH，免得它找不到
  env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` },
});
if (injected.status !== 0) {
  console.error(
    [
      'postject 注入失败（它是构建期工具，需要能跑 npx）。',
      '产物保留在这两个文件里，手动注入：',
      `  npx --yes postject "${outExe}" NODE_SEA_BLOB "${blobPath}" --sentinel-fuse ${FUSE}`,
    ].join('\n'),
  );
  process.exit(injected.status ?? 1);
}

const size = statSync(outExe).size;
console.log(`完成：${path.relative(ROOT, outExe)}（${(size / 1024 / 1024).toFixed(0)} MB）`);
console.log(`跑起来：TAVERN_PORT=8788 "${outExe}"   （再打开 http://127.0.0.1:8788）`);
console.log(`当 MCP 服务器用："${outExe}" --mcp --data-dir <数据目录>`);
