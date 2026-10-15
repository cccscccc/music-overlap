/*
 * 便携版启动器的文本（单一来源）。
 *
 * 为什么要单独一个文件：启动器（.bat / .sh / .command）的正文只在
 * _dev/build-portable.mjs 里生成，源码目录下就没有对应的文件——用户 clone 下来
 * 想用「手机访问」这条功能时，脚本里找不到入口。所以这里把正文抽出来，
 * 两个地方共用同一份：
 *   · _dev/build-portable.mjs        → 打进便携包
 *   · _dev/make-launchers.mjs        → 落到源码根目录（GitHub 上的用户直接用）
 *
 * 编码注意：.bat 必须 GBK(cp936) + CRLF（中文 Windows 控制台默认 936 代码页，
 * 存 UTF-8 会显示成乱码）；.sh / .command 必须纯 LF。落盘由调用方负责。
 */

/**
 * 「手机访问」的 Windows 启动器。
 *
 * 它比普通启动器多三件事：
 *   1) 先把上次留下的 .started.url 删掉，免得读到过期地址
 *   2) 用 --lan --print-port 起服务（服务会把可用地址写进 .started.url）
 *   3) 轮询那个文件，读到地址就把大号提示打出来
 *
 * @param {string} exeRel  node 可执行文件的相对路径（便携版是 "bin\\node.exe"）
 * @param {boolean} portable 便携版要检查自带运行时是否存在
 */
export function phoneBat(exeRel, portable) {
  const guard = portable
    ? `if not exist "%~dp0bin\\node.exe" (
  echo.
  echo   [出错] 没找到自带的运行环境 bin\\node.exe
  echo   多半是解压不完整，或者被杀毒软件删掉 / 隔离了。
  echo.
  pause
  exit /b 1
)
`
    : '';
  return `@echo off
rem 手机访问启动器（由 _dev/launchers.mjs 生成，别直接改这个文件）
setlocal enabledelayedexpansion
cd /d "%~dp0"
title 音乐重合度 · 手机访问

${guard}set "PORT=%~1"
if "%PORT%"=="" set "PORT=8787"

rem 上一次留下的地址文件必须先删掉，否则会读到过期的地址
del /q "%~dp0.started.url" 2>nul
del /q "%~dp0.started.json" 2>nul

rem ---------------------------------------------------------------
rem 先问一句：这个端口上是不是已经有本工具在跑了？
rem 用户最常见的用法就是「上次那个窗口没关，又双击了一次」。按老流程走的话，
rem 第二台会在报「端口被占用」之后才把地址打出来，而启动器早就等超时了——
rem 用户白等 10 秒，还看不到地址。所以这里先用探针把它变成几毫秒的事。
rem ---------------------------------------------------------------
set "PHONE="
rem 探针既打印 JSON（退出码 0/1），也把「手机该输的地址」再写一份纯文本到 .started.url。
rem 这里只认那个文件——bat 里解析 JSON 得跟引号和延迟展开打架，读一行纯文本最稳。
"${exeRel}" "%~dp0server.mjs" --probe-port %PORT% >nul 2>nul
if exist "%~dp0.started.url" set /p PHONE=<"%~dp0.started.url"

if defined PHONE (
  echo   ==================================================
  echo    这个工具已经在运行了，不用再开一个：
  echo.
  echo        手机浏览器打开：  !PHONE!
  echo        这台电脑打开：    http://127.0.0.1:%PORT%/
  echo.
  echo    （要重开的话，先把上次那个窗口关掉）
  echo   ==================================================
  echo.
  echo   这个窗口可以关掉了。
  pause
  exit /b 0
)

echo.
echo   音乐重合度 · 手机访问模式
echo   --------------------------------------------------
echo   同一个 WiFi 下的手机、平板都能打开这个页面。
echo   电脑别关也别注销：手机上取歌单、放歌，干活的一直是这台电脑。
echo.
echo   正在启动，稍等几秒会显示出手机该输入的网址...
echo.

rem 服务会把地址写进 .started.url；这里最多等 10 秒（20 次 x 0.5 秒）
set "PHONE="
for /l %%i in (1,1,20) do (
  if not defined PHONE (
    if exist "%~dp0.started.url" set /p PHONE=<"%~dp0.started.url"
    if not defined PHONE ping -n 1 -w 500 127.0.0.1 >nul
  )
)

echo   ==================================================
if defined PHONE (
  echo    手机浏览器打开这个网址：
  echo.
  echo        !PHONE!
) else (
  echo    [!] 没能自动读出地址，请看下面服务自己打印的那一行
  echo        「手机（同一个 WiFi）打开：」
)
echo   ==================================================
echo.

${exeRel} "%~dp0server.mjs" %PORT% --lan --print-port

rem 退出码 1 表示端口被占用（server.mjs 自己会打印原因），交回给外层换端口
if errorlevel 1 exit /b 2

echo.
echo   服务已停止，可以关掉这个窗口了。
pause
`;
}

/**
 * 「手机访问」的 macOS / Linux 启动器。和 phoneBat 同样的三步，
 * 只是 shell 里一行都不难写：服务自己会打印地址，这里再抓一次做重点提示。
 *
 * @param {boolean} portable 便携版要提示「自带的是 Windows 版 node」
 */
export function phoneSh(portable = true) {
  const note = portable
    ? `
  # 便携包里带的是 Windows 版的 node.exe，在 macOS / Linux 上跑不了
  if [ ! -x "$DIR/bin/node" ] && ! command -v node >/dev/null 2>&1; then
    echo "  [出错] 没找到能用的 node。"
    echo "         这个包是 Windows 版打包的，自带的 bin/node.exe 在这里跑不了；"
    echo "         装一个再试：https://nodejs.org/"
    exit 1
  fi
  if [ ! -x "$DIR/bin/node" ]; then
    echo "  提示：这个包是 Windows 版打包的，自带的 bin/node.exe 在这里跑不了。"
    echo "        正在改用系统里的 node。"
  fi
`
    : '';
  return `#!/bin/sh
# 手机访问启动器（由 _dev/make-launchers.mjs 生成，别直接改这个文件）
#
# 用途：让同一个 WiFi 下的手机 / 平板也能打开这个工具。
# 用法：./手机访问.sh  [端口]      默认 8787
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PORT="\${1:-8787}"
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
  PHONE=$(printf '%s' "$EXISTING" | sed -n 's/.*"lan":\\["http:\\/\\/\\([^"]*\\)".*/\\1/p')
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
`;
}
