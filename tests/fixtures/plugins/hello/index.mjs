/**
 * 示例插件（测试用）：演示四种钩子。
 * 真实插件照这个写就行 —— default export 一个 register(api)。
 */

export default function register(api) {
  let hits = 0;

  // 1) HTTP 接口：必须是 /api/ 开头
  api.routes.get('/api/hello', (ctx) => ctx.json(200, { hello: api.name, hits: (hits += 1) }));
  api.routes.post('/api/hello/echo', async (ctx) => ctx.json(200, { echoed: (await ctx.body()) ?? {} }));

  // 2) 写卡技能：和内置技能同一套 JSON 协议
  api.skills.register({
    id: 'hello.greet',
    title: '打招呼',
    description: '插件注册的示例技能',
    category: 'text',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: [] },
    handler: ({ input }) => ({ greeting: `你好，${input.name ?? '世界'}` }),
  });

  // 3) MCP 工具：把酒馆当 MCP 服务器时会暴露出去
  api.tools.register({
    name: 'hello.ping',
    title: '插件 ping',
    description: '插件注册的示例 MCP 工具',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({ content: [{ type: 'text', text: 'pong' }] }),
  });

  // 4) 视图：服务端只登记元数据，客户端按 manifest.views[].file 动态 import
  api.views.register({ key: 'hello-plugin', title: 'Hello 插件', icon: '👋' });
}
