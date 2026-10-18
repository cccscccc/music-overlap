/*
 * 手机端布局回归：在 390×844 的视口下量几何，钉住「手机上不难看」的几条硬指标。
 *
 *   node _dev/mobile-check.mjs http://127.0.0.1:8899
 *
 * 为什么值得单独一条：桌面宽 1400px 时这些毛病全被藏住了 —— 三列有余量、
 * 列表高度够、输入框字号够大。窄屏的问题只有真的按窄屏渲染才看得见，
 * 而且极容易在「改桌面样式」时被顺手改回去。所以量成断言，改坏了立刻红。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || process.env.BASE || 'http://127.0.0.1:8899';
const CDP_PORT = Number(process.env.CDP_PORT || 9377);
const W = 390;
const H = 844;

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));
if (!EDGE) {
  console.error('没找到 Edge / Chrome');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass: !!pass, detail: String(detail) });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
};

async function waitJson(url, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch { /* 等 */ }
    await sleep(250);
  }
  throw new Error(`CDP 未就绪：${url}`);
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WS 失败')); });
    return new CDP(ws);
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && this.pending.has(m.id)) {
          const p = this.pending.get(m.id); this.pending.delete(m.id);
          m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
        }
      };
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async waitFor(expr, timeout = 60000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (await this.eval(expr)) return true; } catch { /* 等 */ }
      await sleep(300);
    }
    return false;
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }
}

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-mobile-check-'));
const proc = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDir}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions',
  '--mute-audio', '--autoplay-policy=no-user-gesture-required', `--window-size=${W},${H}`, 'about:blank',
], { stdio: 'ignore' });

let code = 0;
try {
  const targets = await waitJson(`http://127.0.0.1:${CDP_PORT}/json`);
  const cdp = await CDP.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
  });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });

  await cdp.send('Page.navigate', { url: BASE });
  await cdp.waitFor('document.readyState === "complete"', 20000);
  await sleep(900);

  console.log('\n【1】首屏');
  const landing = JSON.parse(await cdp.eval(`(() => {
    const d = document.documentElement;
    const btns = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null)
      .map((b) => ({ inPlayer: !!b.closest('.player'), h: b.getBoundingClientRect().height }));
    // 内容区的按钮要够手指点；播放器里是密集图标按钮，门槛放到 32px
    const small = btns.filter((b) => b.h < (b.inPlayer ? 32 : 40)).length;
    const inputs = [...document.querySelectorAll('input[type=text], input:not([type])')].filter((i) => i.offsetParent !== null);
    return JSON.stringify({
      vw: d.clientWidth, sw: d.scrollWidth,
      overflow: d.scrollWidth > d.clientWidth + 1,
      btns: btns.length, smallBtns: small,
      smallDetail: btns.filter((b) => b.h < (b.inPlayer ? 32 : 40)).map((b) => Math.round(b.h)).join(','),
      inputFontSize: inputs.length ? getComputedStyle(inputs[0]).fontSize : '',
      inputHeight: inputs.length ? Math.round(inputs[0].getBoundingClientRect().height) : 0,
    });
  })()`));
  check('视口确实是 390 宽（测量前提）', landing.vw === W, `${landing.vw}px`);
  check('首屏没有横向溢出', !landing.overflow, `scrollWidth=${landing.sw}`);
  check('输入框字号 ≥16px（否则 iOS 聚焦会放大整页）',
    parseFloat(landing.inputFontSize) >= 16, landing.inputFontSize);
  check('输入框高度 ≥44px（好点）', landing.inputHeight >= 44, `${landing.inputHeight}px`);
  check('可见按钮都够手指点（内容区 ≥40px、播放器 ≥32px）',
    landing.smallBtns === 0, `${landing.smallBtns}/${landing.btns} 个偏小 ${landing.smallDetail || ''}`);

  console.log('\n【2】结果页');
  await cdp.eval(`document.getElementById('demoBtn').click(); 1`);
  await sleep(400);
  await cdp.eval(`document.getElementById('runBtn').click(); 1`);
  const ok = await cdp.waitFor(`!document.getElementById('result').classList.contains('hidden')`);
  check('能拿到对比结果', ok);

  const r = JSON.parse(await cdp.eval(`(() => {
    const d = document.documentElement;
    const rect = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom }; };
    const collide = (a, b) => {
      if (!a || !b) return false;
      const ox = Math.min(a.right, b.right) - Math.max(a.x, b.x);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
      return ox > 1 && oy > 1;
    };
    const nameA = rect('.who-a .who-name'), nameB = rect('.who-b .who-name'), core = rect('.merge-core');
    const songs = document.querySelector('.songs');
    const player = rect('.player');
    return JSON.stringify({
      overflow: d.scrollWidth > d.clientWidth + 1,
      scrollW: d.scrollWidth,
      collideA: collide(nameA, core),
      collideB: collide(nameB, core),
      songsOverflowY: songs ? getComputedStyle(songs).overflowY : '',
      songsMaxH: songs ? getComputedStyle(songs).maxHeight : '',
      playerH: player ? Math.round(player.h) : 0,
      vh: d.clientHeight,
    });
  })()`));

  check('结果页没有横向溢出', !r.overflow, `scrollWidth=${r.scrollW}`);
  check('左昵称与中间大数字不重叠', !r.collideA);
  check('右昵称与中间大数字不重叠', !r.collideB);
  check('歌曲列表跟着页面滚（没有内层滚动框）',
    r.songsOverflowY === 'visible' && r.songsMaxH === 'none', `overflow-y=${r.songsOverflowY} max-height=${r.songsMaxH}`);
  check('播放器不超过视口 1/6（别太吃屏）',
    r.playerH <= Math.round(r.vh / 6), `${r.playerH}px / ${r.vh}px`);

  await cdp.shot(path.join(HERE, 'shot-mobile-result.png'));
} catch (e) {
  console.error('出错：', e.message);
  code = 1;
} finally {
  try { proc.kill(); } catch { /* 忽略 */ }
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

const pass = results.filter((x) => x.pass).length;
const fail = results.length - pass;
console.log(`\n──────────────────────────────────────────`);
console.log(`  自检结果：${pass} 项通过 / ${fail} 项失败 （共 ${results.length} 项）`);
if (fail) { console.log('  失败项：'); results.filter((x) => !x.pass).forEach((x) => console.log(`    · ${x.name}  ${x.detail}`)); code = 1; }
console.log(`──────────────────────────────────────────`);
fs.writeFileSync(path.join(HERE, '自检结果_手机.json'), JSON.stringify(results, null, 2));
process.exit(code);
