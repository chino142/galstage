# 安卓 / Termux（手机版）

项目零第三方依赖、前端无构建，所以手机上也能直接跑源码。分发包里那个
`移动端-Termux/` 文件夹就是给手机用的：两个脚本 + 一份说明。

## 前提

- **Termux 要从 F-Droid 或 GitHub Releases 装**，应用商店里那个已经停止维护。
- **Node.js ≥ 24**，而且要带 `node:sqlite`（数据库用的就是它）。
  装完先验一句：

  ```bash
  node -e "new (require('node:sqlite').DatabaseSync)(':memory:')"
  ```

  Termux 里用 `pkg install nodejs`（当前版）。`nodejs-lts` 版本可能偏低，
  不够就换包重装。

## 安装

```bash
cd ~/silver-tavern/移动端-Termux
bash 安装.sh
```

脚本做四件事：缺 Node 就 `pkg install nodejs` → 检查版本与 `node:sqlite` →
建数据目录（默认 `~/silver-tavern-data`）→ 把 `tavern` 启动命令装进 `$PREFIX/bin`，
并把源码路径与数据目录记在 `~/.config/silver-tavern/config.sh`。

## 启动

```bash
tavern                      # 只听 127.0.0.1，手机本机浏览器用
TAVERN_HOST=0.0.0.0 tavern  # 同一个 WiFi 下的电脑也能连（同一份数据）
TAVERN_PORT=8899 tavern     # 换端口
```

不装 `tavern` 命令也能跑：`bash 启动.sh`，加 `--lan` 等于上面那条 `0.0.0.0`。
`启动.sh` 还会在 3 秒后用 `termux-open-url` 把浏览器拉起来
（不要就设 `SILVER_TAVERN_NO_OPEN=1`）。

## 手机上的注意事项

- **数据目录不要放 `/sdcard`**：权限、性能都差，放 Termux 家目录（默认已经是）。
- **后台容易被杀**：跑之前执行一次 `termux-wake-lock`。Android 的省电策略
  对长驻进程不友好，这是系统层面的，不是程序问题。
- **本地大模型跑不动**：手机上接远程 API，或者接同一 WiFi 下另一台机器上的
  Ollama / ComfyUI（填那台机器的局域网地址）。
- **手机和电脑是两份数据**：要互搬走「工具箱 → 备份与维护」的全量备份
  （`.stbk` 加密备份也行），或者直接拷整个数据目录（`master.key` 必须一起）。

## 换绑路径 / 重装

重新跑一次 `安装.sh` 会覆盖 `~/.config/silver-tavern/config.sh`；
想换数据目录：

```bash
SILVER_TAVERN_DATA=~/我的数据 bash 安装.sh
```

## 验证过什么、没验证过什么

- 验过：源码在 Node 24 上零依赖可跑（`node server/index.mjs`）；
  分发包里的源码解压出来能起服务、能出界面（见 `work/tmp/pkg-build/verify-source-zip.mjs`）。
- 没验过：**没有在真机 Termux 上跑过** —— 这台机器上没有 Android 环境。
  脚本的语法和路径逻辑用 bash 检查过、也用模拟的 HOME/PREFIX 跑过一遍安装流程，
  但真机上的 Node 版本、`pkg` 行为、后台策略还是可能不一样。
  第一次在手机上装的时候，以 Termux 窗口里的输出为准。
