/**
 * 真机自检：用系统自带的 Edge（或 Chrome）无头模式打开页面，
 * 真实点击「填入示例」→「开始对比」→ 搜索过滤 → 宽松口径重跑，
 * 读取页面渲染结果并截图。零依赖，用 Node 22+ 内置的 WebSocket 直连 CDP。
 *
 * 用法：先启动服务（node server.mjs），再
 *       node "_dev/真机自检.mjs" [http://127.0.0.1:8787/]
 * 产出：_dev/page.png
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROWSER_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];
const EDGE = BROWSER_CANDIDATES.find((p) => fs.existsSync(p));
if (!EDGE) {
  console.error('没有找到 Edge 或 Chrome，无法做真机自检。');
  process.exit(1);
}
const URL_TARGET = process.argv[2] || 'http://127.0.0.1:8787/';
const CDP_PORT = 9333;
const profile = path.join(os.tmpdir(), `edge-e2e-${Date.now()}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const child = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      '--window-size=1280,1800',
      URL_TARGET,
    ],
    { stdio: 'ignore', detached: false }
  );

  let targets = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) {
        targets = page;
        break;
      }
    } catch {
      /* 还没起来 */
    }
  }
  if (!targets) throw new Error('连不上 Edge 调试端口');

  const ws = new WebSocket(targets.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = (e) => rej(new Error('WebSocket 连接失败: ' + e.message));
  });

  let msgId = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  };

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 120000);
    });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 1700,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error('页面抛异常：' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  };

  // 等页面脚本就绪
  await sleep(1200);

  const step1 = await evaluate(`(() => {
    return JSON.stringify({
      title: document.title,
      hasAppJs: typeof window.parseLink === 'function' || !!document.getElementById('runBtn'),
      hintA0: document.getElementById('hintA').textContent,
      initialResultHidden: document.getElementById('result').classList.contains('hidden')
    });
  })()`);

  const step2 = await evaluate(`(async () => {
    const errs = [];
    window.addEventListener('error', e => errs.push('window.onerror: ' + e.message));
    try {
      document.getElementById('demoBtn').click();
      await new Promise(r => setTimeout(r, 200));
      const filledA = document.getElementById('inputA').value;
      const hint = document.getElementById('hintA').textContent;
      document.getElementById('runBtn').click();

      const t0 = Date.now();
      let phase = 'waiting';
      while (Date.now() - t0 < 90000) {
        const st = document.getElementById('status');
        if (st.classList.contains('err')) { phase = 'error:' + st.textContent; break; }
        if (!document.getElementById('result').classList.contains('hidden')) { phase = 'done'; break; }
        await new Promise(r => setTimeout(r, 250));
      }
      await new Promise(r => setTimeout(r, 1600));

      return JSON.stringify({
        phase,
        filledA,
        hint,
        bigNum: document.getElementById('bigNum').textContent,
        heroSub: document.getElementById('heroSub').textContent,
        ratioCaption: document.getElementById('ratioCaption').textContent,
        stats: [...document.querySelectorAll('.stat')].map(s =>
          s.querySelector('.k').textContent.trim() + ' = ' + s.querySelector('.v').textContent.trim() + ' (' + s.querySelector('.s').textContent.trim() + ')'),
        songRows: document.querySelectorAll('#songList li').length,
        listCount: document.getElementById('listCount').textContent,
        firstSongs: [...document.querySelectorAll('#songList li')].slice(0,3).map(li =>
          li.querySelector('.title a').textContent + ' - ' + li.querySelector('.meta').textContent),
        variantHidden: document.getElementById('variantCard').classList.contains('hidden'),
        elapseText: document.getElementById('status').textContent,
        errs
      });
    } catch (e) {
      return JSON.stringify({ fatal: String(e && e.message || e), errs });
    }
  })()`);

  // 过滤功能
  const step3 = await evaluate(`(async () => {
    const before = document.querySelectorAll('#songList li').length;
    const kw = document.querySelector('#songList li .title a')?.textContent.slice(0,2) || '';
    const f = document.getElementById('filter');
    f.value = kw;
    f.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 150));
    const after = document.querySelectorAll('#songList li').length;
    f.value = '';
    f.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 150));
    const restored = document.querySelectorAll('#songList li').length;
    return JSON.stringify({ keyword: kw, before, after, restored, listCount: document.getElementById('listCount').textContent });
  })()`);

  // 宽松口径：勾上开关重跑，验证变体列表渲染
  const step4 = await evaluate(`(async () => {
    try {
      const cb = document.getElementById('loose');
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('runBtn').click();
      const t0 = Date.now();
      let phase = 'waiting';
      while (Date.now() - t0 < 120000) {
        const st = document.getElementById('status');
        if (st.classList.contains('err')) { phase = 'error:' + st.textContent; break; }
        const done = !document.getElementById('result').classList.contains('hidden')
          && !document.getElementById('variantCard').classList.contains('hidden');
        if (done) { phase = 'done'; break; }
        await new Promise(r => setTimeout(r, 300));
      }
      await new Promise(r => setTimeout(r, 1600));
      return JSON.stringify({
        phase,
        bigNum: document.getElementById('bigNum').textContent,
        heroSub: document.getElementById('heroSub').textContent,
        variantRows: document.querySelectorAll('#variantList li').length,
        variantCount: document.getElementById('variantCount').textContent,
        listTitle: document.getElementById('songListTitle').textContent,
        firstVariant: (document.querySelector('#variantList li')?.textContent || '').replace(/\\s+/g,' ').trim().slice(0, 130),
        statValues: [...document.querySelectorAll('.stat')].map(s => s.querySelector('.v').textContent)
      });
    } catch (e) { return JSON.stringify({ fatal: String(e && e.message || e) }); }
  })()`);

  // 截图
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const shotPath = path.join(__dirname, 'page.png');
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));

  // 收集控制台错误
  const consoleErrs = events
    .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error'))
    .map((e) => e.params?.exceptionDetails?.text || e.params?.entry?.text);

  console.log('===== 1. 页面加载 =====');
  console.log(step1);
  console.log('===== 2. 点击流程 =====');
  console.log(step2);
  console.log('===== 3. 搜索过滤 =====');
  console.log(step3);
  console.log('===== 4. 宽松口径（勾选后重跑） =====');
  console.log(step4);
  console.log('===== 5. 浏览器控制台错误 =====');
  console.log(consoleErrs.length ? JSON.stringify(consoleErrs, null, 2) : '（无）');
  console.log('===== 截图 =====');
  console.log(shotPath);

  ws.close();
  child.kill();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

main().catch((e) => {
  console.error('验证失败：', e.message);
  process.exit(1);
});
