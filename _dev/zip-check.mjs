/**
 * zipwrite.mjs 的测试 —— 用**三套互相独立的 ZIP 解析器**验证同一个文件，
 * 因为这次踩的坑正是「Windows 上的解压工具会自动纠正错误的分隔符，
 * 所以单看 Windows 解压结果是发现不了问题的」。
 *
 * 用法：node _dev/zip-check.mjs
 * 可选环境变量 PYTHON_EXE 指向真 Python（会多跑一组「等同 Mac/Linux 行为」的验证）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createZip } from './zipwrite.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? `  → ${detail}` : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `  → ${detail}` : ''}`); }
}

const TMP = path.join(os.tmpdir(), `zipcheck-${Date.now()}`);
const SRC = path.join(TMP, 'src');
const ZIP = path.join(TMP, 'out.zip');

// ---------- 造一棵有代表性的目录树 ----------
fs.mkdirSync(path.join(SRC, 'bin'), { recursive: true });
fs.mkdirSync(path.join(SRC, 'platforms'), { recursive: true });
fs.mkdirSync(path.join(SRC, 'public'), { recursive: true });
fs.mkdirSync(path.join(SRC, '空目录也要留住'), { recursive: true });

fs.writeFileSync(path.join(SRC, '启动.bat'), 'rem 启动\r\n');
fs.writeFileSync(path.join(SRC, '启动.command'), '#!/bin/sh\necho hi\n');
fs.writeFileSync(path.join(SRC, '启动.sh'), '#!/bin/sh\necho hi\n');
fs.writeFileSync(path.join(SRC, 'README.md'), '# 中文名文件\n');
fs.writeFileSync(path.join(SRC, 'bin', 'node.exe'), randomBytes(300000)); // 真随机 → 压不动，必须退回 store
fs.writeFileSync(path.join(SRC, 'platforms', 'index.mjs'), 'export default {};\n');
fs.writeFileSync(path.join(SRC, 'public', 'app.js'), 'console.log(1);\n');

console.log(`打包 ${path.relative(TMP, SRC)} → out.zip\n`);

const res = createZip({
  srcDir: SRC,
  zipPath: ZIP,
  rootPrefix: '音乐重合度-便携版',
  modeFor: (rel) => (/\.(command|sh)$/.test(rel) ? 0o755 : null),
  log: (m) => console.log(m),
});
console.log('');

// ---------- 检查 1：直接读原始字节（唯一不会骗人的办法） ----------
console.log('【检查 1】直接读中央目录的原始字节');
const buf = fs.readFileSync(ZIP);
let eocd = -1;
for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
ok('能找到 EOCD', eocd > 0);
const declared = buf.readUInt16LE(eocd + 10);
const cdOff = buf.readUInt32LE(eocd + 16);

const entries = [];
let p = cdOff;
for (let i = 0; i < declared; i++) {
  const sig = buf.readUInt32LE(p);
  if (sig !== 0x02014b50) { ok(`第 ${i} 项中央目录签名`, false, `0x${sig.toString(16)}`); break; }
  const flags = buf.readUInt16LE(p + 8);
  const method = buf.readUInt16LE(p + 10);
  const crc = buf.readUInt32LE(p + 16);
  const packed = buf.readUInt32LE(p + 20);
  const rawSize = buf.readUInt32LE(p + 24);
  const nameLen = buf.readUInt16LE(p + 28);
  const extraLen = buf.readUInt16LE(p + 30);
  const commentLen = buf.readUInt16LE(p + 32);
  const external = buf.readUInt32LE(p + 38);
  const localOff = buf.readUInt32LE(p + 42);
  const rawName = buf.subarray(p + 46, p + 46 + nameLen);

  entries.push({
    name: rawName.toString('utf8'),
    rawName,
    flags,
    method,
    crc,
    packed,
    rawSize,
    localOff,
    // external attributes 是 4 字节：高 16 位 UNIX 权限与类型，低 16 位 MS-DOS 属性
    externalLow: external & 0xffff,
    unixMode: (external >>> 16) & 0o7777,
    unixType: (external >>> 16) & 0o170000,
    mode: (external >>> 16) & 0o777,
  });
  p += 46 + nameLen + extraLen + commentLen;
}

const names = entries.map((e) => e.name);
const backslash = entries.filter((e) => e.rawName.includes(0x5c)).length;
const noUtf8 = entries.filter((e) => !(e.flags & 0x0800)).length;
const dirEntries = entries.filter((e) => e.name.endsWith('/'));
const dirFlagBits = entries.filter((e) => (e.externalLow & 0x10) !== 0).length;
const unixTypeDirs = entries.filter((e) => e.unixType === 0o040000).length;

ok('条目数正确', declared === entries.length && declared === res.entries, `${declared} 项`);
ok('路径分隔符一律是正斜杠，没有任何反斜杠', backslash === 0, `含 \\ 的 ${backslash} 项`);
ok('没有条目以 ./ 或 / 开头', entries.every((e) => !e.name.startsWith('./') && !e.name.startsWith('/')));
ok('目录条目一律以 / 结尾（Python zipfile 只认这个）',
  dirEntries.length === 5 && dirEntries.every((e) => e.unixType === 0o040000),
  `${dirEntries.length} 个目录条目：${dirEntries.map((e) => e.name).join(' ')}`);
ok('目录条目同时带上了 MS-DOS 目录位 0x10（有些工具只认属性位）', dirFlagBits === 5, `${dirFlagBits} 项带 0x10`);
ok('普通文件不以 / 结尾', entries.filter((e) => e.unixType === 0o100000).every((e) => !e.name.endsWith('/')));
ok('目录条目之外，条目名里只有正斜杠', entries.filter((e) => e.unixType === 0o100000).every((e) => !e.rawName.includes(0x5c)));
ok('所有条目都声明了 UTF-8（bit 11）', noUtf8 === 0, noUtf8 === 0 ? `全部 ${declared} 项已设置` : `${noUtf8} 项没设置`);
ok('中文文件名按 UTF-8 原样保留', names.includes('音乐重合度-便携版/启动.bat') && names.includes('音乐重合度-便携版/空目录也要留住/'),
  names.find((n) => n.includes('启动.bat')) ?? '');
ok('.sh / .command 被标成可执行（0755）',
  entries.filter((e) => /\.(sh|command)$/.test(e.name)).every((e) => e.mode === 0o755),
  entries.filter((e) => /\.(sh|command)$/.test(e.name)).map((e) => `${path.basename(e.name)}=${e.mode.toString(8)}`).join(' '));
ok('.bat 没有被误标成可执行',
  entries.filter((e) => e.name.endsWith('.bat')).every((e) => e.mode === 0o644),
  entries.filter((e) => e.name.endsWith('.bat')).map((e) => `${path.basename(e.name)}=${e.mode.toString(8)}`).join(' '));

console.log('\n  条目清单：');
for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name, 'zh'))) {
  const kind = e.unixType === 0o040000 ? 'dir ' : 'file';
  console.log(`    ${kind} ${e.name.padEnd(40)} ${e.mode.toString(8).padStart(4, '0')}  ${e.rawSize} B`);
}

// ---------- 检查 2：逐条解压并校验 CRC（证明内容没坏） ----------
console.log('\n【检查 2】逐条按中央目录的偏移解压，校验 CRC32 与长度');
let crcOk = 0;
const crcBad = [];
for (const e of entries) {
  const lNameLen = buf.readUInt16LE(e.localOff + 26);
  const lExtraLen = buf.readUInt16LE(e.localOff + 28);
  const dataStart = e.localOff + 30 + lNameLen + lExtraLen;
  const payload = buf.subarray(dataStart, dataStart + e.packed);

  let content;
  if (e.rawSize === 0) content = Buffer.alloc(0);
  else if (e.method === 0) content = payload;
  else content = zlib.inflateRawSync(payload);

  const good = content.length === e.rawSize && (e.rawSize === 0 || (zlib.crc32(content) >>> 0) === e.crc);
  if (good) crcOk++;
  else crcBad.push(`${e.name}（解出 ${content.length} B，应为 ${e.rawSize} B）`);
}
ok('所有条目 CRC32 与解压长度都对得上', crcBad.length === 0,
  crcBad.length ? crcBad.join('；') : `${crcOk}/${declared} 项通过`);
const exeEntry = entries.find((e) => e.name.endsWith('node.exe'));
ok('压不动的随机数据退回 store，没有白压',
  exeEntry.method === 0 && exeEntry.packed === exeEntry.rawSize,
  `node.exe method=${exeEntry.method} packed=${exeEntry.packed} raw=${exeEntry.rawSize}`);

// ---------- 检查 3：用 Python 的 zipfile 解压（等同 Mac/Linux 的行为） ----------
console.log('\n【检查 3】用 Python zipfile 解压 —— 它严格按规范解析，等同 Mac/Linux');
const py = process.env.PYTHON_EXE;
if (py && fs.existsSync(py)) {
  const outDir = path.join(TMP, 'extracted-py');
  // 注意：Python 往 Windows 控制台打印中文会被代码页搞成乱码——那是**终端**的问题，不是 zip 的问题。
  // 所以让 Python 全部输出 ASCII：名字只回显码点，"有没有乱码"改用 os.path.exists 在磁盘上判。
  const script = `
import zipfile, os
z = zipfile.ZipFile(r"${ZIP}")
names = z.namelist()
esc = lambda s: s.encode("unicode_escape").decode("ascii")
print("COUNT=" + str(len(names)))
print("BACKSLASH=" + str(len([n for n in names if chr(92) in n])))
print("NAMES=" + "|".join(esc(n) for n in names))
z.extractall(r"${outDir}")
files = []
for root, dirs, fs_ in os.walk(r"${outDir}"):
    for f in fs_:
        files.append(os.path.relpath(os.path.join(root, f), r"${outDir}").replace(os.sep, "/"))
print("TREE=" + "|".join(sorted(esc(f) for f in files)))
print("TOP=" + "|".join(sorted(esc(d) for d in os.listdir(r"${outDir}"))))
base = os.path.join(r"${outDir}", "\\u97f3\\u4e50\\u91cd\\u5408\\u5ea6-\\u4fbf\\u643a\\u7248")
print("BINEXE=" + str(os.path.exists(os.path.join(base, "bin", "node.exe"))))
print("EMPTYDIR=" + str(os.path.isdir(os.path.join(base, "\\u7a7a\\u76ee\\u5f55\\u4e5f\\u8981\\u7559\\u4f4f"))))
print("BATNAME=" + ("yes" if "\\u542f\\u52a8.bat" in os.listdir(base) else "no"))
print("ALLNAMES=" + "|".join(sorted(esc(n) for n in os.listdir(base))))
print("EXEC=" + oct(os.stat(os.path.join(base, "\\u542f\\u52a8.sh")).st_mode & 0o777))
`;
  const r = spawnSync(py, ['-c', script], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  if (r.status !== 0) {
    ok('Python 能解析这个 zip', false, (r.stderr || '').slice(0, 300));
  } else {
    const grab = (k) => (new RegExp(`${k}=(.*)`).exec(r.stdout)?.[1] ?? '').trim();
    const unesc = (s) => s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    const bs = grab('BACKSLASH');
    const tree = grab('TREE').split('|').filter(Boolean).map(unesc);
    const top = grab('TOP').split('|').filter(Boolean).map(unesc);

    ok('Python 读到的条目名里没有反斜杠', bs === '0', `含反斜杠的 ${bs} 项`);
    ok('解压后是真正的目录树，不是一坨平铺文件', tree.length === 7, `解出 ${tree.length} 个文件`);
    ok('嵌套目录被正确还原', grab('BINEXE') === 'True' && tree.some((t) => t.endsWith('bin/node.exe')), tree.find((t) => t.includes('node.exe')) ?? '（没找到）');
    ok('顶层只有一个前缀目录', top.length === 1 && top[0] === '音乐重合度-便携版', top.join(' / '));
    ok('中文文件名没乱码', grab('BATNAME') === 'yes', `解出来这一层是：${grab('ALLNAMES').split('|').map(unesc).join(' ')}`);
    ok('空目录也被保留', grab('EMPTYDIR') === 'True', '空目录也要留住');
    // 注意：本机是 Windows，NTFS 根本不存 POSIX 权限位，os.stat 一律回 0o666——
    // 所以「可执行」这件事只能在 Windows 上验证到「zip 里存对了」（检查 1 已验证），
    // 真机上是否生效要靠 Mac/Linux 执行时看。别在这里假装验过了。
    console.log(`  · 参考：Windows 上 os.stat 不体现 POSIX 权限位（${grab('EXEC')}），` +
      `这只说明 NTFS 的特性，没说明 zip 有问题；zip 里的 0755 已由检查 1 验证`);
  }
} else {
  console.log('  （跳过：设 PYTHON_EXE 指向真 Python 才会跑这一组）');
}

// ---------- 检查 4：.NET 的看法（Windows 侧解析器） ----------
console.log('\n【检查 4】用 Windows 自带的 .NET 解压 —— 确认 Windows 上也没坏');
const outDir2 = path.join(TMP, 'extracted-win');
fs.mkdirSync(outDir2, { recursive: true });
const r2 = spawnSync('powershell', ['-NoProfile', '-Command',
  `Add-Type -AssemblyName System.IO.Compression.FileSystem;` +
  `$z=[IO.Compression.ZipFile]::OpenRead('${ZIP}');` +
  `$back=($z.Entries | Where-Object { $_.FullName -like '*\\*' }).Count;` +
  `Write-Output "BACKSLASH=$back";` +
  `$z.Dispose();` +
  `[IO.Compression.ZipFile]::ExtractToDirectory('${ZIP}','${outDir2}')`], { encoding: 'utf8' });
ok('.NET 能正常解压', r2.status === 0, (r2.stdout || '').trim().split('\n')[0] || (r2.stderr || '').slice(0, 300));
ok('Windows 侧也还原出 bin/node.exe', fs.existsSync(path.join(outDir2, '音乐重合度-便携版', 'bin', 'node.exe')));

// ---------- 收尾 ----------
console.log(`\n${'─'.repeat(52)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
