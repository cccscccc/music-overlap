/**
 * 发 GitHub Release：建/更新 release，并把 dist/ 里的便携包传上去。
 *
 * 用法：
 *   $env:GH_TOKEN = '你的 token'          # 不要把 token 写进本文件或提交进仓库
 *   node _dev/release.mjs                 # 默认发当前 package 的版本（读 server.mjs 的 version）
 *   node _dev/release.mjs --tag v0.3.0    # 指定标签
 *   node _dev/release.mjs --recreate      # 已存在就删掉重建（换附件时用）
 *   node _dev/release.mjs --notes X.md    # 指定正文来源，默认用仓库根目录的 RELEASE-<tag>.md
 *
 * token 需要 repo 权限（经典 token 勾 repo；细粒度 token 给 Contents: Read and write）。
 *
 * ⚠️ 踩过的坑：**附件名只能用 ASCII。**
 * GitHub 的 release asset 接口会把文件名里的非 ASCII 字符直接丢掉，
 * 而且是静默的——不报错、HTTP 200，只是名字变了。实测：
 *     probe-ascii.zip          → probe-ascii.zip          （正常）
 *     probe-测试.zip            → probe-.zip               （中文被吃掉）
 *     probe-%E6%B5%8B%E8%AF%95.zip → probe-.zip            （先编码也没用）
 *     probe-%25E6%25B5%258B... → probe-.E6.B5.8B.E8.AF.95.zip（编两次更惨）
 * 所以这里上传时统一改成 ASCII 名（music-overlap-<版本>-portable.zip），
 * 并在正文里说明「解压出来的目录仍然是中文的」。
 *
 * 另外两条经验：
 * - 中文文件名不要当命令行参数传（Windows 用系统 ANSI 代码页编码 argv，会是乱码）；
 *   本脚本不接受文件名参数，附件名在文件里写死，避开这个坑。
 * - 上传大文件用 Node 自带 fetch 直接发 Buffer 就行（33MB 实测没问题）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');

const argv = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};

const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) {
  console.error('缺少环境变量 GH_TOKEN。先设置它，别把 token 写进代码里：');
  console.error("  PowerShell:  $env:GH_TOKEN = 'ghp_xxx'");
  console.error('  CMD:         set GH_TOKEN=ghp_xxx');
  process.exit(2);
}

const REPO = opt('--repo', 'cccscccc/music-overlap');
const RECREATE = argv.includes('--recreate');

/** 版本号从 server.mjs 里读，避免两处不同步。 */
function readVersion() {
  const src = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  const m = src.match(/version:\s*['"]([^'"]+)['"]/);
  if (!m) throw new Error('在 server.mjs 里找不到 version');
  return m[1];
}

const version = readVersion();
const TAG = opt('--tag', `v${version}`);
const NOTES_FILE = opt('--notes', path.join(ROOT, `RELEASE-${version}.md`));
if (!fs.existsSync(NOTES_FILE)) {
  console.error(`找不到正文文件：${NOTES_FILE}`);
  console.error('每个版本在仓库根目录放一个 RELEASE-<版本>.md，脚本会自动用它当 Release 正文。');
  process.exit(2);
}

// 附件名一律 ASCII —— 见文件头「踩过的坑」
const ASSETS = [
  { file: '音乐重合度-便携版.zip', as: `music-overlap-${version}-portable.zip` },
  { file: '音乐重合度-便携版.zip.sha256.txt', as: `music-overlap-${version}-portable.zip.sha256.txt` },
  // 安卓包：有才传（没装安卓工具链的人只发桌面版，不该因为缺这个文件而失败）
  { file: 'music-overlap-android.apk', as: `music-overlap-${version}-android.apk`, optional: true },
];

const API = 'https://api.github.com';
const H = { Authorization: `token ${TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'music-overlap-release' };

const notes = fs.readFileSync(NOTES_FILE, 'utf8').trim();
const title = notes.split('\n')[0].replace(/^#\s*/, '').trim();

async function findRelease() {
  const r = await fetch(`${API}/repos/${REPO}/releases/tags/${TAG}`, { headers: H });
  return r.ok ? r.json() : null;
}

console.log(`仓库：${REPO}`);
console.log(`标签：${TAG}（来自 server.mjs 的 version = ${version}）`);
console.log(`正文：${path.relative(ROOT, NOTES_FILE)}（${notes.length} 字符）`);
console.log(`标题：${title}\n`);

let rel = await findRelease();
if (rel && RECREATE) {
  const d = await fetch(`${API}/repos/${REPO}/releases/${rel.id}`, { method: 'DELETE', headers: H });
  console.log(`[重建] 删掉已有 release ${TAG}（HTTP ${d.status}，附件一并删除）`);
  rel = null;
}

if (rel) {
  console.log(`[复用] 已有 release ${TAG}（id=${rel.id}，附件 ${(rel.assets || []).length} 个）`);
  const p = await fetch(`${API}/repos/${REPO}/releases/${rel.id}`, {
    method: 'PATCH',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: title, body: notes }),
  });
  console.log(`[同步] 标题/正文已更新（HTTP ${p.status}）`);
} else {
  const r = await fetch(`${API}/repos/${REPO}/releases`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: TAG, name: title, body: notes, draft: false, prerelease: false }),
  });
  const j = await r.json();
  if (!r.ok) { console.error(`[失败] 建 release：HTTP ${r.status} ${j.message || ''}`); process.exit(1); }
  rel = j;
  console.log(`[新建] release ${TAG}  id=${rel.id}`);
}

for (const { file, as, optional } of ASSETS) {
  const full = path.join(DIST, file);
  if (!fs.existsSync(full)) {
    console.log(`[跳过] 没有 ${file}${optional ? '（可选附件）' : ' —— 先跑一次 build-portable.mjs'}`);
    if (!optional) console.error('  ⚠️ 这个附件是必须的，发布后记得补上');
    continue;
  }

  const dup = (rel.assets || []).find((a) => a.name === as);
  if (dup) {
    await fetch(`${API}/repos/${REPO}/releases/assets/${dup.id}`, { method: 'DELETE', headers: H });
    console.log(`[清理] 删掉同名旧附件 ${as}`);
  }

  const buf = fs.readFileSync(full);
  console.log(`[上传] ${as}  ${(buf.length / 1048576).toFixed(2)} MB …`);
  const up = await fetch(`https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(as)}`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/octet-stream' },
    body: buf,
  });
  const j = await up.json().catch(() => ({}));
  if (!up.ok || j.state !== 'uploaded') {
    console.error(`[失败] HTTP ${up.status} ${j.message || ''}`);
    process.exit(1);
  }
  if (j.name !== as) {
    console.error(`[警告] GitHub 把附件名改掉了：想要 ${as}，存成 ${j.name}`);
    console.error('        附件名只能 ASCII —— 见本文件开头「踩过的坑」。');
  }
  console.log(`[完成] ${j.name}  ${(j.size / 1048576).toFixed(2)} MB`);
}

const final = await (await fetch(`${API}/repos/${REPO}/releases/tags/${TAG}`, { headers: H })).json();
console.log(`\n=== ${final.tag_name} ===`);
console.log(`页面：${final.html_url}`);
for (const a of final.assets || []) {
  console.log(`附件：${a.name}  ${(a.size / 1048576).toFixed(2)} MB`);
  console.log(`      ${a.browser_download_url}`);
}
