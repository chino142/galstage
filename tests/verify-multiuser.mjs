/**
 * 手动验证多用户模式（docs/MULTI-USER.md 文末的 7 条清单）。
 * 用 fetch + 手动 cookie 跑，不依赖浏览器。跑法：
 *   node work/verify-multiuser.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const { startMultiUser } = await import('../server/index.mjs');

const silent = { setLevel() {}, error() {}, warn() {}, info() {}, debug() {} };

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok, extra });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
}

function jar() {
  const jar = new Map();
  return {
    header() {
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    store(response) {
      const raw = response.headers.getSetCookie?.() ?? [];
      for (const line of raw) {
        const [pair] = line.split(';');
        const index = pair.indexOf('=');
        if (index <= 0) continue;
        jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
      }
    },
    clear() {
      jar.clear();
    },
  };
}

async function call(base, jar, method, path, body, raw = false) {
  const headers = {};
  if (jar) {
    const cookie = jar.header();
    if (cookie) headers.Cookie = cookie;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  jar?.store(response);
  if (raw) return { status: response.status, response, buffer: Buffer.from(await response.arrayBuffer()) };
  let payload = null;
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('json')) payload = await response.json().catch(() => null);
  else payload = await response.text().catch(() => null);
  return { status: response.status, payload, response };
}

const tmp = mkdtempSync(path.join(root, 'work', 'tmp', 'mu-'));
let tavern = null;
try {
  tavern = await startMultiUser({ dataDir: tmp, port: 0, logger: silent });
  const base = tavern.url;
  console.log(`[verify] 多用户服务：${base}（数据目录 ${tmp}）\n`);

  // 1. 首页 / 状态 → 首次建号
  const admin = jar();
  let r = await call(base, admin, 'GET', '/api/auth/status');
  check('1. 未登录时 /api/auth/status 说 setupRequired', r.status === 200 && r.payload.multiUser === true && r.payload.setupRequired === true && r.payload.authenticated === false, JSON.stringify(r.payload));

  const unauth = jar();
  r = await call(base, unauth, 'GET', '/api/chats');
  check('1b. 未登录访问业务接口 → 401', r.status === 401 && r.payload?.error?.code === 'UNAUTHORIZED');

  r = await call(base, unauth, 'GET', '/');
  check('1c. 未登录也能拿到前端壳（静态文件）', r.status === 200 && String(r.payload).includes('<div id="app"'));

  // 2. 建管理员
  r = await call(base, admin, 'POST', '/api/auth/setup', { name: 'boss', password: 'boss-password' });
  check('2. 建管理员账号 → 201 + role=admin', r.status === 201 && r.payload?.user?.name === 'boss' && r.payload?.user?.role === 'admin', JSON.stringify(r.payload?.error ?? ''));
  r = await call(base, admin, 'GET', '/api/app');
  const modules = (r.payload?.modules ?? []).map((m) => m.id);
  check('2b. 管理员 /api/app 有 hostMode + 主机管理模块', r.status === 200 && r.payload.hostMode === true && r.payload.auth?.user?.name === 'boss' && modules.includes('host'), `modules=${modules.length}`);
  check('2c. /api/auth/status 已登录（带 hostRoot）', (await call(base, admin, 'GET', '/api/auth/status')).payload.authenticated === true);

  // 3. 错口令 → 401；管理员加 alice / bob
  const wrong = jar();
  r = await call(base, wrong, 'POST', '/api/auth/login', { name: 'boss', password: 'nope-nope-nope' });
  check('3. 错口令 → 401 BAD_CREDENTIALS', r.status === 401 && r.payload?.error?.code === 'BAD_CREDENTIALS');
  const ghost = jar();
  r = await call(base, ghost, 'POST', '/api/auth/login', { name: 'ghost', password: 'whatever-123' });
  check('3b. 不存在的账号也回同样的 401', r.status === 401 && r.payload?.error?.code === 'BAD_CREDENTIALS');

  r = await call(base, admin, 'POST', '/api/host/users', { name: 'alice', password: 'alice-pass-1', role: 'user' });
  check('3c. 管理员加 alice → 201', r.status === 201 && r.payload?.name === 'alice' && r.payload.role === 'user');
  r = await call(base, admin, 'POST', '/api/host/users', { name: 'bob', password: 'bob-pass-123', role: 'user' });
  check('3d. 管理员加 bob → 201', r.status === 201 && r.payload?.name === 'bob');

  // 4. alice / bob 各自登录，各建对话
  const alice = jar();
  const bob = jar();
  r = await call(base, alice, 'POST', '/api/auth/login', { name: 'alice', password: 'alice-pass-1' });
  check('4. alice 登录 → 200', r.status === 200 && r.payload?.user?.name === 'alice');
  r = await call(base, bob, 'POST', '/api/auth/login', { name: 'bob', password: 'bob-pass-123' });
  check('4b. bob 登录 → 200', r.status === 200 && r.payload?.user?.name === 'bob');

  r = await call(base, alice, 'POST', '/api/chats', { title: 'alice 的对话' });
  check('4c. alice 建对话 → 201', r.status === 201 && r.payload?.id, JSON.stringify(r.payload?.error ?? ''));
  r = await call(base, alice, 'GET', '/api/chats');
  const aliceChats = (r.payload?.items ?? r.payload ?? []).length;
  check('4d. alice 列出自己的对话 = 1', aliceChats === 1, `items=${aliceChats}`);
  r = await call(base, bob, 'GET', '/api/chats');
  const bobChats = (r.payload?.items ?? r.payload ?? []).length;
  check('4e. bob 列出对话 = 0（互相看不见）', bobChats === 0, `items=${bobChats}`);

  // 5. 非管理员访问 /api/host/*
  r = await call(base, alice, 'GET', '/api/host/info');
  check('5. alice 访问 /api/host/info → 403', r.status === 403 && r.payload?.error?.code === 'FORBIDDEN');
  r = await call(base, alice, 'POST', '/api/host/users', { name: 'mallory', password: 'mallory-123' });
  check('5b. alice 建账号 → 403', r.status === 403);
  r = await call(base, alice, 'DELETE', '/api/host/users/bob', { confirm: true });
  check('5c. alice 删 bob → 403', r.status === 403);
  r = await call(base, null, 'GET', '/api/host/info');
  check('5d. 未登录访问 /api/host/info → 401', r.status === 401);

  // 6. 停用 → 会话失效；启用后能再登录
  r = await call(base, admin, 'GET', '/api/host/info');
  check('6. 管理员 /api/host/info → 200', r.status === 200 && Array.isArray(r.payload?.accounts) && r.payload.accounts.length === 3, `accounts=${r.payload?.accounts?.length}`);
  r = await call(base, admin, 'PATCH', '/api/host/users/alice', { disabled: true });
  check('6b. 停用 alice → 200', r.status === 200 && r.payload?.disabled === true);
  r = await call(base, alice, 'GET', '/api/app');
  check('6c. 停用后 alice 的会话立刻失效 → 401', r.status === 401, `status=${r.status}`);
  const aliceLogin = await call(base, jar(), 'POST', '/api/auth/login', { name: 'alice', password: 'alice-pass-1' });
  check('6d. 停用账号登录 → 403 ACCOUNT_DISABLED', aliceLogin.status === 403 && aliceLogin.payload?.error?.code === 'ACCOUNT_DISABLED');
  r = await call(base, admin, 'PATCH', '/api/host/users/alice', { disabled: false });
  check('6e. 启用 alice → 200', r.status === 200 && r.payload?.disabled === false);
  const alice2 = jar();
  r = await call(base, alice2, 'POST', '/api/auth/login', { name: 'alice', password: 'alice-pass-1' });
  check('6f. 启用后能再登录', r.status === 200);
  r = await call(base, alice2, 'GET', '/api/chats');
  check('6g. 重新登录后还能看到自己的对话', (r.payload?.items ?? []).length === 1);

  // 7. 加密导出再导入
  r = await call(base, alice2, 'POST', '/api/maintenance/export-encrypted', { passphrase: 'alice-export-1' }, true);
  const stbk = r.buffer;
  check('7. 加密导出 → 200 + STBK1 文件头', r.status === 200 && stbk.subarray(0, 5).toString('ascii') === 'STBK1', `${stbk.length} bytes`);
  r = await call(base, alice2, 'POST', '/api/maintenance/export-encrypted', { passphrase: 'short' }, true);
  check('7b. 口令太短 → 400', r.status === 400, `status=${r.status}`);

  r = await call(base, bob, 'POST', '/api/maintenance/import-encrypted', { passphrase: 'wrong-pass-1', data: stbk.toString('base64') });
  check('7c. 错口令导入 → 400', r.status === 400, `status=${r.status} ${JSON.stringify(r.payload)}`);
  r = await call(base, bob, 'POST', '/api/maintenance/import-encrypted', { passphrase: 'alice-export-1', data: stbk.toString('base64') });
  check('7d. 用正确口令导入 → 200 + 恢复', r.status === 200 && r.payload?.imported, JSON.stringify(r.payload ?? ''));
  r = await call(base, bob, 'GET', '/api/chats');
  check('7e. 导入后 bob 拿到 alice 那份对话', (r.payload?.items ?? []).length === 1, `items=${(r.payload?.items ?? []).length}`);

  // 8. 租户目录隔离
  check('8. tenants/alice/tavern.db 与 tenants/bob/tavern.db 各一份', existsSync(path.join(tmp, 'tenants', 'alice', 'tavern.db')) && existsSync(path.join(tmp, 'tenants', 'bob', 'tavern.db')));
  check('8b. 账号表只有哈希（没有明文口令）', !readFileSync(path.join(tmp, 'accounts.json'), 'utf8').includes('alice-pass-1'));

  // 9. 登录限速（放最后，别影响上面的用例）
  const throttleJar = jar();
  let sawThrottle = false;
  for (let i = 0; i < 12; i += 1) {
    const attempt = await call(base, throttleJar, 'POST', '/api/auth/login', { name: 'boss', password: `wrong-${i}-password` });
    if (attempt.status === 429) {
      sawThrottle = true;
      break;
    }
  }
  check('9. 连错十次后触发限速 429', sawThrottle);

  // 10. 删账号（先确认，再带 confirm）；不 purge 时目录要留着
  r = await call(base, admin, 'DELETE', '/api/host/users/bob', {});
  check('10. 删账号没带 confirm → 需要确认', r.status === 200 && r.payload?.needConfirm === true);
  r = await call(base, admin, 'DELETE', '/api/host/users/bob', { confirm: true });
  check('10b. 确认删账号（不 purge）→ 目录保留', r.status === 200 && r.payload?.purged === false && existsSync(path.join(tmp, 'tenants', 'bob')));
  r = await call(base, admin, 'DELETE', '/api/host/users/bob', { confirm: true });
  check('10c. 再删一次 → 404', r.status === 404);
} finally {
  if (tavern) await tavern.close();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // 临时目录清不掉就算了
  }
}

const failed = results.filter((item) => !item.ok);
console.log(`\n多用户手动验证：${results.length - failed.length} 通过 / ${failed.length} 失败（共 ${results.length}）`);
if (failed.length) process.exitCode = 1;
