#!/data/data/com.termux/files/usr/bin/bash
# Silver Tavern · Termux 一键安装
#
# 做的事：装 Node.js（如果没有）→ 检查版本和 node:sqlite → 建数据目录 →
# 把 `tavern` 这个启动命令装到 PATH 里。跑一次就够，以后直接敲 tavern 启动。
#
# 用法：  bash 安装.sh
# 可选：  SILVER_TAVERN_DATA=~/我的数据 bash 安装.sh

set -e

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="${SILVER_TAVERN_DATA:-$HOME/silver-tavern-data}"
PREFIX_DIR="${PREFIX:-/usr}"
BIN_DIR="$PREFIX_DIR/bin"
CONFIG_DIR="$HOME/.config/silver-tavern"

echo "== Silver Tavern · Termux 安装 =="

# ---------------------------------------------------------------- 1. 找源码
SRC=""
for candidate in "$SELF_DIR/../源代码" "$SELF_DIR/../source" "$SELF_DIR/.."; do
  if [ -f "$candidate/server/index.mjs" ]; then
    SRC="$(cd "$candidate" && pwd)"
    break
  fi
done

if [ -z "$SRC" ]; then
  echo "找不到源码：应该在「移动端-Termux」的同级目录里有一个「源代码」文件夹。" >&2
  echo "把整个压缩包解压之后再来跑这个脚本就行。" >&2
  exit 1
fi
echo "源码：$SRC"

# ---------------------------------------------------------------- 2. 装 Node
if ! command -v node >/dev/null 2>&1; then
  echo "== 没装 Node.js，正在装（可能要一两分钟）=="
  pkg update -y || true
  pkg install -y nodejs
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 装不上。试着先执行 pkg update && pkg upgrade，再跑一次这个脚本。" >&2
  exit 1
fi

NODE_VERSION="$(node -v 2>/dev/null || echo unknown)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
echo "Node.js：$NODE_VERSION"

if [ "$NODE_MAJOR" -lt 24 ] 2>/dev/null; then
  echo "⚠ 这个项目要 Node 24 或更高（数据库用的是 Node 自带的 node:sqlite）。" >&2
  echo "  Termux 里试试：pkg install nodejs   （不要用 nodejs-lts，版本可能偏低）" >&2
fi

if ! node -e "new (require('node:sqlite').DatabaseSync)(':memory:')" >/dev/null 2>&1; then
  echo "⚠ 这个 Node 里没有 node:sqlite，服务起不来。" >&2
  echo "  换个 Node 版本（pkg install nodejs），或者从别处装一个完整的 Node。" >&2
  exit 1
fi
echo "node:sqlite：可用 ✓"

# ---------------------------------------------------------------- 3. 数据目录
mkdir -p "$DATA_DIR"
echo "数据目录：$DATA_DIR"

# ---------------------------------------------------------------- 4. 记下配置
mkdir -p "$CONFIG_DIR"
cat > "$CONFIG_DIR/config.sh" <<EOF
# 由 安装.sh 生成；换位置就改这里，或者重新跑一遍安装。
SILVER_TAVERN_SRC="$SRC"
SILVER_TAVERN_DATA="$DATA_DIR"
EOF

# ---------------------------------------------------------------- 5. 装 tavern 命令
cat > "$BIN_DIR/tavern" <<'LAUNCHER'
#!/data/data/com.termux/files/usr/bin/bash
# Silver Tavern 启动器（由 安装.sh 装好）
set -e
. "$HOME/.config/silver-tavern/config.sh"

HOST="${TAVERN_HOST:-127.0.0.1}"
PORT="${TAVERN_PORT:-8788}"

if [ ! -f "$SILVER_TAVERN_SRC/server/index.mjs" ]; then
  echo "源码不见了：$SILVER_TAVERN_SRC" >&2
  echo "重新跑一次 安装.sh 就行。" >&2
  exit 1
fi

echo "Silver Tavern 启动中…"
echo "  地址：http://$HOST:$PORT"
echo "  数据：$SILVER_TAVERN_DATA"
echo "  关掉：Ctrl+C（或者从 Termux 通知栏结束）"
echo

TAVERN_HOST="$HOST" TAVERN_PORT="$PORT" \
  exec node "$SILVER_TAVERN_SRC/server/index.mjs" --data-dir "$SILVER_TAVERN_DATA"
LAUNCHER
chmod +x "$BIN_DIR/tavern"

echo
echo "装好了。以后这样启动："
echo
echo "    tavern                # 本机用（手机浏览器打开 http://127.0.0.1:8788）"
echo "    TAVERN_HOST=0.0.0.0 tavern   # 让同一个 WiFi 下的电脑也能连"
echo
echo "第一次启动后：手机浏览器打开 http://127.0.0.1:8788 ，"
echo "先去「模型接入」填你自己的模型（API Key / 本地地址）。"
echo
echo "小提示：手机容易杀后台，跑之前可以在 Termux 里执行一次 termux-wake-lock。"
echo "        数据在 $DATA_DIR —— 换手机就把它拷走（连 master.key 一起）。"
