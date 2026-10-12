// 草稿区：打包出来的 exe 冒烟（不是交付物）。用法：node work/verify-exe.mjs <exe路径>
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const exe = path.resolve(process.argv[2] ?? 'work/tmp/exebuild/silver-tavern.exe');
const dataDir = path.resolve('work/tmp/exedata-verify');
mkdirSync(dataDir, { recursive: true });

const child = spawn(exe, [], {
  env: { ...process.env, TAVERN_PORT: '0', TAVERN_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
let err = '';
child.stdout.on('data', (chunk) => { out += chunk; });
child.stderr.on('data', (chunk) => { err += chunk; });

let port = null;
for (let i = 0; i < 40 && !port; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  const match = out.match(/127\.0\.0\.1:(\d+)/);
  if (match) port = match[1];
}
console.log('port:', port);
if (port) {
  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  console.log('health:', JSON.stringify(health));
  const js = await fetch(`http://127.0.0.1:${port}/app.js`);
  const body = await js.text();
  console.log('/app.js:', js.status, js.headers.get('content-type'), body.length, 'bytes');
  const index = await fetch(`http://127.0.0.1:${port}/`);
  console.log('/:', index.status, (await index.text()).length, 'bytes');
  const plugins = await (await fetch(`http://127.0.0.1:${port}/api/plugins`)).json();
  console.log('/api/plugins items:', plugins.items.length);
}
console.log('stderr head:', err.slice(0, 300));
child.kill('SIGKILL');
setTimeout(() => process.exit(port ? 0 : 1), 300);
