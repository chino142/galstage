/**
 * 打发布包：把 exe、用户文档、移动端脚本和完整源码合成一个 zip。
 *
 * 这一步以前是手工拼的：包里的《使用须知》《使用指南》《怎么改》三份文档只活在临时
 * 目录里（一清就没了），源码放哪几份也靠记忆。现在固定成一条命令，那三份文档也进了
 * 版本库（extras/），不会再丢。
 *
 * 包里的结构（和 0.7.1 那个包保持一致）：
 *   SilverTavern.exe
 *   LICENSE / NOTICE.md
 *   使用须知.txt / 使用指南.txt
 *   移动端-Termux/          ← extras/termux/
 *   源代码/                 ← git 跟踪的全部文件，去掉 .github/ 与 extras/，
 *                             再加一份 extras/怎么改.txt
 *
 * 用法：
 *   node scripts/build-exe.mjs        # 先出 exe
 *   node scripts/package-release.mjs  # 再打包（可加 --exe <路径> --out <路径>）
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createZip } from '../server/toolbox/zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE_IN_ZIP = 'SilverTavern.exe';
const TERMUX_DIR = '移动端-Termux';
const SOURCE_DIR = '源代码';

/**
 * 打包时从「源代码/」里去掉的顶层路径。
 * `.github/` 是 CI 与 PR 模板，出了 GitHub 没意义（这个项目也不收 PR）；
 * `extras/` 会在包里被重新组织成顶层的「移动端-Termux/」，不重复放一份。
 */
const SOURCE_EXCLUDE = ['.github/', 'extras/'];

/** 摆在包顶层的文档。 */
const ROOT_DOCS = ['LICENSE', 'NOTICE.md'];

/** extras/ 里这两份要摆到包顶层。 */
const USER_DOCS = ['使用须知.txt', '使用指南.txt'];

/** 这一份放进「源代码/」，给拿到源码的人看怎么改。 */
const SOURCE_NOTE = '怎么改.txt';

function argValue(args, flag, fallback = null) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
}

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

/**
 * 拿 git 跟踪的文件当「完整源码」的白名单：`data/`、`work/`、`build/`、`outputs/`
 * 这些天然进不来，不用在脚本里另抄一份忽略规则。
 */
function trackedFiles() {
  const run = spawnSync('git', ['-c', 'core.quotepath=false', 'ls-files', '-z'], { cwd: ROOT });
  if (run.error || run.status !== 0) {
    console.error('读不到 git 跟踪的文件列表。这个脚本需要 git（只用来列文件，不会动仓库）。');
    console.error(run.error ? `  ${run.error.message}` : String(run.stderr ?? '').trim());
    process.exit(1);
  }
  return run.stdout.toString('utf8').split('\0').filter(Boolean);
}

const args = process.argv.slice(2);
const version = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const exePath = path.resolve(
  ROOT,
  argValue(args, '--exe', path.join('build', process.platform === 'win32' ? 'silver-tavern.exe' : 'silver-tavern')),
);
const outPath = path.resolve(ROOT, argValue(args, '--out', path.join('build', `SilverTavern-${version}-windows.zip`)));

if (!existsSync(exePath)) {
  console.error(`找不到 ${path.relative(ROOT, exePath)}。先跑 node scripts/build-exe.mjs 把它打出来。`);
  process.exit(1);
}

const entries = [];

/**
 * zip 条目统一用这个固定时间戳。
 *
 * 以前嵌的是源文件的真实 mtime —— 同一份代码今天打和明天打，字节就不一样，
 * 没法拿哈希做对比（条目顺序那边已经排过序了，说明作者是在意可对比性的，只漏了这一项）。
 * 用 2020-01-01：ZIP 的 DOS 时间戳下限是 1980，别用更早的。
 */
const ZIP_EPOCH = new Date(Date.UTC(2020, 0, 1, 0, 0, 0));

/** 加一个文件。缺谁就报谁的名字，别产出半个包。 */
function addFile(zipName, absolutePath) {
  if (!existsSync(absolutePath)) throw new Error(`缺少文件：${path.relative(ROOT, absolutePath)}`);
  entries.push({ name: zipName, data: readFileSync(absolutePath), mtime: ZIP_EPOCH });
}

console.log('[1/4] 收 exe 与文档 …');
addFile(EXE_IN_ZIP, exePath);
for (const name of ROOT_DOCS) addFile(name, path.join(ROOT, name));
for (const name of USER_DOCS) addFile(name, path.join(ROOT, 'extras', name));

console.log(`[2/4] 收 ${TERMUX_DIR}/ …`);
const termuxRoot = path.join(ROOT, 'extras', 'termux');
for (const relative of walkFiles(termuxRoot)) addFile(`${TERMUX_DIR}/${relative}`, path.join(termuxRoot, relative));

const sourceFiles = trackedFiles().filter((relative) => !SOURCE_EXCLUDE.some((prefix) => relative.startsWith(prefix)));
console.log(`[3/4] 收 ${SOURCE_DIR}/（${sourceFiles.length + 1} 个文件）…`);
for (const relative of sourceFiles) addFile(`${SOURCE_DIR}/${relative}`, path.join(ROOT, relative));
addFile(`${SOURCE_DIR}/${SOURCE_NOTE}`, path.join(ROOT, 'extras', SOURCE_NOTE));

// 按名字排序，让每次跑出来的条目顺序一致，方便对比
entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

console.log('[4/4] 压缩 …');
const zip = createZip(entries);
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, zip);

console.log(`完成：${path.relative(ROOT, outPath)}（${entries.length} 个条目，${(zip.length / 1024 / 1024).toFixed(1)} MB）`);
console.log(
  `发版：gh release create v${version} "${path.basename(outPath)}" ` +
    `--title "${version} 内测版（Windows 单文件 + 安卓 Termux + 完整源码）" --notes-file <发布说明>`,
);
