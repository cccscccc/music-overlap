/*
 * --lan 的验收自检：默认模式就该连不上，开了 --lan 才该连得上，而且该拦的还得拦住。
 *
 *   node _dev/lan-check.mjs
 *
 * 为什么要有这个脚本：
 *   「手机能不能连上」这件事在本机是测不出来的——本机永远能用 127.0.0.1 打开。
 *   测试里最容易犯的错就是拿回环地址冒充局域网访问，测完还是不知道自己开了什么。
 *   所以这里一律走本机的**真实局域网 IP**（和手机走的是同一条路），
 *   并且把默认模式当对照组跑：同一个地址在默认模式下必须连不上。
 *
 * 自己踩过的两个坑（都在这里守住了）：
 *   1) node 的 fetch 是**禁止伪造 Host 的**（按规范静默忽略）——用它测 DNS rebinding
 *      会永远"通过"。必须用 node:http 直接发才测得到。
 *   2) 这台机器上有虚拟网卡（VPN / Hyper-V 那类），netsh 之外拿到的地址顺序未必是
 *      用户该用的那个。所以显示的地址要跟服务器自己挑的那个对齐，不能各挑各的。
 *
 * 它验的是网络边界，不是界面行为（界面在 _dev/offline-check.mjs）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* ---------- 断言 ---------- */
let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}${extra ? '  → ' + extra : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 地址挑法与 server.mjs 保持一致（否则显示的地址和测的地址会不是同一个） ---------- */
const VIRTUAL_NIC = /vEthernet|vethernet|Virtual|VMware|VirtualBox|Hyper-V|Loopback|TAP|TUN|WSL|Docker|VPN|ZeroTier|Tailscale|vgate/i;
const nicScore = ({ name, address }) => {
  let s = 0;
  if (!VIRTUAL_NIC.test(name)) s += 100;
  if (address.startsWith('192.168.')) s += 30;
  else if (address.startsWith('10.')) s += 20;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) s += 10;
  return s;
};
const ranked = [];
for (const [name, list] of Object.entries(os.networkInterfaces())) {
  for (const ni of list || []) {
    if (ni.family !== 'IPv4' || ni.internal) continue;
    if (ni.address.startsWith('169.254.')) continue;
    ranked.push({ name, address: ni.address });
  }
}
ranked.sort((a, b) => nicScore(b) - nicScore(a));

if (!ranked.length) {
  console.error('这台机器没有局域网地址（没连 WiFi 也没插网线），--lan 无从测起。');
  process.exit(1);
}

/* ---------- 帮手 ---------- */
async function startServer(args, port) {
  const p = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), String(port), ...args], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  p.stdout.on('data', (c) => { out += c.toString(); });
  p.stderr.on('data', (c) => { out += c.toString(); });

  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return { p, out: () => out };
    } catch { /* 还没起来 */ }
    await sleep(150);
  }
  p.kill();
  throw new Error(`服务没起来（端口 ${port}）\n${out}`);
}

/** 起得来吗？连不上/超时都算"没起来"，用来做对照组断言 */
async function reachable(url, init = {}, timeoutMs = 3000) {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return { ok: true, status: r.status, headers: r.headers, body: await r.text() };
  } catch (e) {
    return { ok: false, error: e?.name === 'TimeoutError' ? '超时' : String(e?.cause?.code || e?.message || e) };
  }
}

/** 只有直接开 socket 才伪造得了 Host —— fetch 会按规范忽略它 */
function spoofHost(port, host, ip = '127.0.0.1') {
  return new Promise((resolve) => {
    const req = http.get({ host: ip, port, path: '/api/health', headers: { Host: host }, timeout: 4000 }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', (e) => resolve({ status: 0, body: String(e.code || e.message) }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '超时' }); });
  });
}

const PORT_OFF = 8802;
const PORT_ON = 8803;
console.log(`\n══ 本机局域网地址（按手机能不能连上排序）══`);
for (const { name, address } of ranked) console.log(`   ${address}   ${name}`);
const PRIMARY = ranked[0].address;

/* ================= 对照组：默认模式 ================= */
console.log('\n【1】默认模式（不加 --lan）—— 局域网 IP 必须连不上');
{
  const { p } = await startServer([], PORT_OFF);
  try {
    const x = await reachable(`http://${PRIMARY}:${PORT_OFF}/api/health`);
    ok('局域网 IP 连不上（只听 127.0.0.1）', x.ok === false, x.ok ? `竟然通了，status=${x.status}` : `被拒：${x.error}`);

    const loop = await reachable(`http://127.0.0.1:${PORT_OFF}/api/health`);
    ok('回环地址正常', loop.ok && loop.status === 200, `status=${loop.status}`);

    const fakeHost = await spoofHost(PORT_OFF, 'evil.example.com');
    ok('伪造 Host 被 403（DNS rebinding）', fakeHost.status === 403, `status=${fakeHost.status} ${fakeHost.body?.slice(0, 70)}`);

    const noCors = await reachable(`http://127.0.0.1:${PORT_OFF}/api/health`);
    ok('默认模式不回 CORS 头', !noCors.headers?.get('access-control-allow-origin'),
      `ACAO=${noCors.headers?.get('access-control-allow-origin') || '(无)'}`);
  } finally {
    p.kill();
    await sleep(300);
  }
}

/* ================= 实验组：开了 --lan ================= */
console.log('\n【2】开了 --lan —— 局域网 IP 该通，且该拦的还拦');
{
  const { p, out } = await startServer(['--lan', '--print-port'], PORT_ON);
  try {
    const lanBase = `http://${PRIMARY}:${PORT_ON}`;

    const h = await reachable(`${lanBase}/api/health`);
    ok('局域网 IP 能打开', h.ok && h.status === 200, `status=${h.status} body=${h.body?.slice(0, 70)}`);
    ok('回的是这一版', /"version":"\d+\.\d+\.\d+"/.test(h.body || ''), h.body?.slice(0, 70));

    const json = await reachable(`${lanBase}/api/platforms`);
    let platforms = null;
    try { platforms = JSON.parse(json.body); } catch { /* 下面断言会报 */ }
    ok('三家平台都在', Array.isArray(platforms?.platforms) && platforms.platforms.length === 3,
      JSON.stringify(platforms?.platforms?.map((x) => x.id)));

    /*
     * CORS：这里从 `*` 收紧成「只回给本机来源」了，所以三件事都要验到。
     * 从前那条断言写的是 `=== '*'`，等于把 `*` 当成了正确行为——
     * 而 `*` 不区分「手机上的页面」和「电脑上随便打开的那个网页」，后者也能读到响应。
     */
    const acao = (r) => r.headers?.get('access-control-allow-origin') || '';
    ok('没带 Origin（手机直连同源）不硬塞 CORS 头', acao(json) === '', `ACAO=${acao(json) || '(无)'}`);

    const trusted = await reachable(`${lanBase}/api/platforms`, { headers: { Origin: lanBase } });
    ok('本机来源的 Origin → 原样回给它，不用 *', acao(trusted) === lanBase, `ACAO=${acao(trusted) || '(无)'}`);
    ok('并且带 Vary: Origin（免得中间缓存串味）', /origin/i.test(trusted.headers?.get('vary') || ''),
      `Vary=${trusted.headers?.get('vary') || '(无)'}`);

    const evil = await reachable(`${lanBase}/api/platforms`, { headers: { Origin: 'http://evil.example.com' } });
    ok('外部网站的 Origin → 一个 CORS 头都不给', acao(evil) === '', `ACAO=${acao(evil) || '(无)'}`);
    ok('但请求本身还是 200（拦的是「读响应」，不是「发请求」）', evil.status === 200, `status=${evil.status}`);

    /*
     * 关键一条：局域网来的 POST 必须能真的干活，不只是"能打开首页"。
     * 手机点「开始对比」走的就是这个请求。
     */
    const post = await reachable(`${lanBase}/api/compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aRaw: '', bRaw: '' }),
    });
    ok('局域网 POST 能打到接口（参数不对但接口有回应）', post.status === 400,
      `status=${post.status} ${post.body?.slice(0, 70)}`);

    const form = await reachable(`${lanBase}/api/compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'aRaw=x&bRaw=y',
    });
    ok('表单形状的 POST 仍被 415 挡住', form.status === 415, `status=${form.status}`);

    const fakeHost = await spoofHost(PORT_ON, 'evil.example.com', PRIMARY);
    ok('陌生 Host 仍被 403', fakeHost.status === 403, `status=${fakeHost.status} ${fakeHost.body?.slice(0, 70)}`);

    /*
     * 每个候选地址都要能用：横幅里会把这些都列出来让用户"连不上就换一个"，
     * 如果它们不在 Host 白名单里，用户换个地址就吃 403 —— 那比不列还气人。
     */
    let allOk = true;
    const detail = [];
    for (const { address } of ranked) {
      if (address === PRIMARY) continue;
      const r = await reachable(`http://${address}:${PORT_ON}/api/health`);
      if (!(r.ok && r.status === 200)) allOk = false;
      detail.push(`${address}:${r.status ?? r.error}`);
    }
    ok('横幅里列出的其它地址也能用（不被 403 误伤）', allOk, detail.join(' / ') || '（只有一个地址）');

    const staticFile = await reachable(`${lanBase}/`);
    ok('首页静态文件也走局域网能取到', staticFile.ok && staticFile.status === 200
      && /<title>/.test(staticFile.body || ''), `status=${staticFile.status}`);

    const o = out();
    const printed = /"lan":\["http:\/\/([0-9.]+):/.exec(o);
    ok('--print-port 的 JSON 里带 lan 地址', !!printed, printed?.[1] || '(没抠到)');
    ok('服务器自己挑的首选地址 = 自检挑的那个', printed?.[1] === PRIMARY,
      `服务器=${printed?.[1]} 自检=${PRIMARY}`);
    ok('启动横幅里打印了手机该用的地址', o.includes(`http://${PRIMARY}:${PORT_ON}`), '');
  } finally {
    p.kill();
  }
}

/* ================= 启动器：编码与换行（这种事只能靠字节级检查，肉眼看不出来） ================= */
console.log('\n【3】「手机访问」启动器 —— 编码 / 换行');
{
  const gbk = new TextDecoder('gbk');
  const files = [
    { name: '手机访问.bat', crlf: true },
    { name: '手机访问.sh', crlf: false },
    { name: '手机访问.command', crlf: false },
  ];

  const missing = files.filter((f) => !fs.existsSync(path.join(ROOT, f.name)));
  ok('三个启动器都在源码根目录（clone 下来就能用）', missing.length === 0,
    missing.length ? missing.map((f) => f.name).join(' / ') : '三个都在');

  for (const { name, crlf } of files) {
    const p = path.join(ROOT, name);
    if (!fs.existsSync(p)) continue;
    const buf = fs.readFileSync(p);
    const raw = buf.toString('latin1');
    const crlfCount = (raw.match(/\r\n/g) || []).length;
    const bareLf = (raw.match(/(?<!\r)\n/g) || []).length;
    const hasBom = raw.charCodeAt(0) === 0xfeff || (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf);

    if (crlf) {
      /*
       * .bat 必须 GBK + CRLF：中文 Windows 控制台是 936 代码页，存 UTF-8 就是乱码；
       * 而 cmd 对纯 LF 的 .bat 会在跳到标签/循环时错行——这类错很难倒查。
       */
      ok(`${name} 是 CRLF（cmd 能正确执行）`, bareLf === 0 && crlfCount > 10, `CRLF=${crlfCount} 裸LF=${bareLf}`);
      ok(`${name} 没有 BOM（cmd 认不得 BOM）`, !hasBom, hasBom ? '有 BOM' : '无');
      const decoded = gbk.decode(buf);
      ok(`${name} 按 GBK 解出来是正常中文`, decoded.includes('手机访问') && !decoded.includes('\uFFFD'),
        decoded.split('\n')[0]?.trim());
      ok(`${name} 是 GBK 而不是 UTF-8（中文该有非 ASCII 字节）`, buf.some((b) => b > 0x7f),
        '含多字节字符');
    } else {
      /*
       * .sh 必须纯 LF：shebang 后面跟一个 CR，内核会去找一个叫 "sh\r" 的解释器，
       * 报 `env: sh\r: No such file or directory`——便携包第一次发出去就踩过这个。
       */
      ok(`${name} 是纯 LF（shebang 才能被内核认出来）`, crlfCount === 0, `CRLF=${crlfCount}`);
      ok(`${name} 第一行是可执行 shebang`, raw.startsWith('#!/bin/sh\n'), JSON.stringify(raw.split('\n')[0]));
    }
  }
}

console.log(`\n────────────────────────────────────────────────────`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log(fail === 0
  ? `手机可以试了：用 node server.mjs --lan 启动，然后手机浏览器打开 http://${PRIMARY}:${PORT_ON}\n`
  : `有失败项，先别看手机\n`);
process.exit(fail === 0 ? 0 : 1);