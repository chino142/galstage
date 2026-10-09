# 安全说明与审计

这份文档写清楚 Silver Tavern 的**信任边界**、已经做了什么、哪些是**有意不做的取舍**，
以及这一轮多用户模式做完之后**查出来并修掉**的问题。它同时是"下次改到安全相关代码时
该看一眼什么"的清单。

## 0. 边界先说清楚

```
主机进程（你自己）  ← 完全可信：能读所有租户目录、能加载插件代码
  └─ 一个账号 = 一个租户目录 <主机目录>/tenants/<账号>/
       ↑ 从这里往下的东西（对话、卡、素材、设置、API Key）才是"朋友的"
```

- **主机进程本身是可信的**。想连主机管理员都读不到朋友的对话内容，就用「加密导出」
  把数据带走（口令不落盘），或者一人起一个进程 / 一人一台机器。
- **同一个进程里的其它租户是半可信的**：他们只能用浏览器访问自己那一份数据，
  但"打进这个进程"的代码（插件）是所有租户共用的。
- 单机模式（不带 `--multi-user`）没有账号、没有会话、没有 `/api/auth`，
  安全模型就是"谁能访问这个端口谁就是主人"。公网部署必须放在反代 + HTTPS 后面。

## 1. 认证与会话

| 项 | 做法 | 位置 |
|---|---|---|
| 口令哈希 | scrypt，`N=16384 / r=8 / p=1 / keylen=64`，16 字节随机盐；存成 `scrypt$N$r$p$salt$hash`（base64url） | `core/accounts.mjs` |
| 口令要求 | 8~200 位；账号名统一小写 | `core/accounts.mjs` |
| 比对 | `timingSafeEqual`；**账号不存在时也跑一次同参数的哈希**（`DUMMY_HASH`），避免用响应时间探"这个名字在不在" | `server/accounts.mjs` |
| 会话令牌 | `randomBytes(32).toString('base64url')` = 256 bit 熵 | `core/accounts.mjs` |
| 会话存储 | **只放内存**（`Map`），重启服务 = 全员重新登录，磁盘上不留票据 | `server/accounts.mjs` |
| 会话 TTL | 30 天滑动（每次请求更新 `lastSeen`，每 60 秒惰性清理过期项） | `server/accounts.mjs` |
| Cookie | 名字 `st_session`；`HttpOnly` + `SameSite=Lax` + `Path=/`；`Secure` 在 `TAVERN_COOKIE_SECURE=1` 或反代带 `x-forwarded-proto: https` 时自动加 | `core/accounts.mjs` |
| 登录限速 | **同一 IP 10 次失败 / 10 分钟**，第 11 次起 `429`；成功登录清零 | `server/accounts.mjs` |
| 客户端 IP | 默认用 `socket.remoteAddress`；**只有** `TAVERN_TRUST_PROXY=1` 时才信 `x-forwarded-for` 的第一段 | `server/host.mjs` |
| 首次建号 | 只在账号数为 0 时允许（`POST /api/auth/setup`，否则 `409`），第一个账号自动是管理员 | `server/host.mjs` |
| 会话失效 | 退出登录销毁当前令牌；**停用账号 / 重置口令会销毁该账号的全部会话**；自己改口令后把当前令牌重新登记（不然改完自己被踢下线） | `server/host.mjs` |
| CSRF | 改数据的接口都要求 JSON body；`SameSite=Lax` 挡掉跨站表单提交；服务端**不设任何 CORS 头**，跨源 `fetch` 写接口过不了预检 | 全局 |
| 未登录访问 | `/api/auth/*` 之外的所有 `/api/*` 一律 `401`；`/api/host/*` 非管理员 `403`（未登录是 `401`，不泄露"这个接口存在且要管理员"） | `server/host.mjs` |

**为什么登录限速只按 IP**：够挡在线暴力破解，又不用引第三方中间件。反代后面所有请求
共享一个 IP 时，要么开 `TAVERN_TRUST_PROXY=1` 拿真实 IP，要么接受"十次失败大家一起等
十分钟"的代价（`docs/MULTI-USER.md` 里也写了）。

## 2. 隔离（跨账号越权）

- **一个账号 = 一个完整数据目录**，不做"同一张表按 owner_id 过滤"。漏一个 `WHERE`
  就串号的那种洞在这个结构里不存在。
- 每次请求按会话挑出租户，把 `req/res` 交给**那个租户自己的** `createApp().handleRequest`；
  各 api 模块是注册时闭包捕获 engine / 存储的，所以租户之间不共享任何句柄。
- 账号名映射到目录名之前一律 `normaliseUsername()`：转小写、正则
  `^[a-z0-9][a-z0-9_-]{1,31}$`、并且挡掉 Windows 保留名（`con` / `nul` / `com1`…）
  与 `tenants` / `plugins` / `backups` / `assets` / `cards`。**不含 `.`、`/`、`\`**，
  所以 `..`、大小写碰撞、保留名都不成立。
- `x-forwarded-for` 只在开了 `TAVERN_TRUST_PROXY` 时才信（见上表）。
- **"让主机替你做事"的两条路也都按角色收了口**：本地代理托管（会在主机上执行命令）与
  `comfy.executionMode = 'server'`（会让主机去连你填的地址）在多用户模式下**只有管理员**能用，
  成员只会得到 403，而且成员的租户在运行时就没有这两样东西（不是靠界面藏起来）。
- **本地 MCP 服务器（客户端方向）同理**：它会在主机上 `spawn` 一个进程，所以
   配置 / 修改 / 连接 / 调用都只有管理员能做（成员 403）。
- 测试覆盖：`tests/api-test.mjs` 的「两个账号互相看不到对方的对话」「/api/host/* 只有
  管理员能用」「成员不能靠本地代理托管在主机上执行命令」「成员不能让主机替他连 ComfyUI」，
  以及 `work/verify-multiuser.mjs` 的 37 条手动清单。

## 3. 路径与文件

| 面 | 做法 |
|---|---|
| 静态文件 | `path.posix.normalize` → 去掉前导 `../` 与 `/` → `path.join(root, relative)` → 再用 `startsWith(root)` 兜一道 |
| 插件静态文件 | 路由 `GET /api/plugins/:name/:file`：名字必须是 `^[a-zA-Z0-9][a-zA-Z0-9_-]*$`，文件名必须是 `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` 且**不含 `..`**；只允许单层文件名 |
| 备份文件 | 按名字找备份时先把名字洗成 `[A-Za-z0-9._-]`；备份文件名由服务端 `stamp()` 生成（时间戳 + 随机后缀），不接受客户端给的路径 |
| 导入的备份（`.stbk`） | 只从 zip 里读 `manifest.json` 认身份，**不会**拿 zip 里的文件名当路径；原样收进备份目录时用服务端生成的 id |
| 从备份恢复 | 解 zip 后按 `assets/` `cards/` 前缀镜像写回。条目名先过校验（拒绝绝对路径、盘符、含 `..` 段），写之前再用 `safeResolve()` 确认落点在自己的目录里，越界的跳过并计数 |
| 素材库 | 落盘文件名是 `ast_xxx` + 过滤过的扩展名（只留 `[A-Za-z0-9.]` 且 ≤ 6 字符），原始文件名只当元数据 |
| 路径参数解码 | 宿主自己解 `%` 转义时会兜住 `URIError`（畸形转义回 404，不是 500）；租户路由器按段解码，不会二次解码 |

## 4. 破坏性操作

- **删账号**：必须先发一次不带 `confirm` 的请求拿到 `needConfirm`，第二次带 `confirm: true`
  才真删；界面上是两次确认框。删自己直接被拒（`400`）。
- **连数据一起删（purge）**：先把目标目录 `path.resolve` 一遍，确认它确实在 `hostRoot`
  之下才 `rmSync`；账号名本身也过校验，所以"用畸形账号名把 rm 指到别处"这条路走不通。
- **管理员兜底**：不能把最后一个管理员停用 / 降级（`adminCount() <= 1` 时拒绝）。
- **恢复备份**：一律先自动做一份 `kind='pre-restore'` 的备份；表结构不一致直接拒绝，
  不做"半搬一半"。
- **加密导出**：导出口令至少 8 位；文件是 `STBK1 + 16B 盐 + 12B iv + 16B tag + 密文`
  （AES-256-GCM，密钥由 scrypt 派生）。口令不落盘，所以主机管理员也解不开。

## 5. 注入面

### 5.1 插件（本地代码）

插件是 `<数据目录>/plugins/<名字>/` 下的**本地代码**，由主进程 `import` 并执行
`register(api)`。也就是说：**放一个插件进来，等于让这段代码以服务进程的身份运行**
（能读文件、能发网络请求、能读所有租户的数据）。

这是有意保留的能力（和 SillyTavern 的插件、以及"装一个扩展"是同一类信任），边界是：

- 只有能写数据目录的人（主机管理员）才放得进插件；
- 多用户模式下插件是**主机级**的，所有租户共用同一份代码，接口在各自会话里执行，
  读到的仍是当前租户的数据 —— 但**插件代码本身可以绕过这一点**（它就是进程内的代码）；
- 坏插件只进 `errors` 列表，不影响主服务启动。

结论：**别装来路不明的插件**。要隔离插件，得把它挪到单独进程 / 容器里，这一版没做。

### 5.2 卡内前端沙箱

角色卡自带的 HTML / CSS / JS 跑在 `<iframe sandbox="allow-scripts">` 里
（**没有** `allow-same-origin`），文档内写死一张 CSP：
`default-src 'none'` / `script-src 'unsafe-inline'` / `style-src 'unsafe-inline'` /
`img-src data: blob:` / `connect-src 'none'` / `media-src data: blob:` /
`frame-src 'none'` / `base-uri 'none'` / `form-action 'none'`。
它能做的事只有一件事：通过 `postMessage` 桥调用**声明过**的能力
（读写对话变量 / 角色变量、读消息、发消息、回合事件）。

静态校验（`validateCardFrontend`）会拦下这些写法：

- 联网：`fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource`
- 存储与 cookie：`localStorage` / `sessionStorage` / `indexedDB` / `document.cookie`
- 碰宿主页面：`parent|top|opener . document|location|localStorage`
- 动态执行：`eval` / `new Function` / `importScripts` / 动态 `import()` / `require()`
- 进程：`process.env|exit|versions`
- 页面结构：**HTML 里一律不许出现 `<script>`**（脚本只能放 JS 段；`<script src>` 也被同一条规则
  覆盖，CSP 另外再挡一层）、内嵌 `<iframe|object|embed|frame>`、`javascript:` URL、CSS `@import`
- **内联事件处理器**：`onclick="…"` / `onerror="…"` 这类是 **error**（以前只是提示）——
  属性里的代码同样绕过 js.* 规则
- **脚本块逃逸**：JS 里出现 `</script>`、CSS 里出现 `</style>`（否则能提前收尾、把后面当 HTML 插出去）；
  另有一条**不依赖 lint 的结构性兜底**：注入 srcdoc 之前把 `</script` / `</style` 改写成
  `<\/script` / `<\/style`（见 `escapeRawText`），放宽或跳过 lint 时它仍然生效
- **导航**：`location.href = …` / `location.assign|replace(…)` / `window.open(…)` /
  `window["location"]` —— 导航不受 `connect-src` 约束，是能绕过"禁止联网"把数据带出去的口子
- `meta http-equiv=refresh`（同样是导航）

桥的放行在**两个地方**都做：卡内那一份存根拒绝未声明的调用；宿主侧
（`web/ui/card-sandbox.mjs`）收到消息时再查一遍 `event.source` 是不是自己那个
iframe、以及这个方法对应的能力有没有被授予。**只信卡内存根是不够的** —— 卡可以绕过
自己的存根直接 `postMessage` 过来。写卡区的预览与对话页的「卡内界面」共用这一份实现。

### 5.3 卡内界面的信任模型（"我自己的卡不限制、别人的卡要限制"）

代码**存在卡数据里**（`data.extensions['silver-tavern'].frontend`），所以导出 PNG / JSON 时
界面跟着卡走 —— 别人拿到卡就有了这段代码。跑不跑由服务端按**卡的来源**决定
（`core/frontend/policy.mjs`），前端说了不算：

| | `own`（自己的卡） | `strict`（别人的卡） |
|---|---|---|
| 判定依据 | `characters.source === 'original'`（本机新建 / 编辑） | 其余（导入的） |
| 静态检查 | 跳过（只当提示） | 全开，拦下就不渲染 |
| 能力 | 声明过的全放开 | 只放行声明过的、且要宿主侧复核 |
| 打开对话 | 自动跑 | **默认不跑**，点「运行」才跑 |
| 可升级？ | —— | 可以「信任这张卡」 |

几条刻意的设计：

- **信任绑代码哈希**（信任表 `card_frontend_trust`，v10）。你信任的是"当时那段代码"，
  不是卡名；代码一改（更新卡、重新导入、手改 JSON）哈希对不上，就退回"要你点一下"。
- **信任记录不在卡数据里**。放进卡数据会跟着导出走，等于让卡自己声明"请信任我"。
- **信任只影响"跑"，不影响"改"**：别人的卡上存一段新的、过不了静态检查的代码，照样 400。
  想随便改就另存成自己的卡。
- **跳过静态检查 ≠ 关掉沙箱**：CSP、`sandbox="allow-scripts"`、宿主侧的能力校验一条不少，
  静态检查只是"来路不明时提前拦一道"。
- 沙箱 iframe 是 opaque origin，父页面拿不到 `contentDocument`，所以内容只能走 srcdoc
  字符串路径 —— 注入前对 css / js 做 raw text 转义（`escapeRawText`）就是为此。

## 6. 已知边界（写明白，不打算在这一版修）

1. **主机进程能读所有租户目录**。这是"一人一个目录、主机来托管"的必然结果；
   要防住得靠加密导出或一人一实例。
2. **会话与限速都在内存**：重启服务 = 全员重新登录、限速计数清零。
3. **限速只按 IP**：同一 NAT / 反代后面的人共享额度；不开 `TAVERN_TRUST_PROXY` 时
   反代后面的所有人共享一个 IP。
4. **首次建号有微小竞态**：两个请求同时到达、都看到"账号数为 0"，可能建出两个管理员。
   自用场景不值得为此加锁；真要防就先命令行 `--add-user`。
5. **`unload` 租户会关掉它的数据库**：如果那个租户正好有一个长请求（SSE 流式输出）
   在跑，会以错误收场。管理员手动卸载、或重置口令 / 停用账号时会触发。
6. **`import-encrypted` 的 body 上限 256 MB**（base64 后），约等于 190 MB 的 `.stbk`。
   再大就得分块或改用直接传文件体的写法（现在没做）。
7. **插件是可信代码**（见 5.1）。**本地代理托管**（providers 的 `launcher`）同理 ——
   它以服务进程的身份执行配置里的命令；多用户模式下已经收成"只有管理员能用"（见 7.8）。
8. **卡内前端的能力声明是"确认"而不是"强隔离"**：沙箱能挡住越界的写法，但沙箱里
   的脚本本来就是这张卡的作者写的；一个已经声明了 `chat.send` 的卡"发什么内容"由它自己定。
   自己的卡（`own`）连静态检查都跳过 —— 那是你写的代码，风险由你判断；
   别人的卡默认不跑、要你点一下（信任模型见 5.3）。
   另外"禁止联网"是**尽力而为**：`connect-src 'none'` 挡住 fetch / XHR / WebSocket / 外部
   图片，静态扫描挡住常见的导航写法，但 JS 里能导航的花样（`computed` 属性名、
   `<a>` 的 `click()`、运行时拼字符串）不可能穷举 —— 一个已经拿到数据的卡理论上仍能
   把数据塞进 URL 导航走。要真正封死，得让卡内前端跑在**独立 origin** 并由服务端代理
   产物（这一版没做，因为要引入第二个端口 / 域名）。
9. **没有 HTTPS / 没有 HSTS**：公网必须自己套 Caddy / nginx，并开
   `TAVERN_COOKIE_SECURE=1`（或让反代带 `x-forwarded-proto`）。
10. **管理员能改朋友的账号与磁盘**（停用、重置口令、删数据）。这是"主机管理员"这个角色的定义。
11. **口令强度只校验长度**（≥ 8）。没做弱口令字典，也没做"必须含大小写数字"这类规则。
12. **会话 Cookie 没有做绑定**（比如绑 UA / IP）；拿到令牌就能用，直到过期或被销毁。
13. **登录失败不落日志审计**（只在内存计数）。要审计得自己接日志。
14. **"等于主机权限"的东西不止插件**：管理员账号本身就是主机主人（能管账号、能配本地代理
    托管）；给朋友开账号时，别把管理员权限一起给出去。
14. **ComfyUI 的 `server` 模式仍然由主机去请求用户填的地址**。这是"统一由主机排队出图"的
    代价，不是漏洞而是功能：多用户模式下等于"主机要能连到它"。想消掉这条就用 `client`
    模式（默认，见下条）。界面上对 `server` 模式标了「这个地址由服务器访问」。

## 7. 这一轮查出来并修掉的问题

1. **备份恢复可以往数据目录外面写文件**（`server/db/backup.mjs`）。
   恢复时按 `assets/` `cards/` 前缀把 zip 里的条目写回磁盘，用的是
   `path.join(target, relative)`；一个被人为改过的备份（比如含 `assets/../../evil.js`）
   就能写出数据目录。多用户模式下"朋友"能用 `import-encrypted` 把自己造的包喂进来，
   等于从租户越权到主机文件系统。**修法**：`adoptZip` 直接拒绝含 `..` / 绝对路径 /
   盘符的条目；恢复时再用 `safeResolve()` 兜一道，越界的跳过并计入 `files.skipped`。
   回归测试：`tests/run.mjs` 的「备份里的越界条目不能把文件写到数据目录外面」。
2. **卡内前端的桥只挡卡内那一侧**（`web/views/card-frontend.mjs`）。
   宿主原先不看 `event.source`、也不查能力声明，卡内脚本绕过自己的存根
   `parent.postMessage({source:'tavern-card', method:'chat.send'})` 就能直接让宿主执行。
   **修法**：宿主侧校验 `event.source === iframe.contentWindow`，并按服务端返回的
   已授予能力清单核对方法所需能力。
3. **沙箱静态规则漏了"脚本块逃逸 / 导航 / meta refresh"**（`core/frontend/service.mjs`）。
   加上 `js.scriptBreak` / `css.styleBreak` / `js.navigation` / `html.metaRefresh`
   四条规则，回归测试在 `tests/run.mjs`。
4. **MCP `--user` 没校验账号名**（`server/mcp-stdio.mjs`）。
   `--user ..` 会让 MCP 指向 `tenants/..`（也就是主机目录本身），读到别人的数据。
   **修法**：过一遍 `normaliseUsername()`，不合法直接报错退出。
5. **畸形 `%` 转义把宿主打成 500**（`server/host.mjs`）。
   `/api/host/users/%` 里 `decodeURIComponent` 抛 `URIError`，被兜底成 500。
   **修法**：`decodeParam()` 兜住异常，解不开就原样返回，让上层正常 404。
6. **HTML 里的 `<script>` 能整段绕过 JS 静态扫描**（`core/frontend/service.mjs`）。
   实测：`validateCardFrontend({ html: '<script>fetch("https://evil")</script>' })` 原本
   **ok = true、0 错误** —— 因为 js.* 规则只扫 `js` 字段，而 `<script>` 里的代码照样执行；
   `onerror=` / `onload=` 这类内联属性也只算提示。**修法**：HTML 里禁止 `<script>`
   （`html.scriptTag`）、内联事件处理器升为 error（`html.inlineHandler`），并且注入 srcdoc
   前对 css / js 做 raw text 转义（`escapeRawText`，不依赖 lint）。回归测试在 `tests/run.mjs`。
7. **素材库能把任意字节当 `text/html` 发回同一个源**（`server/api/platform.mjs`）。
   实测：上传一个 `mime: 'text/html'` 的素材，再打开 `/api/assets/<id>/file`，响应头就是
   `Content-Type: text/html` —— 浏览器把它当文档执行，脚本跑在应用同源里，能带着会话读写
   该账号的一切（stored XSS）。**修法**：只放行图片 / 音频 / 视频这些"媒体"类型原样内联
   （其余降级成 `application/octet-stream` + `Content-Disposition: attachment`），并且一律
   加 `X-Content-Type-Options: nosniff` 与 `Content-Security-Policy: default-src 'none'; sandbox`。
   回归测试：「素材：不允许用 text/html 的 mime 在应用同源里执行脚本」。
8. **多用户模式下任何成员都能让主机执行任意命令**（`server/api/platform.mjs` + `server/providers/launcher.mjs`）。
   实测：用成员账号 `POST /api/providers` 配一条 `launcher:{command,args}`，再
   `POST /api/providers/:id/start`，命令就以**服务进程的身份**跑起来了（写文件成功）。
   这直接把租户隔离作废 —— 能读别人的 `tavern.db` / `master.key`。**修法**：多用户模式下
   `launcher` 只有管理员能配 / 能启动（接口层 403），并且**非管理员账号的租户干脆不建
   launcher**（`server/tenants.mjs` 按角色传 `withLauncher`，模型网关的自动 `ensure` 也一并失效）。
   回归测试：「多用户：成员不能靠"本地代理托管"在主机上执行命令」。
   补充（2026-10 复核时堵上的绕行）：光挡"写配置的接口"不够 —— 成员还能导一份自己改过的加密
   备份，把 `providers.launcher` / `mcp_servers.command` 随数据一起搬进自己的库，等这个数据目录
   被以启用 launcher 的方式打开（README 推荐的 `--mcp --user <账号>`、或单机模式指过来）时命令
   照样会跑。所以恢复那一步也按同样的口径收口：`createBackupStore` 拿运行时的 `withLauncher` 当
   开关（`server/runtime.mjs`），没有 launcher 的租户在恢复时把这两类"可执行配置"剥掉
   （`server/db/backup.mjs` 的 `allowExecutableConfig`）；单机 / 管理员照旧完整恢复。
   回归测试：「备份恢复：没有 launcher 的租户不能把可执行配置恢复回来」。
9. **成员可以把 ComfyUI 改回"主机代连"，让主机去请求任意地址**（`server/runtime.mjs` 等）。
   实现里已经把多用户模式的默认改成「浏览器直连」，但 `comfy.executionMode` 是个可写设置，
   成员能改回 `server`，再把自己填的 `baseUrl` 指向内网 —— 主机进程替他去连，还能从
   `/system_stats` 读回版本 / 设备信息（SSRF + 信息泄露）。**修法**：多用户模式下成员的租户
   在运行时被强制成 `client`（`forceClientComfy`），两条写设置的路（`PUT /api/comfy/config`、
   `PUT /api/settings`）也各自把"改回 server"挡成 403；管理员照旧。回归测试：
   「多用户：成员不能让主机替他连 ComfyUI（SSRF）」。
10. **同理，成员能靠本地 MCP 服务器在主机上启动进程**（`server/api/mcp.mjs`）。
    MCP 客户端方向是 `spawn(command, args)`，命令来自 `POST /api/mcp/servers` 写进库的配置。
    实测：成员加一条 `command: node, args: ['-e', '…写文件…']` 再 `connect`，文件就写出来了。
    **修法**：多用户模式下"配置 / 修改 / 连接 / 调用本地 MCP 服务器"全部收成管理员专用
    （成员 403）；单机模式不变。回归测试：「多用户：成员不能加本地 MCP 服务器」。

> 这三条（7 / 8 / 9 / 10 里除了素材 XSS）本质是同一件事：**"让主机替你执行 / 出网"的入口
> 在多用户模式下必须按角色收口**。以后再往项目里加"能跑本地命令或按用户给的地址发请求"的
> 功能时，记得顺手加同一道闸（`server/api/_helpers.mjs` 的 `deniesHostActions`）。

6. **ComfyUI 地址是用户可控的，服务端会去请求它 → 内网探测（SSRF）**。
   `comfy.baseUrl` 由用户填，`server/toolbox/runner.mjs` 会发 `/prompt`、连 WebSocket、
   拉 `/queue` `/history` `/view`；多用户模式下"朋友"填一个内网地址，就等于让**主机**
   替他扫内网。**修法（第 0 块"别人的连接不经过我"）**：
   - 新增 `comfy.executionMode`：`server`（主机执行）| `client`（浏览器直连，主机不碰这个地址）；
   - **多用户模式默认 `client`**（`server/runtime.mjs` 在租户第一次装配时写默认值），
     界面可切换，说明文字写清"这个地址由谁访问"；
   - `client` 模式下服务端把 `/prompt`、`/queue`、`/history`、`/view`、`/interrupt`、
     `/ws` 全部收口：`runner.tick()` / `connectWs()` / `submit()` / `resume()` 直接短路，
     `/api/comfy/test` 与 `/api/comfy/status` 也不再探活，只回"由浏览器测"；
   - 半自动 / 全自动触发在 `client` 模式下落成 `pending-client` 待办，由前端来领，
     主机不提交；
   - 参数替换仍在服务端做（复用 `/preview`），所以这条改动没有把功能拆成两套。
   回归测试：`tests/run.mjs` 的「浏览器直连（client 模式）—— 主机不出请求」（断言
   假 runner 一次都没被调用）、`tests/api-test.mjs` 的「浏览器直连 …」与
   「多用户：租户默认浏览器直连，主机不向用户的 ComfyUI 地址发请求」
   （把地址填成 `10.255.255.1` 并断言 `status.ok === null`）。
   细节见 `docs/COMFY-DIRECT.md`。

## 8. 改动安全相关代码时顺手确认这几条

- 新增"用客户端给的字符串拼路径"的地方：是不是过了白名单 / `safeResolve`？
- 新增接口：是不是落在 `/api/*` 下（多用户会自动要求登录）？要不要管理员？
- 新增破坏性操作：界面两次确认 + 服务端 `confirm` 标志？
- 新增写进 iframe / innerHTML 的内容：沙箱规则要不要补一条？
- 新增会话 / 令牌：熵够不够？过期时间？停用 / 改口令时会不会被销毁？
