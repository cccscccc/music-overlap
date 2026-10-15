/**
 * 真机自检（新版界面）
 * 零依赖：系统 Edge headless + CDP + Node 22 内置 WebSocket / fetch
 *
 * 用法：先 node server.mjs 8787，然后
 *   node _dev/新界面自检.mjs           结果打印到 stdout
 * 建议后台跑并重定向： node _dev/新界面自检.mjs > _dev/自检记录_新界面.txt 2>&1
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const CDP_PORT = Number(process.env.CDP_PORT || 9333);

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 一边打屏一边攒一份，跑完落成 _dev/自检记录_新界面.txt（省得每次手动重定向）
const LOG_LINES = [];
const log = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  LOG_LINES.push(line);
  console.log(...a);
};

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass: !!pass, detail: String(detail) });
  log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
}

function findBrowser() {
  for (const p of EDGE_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('没找到 Edge / Chrome');
}

async function waitJson(url, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch { /* 继续等 */ }
    await sleep(300);
  }
  throw new Error(`CDP 未就绪：${url}`);
}

/* ── 最小 CDP 客户端 ── */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    this.logs = [];
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params?.exceptionDetails;
        this.errors.push(d?.exception?.description || d?.text || 'unknown exception');
      }
      if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params?.type)) {
        this.logs.push(`${msg.params.type}: ` + (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
      }
      if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
        this.errors.push('log: ' + msg.params.entry.text);
      }
    };
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('WebSocket 连接失败'));
    });
    return new CDP(ws);
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  }

  async waitFor(expression, timeout = 30000, label = expression) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (await this.eval(expression)) return true; } catch { /* 继续等 */ }
      await sleep(300);
    }
    throw new Error(`等待超时：${label}`);
  }

  async shot(file, opts = {}) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', ...opts });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
}

/* ── 主流程 ── */
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-check-'));
const browser = findBrowser();
log('浏览器：', browser);
log('服务：  ', BASE, '\n');

const proc = spawn(browser, [
  '--headless=new',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${userDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--disable-extensions',
  '--mute-audio',
  '--autoplay-policy=no-user-gesture-required',
  '--window-size=1400,1000',
  'about:blank',
], { stdio: 'ignore' });

let cdp = null;
let exitCode = 0;

try {
  const targets = await waitJson(`http://127.0.0.1:${CDP_PORT}/json`);
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('没有可用的 page target');
  cdp = await CDP.connect(page.webSocketDebuggerUrl);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false,
  });

  const resp = await fetch(BASE + '/api/health').catch(() => null);
  if (!resp || !resp.ok) throw new Error(`本地服务没起来（${BASE}/api/health 不通）`);

  log('══ 1. 页面加载 ══');
  await cdp.send('Page.navigate', { url: BASE });
  await cdp.waitFor('document.readyState === "complete"', 20000, '页面加载完成');
  await sleep(600);

  const basic = await cdp.eval(`JSON.stringify({
    title: document.title,
    hasIconDefs: !!document.querySelector('#ic-play') && !!document.querySelector('#ic-grid-lg'),
    viewBtns: document.querySelectorAll('#viewSwitch button').length,
    playerHidden: !document.querySelector('#player').classList.contains('show'),
    resultHidden: document.getElementById('result').classList.contains('hidden'),
    wave: !!document.querySelector('.ground path')
  })`);
  const b = JSON.parse(basic);
  check('页面标题', b.title.includes('重合度'), b.title);
  check('图标已定义（非 emoji）', b.hasIconDefs);
  check('视图切换有 4 个按钮', b.viewBtns === 4, `${b.viewBtns} 个`);
  check('播放器初始收起', b.playerHidden);
  check('结果区初始隐藏', b.resultHidden);
  check('背景声波已渲染', b.wave);
  await cdp.shot(path.join(__dirname, 'shot-1-首屏.png'));

  log('\n══ 2. 对比流程 ══');
  await cdp.eval(`document.getElementById('demoBtn').click(); 1`);
  await cdp.eval(`document.getElementById('runBtn').click(); 1`);
  await cdp.waitFor(`!document.getElementById('result').classList.contains('hidden')`, 90000, '拿到对比结果');
  await sleep(900);

  const res = JSON.parse(await cdp.eval(`(() => {
    const q = (s) => document.querySelector(s);
    const cover = q('#songList .s-art img');
    return JSON.stringify({
      nameA: q('#nameA').textContent.trim(),
      nameB: q('#nameB').textContent.trim(),
      listA: q('#listA').textContent.trim(),
      avaA: q('#avatarA').getAttribute('src') || '',
      avaB: q('#avatarB').getAttribute('src') || '',
      big: q('#bigNum').textContent.trim(),
      stats: q('#stats').innerText.replace(/\\s+/g, ' ').trim(),
      rows: q('#songList').children.length,
      firstCover: cover ? (cover.getAttribute('src') || '') : '',
      firstCoverLoaded: cover ? (cover.complete && cover.naturalWidth > 0) : false,
      firstTitle: q('#songList .s-name').textContent.trim(),
      firstMeta: q('#songList .s-meta').innerText.replace(/\\s+/g, ' ').trim(),
      staggered: !!q('#songList .song[style*="--d"]'),
      sectionReveal: document.querySelectorAll('.reveal').length,
      title: q('#songListTitle').textContent.trim()
    });
  })()`));

  check('左边昵称', !!res.nameA && res.nameA !== '—', res.nameA);
  check('右边昵称', !!res.nameB && res.nameB !== '—', res.nameB);
  check('左边头像地址', /^https?:\/\//.test(res.avaA), res.avaA.slice(0, 58));
  check('右边头像地址', /^https?:\/\//.test(res.avaB), res.avaB.slice(0, 58));
  const ava = JSON.parse(await cdp.eval(`(() => {
    const a = document.getElementById('avatarA'), b = document.getElementById('avatarB');
    return JSON.stringify({
      a: a.complete && a.naturalWidth > 0,
      b: b.complete && b.naturalWidth > 0,
      broken: a.parentElement.classList.contains('broken') || b.parentElement.classList.contains('broken')
    });
  })()`));
  check('两张头像都真的加载出来了（不是占位）', ava.a && ava.b && !ava.broken,
    `A=${ava.a ? '已加载' : '失败'} / B=${ava.b ? '已加载' : '失败'}`);
  check('共同歌曲数字', Number(res.big.replace(/,/g, '')) > 0, res.big);
  check('合并后的摘要条', /重合度/.test(res.stats) && /整体相似度/.test(res.stats) && /口径/.test(res.stats), res.stats.slice(0, 96));
  check('摘要已并进同一张卡（不再有独立的第二块数据带）',
    await cdp.eval(`!!document.querySelector('.merge-card #stats') && !document.querySelector('main > .datastrip')`));
  check('歌曲行数 > 0', res.rows > 0, `${res.rows} 行`);
  check('歌曲封面地址', /^https?:\/\//.test(res.firstCover), res.firstCover.slice(0, 58));
  check('封面图真的加载出来了', res.firstCoverLoaded, res.firstTitle);
  check('列表错峰延迟已注入', res.staggered);
  check('区块渐进显示已挂载', res.sectionReveal >= 2, `${res.sectionReveal} 个区块`);
  check('列表标题', !!res.title, res.title);
  await cdp.shot(path.join(__dirname, 'shot-2-结果.png'));

  log('\n══ 3. 视图切换 ══');
  for (const v of ['sm', 'md', 'lg', 'list']) {
    await cdp.eval(`document.querySelector('#viewSwitch button[data-view="${v}"]').click(); 1`);
    await sleep(450);
    const st = JSON.parse(await cdp.eval(`(() => {
      const ul = document.getElementById('songList');
      const li = ul.querySelector('.song');
      const art = li.querySelector('.s-art');
      const img = art.querySelector('img');
      const cs = getComputedStyle(ul);
      return JSON.stringify({
        cls: ul.className,
        cols: cs.gridTemplateColumns.split(' ').length,
        artW: Math.round(art.getBoundingClientRect().width),
        pressed: document.querySelector('#viewSwitch button[aria-pressed="true"]').dataset.view,
        imgOk: img ? (img.complete && img.naturalWidth > 0) : false
      });
    })()`));
    check(`切到「${v}」视图`, st.cls === `songs view-${v}` && st.pressed === v, `${st.cls} / ${st.cols} 列 / 封面 ${st.artW}px`);
    if (v === 'md') await cdp.shot(path.join(__dirname, 'shot-3-中图标.png'));
    if (v === 'lg') await cdp.shot(path.join(__dirname, 'shot-4-大图标.png'));
  }

  log('\n══ 4. 播放器（要求：一个按钮都不点，自己起播）══');
  await cdp.waitFor(`document.getElementById('player').classList.contains('show')`, 45000, '播放器自动弹出');
  await sleep(1000);
  const p1 = JSON.parse(await cdp.eval(`(() => {
    const a = document.getElementById('audio');
    return JSON.stringify({
      shown: document.getElementById('player').classList.contains('show'),
      name: document.getElementById('pName').textContent.trim(),
      artist: document.getElementById('pArtist').textContent.trim(),
      src: a.getAttribute('src') || '',
      paused: a.paused,
      cover: document.getElementById('pCover').getAttribute('src') || '',
      count: document.getElementById('pCount').textContent.trim(),
      playingRow: !!document.querySelector('#songList .song.playing'),
      iconPause: document.querySelector('#pPlay use').getAttribute('href')
    });
  })()`));
  const waitIcon = async (want) => {
    for (let i = 0; i < 12; i += 1) {
      if ((await cdp.eval(`document.querySelector('#pPlay use').getAttribute('href')`)) === want) return true;
      await sleep(250);
    }
    return false;
  };
  check('播放器已弹出', p1.shown);
  check('播放器显示歌名', !!p1.name, `${p1.name} — ${p1.artist}`);
  check('音频源指向本地代理（按平台的路由）', /^\/api\/audio\?platform=[a-z]+&sid=/.test(p1.src), p1.src);
  check('播放器封面有地址', /^https?:\/\//.test(p1.cover));
  check('播放器计数', /第 \d+ \/ \d+ 首/.test(p1.count), p1.count);
  check('列表高亮当前行', p1.playingRow);
  /*
   * 按钮图标要轮询：某些曲子（比如前面那两首故意设成 VIP 的）会被跳过，
   * 跳的过程中图标本来就是播放态。原来这里立刻断言图标是 #ic-pause，遇到跳歌就红。
   */
  check('按钮切到暂停态', await waitIcon('#ic-pause'), p1.iconPause);

  /*
   * 等音频真的动起来，但也接受「应用自己判定这首放不出来、已如实跳走」。
   *
   * 为什么不写死 sleep：第一包要等网络/解码，偶尔就是会超过两秒。原来固定 sleep(2600)
   * 再断言 currentTime > 0.3，遇到首包慢的那次就红——而那是测试脆弱，不是程序坏了。
   * 多平台自检早就改成了轮询（并且认「已跳走」），这里跟上，两个脚本口径一致。
   */
  let p2 = null;
  const toastBefore = await cdp.eval(`(document.querySelector('.toast') || {}).textContent || ''`);
  for (let i = 0; i < 24; i += 1) {
    p2 = JSON.parse(await cdp.eval(`(() => {
      const a = document.getElementById('audio');
      return JSON.stringify({
        currentTime: a.currentTime,
        duration: a.duration,
        fillW: document.getElementById('pFill').style.width,
        cur: document.getElementById('pCur').textContent,
        dur: document.getElementById('pDur').textContent,
        paused: a.paused,
        readyState: a.readyState,
        toast: (document.querySelector('.toast') || {}).textContent || ''
      });
    })()`));
    const freshSkip = p2.toast !== toastBefore && /跳到下一首|也没出声/.test(p2.toast);
    if (p2.currentTime > 0.3 || freshSkip) break;
    await sleep(450);
  }
  const skipped = p2.toast !== toastBefore && /跳到下一首|也没出声/.test(p2.toast);
  check('音频真的在走（或应用已如实跳走，而不是卡住）',
    p2.currentTime > 0.3 || skipped,
    p2.currentTime > 0.3
      ? `${p2.currentTime.toFixed(2)}s / 时长 ${Number(p2.duration || 0).toFixed(0)}s`
      : `未出声但已跳歌：${p2.toast}`);
  // 进度条只在真的出声时有意义；已经跳走的情况下它本来就该是 0
  check('进度条与时间在动', skipped ? true : (p2.fillW !== '' && p2.fillW !== '0%'),
    `${p2.fillW} · ${p2.cur} / ${p2.dur}`);
  check('音频已开始播放（未暂停）', !p2.paused, `readyState=${p2.readyState}`);
  await cdp.shot(path.join(__dirname, 'shot-5-播放中.png'));

  log('\n══ 5. 播放控制 ══');
  const nameBefore = p1.name;
  await cdp.eval(`document.getElementById('pNext').click(); 1`);
  await sleep(1600);
  const afterNext = JSON.parse(await cdp.eval(`JSON.stringify({
    name: document.getElementById('pName').textContent.trim(),
    playingRow: !!document.querySelector('#songList .song.playing'),
    idx: (document.querySelector('#songList .song.playing')||{dataset:{}}).dataset.i
  })`));
  check('下一首切歌生效', afterNext.name !== nameBefore || afterNext.idx !== undefined, `${nameBefore} → ${afterNext.name}`);

  /*
   * 暂停/继续各轮询一段时间再断言。
   * 音频还没拿到数据时，pause() 之后 paused 可能立刻又被浏览器的 play() 拉回 false，
   * 固定 sleep(600) 偶尔会读到中间态。轮询到「稳定」就稳了。
   */
  const waitPaused = async (want) => {
    for (let i = 0; i < 12; i += 1) {
      if ((await cdp.eval(`document.getElementById('audio').paused`)) === want) return true;
      await sleep(250);
    }
    return false;
  };
  await cdp.eval(`document.getElementById('pPlay').click(); 1`);
  check('暂停按钮生效', await waitPaused(true));
  await cdp.eval(`document.getElementById('pPlay').click(); 1`);
  check('再次播放生效', await waitPaused(false));

  log('\n══ 6. 不可播曲目处理 ══');
  const note = await cdp.eval(`document.getElementById('playNote').textContent.trim()`);
  const unplayable = await cdp.eval(`document.querySelectorAll('#songList .song.unplayable').length`);
  const flags = await cdp.eval(`document.querySelectorAll('#songList .s-flag').length`);
  check('已统计可直接播放的数量', /直接播放|全部可以|暂时都放不出来|没能确认/.test(note), note);
  check('不可播曲目标记完整', unplayable === flags, `${unplayable} 行受限 / ${flags} 个标记`);
  const coverOpacity = await cdp.eval(`(() => {
    const img = document.querySelector('#songList .song.unplayable .s-art img');
    return img ? getComputedStyle(img).opacity : 'none';
  })()`);
  check('受限曲目的封面保持原色（不灰化）', Number(coverOpacity) === 1, `opacity=${coverOpacity}`);

  log('\n══ 7. 搜索过滤 ══');
  await cdp.eval(`(() => { const f = document.getElementById('filter'); f.value = 'a'; f.dispatchEvent(new Event('input', {bubbles:true})); return 1; })()`);
  await sleep(500);
  const filtered = await cdp.eval(`document.getElementById('listCount').textContent.trim()`);
  check('过滤后计数变为 x / 全部', /\(\d+ \/ \d+\)/.test(filtered), filtered);
  await cdp.eval(`(() => { const f = document.getElementById('filter'); f.value = ''; f.dispatchEvent(new Event('input', {bubbles:true})); return 1; })()`);
  await sleep(400);

  log('\n══ 8. 控制台与异常 ══');
  const realErrors = cdp.errors.filter((e) => !/favicon|net::ERR|404 \\(Not Found\\)/i.test(e));
  check('没有 JS 运行时异常', realErrors.length === 0, realErrors.slice(0, 3).join(' | ') || '无');
  const warnCount = cdp.logs.filter((l) => l.startsWith('error')).length;
  check('没有 console.error', warnCount === 0, cdp.logs.filter((l) => l.startsWith('error')).slice(0, 3).join(' | ') || '无');

} catch (err) {
  log('\n💥 自检中断：', err.message);
  exitCode = 1;
} finally {
  try { proc.kill(); } catch { /* 忽略 */ }
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
log('\n' + '═'.repeat(50));
log(`  自检结果：${pass} 项通过 / ${fail} 项失败  （共 ${results.length} 项）`);
if (fail) {
  log('  失败项：');
  results.filter((r) => !r.pass).forEach((r) => log(`    · ${r.name}  ${r.detail}`));
  exitCode = 1;
}
log('═'.repeat(50));
fs.writeFileSync(path.join(__dirname, '自检结果_新界面.json'), JSON.stringify(results, null, 2));
fs.writeFileSync(
  path.join(__dirname, '自检记录_新界面.txt'),
  LOG_LINES.join('\n') + '\n',
  'utf8'
);
process.exit(exitCode);
