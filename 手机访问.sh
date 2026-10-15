#!/bin/sh
# 手机访问启动器（由 _dev/make-launchers.mjs 生成，别直接改这个文件）
#
# 用途：让同一个 WiFi 下的手机 / 平板也能打开这个工具。
# 用法：./手机访问.sh  [端口]      默认 8787
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PORT="${1:-8787}"
URL_FILE="$DIR/.started.url"
LOG="$DIR/.started.log"

cd "$DIR"
rm -f "$URL_FILE" "$DIR/.started.json"

echo
echo "  音乐重合度 · 手机访问模式"
echo "  --------------------------------------------------"
echo "  同一个 WiFi 下的手机、平板都能打开这个页面。"
echo "  这台电脑别关：手机上取歌单、放歌，干活的一直是它。"
# 优先用包里自带的运行时，没有就退回系统里的 node
if [ -x "$DIR/bin/node" ]; then
  NODE_BIN="$DIR/bin/node"
else
  NODE_BIN=$(command -v node || true)
fi
if [ -z "$NODE_BIN" ]; then
  echo "  [出错] 没找到 node，先装一个：https://nodejs.org/"
  exit 1
fi

# ---------------------------------------------------------------
# 先问一句：这个端口上是不是已经有本工具在跑了？
# 用户最常见的用法就是「上次那个窗口没关，又开了一次」。按老流程走的话，
# 第二个会因为端口被占用而退出，用户还得自己从报错里找地址。这里几毫秒就问完。
# ---------------------------------------------------------------
EXISTING=$("$NODE_BIN" "$DIR/server.mjs" --probe-port "$PORT" 2>/dev/null || true)
if [ -n "$EXISTING" ]; then
  PHONE=$(printf '%s' "$EXISTING" | sed -n 's/.*"lan":\["http:\/\/\([^"]*\)".*/\1/p')
  echo "  =================================================="
  echo "    这个工具已经在运行了，不用再开一个："
  echo
  if [ -n "$PHONE" ]; then
    echo "        手机浏览器打开：  http://$PHONE/"
  fi
  echo "        这台电脑打开：    http://127.0.0.1:$PORT/"
  echo
  echo "    （要重开的话，先把上次那个窗口关掉）"
  echo "  =================================================="
  exit 0
fi

echo "  正在启动，稍等几秒会显示出手机该输入的网址..."
echo

"$NODE_BIN" "$DIR/server.mjs" "$PORT" --lan --print-port > "$LOG" 2>&1 &
SRV=$!

# 等 .started.url 出现（最多 10 秒）
i=0
while [ $i -lt 40 ]; do
  if [ -s "$URL_FILE" ]; then break; fi
  if ! kill -0 "$SRV" 2>/dev/null; then break; fi
  sleep 0.25
  i=$((i + 1))
done

echo "  =================================================="
if [ -s "$URL_FILE" ]; then
  echo "    手机浏览器打开这个网址："
  echo
  echo "        $(cat "$URL_FILE")"
else
  echo "    [!] 没能自动读出地址，下面是服务自己的输出："
  sed -n '1,40p' "$LOG" 2>/dev/null || true
fi
echo "  =================================================="
echo

wait "$SRV"
rm -f "$URL_FILE" "$LOG"
echo
echo "  服务已停止。"
