/**
 * HTTP 端到端测试。
 * 自己起一个临时服务 + 临时数据目录，不碰真实数据。跑法：node tests/api-test.mjs
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createHarness } from './harness.mjs';
import { createMockComfy } from './fixtures/mock-comfy-server.mjs';
import { createZip, readZip } from '../server/toolbox/zip.mjs';
import { startMultiUser, startTavern } from '../server/index.mjs';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, setLevel() {} };
const dataDir = mkdtempSync(path.join(tmpdir(), 'tavern-api-'));

// 插件（蓝图 3.2）：把示例插件放进数据目录，验证启动时加载；坏插件不能拖垮服务。
const pluginFixtures = path.join(process.cwd(), 'tests', 'fixtures', 'plugins');
mkdirSync(path.join(dataDir, 'plugins'), { recursive: true });
cpSync(path.join(pluginFixtures, 'hello'), path.join(dataDir, 'plugins', 'hello'), { recursive: true });
cpSync(path.join(pluginFixtures, 'broken'), path.join(dataDir, 'plugins', 'broken'), { recursive: true });

const tavern = await startTavern({ port: 0, host: '127.0.0.1', dataDir, logger: silentLogger });
const base = `http://127.0.0.1:${tavern.address.port}`;

/**
 * 本地假模型服务：说 OpenAI 方言，用来验证适配层。
 * 只实现 /v1/models 与 /v1/chat/completions（流式），不联网。
 */
/** 1×1 的透明 PNG，给「资源本地化」当抓取目标用。 */
const MOCK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const mockModel = http.createServer(async (req, res) => {
  const url = req.url ?? '';
  if (url.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'mock-small' }, { id: 'mock-large' }] }));
    return;
  }
  if (url.includes('/chat/completions')) {
    mockModel.lastRequest = { url, headers: req.headers, bodyText: '' };
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    mockModel.lastRequest.bodyText = bodyText;

    // 非流式（整段返回）：提供方参数选了 streamMode=full 时走这条
    if (/"stream"\s*:\s*false/.test(bodyText)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '整段返回的正文', reasoning_content: '整段返回的思考' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
        }),
      );
      return;
    }

    // 思维链：提示词里带 THINKING_TEST 时先吐 reasoning_content 再吐正文
    // 函数调用（工具）：两套。consume 模式一次到位；普通模式要回填工具结果再生成一轮。
    if (bodyText.includes('TOOL_CONSUME_TEST')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'game_content', arguments: '' } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"content":' } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"消耗模式正文。"}' } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (bodyText.includes('TOOL_RECURSE_TEST')) {
      const hasToolResult = /"role"\s*:\s*"tool"/.test(bodyText);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (!hasToolResult) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', type: 'function', function: { name: 'dice_roll', arguments: '{"sides":6}' } }] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '工具结果收到' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '了。' } }] })}\n\n`);
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } })}\n\n`,
        );
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (bodyText.includes('THINKING_TEST')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '先想一下' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '想好了。' } }] })}\n\n`);
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // 按提示词类型回不同内容，让各条链路都能断言：
    //   带 ```state 的（玩卡区生成）→ 正文 + 状态块
    //   带 ```options 的（候选行动）→ 选项数组
    //   其它带 JSON 的（写卡技能）→ 一张卡 JSON
    //   剩下的是连通性测试 → pong
    // 创作辅助技能按系统提示词里的标记回对应形状的 JSON
    const creative = bodyText.includes('小说章节编辑')
      ? ['{"title":"雪夜的第一章","chapters":[{"heading":"","text":"雪落下来。"}],"text":"雪落下来。\\n\\n她抬起头。","notes":""}']
      : bodyText.includes('剧本策划')
        ? ['{"title":"雪夜剧本","logline":"一场雪夜里的相遇","worldbook":[{"comment":"旧书馆","keys":["旧书馆"],"content":"藏书的地方，二楼有不对外开放的旧刊。"}],"scenes":[{"act":"第一幕","scene":"旧书馆","goal":"相遇","beats":["推门"]}],"script":"第一幕\\n旧书馆，雪夜。"}']
        : bodyText.includes('素材抽取')
          ? ['{"characters":[{"name":"阿狸","aliases":["小狸"],"keys":["阿狸"],"description":"住在旧书馆的狐妖。"}],"places":[{"name":"旧书馆","keys":["旧书馆"],"description":"藏书的地方。"}],"items":[],"relations":[]}']
          : null;
    const pieces = creative ?? (bodyText.includes('IMG_MARKER_TEST')
      ? ['她抬起头看你，眼睛亮了一下。', '\n[IMG: portrait: 白狐，雪夜]']
      : bodyText.includes('```state')
      ? ['她点了点头。', '\n```state\n{"affection":{"阿狸":2}}\n```']
      : bodyText.includes('```options')
        ? ['["追问她","观察四周","回房间"]']
        : bodyText.includes('JSON')
          ? ['{"name":"琥珀","description":"测试角色","tags":["猫娘"]}']
          : ['p', 'o', 'n', 'g']);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const piece of pieces) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    }
    res.write(
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        // prompt_tokens_details.cached_tokens 用来验证适配层把缓存字段透传下来了
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7, prompt_tokens_details: { cached_tokens: 2 } },
      })}\n\n`,
    );
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  // Vertex 的 Gemini 形态：路径不同，SSE 载荷也不同
  if (url.includes(':streamGenerateContent')) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    mockModel.lastRequest = { url, headers: req.headers, bodyText: Buffer.concat(chunks).toString('utf8') };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'po' }] } }] })}\n\n`);
    res.write(
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ng' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2, totalTokenCount: 4 } })}\n\n`,
    );
    res.end();
    return;
  }
  // 卡内前端「资源本地化」要抓的图：给三种响应——正常 png、回 octet-stream 的 png、404
  if (url.startsWith('/img/')) {
    if (url.includes('missing')) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': url.includes('octet') ? 'application/octet-stream' : 'image/png' });
    res.end(MOCK_PNG);
    return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => mockModel.listen(0, '127.0.0.1', resolve));
const mockBase = `http://127.0.0.1:${mockModel.address().port}/v1`;

/** 假的 ComfyUI（HTTP + WebSocket），工具箱端到端测试用。 */
const mockComfy = createMockComfy({ latencyMs: 900 });
await mockComfy.listen();

const { test, run } = createHarness('HTTP 端到端测试');

async function call(pathname, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const response = await fetch(base + pathname, {
    method,
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = response.headers.get('content-type') ?? '';
  const payload = raw ? await response.text() : type.includes('json') ? await response.json() : await response.text();
  return { status: response.status, headers: response.headers, type, body: payload };
}

/** 同上，但打到一个显式的 origin —— 主服务被别的用例 stop() 掉之后自己起一个时用。 */
async function callOn(origin, pathname, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(origin + pathname, {
    method,
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = response.headers.get('content-type') ?? '';
  const payload = type.includes('json') ? await response.json() : await response.text();
  return { status: response.status, headers: response.headers, type, body: payload };
}

/** POST + 解析 SSE，返回事件列表；测试生成类接口用。 */
async function streamCall(pathname, body = {}) {
  const response = await fetch(base + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const events = [];
  for (const frame of text.split('\n\n')) {
    let event = 'message';
    const dataLines = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) continue;
    try {
      events.push({ event, data: JSON.parse(dataLines.join('\n')) });
    } catch {
      events.push({ event, data: { text: dataLines.join('\n') } });
    }
  }
  return { status: response.status, events };
}

// ---------- 系统 ----------

test('GET /api/health', async () => {
  const res = await call('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.schemaVersion, tavern.db.latestSchemaVersion);
  assert.ok(res.body.modules > 15);
});

test('GET /api/app 返回模块地图与设置', async () => {
  const res = await call('/api/app');
  assert.equal(res.status, 200);
  assert.equal(res.body.areas.length, 5);
  assert.ok(res.body.areas.some((area) => area.id === 'galgame'), 'Galgame 板块要在导航里');
  assert.ok(res.body.modules.length > 15);
  assert.equal(res.body.settings['ui.theme'], 'system');
  assert.ok(res.body.settingsSchema.length >= 8);
  assert.equal(res.body.providerKinds.length, 5);
  const cards = res.body.modules.find((mod) => mod.id === 'cards');
  assert.equal(cards.area, 'writing');
  assert.ok(cards.plan.length > 3);
});

test('GET /api/routes 列出了全部接口', async () => {
  const res = await call('/api/routes');
  assert.equal(res.status, 200);
  assert.ok(res.body.total > 60, `接口数偏少：${res.body.total}`);
  assert.ok(res.body.items.some((item) => item.pattern === '/api/characters'));
});

// ---------- 设置 ----------

test('设置的读、写与校验', async () => {
  const initial = await call('/api/settings');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.settings['ui.theme'], 'system');

  const saved = await call('/api/settings', { method: 'PUT', body: { 'ui.theme': 'dark', 'ui.fontScale': 1.2 } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.settings['ui.theme'], 'dark');

  const reread = await call('/api/settings');
  assert.equal(reread.body.settings['ui.fontScale'], 1.2);

  const bad = await call('/api/settings', { method: 'PUT', body: { 'ui.theme': 'neon' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'VALIDATION_ERROR');
  assert.match(bad.body.error.message, /ui\.theme/);

  const schema = await call('/api/settings/schema');
  assert.equal(schema.status, 200);
  assert.equal(schema.body.items.length, initial.body.settings ? schema.body.items.length : 0);

  // 使用体验（蓝图 3.2）：护眼主题、通知开关、可自定义快捷键都要是正式的设置项
  assert.ok(schema.body.items.find((item) => item.key === 'ui.theme').options.includes('sepia'), '主题要有护眼模式');
  assert.equal(initial.body.settings['ui.notifySound'], false);
  assert.equal(initial.body.settings['ui.notifyBrowser'], false);
  for (const key of ['send', 'continue', 'regenerate', 'switchCharacter', 'search']) {
    assert.ok(schema.body.items.some((item) => item.key === `ui.shortcut.${key}`), `缺快捷键设置：${key}`);
  }
  const shortcuts = await call('/api/settings', {
    method: 'PUT',
    body: { 'ui.theme': 'sepia', 'ui.notifySound': true, 'ui.shortcut.send': 'Ctrl+Enter' },
  });
  assert.equal(shortcuts.status, 200);
  assert.equal(shortcuts.body.settings['ui.theme'], 'sepia');
  assert.equal(shortcuts.body.settings['ui.notifySound'], true);
  assert.equal(shortcuts.body.settings['ui.shortcut.send'], 'Ctrl+Enter');
  await call('/api/settings', { method: 'PUT', body: { 'ui.theme': 'system', 'ui.notifySound': false, 'ui.shortcut.send': 'Enter' } });
});

// ---------- 角色卡 ----------

test('角色卡：列表为空、字段表可用、未知 id 404', async () => {
  const list = await call('/api/characters');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body, { items: [], total: 0 });

  const stats = await call('/api/characters/stats');
  assert.equal(stats.body.total, 0);

  const fields = await call('/api/characters/fields');
  assert.equal(fields.status, 200);
  assert.ok(fields.body.items.length >= 15);
  assert.ok(fields.body.groups.length >= 5);
  assert.ok(fields.body.items.some((field) => field.key === 'first_mes'));

  const missing = await call('/api/characters/does-not-exist');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');
});

test('角色卡：建卡 / 读 / 改 / 收藏 / 搜索 / 标签 / 删除（JSON）', async () => {
  const created = await call('/api/characters', {
    method: 'POST',
    body: { name: '测试猫', description: '一只猫', tags: ['猫', '测试', '猫'], favorite: true },
  });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal(created.body.name, '测试猫');
  assert.equal(created.body.data.description, '一只猫');
  assert.deepEqual(created.body.tags, ['猫', '测试'], '重复标签要去掉');
  assert.equal(created.body.favorite, true);
  assert.equal(created.body.versionCount, 1);

  assert.equal((await call(`/api/characters/${id}`)).body.data.name, '测试猫');
  assert.equal((await call(`/api/characters?q=${encodeURIComponent('测试猫')}`)).body.total, 1);
  assert.equal((await call(`/api/characters?q=${encodeURIComponent('不存在')}`)).body.total, 0);
  assert.equal((await call(`/api/characters?tag=${encodeURIComponent('猫')}`)).body.total, 1);
  assert.equal((await call('/api/characters?favorite=true')).body.total, 1);
  assert.equal((await call('/api/characters?favorite=false')).body.total, 0);

  const updated = await call(`/api/characters/${id}`, { method: 'PUT', body: { description: '改过了', note: '改简介' } });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.description, '改过了');
  assert.equal(updated.body.data.name, '测试猫', '只改一个字段不能把别的改没');
  assert.equal(updated.body.versionCount, 2);

  const versions = await call(`/api/characters/${id}/versions`);
  assert.equal(versions.body.total, 2);
  const firstVersion = versions.body.items.find((version) => version.note === '创建');
  const restored = await call(`/api/characters/${id}/versions/${firstVersion.id}/restore`, { method: 'POST' });
  assert.equal(restored.body.data.description, '一只猫');

  assert.equal((await call('/api/characters/does-not-exist')).status, 404);
  assert.equal((await call(`/api/characters/${id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await call(`/api/characters/${id}`)).status, 404);
});

test('角色卡：导入 PNG（原始字节 + base64 两条路径）、解析预览、导出 PNG/JSON', async () => {
  const png = readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'card-amber.png'));

  // 界面批量导入走的是 JSON + base64 这条路径
  const batch = await call('/api/characters/import', {
    method: 'POST',
    body: { files: [{ name: 'card-amber.png', dataBase64: png.toString('base64') }] },
  });
  assert.equal(batch.status, 201);
  assert.equal(batch.body.imported, 1);
  const card = batch.body.items[0];
  assert.equal(card.name, '琥珀');
  assert.equal(card.data.x_fixture_note, '未知字段应当被原样保留');
  assert.equal(card.data.character_book.entries.length, 1);
  assert.deepEqual(card.tags, ['狐狸', '书店']);

  // 原始字节那条路径也要能用（拖一个 PNG 进来）
  const rawImport = await fetch(`${base}/api/characters/import?name=card-amber.png`, { method: 'POST', body: png });
  assert.equal(rawImport.status, 201);
  assert.equal((await rawImport.json()).imported, 1);

  // 解析预览：不落库，只看看这张卡长什么样
  const preview = await call('/api/characters/parse', {
    method: 'POST',
    body: { name: 'card-amber.png', dataBase64: png.toString('base64') },
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.data.name, '琥珀');
  assert.equal(preview.body.hasImage, true);

  // 坏文件逐条报错，不让整批请求失败
  const bad = await call('/api/characters/import', {
    method: 'POST',
    body: { files: [{ name: 'bad.txt', dataBase64: Buffer.from('不是卡').toString('base64') }] },
  });
  assert.equal(bad.status, 201, '单个坏文件不该让整批请求失败');
  assert.equal(bad.body.imported, 0);
  assert.equal(bad.body.skipped, 1);

  // 导出 PNG：能被重新解析回来
  const pngOut = await fetch(`${base}/api/characters/${card.id}/export?format=png`);
  assert.equal(pngOut.status, 200);
  assert.match(pngOut.headers.get('content-type'), /image\/png/);
  const pngBytes = Buffer.from(await pngOut.arrayBuffer());
  assert.ok(pngBytes.length > 100);

  const jsonOut = await call(`/api/characters/${card.id}/export?format=json`, { raw: true });
  const doc = JSON.parse(jsonOut.body);
  assert.equal(doc.data.name, '琥珀');
  assert.equal(doc.data.x_fixture_note, '未知字段应当被原样保留', '导出不能丢未知字段');
  assert.equal(doc.data.character_book.entries.length, 1);

  assert.equal((await call('/api/characters/nope/export')).status, 404);
});

test('玩卡区：从卡库选卡开演（characterId 自动带卡快照与开场白）', async () => {
  const card = await call('/api/characters', {
    method: 'POST',
    body: { name: '琥珀', description: '守书店的狐狸', first_mes: '「书页潮了。」', alternate_greetings: ['雨还在下。'] },
  });
  const id = card.body.id;

  const created = await call('/api/chats', { method: 'POST', body: { characterId: id } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.characterId, id);
  assert.equal(created.body.members.length, 1);
  assert.equal(created.body.members[0].characterId, id);
  assert.equal(created.body.members[0].card.description, '守书店的狐狸', '卡数据要以快照的形式进对话');

  const messages = await call(`/api/chats/${created.body.id}/messages`);
  assert.equal(messages.body.items.length, 1);
  assert.equal(messages.body.items[0].role, 'assistant');
  assert.ok(['「书页潮了。」', '雨还在下。'].includes(messages.body.items[0].content), '开场白要自动变成第一条消息');

  // 群聊：先建一个只带一张卡库卡的空群，再往里加卡库成员
  const group = await call('/api/chats', { method: 'POST', body: { isGroup: true, greetings: false, members: [{ characterId: id }] } });
  assert.equal(group.status, 201, JSON.stringify(group.body));
  assert.equal(group.body.isGroup, true);
  assert.equal(group.body.members.length, 1);
  const added = await call(`/api/group/${group.body.id}/members`, { method: 'POST', body: { characterId: id, talkativeness: 0.7 } });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body.card.description, '守书店的狐狸');
  assert.equal(added.body.talkativeness, 0.7);

  // 不存在的卡要 404，而不是静默建一个空对话
  assert.equal((await call('/api/chats', { method: 'POST', body: { characterId: 'char_nope' } })).status, 404);

  await call(`/api/chats/${created.body.id}`, { method: 'DELETE' });
  await call(`/api/chats/${group.body.id}`, { method: 'DELETE' });
  await call(`/api/characters/${id}`, { method: 'DELETE' });
});

test('一张卡多个对话：按卡筛对话、卡上带对话计数（群聊不算）', async () => {
  const card = await call('/api/characters', { method: 'POST', body: { name: '多话', description: '同一张卡开好几个对话' } });
  const id = card.body.id;
  const chatIds = [];
  for (const title of ['第一夜', '第二夜', '第三夜']) {
    const created = await call('/api/chats', { method: 'POST', body: { characterId: id, title } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    chatIds.push(created.body.id);
  }
  // 群聊也可能挂着这张卡（现实数据里就有），但它不该算进"这张卡的对话"
  const group = await call('/api/chats', { method: 'POST', body: { isGroup: true, characterId: id, greetings: false, members: [{ characterId: id }] } });
  assert.equal(group.status, 201, JSON.stringify(group.body));

  const all = await call(`/api/chats?characterId=${id}`);
  assert.equal(all.body.total, 4, '按卡筛要能一次拿到这张卡的全部对话（含群聊）');
  assert.ok(all.body.items.every((item) => item.characterId === id));

  const singles = await call(`/api/chats?characterId=${id}&group=false`);
  assert.equal(singles.body.total, 3, '配上 group=false 就只剩单聊');

  const other = await call('/api/chats?characterId=char_nope');
  assert.equal(other.body.total, 0, '别的卡不该被算进来');

  const one = await call(`/api/characters/${id}`);
  assert.equal(one.body.chatCount, 3, '卡上带单聊对话数（群聊不算）');
  const listed = await call('/api/characters?q=多话');
  assert.equal(listed.body.items[0].chatCount, 3, '卡库列表也要带这个计数');

  for (const chatId of [...chatIds, group.body.id]) await call(`/api/chats/${chatId}`, { method: 'DELETE' });
  await call(`/api/characters/${id}`, { method: 'DELETE' });
});

// ---------- 写卡区其余模块 ----------

test('世界书：建书 / 条目 CRUD / 试触发 / 形状转换 / 导入导出', async () => {
  const empty = await call('/api/worldbooks');
  assert.equal(empty.status, 200);
  assert.equal(empty.body.total, 0);

  const meta = await call('/api/worldbooks/meta');
  assert.ok(meta.body.positions.length >= 6);
  assert.equal(meta.body.logics.length, 4);
  assert.equal(meta.body.shapes.length, 2);

  // 不存在的书：试触发返回空（兼容骨架阶段的行为）
  const missingTrigger = await call('/api/worldbooks/book-1/test-trigger', { method: 'POST', body: { text: '你好' } });
  assert.deepEqual(missingTrigger.body, { entries: [], reasons: [], scanned: 0 });

  const tavernDoc = {
    name: '书店',
    entries: { 0: { uid: 0, key: ['书店'], comment: '书店', content: '书店在东街尽头。', order: 10, x_unknown: 'keep' } },
  };
  const created = await call('/api/worldbooks', { method: 'POST', body: { name: '书店', data: tavernDoc } });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal(created.body.spec, 'tavern');
  assert.equal((await call('/api/worldbooks')).body.total, 1);

  const entries = await call(`/api/worldbooks/${id}/entries`);
  assert.equal(entries.body.total, 1);
  assert.deepEqual(entries.body.items[0].keys, ['书店']);
  assert.equal(entries.body.items[0].x_unknown, 'keep', '未知字段要跟着条目走');

  const added = await call(`/api/worldbooks/${id}/entries`, { method: 'POST', body: { keys: ['雪'], content: '下雪', comment: '雪' } });
  assert.equal(added.status, 201);
  assert.equal(added.body.uid, 1);

  const updated = await call(`/api/worldbooks/${id}/entries/1`, { method: 'PUT', body: { content: '下大雪', keys: ['雪'] } });
  assert.equal(updated.body.content, '下大雪');

  const trigger = await call(`/api/worldbooks/${id}/test-trigger`, { method: 'POST', body: { text: '我在书店里' } });
  assert.equal(trigger.body.scanned, 2);
  assert.ok(trigger.body.entries.some((entry) => entry.content.includes('书店在东街尽头')));
  assert.ok(trigger.body.reasons.some((reason) => reason.activated === false && reason.detail));

  const convert = await call('/api/worldbooks/convert', { method: 'POST', body: { document: tavernDoc, shape: 'card' } });
  assert.equal(convert.body.shape, 'card');
  assert.equal(convert.body.sourceShape, 'tavern');
  assert.ok(Array.isArray(convert.body.document.entries));

  const exported = await call(`/api/worldbooks/${id}/export?shape=card`, { raw: true });
  const exportedDoc = JSON.parse(exported.body);
  assert.equal(exportedDoc.entries[0].x_unknown, 'keep');
  assert.equal(exportedDoc.entries[0].insertion_order, 10);

  // 导入：原始 JSON 字节与 JSON body 两条路径都要能用
  const rawImport = await fetch(`${base}/api/worldbooks/import?name=raw-book`, { method: 'POST', body: JSON.stringify(tavernDoc) });
  assert.equal(rawImport.status, 201);
  const bodyImport = await call('/api/worldbooks/import', { method: 'POST', body: { files: [{ name: 'body-book.json', text: JSON.stringify(tavernDoc) }] } });
  assert.equal(bodyImport.status, 201);
  assert.equal(bodyImport.body.imported, 1);
  assert.equal((await call('/api/worldbooks')).body.total, 3);

  assert.equal((await call(`/api/worldbooks/${id}/entries/1`, { method: 'DELETE' })).status, 204);
  assert.equal((await call(`/api/worldbooks/${id}/entries`)).body.total, 1);
  assert.equal((await call(`/api/worldbooks/${id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await call(`/api/worldbooks/${id}`)).status, 404);
});

test('提示词：阶段管线、宏、正则、预设、X 光机踢段', async () => {
  const stages = await call('/api/prompts/stages');
  assert.equal(stages.body.items.length, 15);
  assert.equal(stages.body.items[0].id, 'global-system');

  const meta = await call('/api/prompts/meta');
  assert.equal(meta.body.stages.length, 15, '阶段表包含"预设对话内注入"');
  assert.ok(meta.body.placements.length >= 5);

  const preview = await call('/api/prompts/preview', {
    method: 'POST',
    body: {
      card: { name: '阿狸', description: '一只猫', mes_example: '<START>\n{{user}}: 在吗' },
      persona: { name: '我', description: '旅行者' },
      history: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '喵' }],
      settings: { contextBudget: 4000, authorNote: '别忘了猫会掉毛', authorNotePosition: 'before' },
    },
  });
  assert.equal(preview.status, 200);
  const ids = preview.body.sections.map((section) => section.id);
  assert.ok(ids.includes('global-system') && ids.includes('persona') && ids.includes('authors-note'));
  assert.equal(typeof preview.body.text, 'string');
  assert.ok(preview.body.tokens.total > 0);
  assert.ok(preview.body.text.includes('一只猫'));
  assert.ok(Array.isArray(preview.body.notes));

  // 段落顺序必须跟阶段表一致
  const order = ['global-system', 'character-system', 'persona', 'preset-queue', 'worldbook', 'memory', 'databank', 'authors-note', 'examples', 'history', 'preset-inline', 'prefill', 'suffix', 'stop-strings', 'post-process'];
  const indices = preview.body.sections.map((section) => order.indexOf(section.stage));
  assert.deepEqual(indices, [...indices].sort((a, b) => a - b), '段落顺序要跟着阶段表');

  // X 光机：手动踢掉一段，重新算 text 与 token
  const dropped = await call('/api/prompts/preview', { method: 'POST', body: { sections: preview.body.sections, dropSections: ['examples'], messages: [] } });
  assert.ok(!dropped.body.sections.some((section) => section.id === 'examples'));
  assert.ok(dropped.body.tokens.total < preview.body.tokens.total);
  assert.ok(dropped.body.notes.some((note) => note.includes('手动丢掉')));

  // 自定义宏
  const saved = await call('/api/prompts/macros', { method: 'POST', body: { name: '称呼', value: '阿狸' } });
  assert.equal(saved.body['称呼'], '阿狸');
  assert.ok((await call('/api/prompts/macros')).body.items.some((item) => item.name === '称呼'));
  const macroPreview = await call('/api/prompts/preview', { method: 'POST', body: { card: { name: 'x' }, settings: { systemPrompt: '你好 {{称呼}}' } } });
  assert.ok(macroPreview.body.text.includes('你好 阿狸'), '自定义宏要在组装里生效');
  await call('/api/prompts/macros/称呼', { method: 'DELETE' });

  // 正则脚本：发送前把"阿狸"换成"小狸"
  const script = await call('/api/prompts/regex', { method: 'POST', body: { name: '改名', findRegex: '/阿狸/g', replaceString: '小狸', placement: [1] } });
  assert.equal(script.status, 201);
  const regexPreview = await call('/api/prompts/preview', { method: 'POST', body: { card: { name: '阿狸' }, history: [{ role: 'user', content: '阿狸你在吗' }] } });
  assert.ok(regexPreview.body.text.includes('小狸'), '正则脚本要对用户输入生效');
  await call(`/api/prompts/regex/${script.body.id}`, { method: 'DELETE' });

  // 预设：导入酒馆格式、导出、组装时接入
  const preset = await call('/api/prompts/presets/import', {
    method: 'POST',
    body: { name: '测试预设', document: { name: '测试预设', prompts: [{ identifier: 'main', name: '主提示', role: 'system', content: '你是 {{char}}' }] } },
  });
  assert.equal(preset.status, 201);
  assert.ok((await call('/api/prompts/presets')).body.items.some((item) => item.id === preset.body.id));
  const withPreset = await call('/api/prompts/preview', { method: 'POST', body: { card: { name: '琥珀' }, presetId: preset.body.id } });
  assert.ok(withPreset.body.sections.some((section) => section.id.startsWith('preset:')));
  const exportedPreset = JSON.parse((await call(`/api/prompts/presets/${preset.body.id}/export`, { raw: true })).body);
  assert.equal(exportedPreset.prompts.length, 1);
  await call(`/api/prompts/presets/${preset.body.id}`, { method: 'DELETE' });

  // 带位置标记 + 顺序表的酒馆预设：角色描述落在开闭标签中间，历史之后的条目接在对话末尾
  const markerPreset = await call('/api/prompts/presets/import', {
    method: 'POST',
    body: {
      name: '带标记的预设',
      document: {
        name: '带标记的预设',
        prompts: [
          { identifier: 'open', name: '开标签', role: 'system', content: '<{{char}}>' },
          { identifier: 'charDescription', name: 'Char Description', role: 'system', marker: true },
          { identifier: 'close', name: '闭标签', role: 'system', content: '</{{char}}>' },
          { identifier: 'chatHistory', name: 'Chat History', role: 'system', marker: true },
          { identifier: 'tail', name: '压轴', role: 'system', content: '结尾给三个选项' },
        ],
        prompt_order: [
          {
            character_id: 100001,
            order: ['open', 'charDescription', 'close', 'chatHistory', 'tail'].map((identifier) => ({ identifier, enabled: true })),
          },
        ],
      },
    },
  });
  assert.equal(markerPreset.status, 201);
  const laidOut = await call('/api/prompts/preview', {
    method: 'POST',
    body: {
      card: { name: '琥珀', description: '一只会说话的猫' },
      history: [{ role: 'user', content: '你好' }],
      presetId: markerPreset.body.id,
    },
  });
  const laidOutIds = laidOut.body.sections.map((section) => section.id);
  assert.ok(laidOutIds.indexOf('preset:open') < laidOutIds.indexOf('card-description'), '开标签要排在角色描述前面');
  assert.ok(laidOutIds.indexOf('card-description') < laidOutIds.indexOf('preset:close'), '闭标签要包住角色描述');
  // text = 真正发出去的 system + 消息。排在历史之后的条目要出现在对话消息里（而且在历史之后），
  // 不能挤在最前面的系统提示里 —— 所以它在 text 里必须是 system: 前缀、并且晚于历史。
  assert.ok(laidOut.body.text.includes('system: 结尾给三个选项'), '历史之后的条目要以消息形式发出去');
  assert.ok(
    laidOut.body.text.indexOf('结尾给三个选项') > laidOut.body.text.indexOf('你好'),
    '排在历史之后的条目要晚于对话历史',
  );
  const tailSection = laidOut.body.sections.find((section) => section.id === 'preset:tail');
  assert.equal(tailSection.stage, 'preset-inline', '历史之后的条目要归到"预设对话内注入"');
  await call(`/api/prompts/presets/${markerPreset.body.id}`, { method: 'DELETE' });

  // 片段
  const snippet = await call('/api/prompts/snippets', { method: 'POST', body: { title: '常用尾巴', body: '不要重复上文' } });
  assert.equal(snippet.status, 201);
  assert.ok((await call('/api/prompts/snippets')).body.items.some((item) => item.title === '常用尾巴'));
  await call(`/api/prompts/snippets/${snippet.body.id}`, { method: 'DELETE' });

  const xray = await call('/api/xray');
  assert.equal(xray.status, 200);
  assert.deepEqual(xray.body.items, []);
});

test('记忆：生成小总结、读改写删、注入选择有理由', async () => {
  const layers = await call('/api/memory/layers');
  assert.deepEqual(layers.body.items.map((item) => item.id), ['small', 'large', 'profile']);

  const created = await call('/api/memory/summarize/small', {
    method: 'POST',
    // content 手写：这条接口既能让模型总结，也支持你自己写一条
    body: { chatId: 'mem-chat', content: '用户和猫娘打了招呼。', messages: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '喵' }] },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const memoryId = created.body.memory.id;
  assert.equal(created.body.memory.content, '用户和猫娘打了招呼。');
  assert.equal(created.body.covered, 2);

  const listed = await call('/api/memory?chatId=mem-chat');
  assert.equal(listed.body.total, 1);
  assert.equal(listed.body.items[0].layer, 'small');

  const edited = await call(`/api/memory/${memoryId}`, { method: 'PUT', body: { content: '改过的前情提要', pinned: true } });
  assert.equal(edited.body.content, '改过的前情提要');
  assert.equal(edited.body.pinned, true);

  const profiles = await call('/api/memory/profiles?chatId=mem-chat');
  assert.equal(profiles.body.total, 0);
  assert.equal((await call(`/api/memory/${memoryId}`, { method: 'DELETE' })).status, 204);
  assert.equal((await call('/api/memory?chatId=mem-chat')).body.total, 0);
});

test('向量：建索引、混合检索、增量与清理、按来源删', async () => {
  const collections = await call('/api/vectors/collections');
  assert.deepEqual(collections.body.items.map((item) => item.id), ['worldbook', 'databank', 'history', 'memory']);
  const stats = await call('/api/vectors/stats');
  assert.equal(stats.body.total, 0);

  // 没接嵌入模型时退化成关键词索引，也能检索
  const indexed = await call('/api/vectors/index-source', {
    method: 'POST',
    body: { collection: 'databank', sourceId: 'doc-1', content: '旧书店在东街尽头，二楼不对外开放。' },
  });
  assert.equal(indexed.status, 201);
  assert.equal(indexed.body.chunks, 1);
  assert.equal(indexed.body.embedded, 0, '没配嵌入模型时不算向量');

  const search = await call('/api/vectors/search', { method: 'POST', body: { query: '东街书店' } });
  assert.ok(search.body.items.length >= 1);
  assert.ok(search.body.items[0].content.includes('东街'));
  assert.ok(search.body.items[0].keywordScore > 0);

  const afterIndex = await call('/api/vectors/stats');
  assert.equal(afterIndex.body.total, 1);
  assert.equal(afterIndex.body.pending, 1);

  // 增量：同样的内容再索引一次，还是 1 个块
  const again = await call('/api/vectors/index-source', { method: 'POST', body: { collection: 'databank', sourceId: 'doc-1', content: '旧书店在东街尽头，二楼不对外开放。' } });
  assert.equal(again.body.chunks, 1);
  assert.equal((await call('/api/vectors/stats')).body.total, 1);

  // 重建（把当前库里的来源都过一遍；参考资料由请求里带）
  const reindexed = await call('/api/vectors/reindex', { method: 'POST', body: { collection: 'databank', sources: [{ collection: 'databank', sourceId: 'doc-2', content: '二楼有只猫。' }] } });
  assert.equal(reindexed.body.sources, 1);
  assert.equal(reindexed.body.chunks, 1);

  // 按来源删除
  const removed = await call('/api/vectors/source/doc-1?collection=databank', { method: 'DELETE' });
  assert.equal(removed.body.removed, 1);

  // 清空：只清，不会顺手把来源又建回来
  const cleared = await call('/api/vectors/clear', { method: 'POST', body: {} });
  assert.equal(cleared.body.total, 0, '清空接口是只清，不是清了再建');

  // 没有嵌入模型时，测试嵌入要给出可读的错，而不是静默通过
  const test = await call('/api/vectors/test-embedding', { method: 'POST', body: {} });
  assert.equal(test.status, 400);
  assert.equal(test.body.error.code, 'VALIDATION_ERROR');
});

test('卡内前端：元数据接口可用', async () => {
  const capabilities = await call('/api/frontend/capabilities');
  assert.ok(capabilities.body.items.length >= 6);
  const tokens = await call('/api/frontend/theme-tokens');
  assert.ok(tokens.body.items.some((item) => item.id === '--st-accent'));
  const themes = await call('/api/frontend/themes');
  assert.equal(themes.body.total, 3);
});

// ---------- 玩卡区与工具箱 ----------

test('玩卡区接口：空库形状正确，未知对话 404，未实现的演出层 501', async () => {
  const chats = await call('/api/chats');
  assert.deepEqual(chats.body.items, []);

  const protocol = await call('/api/chats/stream-protocol');
  assert.deepEqual(protocol.body.items, ['start', 'delta', 'thinking', 'tool_start', 'usage', 'done', 'error']);

  const send = await call('/api/chats/does-not-exist/send', { method: 'POST', body: { text: 'hi' } });
  assert.equal(send.status, 404);
  assert.equal(send.body.error.code, 'NOT_FOUND');

  const strategies = await call('/api/group/strategies');
  assert.deepEqual(strategies.body.items.map((item) => item.id), ['natural', 'list', 'manual', 'mixed']);
  assert.equal(strategies.body.modes.length, 3);

  const panels = await call('/api/state/panels');
  assert.equal(panels.body.items.length, 6);

  const directorModes = await call('/api/narration/modes');
  assert.deepEqual(directorModes.body.items.map((item) => item.id), ['narrator', 'director', 'ooc']);

  const performance = await call('/api/performance/x');
  assert.equal(performance.status, 501);

  const images = await call('/api/images/generate', { method: 'POST', body: {} });
  assert.equal(images.status, 501);
});

test('工具箱与平台接口：占位但可枚举', async () => {
  // ComfyUI 已实现：还没配置时也要能用 200 + 人话原因回答，而不是 501
  const comfy = await call('/api/comfy/status');
  assert.equal(comfy.status, 200);
  assert.equal(comfy.body.ok, false);
  assert.equal(comfy.body.enabled, false);
  assert.ok(comfy.body.baseUrl);
  assert.equal((await call('/api/comfy/workflows')).body.total, 0);
  assert.equal((await call('/api/comfy/runs')).body.total, 0);
  // 花费统计已实现：没有用量时也要给出结构完整的空汇总
  const cost = await call('/api/cost/summary');
  assert.equal(cost.status, 200);
  assert.equal(cost.body.totals.turns, 0);
  assert.equal(cost.body.totals.cost, 0);
  assert.ok(Array.isArray(cost.body.byDay));
  // 维护接口也已实现：空库也要给出结构完整的统计
  const maintenance = await call('/api/maintenance/stats');
  assert.equal(maintenance.status, 200);
  assert.ok(Array.isArray(maintenance.body.items));
  assert.ok(maintenance.body.raw);

  const mcpTools = await call('/api/mcp/tools');
  assert.equal(mcpTools.status, 200);
  assert.deepEqual(mcpTools.body.items, []);

  const providers = await call('/api/providers');
  assert.equal(providers.body.kinds.length, 5);
  assert.equal(providers.body.items.length, 0);
  assert.ok(providers.body.kinds.every((kind) => kind.implemented === false));
  assert.ok(providers.body.kinds.every((kind) => kind.count === 0));
});

// ---------- 静态文件与错误处理 ----------

test('静态文件：首页、脚本、样式都能取到', async () => {
  const home = await call('/', { raw: true });
  assert.equal(home.status, 200);
  assert.match(home.type, /text\/html/);
  assert.match(home.body, /Silver Tavern/);

  const app = await call('/app.js', { raw: true });
  assert.equal(app.status, 200);
  assert.match(app.type, /javascript/);

  const css = await call('/styles/base.css', { raw: true });
  assert.equal(css.status, 200);
  assert.match(css.body, /--st-accent/);
});

test('静态文件：未知路径回首页（单页兜底），不泄露仓库文件', async () => {
  const spa = await call('/some/deep/route', { raw: true });
  assert.equal(spa.status, 200);
  assert.match(spa.type, /text\/html/);

  for (const probe of ['/package.json', '/%2e%2e/package.json', '/..%2Fpackage.json']) {
    const res = await call(probe, { raw: true });
    assert.ok(res.status === 404 || res.type.includes('html'), `${probe} 不该返回文件内容`);
    assert.ok(!res.body.includes('devDependencies'), `${probe} 泄露了 package.json`);
  }
});

test('错误处理：404 / 405 / 非 JSON 请求体', async () => {
  const notFound = await call('/api/does-not-exist');
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.error.code, 'NOT_FOUND');

  const wrongMethod = await call('/api/health', { method: 'DELETE' });
  assert.equal(wrongMethod.status, 405);
  assert.match(wrongMethod.headers.get('allow'), /GET/);

  const wrongType = await call('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain' },
    body: undefined,
  });
  void wrongType;
});

// ---------- 模型接入 ----------

test('提供方：新增、列表不泄露密钥、列模型、连通性测试', async () => {
  const catalog = await call('/api/providers');
  assert.equal(catalog.status, 200);
  assert.ok(catalog.body.adapters.length >= 5);
  assert.ok(catalog.body.presets.length >= 15);
  assert.ok(catalog.body.presets.some((preset) => preset.id === 'deepseek'));
  assert.equal(catalog.body.items.length, 0);

  const created = await call('/api/providers', {
    method: 'POST',
    body: { label: '本地假模型', kind: 'chat', adapter: 'openai', baseUrl: mockBase, model: 'mock-small', apiKey: 'sk-secret-value' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.hasKey, true);
  assert.equal(created.body.apiKey, undefined);
  assert.ok(!JSON.stringify(created.body).includes('sk-secret-value'), '返回里不该有明文 key');

  const list = await call('/api/providers');
  assert.equal(list.body.items.length, 1);
  assert.ok(!JSON.stringify(list.body).includes('sk-secret-value'));
  assert.equal(list.body.kinds.find((kind) => kind.id === 'chat').implemented, true);

  const models = await call(`/api/providers/${created.body.id}/models`);
  assert.equal(models.status, 200);
  assert.deepEqual(models.body.items, ['mock-large', 'mock-small']);

  const tested = await call(`/api/providers/${created.body.id}/test`, { method: 'POST' });
  assert.equal(tested.status, 200);
  assert.equal(tested.body.ok, true);
  assert.equal(tested.body.via, 'models');

  // 假服务返回 404 的路径也能跑通"列表失败就真发一次请求"的兜底
  const chatOnly = await call('/api/providers', {
    method: 'POST',
    body: { label: '连不上的地址', kind: 'chat', adapter: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'mock-small' },
  });
  assert.equal(chatOnly.status, 201);
  const tested2 = await call(`/api/providers/${chatOnly.body.id}/test`, { method: 'POST' });
  assert.equal(tested2.body.ok, false);
  assert.ok(typeof tested2.body.error === 'string' && tested2.body.error.length > 0);
});

test('提供方：校验非法用途与非法适配器组合', async () => {
  const badKind = await call('/api/providers', {
    method: 'POST',
    body: { label: 'X', kind: 'nope', adapter: 'openai', baseUrl: mockBase, model: 'm' },
  });
  assert.equal(badKind.status, 400);

  const badPair = await call('/api/providers', {
    method: 'POST',
    body: { label: 'X', kind: 'embedding', adapter: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude' },
  });
  assert.equal(badPair.status, 400);
  assert.match(badPair.body.error.message, /Anthropic/);

  const noUrl = await call('/api/providers', {
    method: 'POST',
    body: { label: 'X', kind: 'chat', adapter: 'openai', baseUrl: '', model: 'm' },
  });
  assert.equal(noUrl.status, 400);
});

test('模型调用：ping 走完整适配链（SSE 解析 + usage）', async () => {
  const list = await call('/api/providers');
  const provider = list.body.items.find((item) => item.label === '本地假模型');
  const ping = await call('/api/models/ping', { method: 'POST', body: { providerId: provider.id, prompt: 'ping' } });
  assert.equal(ping.status, 200);
  assert.equal(ping.body.text, 'pong');
  assert.equal(ping.body.usage.totalTokens, 7);
  assert.equal(ping.body.finish, 'stop');

  const missing = await call('/api/models/ping', { method: 'POST', body: {} });
  assert.equal(missing.status, 400);
});

test('多模型协同：两个角色绑两个模型，共享同一份记忆', async () => {
  const list = await call('/api/providers');
  const first = list.body.items.find((item) => item.label === '本地假模型');
  const second = await call('/api/providers', {
    method: 'POST',
    body: { label: '本地假模型·大', kind: 'chat', adapter: 'openai', baseUrl: mockBase, model: 'mock-large' },
  });
  assert.equal(second.status, 201);

  const scopes = await call('/api/models/scopes');
  assert.deepEqual(scopes.body.items.map((item) => item.id), ['default', 'chat', 'character', 'chat_member']);

  const bindHero = await call('/api/models/bindings', {
    method: 'PUT',
    body: { scope: 'character', targetId: 'char-男主', providerId: first.id },
  });
  assert.equal(bindHero.status, 200);

  const bindHeroine = await call('/api/models/bindings', {
    method: 'PUT',
    body: { scope: 'character', targetId: 'char-女主', providerId: second.body.id, model: 'mock-large' },
  });
  assert.equal(bindHeroine.status, 200);

  const bindings = await call('/api/models/bindings');
  assert.equal(bindings.body.total, 2);

  const resolved = await call('/api/models/resolve', { method: 'POST', body: { characterId: 'char-女主' } });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.providerId, second.body.id);
  assert.equal(resolved.body.source, 'character');
  assert.equal(resolved.body.sourceTitle, '角色覆盖');

  const plan = await call('/api/models/plan?characters=char-男主:男主,char-女主:女主&chatId=chat-1');
  assert.equal(plan.status, 200);
  assert.equal(plan.body.items.length, 2);
  assert.equal(plan.body.multiModel, true);
  assert.equal(plan.body.distinctProviders, 2);
  assert.equal(plan.body.sharedMemory, true, '记忆挂在对话上，与模型无关');

  const removed = await call(`/api/models/bindings/${bindHeroine.body.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 204);

  const fallback = await call('/api/models/resolve', { method: 'POST', body: { characterId: 'char-女主' } });
  assert.equal(fallback.body.providerId, null);
  assert.equal(fallback.body.source, 'none');
});

test('多模型协同：群聊成员单独绑模型，分工预览按 chatId 查成员也算得对', async () => {
  const providers = await call('/api/providers');
  const small = providers.body.items.find((item) => item.label === '本地假模型');
  const big = providers.body.items.find((item) => item.label === '本地假模型·大');
  assert.ok(small && big, '前面的用例应该已经建好两个提供方');

  const created = await call('/api/chats', {
    method: 'POST',
    body: {
      title: '分工预览',
      isGroup: true,
      greetings: false,
      members: [
        { characterId: 'c-alpha', name: '甲', card: { name: '甲', description: 'A' } },
        { characterId: 'c-beta', name: '乙', card: { name: '乙', description: 'B' } },
      ],
    },
  });
  assert.equal(created.status, 201);
  const chatId = created.body.id;
  const members = (await call(`/api/group/${chatId}`)).body.members;
  const alpha = members.find((member) => member.name === '甲');
  assert.ok(alpha?.id, '要拿到群聊成员的 id');

  // 只给「甲」这个**群聊成员**绑一家。以前前端拿不到成员 id（只能拼角色 id），
  // 所以这种绑定在分工预览里永远显示成"没绑定"。
  const bound = await call('/api/models/bindings', {
    method: 'PUT',
    body: { scope: 'chat_member', targetId: alpha.id, providerId: big.id, model: 'mock-large' },
  });
  assert.equal(bound.status, 200);

  const plan = await call(`/api/models/plan?chatId=${chatId}`);
  assert.equal(plan.status, 200);
  assert.equal(plan.body.chat.id, chatId, '要说清算的是哪个群');
  assert.equal(plan.body.items.length, 2, '群里两个成员都要算上');
  const rowAlpha = plan.body.items.find((item) => item.member === '甲');
  const rowBeta = plan.body.items.find((item) => item.member === '乙');
  assert.equal(rowAlpha.providerId, big.id, '群聊成员覆盖要生效');
  assert.equal(rowAlpha.source, 'chat_member');
  assert.equal(rowAlpha.sourceTitle, '群聊成员覆盖');
  assert.equal(rowBeta.providerId, null, '没绑的那个不该继承别人的模型');

  // 老写法（前端自己拼 id:名字）还得能用，不然是破坏性改动
  const legacy = await call('/api/models/plan?characters=c-alpha:甲,c-beta:乙');
  assert.equal(legacy.body.items.length, 2);
  assert.equal(legacy.body.chat, null, '没给 chatId 就没有这个字段');

  await call(`/api/chats/${chatId}`, { method: 'DELETE' });
  await call(`/api/models/bindings/${bound.body.id}`, { method: 'DELETE' });
});

// ---------- 写卡助手（Agent + 技能） ----------

test('Agent：内置写卡技能清单', async () => {
  const res = await call('/api/agent/skills');
  assert.equal(res.status, 200);
  assert.ok(res.body.items.length >= 8, `内置技能偏少：${res.body.items.length}`);
  assert.equal(res.body.fromMcp, 0);
  const ids = res.body.items.map((skill) => skill.id);
  for (const id of ['card.draft', 'card.rewrite', 'card.inspect', 'worldbook.extract', 'text.translate']) {
    assert.ok(ids.includes(id), `缺少技能 ${id}`);
  }
  assert.ok(res.body.categories.some((category) => category.id === 'card'));
  // describe 不能把 handler 漏出去
  assert.equal(res.body.items[0].handler, undefined);
});

test('Agent：单跑一个技能，走真实模型调用链', async () => {
  const providers = await call('/api/providers');
  const provider = providers.body.items.find((item) => item.label === '本地假模型');
  const result = await call('/api/agent/skills/card.draft/run', {
    method: 'POST',
    body: { input: { idea: '一只会算数的猫' }, providerId: provider.id },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.data.name, '琥珀');
  assert.equal(result.body.skill.id, 'card.draft');
  assert.equal(result.body.target.source, 'explicit');
});

test('Agent：技能出错时返回 ok:false 而不是抛 500', async () => {
  const providers = await call('/api/providers');
  const provider = providers.body.items.find((item) => item.label === '本地假模型');
  const result = await call('/api/agent/skills/card.draft/run', {
    method: 'POST',
    body: { input: {}, providerId: provider.id },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, false);
  assert.match(result.body.error, /idea/);
});

test('Agent：没有可用模型时给出可读的提示', async () => {
  const result = await call('/api/agent/skills/card.draft/run', { method: 'POST', body: { input: { idea: 'x' } } });
  assert.equal(result.status, 502);
  assert.match(result.body.error.message, /模型/);
});

// ---------- MCP ----------

test('MCP：接一个本地 stdio 服务器，连上、列工具、调工具', async () => {
  const fixture = path.join(process.cwd(), 'tests', 'fixtures', 'mock-mcp-server.mjs');
  const created = await call('/api/mcp/servers', {
    method: 'POST',
    body: { name: 'mock', command: process.execPath, args: [fixture] },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.enabled, true);

  const connected = await call(`/api/mcp/servers/${created.body.id}/connect`, { method: 'POST' });
  assert.equal(connected.status, 200);
  assert.equal(connected.body.tools.length, 1);
  assert.equal(connected.body.tools[0].name, 'echo');

  const tools = await call('/api/mcp/tools');
  assert.equal(tools.body.total, 1);
  assert.equal(tools.body.items[0].serverName, 'mock');

  const called = await call(`/api/mcp/servers/${created.body.id}/call`, {
    method: 'POST',
    body: { tool: 'echo', args: { text: '你好' } },
  });
  assert.equal(called.status, 200);
  assert.equal(called.body.text, 'echo:你好');
  assert.equal(called.body.isError, false);

  // 连上之后，MCP 工具会变成 Agent 的技能
  const skills = await call('/api/agent/skills');
  assert.equal(skills.body.fromMcp, 1);
  const echoSkill = skills.body.items.find((skill) => skill.source === 'mcp');
  assert.equal(echoSkill.category, 'external');
  assert.match(echoSkill.id, /^mcp\.mock\./);

  const removed = await call(`/api/mcp/servers/${created.body.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 204);
  const after = await call('/api/agent/skills');
  assert.equal(after.body.fromMcp, 0);
});

// ---------- 玩卡区端到端 ----------

test('玩卡区：建对话、流式生成、状态落库、重生成 / 继续 / 编辑 / 插入 / 扮演', async () => {
  const providers = await call('/api/providers');
  const provider = providers.body.items.find((item) => item.label === '本地假模型');
  assert.ok(provider, '前面的用例应该已经建好假模型提供方');
  await call('/api/models/bindings', { method: 'PUT', body: { scope: 'default', providerId: provider.id } });

  const created = await call('/api/chats', {
    method: 'POST',
    body: { title: '酒馆夜谈', character: { name: '阿狸', description: '一只会算数的猫', first_mes: '喵。' }, persona: { name: '我' } },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.members.length, 1);
  assert.equal(created.body.messageCount, 1, '开场白自动落一条');
  const chatId = created.body.id;

  const streamed = await streamCall(`/api/chats/${chatId}/send`, { text: '你好' });
  const types = streamed.events.map((event) => event.event);
  assert.equal(types[0], 'start');
  assert.ok(types.includes('delta'));
  assert.equal(types.at(-1), 'done');
  const done = streamed.events.find((event) => event.event === 'done').data;
  assert.equal(done.text, '她点了点头。', '```state 块要被摘掉，不进正文');
  assert.equal(done.name, '阿狸');
  assert.equal(done.source, 'default');
  assert.equal(done.stateDelta.affection.阿狸, 2);

  // 从卡库选卡开演：卡内嵌的世界书要跟着这张卡一起进提示词
  const libCard = await call('/api/characters', {
    method: 'POST',
    body: {
      name: '琥珀',
      description: '守书店的狐狸',
      first_mes: '「书页潮了。」',
      character_book: { name: '书店', entries: [{ id: 0, keys: ['书店'], content: '卡内：书店在东街尽头', enabled: true }] },
    },
  });
  const libChat = await call('/api/chats', { method: 'POST', body: { characterId: libCard.body.id } });
  assert.equal(libChat.body.members[0].card.character_book.entries.length, 1, '卡内世界书要跟着卡快照进对话');
  const libStream = await streamCall(`/api/chats/${libChat.body.id}/send`, { text: '书店在哪' });
  assert.equal(libStream.events.at(-1).event, 'done');

  const libCards = await call(`/api/xray?chatId=${libChat.body.id}&limit=5`);
  const snapshot = await call(`/api/xray/${libCards.body.items[0].id}`);
  assert.ok(
    snapshot.body.sections.some((section) => section.id === 'worldbook' && section.content.includes('书店在东街尽头')),
    '卡内嵌的世界书这一轮要真的注入',
  );
  await call(`/api/chats/${libChat.body.id}`, { method: 'DELETE' });
  await call(`/api/characters/${libCard.body.id}`, { method: 'DELETE' });

  const messages = await call(`/api/chats/${chatId}/messages`);
  assert.equal(messages.body.items.at(-1).content, '她点了点头。');
  assert.ok(messages.body.items.at(-1).tokens > 0, '每条消息都有 token 数');
  assert.ok(messages.body.items.at(-1).extra.promptTokens > 0);

  const stateRes = await call(`/api/state/${chatId}`);
  assert.equal(stateRes.body.worldState.affection.阿狸, 2, 'AI 输出的状态改动要写进对话变量');
  assert.equal(stateRes.body.panels.length, 6);

  const before = messages.body.total;
  const regen = await streamCall(`/api/chats/${chatId}/regenerate`, {});
  assert.ok(regen.events.some((event) => event.event === 'done'));
  const afterRegen = await call(`/api/chats/${chatId}/messages`);
  assert.equal(afterRegen.body.total, before, '重新生成替换而不是追加');

  const cont = await streamCall(`/api/chats/${chatId}/continue`, {});
  assert.ok(cont.events.some((event) => event.event === 'done'));
  const afterCont = await call(`/api/chats/${chatId}/messages`);
  assert.equal(afterCont.body.total, before + 1, '继续不新增用户回合');

  const lastId = afterCont.body.items.at(-1).id;
  const edited = await call(`/api/chats/${chatId}/messages/${lastId}`, {
    method: 'PUT',
    body: { content: '改过的内容', hidden: true, isSystem: true },
  });
  assert.equal(edited.body.content, '改过的内容');
  assert.equal(edited.body.hidden, true);
  assert.equal(edited.body.isSystem, true);

  const inserted = await call(`/api/chats/${chatId}/messages`, { method: 'POST', body: { afterMessageId: lastId, role: 'user', content: '（插一句）' } });
  assert.equal(inserted.status, 201);
  assert.equal(inserted.body.content, '（插一句）');

  // 插到对话中间：之前只在末尾插过，中间的"整体后移"会撞 UNIQUE(chat_id, seq)
  const allMessages = await call(`/api/chats/${chatId}/messages`);
  const middle = allMessages.body.items[1];
  const midInsert = await call(`/api/chats/${chatId}/messages`, {
    method: 'POST',
    body: { afterMessageId: middle.id, role: 'user', content: '（插在中间）' },
  });
  assert.equal(midInsert.status, 201, '插到中间不能 500');
  assert.equal(midInsert.body.seq, middle.seq + 1);
  const afterMid = await call(`/api/chats/${chatId}/messages`);
  assert.deepEqual(
    afterMid.body.items.map((message) => message.seq),
    afterMid.body.items.map((_message, index) => index + 1),
  );

  // 锚点消息不属于这个对话 → 404，而不是默默插到最前面
  const staleAnchor = await call(`/api/chats/${chatId}/messages`, { method: 'POST', body: { afterMessageId: 'msg_不存在', role: 'user', content: 'x' } });
  assert.equal(staleAnchor.status, 404);

  const impersonated = await call(`/api/chats/${chatId}/impersonate`, { method: 'POST', body: {} });
  assert.equal(impersonated.status, 200);
  assert.ok(typeof impersonated.body.text === 'string' && impersonated.body.text.length > 0);

  const options = await call(`/api/narration/${chatId}/options`, { method: 'POST', body: { count: 3 } });
  assert.equal(options.status, 200);
  assert.ok(options.body.items.length >= 3, '每轮给 3~4 个候选行动');
  const latest = await call(`/api/narration/${chatId}/latest`);
  assert.ok(latest.body.options.length >= 3);

  const roll = await call(`/api/state/${chatId}/roll`, { method: 'POST', body: { expr: '1d20' } });
  assert.ok(roll.body.total >= 1 && roll.body.total <= 20);

  await call(`/api/state/${chatId}`, {
    method: 'PUT',
    body: { worldState: { ...stateRes.body.worldState, place: '地窖', items: [{ name: '铜钥匙', qty: 1 }] } },
  });
  const snap = await call(`/api/state/${chatId}/snapshots`, { method: 'POST', body: { label: '进地窖' } });
  assert.equal(snap.status, 201);
  await call(`/api/state/${chatId}`, { method: 'PUT', body: { delta: { place: '城外' } } });
  const moved = await call(`/api/state/${chatId}`);
  assert.equal(moved.body.worldState.place, '城外');
  const restored = await call(`/api/state/${chatId}/snapshots/${snap.body.id}/restore`, { method: 'POST' });
  assert.equal(restored.body.worldState.place, '地窖');
  assert.equal(restored.body.worldState.items[0].name, '铜钥匙');

  const branch = await call(`/api/chats/${chatId}/branch`, { method: 'POST', body: { label: '如果当时拒绝' } });
  assert.equal(branch.status, 201);
  assert.equal(branch.body.parentChatId, chatId);
  assert.ok(branch.body.messageCount >= 2);
  assert.match(branch.body.title, /分支|如果当时拒绝/);

  const search = await call(`/api/search?q=${encodeURIComponent('改过的内容')}`);
  assert.ok(search.body.items.some((item) => item.chatId === chatId), '全文搜索能定位到对话');

  const xrayList = await call(`/api/xray?chatId=${chatId}`);
  assert.ok(xrayList.body.items.length >= 1, '每轮存一份提示词快照');
  const xrayDetail = await call(`/api/xray/${xrayList.body.items[0].id}`);
  assert.ok(xrayDetail.body.sections.some((section) => section.id === 'history'));
  assert.ok(xrayDetail.body.tokens.total > 0);
  assert.ok(xrayDetail.body.text.length > 0);

  const exported = await call(`/api/chats/${chatId}/export?format=jsonl`, { raw: true });
  assert.equal(exported.status, 200);
  assert.match(exported.body, /"user_name"/);
  assert.match(exported.body, /"chat_metadata"/);
  const importedResponse = await fetch(`${base}/api/chats/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-ndjson' },
    body: exported.body,
  });
  const imported = await importedResponse.json();
  assert.equal(importedResponse.status, 201);
  assert.ok(imported.messageCount > 0, '酒馆 JSONL 导进来能读');
  assert.equal((await call(`/api/chats/${imported.id}`, { method: 'DELETE' })).status, 204);

  // 对话挂了带位置标记的预设：发给模型的消息顺序要跟着标记走
  // （就是对话页输入框上方「提示词预设」那一栏做的事）
  const boundPreset = await call('/api/prompts/presets/import', {
    method: 'POST',
    body: {
      name: '夜谈预设',
      document: {
        name: '夜谈预设',
        // 预设顶层的采样参数（酒馆就是这么存的）
        temperature: 1.09,
        top_p: 0.98,
        top_k: 64,
        frequency_penalty: 0,
        presence_penalty: 0,
        min_p: 0,
        seed: -1,
        openai_max_tokens: 65535,
        wi_format: '{{0}}',
        prompts: [
          { identifier: 'open', role: 'system', content: '<{{char}}>' },
          { identifier: 'charDescription', name: 'Char Description', role: 'system', marker: true },
          { identifier: 'close', role: 'system', content: '</{{char}}>' },
          { identifier: 'chatHistory', name: 'Chat History', role: 'system', marker: true },
          { identifier: 'tail', role: 'system', content: '结尾给三个选项' },
        ],
        prompt_order: [{ character_id: 100000, order: ['open', 'charDescription', 'close', 'chatHistory', 'tail'].map((identifier) => ({ identifier, enabled: true })) }],
      },
    },
  });
  await call(`/api/chats/${chatId}`, { method: 'PUT', body: { settings: { ...(created.body.settings ?? {}), presetId: boundPreset.body.id } } });
  const boundChat = await call(`/api/chats/${chatId}`);
  assert.equal(boundChat.body.settings.presetId, boundPreset.body.id, '预设要真的挂在对话上');
  await streamCall(`/api/chats/${chatId}/send`, { text: '再来一句' });
  const sentBody = JSON.parse(mockModel.lastRequest.bodyText);
  const systemMessage = sentBody.messages.find((message) => message.role === 'system');
  const lastMessage = sentBody.messages.at(-1);
  assert.ok(systemMessage.content.includes('<阿狸>'), '开标签要在系统提示里');
  assert.ok(
    systemMessage.content.indexOf('<阿狸>') < systemMessage.content.indexOf('一只会算数的猫') &&
      systemMessage.content.indexOf('一只会算数的猫') < systemMessage.content.indexOf('</阿狸>'),
    '角色描述要被开闭标签夹住',
  );
  assert.ok(!systemMessage.content.includes('结尾给三个选项'), '排在历史之后的条目不能挤进系统提示');
  assert.equal(lastMessage.role, 'system');
  assert.ok(lastMessage.content.includes('结尾给三个选项'), '排在历史之后的条目要作为最后一条消息发出去');

  // 预设顶层的采样参数也要真的生效（默认"常用档"：只发各家都认的那几个）
  assert.equal(sentBody.temperature, 1.09, '预设的温度要真的发给提供方');
  assert.equal(sentBody.top_p, 0.98);
  assert.ok(!('top_k' in sentBody), '常用档不发 top_k（云端中转不一定认）');
  assert.ok(!('frequency_penalty' in sentBody) && !('presence_penalty' in sentBody), '等于没设的惩罚值不占位置');
  assert.ok(!('seed' in sentBody), 'seed = -1 是"随机"，不能原样发出去');
  // 预设顶层字段现在也会照做：openai_max_tokens 当回复上限（最底一层，玩家自己的设置优先）、
  // stream_openai / reasoning_effort / 各种 *_prompt 都有对应实现
  assert.equal(sentBody.max_tokens, 65535, '预设的 openai_max_tokens 要当回复上限用');
  assert.ok(!('wi_format' in sentBody), '不是采样参数的顶层字段一个都不能发出去');

  // 切到"全部档"：本地推理专用的 top_k 才跟上
  await call(`/api/chats/${chatId}`, {
    method: 'PUT',
    body: { settings: { ...(created.body.settings ?? {}), presetId: boundPreset.body.id, presetParams: 'all' } },
  });
  await streamCall(`/api/chats/${chatId}/regenerate`, {});
  const sentAll = JSON.parse(mockModel.lastRequest.bodyText);
  assert.equal(sentAll.top_k, 64, '全部档要把 top_k 也带上');

  // 关掉：一个预设参数都不该出现
  await call(`/api/chats/${chatId}`, {
    method: 'PUT',
    body: { settings: { ...(created.body.settings ?? {}), presetId: boundPreset.body.id, presetParams: 'off' } },
  });
  await streamCall(`/api/chats/${chatId}/regenerate`, {});
  const sentOff = JSON.parse(mockModel.lastRequest.bodyText);
  assert.ok(!('temperature' in sentOff) && !('top_p' in sentOff) && !('top_k' in sentOff), '关掉之后不该再有预设的参数');

  await call(`/api/chats/${chatId}`, { method: 'PUT', body: { settings: { ...(created.body.settings ?? {}) } } });
  await call(`/api/prompts/presets/${boundPreset.body.id}`, { method: 'DELETE' });

  // 预设顶层的"传输 / 推理 / 上限"字段也要照做（stream_openai / reasoning_effort / openai_max_tokens）
  const optionPreset = await call('/api/prompts/presets/import', {
    method: 'POST',
    body: {
      name: '顶层字段预设',
      document: {
        name: '顶层字段预设',
        stream_openai: false,
        reasoning_effort: 'max',
        verbosity: 'low',
        openai_max_tokens: 2048,
        use_sysprompt: false,
        squash_system_messages: false,
        prompts: [{ identifier: 'main', role: 'system', content: '你好 {{char}}' }],
      },
    },
  });
  await call(`/api/chats/${chatId}`, {
    method: 'PUT',
    body: { settings: { ...(created.body.settings ?? {}), presetId: optionPreset.body.id } },
  });
  await streamCall(`/api/chats/${chatId}/send`, { text: '顶层字段试试' });
  const optionSent = JSON.parse(mockModel.lastRequest.bodyText);
  assert.equal(optionSent.stream, false, 'stream_openai: false → 整段返回');
  assert.equal(optionSent.reasoning_effort, 'high', 'reasoning_effort: max → high');
  assert.equal(optionSent.verbosity, 'low', 'verbosity 要透传');
  assert.equal(optionSent.max_tokens, 2048, 'openai_max_tokens 要当回复上限');
  assert.ok(!optionSent.messages.some((message) => String(message.content).includes('你是角色扮演引擎')), 'use_sysprompt: false → 不加默认系统提示');
  await call(`/api/chats/${chatId}`, { method: 'PUT', body: { settings: { ...(created.body.settings ?? {}) } } });
  await call(`/api/prompts/presets/${optionPreset.body.id}`, { method: 'DELETE' });

  // 非流式（整段返回）：提供方参数里选"整段返回"，一次 POST 拿整段，事件流照样走完
  const fakeProvider = (await call('/api/providers')).body.items.find((item) => item.label === '本地假模型');
  await call(`/api/providers/${fakeProvider.id}`, { method: 'PUT', body: { params: { ...(fakeProvider.params ?? {}), streamMode: 'full' } } });
  const fullStream = await streamCall(`/api/chats/${chatId}/send`, { text: '整段返回试试' });
  assert.equal(fullStream.events.at(-1).event, 'done');
  const fullSent = JSON.parse(mockModel.lastRequest.bodyText);
  assert.equal(fullSent.stream, false, '整段返回要带 stream:false');
  assert.ok(!('streamMode' in fullSent), 'streamMode 是本地的开关，不能原样发出去');
  const fullMessages = await call(`/api/chats/${chatId}/messages`);
  assert.equal(fullMessages.body.items.at(-1).content, '整段返回的正文', '非流式返回也要解析出正文');
  assert.equal(fullMessages.body.items.at(-1).extra.reasoning, '整段返回的思考', '非流式的思维链字段也要收下');
  await call(`/api/providers/${fakeProvider.id}`, { method: 'PUT', body: { params: {} } });

  // 思维链：提供方单独给的 reasoning 要存进 extra.reasoning，不能混进正文、也不该进上下文
  const thinkStream = await streamCall(`/api/chats/${chatId}/send`, { text: 'THINKING_TEST' });
  assert.ok(thinkStream.events.some((event) => event.event === 'thinking'), '思维链要作为流事件发出来');
  assert.equal(thinkStream.events.at(-1).event, 'done');
  const thinkMessages = await call(`/api/chats/${chatId}/messages`);
  const thinkMessage = thinkMessages.body.items.at(-1);
  assert.equal(thinkMessage.content, '想好了。', '思维链不能混进正文');
  assert.equal(thinkMessage.extra.reasoning, '先想一下', '思维链单独存一份（界面默认折叠）');

  // 最少字数：要落在发给模型的**最后一条**消息里
  // （预设那种"写够1000字"藏在系统提示中间，模型经常当没看见）
  await call(`/api/chats/${chatId}`, { method: 'PUT', body: { settings: { ...(created.body.settings ?? {}), minChars: 900, thinkingChinese: true } } });
  await streamCall(`/api/chats/${chatId}/send`, { text: '写长一点' });
  const lengthSent = JSON.parse(mockModel.lastRequest.bodyText);
  assert.match(lengthSent.messages.at(-1).content, /思考过程/, '思考语言要求要作为最后一条消息发出去');
  assert.match(lengthSent.messages.at(-2).content, /不少于 900 字/, '长度要求紧挨着它前面一条');
  // 思维链的中文译文走同一个翻译接口，存进 extra.reasoningZh（只改显示）
  const translated = await call('/api/studio/translate', { method: 'POST', body: { text: 'He wants it lively.', target: 'zh-CN' } });
  assert.equal(translated.status, 200);
  assert.ok(typeof translated.body.translation === 'string' && translated.body.translation.length > 0, '翻译接口要回译文');
  const withZh = await call(`/api/chats/${chatId}/messages/${thinkMessage.id}`, {
    method: 'PUT',
    body: { extra: { ...thinkMessage.extra, reasoningZh: '他想要点热闹。' } },
  });
  assert.equal(withZh.body.extra.reasoningZh, '他想要点热闹。', '译文要能存进消息 extra');
  assert.equal(withZh.body.extra.reasoning, '先想一下', '译文不能把原文顶掉');

  // 函数调用（工具）：预设自己带工具（酒馆第三方扩展 SPreset 的 ToolBindings 写法）。
  // consume 模式：工具调用的参数就是正文，不二次生成。
  const toolPreset = await call('/api/prompts/presets/import', {
    method: 'POST',
    body: {
      name: '工具预设',
      document: {
        function_calling: true,
        tool_call_recurse_limit: 5,
        prompts: [{ identifier: 'main', role: 'system', content: 'TOOL_CONSUME_TEST' }],
        extensions: {
          SPreset: {
            ToolBindings: {
              t1: {
                enabled: true,
                form: {
                  name: 'game_content',
                  description: 'MANDATORY, You MUST use this tool to reply.',
                  parameters: [{ name: 'content', type: 'string', description: '正文', required: true }],
                },
              },
              t2: {
                enabled: false,
                form: { name: 'soliumbra_think', description: '被关掉的工具', parameters: [{ name: 'thinking', type: 'string', required: true }] },
              },
            },
            OutputPreprocessing: { enabled: true, consumeToolCalls: true, script: "const marker = '<|valid|>';" },
          },
        },
      },
    },
  });
  await call(`/api/chats/${chatId}`, {
    method: 'PUT',
    body: { settings: { ...(created.body.settings ?? {}), presetId: toolPreset.body.id } },
  });
  const toolStream = await streamCall(`/api/chats/${chatId}/send`, { text: '开始' });
  assert.ok(toolStream.events.some((event) => event.event === 'tool_start'), '工具调用要作为流事件发出来');
  assert.equal(toolStream.events.at(-1).event, 'done');
  const toolSent = JSON.parse(mockModel.lastRequest.bodyText);
  assert.equal(toolSent.tools?.length, 1, '只带启用着的工具（关掉的那个不发）');
  assert.equal(toolSent.tools[0].type, 'function');
  assert.equal(toolSent.tools[0].function.name, 'game_content');
  assert.equal(toolSent.tool_choice, 'auto');
  assert.deepEqual(toolSent.tools[0].function.parameters.required, ['content'], '表单里的参数要变成 JSON Schema');
  assert.equal(toolSent.tools[0].function.parameters.properties.content.type, 'string');
  assert.ok(!toolSent.messages.some((message) => message.role === 'tool'), 'consume 模式不二次生成，不该有回填的工具消息');
  const toolMessages = await call(`/api/chats/${chatId}/messages`);
  const toolMessage = toolMessages.body.items.at(-1);
  assert.equal(toolMessage.content, '消耗模式正文。', '工具参数要还原成正文');
  assert.equal(toolMessage.extra.toolCallsHidden, true, 'consume 模式下正文本身就是那次调用，不再单独摆一块');
  assert.equal(toolMessage.extra.toolCalls?.[0]?.calls?.[0]?.name, 'game_content');
  assert.deepEqual(toolMessage.extra.toolCalls?.[0]?.calls?.[0]?.arguments, { content: '消耗模式正文。' });
  assert.ok(
    toolMessage.extra.promptNotes?.some((note) => note.includes('函数调用') && note.includes('game_content')),
    'X 光机的说明里要看得到这一轮带了什么工具',
  );

  // 普通模式：工具结果回填成 role=tool，再生成一轮，正文是第二轮的。
  const recursePreset = await call('/api/prompts/presets/import', {
    method: 'POST',
    body: {
      name: '工具回填预设',
      document: {
        function_calling: true,
        prompts: [{ identifier: 'main', role: 'system', content: 'TOOL_RECURSE_TEST' }],
        extensions: {
          SPreset: {
            ToolBindings: {
              t1: {
                enabled: true,
                form: {
                  name: 'dice_roll',
                  description: '掷骰子',
                  parameters: [{ name: 'sides', type: 'integer', description: '几面骰', required: true }],
                },
              },
            },
          },
        },
      },
    },
  });
  await call(`/api/chats/${chatId}`, {
    method: 'PUT',
    body: { settings: { ...(created.body.settings ?? {}), presetId: recursePreset.body.id } },
  });
  await streamCall(`/api/chats/${chatId}/send`, { text: '掷个骰子' });
  const recurseSent = JSON.parse(mockModel.lastRequest.bodyText);
  assert.ok(
    recurseSent.messages.some((message) => message.role === 'assistant' && Array.isArray(message.tool_calls)),
    'assistant 那条要带 tool_calls 一起回填',
  );
  assert.ok(
    recurseSent.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_9'),
    '工具结果要以 role=tool + tool_call_id 回填',
  );
  assert.equal(recurseSent.messages.at(-1).role, 'tool', '回填的工具结果排在最后（模型先看到结果再答）');
  const recurseMessages = await call(`/api/chats/${chatId}/messages`);
  const recurseMessage = recurseMessages.body.items.at(-1);
  assert.equal(recurseMessage.content, '工具结果收到了。', '第二轮生成的才是正文');
  assert.equal(recurseMessage.extra.toolCalls?.length, 1);
  assert.ok(!recurseMessage.extra.toolCallsHidden, '非 consume 模式要在聊天里显示调了什么工具');
  assert.equal(recurseMessage.extra.toolCalls[0].calls[0].name, 'dice_roll');
  assert.deepEqual(recurseMessage.extra.toolCalls[0].calls[0].arguments, { sides: 6 }, '流式拼出来的参数要能解析成对象');
  await call(`/api/chats/${chatId}`, { method: 'PUT', body: { settings: { ...(created.body.settings ?? {}) } } });
  await call(`/api/prompts/presets/${toolPreset.body.id}`, { method: 'DELETE' });
  await call(`/api/prompts/presets/${recursePreset.body.id}`, { method: 'DELETE' });
  await call(`/api/chats/${chatId}`, { method: 'PUT', body: { settings: { ...(created.body.settings ?? {}) } } });
});

test('自动总结：积压够阈值才顺手做一次（事件驱动，不按时间）', async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const card = await call('/api/characters', { method: 'POST', body: { name: '总结测试', description: 'x' } });
  const chat = await call('/api/chats', { method: 'POST', body: { characterId: card.body.id, title: '总结测试' } });
  const chatId = chat.body.id;
  // 阈值调小，省得发太多轮：一轮 = 你一句 + AI 一句 = 2 条
  await call(`/api/chats/${chatId}`, {
    method: 'PUT',
    body: { settings: { ...(chat.body.settings ?? {}), autoSummary: true, autoSummaryEvery: 6 } },
  });
  const smalls = async () => (await call(`/api/memory?chatId=${chatId}&layer=small`)).body.items;
  assert.equal((await smalls()).length, 0, '一开始不该有总结');

  // 两轮 = 4 条，还没到 6：不该花这个钱
  await streamCall(`/api/chats/${chatId}/send`, { text: '第一句' });
  await streamCall(`/api/chats/${chatId}/send`, { text: '第二句' });
  assert.equal((await smalls()).length, 0, '没积压够就不该自动总结');

  // 第三轮之后 = 6 条：该顺手写一条了
  await streamCall(`/api/chats/${chatId}/send`, { text: '第三句' });
  let items = [];
  for (let i = 0; i < 40 && !items.length; i += 1) {
    items = await smalls();
    if (!items.length) await wait(200);
  }
  assert.equal(items.length, 1, `积压够 6 条要自动写一条小总结，实际 ${items.length} 条`);
  assert.ok(String(items[0].title).includes('自动总结'), `标题要认得出是自动写的：${items[0].title}`);

  // 关掉自动总结：再聊两轮也不该新增（这时候要靠"定时总结"兜底，默认没配）
  await call(`/api/chats/${chatId}`, {
    method: 'PUT',
    body: { settings: { ...(chat.body.settings ?? {}), autoSummary: false, autoSummaryEvery: 6 } },
  });
  await streamCall(`/api/chats/${chatId}/send`, { text: '第四句' });
  await streamCall(`/api/chats/${chatId}/send`, { text: '第五句' });
  await wait(500);
  assert.equal((await smalls()).length, 1, '关掉之后不该再自动写');

  await call(`/api/chats/${chatId}`, { method: 'DELETE' });
  await call(`/api/characters/${card.body.id}`, { method: 'DELETE' });
});

test('对话配置：提示词 / 前置词 / 后置词的对话级覆盖真的发到了模型那边', async () => {
  // 卡片级三样写满，对话级再覆盖一份 —— 发出去的必须只有对话里那份。
  const card = await call('/api/characters', {
    method: 'POST',
    body: {
      name: '对话配置测试',
      description: '一只会记账的猫',
      system_prompt: '卡片级的系统提示',
      prefix_text: '卡片的前置',
      suffix_text: '卡片的后置',
    },
  });
  const created = await call('/api/chats', { method: 'POST', body: { characterId: card.body.id, title: '配置测试' } });
  const chatId = created.body.id;

  // 先不动覆盖：卡片级那三样要照常出现（对照组）
  await streamCall(`/api/chats/${chatId}/send`, { text: '第一句' });
  const inheritedSent = JSON.parse(mockModel.lastRequest.bodyText);
  const inheritedUser = [...inheritedSent.messages].reverse().find((message) => message.role === 'user');
  assert.ok(inheritedSent.messages.some((message) => String(message.content).includes('卡片级的系统提示')));
  assert.ok(inheritedUser.content.startsWith('卡片的前置') && inheritedUser.content.endsWith('卡片的后置'));

  // 写上对话级覆盖：三样都换成对话里这份
  const overridden = await call(`/api/chats/${chatId}`, {
    method: 'PUT',
    body: {
      settings: {
        ...(created.body.settings ?? {}),
        cardSystemPrompt: '对话级的系统提示',
        prefixText: '对话的前置',
        suffixText: '对话的后置',
      },
    },
  });
  assert.equal(overridden.body.settings.cardSystemPrompt, '对话级的系统提示', '覆盖值要能存住');
  assert.equal(overridden.body.settings.prefixText, '对话的前置');
  assert.equal(overridden.body.settings.suffixText, '对话的后置');

  await streamCall(`/api/chats/${chatId}/send`, { text: '第二句' });
  const sent = JSON.parse(mockModel.lastRequest.bodyText);
  const allText = sent.messages.map((message) => String(message.content)).join('\n');
  assert.ok(allText.includes('对话级的系统提示'), '对话级覆盖的系统提示要发出去');
  assert.ok(!allText.includes('卡片级的系统提示'), '被盖住的卡片级系统提示不能还发出去');
  const lastUser = [...sent.messages].reverse().find((message) => message.role === 'user');
  assert.ok(lastUser.content.startsWith('对话的前置'), '前置词用对话级那份');
  assert.ok(lastUser.content.endsWith('对话的后置'), '后置词用对话级那份');
  assert.ok(!allText.includes('卡片的前置') && !allText.includes('卡片的后置'), '卡片级那两份不能再出现');

  // X 光机里也要看得出"这一段是对话级覆盖的"
  const xray = await call(`/api/xray?chatId=${chatId}&limit=1`);
  const note = (xray.body.items[0]?.notes ?? []).join(' ');
  assert.ok(note.includes('前置词（这个对话覆盖的）'), `X 光机的说明要标出覆盖来源，实际：${note}`);

  // 覆盖成空串 = 这一样不要（不是退回卡片级）
  await call(`/api/chats/${chatId}`, {
    method: 'PUT',
    body: { settings: { ...(created.body.settings ?? {}), cardSystemPrompt: '', prefixText: '', suffixText: '' } },
  });
  await streamCall(`/api/chats/${chatId}/send`, { text: '第三句' });
  const blankSent = JSON.parse(mockModel.lastRequest.bodyText);
  const blankText = blankSent.messages.map((message) => String(message.content)).join('\n');
  assert.ok(!blankText.includes('卡片级的系统提示') && !blankText.includes('对话级的系统提示'), '覆盖成空 → 这一轮不带角色系统提示');
  assert.ok(!blankText.includes('卡片的前置') && !blankText.includes('对话的前置'), '覆盖成空 → 前置词也不要');
  const blankUser = [...blankSent.messages].reverse().find((message) => message.role === 'user');
  assert.equal(blankUser.content, '第三句', '前置 / 后置都空掉之后，用户消息就是原文');

  await call(`/api/chats/${chatId}`, { method: 'DELETE' });
  await call(`/api/characters/${card.body.id}`, { method: 'DELETE' });
});

test('模块零件：世界书条目 / 正则脚本 / 背景图挂上就生效，还能导出导入', async () => {
  // 先往素材库放一张图当背景
  const asset = await call('/api/assets', {
    method: 'POST',
    body: { name: '背景', kind: 'image', data: MOCK_PNG.toString('base64') },
  });
  assert.equal(asset.status, 201, JSON.stringify(asset.body));

  // 一个模块带三样零件：世界书（一行语法，不写 keys = 常开）、正则（只在输出上把 pong 改成 PONG!）、背景图
  const created = await call('/api/prompts/snippets', {
    method: 'POST',
    body: {
      title: '带零件的模块',
      description: '三样零件都要生效',
      worldbookText: '### 银牌酒馆\n镇上那家挂着银牌的酒馆，老板娘叫阿黛尔。',
      regex: [{ findRegex: '/她/g', replaceString: 'TA', placement: [2] }],
      background: asset.body.id,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const moduleId = created.body.id;
  assert.equal(created.body.worldbook.length, 1, '一行语法要解析成条目');
  assert.equal(created.body.worldbook[0].content, '镇上那家挂着银牌的酒馆，老板娘叫阿黛尔。');
  assert.equal(created.body.regex.length, 1);
  assert.equal(created.body.background, asset.body.id);

  // 挂到对话上
  const card = await call('/api/characters', { method: 'POST', body: { name: '零件测试', description: '测试卡' } });
  const chat = await call('/api/chats', { method: 'POST', body: { characterId: card.body.id, title: '零件测试' } });
  await call(`/api/chats/${chat.body.id}/modules`, { method: 'PUT', body: { ids: [moduleId] } });

  const attached = await call(`/api/chats/${chat.body.id}/modules`);
  assert.equal(attached.body.attachedIds.length, 1);
  assert.equal(attached.body.background, asset.body.id, '背景图要回给界面（聊天页铺在后面）');
  assert.ok((attached.body.notes ?? []).some((note) => note.includes('世界书条目')), '说明里要讲清楚带了世界书');

  // 真跑一轮：世界书内容要进提示词，正则要作用在输出上
  await streamCall(`/api/chats/${chat.body.id}/send`, { text: '你好' });
  const sent = JSON.parse(mockModel.lastRequest.bodyText);
  const sentText = sent.messages.map((message) => String(message.content)).join('\n');
  assert.ok(sentText.includes('老板娘叫阿黛尔'), `模块带的世界书条目要进提示词，实际：${sentText.slice(0, 400)}`);
  const messages = await call(`/api/chats/${chat.body.id}/messages`);
  assert.equal(messages.body.items.at(-1).content, 'TA点了点头。', '模块带的正则要作用在回复上');

  // 导出：一个自包含的 JSON
  const exported = await call(`/api/prompts/snippets/${moduleId}/export`);
  assert.equal(exported.status, 200);
  assert.equal(exported.body.kind, 'silver-tavern-module');
  assert.equal(exported.body.module.worldbook.length, 1);
  assert.equal(exported.body.module.background, asset.body.id);

  // 导入：默认按"别人的模块"存（正则要信任过才跑）
  const imported = await call('/api/prompts/snippets/import', { method: 'POST', body: { document: exported.body } });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  assert.equal(imported.body.source, 'imported');
  assert.equal(imported.body.regex.length, 1);
  assert.equal(imported.body.worldbookText, exported.body.module.worldbookText);

  // 「存为模块」：把对话级配置存成一个能挂到别处的模块
  await call(`/api/chats/${chat.body.id}`, {
    method: 'PUT',
    body: { settings: { ...(chat.body.settings ?? {}), prefixText: '每轮都要提到银牌', suffixText: '结尾别用问句' } },
  });
  const asModule = await call('/api/prompts/snippets/from-chat', { method: 'POST', body: { chatId: chat.body.id } });
  assert.equal(asModule.status, 201, JSON.stringify(asModule.body));
  assert.ok(asModule.body.body.includes('每轮都要提到银牌'), '前置词要进模块的提示词');
  assert.ok(asModule.body.body.includes('结尾别用问句'), '后置词也要带上');
  assert.equal(asModule.body.source, 'original', '自己存的是"自己的模块"');

  for (const id of [moduleId, imported.body.id, asModule.body.id]) await call(`/api/prompts/snippets/${id}`, { method: 'DELETE' });
  await call(`/api/chats/${chat.body.id}`, { method: 'DELETE' });
  await call(`/api/characters/${card.body.id}`, { method: 'DELETE' });
  await call(`/api/assets/${asset.body.id}`, { method: 'DELETE' });
});

test('召回：参考资料导入后，每轮真的被召回进提示词（databank 段）', async () => {
  // 以前 assemblePrompt 支持 databankEntries，但没有任何调用方传它 ——
  // "参考资料"这一段在真实对话里永远是空的。这个用例就是钉住那根线。
  const doc = await call('/api/databank', {
    method: 'POST',
    body: {
      title: '灯塔档案',
      content: '北角的灯塔看守人叫老陈。他养了一只会叼钥匙的乌鸦，名叫小灰。灯塔每晚会亮三次。',
    },
  });
  assert.equal(doc.status, 201);
  assert.ok(doc.body.index?.chunks >= 1, '导入就要切片建索引');
  const docId = doc.body.doc.id;

  const list = await call('/api/databank');
  assert.ok(list.body.items.some((item) => item.id === docId && item.title === '灯塔档案'));
  const one = await call(`/api/databank/${docId}`);
  assert.ok(one.body.content.includes('老陈'), '原文要能取回来（向量只是它的副本）');

  const card = await call('/api/characters', { method: 'POST', body: { name: '阿海', description: '灯塔下的渔夫', first_mes: '「风大了。」' } });
  const chat = await call('/api/chats', { method: 'POST', body: { characterId: card.body.id } });
  const sent = await streamCall(`/api/chats/${chat.body.id}/send`, { text: '灯塔的看守人是谁？' });
  assert.ok(sent.events.some((event) => event.event === 'done'), '这一轮要能跑完');

  const xrayList = await call(`/api/xray?chatId=${chat.body.id}&limit=5`);
  const snapshot = await call(`/api/xray/${xrayList.body.items[0].id}`);
  assert.ok(
    snapshot.body.sections.some((section) => section.id === 'databank' && section.content.includes('老陈')),
    '参考资料必须真的进提示词（databank 段）—— 这是这一轮改动的核心',
  );

  // 向量页手动检索也应该能搜到
  const search = await call('/api/vectors/search', { method: 'POST', body: { query: '灯塔 看守人', topK: 5 } });
  assert.ok(search.body.items.some((item) => item.collection === 'databank' && item.content.includes('老陈')));

  // 删资料 → 它的片段也要跟着消失
  assert.equal((await call(`/api/databank/${docId}`, { method: 'DELETE' })).status, 200);
  const after = await call('/api/vectors/search', { method: 'POST', body: { query: '灯塔 看守人', topK: 5 } });
  assert.ok(!after.body.items.some((item) => item.sourceId === docId), '删了资料不能留下孤儿片段');

  await call(`/api/chats/${chat.body.id}`, { method: 'DELETE' });
  await call(`/api/characters/${card.body.id}`, { method: 'DELETE' });
});

test('采样参数：按适配器校验、越界挡住、并且真的发到提供方（绑定可覆盖）', async () => {
  // 1) 参数表按适配器分开，接口要把它发给界面
  const catalog = await call('/api/providers');
  assert.ok(catalog.body.adapterParams, '要把每个适配器的参数表发给界面');
  const openaiKeys = catalog.body.adapterParams.openai.params.map((item) => item.key);
  const anthropicKeys = catalog.body.adapterParams.anthropic.params.map((item) => item.key);
  assert.ok(openaiKeys.includes('frequency_penalty'), 'OpenAI 有 frequency_penalty');
  assert.ok(!anthropicKeys.includes('frequency_penalty'), 'Anthropic 不该出现 frequency_penalty');
  assert.ok(anthropicKeys.includes('top_k'), 'Anthropic 有 top_k');

  // 2) 越界 / 枚举外的值要挡住，并且说清是哪个字段
  const bad = await call('/api/providers', {
    method: 'POST',
    body: { label: '参数越界', kind: 'chat', adapter: 'openai', baseUrl: mockBase, model: 'mock-small', params: { temperature: 9 } },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /temperature/, '报错要指出是哪个字段');

  const badEnum = await call('/api/providers', {
    method: 'POST',
    body: { label: '枚举错', kind: 'chat', adapter: 'openai', baseUrl: mockBase, model: 'mock-small', params: { reasoning_effort: 'ultra' } },
  });
  assert.equal(badEnum.status, 400);

  // 3) 正常保存 → 取回来要带着参数
  const created = await call('/api/providers', {
    method: 'POST',
    body: {
      label: '带采样参数',
      kind: 'chat',
      adapter: 'openai',
      baseUrl: mockBase,
      model: 'mock-small',
      params: { temperature: 0.42, max_tokens: 3000, stop: ['###'] },
    },
  });
  assert.equal(created.status, 201);
  const fetched = await call(`/api/providers/${created.body.id}`);
  assert.equal(fetched.body.params.temperature, 0.42);
  assert.equal(fetched.body.params.max_tokens, 3000);
  assert.deepEqual(fetched.body.params.stop, ['###']);

  // 4) 真的发出去：开个对话、发一句，看 mock 收到的请求体
  const card = await call('/api/characters', { method: 'POST', body: { name: '参数测试', description: '测试用', first_mes: '。' } });
  const chat = await call('/api/chats', { method: 'POST', body: { characterId: card.body.id } });
  // 绑定层再覆盖一个温度：绑定 > 提供方
  await call('/api/models/bindings', {
    method: 'PUT',
    body: { scope: 'chat', targetId: chat.body.id, providerId: created.body.id, model: 'mock-small', params: { temperature: 0.11 } },
  });
  await streamCall(`/api/chats/${chat.body.id}/send`, { text: '随便说一句' });
  const payload = JSON.parse(mockModel.lastRequest.bodyText);
  assert.equal(payload.temperature, 0.11, '绑定层的覆盖要生效（绑定 > 提供方）');
  assert.equal(payload.max_tokens, 3000, '提供方的参数要继承下来');
  assert.deepEqual(payload.stop, ['###'], '数组型参数也要原样发出去');

  // 5) 绑定的参数本身也要过校验
  const badBinding = await call('/api/models/bindings', {
    method: 'PUT',
    body: { scope: 'chat', targetId: chat.body.id, providerId: created.body.id, params: { temperature: 7 } },
  });
  assert.equal(badBinding.status, 400);

  await call(`/api/chats/${chat.body.id}`, { method: 'DELETE' });
  await call(`/api/characters/${card.body.id}`, { method: 'DELETE' });
  await call(`/api/providers/${created.body.id}`, { method: 'DELETE' });
});

test('提供方参数覆盖：不认的参数丢掉（连预设带来的）、专属参数按路径发出去', async () => {
  const created = await call('/api/providers', {
    method: 'POST',
    body: { label: '覆盖测试家', kind: 'chat', adapter: 'openai', baseUrl: mockBase, model: 'mock-small' },
  });
  const providerId = created.body.id;
  // 模拟"这家换了代"：不认 seed / top_k，多了个 thinking_level
  const saved = await call(`/api/providers/${providerId}/param-overrides`, {
    method: 'PUT',
    body: {
      disabled: ['seed', 'top_k'],
      custom: [{ key: 'thinking_level', label: '思考档位', type: 'enum', options: ['low', 'high'], path: 'top' }],
    },
  });
  assert.deepEqual(saved.body.disabled, ['seed', 'top_k']);
  assert.equal(saved.body.custom[0].path, 'top');
  const readBack = await call(`/api/providers/${providerId}/param-overrides`);
  assert.deepEqual(readBack.body.custom[0].key, 'thinking_level', '自定义参数要能存回来');

  // 试探：这家认哪些参数（假模型什么都认，所以这里只验证"逐个数都试过了"）
  const probe = await call(`/api/providers/${providerId}/probe-params`, { method: 'POST', body: { params: ['temperature', 'seed'] } });
  assert.equal(probe.status, 200);
  assert.deepEqual(probe.body.results.map((item) => item.key), ['temperature', 'seed'], '给几个就试几个');
  assert.equal(probe.body.ok, 2, '假模型都认');

  // 提供方自己的参数里把这些都填上（thinking_level 是"表外字段"，按原样保留）
  await call(`/api/providers/${providerId}`, {
    method: 'PUT',
    body: { params: { temperature: 0.7, seed: 7, top_k: 40, thinking_level: 'low' } },
  });

  const card = await call('/api/characters', { method: 'POST', body: { name: '覆盖测试', description: 'x' } });
  const chat = await call('/api/chats', { method: 'POST', body: { characterId: card.body.id, title: '覆盖测试' } });
  await call('/api/models/bindings', { method: 'PUT', body: { scope: 'chat', targetId: chat.body.id, providerId, model: 'mock-small' } });
  await streamCall(`/api/chats/${chat.body.id}/send`, { text: '你好' });
  const sent = JSON.parse(mockModel.lastRequest.bodyText);
  assert.equal(sent.seed, undefined, '这家不认的 seed 不该发出去');
  assert.equal(sent.top_k, undefined, 'top_k 同理');
  assert.equal(sent.thinking_level, 'low', '专属参数按 path=top 发在请求体顶层');
  assert.equal(sent.temperature, 0.7, '没被覆盖的参数照旧发');

  // 按模型名自动禁用：换成 gemini-3.7-flash 这个名字之后，temperature/top_p/top_k 都不该再发
  await call(`/api/providers/${providerId}/param-overrides`, { method: 'PUT', body: { disabled: [], custom: [] } });
  await call(`/api/providers/${providerId}`, {
    method: 'PUT',
    body: { model: 'gemini-3.7-flash', params: { temperature: 0.9, top_p: 0.9, top_k: 40, seed: 7, max_tokens: 512 } },
  });
  // 绑定层写死的是 mock-small，会盖过提供方的模型名 —— 这里也要跟着改，才走"按模型名"的规则
  await call('/api/models/bindings', { method: 'PUT', body: { scope: 'chat', targetId: chat.body.id, providerId, model: 'gemini-3.7-flash' } });
  await streamCall(`/api/chats/${chat.body.id}/send`, { text: '再来一句' });
  const sentGemini = JSON.parse(mockModel.lastRequest.bodyText);
  assert.equal(sentGemini.temperature, undefined, 'gemini-3.7-flash 这代不收 temperature，要自动丢掉');
  assert.equal(sentGemini.top_p, undefined);
  assert.equal(sentGemini.top_k, undefined);
  assert.equal(sentGemini.seed, 7, 'seed 照旧发');
  assert.equal(sentGemini.max_tokens, 512, 'max_tokens 照旧发');

  await call(`/api/providers/${providerId}/param-overrides`, { method: 'PUT', body: { disabled: [], custom: [] } });
  await call(`/api/chats/${chat.body.id}`, { method: 'DELETE' });
  await call(`/api/characters/${card.body.id}`, { method: 'DELETE' });
  await call(`/api/providers/${providerId}`, { method: 'DELETE' });
});

test('玩卡区：群聊四种策略、每成员各自模型、提示词不串味', async () => {
  const providers = await call('/api/providers');
  const first = providers.body.items.find((item) => item.label === '本地假模型');
  const second = providers.body.items.find((item) => item.label === '本地假模型·大');
  assert.ok(first && second, '前面的用例应该已经建好两个提供方');
  await call('/api/models/bindings', { method: 'PUT', body: { scope: 'character', targetId: 'c-cat', providerId: first.id } });
  await call('/api/models/bindings', { method: 'PUT', body: { scope: 'character', targetId: 'c-fox', providerId: second.id } });

  const created = await call('/api/chats', {
    method: 'POST',
    body: {
      title: '群聊测试',
      isGroup: true,
      groupStrategy: 'list',
      groupMode: 'swap',
      greetings: false,
      members: [
        { characterId: 'c-cat', name: '阿狸', card: { name: '阿狸', description: '猫娘设定' } },
        { characterId: 'c-fox', name: '小白', card: { name: '小白', description: '狐狸设定' } },
      ],
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.isGroup, true);
  const chatId = created.body.id;

  const plan = await call(`/api/group/${chatId}/next`);
  assert.equal(plan.body.items.length, 2);
  assert.equal(plan.body.multiModel, true, '两个成员绑了两个模型');
  assert.equal(plan.body.order.length, 2, '列表策略：两个人都要说');

  const streamed = await streamCall(`/api/chats/${chatId}/send`, { text: '你们好' });
  const starts = streamed.events.filter((event) => event.event === 'start');
  assert.deepEqual(starts.map((event) => event.data.name), ['阿狸', '小白']);
  assert.equal(starts[0].data.providerId, first.id);
  assert.equal(starts[1].data.providerId, second.id);

  // 提示词隔离：阿狸那一轮的快照里不能出现小白的人设
  const xrayList = await call(`/api/xray?chatId=${chatId}`);
  const details = [];
  for (const item of xrayList.body.items) details.push((await call(`/api/xray/${item.id}`)).body);
  const catSnapshot = details.find((snapshot) => snapshot.text.includes('猫娘设定'));
  assert.ok(catSnapshot, '能找到阿狸那轮的提示词快照');
  assert.ok(!catSnapshot.text.includes('狐狸设定'), 'A 的专属设定不能串给 B');

  const groupInfo = await call(`/api/group/${chatId}`);
  const fox = groupInfo.body.members.find((member) => member.name === '小白');
  const cat = groupInfo.body.members.find((member) => member.name === '阿狸');
  assert.ok(fox && cat);

  // 静音：只剩另一个说话
  const muted = await call(`/api/group/members/${fox.id}`, { method: 'PUT', body: { muted: true } });
  assert.equal(muted.body.muted, true);
  const plan2 = await call(`/api/group/${chatId}/next`);
  assert.equal(plan2.body.order.length, 1);
  const streamed2 = await streamCall(`/api/chats/${chatId}/send`, { text: '小白？' });
  assert.equal(streamed2.events.filter((event) => event.event === 'start').length, 1);

  const auto = await call(`/api/group/${chatId}/auto`, { method: 'POST', body: { active: true } });
  assert.equal(auto.status, 200);
  assert.ok(auto.body.delay >= 1);

  const strategy = await call(`/api/group/${chatId}/strategy`, { method: 'PUT', body: { strategy: 'manual', mode: 'append', autoModeDelay: 3 } });
  assert.equal(strategy.body.groupStrategy, 'manual');
  assert.equal(strategy.body.groupMode, 'append');
  assert.equal(strategy.body.autoModeDelay, 3);

  const manual = await streamCall(`/api/chats/${chatId}/send`, { text: '谁说？' });
  assert.equal(manual.events.find((event) => event.event === 'done').data.pending, true, '手动模式不指定人就不生成');

  const forced = await streamCall(`/api/chats/${chatId}/send`, { text: '阿狸你说', memberId: cat.id });
  assert.equal(forced.events.filter((event) => event.event === 'start').length, 1);

  const director = await call(`/api/narration/${chatId}/director`, { method: 'POST', body: { text: '屋顶塌了', mode: 'narrator' } });
  assert.equal(director.body.message.role, 'narrator');
  const injection = await call(`/api/narration/${chatId}/director`, { method: 'POST', body: { text: '让小白退场', mode: 'director' } });
  assert.match(injection.body.injection, /导演指令/);

  const groups = await call('/api/group');
  assert.ok(groups.body.items.some((item) => item.id === chatId), '群聊列表能列出它');
});

// ---------- 野路子渠道：公益站 / 中转站 / Vertex / CLI 代理 ----------

test('鉴权方式目录', async () => {
  const res = await call('/api/providers/auth-styles');
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 7);
  assert.equal(res.body.defaults.openai, 'bearer');
});

test('中转站：自定义请求头 + 裸 key 鉴权真的发出去了', async () => {
  const created = await call('/api/providers', {
    method: 'POST',
    body: {
      label: '某中转站',
      kind: 'chat',
      adapter: 'openai',
      baseUrl: mockBase,
      model: 'mock-small',
      apiKey: 'sk-raw-value',
      authStyle: 'raw',
      headers: { 'X-Title': 'Silver Tavern' },
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.authStyle, 'raw');
  assert.deepEqual(created.body.headers, { 'X-Title': 'Silver Tavern' });

  const ping = await call('/api/models/ping', { method: 'POST', body: { providerId: created.body.id } });
  assert.equal(ping.body.text, 'pong');
  assert.equal(mockModel.lastRequest.headers.authorization, 'sk-raw-value', 'raw 模式不该带 Bearer 前缀');
  assert.equal(mockModel.lastRequest.headers['x-title'], 'Silver Tavern');
});

test('中转站：把 key 放在 URL 参数上（query 模式）', async () => {
  const created = await call('/api/providers', {
    method: 'POST',
    body: {
      label: 'query 鉴权站',
      kind: 'chat',
      adapter: 'openai',
      baseUrl: mockBase,
      model: 'mock-small',
      apiKey: 'sk-query-value',
      authStyle: 'query',
    },
  });
  const ping = await call('/api/models/ping', { method: 'POST', body: { providerId: created.body.id } });
  assert.equal(ping.body.text, 'pong');
  assert.match(mockModel.lastRequest.url, /key=sk-query-value/);
  assert.equal(mockModel.lastRequest.headers.authorization, undefined);
});

test('Vertex：express 模式走 publishers/google/models 路径', async () => {
  const created = await call('/api/providers', {
    method: 'POST',
    body: {
      label: 'Vertex Gemini',
      kind: 'chat',
      adapter: 'vertex',
      baseUrl: mockBase,
      model: 'gemini-test',
      apiKey: 'vk-1',
      params: { vertexMode: 'express' },
      authStyle: 'query',
    },
  });
  assert.equal(created.status, 201);

  const ping = await call('/api/models/ping', { method: 'POST', body: { providerId: created.body.id } });
  assert.equal(ping.status, 200, JSON.stringify(ping.body));
  assert.equal(ping.body.text, 'pong');
  assert.match(mockModel.lastRequest.url, /\/v1\/publishers\/google\/models\/gemini-test:streamGenerateContent/);
  assert.match(mockModel.lastRequest.url, /key=vk-1/);

  const tested = await call(`/api/providers/${created.body.id}/test`, { method: 'POST' });
  assert.equal(tested.body.ok, true);
  assert.equal(tested.body.via, 'chat', 'Vertex 不能列模型，测试要退化成真发一次请求');
});

test('Vertex：服务账号模式允许不填 baseUrl，缺 project 时给出可读错误', async () => {
  const created = await call('/api/providers', {
    method: 'POST',
    body: {
      label: 'Vertex SA',
      kind: 'chat',
      adapter: 'vertex',
      baseUrl: '',
      model: 'gemini-2.5-pro',
      params: {
        vertexMode: 'serviceAccount',
        serviceAccount: JSON.stringify({ client_email: 'a@b.iam.gserviceaccount.com', private_key: 'not-a-real-key' }),
      },
    },
  });
  assert.equal(created.status, 201, '服务账号模式允许不填 baseUrl');
  const ping = await call('/api/models/ping', { method: 'POST', body: { providerId: created.body.id } });
  assert.equal(ping.status, 502);
  assert.ok(ping.body.error.message.length > 0);
});

test('CLI 渠道：调用时自动拉起本地代理，用完能停', async () => {
  const fixture = path.join(process.cwd(), 'tests', 'fixtures', 'mock-openai-server.mjs');
  const port = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const found = probe.address().port;
      probe.close(() => resolve(found));
    });
  });

  const created = await call('/api/providers', {
    method: 'POST',
    body: {
      label: '本地 CLI 代理',
      kind: 'chat',
      adapter: 'openai',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'mock',
      authStyle: 'none',
      launcher: { command: process.execPath, args: [fixture, String(port)], port },
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.launcher.port, port);

  const before = await call(`/api/providers/${created.body.id}/launcher`);
  assert.equal(before.body.status.running, false);

  // 关键：没人手动启动代理，ping 自己把它拉起来了
  const ping = await call('/api/models/ping', { method: 'POST', body: { providerId: created.body.id } });
  assert.equal(ping.status, 200, JSON.stringify(ping.body));
  assert.equal(ping.body.text, 'pong');

  const after = await call(`/api/providers/${created.body.id}/launcher`);
  assert.equal(after.body.status.running, true);
  assert.equal(after.body.status.ready, true);
  assert.ok(after.body.status.logs.length > 0, '应该留下启动日志');

  const stopped = await call(`/api/providers/${created.body.id}/stop`, { method: 'POST' });
  assert.equal(stopped.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const final = await call(`/api/providers/${created.body.id}/launcher`);
  assert.equal(final.body.status.running, false);
});

test('玩卡区：导出 / 导入走界面用的那条路径（JSON body）', async () => {
  const chats = await call('/api/chats');
  const chat = chats.body.items.find((item) => item.messageCount > 0);
  assert.ok(chat, '前面应该已经有带消息的对话');

  const exported = await call(`/api/chats/${chat.id}/export?format=jsonl`, { raw: true });
  assert.equal(exported.status, 200);
  assert.match(exported.type, /ndjson|text\/plain/);
  assert.match(exported.body, /"user_name"/);

  // 界面「导入 JSONL」就是发 JSON body 的，这条路径必须通
  const imported = await call('/api/chats/import', { method: 'POST', body: { text: exported.body } });
  assert.equal(imported.status, 201, '界面用 JSON body 导入必须成功');
  assert.ok(imported.body.messageCount > 0);
  assert.equal((await call(`/api/chats/${imported.body.id}`, { method: 'DELETE' })).status, 204);

  // 用户丢进来一个不认识的文件：要报 400 让他看懂，不是 500
  const bad = await call('/api/chats/import', { method: 'POST', body: { text: '这不是对话文件' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'VALIDATION_ERROR');

  const empty = await call('/api/chats/import', { method: 'POST', body: {} });
  assert.equal(empty.status, 400);
});

// ---------- 工具箱 3.1：ComfyUI 端到端 ----------

/** 一份最小的 ComfyUI「API 格式」工作流，形状与真实导出一致。 */
function comfyWorkflow() {
  return {
    3: { class_type: 'KSampler', inputs: { seed: 1, steps: 20, cfg: 7, denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
    5: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 768, batch_size: 1 } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: '{{char}}, {{scene}}, {{emotion}}, 1girl', clip: ['4', 1] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: 'lowres, bad anatomy', clip: ['4', 1] } },
    9: { class_type: 'SaveImage', inputs: { filename_prefix: 'tavern', images: ['8', 0] } },
  };
}

test('工具箱：ComfyUI 连接、工作流导入与占位符预览', async () => {
  // 连不上时给的是人话，而不是 500
  const dead = await call('/api/comfy/test', { method: 'POST', body: { baseUrl: 'http://127.0.0.1:9', timeoutMs: 1500 } });
  assert.equal(dead.status, 200);
  assert.equal(dead.body.ok, false);
  assert.match(dead.body.error, /连不上|超时|端口/);

  const ok = await call('/api/comfy/test', { method: 'POST', body: { baseUrl: mockComfy.url } });
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.stats.comfyuiVersion, '0.3.99-mock');
  assert.equal(ok.body.stats.devices[0].name, 'mock-gpu');

  // 存成设置后，状态接口就能连上并报队列
  const saved = await call('/api/comfy/config', {
    method: 'PUT',
    body: { 'comfy.baseUrl': mockComfy.url, 'comfy.enabled': true, 'comfy.trigger': 'marker' },
  });
  assert.equal(saved.body.settings['comfy.enabled'], true);
  assert.equal(saved.body.settings['comfy.trigger'], 'marker');

  const status = await call('/api/comfy/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.ok, true, status.body.error ?? '');
  assert.equal(status.body.enabled, true);
  assert.equal(status.body.kinds.length, 6);
  assert.equal(status.body.queue.total, 0);

  const config = await call('/api/comfy/config');
  assert.ok(config.body.placeholders.some((item) => item.key === 'char'));
  assert.ok(config.body.clientId, '要有一个固定的 clientId 才能收到自己那批图的事件');

  const imported = await call('/api/comfy/workflows', {
    method: 'POST',
    body: { name: '立绘', kind: 'portrait', workflow: comfyWorkflow(), seed: 31337 },
  });
  assert.equal(imported.status, 201);
  const workflowId = imported.body.id;
  assert.deepEqual(imported.body.placeholders, ['char', 'scene', 'emotion']);
  assert.ok(imported.body.bindings.length >= 8, '导入时要自动标出可填参数');
  assert.equal((await call('/api/comfy/workflows')).body.total, 1);

  // 内置示例工作流：列出来 → 一键添加 → 能直接跑（蓝图 3.1「预设几个常用工作流」）
  const presets = await call('/api/comfy/presets');
  assert.equal(presets.status, 200);
  assert.ok(presets.body.total >= 5);
  assert.ok(presets.body.items.some((item) => item.kind === 'inpaint'), '要预置局部重绘');
  const preset = presets.body.items.find((item) => item.kind === 'background');
  assert.ok(preset.placeholders.includes('scene'), '背景预设要带 {{scene}} 占位符');
  assert.equal(preset.installed, false);
  const addedPreset = await call(`/api/comfy/presets/${preset.id}`, { method: 'POST', body: {} });
  assert.equal(addedPreset.status, 201);
  assert.equal(addedPreset.body.kind, 'background');
  assert.ok(addedPreset.body.bindings.some((binding) => binding.input === 'ckpt_name'), '要能改模型名');
  assert.equal((await call('/api/comfy/workflows')).body.total, 2);
  assert.equal((await call('/api/comfy/presets')).body.items.find((item) => item.id === preset.id).installed, true);
  assert.equal((await call(`/api/comfy/workflows/${addedPreset.body.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await call('/api/comfy/workflows')).body.total, 1);

  // 参数绑定面板靠这个列表：全部输入 + 哪些已经绑定，界面据此加 / 删绑定
  const bindingInputs = (await call(`/api/comfy/workflows/${workflowId}/inputs`)).body.items;
  assert.ok(bindingInputs.every((item) => typeof item.bound === 'boolean'));
  assert.equal(bindingInputs.filter((item) => item.bound).length, imported.body.bindings.length, 'bound 标记要和绑定表对上');
  const wasBound = bindingInputs.find((item) => item.bound === true && item.type === 'string' && item.value);
  assert.ok(wasBound, '应该有一个已绑定的文本输入，用来测删除 / 加回');
  // 删掉一个绑定：bound 要跟着变
  const keptBindings = imported.body.bindings
    .filter((binding) => !(binding.nodeId === wasBound.nodeId && binding.input === wasBound.input))
    .map((binding) => ({ nodeId: binding.nodeId, input: binding.input, label: binding.label, type: binding.type, value: binding.value }));
  await call(`/api/comfy/workflows/${workflowId}`, { method: 'PUT', body: { bindings: keptBindings } });
  const afterRemove = (await call(`/api/comfy/workflows/${workflowId}/inputs`)).body.items;
  assert.equal(afterRemove.find((item) => item.nodeId === wasBound.nodeId && item.input === wasBound.input).bound, false);
  assert.ok(afterRemove.some((item) => item.bound === false), '删掉绑定后它要变成"可添加"');
  // 再加回来：从"全部输入"里挑一个没绑的
  const toAdd = afterRemove.find((item) => !item.bound && item.type === 'string' && item.value);
  await call(`/api/comfy/workflows/${workflowId}`, {
    method: 'PUT',
    body: { bindings: [...keptBindings, { nodeId: toAdd.nodeId, input: toAdd.input, label: `${toAdd.classType}.${toAdd.input}`, type: 'text', value: toAdd.value }] },
  });
  assert.equal((await call(`/api/comfy/workflows/${workflowId}/inputs`)).body.items.find((item) => item.nodeId === toAdd.nodeId && item.input === toAdd.input).bound, true);
  // 还原成导入时的绑定表，后面的出图测试还用这条工作流
  await call(`/api/comfy/workflows/${workflowId}`, {
    method: 'PUT',
    body: {
      bindings: imported.body.bindings.map((binding) => ({ nodeId: binding.nodeId, input: binding.input, label: binding.label, type: binding.type, value: binding.value })),
    },
  });

  const inputs = await call(`/api/comfy/workflows/${workflowId}/inputs`);
  assert.ok(inputs.body.total > 8);
  assert.ok(inputs.body.items.some((item) => item.nodeId === '3' && item.input === 'seed' && item.bound));

  const preview = await call(`/api/comfy/workflows/${workflowId}/preview`, {
    method: 'POST',
    body: { context: { char: '阿狸', scene: '旧书店', emotion: '好奇' }, values: { '5.width': 768 } },
  });
  assert.match(preview.body.prompt['6'].inputs.text, /阿狸/);
  assert.match(preview.body.prompt['6'].inputs.text, /旧书店/);
  assert.equal(preview.body.prompt['5'].inputs.width, 768);
  assert.equal(preview.body.prompt['3'].inputs.seed, 31337, '工作流上固定的种子要生效');

  const bad = await call('/api/comfy/workflows', { method: 'POST', body: { name: 'x', workflow: { hello: 1 } } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'VALIDATION_ERROR');
  assert.match(bad.body.error.message, /API 格式/);
});

test('工具箱：出图跑通队列 / 进度 / 入库，并且能拿回图片字节', async () => {
  const workflows = await call('/api/comfy/workflows');
  const workflow = workflows.body.items.find((item) => item.kind === 'portrait');
  assert.ok(workflow);

  const started = await call('/api/comfy/run', {
    method: 'POST',
    body: { workflowId: workflow.id, chatId: 'chat-comfy', messageId: 'msg-comfy', context: { char: '阿狸' } },
  });
  assert.equal(started.status, 202);
  assert.equal(started.body.status, 'queued');
  assert.ok(started.body.promptId, '要记下 ComfyUI 的 prompt_id');

  const queue = await call('/api/comfy/queue');
  assert.equal(queue.status, 200);
  assert.ok(Array.isArray(queue.body.runs));

  // 假的 ComfyUI 故意慢 900ms，这里等它跑完（同时测轮询收尾）
  let finished = null;
  for (let i = 0; i < 30 && !finished; i += 1) {
    const one = await call(`/api/comfy/runs/${started.body.id}`);
    if (one.body.status === 'done' || one.body.status === 'error') finished = one.body;
    else await new Promise((resolve) => setTimeout(resolve, 400));
  }
  assert.ok(finished, '应该在几秒内跑完');
  assert.equal(finished.status, 'done', finished.error ?? '');
  assert.equal(finished.images.length, 1);
  assert.equal(finished.messageId, 'msg-comfy');
  // 进度来自 WebSocket（假的 ComfyUI 一连上就推 executing / progress）
  assert.equal(finished.progressMax, 10);
  assert.ok(finished.nodeId, 'WebSocket 上的当前节点要记下来');

  const assetId = finished.images[0].assetId;
  // 图片要按原始字节取回来，前端 <img> 直接指这个地址
  const fileResponse = await fetch(`${base}/api/assets/${assetId}/file`);
  assert.equal(fileResponse.status, 200);
  assert.equal(fileResponse.headers.get('content-type'), 'image/png');
  const bytes = Buffer.from(await fileResponse.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString('hex'), '89504e47', 'PNG 魔数要对得上');
  assert.ok(bytes.length > 60);

  const meta = await call(`/api/assets/${assetId}`);
  assert.equal(meta.body.kind, 'image');
  assert.equal(meta.body.mime, 'image/png');
  assert.equal(meta.body.meta.source, 'comfyui');

  const list = await call('/api/assets');
  assert.ok(list.body.total >= 1);

  // 参考图（图生图要用）走上传接口；同样的字节按内容哈希复用同一条记录
  const refBytes = Buffer.from('reference-image-bytes').toString('base64');
  const uploaded = await call('/api/assets', { method: 'POST', body: { data: refBytes, mime: 'image/png', name: 'ref.png' } });
  assert.equal(uploaded.status, 201);
  const again = await call('/api/assets', { method: 'POST', body: { data: refBytes, mime: 'image/png', name: 'ref-2.png' } });
  assert.equal(again.body.id, uploaded.body.id, '同内容只存一份');
  assert.equal((await call(`/api/assets/${uploaded.body.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await call(`/api/assets/${uploaded.body.id}`)).status, 404);

  // 出图记录按对话能查回来
  const runs = await call('/api/comfy/runs?chatId=chat-comfy');
  assert.equal(runs.body.total, 1);
  assert.equal(runs.body.items[0].percent, 100);
});

test('工具箱：工作流能自己标出正向 / 负向提示词', async () => {
  const workflows = await call('/api/comfy/workflows');
  const workflow = workflows.body.items.find((item) => item.kind === 'portrait');
  assert.ok(workflow, '前面那条立绘工作流还在');
  // KSampler.positive → 6，KSampler.negative → 7（见 comfyWorkflow()）
  assert.equal(workflow.prompts.positive.nodeId, '6');
  assert.equal(workflow.prompts.positive.input, 'text');
  assert.equal(workflow.prompts.negative.nodeId, '7');
  assert.ok(workflow.prompts.positive.value.length > 0, '要把当前文本一起带出来，界面才好直接编辑');

  // 界面上改提示词 = 写进绑定值（没有绑定就现加一条），预览里立刻能看见
  const bindings = workflow.bindings.map((binding) => ({ ...binding }));
  const upsert = (nodeId, input, value) => {
    const found = bindings.find((binding) => binding.nodeId === nodeId && binding.input === input);
    if (found) found.value = value;
    else bindings.push({ nodeId, input, label: `CLIPTextEncode.${input}`, type: 'text', value, enabled: true });
  };
  upsert('6', 'text', '一只银色的猫');
  upsert('7', 'text', '模糊, 多余的手指');
  assert.equal((await call(`/api/comfy/workflows/${workflow.id}`, { method: 'PUT', body: { bindings } })).status, 200);

  const after = (await call('/api/comfy/workflows')).body.items.find((item) => item.id === workflow.id);
  assert.equal(after.prompts.positive.value, '一只银色的猫', '列表里要显示绑定后的值');
  assert.equal(after.prompts.negative.value, '模糊, 多余的手指');
  const preview = await call(`/api/comfy/workflows/${workflow.id}/preview`, {
    method: 'POST',
    body: { context: { char: '阿狸', scene: '旧书店' } },
  });
  assert.equal(preview.body.prompt['6'].inputs.text, '一只银色的猫');
  assert.equal(preview.body.prompt['7'].inputs.text, '模糊, 多余的手指');

  // 认不出来的时候是 null（不是抛错）：拿一份没有文本编码器的工作流试
  const noText = await call('/api/comfy/workflows', {
    method: 'POST',
    body: { name: '没有文本节点', workflow: { 1: { class_type: 'VAEDecode', inputs: { samples: ['2', 0], vae: ['2', 1] } } } },
  });
  assert.equal(noText.body.prompts.positive, null);
  assert.equal(noText.body.prompts.negative, null);
  assert.equal((await call(`/api/comfy/workflows/${noText.body.id}`, { method: 'DELETE' })).status, 204);

  // 复原，别影响后面的用例
  upsert('6', 'text', '{{char}}, {{scene}}, {{emotion}}, 1girl');
  upsert('7', 'text', 'lowres, bad anatomy');
  await call(`/api/comfy/workflows/${workflow.id}`, { method: 'PUT', body: { bindings } });
});

test('工具箱：删图会把素材、出图记录、消息附件一起收干净', async () => {
  const run = (await call('/api/comfy/runs?limit=10')).body.items.find((item) => item.images?.length);
  assert.ok(run, '需要一条前面测试留下的、带图的出图记录');
  const assetId = run.images[0].assetId;

  // 造一条引用这张图的消息，模拟"自动出图绑回消息"
  const chat = await call('/api/chats', {
    method: 'POST',
    body: { title: '删图测试', character: { name: '阿狸', first_mes: '喵。' } },
  });
  const chatId = chat.body.id;
  const inserted = await call(`/api/chats/${chatId}/messages`, {
    method: 'POST',
    body: { role: 'assistant', content: '给你一张图', extra: { images: [assetId] } },
  });
  assert.equal(inserted.status, 201);
  assert.ok(inserted.body.extra.images.includes(assetId));

  const deleted = await call(`/api/comfy/images/${assetId}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.removed, true);
  assert.ok(deleted.body.runs >= 1, '出图记录里的引用要清掉');
  assert.ok(deleted.body.messages >= 1, '消息附件里的引用要清掉');
  assert.equal(deleted.body.pruned, 1, '摘完一张不剩的记录要一起清掉，别留空壳卡片');

  // 素材没了
  assert.equal((await call(`/api/assets/${assetId}`)).status, 404);
  assert.equal((await fetch(`${base}/api/assets/${assetId}/file`)).status, 404);
  // 那条记录本身也没了（它跑完就只剩这一张图）
  assert.equal((await call(`/api/comfy/runs/${run.id}`)).status, 404, '空壳记录不该留在"最近的出图"里');
  // 消息还留着，extra.images 清空（不然聊天里是一张裂图）
  const afterChat = await call(`/api/chats/${chatId}/messages`);
  const message = afterChat.body.items.find((item) => item.id === inserted.body.id);
  assert.deepEqual(message.extra.images, []);
  // 幂等边界：已经删过再删一次，给 404 而不是假装成功
  assert.equal((await call(`/api/comfy/images/${assetId}`, { method: 'DELETE' })).status, 404);

  // 还有图的记录不能被误删；删到一张不剩才清
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
  const first = await call('/api/assets', { method: 'POST', body: { data: png.toString('base64'), mime: 'image/png', name: 'keep-1.png' } });
  const second = await call('/api/assets', { method: 'POST', body: { data: Buffer.concat([png, Buffer.from([0x02])]).toString('base64'), mime: 'image/png', name: 'keep-2.png' } });
  const workflow = (await call('/api/comfy/workflows')).body.items[0];
  const queued = await call('/api/comfy/client-runs', {
    method: 'POST',
    body: { workflowId: workflow.id, promptId: 'test-two-images', reason: 'two-images' },
  });
  assert.equal(queued.status, 201, JSON.stringify(queued.body));
  await call(`/api/comfy/client-runs/${queued.body.id}`, {
    method: 'PUT',
    body: { status: 'done', images: [{ assetId: first.body.id, filename: 'keep-1.png' }, { assetId: second.body.id, filename: 'keep-2.png' }] },
  });
  const half = await call(`/api/comfy/images/${first.body.id}`, { method: 'DELETE' });
  assert.equal(half.body.pruned, 0, '还剩一张图，记录要留着');
  const halfRun = await call(`/api/comfy/runs/${queued.body.id}`);
  assert.equal(halfRun.status, 200);
  assert.deepEqual(halfRun.body.images.map((item) => item.assetId), [second.body.id]);
  const rest = await call(`/api/comfy/images/${second.body.id}`, { method: 'DELETE' });
  assert.equal(rest.body.pruned, 1, '最后一张删掉后记录也要清');
  assert.equal((await call(`/api/comfy/runs/${queued.body.id}`)).status, 404);

  // 单独删记录：图还在素材库里，只清记录
  const png3 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x03]);
  const asset = await call('/api/assets', { method: 'POST', body: { data: png3.toString('base64'), mime: 'image/png', name: 'record-only.png' } });
  const keep = await call('/api/comfy/client-runs', {
    method: 'POST',
    body: { workflowId: workflow.id, promptId: 'test-record-only', reason: 'record-only' },
  });
  assert.equal(keep.status, 201, JSON.stringify(keep.body));
  await call(`/api/comfy/client-runs/${keep.body.id}`, { method: 'PUT', body: { status: 'done', images: [{ assetId: asset.body.id, filename: 'record-only.png' }] } });
  assert.equal((await call(`/api/comfy/runs/${keep.body.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await call(`/api/comfy/runs/${keep.body.id}`)).status, 404);
  assert.equal((await call(`/api/assets/${asset.body.id}`)).status, 200, '删记录不动素材库');
  assert.equal((await call(`/api/comfy/runs/${keep.body.id}`, { method: 'DELETE' })).status, 404, '再删一次给 404');

  await call(`/api/chats/${chatId}`, { method: 'DELETE' });
});

test('工具箱：酒馆托管 ComfyUI —— 手动启动 / 停掉 / 出图前自动拉起', async () => {
  // 挑一个空端口，让托管把"假 ComfyUI"当成整合包里的那份拉起来
  const port = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const found = probe.address().port;
      probe.close(() => resolve(found));
    });
  });
  const fixture = path.join(process.cwd(), 'tests', 'fixtures', 'mock-comfy-cli.mjs');

  // 没配命令时点启动：给人话，而不是崩或者起一个空进程
  await call('/api/comfy/config', { method: 'PUT', body: { 'comfy.launcher.command': '', 'comfy.autoStart': false } });
  const empty = await call('/api/comfy/launch', { method: 'POST', body: {} });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error.message, /启动命令/);

  const before = await call('/api/comfy/launcher');
  assert.equal(before.body.available, true);
  assert.equal(before.body.status.running, false);
  assert.equal(before.body.status.configured, false);

  // 配上命令（参数里带引号的路径，顺带测参数切分）+ 换成新端口，手动启动
  await call('/api/comfy/config', {
    method: 'PUT',
    body: {
      'comfy.enabled': true,
      'comfy.baseUrl': `http://127.0.0.1:${port}`,
      'comfy.launcher.command': process.execPath,
      'comfy.launcher.args': `"${fixture}" ${port}`,
      'comfy.launcher.cwd': '',
    },
  });
  const started = await call('/api/comfy/launch', { method: 'POST', body: {} });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.started, true);
  assert.equal(started.body.status.running, true);
  assert.equal(started.body.status.ready, true, '端口通了还要等 /system_stats 真回话');
  assert.ok(started.body.status.pid, '要记下 PID，界面才好显示');
  assert.equal(started.body.status.port, port, '端口跟着 comfy.baseUrl 走');
  assert.ok(started.body.status.logs.length, '应该留下启动日志');

  // 再点一次不该起第二份
  const again = await call('/api/comfy/launch', { method: 'POST', body: {} });
  assert.equal(again.status, 200);
  assert.equal(again.body.mine, true, '已经在跑就直接认账，不再起第二份');
  assert.equal(again.body.status.pid, started.body.status.pid, 'PID 不该变');

  const stopped = await call('/api/comfy/stop', { method: 'POST', body: {} });
  assert.equal(stopped.body.stopped, true);
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal((await call('/api/comfy/launcher')).body.status.running, false);
  assert.equal((await call('/api/comfy/stop', { method: 'POST', body: {} })).body.stopped, false, '没在跑就没什么可停的');

  // 出图前自动拉起：只开开关不点启动，直接提交
  await call('/api/comfy/config', { method: 'PUT', body: { 'comfy.autoStart': true } });
  const workflow = (await call('/api/comfy/workflows')).body.items.find((item) => item.kind === 'portrait');
  const submitted = await call('/api/comfy/run', { method: 'POST', body: { workflowId: workflow.id } });
  assert.equal(submitted.status, 202, JSON.stringify(submitted.body));
  assert.equal((await call('/api/comfy/launcher')).body.status.running, true, '提交时应该自己把 ComfyUI 拉起来');

  let finished = null;
  for (let i = 0; i < 40 && !finished; i += 1) {
    const one = await call(`/api/comfy/runs/${submitted.body.id}`);
    if (one.body.status === 'done' || one.body.status === 'error') finished = one.body;
    else await new Promise((resolve) => setTimeout(resolve, 400));
  }
  assert.equal(finished?.status, 'done', finished?.error ?? '自动拉起之后这一轮应该能出图');
  assert.equal(finished.images.length, 1);

  // 收尾：关掉自动开关、停掉进程、把地址换回主 mock，别影响后面的用例
  await call('/api/comfy/config', { method: 'PUT', body: { 'comfy.baseUrl': mockComfy.url, 'comfy.autoStart': false } });
  await call('/api/comfy/stop', { method: 'POST', body: {} });
});

test('素材：不允许用 text/html 的 mime 在应用同源里执行脚本', async () => {
  // 传一个"自称是 HTML"的素材，再直接打开它的 URL —— 这就是 stored XSS 的经典写法
  const hostile = Buffer.from('<scr' + 'ipt>document.title="PWNED"</scr' + 'ipt>').toString('base64');
  const created = await call('/api/assets', { method: 'POST', body: { data: hostile, mime: 'text/html', name: 'evil.html' } });
  assert.equal(created.status, 201);
  const asHtml = await fetch(`${base}/api/assets/${created.body.id}/file`);
  assert.notEqual(asHtml.headers.get('content-type'), 'text/html', '绝不能把 text/html 原样发出去');
  assert.equal(asHtml.headers.get('content-type'), 'application/octet-stream');
  assert.equal(asHtml.headers.get('x-content-type-options'), 'nosniff');
  assert.match(asHtml.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.match(asHtml.headers.get('content-disposition') ?? '', /attachment/);
  assert.ok((await asHtml.text()).startsWith('<scr'), '字节还是原样，只是不许当文档执行');

  // SVG 也是文档，同样要被 nosniff + CSP sandbox 兜住（但 <img> 还要能显示，所以保留 image/svg+xml）
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="document.title=\'x\'"></svg>').toString('base64');
  const svgAsset = await call('/api/assets', { method: 'POST', body: { data: svg, mime: 'image/svg+xml', name: 'x.svg' } });
  const svgResponse = await fetch(`${base}/api/assets/${svgAsset.body.id}/file`);
  assert.equal(svgResponse.headers.get('content-type'), 'image/svg+xml');
  assert.equal(svgResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.match(svgResponse.headers.get('content-security-policy') ?? '', /sandbox/);

  // 正常图片照旧：类型不变、字节不变（前端 <img src> 直接指这里）
  const image = await call('/api/assets', { method: 'POST', body: { data: Buffer.from('0123456789abcdef').toString('base64'), mime: 'image/png', name: 'ok.png' } });
  const imageResponse = await fetch(`${base}/api/assets/${image.body.id}/file`);
  assert.equal(imageResponse.headers.get('content-type'), 'image/png');
  assert.equal((await imageResponse.arrayBuffer()).byteLength, 16);
});

test('工具箱：半自动出图 —— 回复里出现 [IMG:] 就出图并绑到那条消息', async () => {
  const created = await call('/api/chats', {
    method: 'POST',
    body: { title: '出图测试', character: { name: '阿狸', first_mes: '喵。' }, persona: { name: '我' } },
  });
  assert.equal(created.status, 201);
  const chatId = created.body.id;

  const streamed = await streamCall(`/api/chats/${chatId}/send`, { text: 'IMG_MARKER_TEST' });
  const done = streamed.events.find((event) => event.event === 'done')?.data;
  assert.ok(done, '应该有一轮完整回复');
  assert.ok(done.imageTrigger, 'done 事件里要带上出图触发结果');
  assert.equal(done.imageTrigger.trigger, true);
  assert.equal(done.imageTrigger.started[0].ok, true, JSON.stringify(done.imageTrigger.started));

  const runs = await call(`/api/comfy/runs?chatId=${chatId}`);
  assert.equal(runs.body.total, 1);
  assert.equal(runs.body.items[0].messageId, done.messageId, '出的图要绑在刚刚那条回复上');

  // 图跑完之后要真正绑到那条消息上（extra.images），前端才知道气泡下面该显示什么。
  // 半自动触发是异步的：提交完就返回了，这里等它收尾。
  let attached = null;
  for (let i = 0; i < 30 && !attached; i += 1) {
    const listing = await call(`/api/chats/${chatId}/messages`);
    const message = listing.body.items.find((item) => item.id === done.messageId);
    if (message?.extra?.images?.length) attached = message;
    else await new Promise((resolve) => setTimeout(resolve, 400));
  }
  assert.ok(attached, '出图完成后 assetId 要写进消息的 extra.images');
  const attachedAssetId = attached.extra.images[0];
  assert.equal(typeof attachedAssetId, 'string');
  const attachedFile = await fetch(`${base}/api/assets/${attachedAssetId}/file`);
  assert.equal(attachedFile.status, 200, '消息里绑的图要能按 assetId 取回字节（前端点开大图用）');
  assert.equal(attachedFile.headers.get('content-type'), 'image/png');

  // 标记里的正文要当成正向提示词，并顺手把 {{char}} 换成在场角色
  const last = mockComfy.state.submitted.at(-1);
  assert.match(last.body.prompt['6'].inputs.text, /白狐，雪夜/);
  assert.match(last.body.prompt['6'].inputs.text, /阿狸/);
  assert.equal(last.body.client_id, (await call('/api/comfy/config')).body.clientId);

  await call(`/api/chats/${chatId}`, { method: 'DELETE' });
});

test('工具箱：浏览器直连 —— client 模式下主机不提交，触发落成待办，前端回写并绑消息', async () => {
  const created = await call('/api/chats', {
    method: 'POST',
    body: { title: '直连测试', character: { name: '阿狸', first_mes: '喵。' }, persona: { name: '我' } },
  });
  assert.equal(created.status, 201);
  const chatId = created.body.id;
  const workflow = (await call('/api/comfy/workflows')).body.items.find((item) => item.kind === 'portrait');
  assert.ok(workflow, '前面导入的立绘工作流还在');

  // 切到「浏览器直连」，地址仍指向假 ComfyUI —— 但主机一次都不该去提交。
  await call('/api/comfy/config', {
    method: 'PUT',
    body: { 'comfy.executionMode': 'client', 'comfy.baseUrl': mockComfy.url, 'comfy.enabled': true, 'comfy.trigger': 'marker' },
  });
  const config = await call('/api/comfy/config');
  assert.equal(config.body.settings['comfy.executionMode'], 'client');
  assert.deepEqual(config.body.executionModes.map((item) => item.id), ['server', 'client']);

  const status = await call('/api/comfy/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.executionMode, 'client');
  assert.equal(status.body.ok, null, 'client 模式下主机不探活');
  assert.equal(status.body.client, true);
  assert.equal((await call('/api/comfy/queue')).body.client, true);

  const submittedBefore = mockComfy.state.submitted.length;
  // 服务器执行的提交入口在 client 模式下要明确拒绝，而不是偷偷去连
  const refused = await call('/api/comfy/run', { method: 'POST', body: { workflowId: workflow.id } });
  assert.equal(refused.status, 502);
  assert.match(refused.body.error.message, /浏览器直连/);

  // marker 触发 → 落成 pending-client 待办，最终 prompt 由服务端算好塞进记录
  const streamed = await streamCall(`/api/chats/${chatId}/send`, { text: 'IMG_MARKER_TEST' });
  const done = streamed.events.find((event) => event.event === 'done')?.data;
  assert.ok(done.imageTrigger);
  assert.equal(done.imageTrigger.trigger, true);
  assert.equal(done.imageTrigger.started[0].pending, true);
  assert.equal(done.imageTrigger.started[0].run.status, 'pending-client');

  const pendingList = await call('/api/comfy/runs?status=pending-client');
  const pending = pendingList.body.items.find((run) => run.messageId === done.messageId);
  assert.ok(pending, '要有一条挂在这条消息上的待办');
  assert.equal(pending.chatId, chatId);
  assert.ok(pending.values.prompt, '待办里要有服务端替换好占位符的最终 prompt');
  assert.equal(pending.values.prompt['3'].inputs.seed, workflow.seed ?? null);
  assert.equal(mockComfy.state.submitted.length, submittedBefore, 'client 模式下主机不能向用户地址提交任务（SSRF 收敛）');

  // 模拟浏览器：先登记 promptId（领走这条待办）
  const claimed = await call('/api/comfy/client-runs', {
    method: 'POST',
    body: { runId: pending.id, workflowId: workflow.id, chatId, messageId: done.messageId, promptId: 'pid-client-1' },
  });
  assert.equal(claimed.status, 201);
  assert.equal(claimed.body.status, 'running');
  assert.equal(claimed.body.promptId, 'pid-client-1');

  const progressing = await call(`/api/comfy/client-runs/${pending.id}`, {
    method: 'PUT',
    body: { status: 'running', progress: 4, progressMax: 10, nodeId: '5' },
  });
  assert.equal(progressing.body.percent, 40);

  // 上传一张素材，再走 attachments 绑回那条消息（浏览器直连的收尾）
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const uploaded = await call('/api/assets', { method: 'POST', body: { data: pngBytes.toString('base64'), mime: 'image/png', name: 'client.png' } });
  assert.equal(uploaded.status, 201);
  const assetId = uploaded.body.id;
  const attached = await call(`/api/chats/${chatId}/messages/${done.messageId}/attachments`, {
    method: 'POST',
    body: { assetIds: [assetId] },
  });
  assert.equal(attached.status, 200);
  assert.ok(attached.body.extra.images.includes(assetId), 'assetId 要合并进 extra.images');
  // 幂等：同一个 assetId 再挂一次不该重复
  const again = await call(`/api/chats/${chatId}/messages/${done.messageId}/attachments`, { method: 'POST', body: { assetIds: [assetId] } });
  assert.equal(again.body.extra.images.filter((id) => id === assetId).length, 1);

  const finished = await call(`/api/comfy/client-runs/${pending.id}`, {
    method: 'PUT',
    body: { status: 'done', images: [{ assetId, filename: 'client.png' }] },
  });
  assert.equal(finished.body.status, 'done');
  assert.equal(finished.body.percent, 100);
  assert.equal((await call('/api/comfy/runs?status=pending-client')).body.total, 0);
  assert.equal((await call(`/api/comfy/runs/${pending.id}`)).body.images[0].assetId, assetId);

  // 换回服务器执行，别影响后面的用例
  await call('/api/comfy/config', { method: 'PUT', body: { 'comfy.executionMode': 'server' } });
  await call(`/api/chats/${chatId}`, { method: 'DELETE' });
});

test('工具箱：对话里能显示出图 —— 消息绑 assetId、能查 runs、能取文件字节', async () => {
  const created = await call('/api/chats', {
    method: 'POST',
    body: { title: '看图', character: { name: '阿狸', first_mes: '你好。' }, persona: { name: '我' } },
  });
  const chatId = created.body.id;
  const target = (await call(`/api/chats/${chatId}/messages`)).body.items[0];
  assert.ok(target, '新对话要有开场白，才有消息可以挂图');

  const workflow = (await call('/api/comfy/workflows')).body.items[0];
  assert.ok(workflow);
  // 这条路径就是对话里"重试 / 手动出一张"走的那条：把任务绑到具体那条消息上
  const started = await call('/api/comfy/run', {
    method: 'POST',
    body: { workflowId: workflow.id, chatId, messageId: target.id, reason: 'manual' },
  });
  assert.equal(started.status, 202);

  let done = null;
  for (let i = 0; i < 30 && !done; i += 1) {
    const run = (await call(`/api/comfy/runs?messageId=${target.id}`)).body.items[0];
    if (run && (run.status === 'done' || run.status === 'error')) done = run;
    else await new Promise((resolve) => setTimeout(resolve, 400));
  }
  assert.ok(done, '应该能跑完');
  assert.equal(done.status, 'done', done.error ?? '');
  assert.equal(done.images.length, 1);

  const assetId = done.images[0].assetId;
  const message = (await call(`/api/chats/${chatId}/messages`)).body.items.find((item) => item.id === target.id);
  assert.ok(message.extra.images.includes(assetId), 'assetId 要挂在消息的 extra.images 上');

  // 前端 <img src="/api/assets/:id/file"> 真的要能拿回 PNG
  const file = await fetch(`${base}/api/assets/${assetId}/file`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await file.arrayBuffer()).subarray(0, 4).toString('hex'), '89504e47');

  // 视图一次拉整个对话的出图记录，按 messageId 分组画到气泡下面
  const byChat = await call(`/api/comfy/runs?chatId=${chatId}`);
  assert.equal(byChat.body.items.filter((run) => run.messageId === target.id).length, 1);
  // 有 WebSocket 进度事件时跑完会给满格；没有时是 null（视图只在 queued/running 时画进度条）
  assert.ok([100, null].includes(byChat.body.items[0].percent), `跑完的记录不该停在中间进度：${byChat.body.items[0].percent}`);

  await call(`/api/chats/${chatId}`, { method: 'DELETE' });
});

test('工具箱：用量落库、按对话 / 角色 / 天汇总、能填各家单价', async () => {
  const summary = await call('/api/cost/summary');
  assert.equal(summary.status, 200);
  assert.ok(summary.body.totals.turns > 0, '前面跑过很多轮对话，应该有用量了');
  assert.ok(summary.body.totals.promptTokens > 0);
  assert.ok(summary.body.totals.reportedTurns > 0, '假模型是带 usage 回来的');
  assert.equal(summary.body.totals.reportedTurns + summary.body.totals.estimatedTurns, summary.body.totals.turns);
  assert.ok(summary.body.totals.prompt.percent !== null, '要有预估 vs 实际');
  assert.equal(summary.body.byDay.length, 14);
  assert.ok(summary.body.byDay.at(-1).turns > 0, '今天的用量要落在最后一天');

  const chats = await call('/api/cost/by-chat');
  assert.ok(chats.body.total >= 1);
  assert.ok(chats.body.items[0].totalTokens > 0);

  const characters = await call('/api/cost/by-character');
  assert.ok(characters.body.total >= 1);

  const usage = await call('/api/cost/usage?limit=5');
  assert.equal(usage.body.items.length, 5);
  assert.ok(usage.body.items[0].providerId, '要记住是哪家出的这一轮');

  // 填了单价之后，新的一轮要真的算上钱（走 providerParams 的覆盖）
  const providers = await call('/api/providers');
  const provider = providers.body.items.find((item) => item.label === '本地假模型');
  const savedPricing = await call('/api/cost/pricing', {
    method: 'PUT',
    body: { providerId: provider.id, model: '', priceIn: 10, priceOut: 40, label: '假模型' },
  });
  assert.equal(savedPricing.body.priceIn, 10);
  assert.equal(savedPricing.body.model, '', '模型名留空 = 这家所有模型');

  const created = await call('/api/chats', {
    method: 'POST',
    body: { title: '记账', character: { name: '小账', first_mes: '你好。' }, persona: { name: '我' } },
  });
  const chatId = created.body.id;
  // 绑定时写死模型名，这样用量里也能看到是哪个模型
  await call('/api/models/bindings', { method: 'PUT', body: { scope: 'default', providerId: provider.id, model: 'mock-small' } });
  await streamCall(`/api/chats/${chatId}/send`, { text: '一轮' });

  const after = await call(`/api/cost/usage?chatId=${chatId}`);
  assert.equal(after.body.items.length, 1);
  const row = after.body.items[0];
  assert.equal(row.reported, true);
  assert.equal(row.model, 'mock-small');
  assert.equal(row.priceIn, 10);
  assert.equal(row.priceOut, 40);
  // 缓存命中：适配层把 prompt_tokens_details.cached_tokens 透传成了 cachedTokens
  assert.equal(row.cachedTokens, 2, '缓存字段要一路透传到记账');
  assert.ok(row.cacheSavings > 0, '有缓存命中 + 有单价时应该算出节省');
  // 假模型固定回 3 输入 / 4 输出：3/1e6*10 + 4/1e6*40
  assert.ok(Math.abs(row.cost - (3 / 1e6) * 10 - (4 / 1e6) * 40) < 1e-9, `算出来的钱不对：${row.cost}`);
  assert.ok(row.estPromptTokens > 0, '估算值也要留着，才能对比');

  const mine = (await call('/api/cost/by-chat')).body.items.find((item) => item.chatId === chatId);
  assert.ok(mine.cost > 0);

  const pricing = await call('/api/cost/pricing');
  assert.ok(pricing.body.items.length >= 1);
  assert.ok(pricing.body.presets.length >= 5);
  // 「+ 模型名」候选：从配好的提供方与绑定里现取，不该再是写死的老型号
  const suggestions = pricing.body.suggestions ?? [];
  assert.ok(suggestions.length >= 1, '配过提供方就该给出候选模型');
  assert.ok(
    suggestions.some((item) => item.model === 'mock-small' && item.providerId === provider.id),
    `候选里要有这台假模型这个模型，实际：${JSON.stringify(suggestions)}`,
  );
  assert.ok(
    suggestions.every((item) => !String(item.model).includes('gpt-4o') && !String(item.model).includes('gemini-1.5')),
    '候选里不该混进写死的老型号',
  );
  const priced = pricing.body.items.find((item) => item.providerId === provider.id && item.model === '');
  assert.equal((await call(`/api/cost/pricing/${priced.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await call('/api/cost/pricing')).body.items.length, pricing.body.items.length - 1);

  await call(`/api/chats/${chatId}`, { method: 'DELETE' });
});

test('工具箱：月度 / 年度报告把用量聚合成机器可读的数字', async () => {
  const periods = await call('/api/review/periods');
  assert.equal(periods.status, 200);
  assert.deepEqual(periods.body.scopes, ['month', 'year', 'all']);
  assert.ok(periods.body.currentMonth, '要给出"现在"这一个月');

  // 现造一轮：绑假模型 → 建对话 → 发一条（聊天会记账）
  const providers = await call('/api/providers');
  const provider = providers.body.items.find((item) => item.label === '本地假模型');
  await call('/api/models/bindings', { method: 'PUT', body: { scope: 'default', providerId: provider.id, model: 'mock-small' } });
  const created = await call('/api/chats', { method: 'POST', body: { title: '报告', character: { name: '报卡', first_mes: '你好。' }, persona: { name: '我' } } });
  const chatId = created.body.id;
  await streamCall(`/api/chats/${chatId}/send`, { text: '聊一句' });

  const report = await call('/api/review/report?scope=month');
  assert.equal(report.status, 200);
  assert.equal(report.body.meta.scope, 'month');
  assert.ok(report.body.headline.turns >= 1, '这一轮要算进报告');
  assert.ok(report.body.headline.tokens >= 1);
  assert.ok(report.body.usage.topCharacters.length >= 1, '要按卡分组');
  assert.ok(report.body.usage.topCharacters[0].turns >= 1);
  assert.ok(report.body.usage.byModel.some((row) => row.model === 'mock-small'));
  assert.ok(report.body.activity.byDay.length >= 28, '月报按天补满整月');
  assert.equal(report.body.activity.byHour.length, 24);
  assert.equal(report.body.activity.byWeekday.length, 7);
  assert.ok(report.body.creation && typeof report.body.creation.cardsCreated === 'number');
  assert.ok(Array.isArray(report.body.commentary) && report.body.commentary.length >= 1);

  const all = await call('/api/review/report?scope=all');
  assert.equal(all.body.meta.scope, 'all');
  assert.ok(all.body.headline.turns >= report.body.headline.turns, '全部时间的轮数不该少于这个月');

  await call(`/api/chats/${chatId}`, { method: 'DELETE' });
});

test('工具箱：把酒馆当 MCP 服务器 —— Codex / Claude Code 能直接读写', async () => {
  const info = await call('/api/mcp/server');
  assert.equal(info.status, 200);
  assert.equal(info.body.enabled, true);
  assert.equal(info.body.transport, 'stdio');
  assert.ok(info.body.args.includes('--data-dir'));
  assert.deepEqual(info.body.returnModes.map((mode) => mode.id), ['summary', 'search', 'index']);
  assert.ok(info.body.items.length >= 12, `工具太少：${info.body.items.length}`);
  assert.ok(info.body.items.some((tool) => tool.name === 'cards.list'));
  assert.ok(info.body.items.some((tool) => tool.name === 'chats.send'));
  assert.ok(info.body.items.some((tool) => tool.annotations?.destructiveHint), '破坏性工具要标出来');

  // 界面上的"试一下"
  const tried = await call('/api/mcp/server/call', { method: 'POST', body: { tool: 'stats.overview', args: {} } });
  assert.equal(tried.status, 200);
  assert.equal(tried.body.isError, false);
  const overview = JSON.parse(tried.body.text);
  assert.ok(overview.cards >= 1, '前面建的卡应该数得出来');
  assert.ok(overview.chats >= 1);

  const badCall = await call('/api/mcp/server/call', { method: 'POST', body: { tool: 'nope' } });
  assert.equal(badCall.body.isError, true);

  // 真起一个 stdio 服务器进程，按 MCP 协议说话
  const child = spawn(process.execPath, [path.join(process.cwd(), 'server', 'mcp-stdio.mjs'), '--data-dir', dataDir], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TEMP: dataDir, TMP: dataDir },
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  let buffer = '';
  let nextId = 1;
  let junkLines = 0;
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        junkLines += 1; // stdout 上只该有 JSON-RPC
        continue;
      }
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    }
  });
  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP 请求超时：${method}（stderr: ${stderr.slice(-400)}）`));
      }, 20000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  try {
    const init = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'api-test', version: '1.0.0' } });
    assert.equal(init.serverInfo.name, 'silver-tavern');
    assert.ok(init.capabilities.tools);
    assert.match(init.instructions, /summary/);

    const tools = await request('tools/list', {});
    assert.ok(tools.tools.length >= 12);
    assert.ok(tools.tools.every((tool) => tool.inputSchema));

    // 关键一条：MCP 进程要能看到界面里建出来的数据
    const listed = await request('tools/call', { name: 'cards.list', arguments: { mode: 'index', limit: 5 } });
    const cardList = JSON.parse(listed.content[0].text);
    assert.ok(cardList.length >= 1, `MCP 返回的角色卡为空：${listed.content[0].text}`);
    assert.ok(cardList[0].id && cardList[0].name);

    const chats = await request('tools/call', { name: 'chats.list', arguments: { mode: 'summary', limit: 5 } });
    const chatList = JSON.parse(chats.content[0].text);
    assert.ok(chatList.length >= 1);

    // 破坏性操作没有 confirm 时只返回提示，不落库
    const guarded = await request('tools/call', { name: 'worldbook.removeEntry', arguments: { bookId: 'whatever', uid: 'e1' } });
    assert.equal(guarded.isError, true);
    assert.match(guarded.content[0].text, /confirm: true/);

    const unknown = await request('tools/call', { name: 'nope', arguments: {} });
    assert.equal(unknown.isError, true);

    // 未知方法走 JSON-RPC 错误码，而不是当成工具报错
    await assert.rejects(() => request('no/such/method', {}), /method not found/);
    assert.equal(junkLines, 0, 'stdout 上除了 JSON-RPC 不该有别的东西');
  } finally {
    child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 8000);
      child.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
});

test('工具箱：数据统计、一键备份 / 恢复、清理走 HTTP', async () => {
  const stats = await call('/api/maintenance/stats');
  assert.equal(stats.status, 200);
  assert.ok(stats.body.items.length >= 10);
  assert.ok(stats.body.raw.messages > 0, '前面已经有很多消息了');
  assert.ok(stats.body.items.some((item) => item.key === 'messages'));

  // 启动时的自动备份应该已经留下了一份
  const before = await call('/api/maintenance/backups');
  assert.equal(before.status, 200);
  assert.ok(before.body.total >= 1, '启动时应该自动备份过');
  assert.ok(before.body.items[0].bytes > 0);
  assert.ok(before.body.items[0].sizeText);
  assert.equal(before.body.items[0].latest, true);
  assert.equal(before.body.autoBackupOnStart, true);
  assert.ok(before.body.kinds.some((kind) => kind.id === 'pre-restore'));
  assert.ok(before.body.directory.endsWith('backups'));

  const made = await call('/api/maintenance/backup', { method: 'POST', body: { label: '接口测试备份' } });
  assert.equal(made.status, 201);
  assert.equal(made.body.label, '接口测试备份');
  assert.equal(made.body.kind, 'manual');
  assert.ok(made.body.stats.chats > 0);
  assert.ok(made.body.assetFiles >= 1, '备份包里要带上素材');

  // 造一个孤立素材文件：磁盘上有、库里没有
  const orphan = path.join(dataDir, 'assets', 'orphan-api.png');
  writeFileSync(orphan, '没人管的文件');
  const scan = await call('/api/maintenance/scan');
  assert.equal(scan.status, 200);
  assert.ok(scan.body.totalIssues >= 1);
  assert.ok(scan.body.details.orphanFiles.some((file) => file.path.endsWith('orphan-api.png')));
  assert.ok(scan.body.targets.some((target) => target.id === 'staleVectors'));

  const cleaned = await call('/api/maintenance/cleanup', { method: 'POST', body: { targets: ['orphanFiles'] } });
  assert.equal(cleaned.status, 200);
  assert.equal(cleaned.body.removed.orphanFiles, 1);
  assert.ok(cleaned.body.safetyBackup, '清理前要自动留一份');
  assert.equal(existsSync(orphan), false);
  const rescanned = await call('/api/maintenance/scan');
  assert.equal(rescanned.body.issues.find((item) => item.id === 'orphanFiles').count, 0);

  // 恢复：数据回到备份那一刻
  const restore = await call('/api/maintenance/restore', { method: 'POST', body: { name: made.body.name } });
  assert.equal(restore.status, 200);
  assert.equal(restore.body.ok, true);
  assert.ok(restore.body.tables > 10);
  assert.equal(restore.body.foreignKeyIssues, 0);
  assert.ok(restore.body.safetyBackup);
  assert.ok(restore.body.stats.chats > 0);

  const after = await call('/api/maintenance/backups');
  assert.ok(after.body.total > before.body.total, '恢复本身也会留一份');
  assert.equal((await call(`/api/maintenance/backups/${restore.body.safetyBackup}`, { method: 'DELETE' })).status, 204);
  assert.equal((await call('/api/maintenance/backups/no-such-backup', { method: 'DELETE' })).status, 404);

  const badRestore = await call('/api/maintenance/restore', { method: 'POST', body: { name: 'no-such-backup' } });
  assert.equal(badRestore.status, 400);
  assert.equal(badRestore.body.error.code, 'VALIDATION_ERROR');
  assert.equal((await call('/api/maintenance/restore', { method: 'POST', body: {} })).status, 400);
});

test('工具箱：批量导入 / 清空这类大改动前会自动留一份备份', async () => {
  // 保留份数会把最旧的自动备份清掉，所以看"最新那份"而不是数总数
  const newest = async () => (await call('/api/maintenance/backups')).body.items[0];

  const created = await call('/api/chats', {
    method: 'POST',
    body: { title: '备份钩子', character: { name: '阿狸', first_mes: '你好。' }, persona: { name: '我' } },
  });
  const exported = await call(`/api/chats/${created.body.id}/export?format=jsonl`, { raw: true });

  const beforeImport = await newest();
  const imported = await call('/api/chats/import', { method: 'POST', body: { text: exported.body } });
  assert.equal(imported.status, 201);
  const afterImport = await newest();
  assert.notEqual(afterImport.name, beforeImport.name);
  assert.equal(afterImport.kind, 'pre-import', '导入对话存档前要留一份 pre-import');
  assert.match(afterImport.label, /导入/);

  // 删掉整个对话（外键级联带走它的所有消息）→ pre-delete
  const beforeDelete = await newest();
  assert.equal((await call(`/api/chats/${imported.body.id}`, { method: 'DELETE' })).status, 204);
  const afterDelete = await newest();
  assert.notEqual(afterDelete.name, beforeDelete.name);
  assert.equal(afterDelete.kind, 'pre-delete');
  assert.match(afterDelete.label, /删除对话/);

  // 清空向量索引 → 也算"清空"类破坏性操作
  const beforeClear = await newest();
  assert.equal((await call('/api/vectors/clear', { method: 'POST', body: {} })).status, 200);
  const afterClear = await newest();
  assert.notEqual(afterClear.name, beforeClear.name);
  assert.equal(afterClear.kind, 'pre-delete');
  assert.match(afterClear.label, /清空向量/);

  await call(`/api/chats/${created.body.id}`, { method: 'DELETE' });
});

test('工具箱：定时任务 —— 默认清单、开关、立刻跑、上次 / 下次时间', async () => {
  const list = await call('/api/scheduler');
  assert.equal(list.status, 200);
  assert.ok(list.body.items.length >= 2, '默认给一份"每天自动备份" + "每周自动清理"');
  assert.ok(list.body.items.every((item) => item.enabled === false), '默认关着，别一启动就动数据');
  assert.ok(list.body.items.every((item) => item.nextRunAt), '每条都要能算出下次运行时间');
  assert.equal(list.body.kinds.length, 3);
  assert.ok(list.body.frequencies.some((item) => item.id === 'weekly'));

  // 新建一条启用的备份任务，立刻跑一遍验证真的落了一份备份
  const created = await call('/api/scheduler', {
    method: 'POST',
    body: { kind: 'backup', every: 'daily', atHour: 5, atMinute: 0, enabled: true, label: '测试定时备份' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.kind, 'backup');
  assert.equal(created.body.frequency, '每天 05:00');
  assert.equal(created.body.lastRunAt, null);
  assert.ok(created.body.nextRunAt);

  const backupsBefore = (await call('/api/maintenance/backups')).body.total;
  const ran = await call(`/api/scheduler/${created.body.id}/run`, { method: 'POST', body: {} });
  assert.equal(ran.status, 200);
  assert.equal(ran.body.lastStatus, 'ok');
  assert.ok(ran.body.lastRunAt, '跑完要记下上次运行时间（重启后不重复跑靠它）');
  assert.match(ran.body.lastResult, /备份/);
  assert.equal(ran.body.runCount, 1);
  assert.ok((await call('/api/maintenance/backups')).body.total > backupsBefore, '定时备份要真的多一份');

  // 关掉之后就不是启用状态了
  const disabled = await call(`/api/scheduler/${created.body.id}`, { method: 'PUT', body: { enabled: false } });
  assert.equal(disabled.body.enabled, false);
  assert.equal((await call(`/api/scheduler/${created.body.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await call('/api/scheduler')).body.items.some((item) => item.id === created.body.id), false);

  // 定时总结：必须指定对话；跑一条真的写进记忆；没有新消息时跳过而不是重复写
  const bad = await call('/api/scheduler', { method: 'POST', body: { kind: 'summarize', every: 'daily', atHour: 6, atMinute: 0 } });
  assert.equal(bad.status, 400);

  const chat = await call('/api/chats', {
    method: 'POST',
    body: { title: '定时总结', character: { name: '阿狸', first_mes: '你好。' }, persona: { name: '我' } },
  });
  const chatId = chat.body.id;
  await streamCall(`/api/chats/${chatId}/send`, { text: '第一轮' });

  const summarize = await call('/api/scheduler', {
    method: 'POST',
    body: { kind: 'summarize', every: 'daily', atHour: 6, atMinute: 0, enabled: true, chatId, level: 'small', messagesPerRun: 20 },
  });
  assert.equal(summarize.status, 201);
  const summaryRun = await call(`/api/scheduler/${summarize.body.id}/run`, { method: 'POST', body: {} });
  assert.equal(summaryRun.body.lastStatus, 'ok', summaryRun.body.lastResult ?? '');
  assert.ok((await call(`/api/memory?chatId=${chatId}&layer=small`)).body.items.length >= 1, '定时总结要真的写进记忆');
  const again = await call(`/api/scheduler/${summarize.body.id}/run`, { method: 'POST', body: {} });
  assert.equal(again.body.lastStatus, 'skipped', '没有新消息时跳过，别重复写');

  await call(`/api/scheduler/${summarize.body.id}`, { method: 'DELETE' });
  await call(`/api/chats/${chatId}`, { method: 'DELETE' });
});

test('创作辅助：对话成章 / 角色卡一条龙 / 素材抽取（走写卡助手的技能机制）', async () => {
  // 三个技能要出现在写卡助手的技能清单里，并且有自己的分类
  const skills = await call('/api/agent/skills');
  const ids = skills.body.items.map((item) => item.id);
  for (const id of ['chapter.polish', 'script.from_card', 'chat.extract_entities']) {
    assert.ok(ids.includes(id), `技能清单里要有 ${id}`);
  }
  assert.ok(skills.body.categories.some((category) => category.id === 'novel'), '要有"创作辅助"分类');

  const created = await call('/api/chats', {
    method: 'POST',
    body: { title: '创作辅助', character: { name: '阿狸', first_mes: '雪落下来了。' }, persona: { name: '我' } },
  });
  const chatId = created.body.id;
  await streamCall(`/api/chats/${chatId}/send`, { text: '我们进旧书馆吧' });

  // 对话 → 小说章节
  const chapter = await call('/api/creative/chat-to-chapter', { method: 'POST', body: { chatId, style: '冷峻悬疑' } });
  assert.equal(chapter.status, 200);
  assert.equal(chapter.body.title, '雪夜的第一章');
  assert.match(chapter.body.text, /雪落下来/);
  assert.ok(chapter.body.sourceMessages >= 2, '要把对话里的多条消息都带上');
  assert.ok(chapter.body.target.providerId, '要能看出这轮用的哪个模型');
  assert.equal((await call('/api/creative/chat-to-chapter', { method: 'POST', body: {} })).status, 400);

  // 角色卡 → 世界书 + 剧本（一条龙）
  const card = await call('/api/characters', {
    method: 'POST',
    body: { name: '阿狸', description: '住在旧书馆的狐妖', first_mes: '喵。' },
  });
  const cardId = card.body.id;
  const script = await call('/api/creative/card-to-script', { method: 'POST', body: { characterId: cardId, acts: 2, saveWorldbook: true } });
  assert.equal(script.status, 200);
  assert.equal(script.body.title, '雪夜剧本');
  assert.equal(script.body.worldbook.length, 1);
  assert.equal(script.body.scenes.length, 1);
  assert.match(script.body.script, /第一幕/);
  assert.ok(script.body.savedWorldbook.added >= 1);
  const books = await call(`/api/worldbooks?characterId=${cardId}`);
  assert.ok(books.body.items.some((book) => book.id === script.body.savedWorldbook.id), '世界书要真的建到这张卡名下');
  const entries = await call(`/api/worldbooks/${script.body.savedWorldbook.id}/entries`);
  assert.ok(entries.body.items.length >= 1);
  assert.ok(entries.body.items[0].keys.includes('旧书馆'));

  // 对话 → 素材（人物 / 地点 / 物品），默认顺手存进世界书
  const extracted = await call('/api/creative/extract-entities', { method: 'POST', body: { chatId } });
  assert.equal(extracted.status, 200);
  assert.equal(extracted.body.counts.characters, 1);
  assert.equal(extracted.body.counts.places, 1);
  assert.equal(extracted.body.entries[0].comment, '人物：阿狸');
  assert.deepEqual(extracted.body.entries[0].keys, ['阿狸', '小狸'], '名字 + 别名都要进触发键');
  assert.ok(extracted.body.savedWorldbook.added >= 2);

  // 只抽取不落库
  const dry = await call('/api/creative/extract-entities', { method: 'POST', body: { text: '阿狸在旧书馆', save: false } });
  assert.equal(dry.status, 200);
  assert.equal(dry.body.savedWorldbook, null);

  // 收尾：把这次造出来的东西删掉，别影响后面的统计
  await call(`/api/worldbooks/${script.body.savedWorldbook.id}`, { method: 'DELETE' });
  await call(`/api/worldbooks/${extracted.body.savedWorldbook.id}`, { method: 'DELETE' });
  await call(`/api/characters/${cardId}`, { method: 'DELETE' });
  await call(`/api/chats/${chatId}`, { method: 'DELETE' });
});

test('玩卡区：候选回复（swipes）—— 再来一版 + ◀ ▶ 切换', async () => {
  const created = await call('/api/chats', {
    method: 'POST',
    body: { title: '按版本', character: { name: '阿狸', first_mes: '喵。' }, persona: { name: '我' } },
  });
  const chatId = created.body.id;
  await streamCall(`/api/chats/${chatId}/send`, { text: '你好' });

  let messages = (await call(`/api/chats/${chatId}/messages`)).body.items;
  const target = messages.at(-1);
  assert.equal(target.role, 'assistant');
  assert.equal(target.swipes.length, 1, '第一版就是当前内容');

  // 再来一版：追加候选，原来那版不删
  const swiped = await streamCall(`/api/chats/${chatId}/swipe`, { messageId: target.id });
  assert.equal(swiped.status, 200);
  const swipeEvent = [...swiped.events].reverse().find((event) => event.event === 'swipe');
  assert.ok(swipeEvent, '要推一条 swipe 事件告诉前端候选变了');
  assert.equal(swipeEvent.data.swipes.length, 2);
  assert.equal(swipeEvent.data.swipeId, 1);

  messages = (await call(`/api/chats/${chatId}/messages`)).body.items;
  const after = messages.find((message) => message.id === target.id);
  assert.equal(after.id, target.id, '消息本身的 id 不能变，挂在上面的图和统计才留得住');
  assert.equal(after.swipes.length, 2);
  assert.equal(after.swipeId, 1);
  assert.equal(after.content, after.swipes[1]);

  // 切回第一版 / 再切到第二版
  const first = await call(`/api/chats/${chatId}/messages/${target.id}/swipe`, { method: 'PUT', body: { index: 0 } });
  assert.equal(first.body.swipeId, 0);
  assert.equal(first.body.content, after.swipes[0]);
  const next = await call(`/api/chats/${chatId}/messages/${target.id}/swipe`, { method: 'PUT', body: { delta: 1 } });
  assert.equal(next.body.swipeId, 1);
  // 越界会绕回来（◀ ▶ 循环）
  assert.equal((await call(`/api/chats/${chatId}/messages/${target.id}/swipe`, { method: 'PUT', body: { delta: 1 } })).body.swipeId, 0);
  assert.equal((await call(`/api/chats/${chatId}/messages/${target.id}/swipe`, { method: 'PUT', body: { delta: -1 } })).body.swipeId, 1);

  await call(`/api/chats/${chatId}`, { method: 'DELETE' });
});

test('玩卡区：场景状态能新增角色变量（界面上补的入口）', async () => {
  const card = await call('/api/characters', { method: 'POST', body: { name: '变量测试', description: 'x', first_mes: '喵。' } });
  const created = await call('/api/chats', {
    method: 'POST',
    body: { title: '变量', characterId: card.body.id, persona: { name: '我' } },
  });
  const chatId = created.body.id;

  // 角色变量按角色卡 id 存：界面选中的就是 card.id
  const saved = await call(`/api/state/${chatId}`, {
    method: 'PUT',
    body: { variables: [{ scope: 'character', characterId: card.body.id, key: '好感度', value: 12 }] },
  });
  assert.equal(saved.status, 200);
  const row = (saved.body.variables ?? []).find((item) => item.key === '好感度');
  assert.ok(row, '角色变量要存下来');
  assert.equal(row.scope, 'character');
  assert.equal(row.characterId, card.body.id);

  // 对话变量与角色变量互不干扰
  await call(`/api/state/${chatId}`, { method: 'PUT', body: { variables: [{ scope: 'chat', key: '钱', value: 5 }] } });
  const listed = (await call(`/api/state/${chatId}`)).body.variables;
  assert.ok(listed.some((item) => item.scope === 'chat' && item.key === '钱'));
  assert.ok(listed.some((item) => item.scope === 'character' && item.key === '好感度'));

  // 删角色变量也要按 scope + characterId 删
  const removed = await call(`/api/state/${chatId}`, {
    method: 'PUT',
    body: { deleteVariables: [{ scope: 'character', characterId: card.body.id, key: '好感度' }] },
  });
  assert.ok(!(removed.body.variables ?? []).some((item) => item.key === '好感度'));
  assert.ok((removed.body.variables ?? []).some((item) => item.key === '钱'), '别把对话变量一起删了');

  await call(`/api/chats/${chatId}`, { method: 'DELETE' });
  await call(`/api/characters/${card.body.id}`, { method: 'DELETE' });
});

test('写卡区：向量重排、记忆热度、卡内前端沙箱边界', async () => {
  // ---- 重排：多召回一些再挑，重排信息要能看见 ----
  await call('/api/vectors/index-source', {
    method: 'POST',
    body: { collection: 'databank', sourceId: 'rerank-a', content: '旧书馆的二楼藏着不对外开放的旧刊，管理员不让进。' },
  });
  await call('/api/vectors/index-source', {
    method: 'POST',
    body: { collection: 'databank', sourceId: 'rerank-b', content: '今天天气不错，但旧刊还是想找一找。' },
  });
  const plain = await call('/api/vectors/search', { method: 'POST', body: { query: '旧书馆 旧刊', topK: 5 } });
  assert.equal(plain.status, 200);
  assert.ok(plain.body.items.length >= 2);
  const reranked = await call('/api/vectors/search', { method: 'POST', body: { query: '旧书馆 旧刊', topK: 5, rerank: true } });
  assert.equal(reranked.status, 200);
  const top = reranked.body.items[0];
  assert.ok(top.rerank, '开了重排就要带上重排信息');
  assert.equal(typeof top.rerank.rankBefore, 'number');
  assert.equal(top.rerank.rankAfter, 0);
  assert.equal(top.sourceId, 'rerank-a', '命中查询词的片段要顶上来');
  await call('/api/vectors/source/rerank-a?collection=databank', { method: 'DELETE' });
  await call('/api/vectors/source/rerank-b?collection=databank', { method: 'DELETE' });

  // ---- 记忆热度 ----
  const chat = await call('/api/chats', { method: 'POST', body: { title: '热度', character: { name: '阿狸', first_mes: '喵。' }, persona: { name: '我' } } });
  const chatId = chat.body.id;
  await streamCall(`/api/chats/${chatId}/send`, { text: '第一轮' });
  await call('/api/memory/summarize/small', { method: 'POST', body: { chatId, content: '手写一条小总结', title: '热度测试' } });
  const memories = await call(`/api/memory?chatId=${chatId}&limit=50`);
  assert.ok(memories.body.items.length >= 1);
  assert.ok(memories.body.items[0].heat > 0 && memories.body.items[0].heat <= 1, '每条记忆都要有热度');
  const byHeat = await call(`/api/memory?chatId=${chatId}&limit=50&sort=heat`);
  assert.ok(byHeat.body.items[0].heat >= byHeat.body.items.at(-1).heat, '按热度排序要真的降序');
  const timeline = await call(`/api/memory/timeline?chatId=${chatId}`);
  assert.ok(timeline.body.items.every((item) => typeof item.heat === 'number'), '时间线的每条也带热度');
  await call(`/api/chats/${chatId}`, { method: 'DELETE' });

  // ---- 卡内前端沙箱 ----
  const policy = await call('/api/frontend/policy');
  assert.equal(policy.status, 200);
  assert.equal(policy.body.iframe.sandbox, 'allow-scripts');
  assert.match(policy.body.csp, /connect-src 'none'/);

  const clean = await call('/api/frontend/validate', {
    method: 'POST',
    body: { html: '<div>hi</div>', css: '.a{}', js: "Tavern.vars.get('a')", capabilities: ['chat.vars.read'] },
  });
  assert.equal(clean.body.ok, true);
  assert.equal(clean.body.errors, 0);

  const dirty = await call('/api/frontend/validate', {
    method: 'POST',
    body: { html: '<iframe src="x"></iframe>', js: 'fetch("/x"); localStorage.setItem("a","b");', capabilities: ['no.such.capability'] },
  });
  assert.equal(dirty.body.ok, false);
  assert.ok(dirty.body.issues.some((issue) => issue.rule === 'js.fetch'));
  assert.ok(dirty.body.issues.some((issue) => issue.rule === 'html.iframe'));
  assert.ok(dirty.body.issues.some((issue) => issue.rule === 'capability.unknown'));

  const rendered = await call('/api/frontend/render', {
    method: 'POST',
    body: { html: '<b>hi</b>', css: 'b{color:red}', js: 'Tavern.ready();', capabilities: ['chat.vars.read'] },
  });
  assert.equal(rendered.status, 200);
  assert.match(rendered.body.srcdoc, /Content-Security-Policy/);
  assert.match(rendered.body.srcdoc, /connect-src 'none'/);
  assert.equal(rendered.body.sandbox, 'allow-scripts');
  assert.ok(rendered.body.srcdoc.includes('var allowed = ["chat.vars.read"]'));
  // 越界的写法直接拒绝渲染
  const blocked = await call('/api/frontend/render', { method: 'POST', body: { js: 'fetch("https://example.com")' } });
  assert.equal(blocked.status, 400);
});

test('写卡区加分项：剧本大纲 / 关系图 / BGM 清单 / 一致性锁定接口', async () => {
  const card = await call('/api/characters', { method: 'POST', body: { name: '锁定测试', description: '原始简介', personality: '冷静' } });
  assert.equal(card.status, 201);
  const id = card.body.id;

  const before = await call(`/api/characters/${id}/extras`);
  assert.equal(before.status, 200);
  assert.ok(before.body.lockableFields.some((item) => item.id === 'name'));
  assert.deepEqual(before.body.extras.locks, []);

  const saved = await call(`/api/characters/${id}/extras`, {
    method: 'PUT',
    body: {
      outline: { logline: '雪夜相遇', chapters: [{ title: '第一章', summary: '旧书馆' }] },
      relations: [{ from: '阿狸', to: '书生', label: '师徒' }],
      audio: { bgm: [], sfx: [] },
      locks: ['name'],
    },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.extras.outline.chapters.length, 1);
  assert.equal(saved.body.extras.relations.length, 1);
  assert.deepEqual(saved.body.extras.locks, ['name']);

  // 锁定生效：改名字 409；原样发整份数据不算改
  const currentData = (await call(`/api/characters/${id}`)).body.data;
  const unchanged = await call(`/api/characters/${id}`, { method: 'PUT', body: { data: currentData } });
  assert.equal(unchanged.status, 200, '原样保存不该被锁定拦下');
  const blocked = await call(`/api/characters/${id}`, { method: 'PUT', body: { data: { ...currentData, name: '新名字' } } });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error.message, /一致性锁定/);
  // 没锁的字段照旧能改
  const ok = await call(`/api/characters/${id}`, { method: 'PUT', body: { data: { ...currentData, description: '改过的简介' } } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.description, '改过的简介');
  // 解锁后能改名字
  await call(`/api/characters/${id}/extras`, { method: 'PUT', body: { locks: [] } });
  const renamed = await call(`/api/characters/${id}`, { method: 'PUT', body: { data: { ...ok.body.data, name: '新名字' } } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.data.name, '新名字');

  // 卡内加分项跟着卡导出走（是 extensions 里的未知字段）
  const exported = await call(`/api/characters/${id}/export?format=json`, { raw: true });
  assert.equal(exported.status, 200);

  await call(`/api/characters/${id}`, { method: 'DELETE' });
});

test('卡内前端：主题保存与卡内代码持久化接口可用（不再是 501）', async () => {
  const tokens = await call('/api/frontend/theme-tokens');
  assert.ok(tokens.body.items.some((item) => item.id === '--st-accent'));
  const builtin = await call('/api/frontend/themes');
  assert.ok(builtin.body.total >= 3);

  const saved = await call('/api/frontend/themes', { method: 'POST', body: { name: '测试主题', tokens: { '--st-accent': '#ff88aa' } } });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.tokens['--st-accent'], '#ff88aa');
  const updated = await call(`/api/frontend/themes/${saved.body.id}`, { method: 'PUT', body: { name: '测试主题2', tokens: { '--st-accent': '#123456' } } });
  assert.equal(updated.body.name, '测试主题2');
  assert.equal(updated.body.tokens['--st-accent'], '#123456');
  assert.equal((await call(`/api/frontend/themes/${saved.body.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await call(`/api/frontend/themes/${saved.body.id}`, { method: 'DELETE' })).status, 404);

  const snippet = await call('/api/frontend/snippets', {
    method: 'POST',
    body: { scope: 'global', name: '状态栏', html: '<b>x</b>', css: '', js: 'Tavern.ready();', capabilities: ['chat.vars.read'] },
  });
  assert.equal(snippet.status, 201);
  assert.deepEqual(snippet.body.capabilities, ['chat.vars.read']);
  assert.ok((await call('/api/frontend/snippets?scope=global')).body.total >= 1);
  assert.equal((await call('/api/frontend/snippets?scope=nope')).body.total, 0);
  // 越界代码保存也要拦住（不只是渲染时拦）
  const bad = await call('/api/frontend/snippets', { method: 'POST', body: { name: 'bad', js: 'localStorage.setItem("a","b")' } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /沙箱边界/);
  assert.equal((await call(`/api/frontend/snippets/${snippet.body.id}`, { method: 'PUT', body: { name: '状态栏2' } })).body.name, '状态栏2');
  assert.equal((await call(`/api/frontend/snippets/${snippet.body.id}`, { method: 'DELETE' })).status, 204);
});

test('卡内前端：把外链资源抓进本地（素材库 + URL 重写）', async () => {
  const imgBase = mockBase.replace(/\/v1$/, '');
  const own = await call('/api/characters', { method: 'POST', body: { name: '本地化测试', description: 'x', first_mes: 'hi' } });
  assert.equal(own.status, 201);
  const cardId = own.body.id;

  const saved = await call(`/api/characters/${cardId}/frontend`, {
    method: 'POST',
    body: {
      html: `<img src="${imgBase}/img/octet.png">`,
      css: `body{background:url('${imgBase}/img/a.png')}`,
      js: `var gone = '${imgBase}/img/missing.png';`,
    },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.policy.tier, 'own', '自己新建的卡是 own 档');

  const stream = await streamCall(`/api/characters/${cardId}/frontend/localise`, {});
  assert.equal(stream.status, 200);
  const start = stream.events.find((event) => event.event === 'start');
  assert.equal(start.data.total, 3, 'html / css / js 里的三条外链都要被发现');
  const done = stream.events.find((event) => event.event === 'done');
  assert.equal(done.data.downloaded, 2, '两张能抓的要抓下来');
  assert.equal(done.data.failed.length, 1, '404 那张要如实报失败');
  assert.match(done.data.failed[0].reason, /404/);
  assert.ok(done.data.bytes > 0, '要统计占了多少空间');
  assert.equal(done.data.saved, true, '改完要写回卡里');

  const after = await call(`/api/characters/${cardId}/frontend`);
  assert.ok(after.body.code.html.includes('/api/assets/'), 'html 里的外链要换成本地地址');
  assert.ok(after.body.code.css.includes('/api/assets/'));
  assert.ok(!after.body.code.html.includes(imgBase), '原来的外链地址不该还留在 html 里');
  assert.ok(after.body.code.js.includes(`${imgBase}/img/missing.png`), '抓失败的那条要原样留着，不能静默删掉');

  // 素材真的取得到，而且 mime 是按魔数纠正过的（对方回的是 application/octet-stream）
  const assetId = /\/api\/assets\/([^/]+)\/file/.exec(after.body.code.html)[1];
  const file = await fetch(`${base}/api/assets/${assetId}/file`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png', 'octet-stream 要按魔数纠正成 image/png，否则 <img> 不认');
  assert.equal(Buffer.from(await file.arrayBuffer()).length, MOCK_PNG.length);

  // 再抓一次：只剩下那条抓不到的，不会重复下载
  const again = await streamCall(`/api/characters/${cardId}/frontend/localise`, {});
  const againDone = again.events.find((event) => event.event === 'done');
  assert.equal(againDone.data.total, 1, '已经本地化的不该再被当成外链');
  assert.equal(againDone.data.downloaded, 0);

  await call(`/api/characters/${cardId}`, { method: 'DELETE' });
});

test('从平台作品导入：设定进系统提示、世界书进卡内世界书、前端拆三段', async () => {
  const document = {
    app_name: '平台作品',
    prpt: '设定内容在提示词里',
    prefix_txt: '前置词原文',
    suffix_txt: '后置词原文',
    opening_statement: '选择一段开场白',
    desc: '<div onclick="x()">界面</div><style>.a{color:red}</style><script>var a=1;</script>',
    builtInCss: '.global{color:blue}',
    world_bk: [
      { key: '_or_甲@wb@乙', match_type: 2, value: '# 甲乙\n内容', enable: true, group: '功能', sort: 3 },
      { key: '_or_丙', match_type: 2, value: '丙的内容', enable: false },
    ],
    // 封面指到假模型服务上那张真 PNG：导入时应该被抓下来当卡头像
    cover: `${mockBase.replace(/\/v1$/, '')}/img/cover.png`,
    // 卡自己的横幅背景：也要抓下来，挂进卡内前端（沙箱里是 --st-card-bg）
    bg_image: `${mockBase.replace(/\/v1$/, '')}/img/banner.png`,
  };

  const imported = await call('/api/characters/import-platform', { method: 'POST', body: { document } });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  assert.equal(imported.body.card.source, 'imported', '默认导成导入卡（安全档）');
  assert.equal(imported.body.report.worldbook.total, 2);
  assert.equal(imported.body.report.frontendCheck.needsTrust, true, '导入卡跑之前要先信任');
  assert.ok(imported.body.report.frontendCheck.errors >= 1, 'onclick 这类写法要如实报出来');
  assert.ok(!imported.body.report.notImported.includes('封面图'), '封面现在会去抓，不该再报没导');
  assert.equal(imported.body.cover?.ok, true, `封面要抓到，实际：${JSON.stringify(imported.body.cover)}`);
  assert.equal(imported.body.cover.as, 'avatar', 'PNG 封面直接当卡头像');
  assert.equal(imported.body.background?.ok, true, `卡背景要抓到，实际：${JSON.stringify(imported.body.background)}`);
  assert.ok(imported.body.background.assetId, '卡背景要存进素材库');

  const cardId = imported.body.card.id;
  const card = await call(`/api/characters/${cardId}`);
  assert.equal(card.body.data.system_prompt, '设定内容在提示词里');
  assert.equal(card.body.data.prefix_text, '前置词原文');
  assert.equal(card.body.data.suffix_text, '后置词原文');
  assert.equal(card.body.data.first_mes, '', '占位开场白不导');
  assert.equal(card.body.data.character_book.entries.length, 2);
  assert.deepEqual(card.body.data.character_book.entries[0].keys, ['甲', '乙']);
  assert.equal(card.body.data.character_book.entries[0].group, '功能');
  assert.equal(card.body.data.character_book.entries[1].enabled, false);
  assert.ok(card.body.avatarAssetId, '抓回来的封面要真的存成这张卡的头像');

  const frontend = await call(`/api/characters/${cardId}/frontend`);
  assert.equal(frontend.body.hasCode, true, '界面代码要挂到卡内前端上');
  // 导入卡还没信任，render 是 null（静态检查拦着），所以看挂上去的代码里有没有背景
  assert.match(
    String(frontend.body.code.background ?? ''),
    /^\/api\/assets\/.+\/file$/,
    `导入的横幅要挂到卡内前端的 background 上；实际 background=${JSON.stringify(frontend.body.code.background ?? null)}，code 的键=${Object.keys(frontend.body.code ?? {}).join(',')}`,
  );
  assert.match(frontend.body.code.js, /var a=1;/);
  assert.match(frontend.body.code.css, /\.global\{color:blue\}/);
  assert.ok(!frontend.body.code.html.includes('<script'));

  // 自己写的作品可以直接按"自己的卡"导，省掉信任那一步
  const mine = await call('/api/characters/import-platform?source=original', {
    method: 'POST',
    body: { document: { ...document, app_name: '我自己的作品' } },
  });
  assert.equal(mine.status, 201);
  assert.equal(mine.body.card.source, 'original');
  assert.equal(mine.body.report.frontendCheck.needsTrust, false);

  // 不是平台作品的文件要明确报错，不能悄悄造一张空卡
  const bad = await call('/api/characters/import-platform', { method: 'POST', body: { document: '不是对象' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'BAD_PLATFORM_CARD');

  await call(`/api/characters/${cardId}`, { method: 'DELETE' });
  await call(`/api/characters/${mine.body.card.id}`, { method: 'DELETE' });
});

test('模块（Mod）：自己的样式全放开、别人的收进消息区、带 HTML/JS 的进沙箱', async () => {
  const created = await call('/api/chats', {
    method: 'POST',
    body: { title: '模块测试', character: { name: '甲', first_mes: '嗯。' }, persona: { name: '我' } },
  });
  const chatId = created.body.id;

  const mine = await call('/api/prompts/snippets', {
    method: 'POST',
    body: {
      title: '我的美化', description: '把正文改好看', source: 'original', position: 'after-user',
      body: '【本轮要求】写长一点', css: '.msg-body{color:#a78bfa}',
    },
  });
  assert.equal(mine.status, 201, JSON.stringify(mine.body));
  assert.equal(mine.body.position, 'after-user');
  assert.equal(mine.body.tier.tier, 'own');

  const theirs = await call('/api/prompts/snippets', {
    method: 'POST',
    body: { title: '别人的美化', source: 'imported', css: '.summary{color:red}' },
  });
  assert.equal(theirs.status, 201);
  assert.equal(theirs.body.tier.tier, 'strict');
  assert.equal(theirs.body.tier.needsTrust, true);

  const panel = await call('/api/prompts/snippets', {
    method: 'POST',
    body: { title: '状态面板', source: 'original', html: '<b>hp</b>', js: 'Tavern.vars.get("hp");', capabilities: ['chat.vars.read'] },
  });
  assert.equal(panel.status, 201);

  // 别人的模块带违规样式：存的时候就拦
  const bad = await call('/api/prompts/snippets', {
    method: 'POST',
    body: { title: '坏的', source: 'imported', css: '.x{position:fixed;inset:0}' },
  });
  assert.equal(bad.status, 400, '别人的模块不许 position:fixed');
  assert.match(bad.body.error.message, /不能这么写|position:fixed/);

  const attached = await call(`/api/chats/${chatId}/modules`, {
    method: 'PUT',
    body: { ids: [mine.body.id, theirs.body.id, panel.body.id] },
  });
  assert.equal(attached.status, 200);

  const got = await call(`/api/chats/${chatId}/modules`);
  assert.equal(got.body.attachedIds.length, 3);
  assert.match(got.body.css, /\.msg-body\{color:#a78bfa\}/, '自己写的模块：样式原样注入，能改整个聊天页');
  assert.match(got.body.css, /\.st-mod-scope \.summary\{color:red\}/, '别人的模块：样式被收进消息区');
  assert.equal(got.body.panels.length, 1, '带 HTML/JS 的模块给沙箱面板，不给聊天页样式');
  assert.match(got.body.panels[0].render.srcdoc, /connect-src 'none'/, '面板跑在沙箱里，脚本不能联网');
  assert.match(got.body.panels[0].render.srcdoc, /Tavern\.vars\.get/, '模块的脚本原样进沙箱');
  assert.ok(got.body.notes.some((note) => note.includes('只作用在消息区')));

  // 信任之后，别人的模块也不再收进消息区
  const trusted = await call(`/api/prompts/snippets/${theirs.body.id}/trust`, { method: 'POST', body: {} });
  assert.equal(trusted.body.tier, 'strict');
  assert.equal(trusted.body.trusted, true, '信任过就该放开');
  const afterTrust = await call(`/api/chats/${chatId}/modules`);
  assert.match(afterTrust.body.css, /\.summary\{color:red\}/, '信任过就原样注入');
  assert.ok(!/st-mod-scope/.test(afterTrust.body.css));

  // 挂一个不存在的模块要明确报错
  const nope = await call(`/api/chats/${chatId}/modules`, { method: 'PUT', body: { ids: ['mod_不存在'] } });
  assert.equal(nope.status, 400);

  // 模块的提示词真的会进这一轮的提示词
  await streamCall(`/api/chats/${chatId}/send`, { text: '开始吧' });
  const sent = JSON.parse(mockModel.lastRequest.bodyText);
  const lastUser = sent.messages.filter((message) => message.role === 'user').at(-1);
  assert.match(lastUser.content, /写长一点/, 'after-user 位置的模块要拼在最后一条用户消息后面');

  await call(`/api/chats/${chatId}`, { method: 'DELETE' });
  for (const item of [mine, theirs, panel]) await call(`/api/prompts/snippets/${item.body.id}`, { method: 'DELETE' });
});

test('演出层：舞台状态、按场景出背景（复用 3.1）、导出 Ren\'Py 工程', async () => {
  const created = await call('/api/chats', {
    method: 'POST',
    body: { title: '演出', character: { name: '阿狸', first_mes: '你终于来了。' }, persona: { name: '我' } },
  });
  const chatId = created.body.id;
  await streamCall(`/api/chats/${chatId}/send`, { text: '外面下雨了。' });
  await call(`/api/state/${chatId}`, { method: 'PUT', body: { worldState: { place: '旧书馆', time: '深夜' } } });

  const stage = await call(`/api/staging/${chatId}`);
  assert.equal(stage.status, 200);
  assert.equal(stage.body.scene.place, '旧书馆');
  assert.ok(stage.body.dialogue.length >= 2, '台词来自这条对话');
  assert.equal(stage.body.persona, '我');
  assert.equal(typeof stage.body.counts.backgrounds, 'number');
  assert.equal((await call('/api/staging/no-such-chat')).status, 400);

  // 按当前场景出一张背景：走的是 3.1 那条通道（comfy.run），不新造一套
  const generated = await call(`/api/staging/${chatId}/generate`, { method: 'POST', body: { kind: 'background' } });
  assert.equal(generated.status, 202);
  assert.ok(generated.body.promptId, '要拿到 ComfyUI 的 prompt_id');
  assert.ok(generated.body.workflowId);

  // Ren'Py 工程：一个 zip，里面有 script.rpy
  const renpy = await fetch(`${base}/api/staging/${chatId}/renpy`);
  assert.equal(renpy.status, 200);
  assert.equal(renpy.headers.get('content-type'), 'application/zip');
  const zip = Buffer.from(await renpy.arrayBuffer());
  assert.equal(zip.subarray(0, 2).toString('ascii'), 'PK', '是 zip');
  assert.ok(zip.length > 200);

  await call(`/api/chats/${chatId}`, { method: 'DELETE' });
});

test('演出层加分项：转场 / BGM / CG 回廊 / 好感度路线与结局', async () => {
  const created = await call('/api/chats', {
    method: 'POST',
    body: { title: '演出加分', character: { name: '阿狸', first_mes: '你终于来了。' }, persona: { name: '我' } },
  });
  const chatId = created.body.id;
  await call(`/api/state/${chatId}`, { method: 'PUT', body: { worldState: { place: '旧书馆', time: '深夜', affection: { 阿狸: 65 } } } });

  // 出一张背景，等它跑完，回廊里就该有它（走 3.1 那条通道）
  const generated = await call(`/api/staging/${chatId}/generate`, { method: 'POST', body: { kind: 'background' } });
  assert.equal(generated.status, 202);
  let done = null;
  for (let i = 0; i < 30 && !done; i += 1) {
    const runs = await call(`/api/comfy/runs?chatId=${chatId}`);
    const run = runs.body.items.find((item) => item.id === generated.body.id);
    if (run && (run.status === 'done' || run.status === 'error')) done = run;
    else await new Promise((resolve) => setTimeout(resolve, 400));
  }
  assert.ok(done, '背景应该跑完');
  assert.equal(done.status, 'done', done.error ?? '');

  // 舞台一次性带上：演出设置 / 音频解析 / 转场判定 / 路线 / 回廊 / 目录
  const stage = await call(`/api/staging/${chatId}`);
  assert.equal(stage.status, 200);
  assert.ok(stage.body.show, '要有演出设置');
  assert.ok(Array.isArray(stage.body.catalogs.transitions) && stage.body.catalogs.transitions.length >= 4);
  assert.ok(Array.isArray(stage.body.catalogs.routeKinds));
  assert.equal(stage.body.audio.resolved.assetId, null, '还没配 BGM');
  assert.ok(stage.body.gallery.total >= 1, '刚出的背景要进回廊');
  assert.equal(stage.body.gallery.items[0].assetId, done.images[0].assetId, '回廊里要有刚出的那张图');
  assert.equal(typeof stage.body.gallery.items[0].kind, 'string');
  assert.equal(stage.body.routes.items.length, 3, '默认三条模板路线');
  assert.ok(stage.body.routes.unlocked.includes('route-lover'), '好感度 65 解锁到恋人线');
  assert.equal(stage.body.transitionPlan.effect, 'none', '第一次进不转场');

  // 保存演出设置：转场 / 音量 / 自定义路线
  const saved = await call(`/api/staging/${chatId}/show`, {
    method: 'PUT',
    body: {
      transition: { effect: 'shake', durationMs: 400 },
      audio: { volume: 0.4 },
      routes: [{ id: 'route-secret', title: '隐藏线', target: '阿狸', threshold: 60, ending: '只有她知道的那扇门开了。' }],
    },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.show.transition.effect, 'shake');
  assert.equal(saved.body.show.transition.durationMs, 400);
  assert.equal(saved.body.show.audio.volume, 0.4);
  assert.equal(saved.body.show.routes.length, 1);

  // 场景变化 → 服务端算出该放的转场（上一帧由前端带上来）
  await call(`/api/state/${chatId}`, { method: 'PUT', body: { worldState: { place: '教堂', time: '深夜' } } });
  const changed = await call(`/api/staging/${chatId}?prev=1&prevPlace=${encodeURIComponent('旧书馆')}&prevTime=${encodeURIComponent('深夜')}`);
  assert.equal(changed.body.transitionPlan.effect, 'shake');
  assert.match(changed.body.transitionPlan.reason, /场景变化/);

  // 结局收集
  const collected = await call(`/api/staging/${chatId}/endings`, { method: 'POST', body: { routeId: 'route-secret' } });
  assert.equal(collected.status, 201);
  assert.equal(collected.body.endings.length, 1);
  assert.equal(collected.body.endings[0].title, '隐藏线');
  const again = await call(`/api/staging/${chatId}/endings`, { method: 'POST', body: { routeId: 'route-secret' } });
  assert.equal(again.body.endings.length, 1, '同一个结局只收一条');
  assert.equal((await call(`/api/staging/${chatId}/endings`, { method: 'POST', body: { routeId: 'nope' } })).status, 400);

  // 上传一段音频当 BGM → 导出 Ren'Py 时连音频一起带走
  const audioBytes = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00]);
  const audioAsset = await call('/api/assets', { method: 'POST', body: { data: audioBytes.toString('base64'), mime: 'audio/mpeg', name: 'bgm.mp3', kind: 'audio' } });
  assert.equal(audioAsset.status, 201);
  await call(`/api/staging/${chatId}/show`, { method: 'PUT', body: { audio: { bgm: audioAsset.body.id } } });
  const galleryOnlyAudio = await call(`/api/staging/${chatId}/gallery`);
  assert.ok(galleryOnlyAudio.body.total >= 1);

  const renpy = await fetch(`${base}/api/staging/${chatId}/renpy`);
  const zip = Buffer.from(await renpy.arrayBuffer());
  const entries = new Map(readZip(zip).map((entry) => [entry.name, entry.data]));
  assert.ok(entries.has('game/audio/bgm.mp3'), 'zip 里要有 BGM 文件');
  assert.match(entries.get('game/script.rpy').toString('utf8'), /play music "audio\/bgm\.mp3"/);

  await call(`/api/chats/${chatId}`, { method: 'DELETE' });
});

test('演出层：剧本指示编成时间线 / 素材绑定 / CG 演到才解锁 / 存档槽', async () => {
  const created = await call('/api/chats', {
    method: 'POST',
    body: {
      title: '演出脚本',
      character: { name: '阿狸', first_mes: '[场景: 旧书馆]\n你终于来了。[立绘: 阿狸 平静 左]' },
      persona: { name: '我' },
    },
  });
  const chatId = created.body.id;

  // 没绑素材：指示照样解析出来，只是名字还挂着"没图"
  const bare = await call(`/api/staging/${chatId}`);
  assert.equal(bare.status, 200);
  assert.ok(Array.isArray(bare.body.timeline?.frames), '舞台要带上时间线');
  assert.equal(bare.body.timeline.frames[0].stage.background.name, '旧书馆');
  assert.equal(bare.body.timeline.frames[0].stage.background.assetId, null);
  assert.equal(bare.body.timeline.frames[0].text, '你终于来了。', '指示不该漏进台词');
  assert.equal(bare.body.timeline.frames[0].stage.characters[0].position, 'left');
  assert.deepEqual(bare.body.timeline.cgs, [], '还没写 [CG: …]');
  assert.deepEqual(bare.body.saves, [], '新对话没有存档');
  assert.equal(bare.body.playback.textSpeed > 0, true, '要有默认的播放手感');

  // 绑定素材：名字 → 素材库里的图
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const bgAsset = await call('/api/assets', { method: 'POST', body: { data: png.toString('base64'), mime: 'image/png', name: '旧书馆.png', kind: 'image' } });
  assert.equal(bgAsset.status, 201);
  const bound = await call(`/api/staging/${chatId}/show`, {
    method: 'PUT',
    body: { cast: { backgrounds: { 旧书馆: bgAsset.body.id } }, playback: { textSpeed: 0 } },
  });
  assert.equal(bound.status, 200);
  assert.equal(bound.body.show.cast.backgrounds['旧书馆'], bgAsset.body.id);
  assert.equal(bound.body.show.playback.textSpeed, 0);

  const withCast = await call(`/api/staging/${chatId}`);
  assert.equal(withCast.body.timeline.frames[0].stage.background.assetId, bgAsset.body.id, '绑上之后时间线里要能取到素材');

  // CG：演到才解锁，而且幂等
  const first = await call(`/api/staging/${chatId}/unlocks`, { method: 'POST', body: { name: '初雪', messageId: 'm-x' } });
  assert.equal(first.status, 201);
  assert.equal(first.body.added, true);
  assert.equal(first.body.unlocks.length, 1);
  const again = await call(`/api/staging/${chatId}/unlocks`, { method: 'POST', body: { name: '初雪' } });
  assert.equal(again.status, 200);
  assert.equal(again.body.added, false, '同一张 CG 只算解锁一次');
  assert.equal(again.body.unlocks.length, 1);
  assert.equal((await call(`/api/staging/${chatId}/unlocks`, { method: 'POST', body: { name: '  ' } })).status, 400);
  const afterUnlock = await call(`/api/staging/${chatId}`);
  assert.deepEqual(afterUnlock.body.unlocks.map((item) => item.name), ['初雪']);

  // 存档槽：写、覆盖、删
  const saved = await call(`/api/staging/${chatId}/saves`, {
    method: 'PUT',
    body: { slot: 2, lineIndex: 0, name: '阿狸', text: '你终于来了。', scene: '旧书馆', shotAssetId: bgAsset.body.id },
  });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.saves.length, 1);
  assert.equal(saved.body.saves[0].slot, 2);
  assert.equal(saved.body.saves[0].scene, '旧书馆');
  const overwritten = await call(`/api/staging/${chatId}/saves`, { method: 'PUT', body: { slot: 2, lineIndex: 5, text: '后面的' } });
  assert.equal(overwritten.body.saves.length, 1, '同槽覆盖');
  assert.equal(overwritten.body.saves[0].lineIndex, 5);
  assert.equal((await call(`/api/staging/${chatId}/saves`, { method: 'PUT', body: { slot: 0 } })).status, 400);
  const cleared = await call(`/api/staging/${chatId}/saves/2`, { method: 'DELETE' });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body.saves, []);

  assert.equal((await call('/api/staging/no-such-chat/unlocks', { method: 'POST', body: { name: 'x' } })).status, 400);
  assert.equal((await call('/api/staging/no-such-chat/saves', { method: 'PUT', body: { slot: 1 } })).status, 400);

  // 路线锁定：进了恋人线，别的线锁上（谁锁的说得清），也能手动放出来
  await call(`/api/staging/${chatId}/show`, {
    method: 'PUT',
    body: {
      routes: [
        { id: 'route-lover', title: '恋人线', target: '阿狸', threshold: 60, ending: '雪停了。' },
        { id: 'route-friend', title: '挚友线', target: '阿狸', threshold: 30, ending: '还是朋友。' },
      ],
    },
  });
  const entered = await call(`/api/staging/${chatId}/routes/enter`, { method: 'POST', body: { name: '恋人线' } });
  assert.equal(entered.status, 200);
  assert.equal(entered.body.items.find((item) => item.id === 'route-friend').locked, true, '别的线要锁上');
  assert.equal(entered.body.items.find((item) => item.id === 'route-friend').lockedBy, '恋人线', '要能说清是被谁锁的');
  assert.equal(entered.body.items.find((item) => item.id === 'route-lover').locked, false);
  assert.equal((await call(`/api/staging/${chatId}/routes/enter`, { method: 'POST', body: { name: '没这条线' } })).status, 400);
  const freed = await call(`/api/staging/${chatId}/routes/route-friend/unlock`, { method: 'POST', body: {} });
  assert.equal(freed.status, 200);
  assert.equal(freed.body.items.find((item) => item.id === 'route-friend').locked, false, '手动解锁要生效');

  await call(`/api/chats/${chatId}`, { method: 'DELETE' });
});

test('叙事加分项：章节 CRUD / 结局收集 / 随机事件开关与试掷', async () => {
  const created = await call('/api/chats', {
    method: 'POST',
    body: { title: '章节测试', character: { name: '阿狸', first_mes: '喵。' }, persona: { name: '我' } },
  });
  const chatId = created.body.id;
  await streamCall(`/api/chats/${chatId}/send`, { text: '第二句' });
  const messages = (await call(`/api/chats/${chatId}/messages`)).body.items;
  assert.ok(messages.length >= 2);

  const initial = await call(`/api/narration/${chatId}/chapters`);
  assert.equal(initial.body.total, 1, '没分章时整条算一章');

  const first = await call(`/api/narration/${chatId}/chapters`, { method: 'POST', body: { title: '第一章', summary: '开场', messageId: messages[0].id } });
  assert.equal(first.status, 201);
  assert.equal(first.body.items[0].title, '第一章');
  const second = await call(`/api/narration/${chatId}/chapters`, { method: 'POST', body: { title: '第二章', messageId: messages[messages.length - 1].id } });
  assert.equal(second.body.total, 2);
  const chapterId = second.body.items[1].id;
  const renamed = await call(`/api/narration/${chatId}/chapters/${chapterId}`, { method: 'PUT', body: { title: '第二章 改名' } });
  assert.equal(renamed.body.items.find((item) => item.id === chapterId).title, '第二章 改名');
  assert.equal(renamed.body.items.find((item) => item.id === chapterId).messageId, messages[messages.length - 1].id, '改名不动起始消息');
  assert.equal((await call(`/api/narration/${chatId}/chapters/${chapterId}`, { method: 'DELETE' })).status, 204);
  assert.equal((await call(`/api/narration/${chatId}/chapters`)).body.stored.length, 1);

  // 结局收集
  const collected = await call(`/api/narration/${chatId}/endings`, { method: 'POST', body: { routeId: 'route-true', title: '真结局' } });
  assert.equal(collected.status, 201);
  assert.equal(collected.body.total, 1);
  assert.equal((await call(`/api/narration/${chatId}/endings`)).body.items[0].title, '真结局');

  // 随机事件
  const ev0 = await call(`/api/narration/${chatId}/events`);
  assert.equal(ev0.body.settings.enabled, false);
  assert.ok(ev0.body.defaults.length >= 4);
  const saved = await call(`/api/narration/${chatId}/events`, { method: 'PUT', body: { enabled: true, chance: 0.5 } });
  assert.equal(saved.body.settings.enabled, true);
  assert.equal(saved.body.settings.chance, 0.5);
  assert.equal((await call(`/api/narration/${chatId}/events/roll`, { method: 'POST', body: { chanceRoll: 0, roll: 0 } })).body.fired, true);
  assert.equal((await call(`/api/narration/${chatId}/events/roll`, { method: 'POST', body: { chanceRoll: 0.9, roll: 0 } })).body.fired, false);

  // 概率 1：真的发一轮会先插一条旁白
  await call(`/api/narration/${chatId}/events`, { method: 'PUT', body: { enabled: true, chance: 1 } });
  await streamCall(`/api/chats/${chatId}/send`, { text: '继续' });
  const after = (await call(`/api/chats/${chatId}/messages`)).body.items;
  assert.ok(after.some((message) => message.extra?.randomEvent), '开着随机事件时发一轮要插一条旁白');

  await call(`/api/chats/${chatId}`, { method: 'DELETE' });
});

test('工具箱加分项：角色绑定 / 批量表情 / 参考图图生图（服务器执行）', async () => {
  const card = await call('/api/characters', { method: 'POST', body: { name: '阿狸出图', description: '狐妖' } });
  assert.equal(card.status, 201);
  const characterId = card.body.id;

  const expressions = await call('/api/comfy/expressions');
  assert.ok(expressions.body.items.some((item) => item.id === 'happy'));

  // 角色绑定：工作流 + LoRA + 表情差分包
  const portrait = (await call('/api/comfy/workflows')).body.items.find((workflow) => workflow.kind === 'portrait');
  assert.ok(portrait);
  const saved = await call(`/api/comfy/character-bindings/${characterId}`, {
    method: 'PUT',
    body: { workflowId: portrait.id, loraText: '<lora:test:0.8>', expressions: { 开心: portrait.id } },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.loraText, '<lora:test:0.8>');
  assert.deepEqual(saved.body.expressions, { 开心: portrait.id });
  assert.ok((await call('/api/comfy/character-bindings')).body.total >= 1);
  assert.equal((await call(`/api/comfy/character-bindings/${characterId}`)).body.workflowId, portrait.id);

  // 批量表情：两个表情各提交一次
  const batch = await call('/api/comfy/batch-expressions', { method: 'POST', body: { workflowId: portrait.id, emotions: ['happy', 'sad'], chatId: 'chat-batch' } });
  assert.equal(batch.status, 202);
  assert.equal(batch.body.items.length, 2);
  assert.ok(batch.body.items.every((item) => item.ok), JSON.stringify(batch.body.items));
  const submitted = mockComfy.state.submitted.slice(-2);
  assert.match(submitted[0].body.prompt['6'].inputs.text, /smiling/);
  assert.match(submitted[1].body.prompt['6'].inputs.text, /crying/);

  // 参考图（图生图）：素材先上传到 ComfyUI，再提交
  const preset = await call('/api/comfy/presets/preset-img2img', { method: 'POST', body: {} });
  assert.equal(preset.status, 201);
  const refBytes = Buffer.from('reference-image-for-img2img');
  const asset = await call('/api/assets', { method: 'POST', body: { data: refBytes.toString('base64'), mime: 'image/png', name: 'ref.png' } });
  const uploadsBefore = mockComfy.state.uploads.length;
  const img2img = await call('/api/comfy/img2img', { method: 'POST', body: { workflowId: preset.body.id, referenceAssetId: asset.body.id, chatId: 'chat-img2img' } });
  assert.equal(img2img.status, 202);
  let done = null;
  for (let i = 0; i < 30 && !done; i += 1) {
    const one = await call(`/api/comfy/runs/${img2img.body.id}`);
    if (one.body.status === 'done' || one.body.status === 'error') done = one.body;
    else await new Promise((resolve) => setTimeout(resolve, 400));
  }
  assert.ok(done, '参考图出图应该跑完');
  assert.equal(done.status, 'done', done.error ?? '');
  assert.equal(mockComfy.state.uploads.length, uploadsBefore + 1, '参考图要上传给 ComfyUI');
  const last = mockComfy.state.submitted.at(-1);
  assert.equal(last.body.prompt['8'].inputs.image, mockComfy.state.uploads.at(-1).name, 'LoadImage 要换成上传后的文件名');
  assert.ok(done.images.length, '图生图的结果也要进素材库');
  const assetInfo = await call(`/api/assets/${done.images[0].assetId}`);
  assert.ok(assetInfo.body.refCount >= 1, '出图记录要算进引用计数');

  await call(`/api/comfy/workflows/${preset.body.id}`, { method: 'DELETE' });
  await call(`/api/comfy/character-bindings/${characterId}`, { method: 'DELETE' });
  assert.equal((await call(`/api/comfy/character-bindings/${characterId}`)).body, null);
  await call(`/api/characters/${characterId}`, { method: 'DELETE' });
});

test('插件机制：本地文件夹放插件即可加载，坏插件不影响主服务', async () => {
  const listing = await call('/api/plugins');
  assert.equal(listing.status, 200);
  const hello = listing.body.items.find((item) => item.name === 'hello');
  assert.ok(hello, '示例插件要加载进来');
  assert.equal(hello.hooks.routes, 2);
  assert.equal(hello.hooks.skills, 1);
  assert.equal(hello.hooks.tools, 1);
  assert.ok(listing.body.errors.some((item) => item.name === 'broken'), '坏插件要进 errors，而不是让服务起不来');

  // 插件注册的接口真的能用
  const hi = await call('/api/hello');
  assert.equal(hi.status, 200);
  assert.equal(hi.body.hello, 'hello');
  assert.equal(hi.body.hits, 1);
  assert.equal((await call('/api/hello')).body.hits, 2);
  assert.deepEqual((await call('/api/hello/echo', { method: 'POST', body: { a: 1 } })).body.echoed, { a: 1 });

  // 模块与视图元数据进 /api/app（core/modules.mjs 的校验不受影响）
  const app = await call('/api/app');
  assert.ok(app.body.modules.some((mod) => mod.id === 'hello-plugin' && mod.plugin === 'hello'));
  assert.ok(app.body.plugins.views.some((view) => view.key === 'hello-plugin' && view.file === 'view.mjs'));

  // 插件自己的浏览器文件由 /api/plugins/<名字>/<文件名> 提供
  const viewFile = await fetch(`${base}/api/plugins/hello/view.mjs`);
  assert.equal(viewFile.status, 200);
  assert.match(viewFile.headers.get('content-type'), /javascript/);
  assert.match(await viewFile.text(), /export default/);
  const cssFile = await fetch(`${base}/api/plugins/hello/style.css`);
  assert.equal(cssFile.status, 200);
  assert.match(cssFile.headers.get('content-type'), /css/);
  // 路径逃逸要被挡掉
  assert.equal((await call('/api/plugins/hello/..%2fplugin.json')).status, 404);
  assert.equal((await call('/api/plugins/nope/view.mjs')).status, 404);

  // 插件技能出现在写卡助手的技能清单里，也能直接跑
  const skills = await call('/api/agent/skills');
  const greet = skills.body.items.find((item) => item.id === 'hello.greet');
  assert.ok(greet, '插件技能要出现在技能清单里');
  assert.equal(greet.source, 'plugin');
  const run = await call('/api/agent/skills/hello.greet/run', { method: 'POST', body: { input: { name: '琥珀' } } });
  assert.equal(run.status, 200);
  assert.equal(run.body.data.greeting, '你好，琥珀');
});

// ---------- 多用户模式（蓝图「多用户 / 权限」，A 方案）----------
// 单用户模式那个 tavern 照旧跑；这里另起一个 multi-user 临时服务，别弄混。

let multiUser = null;
let muDir = null;
let muBase = null;

/** 一套 cookie：浏览器会自动带，fetch 不会，所以手动收 / 手动送。 */
function cookieJar() {
  const jar = new Map();
  return {
    header: () => [...jar].map(([key, value]) => `${key}=${value}`).join('; '),
    capture(response) {
      for (const line of response.headers.getSetCookie?.() ?? []) {
        const [pair] = line.split(';');
        const index = pair.indexOf('=');
        if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
      }
    },
  };
}

async function ensureMultiUser() {
  if (multiUser) return;
  muDir = mkdtempSync(path.join(tmpdir(), 'tavern-mu-'));
  multiUser = await startMultiUser({ port: 0, host: '127.0.0.1', dataDir: muDir, logger: silentLogger });
  muBase = `http://127.0.0.1:${multiUser.address.port}`;
}

async function hostCall(jar, method, pathname, body, { raw = false, headers: extra = {} } = {}) {
  const headers = { ...extra };
  const cookie = jar?.header?.();
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(muBase + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  jar?.capture?.(response);
  const type = response.headers.get('content-type') ?? '';
  if (raw) return { status: response.status, type, buffer: Buffer.from(await response.arrayBuffer()) };
  const payload = type.includes('json') ? await response.json().catch(() => null) : await response.text();
  return { status: response.status, type, body: payload };
}

const chatCount = async (jar) => (await hostCall(jar, 'GET', '/api/chats')).body.items.length;

test('多用户：首页先建管理员，没登录之前业务接口一律 401', async () => {
  await ensureMultiUser();

  const status = await hostCall(cookieJar(), 'GET', '/api/auth/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.multiUser, true);
  assert.equal(status.body.setupRequired, true);
  assert.equal(status.body.authenticated, false);
  assert.equal(status.body.hostRoot, null, '没登录就不该暴露服务器路径');

  const blocked = await hostCall(cookieJar(), 'GET', '/api/chats');
  assert.equal(blocked.status, 401);
  assert.equal(blocked.body.error.code, 'UNAUTHORIZED');

  // 登录页要能拿到（壳是静态文件，登录前也得能加载）
  const shell = await fetch(`${muBase}/`);
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /<div id="app"/);

  const admin = cookieJar();
  const setup = await hostCall(admin, 'POST', '/api/auth/setup', { name: 'boss', password: 'boss-password' });
  assert.equal(setup.status, 201);
  assert.equal(setup.body.user.name, 'boss');
  assert.equal(setup.body.user.role, 'admin');
  assert.match(admin.header(), /st_session=/, '建号后要下发会话 cookie');

  const app = await hostCall(admin, 'GET', '/api/app');
  assert.equal(app.status, 200);
  assert.equal(app.body.hostMode, true);
  assert.equal(app.body.auth.user.role, 'admin');
  assert.ok(app.body.modules.some((mod) => mod.id === 'host'), '管理员要多出主机管理模块');

  // 已经有账号了就不能再走"首次建号"
  const again = await hostCall(cookieJar(), 'POST', '/api/auth/setup', { name: 'other', password: 'other-pass-1' });
  assert.equal(again.status, 409);
});

test('多用户：两个账号互相看不到对方的对话', async () => {
  await ensureMultiUser();
  const admin = cookieJar();
  assert.equal((await hostCall(admin, 'POST', '/api/auth/login', { name: 'boss', password: 'boss-password' })).status, 200);

  // 错口令与不存在的账号回同一个答案，不泄露"这个名字有没有"
  const badPassword = await hostCall(cookieJar(), 'POST', '/api/auth/login', { name: 'boss', password: 'definitely-wrong' });
  assert.equal(badPassword.status, 401);
  assert.equal(badPassword.body.error.code, 'BAD_CREDENTIALS');
  const noSuchUser = await hostCall(cookieJar(), 'POST', '/api/auth/login', { name: 'ghost', password: 'definitely-wrong' });
  assert.equal(noSuchUser.status, 401);
  assert.equal(noSuchUser.body.error.code, 'BAD_CREDENTIALS');

  assert.equal((await hostCall(admin, 'POST', '/api/host/users', { name: 'alice', password: 'alice-pass-1', role: 'user' })).status, 201);
  assert.equal((await hostCall(admin, 'POST', '/api/host/users', { name: 'bob', password: 'bob-pass-123' })).status, 201);
  assert.equal((await hostCall(admin, 'POST', '/api/host/users', { name: 'alice', password: 'alice-pass-1' })).status, 409, '重名要 409');

  const alice = cookieJar();
  const bob = cookieJar();
  assert.equal((await hostCall(alice, 'POST', '/api/auth/login', { name: 'alice', password: 'alice-pass-1' })).status, 200);
  assert.equal((await hostCall(bob, 'POST', '/api/auth/login', { name: 'bob', password: 'bob-pass-123' })).status, 200);

  const aliceApp = await hostCall(alice, 'GET', '/api/app');
  assert.equal(aliceApp.body.hostMode, true);
  assert.equal(aliceApp.body.auth.user.role, 'user');
  assert.ok(!aliceApp.body.modules.some((mod) => mod.id === 'host'), '成员不该看到主机管理');

  assert.equal((await hostCall(alice, 'POST', '/api/chats', { title: 'alice 的对话' })).status, 201);
  assert.equal(await chatCount(alice), 1);
  assert.equal(await chatCount(bob), 0, 'bob 看不到 alice 的对话');

  // 一人一份目录；账号表里只有哈希
  assert.ok(existsSync(path.join(muDir, 'tenants', 'alice', 'tavern.db')));
  assert.ok(existsSync(path.join(muDir, 'tenants', 'bob', 'tavern.db')));
  const accountsText = readFileSync(path.join(muDir, 'accounts.json'), 'utf8');
  assert.ok(!accountsText.includes('alice-pass-1'), '账号表不能存明文口令');
  assert.match(accountsText, /scrypt\$/);
});

test('多用户：租户默认「浏览器直连」，主机不向用户的 ComfyUI 地址发请求', async () => {
  await ensureMultiUser();
  const alice = cookieJar();
  assert.equal((await hostCall(alice, 'POST', '/api/auth/login', { name: 'alice', password: 'alice-pass-1' })).status, 200);

  const config = await hostCall(alice, 'GET', '/api/comfy/config');
  assert.equal(config.body.settings['comfy.executionMode'], 'client', '多用户模式默认「浏览器直连」');
  assert.deepEqual(config.body.executionModes.map((item) => item.id), ['server', 'client']);

  // 地址填成"主机不该碰"的内网地址，状态接口也不能去连它（ok 为 null 表示"由浏览器测"）
  await hostCall(alice, 'PUT', '/api/comfy/config', { 'comfy.baseUrl': 'http://10.255.255.1:8188', 'comfy.enabled': true });
  const status = await hostCall(alice, 'GET', '/api/comfy/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.ok, null);
  assert.equal(status.body.client, true);
});

test('多用户：/api/host/* 只有管理员能用，总览里也没有别人的数据', async () => {
  await ensureMultiUser();
  const alice = cookieJar();
  await hostCall(alice, 'POST', '/api/auth/login', { name: 'alice', password: 'alice-pass-1' });

  const info = await hostCall(alice, 'GET', '/api/host/info');
  assert.equal(info.status, 403);
  assert.equal(info.body.error.code, 'FORBIDDEN');
  assert.equal((await hostCall(alice, 'POST', '/api/host/users', { name: 'mallory', password: 'mallory-pass' })).status, 403);
  assert.equal((await hostCall(alice, 'DELETE', '/api/host/users/bob', { confirm: true })).status, 403);
  assert.equal((await hostCall(alice, 'POST', '/api/host/tenants/alice/unload', {})).status, 403);
  assert.equal((await hostCall(null, 'GET', '/api/host/info')).status, 401, '没登录要 401 而不是 403');

  const admin = cookieJar();
  await hostCall(admin, 'POST', '/api/auth/login', { name: 'boss', password: 'boss-password' });
  const ok = await hostCall(admin, 'GET', '/api/host/info');
  assert.equal(ok.status, 200);
  assert.ok(ok.body.accounts.length >= 3);
  assert.ok(ok.body.tenants.some((tenant) => tenant.name === 'alice' && tenant.loaded));
  assert.ok(!JSON.stringify(ok.body).includes('alice 的对话'), '服务总览不该带别人的对话内容');
});

test('多用户：停用账号后会话立刻失效，启用后能再登录', async () => {
  await ensureMultiUser();
  const admin = cookieJar();
  await hostCall(admin, 'POST', '/api/auth/login', { name: 'boss', password: 'boss-password' });
  const alice = cookieJar();
  await hostCall(alice, 'POST', '/api/auth/login', { name: 'alice', password: 'alice-pass-1' });
  assert.equal((await hostCall(alice, 'GET', '/api/app')).status, 200);

  const off = await hostCall(admin, 'PATCH', '/api/host/users/alice', { disabled: true });
  assert.equal(off.status, 200);
  assert.equal(off.body.disabled, true);
  assert.equal((await hostCall(alice, 'GET', '/api/app')).status, 401, '停用之后旧会话要立刻失效');

  const denied = await hostCall(cookieJar(), 'POST', '/api/auth/login', { name: 'alice', password: 'alice-pass-1' });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'ACCOUNT_DISABLED');

  assert.equal((await hostCall(admin, 'PATCH', '/api/host/users/alice', { disabled: false })).status, 200);
  const back = cookieJar();
  assert.equal((await hostCall(back, 'POST', '/api/auth/login', { name: 'alice', password: 'alice-pass-1' })).status, 200);
  assert.equal(await chatCount(back), 1, '重新登录后自己的数据还在');

  // 管理员别把自己锁在门外
  assert.equal((await hostCall(admin, 'PATCH', '/api/host/users/boss', { disabled: true })).status, 400);
});

test('多用户：加密导出再导入能恢复另一份数据', async () => {
  await ensureMultiUser();
  const alice = cookieJar();
  await hostCall(alice, 'POST', '/api/auth/login', { name: 'alice', password: 'alice-pass-1' });

  const exported = await hostCall(alice, 'POST', '/api/maintenance/export-encrypted', { passphrase: 'alice-export-1' }, { raw: true });
  assert.equal(exported.status, 200);
  assert.equal(exported.buffer.subarray(0, 5).toString('ascii'), 'STBK1');
  assert.ok(exported.buffer.length > 1000, `导出件太小：${exported.buffer.length}`);

  const short = await hostCall(alice, 'POST', '/api/maintenance/export-encrypted', { passphrase: 'short' }, { raw: true });
  assert.equal(short.status, 400, '口令太短不给导出');

  const bob = cookieJar();
  await hostCall(bob, 'POST', '/api/auth/login', { name: 'bob', password: 'bob-pass-123' });
  assert.equal(await chatCount(bob), 0);

  const wrongPass = await hostCall(bob, 'POST', '/api/maintenance/import-encrypted', { passphrase: 'wrong-pass-1', data: exported.buffer.toString('base64') });
  assert.equal(wrongPass.status, 400);

  const imported = await hostCall(bob, 'POST', '/api/maintenance/import-encrypted', { passphrase: 'alice-export-1', data: exported.buffer.toString('base64') });
  assert.equal(imported.status, 200);
  assert.ok(imported.body.imported);
  assert.ok(imported.body.safetyBackup, '恢复前要自动留一份当前的备份');
  assert.equal(await chatCount(bob), 1, '导入之后 bob 拿到了那一份对话');
});

test('多用户：删账号要二次确认，purge 只删自己那个租户目录', async () => {
  await ensureMultiUser();
  const admin = cookieJar();
  await hostCall(admin, 'POST', '/api/auth/login', { name: 'boss', password: 'boss-password' });

  const needConfirm = await hostCall(admin, 'DELETE', '/api/host/users/bob', {});
  assert.equal(needConfirm.status, 200);
  assert.equal(needConfirm.body.needConfirm, true);
  assert.ok(existsSync(path.join(muDir, 'tenants', 'bob')), '确认之前不动数据');

  const removed = await hostCall(admin, 'DELETE', '/api/host/users/bob', { confirm: true });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.purged, false);
  assert.ok(existsSync(path.join(muDir, 'tenants', 'bob')), '不 purge 时数据目录要留着');
  assert.equal((await hostCall(cookieJar(), 'POST', '/api/auth/login', { name: 'bob', password: 'bob-pass-123' })).status, 401);
  assert.equal((await hostCall(admin, 'DELETE', '/api/host/users/bob', { confirm: true })).status, 404);

  // 连数据一起删（purge）
  await hostCall(admin, 'POST', '/api/host/users', { name: 'carol', password: 'carol-pass-1' });
  const carol = cookieJar();
  await hostCall(carol, 'POST', '/api/auth/login', { name: 'carol', password: 'carol-pass-1' });
  await hostCall(carol, 'POST', '/api/chats', { title: 'carol 的对话' });
  assert.ok(existsSync(path.join(muDir, 'tenants', 'carol')));
  const purged = await hostCall(admin, 'DELETE', '/api/host/users/carol', { confirm: true, purge: true });
  assert.equal(purged.status, 200);
  assert.equal(purged.body.purged, true);
  assert.ok(!existsSync(path.join(muDir, 'tenants', 'carol')), 'purge 要删掉数据目录');

  // 管理员不能删自己
  assert.equal((await hostCall(admin, 'DELETE', '/api/host/users/boss', { confirm: true })).status, 400);
  // 路径穿越 / 畸形转义都只该是 4xx，不能炸成 500
  assert.equal((await hostCall(admin, 'DELETE', '/api/host/users/%2E%2E%2F%2E%2E', { confirm: true })).status, 404);
  assert.equal((await hostCall(admin, 'DELETE', '/api/host/users/%', { confirm: true })).status, 404);
});

test('多用户：成员不能靠"本地代理托管"在主机上执行命令', async () => {
  await ensureMultiUser();
  const admin = cookieJar();
  await hostCall(admin, 'POST', '/api/auth/login', { name: 'boss', password: 'boss-password' });
  const alice = cookieJar();
  await hostCall(alice, 'POST', '/api/auth/login', { name: 'alice', password: 'alice-pass-1' });

  const marker = path.join(muDir, 'launcher-executed.txt');
  const spec = {
    command: process.execPath,
    args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`],
  };

  // 成员连"配"都不许配（launcher 会以服务进程的身份执行命令 → 等于主机 RCE）
  const created = await hostCall(alice, 'POST', '/api/providers', { label: '坏代理', kind: 'chat', adapter: 'openai', baseUrl: 'http://127.0.0.1:1/v1', launcher: spec });
  assert.equal(created.status, 403);
  assert.equal(created.body.error.code, 'FORBIDDEN');
  assert.equal((await hostCall(alice, 'POST', '/api/providers/prov_not_mine/start', {})).status, 403);
  assert.equal((await hostCall(alice, 'PUT', '/api/providers/prov_not_mine', { launcher: spec })).status, 403);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(!existsSync(marker), '成员不该能触发主机执行命令');

  // 管理员就是主机主人，照旧能用（命令立刻退出，所以 start 会报"启动后立刻退出"，但进程确实跑了）
  const mine = await hostCall(admin, 'POST', '/api/providers', { label: '我的代理', kind: 'chat', adapter: 'openai', baseUrl: 'http://127.0.0.1:1/v1', launcher: spec });
  assert.equal(mine.status, 201);
  await hostCall(admin, 'POST', `/api/providers/${mine.body.id}/start`, {});
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(existsSync(marker), '管理员（自己的机器）应该还能用本地代理托管');
});

test('多用户：成员不能让主机替他连 ComfyUI（SSRF）', async () => {
  await ensureMultiUser();
  const admin = cookieJar();
  await hostCall(admin, 'POST', '/api/auth/login', { name: 'boss', password: 'boss-password' });
  const alice = cookieJar();
  await hostCall(alice, 'POST', '/api/auth/login', { name: 'alice', password: 'alice-pass-1' });

  // 两条写设置的路都要拦住：让主机进程去连成员自己填的地址 = SSRF（还能从 /system_stats 读回信息）
  const viaComfy = await hostCall(alice, 'PUT', '/api/comfy/config', { 'comfy.executionMode': 'server', 'comfy.baseUrl': 'http://169.254.169.254' });
  assert.equal(viaComfy.status, 403);
  assert.equal(viaComfy.body.error.code, 'FORBIDDEN');
  const viaSettings = await hostCall(alice, 'PUT', '/api/settings', { 'comfy.executionMode': 'server' });
  assert.equal(viaSettings.status, 403);

  // 实际执行模式仍然是浏览器直连
  const config = await hostCall(alice, 'GET', '/api/comfy/config');
  assert.equal(config.body.settings['comfy.executionMode'], 'client');

  // 管理员（主机主人）可以改回去，改完再放回 client 免得影响别的用例
  assert.equal((await hostCall(admin, 'PUT', '/api/comfy/config', { 'comfy.executionMode': 'server' })).status, 200);
  assert.equal((await hostCall(admin, 'PUT', '/api/comfy/config', { 'comfy.executionMode': 'client' })).status, 200);
});

test('多用户：成员不能加本地 MCP 服务器（主机会启动进程）', async () => {
  await ensureMultiUser();
  const admin = cookieJar();
  await hostCall(admin, 'POST', '/api/auth/login', { name: 'boss', password: 'boss-password' });
  const alice = cookieJar();
  await hostCall(alice, 'POST', '/api/auth/login', { name: 'alice', password: 'alice-pass-1' });

  const marker = path.join(muDir, 'mcp-executed.txt');
  const spec = {
    name: '坏 MCP',
    transport: 'stdio',
    command: process.execPath,
    args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`],
  };

  // MCP 客户端方向 = 在主机上 spawn 一个进程，成员一律不许碰
  const created = await hostCall(alice, 'POST', '/api/mcp/servers', spec);
  assert.equal(created.status, 403);
  assert.equal(created.body.error.code, 'FORBIDDEN');
  assert.equal((await hostCall(alice, 'PUT', '/api/mcp/servers/mcp_not_mine', spec)).status, 403);
  assert.equal((await hostCall(alice, 'POST', '/api/mcp/servers/mcp_not_mine/connect', {})).status, 403);
  assert.equal((await hostCall(alice, 'POST', '/api/mcp/servers/mcp_not_mine/call', { tool: 'x', args: {} })).status, 403);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(!existsSync(marker), '成员不该能触发主机启动进程');

  // 管理员（主机主人）照旧能配（只配不连，所以不会有进程被拉起来）
  assert.equal((await hostCall(admin, 'POST', '/api/mcp/servers', spec)).status, 201);
});

test('多用户：登录失败按 IP 限速，伪造的 x-forwarded-for 不算数', async () => {
  await ensureMultiUser();
  let index = 0;
  const wrongLogin = (extra) => hostCall(cookieJar(), 'POST', '/api/auth/login', { name: 'boss', password: `wrong-${index += 1}-password` }, extra ? { headers: extra } : {});

  // 连错 9 次还在窗口内，一次对口令就把失败计数清掉
  for (let i = 0; i < 9; i += 1) assert.equal((await wrongLogin()).status, 401);
  assert.equal((await hostCall(cookieJar(), 'POST', '/api/auth/login', { name: 'boss', password: 'boss-password' })).status, 200, '第 10 次对上了还能进');

  // 再连错：第 10 次仍是 401，第 11 次开始 429
  let saw429 = false;
  for (let i = 0; i < 12 && !saw429; i += 1) {
    const attempt = await wrongLogin();
    if (attempt.status === 429) saw429 = true;
    else assert.equal(attempt.status, 401);
  }
  assert.ok(saw429, '连错十次之后应该限速');

  // 没开 TAVERN_TRUST_PROXY 时不能靠 x-forwarded-for 换一个新桶
  const spoofed = await wrongLogin({ 'x-forwarded-for': '203.0.113.7' });
  assert.equal(spoofed.status, 429, '伪造 x-forwarded-for 不该绕过限速');
});

test('卡内界面：存到卡上、跟着卡走；导入的卡要信任才放行', async () => {
  // 自己新建的卡（source = original）：跳过静态检查、打开对话自动跑
  const own = await call('/api/characters', { method: 'POST', body: { name: '带界面的卡', data: { description: 'x' } } });
  assert.equal(own.status, 201);
  assert.equal(own.body.source, 'original');

  const empty = await call(`/api/characters/${own.body.id}/frontend`);
  assert.equal(empty.status, 200);
  assert.equal(empty.body.hasCode, false);
  assert.equal(empty.body.policy.tier, 'own');
  assert.equal(empty.body.policy.autoRun, true);

  const saved = await call(`/api/characters/${own.body.id}/frontend`, {
    method: 'POST',
    body: { html: '<b>hi</b>', css: 'b{color:red}', js: 'Tavern.ready();', capabilities: ['chat.vars.read'] },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.hasCode, true);
  assert.equal(saved.body.policy.skipLint, true);
  assert.match(saved.body.render.srcdoc, /Tavern\.ready\(\)/);
  assert.match(saved.body.render.srcdoc, /connect-src 'none'/);
  assert.match(saved.body.render.srcdoc, /img-src data: blob: https: http:/, '自己的卡允许外部资源：CSS 里贴图床 URL 就能显示');
  assert.equal(saved.body.policy.allowExternalAssets, true);
  assert.equal(saved.body.render.sandbox, 'allow-scripts');
  assert.ok(Object.keys(saved.body.render.methods ?? {}).length > 0, '宿主侧桥要有方法表');

  // 代码存在卡数据里 → 导出 JSON 时一起走
  const exported = await (await fetch(`${base}/api/characters/${own.body.id}/export?format=json`)).json();
  const carried = exported.data.extensions['silver-tavern'].frontend;
  assert.equal(carried.html, '<b>hi</b>');
  assert.deepEqual(carried.capabilities, ['chat.vars.read']);

  // 自己的卡：连 fetch 都放行（跳过静态检查），但沙箱 CSP 一条不少；只传 js 不该冲掉 html
  const relaxed = await call(`/api/characters/${own.body.id}/frontend`, { method: 'POST', body: { js: "fetch('https://example.com')" } });
  assert.equal(relaxed.status, 200);
  assert.equal(relaxed.body.code.html, '<b>hi</b>');
  assert.match(relaxed.body.render.srcdoc, /connect-src 'none'/);
  assert.equal(relaxed.body.render.sandbox, 'allow-scripts');

  // 别人的卡：走真实导入路径（source = imported）
  const cardJson = Buffer.from(
    JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: '别人的卡', description: 'y', first_mes: 'hi' } }),
  );
  const imported = await call('/api/characters/import?source=imported', {
    method: 'POST',
    body: { files: [{ name: 'other.json', dataBase64: cardJson.toString('base64') }] },
  });
  const importedId = imported.body.items[0].id;
  assert.equal((await call(`/api/characters/${importedId}`)).body.source, 'imported');

  const rejected = await call(`/api/characters/${importedId}/frontend`, {
    method: 'POST',
    body: { html: '<b>x</b>', js: "fetch('https://evil')" },
  });
  assert.equal(rejected.status, 400, '别人的卡：代码要先过静态检查');
  assert.equal(rejected.body.error.code, 'FRONTEND_INVALID');

  const strictSaved = await call(`/api/characters/${importedId}/frontend`, {
    method: 'POST',
    body: { html: '<b>x</b>', js: 'Tavern.ready();' },
  });
  assert.equal(strictSaved.status, 200);
  assert.equal(strictSaved.body.policy.tier, 'strict');
  assert.equal(strictSaved.body.policy.autoRun, false, '别人的卡默认不自动跑');
  assert.equal(strictSaved.body.policy.allowExternalAssets, false, '别人的卡没信任之前不给外链权限');
  assert.ok(!/img-src[^;]*https:/.test(strictSaved.body.render.csp), '没信任的卡 CSP 里不该有外链图片');
  assert.ok(strictSaved.body.render, '过关的代码照样能渲染，只是要你点一下');

  // 手改卡里的代码 = 模拟"别人给你的卡自带一段过不了静态检查的代码"
  const hostile = { html: '<b>x</b>', js: "fetch('https://evil')" };
  await call(`/api/characters/${importedId}/extras`, { method: 'PUT', body: { frontend: hostile } });
  const blockedRun = await call(`/api/characters/${importedId}/frontend`);
  assert.equal(blockedRun.body.render, null, '没过检查的代码不给渲染');
  assert.ok(blockedRun.body.blocked);

  // 点「信任这张卡」：跑得起来了（信任绑的就是这段代码的指纹），但仍然不自动跑
  const trusted = await call(`/api/characters/${importedId}/frontend/trust`, { method: 'POST', body: {} });
  assert.equal(trusted.status, 200);
  assert.equal(trusted.body.policy.trusted, true);
  assert.equal(trusted.body.policy.trustedByUser, true);
  assert.equal(trusted.body.policy.autoRun, false);
  assert.ok(trusted.body.render, '信任过就能跑');
  assert.match(trusted.body.render.srcdoc, /connect-src 'none'/);
  assert.equal(trusted.body.policy.allowExternalAssets, true, '信任过就放开外链资源');
  assert.match(trusted.body.render.srcdoc, /img-src data: blob: https: http:/);
  assert.equal(trusted.body.render.sandbox, 'allow-scripts');

  // 信任 ≠ 改别人的代码：存一段**新的**、过不了检查的代码仍然被拦
  assert.equal(
    (await call(`/api/characters/${importedId}/frontend`, { method: 'POST', body: { js: "fetch('https://evil2')" } })).status,
    400,
    '信任只影响"跑"，不影响"改"',
  );

  // 换一段代码 → 指纹对不上 → 信任自动失效
  await call(`/api/characters/${importedId}/extras`, { method: 'PUT', body: { frontend: { html: '<b>x</b>', js: "fetch('https://evil'); // 改一下" } } });
  assert.equal((await call(`/api/characters/${importedId}/frontend`)).body.policy.trusted, false, '改了代码信任就该失效');

  // 再信一次，然后取消
  await call(`/api/characters/${importedId}/frontend/trust`, { method: 'POST', body: {} });
  assert.equal((await call(`/api/characters/${importedId}/frontend/trust`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(`/api/characters/${importedId}/frontend`)).body.policy.trustedByUser, false);
});

test('数据持久化：重启服务后设置还在', async () => {
  await call('/api/settings', { method: 'PUT', body: { 'ui.theme': 'light' } });
  await tavern.stop();

  const restarted = await startTavern({ port: 0, host: '127.0.0.1', dataDir, logger: silentLogger });
  try {
    const res = await fetch(`http://127.0.0.1:${restarted.address.port}/api/settings`);
    const payload = await res.json();
    assert.equal(payload.settings['ui.theme'], 'light');
  } finally {
    await restarted.stop();
  }
});

test('工坊接口：质检 / 向导 / 世界书语法 / Markdown 卡 / 临场指令 / 采样器 / 套装 / 能力位', async () => {
  // 前面的"数据持久化"用例把主服务停掉了，这里自己起一个（同一个数据目录）
  const server = await startTavern({ port: 0, host: '127.0.0.1', dataDir, logger: silentLogger });
  const origin = `http://127.0.0.1:${server.address.port}`;
  const call = (pathname, options = {}) => callOn(origin, pathname, options);
  try {
  // 模块注册
  const app = await call('/api/app');
  assert.equal(app.status, 200);
  assert.ok((app.body.modules ?? []).some((mod) => mod.id === 'studio'), '工坊模块要在模块清单里');

  // 质检元信息 + 直接体检
  const meta = await call('/api/studio/quality/meta');
  assert.equal(meta.status, 200);
  assert.ok(meta.body.rules.length >= 8, '七病灶至少八条规则');
  assert.equal(meta.body.openingChecks.length, 9, '开场白九项硬检');
  assert.equal(meta.body.dimensions.length, 8, '八维评分');

  const lint = await call('/api/studio/quality', {
    method: 'POST',
    body: { card: { name: '测试', description: '她攥紧了杯子。', first_mes: '「你好。」', tags: ['限左', '洁'] } },
  });
  assert.equal(lint.status, 200);
  assert.ok(lint.body.total >= 0 && lint.body.total <= 100);
  assert.equal(lint.body.dimensions.length, 8);
  const lintNoCard = await call('/api/studio/quality', { method: 'POST', body: {} });
  assert.equal(lintNoCard.status, 400);

  // 建卡向导
  const wizardOptions = await call('/api/studio/wizard/options');
  assert.equal(wizardOptions.body.paradigms.length, 5, '五种开场白范式');
  assert.equal(wizardOptions.body.axes.length, 4, '四元组');
  const draft = await call('/api/studio/wizard/draft', {
    method: 'POST',
    body: { name: '沈知夏', orientation: '限左', genre: '校园', purity: '洁', hooks: ['难攻略'], paradigm: 'event' },
  });
  assert.equal(draft.status, 200);
  assert.ok(draft.body.fields.system_prompt.includes('输出节奏四律'));
  assert.deepEqual(draft.body.tags.slice(0, 3), ['限左', '校园', '洁']);
  const badDraft = await call('/api/studio/wizard/draft', { method: 'POST', body: { name: 'x', orientation: '不存在的性向' } });
  assert.equal(badDraft.status, 400, '非法选项要回 400');

  // 世界书一行语法
  const notation = await call('/api/studio/worldbook/notation/parse', {
    method: 'POST',
    body: { text: '### 甲 | keys: a, b | secondary: c | logic: and_all | order: 250 | trigger: continue\n正文' },
  });
  assert.equal(notation.status, 200);
  assert.equal(notation.body.entries.length, 1);
  assert.deepEqual(notation.body.errors, []);
  assert.deepEqual(notation.body.entries[0].injectionTrigger, ['continue']);
  const badNotation = await call('/api/studio/worldbook/notation/parse', { method: 'POST', body: { text: '   ' } });
  assert.equal(badNotation.status, 400);

  // Markdown 卡
  const md = await call('/api/studio/cards/markdown/parse', {
    method: 'POST',
    body: { markdown: '---\nname: 甲\ntags: [限左, 洁]\n---\n## Description\n设定。\n## Lorebook\n### 乙 | keys: b\n正文' },
  });
  assert.equal(md.status, 200);
  assert.equal(md.body.card.name, '甲');
  assert.equal(md.body.lorebook.length, 1);
  assert.equal(typeof md.body.lint.total, 'number');

  // 临场指令三层
  const putNote = await call('/api/studio/notes/default/-', { method: 'PUT', body: { prompt: '默认层', interval: 2 } });
  assert.equal(putNote.status, 200);
  const notes = await call('/api/studio/notes');
  assert.equal(notes.body.layers.default.prompt, '默认层');
  assert.ok(notes.body.summary.includes('每 2 条'), '摘要要说清插入频率');
  const notePreview = await call('/api/studio/notes/preview', {
    method: 'POST',
    body: { layers: { chat: { prompt: 'x', interval: 3 } }, userTurnCount: 2 },
  });
  assert.equal(notePreview.body.inject, false, 'interval=3 的第 2 轮不该插');
  const badScope = await call('/api/studio/notes/没有这层/-', { method: 'PUT', body: { prompt: 'x' } });
  assert.equal(badScope.status, 400);
  assert.equal((await call('/api/studio/notes/default/-', { method: 'DELETE' })).body.removed, true);
  assert.equal((await call('/api/studio/notes')).body.layers.default, null);

  // 采样器
  const samplerMeta = await call('/api/studio/samplers/meta');
  assert.equal(samplerMeta.body.backends.length, 4);
  assert.ok(samplerMeta.body.catalog.length >= 15);
  const created = await call('/api/studio/samplers', {
    method: 'POST',
    body: { name: '我的配方', backend: 'llamacpp', order: ['top_p', 'temperature'] },
  });
  assert.equal(created.status, 200);
  assert.ok(created.body.diff.includes('顺序改了'));
  const neutralised = await call(`/api/studio/samplers/${created.body.id}/action`, { method: 'POST', body: { action: 'neutralize' } });
  assert.ok(neutralised.body.diff.includes('关掉了'));
  const reset = await call(`/api/studio/samplers/${created.body.id}/action`, { method: 'POST', body: { action: 'reset' } });
  assert.equal(reset.body.diff, '与默认一致');
  const badAction = await call(`/api/studio/samplers/${created.body.id}/action`, { method: 'POST', body: { action: '乱来' } });
  assert.equal(badAction.status, 400);
  assert.equal((await call(`/api/studio/samplers/${created.body.id}`, { method: 'DELETE' })).body.removed, true);

  // 套装：选择性应用
  const loadout = await call('/api/studio/loadouts', {
    method: 'POST',
    body: { name: '校园纯爱', parts: ['persona'], state: { persona: 'p1' } },
  });
  assert.equal(loadout.status, 200);
  const applied = await call(`/api/studio/loadouts/${loadout.body.id}/apply`, {
    method: 'POST',
    body: { apply: ['persona'], current: { persona: '旧', preset: '我的预设' } },
  });
  assert.deepEqual(applied.body.applied, ['persona']);
  assert.equal(applied.body.next.persona, 'p1');
  assert.equal(applied.body.next.preset, '我的预设', '没勾的部分不该被动');
  assert.ok((await call('/api/studio/loadouts')).body.items.some((item) => item.id === loadout.body.id));
  await call(`/api/studio/loadouts/${loadout.body.id}`, { method: 'DELETE' });

  // 连接档案：排除法
  const profile = await call('/api/studio/profiles', {
    method: 'POST',
    body: { name: 'Claude 直连', settings: { apiKey: 'x', baseUrl: 'y' }, exclude: ['baseUrl'] },
  });
  assert.equal(profile.status, 200);
  assert.deepEqual(profile.body.omitted, ['baseUrl']);
  assert.equal(profile.body.settings.apiKey, 'x');
  assert.equal(profile.body.settings.baseUrl, undefined, '被排除的键不该写进去');
  await call(`/api/studio/profiles/${profile.body.id}`, { method: 'DELETE' });

  // 反向代理预设
  const proxy = await call('/api/studio/proxies', { method: 'POST', body: { name: '公益站', payload: { baseUrl: 'https://relay.example/v1' } } });
  assert.equal(proxy.status, 200);
  assert.equal(proxy.body.baseUrl, 'https://relay.example/v1');
  assert.equal((await call(`/api/studio/proxies/${proxy.body.id}`, { method: 'DELETE' })).body.removed, true);

  // 能力位
  const caps = await call('/api/studio/providers/capabilities');
  assert.ok(caps.body.adapters.length >= 5);
  const claudeCaps = await call('/api/studio/providers/capabilities?adapter=anthropic');
  assert.ok(claudeCaps.body.flags.includes('thinking'));
  assert.equal(claudeCaps.body.params.find((param) => param.id === 'reasoningEffort').visible, false, '没有该能力位就得隐藏');
  const deepseekCaps = await call('/api/studio/providers/capabilities?adapter=openai&preset=deepseek');
  assert.ok(deepseekCaps.body.flags.includes('thinking'), '预设能补上适配器没有的能力位');
  } finally {
    await server.stop();
  }
});

test('工坊接口：对库里的卡做质检 / 闸门 / Markdown 导出 / 分支图', async () => {
  const server = await startTavern({ port: 0, host: '127.0.0.1', dataDir, logger: silentLogger });
  const origin = `http://127.0.0.1:${server.address.port}`;
  const call = (pathname, options = {}) => callOn(origin, pathname, options);
  try {
  const created = await call('/api/characters', {
    method: 'POST',
    body: {
      name: '工坊测试卡',
      description: '大二跨栏摔过一次，锁骨下面留了道浅疤。嘴毒，但说的都是实话。',
      first_mes: '【地点】体育馆\n她正蹲着缠护踝。\n「还站着干嘛？」\n<details><summary>状态</summary>心情：待载入</details>\n你还没开口。',
      tags: ['限左', '洁', '校园'],
    },
  });
  assert.ok([200, 201].includes(created.status), `建卡要成功，实际 ${created.status}`);
  const cardId = created.body.id ?? created.body.card?.id ?? created.body.record?.id;
  assert.ok(cardId, '要拿到卡 id');

  const report = await call(`/api/studio/quality/${encodeURIComponent(cardId)}`);
  assert.equal(report.status, 200);
  assert.equal(report.body.dimensions.length, 8);

  const gate = await call(`/api/studio/quality/${encodeURIComponent(cardId)}/gate?threshold=50`);
  assert.equal(gate.status, 200);
  assert.equal(typeof gate.body.pass, 'boolean');
  assert.ok(Array.isArray(gate.body.weak));

  const markdown = await call(`/api/studio/cards/${encodeURIComponent(cardId)}/markdown`);
  assert.equal(markdown.status, 200);
  assert.ok(markdown.body.markdown.includes('工坊测试卡'));
  assert.ok(markdown.body.markdown.includes('## First Message'));

  const branches = await call(`/api/studio/branches?characterId=${encodeURIComponent(cardId)}`);
  assert.equal(branches.status, 200);
  assert.ok(Array.isArray(branches.body.nodes));
  assert.equal(typeof branches.body.stats.chats, 'number');

  // 提示词快照 diff：有快照就能比，没上一轮就如实说明
  const xrayList = await call('/api/xray?limit=5');
  assert.equal(xrayList.status, 200);
  const firstSnapshot = (xrayList.body.items ?? [])[0];
  if (firstSnapshot) {
    const diff = await call(`/api/xray/${encodeURIComponent(firstSnapshot.id)}/diff`);
    assert.equal(diff.status, 200);
    if (diff.body.diff) {
      assert.equal(typeof diff.body.diff.identical, 'boolean');
      assert.ok(Array.isArray(diff.body.diff.changed));
      assert.equal(typeof diff.body.diff.summary, 'string');
    } else {
      assert.ok(diff.body.note.includes('第一份快照'));
    }
  }
  } finally {
    await server.stop();
  }
});

test('玩法补强接口：视觉 / 翻译 / 书签 / 动作 / Logit / 导出 / 代理 / 缩略图', async () => {
  const server = await startTavern({ port: 0, host: '127.0.0.1', dataDir, logger: silentLogger });
  const origin = `http://127.0.0.1:${server.address.port}`;
  const call = (pathname, options = {}) => callOn(origin, pathname, options);
  try {
    // 视觉：元信息 + 模式判定
    const visionMeta = await call('/api/studio/vision/meta');
    assert.equal(visionMeta.status, 200);
    assert.ok(visionMeta.body.mimes.includes('image/png'));
    assert.ok(visionMeta.body.template.includes('{{caption}}'));
    const mode = await call('/api/studio/vision/mode', { method: 'POST', body: {} });
    assert.equal(mode.status, 200);
    assert.ok(['vision', 'caption', 'off'].includes(mode.body.mode));
    // 没有配看图模型时要给出可读的错误（不是 500）
    const caption = await call('/api/studio/vision/caption', { method: 'POST', body: { base64: 'AAAA', mime: 'image/png', bytes: 4, providerId: '不存在' } });
    assert.ok([400, 404, 500].includes(caption.status), `缺提供方要报错，实际 ${caption.status}`);
    const badImage = await call('/api/studio/vision/caption', { method: 'POST', body: { base64: 'AAAA', mime: 'image/tiff', bytes: 4 } });
    assert.equal(badImage.status, 400);

    // 翻译：元信息 + 触发判定 + 只回提示词（不调模型）
    const translateMeta = await call('/api/studio/translate/meta');
    assert.equal(translateMeta.body.targets.length, 6);
    const should = await call('/api/studio/translate/should', { method: 'POST', body: { text: '你好，今天天气不错，我们出去走走吧', target: 'zh-CN', enabled: true } });
    assert.equal(should.body.translate, false, '已经是中文就别再翻');
    const shouldForeign = await call('/api/studio/translate/should', { method: 'POST', body: { text: 'Hello there, how are you doing today', target: 'zh-CN', enabled: true } });
    assert.equal(shouldForeign.body.translate, true);
    const promptOnly = await call('/api/studio/translate', { method: 'POST', body: { text: 'Hello', target: 'ja', promptOnly: true } });
    assert.equal(promptOnly.status, 200);
    assert.ok(promptOnly.body.prompt.includes('日本語'));

    // 书签：增 / 查 / 删
    const bookmark = await call('/api/studio/bookmarks', { method: 'POST', body: { chatId: 'chat-x', messageId: 'msg-1', label: '名场面', color: 'rose' } });
    assert.equal(bookmark.status, 200);
    assert.equal(bookmark.body.label, '名场面');
    const listed = await call('/api/studio/bookmarks?chatId=chat-x');
    assert.equal((listed.body.items ?? []).length, 1);
    assert.ok(listed.body.colors.includes('rose'));
    const overwritten = await call('/api/studio/bookmarks', { method: 'POST', body: { chatId: 'chat-x', messageId: 'msg-1', label: '改过' } });
    assert.equal(overwritten.body.label, '改过', '同一条消息重复打书签是覆盖');
    assert.equal((await call('/api/studio/bookmarks?chatId=chat-x')).body.items.length, 1);
    assert.equal((await call(`/api/studio/bookmarks/${bookmark.body.id}`, { method: 'DELETE' })).body.removed, true, '书签删除要返回 removed=true');
    const badBookmark = await call('/api/studio/bookmarks', { method: 'POST', body: { chatId: 'chat-x' } });
    assert.equal(badBookmark.status, 400);

    // 动作序列：元信息 / 保存 / 展开 / 删除
    const actionMeta = await call('/api/studio/actions/meta');
    assert.ok(actionMeta.body.stepTypes.length >= 10);
    const action = await call('/api/studio/actions', {
      method: 'POST',
      body: { name: '开一局', variables: { 开场: '推开木门' }, steps: [{ type: 'send', text: '{{开场}}' }, { type: 'continue' }] },
    });
    assert.equal(action.status, 200);
    assert.ok(action.body.description.includes('发送消息'));
    const expanded = await call(`/api/studio/actions/${action.body.id}/expand`, { method: 'POST', body: { variables: {} } });
    assert.equal(expanded.body.steps[0].text, '推开木门');
    const badAction = await call('/api/studio/actions', { method: 'POST', body: { name: 'x', steps: [{ type: '乱来' }] } });
    assert.equal(badAction.status, 400);
    assert.equal((await call(`/api/studio/actions/${action.body.id}`, { method: 'DELETE' })).body.removed, true, '动作组删除要返回 removed=true');

    // Logit Bias：内置 + 合并
    const logit = await call('/api/studio/logit');
    assert.equal(logit.status, 200);
    assert.ok(logit.body.builtin.length >= 2);
    assert.equal(logit.body.range.min, -100);
    const merged = await call('/api/studio/logit/merge', { method: 'POST', body: { ids: logit.body.builtin.map((item) => item.id) } });
    assert.ok(Object.keys(merged.body.bias).length > 0);
    const saved = await call('/api/studio/logit', { method: 'POST', body: { name: '我的压词表', bias: { 一丝: -50 } } });
    assert.equal(saved.body.bias['一丝'], -50);
    const badBias = await call('/api/studio/logit', { method: 'POST', body: { name: 'x', bias: { 一丝: 999 } } });
    assert.equal(badBias.status, 400);
    await call(`/api/studio/logit/${saved.body.id}`, { method: 'DELETE' });

    // 导出：用假消息直接导（不需要真对话）
    const html = await call('/api/studio/export/html', {
      method: 'POST',
      body: { title: '雪夜', card: { name: '琥珀' }, messages: [{ role: 'user', content: '在吗' }, { role: 'assistant', content: '好啊' }] },
    });
    assert.equal(html.status, 200);
    assert.ok(html.body.html.includes('<!doctype html>'));
    assert.ok(html.body.html.includes('琥珀'));
    const md = await call('/api/studio/export/html', { method: 'POST', body: { title: '雪夜', messages: [{ role: 'user', content: '在吗' }], format: 'markdown' } });
    assert.ok(md.body.markdown.includes('# 雪夜'));

    // 抓料：内网地址必须被拦（这条不需要真出网）
    const blocked = await call('/api/studio/source/fetch', { method: 'POST', body: { url: 'http://127.0.0.1:8788/api/app' } });
    assert.equal(blocked.status, 400, '内网地址必须挡掉');
    assert.ok(blocked.body.error.message.includes('内网'));
    const badUrl = await call('/api/studio/source/fetch', { method: 'POST', body: { url: '不是网址' } });
    assert.equal(badUrl.status, 400);

    // 思维链拆分
    const split = await call('/api/studio/reasoning/split', { method: 'POST', body: { text: '<thinking>先想想</thinking>她说：好啊。' } });
    assert.equal(split.body.reasoning, '先想想');
    assert.equal(split.body.content, '她说：好啊。');

    // 网络代理：状态可读；测试接口对空地址要报 400
    const proxy = await call('/api/net/proxy');
    assert.equal(proxy.status, 200);
    assert.equal(proxy.body.enabled, false, '默认直连');
    const proxyTest = await call('/api/net/proxy/test', { method: 'POST', body: { proxy: '' } });
    assert.equal(proxyTest.status, 400);
    await call('/api/settings', { method: 'PUT', body: { 'net.proxy': 'http://127.0.0.1:9' } });
    const afterSet = await call('/api/net/proxy');
    assert.equal(afterSet.body.enabled, true, `写了设置之后代理要立刻生效（实际 ${JSON.stringify(afterSet.body)}）`);
    assert.equal(afterSet.body.proxy, 'http://127.0.0.1:9');
    await call('/api/settings', { method: 'PUT', body: { 'net.proxy': '' } });
    assert.equal((await call('/api/net/proxy')).body.enabled, false, '清空就回到直连');

    // 自定义请求体：读 / 写 / 读回
    const created = await call('/api/providers', {
      method: 'POST',
      body: { label: '额外体测试', kind: 'chat', adapter: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'x' },
    });
    const providerId = created.body.id ?? created.body.provider?.id;
    assert.ok(providerId, '要能建出提供方');
    const emptyExtra = await call(`/api/providers/${providerId}/extra-body`);
    assert.deepEqual(emptyExtra.body.extraBody, {});
    const savedExtra = await call(`/api/providers/${providerId}/extra-body`, { method: 'PUT', body: { extraBody: { top_k: 7, chat_template_kwargs: { enable_thinking: false } } } });
    assert.equal(savedExtra.body.extraBody.top_k, 7);
    const readBack = await call(`/api/providers/${providerId}/extra-body`);
    assert.equal(readBack.body.extraBody.chat_template_kwargs.enable_thinking, false);
    const badExtra = await call(`/api/providers/${providerId}/extra-body`, { method: 'PUT', body: { extraBody: [1, 2] } });
    assert.equal(badExtra.status, 400);

    // 缩略图：还没生成时状态是 false，生成之后能取到字节
    const asset = await call('/api/assets', {
      method: 'POST',
      body: { data: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'), kind: 'image', name: 't.png', mime: 'image/png' },
    });
    assert.equal(asset.status, 201);
    const before = await call(`/api/assets/${asset.body.id}/thumb/status`);
    assert.equal(before.body.has, false);
    const savedThumb = await call(`/api/assets/${asset.body.id}/thumbnail`, { method: 'POST', body: { data: Buffer.from('RIFFxxxxWEBP', 'utf8').toString('base64'), mime: 'image/webp', width: 8, height: 8 } });
    assert.equal(savedThumb.status, 201);
    const after = await call(`/api/assets/${asset.body.id}/thumb/status`);
    assert.equal(after.body.has, true, '生成缩略图之后状态要变成 true');
    const thumbBytes = await call(`/api/assets/${asset.body.id}/thumb`, { raw: true });
    assert.equal(thumbBytes.status, 200);
    assert.equal(thumbBytes.type, 'image/webp');
  } finally {
    await server.stop();
  }
});

test('角色卡：拖一个 zip 卡包进去，里面的 PNG / JSON 一次性都进来', async () => {
  // 自己起一个（这台共享服务到这儿已经被前面几个测试停掉了）
  const zipDir = mkdtempSync(path.join(tmpdir(), 'tavern-zip-import-'));
  const server = await startTavern({ port: 0, host: '127.0.0.1', dataDir: zipDir, logger: silentLogger });
  const origin = `http://127.0.0.1:${server.address.port}`;
  try {
    const png = readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'card-amber.png'));
    const jsonCard = Buffer.from(
      JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: '压缩包里的卡', description: '来自 zip' } }),
      'utf8',
    );
    const zip = createZip([
      { name: '卡包/', data: Buffer.alloc(0) },
      { name: '卡包/card-amber.png', data: png },
      { name: '卡包/一只猫.json', data: jsonCard },
      { name: '__MACOSX/._junk.json', data: Buffer.from('{}') },
      { name: 'readme.txt', data: Buffer.from('忽略我') },
    ]);

    const response = await fetch(`${origin}/api/characters/import?name=pack.zip&source=imported`, { method: 'POST', body: zip });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.imported, 2, `zip 里两张卡都要进来，实际：${JSON.stringify(body)}`);

    const found = await (await fetch(`${origin}/api/characters?q=${encodeURIComponent('压缩包里的卡')}`)).json();
    assert.ok(found.items.some((item) => item.name === '压缩包里的卡'), '压缩包里那张 JSON 卡要进库');
  } finally {
    await server.stop();
    rmSync(zipDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

const result = await run();
if (tavern.server.listening) await tavern.stop();
if (multiUser) {
  try {
    await multiUser.stop();
  } catch {
    // 多用户那个服务关不掉也不影响结果
  }
  rmSync(muDir, { recursive: true, force: true });
}
await new Promise((resolve) => mockModel.close(resolve));
await mockComfy.close();
rmSync(dataDir, { recursive: true, force: true });
process.exitCode = result.failed ? 1 : 0;
