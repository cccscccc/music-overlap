/*
 * 把「手机访问」的启动器落到源码根目录。
 *
 *   node _dev/make-launchers.mjs
 *
 * 为什么需要这一步：便携包里的 .bat / .sh 是 _dev/build-portable.mjs 生成的，
 * 源码目录下本来没有对应文件——从 GitHub clone 下来的用户就没有这个入口。
 * 正文写在 _dev/launchers.mjs，两个地方共用同一份，省得改一处漏一处。
 *
 * 落地时有两个坑必须在这儿解决，否则脚本在 Windows 上就是个乱码文件：
 *   · .bat 要 GBK(cp936) + CRLF —— 中文 Windows 控制台默认 936 代码页
 *   · .sh  要纯 LF —— shebang 后面跟个 CR，内核直接找不到解释器
 *
 * 便携版走的是同一条规矩（见 build-portable.mjs 里的 writeGbk / writeLf），
 * 这里只做「不用建整包，也能拿到启动器」这件事。
 */
import { execFileSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { phoneBat, phoneSh } from './launchers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** 源码根目录用系统的 node（没有 bin/node.exe 那种自带运行时） */
const EXE_REL = 'node';

async function writeGbk(file, text) {
  // Node 内置没有 GBK 编码器，交给 PowerShell 按 cp936 落盘
  const tmp = path.join(ROOT, `.gbk-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  await writeFile(tmp, text, 'utf8');
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
}

const writeLf = (file, text) => writeFile(file, text.replace(/\r\n?/g, '\n'), 'utf8');

await writeGbk(path.join(ROOT, '手机访问.bat'), phoneBat(EXE_REL, false));
await writeLf(path.join(ROOT, '手机访问.sh'), phoneSh(false));
await writeLf(path.join(ROOT, '手机访问.command'), `#!/bin/sh
# macOS 双击入口：交给同目录的 手机访问.sh 干活。
DIR=$(cd "$(dirname "$0")" && pwd) || exit 1
exec "$DIR/手机访问.sh" "$@"
`);

console.log('已生成：手机访问.bat（GBK+CRLF） / 手机访问.sh（LF） / 手机访问.command（LF）');
