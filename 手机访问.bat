@echo off
rem 手机访问启动器（由 _dev/launchers.mjs 生成，别直接改这个文件）
setlocal enabledelayedexpansion
cd /d "%~dp0"
title 音乐重合度 · 手机访问

set "PORT=%~1"
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
"node" "%~dp0server.mjs" --probe-port %PORT% >nul 2>nul
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

node "%~dp0server.mjs" %PORT% --lan --print-port

rem 退出码 1 表示端口被占用（server.mjs 自己会打印原因），交回给外层换端口
if errorlevel 1 exit /b 2

echo.
echo   服务已停止，可以关掉这个窗口了。
pause
