#!/data/data/com.termux/files/usr/bin/bash
# Silver Tavern · 直接启动（不装也行，装了 tavern 命令的话用那个更省事）
#
# 用法：
#   bash 启动.sh              # 只在手机本机能开
#   bash 启动.sh --lan        # 同一个 WiFi 下的电脑也能连（会打印手机 IP）
#
# 想改端口：TAVERN_PORT=8899 bash 启动.sh

set -e

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"

# 装了的话就用安装时记下的路径，没装就按压缩包里的相对位置找
if [ -f "$HOME/.config/silver-tavern/config.sh" ]; then
  . "$HOME/.config/silver-tavern/config.sh"
fi

SRC="${SILVER_TAVERN_SRC:-}"
if [ -z "$SRC" ] || [ ! -f "$SRC/server/index.mjs" ]; then
  for candidate in "$SELF_DIR/../源代码" "$SELF_DIR/../source"; do
    if [ -f "$candidate/server/index.mjs" ]; then
      SRC="$(cd "$candidate" && pwd)"
      break
    fi
  done
fi

if [ -z "$SRC" ] || [ ! -f "$SRC/server/index.mjs" ]; then
  echo "找不到源码：应该在「移动端-Termux」同级有个「源代码」文件夹。" >&2
  echo "（把整个压缩包解压之后再跑这个脚本）" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "还没装 Node.js。先跑一次：bash 安装.sh" >&2
  exit 1
fi

DATA_DIR="${SILVER_TAVERN_DATA:-$HOME/silver-tavern-data}"
mkdir -p "$DATA_DIR"

HOST="127.0.0.1"
if [ "$1" = "--lan" ]; then
  HOST="0.0.0.0"
fi
PORT="${TAVERN_PORT:-8788}"

echo "Silver Tavern 启动中…"
echo "  地址：http://127.0.0.1:$PORT"
echo "  数据：$DATA_DIR"

if [ "$HOST" = "0.0.0.0" ]; then
  echo
  echo "局域网地址（同一个 WiFi 的电脑 / 手机用这个）："
  if command -v ifconfig >/dev/null 2>&1; then
    ifconfig 2>/dev/null | grep -E "inet " | grep -v "127.0.0.1" | awk '{ print "  http://" $2 ":'"$PORT"'" }' || true
  elif command -v ip >/dev/null 2>&1; then
    ip -4 addr show 2>/dev/null | grep -oE "inet [0-9.]+" | awk '{ print "  http://" $2 ":'"$PORT"'" }' || true
  fi
  echo "  （找不到就自己去手机的 WiFi 设置里看 IP）"
fi

echo
echo "  关掉：Ctrl+C"
echo

# 顺手用浏览器打开（如果 Termux 装了 termux-tools 的话）
if [ "${SILVER_TAVERN_NO_OPEN:-}" != "1" ] && command -v termux-open-url >/dev/null 2>&1; then
  ( sleep 3; termux-open-url "http://127.0.0.1:$PORT" >/dev/null 2>&1 || true ) &
fi

TAVERN_HOST="$HOST" TAVERN_PORT="$PORT" \
  exec node "$SRC/server/index.mjs" --data-dir "$DATA_DIR"
