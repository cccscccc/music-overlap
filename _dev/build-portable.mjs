/**
 * 打便携包：把程序 + 便携版 Node 运行时打成一个解压就能双击的文件夹，并压成 zip。
 *
 * 用法：
 *   node _dev/build-portable.mjs              打完整包（含 node.exe，约 35MB zip）
 *   node _dev/build-portable.mjs --no-runtime 只打程序（给已经装了 Node 的人）
 *   node _dev/build-portable.mjs --no-zip     只铺文件夹，不压 zip
 *
 * 产物落在 dist/ 下。dist/ 不进 git（便携包是构建产物，不该进版本库）。
 *
 * 为什么是「文件夹 + 便携版 node.exe」而不是单文件 exe：
 *   - 单文件要用 Node 的 SEA 把代码和前端打进 exe，还得处理 Windows 清单（否则可能弹 UAC），
 *     一改代码就得重新构建，朋友那边也没法自己看/改。
 *   - 现在这样：零构建依赖、改完直接生效、出问题能直接看是哪个文件。
 */

import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip } from './zipwrite.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');
const APP_DIR_NAME = '音乐重合度-便携版';
const OUT = path.join(DIST, APP_DIR_NAME);
const PORT_DEFAULT = 8787;

/**
 * 版本号只有一个来源：server.mjs 里的 `version`。
 * release.mjs 也是这么读的，两处不会各写各的。
 */
function readVersion() {
  const src = readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  const m = src.match(/version:\s*['"]([^'"]+)['"]/);
  if (!m) throw new Error('在 server.mjs 里找不到 version');
  return m[1];
}
const VERSION = readVersion();

const argv = process.argv.slice(2);
const WITH_RUNTIME = !argv.includes('--no-runtime');
const WITH_ZIP = !argv.includes('--no-zip');

/** 放进包里的东西（顺序无关）。不含 _dev / dist / .git。 */
const FILES = ['server.mjs', 'README.md', '使用说明.md', 'LICENSE'];
const DIRS = ['platforms', 'public'];

const log = (...a) => console.log(...a);
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 1) 启动器：GBK(cp936) + CRLF                                        */
/*    和既有的 启动.bat 保持一致——中文 Windows 控制台默认是 936 代码页， */
/*    存成 UTF-8 会在控制台里显示成乱码。                                */
/* ------------------------------------------------------------------ */

const launcherBat = () => `@echo off
rem 便携版启动器（由 _dev/build-portable.mjs 生成，别直接改这个文件）
setlocal
cd /d "%~dp0"
title 音乐重合度 · 歌单对比

call "%~dp0启动-核心.bat" %*
if errorlevel 2 (
  echo.
  echo   换个端口再试一次...
  echo.
  timeout /t 2 >nul
  call "%~dp0启动-核心.bat" 8788
)
`;

/** 真正干活的启动器；端口冲突时以退出码 2 交回给外层换端口 */
const coreBat = (exeRel, portable) => {
  const guard = portable
    ? `if not exist "%~dp0bin\\node.exe" (
  echo.
  echo   [出错] 没找到自带的运行环境 bin\\node.exe
  echo   多半是解压不完整，或者被杀毒软件删掉 / 隔离了。
  echo   重新解压一次；还不行就看「先看我.txt」。
  echo.
  pause
  exit /b 1
)
`
    : '';
  return `@echo off
rem 便携版启动器内核（由 _dev/build-portable.mjs 生成，别直接改这个文件）
setlocal
cd /d "%~dp0"
title 音乐重合度 · 歌单对比

${guard}set "PORT=%~1"
if "%PORT%"=="" set "PORT=8787"

echo.
echo   音乐重合度 · 网易云 / QQ 音乐 / 酷狗
echo   --------------------------------------------------
echo   正在启动本地服务，浏览器马上会自动打开...
echo.
echo   用完之后，直接关掉这个黑窗口就停止服务了。
echo

start "" /b cmd /c "timeout /t 2 >nul & start "" http://127.0.0.1:%PORT%"
${exeRel} "%~dp0server.mjs" %PORT%

rem 退出码 1 表示端口被占用（server.mjs 自己会打印原因），交回给外层换端口
if errorlevel 1 exit /b 2

echo.
echo   服务已停止，可以关掉这个窗口了。
pause
`;
};

const launcherAltBat = `@echo off
rem 当 8787 被占用时用这个，会换一个端口启动。
cd /d "%~dp0"
call "%~dp0启动-核心.bat" 8788
if errorlevel 1 pause
`;

/* ------------------------------------------------------------------ */
/* 1b) macOS / Linux 启动器                                             */
/*     .sh / .command 必须是 LF 换行（CRLF 会让 shebang 失效，           */
/*     报 "$'\r': command not found" 这种让人摸不着头脑的错），          */
/*     并且要在 zip 里带可执行位（0755）——Windows 上没法验证这一点，     */
/*     但可以验证「zip 里确实写的是 0755」（见 _dev/zip-check.mjs）。    */
/* ------------------------------------------------------------------ */

/**
 * 交给 sh 干活的启动器。
 *
 * 为什么不像 Windows 那样无条件用自带的运行时：
 * 便携包里塞的 `bin/node.exe` 是 **Windows 程序**，在 macOS / Linux 上压根跑不起来，
 * 硬要执行只会得到一句 "cannot execute binary file"，用户完全不知道该怎么办。
 * 所以这里的优先级是：
 *   1) `bin/node`（不带 .exe）——只有人在这台 Mac/Linux 上重新打过包才会有，
 *      那种情况下它才是真的能用的自带运行时；
 *   2) 系统里的 node（`node -v` 拿得到版本号才算数）——Mac/Linux 上基本人人都有；
 *   3) 都没有 → 给一句人话告诉他去 nodejs.org 装一个。
 * 顺便说清「自带的是 Windows 版」这件事，免得用户以为包坏了。
 */
const shLauncher = () => {
  return `#!/bin/sh
# 音乐重合度 · 本地歌单对比（macOS / Linux 启动器）
# 由 _dev/build-portable.mjs 生成，别直接改这个文件。
#
# 用法：双击本文件（macOS 上是 .command）或者  ./启动.sh  [端口]

DIR=$(cd "$(dirname "$0")" && pwd) || exit 1
cd "$DIR" || exit 1
export LANG="\${LANG:-zh_CN.UTF-8}"

echo
echo "  音乐重合度 · 网易云 / QQ 音乐 / 酷狗"
echo "  --------------------------------------------------"

# 找一个能用的 node：先看包里的 Unix 版，再退回系统里装的
EXE=""
if [ -x "$DIR/bin/node" ]; then
  EXE="$DIR/bin/node"
else
  command -v node >/dev/null 2>&1 && EXE="node"
fi

# 包里带的是 Windows 版 node.exe 时，先说清这件事：
# 免得用户去双击 bin/node.exe，或者以为「自带运行时没生效」是包坏了。
if [ ! "$EXE" = "$DIR/bin/node" ] && [ -f "$DIR/bin/node.exe" ]; then
  echo "  提示：这个包是 Windows 版打包的，自带的 bin/node.exe 在这里跑不了，"
  echo "        所以下面用的是你自己系统里装的 Node.js。"
  echo
fi

if [ -z "$EXE" ]; then
  echo "  [还差一步] 你系统里没有 Node.js，而包里自带的那个是 Windows 版，这里用不了。"
  echo "  这不是包坏了——Windows 和 Mac/Linux 的可执行文件本来就不能通用。"
  echo
  echo "  装一个 Node.js 18 以上版本就能用了（装完再双击本文件）："
  echo "    macOS ：去 https://nodejs.org 下载 .pkg 安装包，双击装完再运行本文件"
  echo "            或者用 Homebrew：brew install node"
  echo "    Linux ：用系统包管理器，比如 sudo apt install nodejs"
  echo
  exit 1
fi

PORT="\${1:-$PORT_DEFAULT}"

echo "  正在启动本地服务，浏览器马上会自动打开..."
echo
echo "  用完之后，在这个终端窗口按 Ctrl+C 就停止服务了。"
echo

LOG="\${TMPDIR:-/tmp}/music-overlap-\$\$.log"
"$EXE" "$DIR/server.mjs" "$PORT" --print-port > "$LOG" 2>&1 &
SRV=$!

# Ctrl+C / 关窗口时，把服务一起带走，别留下占着端口的孤儿进程
cleanup() {
  kill "$SRV" 2>/dev/null
  rm -f "$LOG"
  exit 0
}
trap cleanup INT TERM HUP

# 等服务就绪：从启动日志里那行 JSON 读出真实地址（最多等 20 秒）
URL=""
i=0
while [ "$i" -lt 100 ]; do
  kill -0 "$SRV" 2>/dev/null || break
  URL=$(sed -n 's/.*"url":"\\([^"]*\\)".*/\\1/p' "$LOG" 2>/dev/null | head -n 1)
  [ -n "$URL" ] && break
  i=$((i + 1))
  sleep 0.2
done

if [ -z "$URL" ]; then
  echo
  echo "  [出错] 服务没能启动，下面是它的输出："
  echo "  --------------------------------------------------"
  cat "$LOG" 2>/dev/null
  echo "  --------------------------------------------------"
  rm -f "$LOG"
  exit 1
fi

echo "  已经跑起来了： $URL"
echo

if command -v open >/dev/null 2>&1; then
  open "$URL" >/dev/null 2>&1
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1
else
  echo "  （没能自动打开浏览器，请手动访问上面那个地址）"
fi

wait "$SRV"
rm -f "$LOG"
echo
echo "  服务已停止。"
`;
};

/* ------------------------------------------------------------------ */
/* 2) 给朋友看的说明                                                     */
/* ------------------------------------------------------------------ */

const readmeTxt = `先看我（30 秒看完）
================================================

怎么用
------
  双击  「启动.bat」

  会弹出一个黑色小窗口，然后浏览器自己打开。
  别关那个黑窗口——它就是程序本体，关了服务就停了。
  用完之后，把黑窗口关掉就完事了。

  （如果双击的是「打开音乐重合度」那个带图标的快捷方式，效果一样。）

需要装什么吗
------------
  什么都不用装。运行环境已经打包在里面了（bin\\node.exe）。
  这也是为什么压缩包有点大——它自带了一整套运行环境。

能做什么
--------
  把一个歌单链接贴到左边，另一个贴到右边，点「开始对比」。
  支持网易云音乐 / QQ 音乐 / 酷狗，两边可以是不同的平台。

  没链接？点「填入示例」先看个效果。

  网易云：歌单页地址，或者「我喜欢的音乐」分享出来的链接
  QQ 音乐：y.qq.com 的歌单页地址
  酷狗：www.kugou.com 的歌单页地址（只能读到前 30 首，也听不了，见下）

几个提前说清楚的事
------------------
  · 歌单必须是「公开」的，私密歌单读不到，会明确告诉你读不到。
  · 酷狗的歌单页只公开前 30 首，而且拿不到播放地址，
    所以酷狗只能比、不能听——界面里会如实标出来，不会假装能播。
  · 有些歌是 VIP / 付费 / 无版权，默认放不出来。
    想听这些，把浏览器里的登录凭证填进页面下方「进阶」区就行（只保存在你自己电脑的内存里）。

打不开 / 报错怎么办
-------------------
  1. 先看那个黑窗口里写了什么，报错信息都在那儿。
  2. 杀毒软件可能把 bin\\node.exe 当可疑文件删了 —— 看 bin 文件夹里还有没有 node.exe。
     没有的话，让它别拦，或者重新解压一次。
  3. 双击没反应：右键「启动.bat」→「以管理员身份运行」试试。
  4. 想换端口：双击「换个端口启动.bat」。

详细说明看 「使用说明.md」（用记事本或 VS Code 都能打开）。
`;

/* ------------------------------------------------------------------ */
/* 3) 铺文件                                                            */
/* ------------------------------------------------------------------ */

async function main() {
  log('清理 dist/ ...');
  await rm(DIST, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  log(`拷程序文件 → ${path.relative(ROOT, OUT)}`);
  for (const f of FILES) {
    await cp(path.join(ROOT, f), path.join(OUT, f));
  }
  for (const d of DIRS) {
    await cp(path.join(ROOT, d), path.join(OUT, d), { recursive: true });
  }
  // 版本说明也带上，朋友想知道改了啥可以翻
  for (const f of await readdir(ROOT)) {
    if (/^RELEASE-.*\.md$/.test(f)) await cp(path.join(ROOT, f), path.join(OUT, f));
  }

  // 启动器（GBK + CRLF）
  let exeRel = null;
  if (WITH_RUNTIME) {
    log('拷便携版 Node 运行时 ...');
    await mkdir(path.join(OUT, 'bin'), { recursive: true });
    const nodeExe = findNodeExe();
    await cp(nodeExe, path.join(OUT, 'bin', 'node.exe'));
    exeRel = 'bin\\node.exe';
    log(`  用的是 ${nodeExe}（${mb((await stat(nodeExe)).size)}）`);
  } else {
    exeRel = 'node';
    log('（--no-runtime）不带运行环境，启动器改用系统里的 node');
  }

  const writeGbk = async (file, text) => {
    // Node 内置没有 GBK 编码器，交给 PowerShell 按 cp936 落盘
    const tmp = path.join(DIST, `.gbk-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    await writeFile(tmp, text, 'utf8');
    // 用 UTF-8 读入、按 936 写出，顺带把换行统一成 CRLF
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `$t=[IO.File]::ReadAllText('${tmp.replace(/'/g, "''")}',[Text.Encoding]::UTF8);` +
          `$t=$t -replace "\`r?\`n","\`r\`n";` +
          `[IO.File]::WriteAllText('${file.replace(/'/g, "''")}', $t, [Text.Encoding]::GetEncoding(936))`,
      ],
      { stdio: 'pipe' }
    );
    await rm(tmp, { force: true });
  };

  log('写启动器 ...');
  const nodeCmd = WITH_RUNTIME ? '"%~dp0bin\\node.exe"' : 'node';
  await writeGbk(path.join(OUT, '启动.bat'), launcherBat());
  await writeGbk(path.join(OUT, '启动-核心.bat'), coreBat(nodeCmd, WITH_RUNTIME));
  await writeGbk(path.join(OUT, '换个端口启动.bat'), launcherAltBat);
  await writeGbk(path.join(OUT, '先看我.txt'), readmeTxt);

  /*
   * macOS / Linux 的启动器。
   * 关键：**必须 LF 换行**。shebang 后面跟一个 CR 会让内核找不到解释器，
   * 报 `env: sh\r: No such file or directory` 或者 `$'\r': command not found`——
   * 这种错最难倒查，所以在生成阶段就统一成 LF。
   */
  log('  写 macOS / Linux 启动器（LF 换行）...');
  const shText = shLauncher();
  const writeLf = (file, text) => writeFile(file, text.replace(/\r\n?/g, '\n'), 'utf8');
  await writeLf(path.join(OUT, '启动.sh'), shText);
  // macOS 上双击 .command 才会在终端里跑；.sh 双击默认是用编辑器打开的
  await writeLf(path.join(OUT, '启动.command'), `#!/bin/sh
# macOS 双击入口：交给同目录的 启动.sh 干活。
DIR=$(cd "$(dirname "$0")" && pwd) || exit 1
exec "$DIR/启动.sh" "$@"
`);

  // 快捷方式：让朋友看到的是一个带名字的入口，而不是一堆文件
  log('创建快捷方式 ...');
  try {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `$w=New-Object -ComObject WScript.Shell;` +
          `$s=$w.CreateShortcut('${path.join(OUT, '打开音乐重合度.lnk').replace(/'/g, "''")}');` +
          `$s.TargetPath='cmd.exe';` +
          `$s.Arguments='/c "启动.bat"';` +
          `$s.WorkingDirectory='${OUT.replace(/'/g, "''")}';` +
          `$s.Description='歌单重合度对比（本地运行）';` +
          `$s.Save()`,
      ],
      { stdio: 'pipe' }
    );
  } catch (e) {
    log(`  快捷方式没建成（不影响使用）：${e.message.split('\n')[0]}`);
  }

  // 统计
  const files = await walk(OUT);
  const total = (await Promise.all(files.map(async (f) => (await stat(f)).size))).reduce((a, b) => a + b, 0);
  log(`\n包内容：${files.length} 个文件，共 ${mb(total)}`);

  if (WITH_ZIP) {
    const zip = path.join(DIST, `${APP_DIR_NAME}.zip`);
    log(`\n压 zip → ${path.relative(ROOT, zip)}`);
    await rm(zip, { force: true });
    /*
     * 自己写 zip，不用 Compress-Archive。
     * 原因：PowerShell 5.1 的 Compress-Archive（以及 .NET 的 ZipFile.CreateFromDirectory）
     * 会在条目名里用反斜杠当路径分隔符，违反 ZIP 规范。Windows 解压时看不出来，
     * 但 macOS / Linux 上会把 `目录\文件` 当成一个平铺的怪文件名。
     * 详见 _dev/zipwrite.mjs 顶部的说明，验证脚本是 _dev/zip-check.mjs。
     */
    const z = createZip({
      srcDir: OUT,
      zipPath: zip,
      rootPrefix: APP_DIR_NAME,
      /*
       * 权限位要显式给，不能让 cp() 复制来的模式漏进去。
       * 具体踩到的坑：`fs.cp` 会保留源文件的 mode，Windows 上的 node.exe 是 0755，
       * 于是 bin/node.exe 在 zip 里也成了「可执行」——到了 macOS / Linux 上，
       * 启动器的 `[ -x ]` 判断会通过，然后尝试执行一个 Windows PE 文件，
       * 报一句让人完全摸不着头脑的 "cannot execute binary file"。
       * 所以：只有 .sh / .command 给 0755，其余一律 0644。
       */
      modeFor: (name, isDir) => (isDir ? 0o755 : /\.(sh|command)$/.test(name) ? 0o755 : 0o644),
      log: (m) => log(` ${m.trim()}`),
    });
    log(`  压缩后 ${mb(z.bytes)}`);
    log(`  SHA256 ${z.sha256}`);
    /*
     * 校验文件里写的是 **ASCII 附件名**，不是本地那个中文 zip 名。
     * 因为 release.mjs 上传时会把它改名成 music-overlap-<版本>-portable.zip
     * （GitHub 的附件接口会静默吃掉非 ASCII 字符，见 release.mjs 开头），
     * 用户下载到的是 ASCII 名，`certutil -hashfile <那个名字> SHA256` 得能对上。
     */
    const asciiName = `music-overlap-${VERSION}-portable.zip`;
    await writeFile(
      path.join(DIST, `${APP_DIR_NAME}.zip.sha256.txt`),
      `${z.sha256}  ${asciiName}\n`,
      'utf8'
    );
    log(`\n✅ 可以发给朋友了（Windows 双击 启动.bat，macOS 双击 启动.command，Linux 跑 ./启动.sh）：${zip}`);
  } else {
    log(`\n✅ 文件夹已铺好：${OUT}`);
  }
}

function findNodeExe() {
  // 优先用正在跑这个脚本的那个 node（它就是本机的 node.exe）
  if (process.execPath && path.basename(process.execPath).toLowerCase() === 'node.exe') {
    return process.execPath;
  }
  const candidates = [
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error('没找到本机的 node.exe，装一个 Node 再跑这个脚本');
}

main().catch((e) => {
  console.error('\n构建失败：', e.message);
  process.exit(1);
});
