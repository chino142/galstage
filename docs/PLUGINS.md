# 插件机制

本地文件夹放插件即可加载，不用改本项目的代码、不用构建。

## 放哪里

```
<数据目录>/plugins/<插件名>/
  plugin.json     清单（必需）
  index.mjs       入口（默认，可在清单里改 main）
  view.mjs        插件自己的浏览器界面（可选，无构建 ESM）
  style.css       插件自己的样式（可选）
```

数据目录默认是 `./data`，也可以用 `TAVERN_DATA_DIR` 指定。改完插件**重启服务**即可生效。

## plugin.json

```json
{
  "name": "hello",
  "title": "Hello 插件",
  "version": "1.0.0",
  "description": "一句话说明",
  "main": "index.mjs",
  "enabled": true,
  "modules": [
    {
      "id": "hello-plugin",
      "area": "platform",
      "title": "Hello 插件",
      "summary": "插件机制的示例",
      "status": "ready",
      "web": { "view": "hello-plugin", "icon": "👋" },
      "api": ["/api/hello"],
      "plan": ["注册接口", "注册技能"]
    }
  ],
  "views": [{ "key": "hello-plugin", "file": "view.mjs", "title": "Hello 插件", "icon": "👋" }],
  "styles": ["style.css"]
}
```

- `name` 只允许字母、数字、`-`、`_`，没写就用文件夹名。
- `modules` 会追加到 `/api/app` 的模块清单（侧边栏与命令面板自动多一项）；
  **不改 `core/modules.mjs`**，也就不会影响模块地图自身的依赖校验。
- `views` 声明浏览器模块：客户端启动时按 `/api/plugins/<name>/<file>` 动态 import。
- `styles` 会被自动 `<link>` 进页面。

## index.mjs：四种钩子

入口 default export 一个 `register(api)` 函数，加载时调用一次：

```js
export default function register(api) {
  // 1) HTTP 接口：路径必须以 /api/ 开头，不能覆盖已注册的内置接口
  api.routes.get('/api/hello', (ctx) => ctx.json(200, { hello: api.name }));
  api.routes.post('/api/hello/echo', async (ctx) => ctx.json(200, { echoed: await ctx.body() }));

  // 2) 写卡技能：和内置技能同一套 JSON 协议，会自动出现在「写卡助手」的技能清单里
  api.skills.register({
    id: 'hello.greet',                       // 必须 domain.action（全小写/数字/下划线）
    title: '打招呼',
    description: '示例技能',
    category: 'text',                        // card / worldbook / text / novel / external
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: [] },
    handler: ({ input }) => ({ greeting: `你好，${input.name ?? '世界'}` }),
  });

  // 3) MCP 工具：把酒馆当 MCP 服务器（server/mcp-stdio.mjs）时会一起暴露给 Codex / Claude Code
  api.tools.register({
    name: 'hello.ping',
    title: '插件 ping',
    description: '示例工具',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({ content: [{ type: 'text', text: 'pong' }] }),
  });

  // 4) 视图：动态登记元数据（常规做法是写进 plugin.json 的 views，两者等价）
  api.views.register({ key: 'hello-plugin', title: 'Hello 插件', icon: '👋' });
}
```

`api` 上还有：`manifest`（清单）、`name`、`logger`、`dataDir`、`pluginDir`、`settings()`。

### 工具返回形状

MCP 工具按规范返回 `{ content: [{ type: 'text', text }] }`；如果返回字符串或普通对象，
加载器会帮你包成 MCP 结果，异步 handler 也支持。

## view.mjs：插件界面

浏览器端 ESM，default export 一个工厂函数，和内置视图同一契约：

```js
export default function createHelloView(module, ctx) {
  const el = document.createElement('div');
  el.className = 'view';
  // ctx.ui 里有主前端的零件：h / panel / field / toast / toastError
  // 也可以像这里一样只用原生 DOM —— 没有构建步骤
  const button = document.createElement('button');
  button.className = 'btn primary';
  button.textContent = '调接口';
  button.onclick = async () => { console.log(await (await fetch('/api/hello')).json()); };
  el.append(button);
  return { el, mount() {} };   // mount 可选，挂载时调用
}
```

## 出错会怎样

- 单个插件加载失败（清单不合法、入口抛错、钩子用错）：只记一条警告，进 `/api/plugins` 的
  `errors` 列表，**主服务照常启动**，其它插件照常加载。
- 同名 MCP 工具不会覆盖内置工具（内置行为是契约）。
- 插件文件只按 `/api/plugins/<name>/<file>` 的单层文件名读取，`..` 与路径分隔符都会被拒绝。

## 怎么排查

```powershell
node server/index.mjs            # 启动日志里会打 [plugins] 已加载 / 跳过
GET /api/plugins                 # 看 items（成功）与 errors（失败原因）
GET /api/app                     # 看模块清单里有没有插件的模块
```

示例插件在 `tests/fixtures/plugins/hello/`，坏插件的隔离测试在 `tests/fixtures/plugins/broken/`。
