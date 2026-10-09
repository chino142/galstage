# 多用户模式（给几个朋友用）

一个网址 + 登录；**每个人一个完整的数据目录**，互相看不见，换设备用同一个账号登录就能接着玩。

## 隔离模型（先说清楚）

```
<主机目录>/                       ← TAVERN_DATA_DIR
  accounts.json                  ← 账号表（只有口令哈希，没有聊天内容）
  plugins/                       ← 插件是主机级的（代码，不是数据）
  tenants/
    alice/   tavern.db  assets/  cards/  backups/  master.key
    bob/     tavern.db  assets/  cards/  backups/  master.key
```

- 一个账号 = 一套 SQLite + 素材 + 角色卡 + 备份 + **自己的 API Key 主密钥**。
  没有"同一张表按用户 id 过滤"这回事，所以不存在漏一个 `WHERE` 就串号的漏洞。
- 账号名统一小写（Windows 文件系统大小写不敏感，`Alice` 和 `alice` 会落到同一个目录）。
- 主机进程（也就是你）在**文件系统层面**能看到这些目录 —— 想连这一点都防住，就用下面的
  「加密导出」把数据带走，或者改用"一人一实例"的部署方式（见 README）。

> **先说在明面上**：账号口令只提供"用户之间的基本隐私"，**它不是安全功能**。
> 租户目录里的 `tavern.db` 是明文 SQLite（只有提供方密钥那一层是加密的），
> 任何能碰到这台机器硬盘的人都能直接看、直接改。所以**别跟不信任的人一起用**，
> 也**不要在公开服务器上开**。（SillyTavern 的多用户文档里是同一句警告。）

## 怎么开

```powershell
# 方式一：环境变量
$env:TAVERN_MULTI_USER='1'
$env:TAVERN_DATA_DIR='D:\tavern-host'     # 主机目录；租户会自动建在 tenants\ 下
node server/index.mjs                     # 或者 npm run start:multi

# 方式二：命令行参数
node server/index.mjs --multi-user --data-dir D:\tavern-host
```

第一次打开首页会让你**建第一个账号**（就是管理员）。也可以用命令行建：

```powershell
node server/index.mjs --multi-user --data-dir D:\tavern-host --add-user alice
# 会打印一个随机口令；也可以自己指定：--add-user alice --password 你的口令
node server/index.mjs --multi-user --data-dir D:\tavern-host --list-users
node server/index.mjs --multi-user --data-dir D:\tavern-host --set-password alice
```

## 加朋友 / 管账号

用管理员账号登录 → 右上角 `🛡️ 你的名字` → **主机管理**：

- 加账号（给初始口令）、停用 / 启用、重置口令、删除账号。
- 删除时可以选择"只删账号"或"连数据一起删"（第二个确认框）。
- 服务总览：在线会话数、哪些租户已载入、磁盘占用、插件。
- 管理员**看不到**任何人的对话、角色卡、素材 —— 那些只在各自的租户目录里。

自己改口令：右上角 `👤 你的名字` → 改口令（要输当前口令）。

## 换设备怎么接着玩

朋友用同一个网址 + 账号登录即可：数据在这台机器上他名下的目录里，浏览器只是个窗口。
手机/平板同浏览器访问也行（放在局域网 / Tailscale 里最省事，公网请照下面配 HTTPS）。

## 加密导出：数据真正在他自己手里

「工具箱 → 备份与维护 → **加密备份（带走你的全部数据）**」：

- 导出一个 `.stbk` 文件：整个数据目录（对话 / 卡 / 世界书 / 素材 / 设置）打成包，
  再用**他自己给的口令**加密（AES-256-GCM + scrypt）。
- 口令不落盘，所以**主机管理员也解不开**；换了机器、换了服务器，导入回来就能接着玩。
- 导入会覆盖当前数据（导入前照例自动留一份现在的备份）。
- 同一页还能从加密备份**恢复**：选文件 + 口令。

## MCP（可选）

一人一份，各自指向自己的租户目录：

```powershell
node server/mcp-stdio.mjs --data-dir D:\tavern-host --user alice
```

## 部署到公网时

- **别用端口转发把服务直接暴露到公网。** 要远程访问就用 VPN 或隧道
  （Tailscale 最省事，也可以 Cloudflare Zero Trust / ngrok）。
  裸奔公网出的事，SillyTavern 那份文档的原话是：*"WE ARE NOT RESPONSIBLE FOR ANY
  DAMAGE OR LOSSES IN CASES OF UNAUTHORIZED ACCESS DUE TO IMPROPER OR INADEQUATE
  SECURITY IMPLEMENTATION."* —— 我们这边态度一样：**安全没做好被入侵，责任在部署的人。**
- **一定配 HTTPS**（Caddy / nginx），并把 `TAVERN_COOKIE_SECURE=1` 打开（或让反代带
  `x-forwarded-proto: https`，程序会自动加 `Secure`）。
- 反代后面要拿到真实客户端 IP 时才设 `TAVERN_TRUST_PROXY=1`（登录限速按 IP 算；
  不设的话所有人共享反代 IP，10 次失败会把大家一起挡十分钟）。
- 会话只放内存：**重启服务 = 所有人重新登录**（不会留下长期有效的票据）。
- 登录失败按 IP 限速（10 次 / 10 分钟）。

## 一些取舍（说在明面上）

- 每个租户在第一次访问后**常驻**（含它自己的定时任务、ComfyUI 连接）。几个人 × 几十 MB，
  换来的是"没人访问时定时备份照样跑"。管理员可以在总览里手动卸载某个租户。
- 插件是主机级的（`<主机目录>/plugins`）：所有租户共用同一份插件代码。插件接口在各自
  会话里执行，读到的仍然是当前租户的数据。
- 租户的 ComfyUI 配置各存各的，而且**默认是「浏览器直连」**：出图由朋友自己的浏览器连他
  自己的 ComfyUI，主机不向那个地址发任何请求（这也顺手消掉了"用户可控地址 → 主机内网探测"
  的 SSRF 面）。要改成"主机统一出图"就去「工具箱 → ComfyUI」把连接方式切回「服务器执行」，
  那时主机才会去连这个地址；细节见 `docs/COMFY-DIRECT.md`。

## 验证（这轮已经跑过）

下面七条是照着手动脚本 `work/verify-multiuser.mjs` 跑的（`node work/verify-multiuser.mjs`，
**37 条断言全过**）。它用 `fetch` + 手动 cookie 打接口，不依赖浏览器：

1. `--multi-user` 起服务 → 首页出现"建管理员账号" → 建完自动进入。
2. 退出登录 → 登录页 → 用错口令应报"账号或口令不对"，连错 10 次应提示限速。
3. 管理员建 `alice` / `bob`，各开一个隐身窗口登录，各自建对话：互相看不到对方的对话列表。
4. `tenants/<名字>/tavern.db` 各一份；删掉 alice 的账号（不 purge）→ 她的目录还在。
5. 工具箱 → 备份与维护 → 加密导出 `.stbk` → 在另一个账号里导入（会用对方的库覆盖）。
6. 停用 alice → 她的页面应跳回登录页；启用后能再登录。
7. 单机模式（不带 `--multi-user`）行为不变：不出现登录页、不出现主机管理。

自动化那边：`tests/api-test.mjs` 里有 7 条多用户端到端用例（首次建号 / 两账号隔离 /
`/api/host/*` 权限 / 停用后会话失效 / 加密导出再导入 / 删账号确认与 purge / 登录限速与
伪造 `x-forwarded-for`），全量 66 条接口用例全过。

> **浏览器点检没做**：本机浏览器权限被策略挡着，`127.0.0.1` 打不开（也不许绕路）。
> 兜底是 `work/ui-smoke.mjs`（33 个视图都挂得上）+ 上面这些接口用例；登录页与主机管理
> 这两屏是纯 DOM、逻辑很薄，但**没有真人点过**。

## 已知边界

完整清单（含认证参数、限速、路径、注入面）见 `docs/SECURITY.md`，多用户相关的几条：

1. 主机进程（也就是你）在**文件系统层面**能看到所有租户目录 —— 想连这一点都防住，
   只能用加密导出把数据带走，或者一人一实例。
2. 会话与限速都在内存：**重启 = 全员重新登录、限速清零**。
3. 限速只按 IP；反代后面不开 `TAVERN_TRUST_PROXY=1` 时所有人共享一个 IP。
4. 管理员手动"卸载租户"（或重置口令 / 停用账号触发的卸载）会关掉那个租户的数据库，
   如果它正好有一个流式请求在跑，那个请求会报错收场。
5. `import-encrypted` 走 base64 body，上限 256 MB（约 190 MB 的 `.stbk`）。
6. 插件是主机级、进程内的**可信代码**：装一个插件等于让这段代码以服务身份运行。
7. **成员不能"让主机替他做事"**：本地代理托管（providers 的 `launcher`）、本地 MCP 服务器
   （会在主机上 spawn 进程）、`comfy.executionMode = 'server'`（让主机去连他填的地址）
   这三样在多用户模式下都只有管理员能用，成员调用会拿到 403；成员的 ComfyUI 一律走浏览器直连。
8. **成员填的模型接口地址仍然是主机去连的**：这是"自带端点"的固有性质（你填 OpenAI / 本地
   Ollama 的地址，服务端替你去请求）。要收紧就只能给 baseUrl 做白名单 —— 这一版没做。
