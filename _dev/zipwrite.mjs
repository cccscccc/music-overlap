/**
 * 用 Node 内置模块写 zip —— 零第三方依赖。
 *
 * 为什么不用 PowerShell 的 Compress-Archive（踩过的坑）：
 * 它会用**反斜杠**当条目名的路径分隔符（写成 `目录\文件`），而 ZIP 规范要求正斜杠。
 * Windows 上的解压工具会自动把反斜杠当分隔符，所以一直没暴露；但 macOS / Linux 上的
 * 解压工具严格遵守规范，会把反斜杠当普通字符——解出来是一坨平铺的、名字里带反斜杠的怪文件，
 * 里面没有 bin/ 也没有 platforms/。
 *
 * 本模块保证：
 * - 条目名一律用 `/` 分隔（绝不出现 `\`）
 * - 目录条目名以 `/` 结尾，同时把 MS-DOS 目录位（0x10）写进 external attributes 低 16 位
 *   —— 两处**都要**：Python 的 zipfile 只认结尾的 `/`（is_dir() 不看属性位），
 *   而有些工具只认属性位，两边都写才不会有人掉队
 * - 文件名全程 UTF-8 编码，并设置 general purpose bit 11（0x0800）声明「这是 UTF-8」
 * - 可以给条目带上 POSIX 权限（external attributes 高 16 位），让 .sh / .command 在 Mac/Linux 上可执行
 * - 压不动的内容自动退回 store，不白费时间
 *
 * 对照事实（2026-10 本机实测，用读原始字节的办法）：
 * - PowerShell 5.1 的 `Compress-Archive` 和 .NET 的 `ZipFile.CreateFromDirectory` 都**不写目录条目**，
 *   并且在条目名里用 `\`（实测 `sub\b.txt`：`/` x0、`\` x1）——所以它们在 Mac/Linux 上解出来是平铺的怪文件。
 * - .NET 写出的条目 external attributes 是 `0x00000000`，也就是权限位全 0；我们写 0644/0755 更规范。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const FLAG_UTF8 = 0x0800;

/** MS-DOS 时间/日期：zip 的传统字段，年份范围只有 1980–2107，超出就夹住。 */
function dosDateTime(when) {
  const d = when instanceof Date && !Number.isNaN(when.getTime()) ? when : new Date();
  if (d.getFullYear() < 1980) return { time: 0, date: (1 << 5) | 1 };
  const year = Math.min(d.getFullYear(), 2107);
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f);
  const dosDate = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date: dosDate };
}

/**
 * 递归列目录，返回相对路径（一律用 `/` 分隔）。
 * 符号链接直接跳过——跨平台包里带链接只会带来麻烦。
 */
export function listTree(rootDir) {
  const dirs = [];
  const files = [];

  const walk = (absDir, relDir) => {
    const entries = fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    for (const e of entries) {
      const abs = path.join(absDir, e.name);
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        dirs.push(rel);
        walk(abs, rel);
      } else if (e.isFile()) {
        files.push({ rel, abs });
      }
    }
  };

  walk(rootDir, '');
  return { dirs, files };
}

/**
 * 把一个目录打成 zip。
 *
 * @param {object} opts
 * @param {string} opts.srcDir            要打包的目录
 * @param {string} opts.zipPath           输出 zip 路径
 * @param {string} [opts.rootPrefix]      可选：所有条目加一层前缀目录（如 `音乐重合度-便携版`）
 * @param {(rel: string, isDir: boolean) => number} [opts.modeFor]  按相对路径给 POSIX 权限
 * @param {(msg: string) => void} [opts.log]
 */
export function createZip({ srcDir, zipPath, rootPrefix = '', modeFor, log = () => {} }) {
  const { dirs, files } = listTree(srcDir);
  const prefix = rootPrefix ? `${rootPrefix.replace(/\/+$/, '')}/` : '';

  // 条目名：目录在前，文件在后；一律 `/` 分隔、**目录以 `/` 结尾**
  const dirNames = [];
  if (rootPrefix) dirNames.push(`${rootPrefix.replace(/\/+$/, '')}/`);
  for (const d of dirs) dirNames.push(`${prefix}${d}/`);

  const chunks = [];
  const central = [];
  let offset = 0;

  const push = (buf) => {
    chunks.push(buf);
    offset += buf.length;
  };

  const addEntry = (name, { isDir, data = Buffer.alloc(0), date }) => {
    const nameBuf = Buffer.from(name, 'utf8');
    const { time, date: dosDate } = dosDateTime(date);
    const crc = isDir ? 0 : zlib.crc32(data) >>> 0;

    // 压缩；压不小就 store
    let method = 0;
    let payload = data;
    if (!isDir && data.length > 0) {
      const packed = zlib.deflateRawSync(data, { level: 9 });
      if (packed.length < data.length) {
        method = 8;
        payload = packed;
      }
    }

    const typeBits = isDir ? 0o040000 : 0o100000;
    const perm = (modeFor ? modeFor(name, isDir) : null) ?? (isDir ? 0o755 : 0o644);
    // 高 16 位是 POSIX 权限（.NET 风格 / UNIX 约定），低 16 位放 MS-DOS 属性；
    // 目录要把 DOS 目录位 0x10 也置上，两头都不落空。
    const external = (((typeBits | perm) << 16) | (isDir ? 0x10 : 0)) >>> 0;

    const localOffset = offset;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);        // version needed to extract
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    push(local);
    push(nameBuf);
    push(payload);

    central.push({ nameBuf, method, crc, packed: payload.length, raw: data.length, time, dosDate, external, localOffset });
    return { method, raw: data.length, packed: payload.length };
  };

  const now = new Date();
  for (const d of dirNames) addEntry(d, { isDir: true, date: now });
  for (const f of files) {
    addEntry(`${prefix}${f.rel}`, { isDir: false, data: fs.readFileSync(f.abs), date: fs.statSync(f.abs).mtime });
  }

  // ---- 中央目录 ----
  const cdStart = offset;
  let deflated = 0;
  let stored = 0;
  for (const e of central) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(SIG_CENTRAL, 0);
    h.writeUInt16LE(0x031e, 4);        // version made by: UNIX(3) << 8 | 30
    h.writeUInt16LE(20, 6);
    h.writeUInt16LE(FLAG_UTF8, 8);
    h.writeUInt16LE(e.method, 10);
    h.writeUInt16LE(e.time, 12);
    h.writeUInt16LE(e.dosDate, 14);
    h.writeUInt32LE(e.crc, 16);
    h.writeUInt32LE(e.packed, 20);
    h.writeUInt32LE(e.raw, 24);
    h.writeUInt16LE(e.nameBuf.length, 28);
    h.writeUInt16LE(0, 30);            // extra
    h.writeUInt16LE(0, 32);            // comment
    h.writeUInt16LE(0, 34);            // disk number start
    h.writeUInt16LE(0, 36);            // internal attributes
    h.writeUInt32LE(e.external, 38);
    h.writeUInt32LE(e.localOffset, 42);
    push(h);
    push(e.nameBuf);
    if (e.method === 8) deflated++;
    else stored++;
  }
  const cdSize = offset - cdStart;

  // ---- EOCD ----
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  push(eocd);

  const out = Buffer.concat(chunks);
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  fs.writeFileSync(zipPath, out);

  const sha256 = createHash('sha256').update(out).digest('hex');
  log(`  ${central.length} 个条目（deflate ${deflated} / store ${stored}），${(out.length / 1048576).toFixed(2)} MB`);

  return { zipPath, bytes: out.length, entries: central.length, sha256 };
}
