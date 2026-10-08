@echo off
cd /d "%~dp0"
title 网易云 . 喜欢歌单重合度对比

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [错误] 没有找到 Node.js，这个程序需要它才能运行。
  echo   下载安装：https://nodejs.org/   装完重新双击本文件即可。
  echo.
  pause
  exit /b 1
)

echo.
echo   网易云 . 喜欢歌单重合度对比
echo   --------------------------------
echo   正在启动本地服务，浏览器会自动打开...
echo   页面用完之后，直接关掉这个黑窗口就停止服务了。
echo.

start "" http://127.0.0.1:8787
node "%~dp0server.mjs" 8787

echo.
echo   服务已停止，可以关掉这个窗口了。
pause
