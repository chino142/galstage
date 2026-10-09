/**
 * 极小的打包器：把 `core/` + `server/` 的 ESM 合成一个 CommonJS 文件。
 *
 * 为什么自己写：SEA 注入的入口脚本必须是 CommonJS，而本项目是纯 ESM；
 * 硬约束又要求零第三方运行时依赖，所以不引 esbuild/webpack。
 *
 * 支持的语法就是本项目实际用到的那几种（都是规范写法）：
 *   import * as ns from 'x' / import { a, b as c } from 'x' / import X from 'x' / import 'x'
 *   export function / async function / function*、export const|let|var、export { a, b as c }
 *   export * from 'x'、export default、import.meta.url
 * `node:` 开头的与其它裸模块走原生 require；相对路径的交给内置注册表。
 * 浏览器端代码（web/）不参与打包 —— exe 里把它当 SEA 资源嵌进去。
 *
 * 用法：node scripts/bundle.mjs [--entry server/index.mjs] [--out build/silver-tavern.cjs]
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();

function toId(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function resolveLocal(spec, fromFile) {
  if (!spec.startsWith('.')) return null;
  return toId(path.resolve(path.dirname(fromFile), spec));
}

function toRequire(spec, fromFile) {
  const local = resolveLocal(spec, fromFile);
  return local ? `__req(${JSON.stringify(local)})` : `require(${JSON.stringify(spec)})`;
}

export function transformModule(code, file) {
  const exported = new Set();
  let out = String(code);

  out = out.replace(/import\.meta\.url/g, '__metaUrl');

  out = out.replace(/^import\s+\*\s+as\s+([A-Za-z0-9_$]+)\s+from\s+['"]([^'"]+)['"];?[ \t]*$/gm, (_m, ns, spec) => `const ${ns} = ${toRequire(spec, file)};`);

  out = out.replace(/^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?[ \t]*$/gm, (_m, names, spec) => {
    const bindings = names
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [original, alias] = entry.split(/\s+as\s+/).map((part) => part.trim());
        return alias ? `${original}: ${alias}` : original;
      })
      .join(', ');
    return `const { ${bindings} } = ${toRequire(spec, file)};`;
  });

  out = out.replace(/^import\s+([A-Za-z0-9_$]+)\s*,?\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?[ \t]*$/gm, (_m, def, names, spec) => {
    const bindings = names
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [original, alias] = entry.split(/\s+as\s+/).map((part) => part.trim());
        return alias ? `${original}: ${alias}` : original;
      })
      .join(', ');
    const source = toRequire(spec, file);
    return `const __mod_${def} = ${source}; const ${def} = __mod_${def}; const { ${bindings} } = __mod_${def};`;
  });

  out = out.replace(/^import\s+([A-Za-z0-9_$]+)\s+from\s*['"]([^'"]+)['"];?[ \t]*$/gm, (_m, def, spec) => `const ${def} = ${toRequire(spec, file)};`);

  out = out.replace(/^import\s*['"]([^'"]+)['"];?[ \t]*$/gm, (_m, spec) => `${toRequire(spec, file)};`);

  // 带 from 的具名再导出（本项目暂时没有，但顺手支持）
  out = out.replace(/^export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?[ \t]*$/gm, (_m, names, spec) => {
    const target = toRequire(spec, file);
    return names
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [original, alias] = entry.split(/\s+as\s+/).map((part) => part.trim());
        return `__exports[${JSON.stringify(alias ?? original)}] = ${target}[${JSON.stringify(original)}];`;
      })
      .join(' ');
  });

  out = out.replace(/^export\s*\*\s*from\s*['"]([^'"]+)['"];?[ \t]*$/gm, (_m, spec) => `Object.assign(__exports, ${toRequire(spec, file)});`);

  out = out.replace(/^export\s+(async\s+)?function(\s*\*)?\s+([A-Za-z0-9_$]+)/gm, (_m, asyncKw, star, name) => {
    exported.add(name);
    return `${asyncKw ? 'async ' : ''}function${star ? '*' : ''} ${name}`;
  });

  out = out.replace(/^export\s+(const|let|var)\s+([A-Za-z0-9_$]+)/gm, (_m, kind, name) => {
    exported.add(name);
    return `${kind} ${name}`;
  });

  out = out.replace(/^export\s+class\s+([A-Za-z0-9_$]+)/gm, (_m, name) => {
    exported.add(name);
    return `class ${name}`;
  });

  out = out.replace(/^export\s*\{([^}]*)\};?[ \t]*$/gm, (_m, names) =>
    names
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [original, alias] = entry.split(/\s+as\s+/).map((part) => part.trim());
        return `__exports[${JSON.stringify(alias ?? original)}] = ${original};`;
      })
      .join(' '),
  );

  if (/^export\s+default\s+/m.test(out)) {
    out = out.replace(/^export\s+default\s+/m, '__exports.default = ');
  }

  const registry = [...exported].map((name) => `__exports[${JSON.stringify(name)}] = ${name};`).join(' ');
  const leftover = out.match(/^export\s+[^\n]*/m);
  if (leftover) {
    throw new Error(`打包器不认识这种导出语法（${file}）：${leftover[0].trim()}`);
  }
  return { code: out, registry, exported: [...exported] };
}

/** 从入口开始递归收集本地模块（只收 core/ 与 server/ 下的）。 */
export function collectModules(entryId) {
  const modules = new Map();
  const queue = [entryId];
  while (queue.length) {
    const id = queue.shift();
    if (modules.has(id)) continue;
    const file = path.join(ROOT, id);
    const source = readFileSync(file, 'utf8');
    modules.set(id, source);
    const specs = [...source.matchAll(/from\s+['"](\.[^'"]+)['"]|import\s*\(\s*['"](\.[^'"]+)['"]\s*\)|import\s+['"](\.[^'"]+)['"]/g)];
    for (const match of specs) {
      const spec = match[1] ?? match[2] ?? match[3];
      const local = resolveLocal(spec, file);
      if (local && !modules.has(local)) queue.push(local);
    }
  }
  return modules;
}

export function buildBundle({ entry = 'server/index.mjs', out = 'build/silver-tavern.cjs' } = {}) {
  const entryId = toId(path.resolve(ROOT, entry));
  const modules = collectModules(entryId);
  const parts = [];
  parts.push("#!/usr/bin/env node");
  parts.push("'use strict';");
  parts.push('// 由 scripts/bundle.mjs 生成：core/ + server/ 合成一个 CommonJS 文件。不要手改。');
  parts.push('const __path = require("node:path");');
  parts.push('const __url = require("node:url");');
  parts.push('const __metaUrl = __url.pathToFileURL(typeof __filename === "string" ? __filename : process.execPath).href;');
  parts.push('const __defs = Object.create(null);');
  parts.push('const __cache = Object.create(null);');
  parts.push('function __define(id, factory) { __defs[id] = factory; }');
  parts.push('function __req(id) {');
  parts.push('  if (__cache[id]) return __cache[id].exports;');
  parts.push('  const mod = { exports: {} };');
  parts.push('  __cache[id] = mod;');
  parts.push('  if (!__defs[id]) throw new Error("模块没打进包里：" + id);');
  parts.push('  __defs[id](mod.exports, __req, mod);');
  parts.push('  return mod.exports;');
  parts.push('}');

  for (const [id, source] of modules) {
    const { code, registry } = transformModule(source, path.join(ROOT, id));
    parts.push(`__define(${JSON.stringify(id)}, function (__exports, __req, __module) {`);
    parts.push(code);
    if (registry) parts.push(registry);
    parts.push('});');
  }

  parts.push(`const __entry = __req(${JSON.stringify(entryId)});`);
  parts.push('if (typeof __entry.runCli === "function" && !process.env.TAVERN_BUNDLE_NO_AUTORUN) {');
  parts.push('  void Promise.resolve(__entry.runCli()).catch((err) => { console.error("启动失败：", err); process.exitCode = 1; });');
  parts.push('}');
  parts.push('module.exports = __entry;');

  const code = `${parts.join('\n')}\n`;
  const target = path.resolve(ROOT, out);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, code);
  return { out: target, bytes: Buffer.byteLength(code), modules: modules.size };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const valueOf = (flag, fallback) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const result = buildBundle({ entry: valueOf('--entry', 'server/index.mjs'), out: valueOf('--out', 'build/silver-tavern.cjs') });
  console.log(`已打包 ${result.modules} 个模块 → ${result.out}（${(result.bytes / 1024).toFixed(0)} KB）`);
}
