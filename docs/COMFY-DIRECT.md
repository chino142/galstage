# ComfyUI 连接的两种方式（服务器执行 / 浏览器直连）

「别人的连接不经过我」—— 多用户模式下，朋友填的 ComfyUI 地址不该让**主机进程**去请求。
所以 ComfyUI 有两种执行方式，设置项是 `comfy.executionMode`：

| 值 | 谁去连 ComfyUI | 默认 | 说明 |
|---|---|---|---|
| `server` | 主机进程（`server/toolbox/runner.mjs`） | 单机模式 | 行为与以前完全一致：主机发 `/prompt`、连 WebSocket、下载图片。 |
| `client` | **你自己的浏览器**（`web/ui/comfy-client.mjs`） | 多用户模式 | 主机不向这个地址发任何请求。提示词替换仍在服务端做。 |

界面上：「工具箱 → ComfyUI 接入 → 连接方式」切换；说明文字会跟着变。

## 为什么要有 client 模式

`comfy.baseUrl` 是**用户可控**的地址。`server` 模式下主机进程会去请求它，于是：

- 多用户模式里，朋友的 ComfyUI 必须在**主机这台机器**上能访问到（同一局域网 / 公网）；
- 用户填一个内网地址就能让**主机**替他探测内网（SSRF）。

`client` 模式把这条连接整个搬到浏览器：谁出图、就用谁自己的网络去连自己的 ComfyUI，
主机只负责不碰地址的那部分（参数替换、落库、记账、绑消息）。

## client 模式的分工

```
浏览器                                   主机（Silver Tavern）
  │ POST /api/comfy/workflows/:id/preview  ← 服务端替换 {{char}}/{{scene}}…，返回最终 prompt
  │ POST {comfy.baseUrl}/prompt            → 你自己的 ComfyUI
  │ WS   {comfy.baseUrl}/ws?clientId=…     → 进度
  │ GET  {comfy.baseUrl}/history/{id}      → 收尾
  │ GET  {comfy.baseUrl}/view?…            → 图片字节
  │ POST /api/assets                       ← 上传进**自己租户**的素材库
  │ POST /api/chats/:id/messages/:mid/attachments  ← assetId 合并进 extra.images
  │ POST/PUT /api/comfy/client-runs[/:id]  ← 登记与回写，队列 / 历史 / 花费照旧可见
```

- **参数替换在服务端**：`POST /api/comfy/workflows/:id/preview` 返回替换好占位符的最终 prompt；
  浏览器拿它去 `POST {baseUrl}/prompt`。
- **事件解释不分叉**：队列 / WebSocket / history 的解释放在 `web/core/comfy-events.mjs`，
  服务端 runner 与浏览器直连 import 的是同一份（`core/toolbox/comfy.mjs` 反向再导出）。
- **入库 / 绑消息 / 落记录**留在服务端：浏览器把图上传到自己的素材库，再把 assetId 绑到消息上。

## 半自动 / 全自动触发 = 待办任务

`marker`（回复里出现 `[IMG: …]`）和 `auto`（场景变化）触发的出图，在 client 模式下
**不会立刻提交**，而是落一条 `status: 'pending-client'` 的记录（复用 `comfy_runs` 表），
里面带着服务端算好的最终 prompt：

- 前端打开着页面时，后台泵（`web/app.js` 启动的 `startComfyClientPump`）每十几秒领一次待办执行；
- 打开某个对话 / 演出层时也会立刻把当前的待办跑掉；
- **没有前端在线就一直挂着**，下次打开再跑。

界面上会显示成「待浏览器出图…」。要取消就点「取消这条待办」（只改本地状态，主机不会去发 `/interrupt`）。

## 跨域：client 模式需要 ComfyUI 允许 CORS

浏览器直连走的是普通 `fetch` + `WebSocket`：

- WebSocket 不受同源策略限制，直接连即可；
- `POST /prompt` 是 `application/json`，会先发一个 `OPTIONS` 预检，**需要 ComfyUI 返回 CORS 头**。

ComfyUI 默认**不**返回 CORS 头（对着 master 的 `server.py` 核过：只有加 `--enable-cors-header`
才会挂上 `create_cors_middleware`）。所以请这样启动 ComfyUI：

```powershell
python main.py --enable-cors-header "*"
# 或者只放行你这个酒馆的地址：
python main.py --enable-cors-header "http://127.0.0.1:8788"
```

没开跨域时，浏览器里会看到「浏览器连不上 …：可能是没开跨域」，点「测试连接」就能看到原因。

另外，如果酒馆是**公网 HTTPS**、而 ComfyUI 在 `127.0.0.1`，浏览器会按混合内容 / 私有网络策略
挡掉请求。client 模式适合「酒馆在局域网 / 本机、ComfyUI 也在本机」这种自用或朋友各自开一个的场景。

## 什么时候还是用 server 模式

- 单机自用，ComfyUI 就在同一台机器 / 局域网，图省事。
- 想统一由主机排队出图（比如一台强显卡机器专门跑 ComfyUI，大家一起用）。
  **注意：多用户模式下 `server` 模式只有管理员能用** —— 成员把这个设置改回去会被 403 挡住，
  他们在运行时也被强制成 `client`（`server/tenants.mjs` 的 `forceClientComfy`）。
  所以"大家一起用那台强显卡机器"要走 client 模式：让那台 ComfyUI 对**每个人的浏览器**可达
  （局域网 / 公网 + `--enable-cors-header`），主机不替他们连。

这时请注意：**界面上填的地址是由服务器访问的** —— 多用户模式下等于「主机要能连到它」，
别填只想让某个人访问的内网地址。

## 接口一览

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/api/comfy/config` | 设置 + `executionModes`（两种方式的说明） |
| `GET` | `/api/comfy/status` | `server` 探活；`client` 时 `ok: null` + `client: true`（不探活） |
| `POST` | `/api/comfy/test` | 同上：`client` 时直接回「在浏览器里测」，主机不发请求 |
| `POST` | `/api/comfy/client-runs` | 浏览器拿到 promptId 后登记；带 `runId` 表示领走一条待办 |
| `PUT` | `/api/comfy/client-runs/:id` | 回写 `status` / `progress` / `images` / `error` |
| `GET` | `/api/comfy/runs?status=pending-client` | 拉待办清单 |
| `POST` | `/api/chats/:chatId/messages/:messageId/attachments` | `{ assetIds: [] }` 合并进消息的 `extra.images` |

## 测试

- `tests/run.mjs`：地址推导（`ws://`/`wss://`）、终态判断、client 模式下主机零请求、
  触发落成待办、`registerClientRun` / `updateClientRun` 回写。
- `tests/api-test.mjs`：`client-runs` 接口、attachments 绑定（含去重）、
  多用户租户默认 `client` 且不向用户地址发请求、成员把执行模式改回 `server` 会被 403
  （`/api/comfy/config` 与 `/api/settings` 两条路都挡）。
- `work/ui-smoke.mjs`：对假 ComfyUI 真跑一遍浏览器的「提交 → WS → 取图 → 上传 → 绑消息」。

本机浏览器权限被策略挡着，所以没有真人点检；上面那条冒烟用的是 Node 自带的
`fetch` / `WebSocket`（与浏览器同一套实现），能覆盖全流程。
