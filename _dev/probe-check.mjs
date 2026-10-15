/*
 * 探针（--probe-port）与「已经开着」这条路的行为测试。
 *
 * 为什么值得单独一组测试：这里出过的两个 bug 都是「肉眼看不出来」的类型——
 *   1) 探针子进程自己把服务起起来了，启动横幅混进 stdout，父进程 JSON.parse 直接炸，
 *      表现成「明明开着服务却认不出来」；
 *   2) /api/health 只答 ok/version/platforms，没有 url/lan，探针照抄就把地址写成了空白。
 * 所以这里把「没服务 / 有服务 / 端口被自己占着再启一次」三种情况全钉住。
 *
 * 用 child_process 自己起服务、自己收尸，跑完保证不留后台进程。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server.mjs');
/*
 * 端口别写死。第一版写的是 8901，结果那台机器上被一个完全无关的程序
 * （douyin_tray）占着，探针当然答不上话——测试红了一片，看着像探针坏了。
 * 现在从一个高位区间里挑一个「真的空着」的端口，并且把选中的端口打印出来。
 */
function pickFreePort() {
  for (let p = 8930; p < 8990; p++) {
    const r = spawnSync(process.execPath, [SERVER, '--probe-port', String(p)],
      { encoding: 'utf8', cwd: ROOT, timeout: 5000 });
    if (r.status === 1 && r.stdout === '') return p;
  }
  throw new Error('找不到空端口（8930-8989 都被占着）');
}
const PORT = pickFreePort();
const URL_FILE = path.join(ROOT, '.started.url');
let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${extra ? `   ← ${extra}` : ''}`);
};

const run = (args) => spawnSync(process.execPath, [SERVER, ...args], { encoding: 'utf8', cwd: ROOT });
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

for (const f of ['.started.url', '.started.json']) {
  try { fs.unlinkSync(path.join(ROOT, f)); } catch { /* 没有就算了 */ }
}

// ---------------------------------------------------------------- 场景 A
console.log(`A. ${PORT} 上什么都没有时，探针应当失败且不出声`);
const a = run(['--probe-port', String(PORT)]);
check(`退出码是 1（实际 ${a.status}）`, a.status === 1);
check('stdout 是空的', a.stdout === '', JSON.stringify(a.stdout));
check('stderr 是空的（探针不该打印启动横幅）', a.stderr === '', JSON.stringify(a.stderr));
check('.started.url 没被写出来', !fs.existsSync(URL_FILE));

// ---------------------------------------------------------------- 场景 B
console.log(`B. 真起一台在 ${PORT}（--lan --print-port）`);
const srv = spawn(process.execPath, [SERVER, String(PORT), '--lan', '--print-port'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
srv.stdout.setEncoding('utf8');
srv.stderr.setEncoding('utf8');
let banner = '';
let srvErr = '';
srv.stdout.on('data', (c) => { banner += c; });
srv.stderr.on('data', (c) => { srvErr += c; });

let up = false;
for (let i = 0; i < 60; i++) {
  if (run(['--probe-port', String(PORT)]).status === 0) { up = true; break; }
  await sleep(200);
}
check('服务起来了（探针能答上话）', up);
/*
 * 横幅要等一会儿再看：探针一通就说明端口已经 listen 了，但那几行 human-readable
 * 的输出可能还在管子里没读完（第一版就是这么误报的）。
 */
for (let i = 0; i < 20 && !banner.includes('手机（同一个 WiFi）打开'); i++) await sleep(100);
check('启动横幅里有「手机（同一个 WiFi）打开」', banner.includes('手机（同一个 WiFi）打开'),
  JSON.stringify(banner.slice(0, 80)));
check('启动时没有 stderr 输出', srvErr === '', srvErr.slice(0, 120));

if (up) {
  const b = run(['--probe-port', String(PORT)]);
  check(`探针退出码 0（实际 ${b.status}）`, b.status === 0);
  let info = null;
  try { info = JSON.parse(b.stdout); } catch { /* 下面报出来 */ }
  check('探针 stdout 是**单独一行**可解析的 JSON（没有横幅混进去）',
    !!info && b.stdout.trim().split('\n').length === 1, JSON.stringify(b.stdout));
  check('JSON 里 ok === true', info?.ok === true);
  check(`JSON 里 port === ${PORT}`, info?.port === PORT, String(info?.port));
  check('JSON 里 url 指向 127.0.0.1',
    typeof info?.url === 'string' && info.url === `http://127.0.0.1:${PORT}`, String(info?.url));
  check('JSON 里 lan 至少有一项（给手机用的地址）',
    Array.isArray(info?.lan) && info.lan.length > 0, JSON.stringify(info?.lan));
  check('探针顺手把手机地址写进了 .started.url（给 .bat 读的纯文本）',
    fs.existsSync(URL_FILE) && fs.readFileSync(URL_FILE, 'utf8').trim() === info?.lan?.[0],
    fs.existsSync(URL_FILE) ? fs.readFileSync(URL_FILE, 'utf8').trim() : '(没有这个文件)');

  // -------------------------------------------------------------- 场景 C
  console.log('C. 端口被这个工具自己占着时再启一次（用户「又双击了一次」）');
  const c = run([String(PORT), '--lan', '--print-port']);
  const all = (c.stdout || '') + (c.stderr || '');
  check(`退出码是 0（期望 0，实际 ${c.status}）——启动器看到 0 就不会再劝用户换端口`, c.status === 0);
  check('输出里有「已经在运行了」', all.includes('已经在运行了'));
  check('输出里有手机地址', all.includes(info?.lan?.[0] ?? '@@'), '');
  check('输出里没有被占用那句老提示挡在前面',
    !/^\s*\[端口被占用\]/m.test(all.split('已经在运行了')[0] ?? ''), '');
  /*
   * 这一步读文件可能差一拍：文件由探针子进程写，写盘完成不一定早于第二台进程退出。
   * 老写法直接 readFileSync，文件不在就整个测试脚本崩掉——测试自己不该这么脆。
   */
  let wrote = '';
  for (let i = 0; i < 20; i++) {
    try { wrote = fs.readFileSync(URL_FILE, 'utf8').trim(); } catch { wrote = ''; }
    if (wrote) break;
    await sleep(100);
  }
  check('.started.url 被重新写好（启动器刚删过它）', wrote === info?.lan?.[0], wrote || '(文件不存在)');

  // 第二台不该留下监听：同一时间只该有一个进程占着端口
  const second = spawn(process.execPath, [SERVER, String(PORT), '--lan', '--print-port'],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'] });
  await sleep(600);
  check('第二台进程自己退掉了（没有变成第二个常驻服务）', second.exitCode !== null || second.killed === false);
  try { second.kill(); } catch { /* 已经退了 */ }
}

// ---------------------------------------------------------------- 清场
srv.kill();
await sleep(600);
check('清场后端口放掉了（探针又失败）', run(['--probe-port', String(PORT)]).status === 1);
for (const f of ['.started.url', '.started.json']) {
  try { fs.unlinkSync(path.join(ROOT, f)); } catch { /* 没有就算了 */ }
}

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
