/**
 * 验收真正要发出去的那个 zip：`dist/音乐重合度-便携版.zip`
 *
 * 和 _dev/zip-check.mjs 的区别：
 *   zip-check 验的是「写入器」本身（自己造的小样本，跑得快、断言密）；
 *   本脚本验的是**真实产物**（88MB node.exe 在里面），用 Python 严格解压一遍，
 *   确认 macOS / Linux 上解出来是好的目录树、启动器带可执行位。
 *
 * 用法：node _dev/zip-verify-dist.mjs
 *      环境变量 PYTHON_EXE 指向真 Python（必需，否则跳过严格解压）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// 注意：不能自己拿 import.meta.url 手搓路径，项目目录里带空格和中文，
// url 里是 %20/%E9%9F%B3 这种转义，必须用 fileURLToPath 解回来。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ZIP = path.join(ROOT, 'dist', '音乐重合度-便携版.zip');
const APP = '音乐重合度-便携版';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? `  → ${detail}` : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `  → ${detail}` : ''}`); }
};

if (!fs.existsSync(ZIP)) {
  console.error(`找不到 ${ZIP}，先跑 node _dev/build-portable.mjs`);
  process.exit(1);
}

const size = fs.statSync(ZIP).size;
console.log(`验收 ${path.relative(ROOT, ZIP)}（${(size / 1048576).toFixed(2)} MB）\n`);

// ---------- 1) 原始字节：条目名 ----------
console.log('【1】直接读中央目录的原始字节');
const buf = fs.readFileSync(ZIP);
let eocd = -1;
for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
const total = buf.readUInt16LE(eocd + 10);
const cdOff = buf.readUInt32LE(eocd + 16);

const entries = [];
let p = cdOff;
for (let i = 0; i < total; i++) {
  const nameLen = buf.readUInt16LE(p + 28);
  const extraLen = buf.readUInt16LE(p + 30);
  const commentLen = buf.readUInt16LE(p + 32);
  const external = buf.readUInt32LE(p + 38);
  const raw = buf.subarray(p + 46, p + 46 + nameLen);
  entries.push({
    name: raw.toString('utf8'),
    raw,
    flags: buf.readUInt16LE(p + 8),
    mode: (external >>> 16) & 0o777,
    unixType: (external >>> 16) & 0o170000,
    rawSize: buf.readUInt32LE(p + 24),
  });
  p += 46 + nameLen + extraLen + commentLen;
}

const files = entries.filter((e) => e.unixType === 0o100000);
ok('条目总数与 EOCD 一致', entries.length === total, `${total} 项`);
ok('没有任何条目名含反斜杠', entries.every((e) => !e.raw.includes(0x5c)));
ok('全部条目声明 UTF-8', entries.every((e) => e.flags & 0x0800));
ok('目录条目以 / 结尾', entries.filter((e) => e.unixType === 0o040000).every((e) => e.name.endsWith('/')));
ok('中文文件名保留', files.some((e) => e.name === `${APP}/先看我.txt`), `${APP}/先看我.txt`);

const sh = entries.filter((e) => /\.(sh|command)$/.test(e.name));
ok('启动器在 zip 里是可执行的（0755）', sh.length === 2 && sh.every((e) => e.mode === 0o755),
  sh.map((e) => `${path.basename(e.name)}=${e.mode.toString(8)}`).join(' '));
const nodeExe = entries.find((e) => e.name.endsWith('bin/node.exe'));
ok('bin/node.exe 是普通文件、且**没有**被标成可执行（Mac 上误判的关键）',
  nodeExe && nodeExe.unixType === 0o100000 && nodeExe.mode === 0o644,
  nodeExe ? `${nodeExe.mode.toString(8)}` : '（没找到）');

console.log('\n  条目清单：');
for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name, 'zh'))) {
  const kind = e.unixType === 0o040000 ? 'dir ' : 'file';
  console.log(`    ${kind} ${e.name.padEnd(46)} ${e.mode.toString(8).padStart(4, '0')}  ${e.rawSize} B`);
}

// ---------- 2) 用 Python 严格解压（等同 macOS / Linux 的行为） ----------
console.log('\n【2】用 Python zipfile 解压 —— 严格按规范，等同 macOS / Linux');
const py = process.env.PYTHON_EXE;
if (!py || !fs.existsSync(py)) {
  console.log('  （跳过：设 PYTHON_EXE 指向真 Python）');
} else {
  const outDir = path.join(os.tmpdir(), `dist-verify-${Date.now()}`);
  const script = `
import zipfile, os, stat, json
z = zipfile.ZipFile(r"${ZIP}")
names = z.namelist()
bad = z.testzip()
z.extractall(r"${outDir}")
base = os.path.join(r"${outDir}", "\\u97f3\\u4e50\\u91cd\\u5408\\u5ea6-\\u4fbf\\u643a\\u7248")
res = {
  "count": len(names),
  "backslash": len([n for n in names if chr(92) in n]),
  "testzip": bad,
  "top_entries": sorted(os.listdir(r"${outDir}")),
  "root_files": sorted(os.listdir(base)),
  "nested_ok": os.path.isdir(os.path.join(base, "platforms")) and os.path.isfile(os.path.join(base, "platforms", "index.mjs")),
  "node_exe_ok": os.path.isfile(os.path.join(base, "bin", "node.exe")),
  "node_exe_size": os.path.getsize(os.path.join(base, "bin", "node.exe")) if os.path.isfile(os.path.join(base, "bin", "node.exe")) else 0,
  "server_size": os.path.getsize(os.path.join(base, "server.mjs")),
}
print("JSON=" + json.dumps(res, ensure_ascii=True))
`;
  const r = spawnSync(py, ['-c', script], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    ok('Python 解压真实产物', false, (r.stderr || '').slice(0, 400));
  } else {
    const json = JSON.parse(/JSON=(.*)/.exec(r.stdout)[1]);
    ok('Python 解出的条目数一致', json.count === total, `${json.count} 项`);
    ok('没有反斜杠条目名', json.backslash === 0);
    ok('CRC 全部通过（testzip 返回 None）', json.testzip === null, String(json.testzip));
    ok('顶层只有一个前缀目录', json.top_entries.length === 1 && json.top_entries[0] === '音乐重合度-便携版', json.top_entries.join(' / '));
    ok('嵌套目录结构还原正确', json.nested_ok);
    ok('bin/node.exe 解出来是完整大小', json.node_exe_ok && json.node_exe_size > 80 * 1024 * 1024,
      `${(json.node_exe_size / 1048576).toFixed(1)} MB`);
    ok('根目录文件齐全', json.root_files.includes('server.mjs') && json.root_files.includes('启动.bat')
      && json.root_files.includes('启动.sh') && json.root_files.includes('启动.command')
      && json.root_files.includes('先看我.txt'), json.root_files.join(' '));
  }
  fs.rmSync(outDir, { recursive: true, force: true });
}

// ---------- 3) 启动器的「只能在 Mac/Linux 上暴露」的毛病 ----------
console.log('\n【3】启动器本身：换行符与双击入口（这两条在 Windows 上永远看不出问题）');
const appDir = path.join(ROOT, 'dist', APP);
const shPath = path.join(appDir, '启动.sh');
const cmdPath = path.join(appDir, '启动.command');
if (!fs.existsSync(shPath)) {
  ok('启动.sh 存在', false);
} else {
  const shBuf = fs.readFileSync(shPath);
  const crlf = (shBuf.toString('binary').match(/\r/g) || []).length;
  ok('启动.sh 是纯 LF（shebang 后面跟个 CR 会让内核找不到解释器）', crlf === 0, `CR 数量 ${crlf}`);
  ok('启动.sh 第一行就是 shebang', shBuf.toString('utf8').split('\n')[0] === '#!/bin/sh');

  const shText = shBuf.toString('utf8');
  ok('启动.sh 会先找 bin/node、再退回系统 node',
    /\[ -x "\$DIR\/bin\/node" \]/.test(shText) && /command -v node/.test(shText));
  ok('启动.sh 说清了「自带的是 Windows 版」', shText.includes('bin/node.exe') && shText.includes('Windows 版'));
  // 这一条是防回归的：系统里有 node 时选的是系统 node，此时不提示的话，用户会一直以为
  // 「包里那个 bin/node.exe 才该被用上」，或者干脆去双击它。
  ok('启动.sh 在用系统 node 时也会先说明「包里的 node.exe 是 Windows 版」',
    shText.includes('所以下面用的是你自己系统里装的 Node.js'),
    (shText.match(/提示：这个包是 Windows 版打包的[^\n]*/) || ['（没找到这句）'])[0]);
  ok('启动.sh 里没有 CRLF 拼出来的变量（\u005c$ 转义没被吃）',
    shText.includes('"$EXE" "$DIR/server.mjs" "$PORT" --print-port'));

  const cmdText = fs.readFileSync(cmdPath, 'utf8');
  ok('启动.command 是纯 LF 且 exec 到 启动.sh',
    !cmdText.includes('\r') && /exec "\$DIR\/启动\.sh"/.test(cmdText), cmdText.trim().split('\n').pop());
}

console.log(`\n${'─'.repeat(52)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
