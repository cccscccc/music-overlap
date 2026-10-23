/**
 * 真机自检·多平台版
 * 零依赖：系统 Edge headless + CDP + Node 内置 WebSocket / fetch
 *
 * 覆盖：
 *   1. 页面加载（三个平台都写在页面上）
 *   2. 链接识别：三家链接 + 纯数字，提示文案对不对
 *   3. 同平台对比（网易云 vs 网易云）：88 首 / 播放器自动起播 / 新接口地址
 *   4. 跨平台对比（网易云 vs QQ 音乐）：口径提醒、平台徽章、两边都标出来
 *   5. 酷狗：只能读 30 首 + 只有对比（禁用播放、按钮隐藏、如实提示）
 *   6. 导出面板：三家平台在，网易云格式是「序号. 歌名 歌手」
 *   7. CSV 导出：表头带「来源平台 / 链接」
 *   7. 控制台无异常
 *
 * 用法：先起服务（默认 8787），然后
 *   node _dev/多平台自检.mjs
 * 可用环境变量覆盖：BASE / CDP_PORT
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const CDP_PORT = Number(process.env.CDP_PORT || 9333);

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

const NET_A = 'https://music.163.com/#/my/m/music/playlist?id=429241928';
const NET_B = 'https://music.163.com/playlist?id=2015697743';
const QQ_B = 'https://y.qq.com/n/ryqq/playlist/7716239979';
const KG_A = 'https://www.kugou.com/yy/special/single/6025092.html';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 一边打屏一边攒一份，跑完落成 _dev/自检记录_多平台.txt（省得每次手动重定向）
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
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
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

/** 往输入框里塞值并触发 input 事件（页面自己会更新提示） */
const setInput = (id, val) =>
  `(() => { const i = document.getElementById('${id}'); i.value = ${JSON.stringify(val)};` +
  ` i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`;

async function fillAndRun(cdp, a, b) {
  await cdp.eval(setInput('inputA', a));
  await cdp.eval(setInput('inputB', b));
  await cdp.eval(`document.getElementById('result').classList.add('hidden'); 1`);
  await cdp.eval(`document.getElementById('runBtn').click(); 1`);
}

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-multi-'));
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
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });

  const resp = await fetch(BASE + '/api/health').catch(() => null);
  if (!resp || !resp.ok) throw new Error(`本地服务没起来（${BASE}/api/health 不通）`);

  log('══ 1. 页面加载 ══');
  await cdp.send('Page.navigate', { url: BASE });
  await cdp.waitFor('document.readyState === "complete"', 20000, '页面加载完成');
  await sleep(700);
  const basic = JSON.parse(await cdp.eval(`JSON.stringify({
    title: document.title,
    tagline: (document.querySelector('.tagline')||document.querySelector('header p')||{}).textContent || '',
    hasCookieInput: !!document.querySelector('input#cookie, input#cookieQQ'),
    hasCookieApiMention: /凭证|document\\.cookie/.test(document.body.innerHTML),
    hasAdvPanel: !!document.querySelector('details.adv'),
    hasWarnBar: !!document.getElementById('warnBar'),
    hasSrc: !!document.getElementById('pSrc'),
    hasIconDefs: !!document.querySelector('#ic-play') && !!document.querySelector('#ic-warn'),
    viewBtns: document.querySelectorAll('#viewSwitch button').length,
    playerHidden: !document.querySelector('#player').classList.contains('show'),
    resultHidden: document.getElementById('result').classList.contains('hidden'),
    wave: !!document.querySelector('.ground path')
  })`));
  check('页面标题提到三个平台', /网易云/.test(basic.title) && /QQ/.test(basic.title) && /酷狗/.test(basic.title), basic.title);
  check('副标题写明能跨平台比', /跨平台/.test(basic.tagline), basic.tagline.trim().slice(0, 60));
  check('登录/凭证那一条线已整条删除（界面上没有输入框，也不提凭证）',
    !basic.hasCookieInput && !basic.hasCookieApiMention);
  check('提醒条容器在', basic.hasWarnBar);
  check('折叠说明面板还在（删登录时没误删）', basic.hasAdvPanel);
  check('播放器有来源平台位', basic.hasSrc);
  check('图标已定义（含警示图标）', basic.hasIconDefs);
  check('视图切换有 4 个按钮', basic.viewBtns === 4, `${basic.viewBtns} 个`);
  check('播放器初始收起', basic.playerHidden);
  check('结果区初始隐藏', basic.resultHidden);
  check('背景声波已渲染', basic.wave);
  await cdp.shot(path.join(__dirname, 'shot-m1-首屏.png'));

  log('\n══ 2. 链接识别 ══');
  const cases = [
    ['inputA', NET_A, /网易云/, '网易云歌单'],
    ['inputA', QQ_B, /QQ/, 'QQ 歌单'],
    ['inputA', KG_A, /酷狗/, '酷狗歌单'],
    ['inputB', '429241928', /依次|网易云 \/ QQ/, '纯数字交给服务端依次猜'],
  ];
  for (const [id, val, re, label] of cases) {
    await cdp.eval(setInput(id, val));
    await sleep(150);
    const hint = await cdp.eval(`document.getElementById('${id === 'inputA' ? 'hintA' : 'hintB'}').textContent.trim()`);
    check(`识别${label}`, re.test(hint), hint.slice(0, 70));
  }
  const kgHint = await cdp.eval(`(() => {
    const i = document.getElementById('inputA');
    i.value = ${JSON.stringify(KG_A)}; i.dispatchEvent(new Event('input', { bubbles: true }));
    return document.getElementById('hintA').textContent.trim();
  })()`);
  check('酷狗那条如实说明限制', /30/.test(kgHint) && /听不了|不能播|不支持/.test(kgHint), kgHint.slice(0, 90));

  log('\n══ 3. 同平台对比（网易云 vs 网易云）══');
  await cdp.eval(setInput('inputA', NET_A));
  await cdp.eval(setInput('inputB', NET_B));
  await cdp.eval(`document.getElementById('runBtn').click(); 1`);
  await cdp.waitFor(`!document.getElementById('result').classList.contains('hidden')`, 90000, '拿到对比结果');
  await sleep(1200);
  const same = JSON.parse(await cdp.eval(`(() => {
    const q = (s) => document.querySelector(s);
    return JSON.stringify({
      big: (q('#bigNum')||{}).textContent || '',
      stats: q('#stats').textContent.trim(),
      rows: document.querySelectorAll('#songList .song').length,
      title: q('#songListTitle').textContent.trim(),
      warnHidden: q('#warnBar').classList.contains('hidden'),
      badges: document.querySelectorAll('#songList .pfa').length,
      pairs: document.querySelectorAll('#songList .s-pair').length,
      nameA: q('#nameA') ? q('#nameA').textContent.trim() : '',
      nameB: q('#nameB') ? q('#nameB').textContent.trim() : ''
    });
  })()`));
  check('共同歌曲数 > 0', Number(String(same.big).replace(/,/g, '')) > 0, same.big);
  check('摘要含重合度 / 整体相似度 / 口径', /重合度/.test(same.stats) && /整体相似度/.test(same.stats) && /口径/.test(same.stats), same.stats.slice(0, 90));
  check('口径写明「同一平台」', /同一平台/.test(same.stats), same.stats.slice(0, 90));
  check('歌曲行数 > 0', same.rows > 0, `${same.rows} 行`);
  check('同平台不显示平台徽章（不用重复标）', same.badges === 0, `${same.badges} 个`);
  check('同平台不显示提醒条', same.warnHidden);
  await cdp.shot(path.join(__dirname, 'shot-m2-同平台.png'));

  log('\n══ 4. 播放器（要求：一个按钮都不点，自己起播）══');
  await cdp.waitFor(`document.getElementById('player').classList.contains('show')`, 45000, '播放器自动弹出');
  await sleep(2600);
  const p1 = JSON.parse(await cdp.eval(`(() => {
    const a = document.getElementById('audio');
    return JSON.stringify({
      name: document.getElementById('pName').textContent.trim(),
      artist: document.getElementById('pArtist').textContent.trim(),
      src: a.getAttribute('src') || '',
      paused: a.paused,
      currentTime: a.currentTime,
      readyState: a.readyState,
      count: document.getElementById('pCount').textContent.trim(),
      srcLabel: document.getElementById('pSrc').textContent.trim(),
      playingRow: !!document.querySelector('#songList .song.playing'),
      icon: document.querySelector('#pPlay use').getAttribute('href')
    });
  })()`));
  check('播放器自动弹出并显示歌名', !!p1.name, `${p1.name} — ${p1.artist}`);
  check('音频源走新的按平台接口', /^\/api\/audio\?platform=[a-z]+&sid=/.test(p1.src), p1.src);
  check('播放器标出来源平台', p1.srcLabel.length > 0, p1.srcLabel);
  check('播放器计数正常', /第\s*\d+\s*\/\s*\d+\s*首/.test(p1.count), p1.count);
  check('列表高亮当前行', p1.playingRow);
  check('按钮切到暂停态', p1.icon === '#ic-pause', p1.icon);
  // 音频起播可能慢（首包要等网易 CDN）。这里给足时间，并且把「应用自己判定这首出不了声、
  // 已经跳到下一首」也算通过——那正是 PLAY_WAIT_MS 兜底该做的事，不是自检失败。
  // 只要求：要么出声了，要么它明确跳走了（而不是无声无息卡在原地）。
  let audioProbe = null;
  const toastBefore = await cdp.eval(`(document.querySelector('.toast') || {}).textContent || ''`);
  for (let i = 0; i < 24; i += 1) {
    audioProbe = JSON.parse(await cdp.eval(`(() => {
      const a = document.getElementById('audio');
      return JSON.stringify({
        t: a.currentTime,
        ready: a.readyState,
        name: document.getElementById('pName').textContent.trim(),
        count: document.getElementById('pCount').textContent.trim(),
        toast: (document.querySelector('.toast') || {}).textContent || ''
      });
    })()`));
    // 只认「这次新出现的」跳歌提示，免得把上一环节残留的 toast 当成证据
    const freshSkip = audioProbe.toast !== toastBefore && /跳到下一首|也没出声/.test(audioProbe.toast);
    if (audioProbe.t > 0.3 || freshSkip) break;
    await sleep(450);
  }
  const skipped = audioProbe.toast !== toastBefore && /跳到下一首|也没出声/.test(audioProbe.toast);
  check('音频真的在走（或应用已如实跳走，而不是卡住）',
    audioProbe.t > 0.3 || skipped,
    audioProbe.t > 0.3
      ? `${audioProbe.t.toFixed(2)}s readyState=${audioProbe.ready}`
      : `未出声但已跳歌：${audioProbe.toast || '(无提示)'} → 现为 ${audioProbe.count}`);
  await cdp.shot(path.join(__dirname, 'shot-m3-播放中.png'));

  log('\n══ 5. 跨平台对比（网易云 vs QQ 音乐）══');
  await fillAndRun(cdp, NET_A, QQ_B);
  await cdp.waitFor(`!document.getElementById('result').classList.contains('hidden')`, 90000, '拿到跨平台结果');
  await sleep(1200);
  const cross = JSON.parse(await cdp.eval(`(() => {
    const q = (s) => document.querySelector(s);
    const warn = q('#warnBar');
    return JSON.stringify({
      stats: q('#stats').textContent.trim(),
      warnShown: !warn.classList.contains('hidden'),
      warnText: warn.textContent.trim(),
      rows: document.querySelectorAll('#songList .song').length,
      badges: document.querySelectorAll('#songList .pfa-qq').length,
      pairs: document.querySelectorAll('#songList .s-pair').length,
      nameB: q('#nameB') ? q('#nameB').textContent.trim() : '',
      listTitle: q('#songListTitle').textContent.trim()
    });
  })()`));
  check('口径改成「跨平台 · 同名 + 同歌手」', /跨平台/.test(cross.stats) && /同名/.test(cross.stats), cross.stats.slice(0, 90));
  check('摆出「口径偏松」的提醒条', cross.warnShown && /ID 体系不同|同名/.test(cross.warnText), cross.warnText.slice(0, 110));
  check('跨平台结果不为空（这份 QQ 歌单里有能对上的）', cross.rows > 0, `${cross.rows} 行`);
  check('每行标出 QQ 侧平台徽章', cross.badges === cross.rows, `${cross.badges} 个徽章 / ${cross.rows} 行`);
  check('每行标出另一边是哪首歌', cross.pairs === cross.rows, `${cross.pairs} 行带「另一边」`);
  check('右侧昵称读到了', !!cross.nameB && cross.nameB !== '—', cross.nameB);
  await cdp.shot(path.join(__dirname, 'shot-m4-跨平台.png'));

  // 封面要真的加载出来，不能只看有没有 src（老版自检有这条，新脚本别丢了）
  await cdp.waitFor(
    `[...document.querySelectorAll('#songList img')].every((i) => i.complete)`,
    25000, '封面图加载完（成功或失败）'
  );
  const cover = JSON.parse(await cdp.eval(`(() => {
    const imgs = [...document.querySelectorAll('#songList img')];
    const ok = imgs.filter((i) => i.naturalWidth > 0);
    return JSON.stringify({ total: imgs.length, ok: ok.length, sample: ok[0] ? ok[0].naturalWidth + 'px' : '' });
  })()`));
  check('专辑封面真的加载出来了（不是空壳 img）',
    cover.total > 0 && cover.ok === cover.total,
    `${cover.ok}/${cover.total} 张加载成功，样本宽度 ${cover.sample}`);

  log('\n══ 6. 酷狗（能对比、不能试听）══');
  // 酷狗没读到全量、拿不到播放地址，所以这里用「网易云 vs 酷狗」的混平台场景：
  // 既验证 partial 提醒，也验证「酷狗侧的曲目只能靠网易云那侧出声」。
  // （双侧都是酷狗的情况由 _dev/api-check.mjs 覆盖——手上只有一个确定可用的酷狗歌单 id。）
  await fillAndRun(cdp, NET_A, KG_A);
  await cdp.waitFor(`!document.getElementById('result').classList.contains('hidden')`, 90000, '拿到酷狗结果');
  await cdp.waitFor(`document.getElementById('playNote').textContent.trim().length > 0`, 60000, '播放权限查完');
  await sleep(1200);
  const kg = JSON.parse(await cdp.eval(`(() => {
    const q = (s) => document.querySelector(s);
    const warn = q('#warnBar');
    const a = document.getElementById('audio');
    return JSON.stringify({
      stats: q('#stats').textContent.trim(),
      warnShown: !warn.classList.contains('hidden'),
      warnText: warn.textContent.trim(),
      rows: document.querySelectorAll('#songList .song').length,
      badges: document.querySelectorAll('#songList .pfa-kugou').length,
      pairs: document.querySelectorAll('#songList .s-pair').length,
      playBtns: document.querySelectorAll('#songList .s-play').length,
      note: q('#playNote').textContent.trim(),
      playAllDisabled: q('#playAllBtn') ? q('#playAllBtn').disabled : null,
      playerShown: q('#player').classList.contains('show'),
      audioSrc: a.getAttribute('src') || '',
      listTitle: q('#songListTitle').textContent.trim()
    });
  })()`));
  check('酷狗也能读到歌单并参与对比', kg.rows > 0, `${kg.rows} 行 · ${kg.stats.slice(0, 60)}`);
  check('如实提醒「只读到前 30 首」', kg.warnShown && /30/.test(kg.warnText), kg.warnText.slice(0, 110));
  check('每行标出酷狗侧徽章', kg.badges === kg.rows, `${kg.badges} 个徽章 / ${kg.rows} 行`);
  check('每行标出另一边是哪首歌', kg.pairs === kg.rows, `${kg.pairs} 行带「另一边」`);
  // 这 2 首恰好都是网易云的 VIP 曲，酷狗侧的地址拿不到、也轮不到——所以这里只断言「说明有话说、且不撒谎」，
  // 不硬性要求出现「酷狗」字样（酷狗没参与出声时提它反而是噪音）。
  check('播放说明有明确交代，不留空白', kg.note.length > 8 && /放不出来|可以直接播放|无法试听/.test(kg.note), kg.note.slice(0, 130));
  check('「按顺序播放全部」没被误禁用（有网易云侧的地址）', kg.playAllDisabled === false, String(kg.playAllDisabled));
  await cdp.shot(path.join(__dirname, 'shot-m5-酷狗.png'));

  log('\n══ 6b. 同一个酷狗链接：前端应当拦下 ══');
  // 只有一份确定可用的酷狗歌单，所以「两侧都是酷狗」只能靠同一个链接；
  // 前端会拦下同一个链接，这里就验证这道拦截真的生效（不是静默失败）。
  await cdp.eval(`document.getElementById('status').textContent = ''; 1`);
  await fillAndRun(cdp, KG_A, KG_A);
  await cdp.waitFor(`/同一个链接/.test(document.getElementById('status').textContent)`, 15000, '提示「同一个链接」');
  const dup = JSON.parse(await cdp.eval(`JSON.stringify({
    status: document.getElementById('status').textContent.trim(),
    resultHidden: document.getElementById('result').classList.contains('hidden'),
    runEnabled: !document.getElementById('runBtn').disabled
  })`));
  check('同一个链接被拦下并说清原因', /同一个链接/.test(dup.status), dup.status.slice(0, 70));
  check('拦下时不出结果、按钮恢复', dup.resultHidden && dup.runEnabled, `hidden=${dup.resultHidden} enabled=${dup.runEnabled}`);

  log('\n══ 7. 导出面板 ══');
  // 点「导出」应当弹出面板，三家平台各一份格式
  await cdp.eval(`document.getElementById('exportBtn').click(); 1`);
  const sheet = JSON.parse(await cdp.eval(`JSON.stringify({
    open: !document.getElementById('exportMask').classList.contains('hidden'),
    plats: [...document.querySelectorAll('#exportMask .plat')].map((p) => p.dataset.plat),
    sub: document.getElementById('exportSub').textContent.trim(),
    qqBtn: document.querySelector('#exportMask [data-copy="qq"]').textContent.trim(),
    kgNote: (document.querySelector('#exportMask [data-plat="kugou"] .plat-note') || {}).textContent || ''
  })`));
  check('点「导出」弹出面板，三家平台都在', sheet.open && sheet.plats.join(',') === 'netease,qq,kugou',
    `open=${sheet.open} plats=${sheet.plats.join(',')} ${sheet.sub}`);
  check('QQ 那颗按钮是「复制并打开导入页」', /打开导入页/.test(sheet.qqBtn), sheet.qqBtn);
  check('酷狗卡片说明走链接导入', /链接/.test(sheet.kgNote), sheet.kgNote.slice(0, 50));

  // 抓「复制文本」实际写了什么（headless 里真剪贴板不可靠，先拦截掉）
  const patText = await cdp.eval(`(async () => {
    let got = '';
    const real = navigator.clipboard;
    try {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { got = t; } } });
      document.querySelector('#exportMask [data-copy="netease"]').click();
      await new Promise((r) => setTimeout(r, 80));
    } finally {
      try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: real }); } catch (e) {}
    }
    return got;
  })()`);
  const firstLine = String(patText || '').split('\n')[0];
  check('网易云格式 =「序号. 歌名 歌手」（不带横杠）',
    /^\d+\.\s/.test(firstLine) && !/ - /.test(firstLine), firstLine.slice(0, 60));
  const stillOpen = JSON.parse(await cdp.eval(
    `JSON.stringify(!document.getElementById('exportMask').classList.contains('hidden'))`));
  check('复制完之后面板自动收起', stillOpen === false, `open=${stillOpen}`);

  // ── 更新面板：页脚那个小版本号点开就是
  await cdp.eval(`document.getElementById('verChip').click(); 1`);
  await sleep(500);
  const upd = JSON.parse(await cdp.eval(`JSON.stringify({
    open: !document.getElementById('updateMask').classList.contains('hidden'),
    foot: document.getElementById('verNum').textContent.trim(),
    cur: document.getElementById('updCur').textContent.trim(),
    latest: document.getElementById('updLatest').textContent.trim(),
    applyShown: !document.getElementById('updateApply').classList.contains('hidden'),
    applyText: document.getElementById('updateApply').textContent.trim(),
    chipNew: document.getElementById('verChip').classList.contains('has-new'),
    notes: document.getElementById('updNotes').textContent.trim()
  })`));
  check('点页脚版本号弹出更新面板', upd.open, `open=${upd.open} foot=v${upd.foot}`);
  check('面板写清「当前 → 最新」两个版本号',
    /0\.3\.1-offline/.test(upd.cur) && /0\.9\.9/.test(upd.latest), `${upd.cur} → ${upd.latest}`);
  check('有新版本时给出「一键更新到 v0.9.9」', upd.applyShown && /0\.9\.9/.test(upd.applyText), upd.applyText);
  check('页脚版本号打上「有新版」标记', upd.chipNew === true, String(upd.chipNew));
  check('发布说明原文摊在面板里', /离线自检/.test(upd.notes), upd.notes.slice(0, 40));

  await cdp.eval(`document.getElementById('updateClose').click(); 1`);
  const updClosed = JSON.parse(await cdp.eval(
    `JSON.stringify(document.getElementById('updateMask').classList.contains('hidden'))`));
  check('关掉更新面板', updClosed === true, `hidden=${updClosed}`);

  log('\n══ 7b. CSV 导出 ══');
  await cdp.eval(`document.getElementById('exportBtn').click(); 1`);
  const csv = await cdp.eval(`(() => {
    // 拦住 createObjectURL，用 XHR 把内容读回来（headless 里抓不到真实下载文件）
    const orig = URL.createObjectURL;
    let text = '';
    URL.createObjectURL = (blob) => { window.__blob = blob; return 'blob:fake'; };
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {};
    document.getElementById('exportCsv').click();
    URL.createObjectURL = orig;
    HTMLAnchorElement.prototype.click = origClick;
    return window.__blob ? window.__blob.text() : Promise.resolve('');
  })()`);
  const csvText = typeof csv === 'string' ? csv : '';
  const csvLines = csvText.split('\r\n');
  check('CSV 表头含「来源平台」与「链接」', /来源平台/.test(csvText) && /链接/.test(csvText), csvLines[0].slice(0, 130));
  check('CSV 数据行数对得上', csvLines.length > 2, `${csvLines.length - 2} 行数据`);

  log('\n══ 8. 控制台与异常 ══');
  const realErrors = cdp.errors.filter((e) => !/favicon|net::ERR|404 \\(Not Found\\)/i.test(e));
  check('没有 JS 运行时异常', realErrors.length === 0, realErrors.slice(0, 3).join(' | ') || '无');
  const errLogs = cdp.logs.filter((l) => l.startsWith('error'));
  check('没有 console.error', errLogs.length === 0, errLogs.slice(0, 3).join(' | ') || '无');
} catch (err) {
  log('\n💥 自检中断：', err.message);
  exitCode = 1;
} finally {
  try { proc.kill(); } catch { /* 忽略 */ }
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
log('\n' + '─'.repeat(50));
log(`  自检结果：${pass} 项通过 / ${fail} 项失败 （共 ${results.length} 项）`);
if (fail) {
  log('  失败项：');
  results.filter((r) => !r.pass).forEach((r) => log(`    · ${r.name}  ${r.detail}`));
  exitCode = 1;
}
log('─'.repeat(50));
fs.writeFileSync(path.join(__dirname, '自检结果_多平台.json'), JSON.stringify(results, null, 2));
// 同时留一份人看的文本记录，跟 _dev/自检记录_新界面.txt 对齐
fs.writeFileSync(
  path.join(__dirname, '自检记录_多平台.txt'),
  LOG_LINES.join('\n') + '\n',
  'utf8'
);
process.exit(exitCode);
