/**
 * 音乐歌单重合度对比 —— 本地服务
 *
 * 支持网易云音乐 / QQ 音乐 / 酷狗音乐三个平台，可以同平台对比，也可以跨平台对比。
 * 零第三方依赖，只用 Node 内置模块。
 *
 * 启动：node server.mjs [端口]       默认 8787，只监听 127.0.0.1
 * 手机访问：node server.mjs --lan    监听 0.0.0.0，并打印局域网地址（同 WiFi 的手机能打开）
 * 走代理：node server.mjs --proxy=http://127.0.0.1:7890   或设置环境变量 MUSIC_PROXY
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import {
  ORDER,
  PLATFORM_LIST,
  PLATFORM_IDS,
  getPlatform,
  allHints,
  parseInput,
} from './platforms/index.mjs';
import { resolveProxy, HttpError, streamAudio } from './platforms/shared.mjs';
import { isShortLink, resolveShort } from './platforms/shortlink.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
/* ESM 里没有 __filename；--probe-port 要把它当子进程再跑一次本文件，得有它 */
const __filename = fileURLToPath(import.meta.url);

/*
 * `--probe-port <n>`：问一下「某个端口上跑的是不是这个工具」，是就把那份 JSON
 * 打印出来然后退出——不起服务、不打印别的。
 *
 * 用途只有一个：端口被占用时区分「自己的上一个窗口忘了关」和「别的程序占着」。
 * 前者该把手机该输的网址直接给出来，后者才该劝用户换端口。
 *
 * 走 http.get 而不是 net.connect，是因为这里顺手把 /api/health 验了：能答出 ok
 * 的才是这个工具；别的程序占着端口、或对面是另一个 HTTP 服务，都会落到失败分支。
 *
 * 这段必须放在 IS_MAIN 判断**之前**——探针自己也是一个进程，不该顺手把服务起起来。
 */
function probeExisting(p, cb) {
  const req = http.get({ host: '127.0.0.1', port: p, path: '/api/health', family: 4, timeout: 1500 }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
      try {
        const info = JSON.parse(body);
        cb(info && info.ok ? info : null);
      } catch { cb(null); }
    });
  });
  req.on('timeout', () => { req.destroy(); cb(null); });
  req.on('error', () => cb(null));
}
/*
 * 端口被占用时要在 'error' 回调里**同步**拿到答案（异步的话就得在回调里续写
 * 一长段控制流），所以这里用子进程把 --probe-port 跑成同步的。
 * 探不通（超时、对面不是这个工具、老版本不认这个参数）一律当「别的程序占着」。
 */
function probeExistingSync(p) {
  try {
    return JSON.parse(execFileSync(process.execPath, [__filename, '--probe-port', String(p)], {
      timeout: 4000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }));
  } catch { return null; }
}
if (process.argv.includes('--probe-port')) {
  /*
   * 注意：/api/health 只答 `{ok, version, platforms}`，**没有** url / lan。
   * 那两项是启动时打印的（启动进程自己知道端口和网卡），探针进程得自己补上——
   * 否则父进程会把 `lan[0]` 当 undefined 写进 .started.url，用户看到的就是空白地址。
   */
  const target = Number(process.argv[process.argv.indexOf('--probe-port') + 1]) || 8787;
  const lan = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      if (ni.address.startsWith('169.254.')) continue;
      lan.push({ name, address: ni.address });
    }
  }
  lan.sort((x, y) => {
    const v = (n) => (/^(vEthernet|VMware|VirtualBox|Hyper-V|Loopback|Bluetooth|WSL|vgate|ZeroTier|Tailscale)/i.test(n) ? 1 : 0);
    return v(x.name) - v(y.name);
  });
  probeExisting(target, (alive) => {
    const info = alive && {
      ok: true,
      port: target,
      url: `http://127.0.0.1:${target}`,
      lan: lan.map((x) => `http://${x.address}:${target}`),
    };
    if (info) process.stdout.write(JSON.stringify(info) + '\n');
    /*
     * 顺手把「手机该输的地址」单独写一个文件。原因：Windows 的 .bat 里做字符串
     * 处理极其难缠（`!VAR:"=!` 这种替换在 `in ("...")` 里不一定生效），而启动器
     * 只需要一行地址。给它一行纯文本，比让它去解析 JSON 稳得多。
     * 路径跟 STARTED_URL_FILE 是同一个（define 在后面，所以这里只能自己算一遍）。
     */
    try {
      if (info?.lan?.length) {
        fs.writeFileSync(path.join(__dirname, '.started.url'), info.lan[0], 'utf8');
      }
    } catch { /* 写不进去也不影响探针本身 */ }
    process.exit(info ? 0 : 1);
  });
}

/*
 * 是在跑服务，还是被 import 进来做测试？
 * _dev/api-check.mjs 要能把 compare() 拆出来单独喂假数据跑（不然那些测试只能靠真实网络），
 * 所以被 import 时不要起 HTTP 服务、也不要打印启动横幅。
 */
const IS_MAIN = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
/*
 * 探针模式：`--probe-port` 时**绝不能**把服务起起来。
 * 一开始只写了「探到就 exit」，结果探针自己先 listen 了一下、把启动横幅也打进
 * stdout，父进程 JSON.parse 那一行就炸了——表现为「明明开着服务却认不出来」。
 */
const PROBE_ONLY = process.argv.includes('--probe-port');

const ARGV = process.argv.slice(2);
const PORT = Number(ARGV.find((a) => /^\d+$/.test(a))) || 8787;
/*
 * `--print-port`：启动后第一行输出机器可读的 JSON（含真实端口）。
 * Mac / Linux 的启动脚本靠它拿到端口——POSIX shell 没有便宜的办法读后台进程的 stdout。
 */
const PRINT_PORT = ARGV.includes('--print-port');

/*
 * `--lan`：把服务开给局域网，手机浏览器就能用（同一份前端，一行不用改）。
 *
 * 默认只监听 127.0.0.1 —— 那是「只有这台电脑能用」的最安全状态。开了 --lan 就是
 * 主动把端口交给同网段的设备，所以这里同时补两件事：
 *   1) Host 头白名单：只认本机自己的地址，挡掉 DNS rebinding（外部域名解析到内网 IP）
 *   2) 回一个 CORS 头：让同 WiFi 下的其它页面也调得动（默认模式下从不回 CORS 头，
 *      那是本机上防跨站 POST 的第一道关，所以只能在 --lan 下开口子）
 */
const LAN = ARGV.includes('--lan');

/** 本机所有可用的局域网 IPv4（排除回环与 169.254 那种没拿到 DHCP 的地址） */
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      if (ni.address.startsWith('169.254.')) continue;
      out.push({ name, address: ni.address });
    }
  }
  return out;
}

/*
 * 一台机器上常常不止一个地址：虚拟机网卡、VPN、Docker、Hyper-V 都会各报一个。
 * 用户看到一列地址只会懵，所以挑一个最可能是「手机能摸到的那个」排在最前面：
 * 网卡名字里带虚拟化关键词的降权，剩下的按常见家用网段（192.168 > 10 > 172）排。
 * 注意这只影响**显示顺序**，不影响的 Host 白名单——白名单收全部地址，
 * 免得用户在手机上试了第二个地址反而被 403 挡回来。
 */
const VIRTUAL_NIC = /vEthernet|vethernet|Virtual|VMware|VirtualBox|Hyper-V|Loopback|TAP|TUN|WSL|Docker|VPN|ZeroTier|Tailscale|vgate/i;
function nicScore({ name, address }) {
  let s = 0;
  if (!VIRTUAL_NIC.test(name)) s += 100;
  if (address.startsWith('192.168.')) s += 30;
  else if (address.startsWith('10.')) s += 20;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) s += 10;
  return s;
}

const LAN_IPS = lanAddresses().sort((a, b) => nicScore(b) - nicScore(a));
const LAN_NAMES = LAN_IPS.map((x) => x.address);
/** 横幅和自检里那个「拿手机连这个」的地址；一个都没有时是空串 */
const PRIMARY_LAN = LAN_IPS[0]?.address || '';
const BIND_HOST = LAN ? '0.0.0.0' : '127.0.0.1';
/** Host 头白名单（开了 --lan 才有意义，默认模式下 accept 里只有回环那几种写法） */
const ALLOWED_HOSTS = new Set([
  '127.0.0.1', 'localhost', '[::1]', '::1',
  ...(LAN ? LAN_NAMES : []),
]);

resolveProxy(ARGV);

/*
 * 兜底：这个服务是给普通用户双击 bat 用的，普通用户不会看黑窗口里滚了什么，
 * 更不会去重启它。所以任何一条漏网的 socket 错误（比如远端 RST）
 * 都不该让进程直接消失——那种情况下表现就是「网页突然打不开了」，
 * 用户完全不知道发生了什么。宁可留一条记录继续跑。
 */
process.on('uncaughtException', (err) => {
  // 连 stack 一起打：只打 message 的话，线上出问题根本倒查不到是哪一行
  console.error(`[${new Date().toLocaleTimeString('zh-CN')}] 忽略了一个未捕获异常，服务继续运行：`);
  console.error(err?.stack || err);
});
process.on('unhandledRejection', (err) => {
  console.error(`[${new Date().toLocaleTimeString('zh-CN')}] 忽略了一个未处理的 Promise 拒绝，服务继续运行：`);
  console.error(err?.stack || err);
});

const DETAIL_CAP = 8000; // 每侧最多取这么多首的详情，防呆
const MAX_BODY = 4 * 1024 * 1024; // 请求体上限
/*
 * 版本号只在这里写一次。
 * _dev/build-portable.mjs 与 _dev/release.mjs 会用正则从本文件里搜
 * 「version 冒号 引号里的东西」，所以下面的写法不能改（别把版本号挪进注释，
 * 也别写成 `const VERSION = '1.2.3'` —— 那样正则搜不到，打包和发版会直接炸）。
 */
const PKG = { version: '0.10.0' };

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

const ALLOWED_ORIGIN_RE = new RegExp(
  `^https?://(127\\.0\\.0\\.1|localhost|\\[::1\\])(:\\d+)?$|^https?://(${LAN_IPS.map((x) => x.address.replace(/\./g, '\\.')).join('|')})(:\\d+)?$`
);

/**
 * 跨域来源白名单（只在 --lan 时有意义）。
 *
 * 一开始这里写的是 `Access-Control-Allow-Origin: *`，想着「反正只是给自己家 WiFi 用」。
 * 那是错的：`*` 不区分「你手机上的页面」和「你电脑上随便打开的那个网页」——
 * 后者也能安安稳稳读到 /api/compare 的响应。收紧成「只有本机地址才给 CORS 头」之后，
 * 手机直连（同源，浏览器根本不发 Origin）完全不受影响，而外部网站拿不到响应内容。
 */
function corsHeaders(origin) {
  if (!LAN || !origin) return {};
  return ALLOWED_ORIGIN_RE.test(origin)
    ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
    : {};
}

const send = (res, status, body, headers = {}) => {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...corsHeaders(res.__origin),
    ...headers,
  });
  res.end(payload);
};

const fail = (res, status, message, extra = {}) =>
  send(res, status, { ok: false, error: message, ...extra });

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, '请求体太大了'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
}

/* ── 对比记录：存在本机的一个 JSON 文件里 ──
 * 为什么存服务端而不是 localStorage：手机和电脑各存一份会分叉，而且清理浏览器数据就没了；
 * 存服务端还有一个好处——手机上那个 APK 自己就是服务端，记录跟着应用走。
 * 只存「谁和谁、哪两个歌单、共同多少首」，不存歌单正文（那样文件会很快涨到几十 MB）。 */
const HISTORY_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(HISTORY_DIR, 'history.json');

async function readHistory() {
  try {
    const txt = await fs.promises.readFile(HISTORY_FILE, 'utf8');
    const data = JSON.parse(txt);
    return { items: Array.isArray(data?.items) ? data.items : [] };
  } catch {
    return { items: [] };   // 没有文件 / 文件坏了，都当空
  }
}

async function writeHistory(h) {
  await fs.promises.mkdir(HISTORY_DIR, { recursive: true });
  await fs.promises.writeFile(HISTORY_FILE, JSON.stringify(h, null, 2), 'utf8');
}

/** 把一次对比压缩成一条记录；缺了关键字段就返回 null（宁可不记，也别存半条） */
function makeHistoryItem(b) {
  const link = (x) => (typeof x === 'string' ? x.trim() : '');
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const side = (x) => ({
    link: link(x?.link),
    name: String(x?.name || '').slice(0, 80),
    nickname: String(x?.nickname || '').slice(0, 40),
    platform: String(x?.platform || ''),
  });

  // 多人记录：链接都在 raws 里，a / b 只是头两个，老的展示逻辑照样能用
  const raws = (Array.isArray(b?.raws) ? b.raws : []).map(link).filter(Boolean).slice(0, 8);
  const a = side(b?.a);
  const bb = side(b?.b);
  const multi = raws.length >= 3;

  if (multi) {
    if (!a.link || !bb.link) return null;
    return {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      at: new Date().toISOString(),
      raws,
      people: raws.length,
      a,
      b: bb,
      shared: num(b?.shared),
      totalA: num(b?.totalA),
      totalB: num(b?.totalB),
      ratio: num(b?.ratio),
      ratioUnion: num(b?.ratioUnion),
    };
  }

  const aLink = a.link;
  const bLink = bb.link;
  if (!aLink || !bLink) return null;
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    at: new Date().toISOString(),
    a: { ...a, link: aLink },
    b: { ...bb, link: bLink },
    shared: num(b?.shared),
    totalA: num(b?.totalA),
    totalB: num(b?.totalB),
    ratio: num(b?.ratio),
    ratioUnion: num(b?.ratioUnion),
  };
}

/**
 * 同名同歌手指纹：小写 + 去空白 + 去标点。
 * 刻意不剥括号——「Love is Gone (Acoustic)」和「Love is Gone」是不同录音，
 * 宁可少算，也不要把不同版本混成一首虚高数字。
 */
function normalize(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[·・.,，。、!！?？'"“”‘’()（）\[\]【】\-—_/\\|&+*#:：;；~^]/g, '');
}

function fingerprint(song) {
  if (!song) return '';
  const name = normalize(song.name);
  if (!name) return '';
  // 歌手用**完整**名单，不只看第一歌手：网易云「Believer - Imagine Dragons / Lil Wayne」
  // 和「Believer - Imagine Dragons」是两份不同的录音，不该算成同一首的版本。
  const artist = normalize(song.artists);
  return artist ? `${name}@@${artist}` : name;
}

/* ------------------------------------------------------------------ *
 * 取歌单：先按平台，再按候选
 * ------------------------------------------------------------------ */

/**
 * 解析输入 → 候选平台列表。
 * 纯数字输入在三家都可能，按 网易云 → QQ → 酷狗 的顺序试。
 */
function buildCandidates(raw) {
  const hit = parseInput(raw);
  if (!hit) {
    return {
      error:
        '这段内容里没认出歌单。可以直接粘 App 里复制的整段分享文案，' +
        '也可以粘歌单链接或歌单 ID。如果是短链打不开，请点开歌单后从浏览器地址栏复制完整地址。',
      candidates: [],
    };
  }
  const list = Array.isArray(hit) ? hit : [hit];
  const usable = list.filter((c) => c && c.id);
  if (!usable.length) {
    return {
      error: '没能从这段内容里认出歌单：短链可能已经失效，请点开歌单后复制地址栏里的完整地址',
      candidates: [],
    };
  }
  return { candidates: usable, error: '' };
}

/** 按候选顺序依次尝试，返回第一个成功的 */
async function loadSide(raw, label) {
  // 手机 App 里「复制链接」得到的常常是短链（163cn.tv / c6.y.qq.com/…），
  // 短链里没有歌单 ID，先跟一跳拿到真正的歌单页地址再识别。
  let text = raw;
  if (isShortLink(raw)) {
    const real = await resolveShort(raw);
    if (real) text = real;
  }

  const { candidates, error } = buildCandidates(text);
  if (error) throw new HttpError(400, `第 ${label} 个输入：${error}`);

  const tried = [];
  for (const cand of candidates) {
    const platform = getPlatform(cand.platform);
    if (!platform) continue;
    try {
      const pl = await platform.fetchPlaylist(cand.id);
      return { ...pl, platform: cand.platform, label, guessed: candidates.length > 1 && tried.length > 0, tried };
    } catch (e) {
      tried.push({ platform: cand.platform, message: e?.message || String(e) });
      // 只有「不是这个平台」类的失败才继续换一家；一旦是明确的私密/无权限就别乱猜了
      if (e instanceof HttpError && e.status === 404 && /私密/.test(e.message)) {
        throw new HttpError(404, `第 ${label} 个输入（${platform.label}）：${e.message}`);
      }
      if (candidates.length === 1) throw e;
    }
  }

  const detail = tried.map((t) => `· ${getPlatform(t.platform)?.label || t.platform}：${t.message}`).join('\n');
  throw new HttpError(404, `第 ${label} 个输入没能在任何一个平台读到歌单。挨个试过的结果：\n${detail}`);
}

/* ------------------------------------------------------------------ *
 * 对比
 * ------------------------------------------------------------------ */

/** 把两侧都归一成 { ids:string[], songs:Map<string, song> } */
async function loadDetails(side) {
  const platform = getPlatform(side.platform);
  const ids = [...new Set((side.trackIds || []).map(String))];
  const truncated = ids.length > DETAIL_CAP;
  const use = truncated ? ids.slice(0, DETAIL_CAP) : ids;
  const map = await platform.fetchSongs(use, side.raw, side.cover);
  // 统一成字符串 id，跨平台比较时不会因为类型不同而错位
  const norm = new Map();
  for (const [k, v] of map) norm.set(String(k), v);
  return { platform: side.platform, ids: use, truncated, allIds: ids, songs: norm };
}

/**
 * 核心对比。
 * 同平台：按「歌曲 ID 相同」算，这是最严格也最准的口径。
 * 跨平台：不同平台 ID 体系不同，只能按「同名 + 同歌手」算（不剥括号，宁少不虚）。
 *
 * 最后两个参数是给测试用的注入口（_dev/api-check.mjs 会喂假数据进来），
 * 正式运行时用默认值，行为不变。
 *
 * 统计口径的唯一原则：**分子和分母必须来自同一个集合**。
 * 歌单里会有拿不到详情的条目（下架 / 版权变动），它们进不了 common；
 * 如果分母还按歌单总数算，比例就会静默偏低。所以统一改成：
 *   分母 = 「本次真正参与对比的歌曲」的并集，另外单独报出被排除的数量。
 */
export async function compare({ aRaw, bRaw }, deps = {}) {
  const doLoadSide = deps.loadSide || loadSide;
  const doLoadDetails = deps.loadDetails || loadDetails;
  const started = Date.now();

  const a = await doLoadSide(aRaw, 'A');
  const b = await doLoadSide(bRaw, 'B');
  const samePlatform = a.platform === b.platform;

  const [ad, bd] = await Promise.all([doLoadDetails(a), doLoadDetails(b)]);

  /*
   * 统一把 id 归一成字符串再比较。
   * 不能直接拿 loadDetails 返回的 ids：测试注入的实现不一定做过这层归一化，
   * 一旦类型不一致，set 判等就会全部落空，而且这种错看起来像「匹配率突然变 0」。
   */
  const idsA = [...new Set((ad.allIds || ad.ids).map(String))];
  const idsB = [...new Set((bd.allIds || bd.ids).map(String))];
  const hasDetailA = new Set([...ad.songs.keys()].map(String));
  const hasDetailB = new Set([...bd.songs.keys()].map(String));

  const common = [];
  const variants = [];
  const unmatchedA = [];
  const unmatchedB = [];
  const noDetail = []; // ID 相同、但两边都取不到详情的歌（下架 / 版权变动）
  const usedB = new Set();

  // 有歌名（= 能进指纹匹配）的才算「候选」；没详情的进不了任何匹配
  const fpA = new Map();
  for (const id of idsA) {
    const s = ad.songs.get(id);
    if (!s) continue;
    const fp = fingerprint(s);
    if (!fp) continue;
    if (!fpA.has(fp)) fpA.set(fp, []);
    fpA.get(fp).push(id);
  }
  const fpB = new Map();
  for (const id of idsB) {
    const s = bd.songs.get(id);
    if (!s) continue;
    const fp = fingerprint(s);
    if (!fp) continue;
    if (!fpB.has(fp)) fpB.set(fp, []);
    fpB.get(fp).push(id);
  }
  const candidatesA = [...fpA.values()].reduce((n, v) => n + v.length, 0);
  const candidatesB = [...fpB.values()].reduce((n, v) => n + v.length, 0);
  const otherIds = samePlatform ? new Set(idsB) : new Set();

  if (samePlatform) {
    // —— 同平台：ID 严格相等
    for (const id of idsA) {
      if (!hasDetailB.has(id)) continue;
      const s = ad.songs.get(id) || bd.songs.get(id);
      if (!s) continue;
      common.push({
        id,
        name: s.name,
        artists: s.artists,
        album: s.album,
        cover: s.cover || bd.songs.get(id)?.cover || '',
        dt: s.dt,
        audio: { platform: a.platform, id },
      });
    }

    // 宽松口径：ID 不同但同名同歌手（现场版、Remaster 之类）
    // 两个容易踩的点：
    //   1) A 侧**不能**把「ID 也在 B 里」的歌排除掉——同一首歌两边各有一条 ID 不同的记录时，
    //      那条记录正是 B 侧另一条记录的唯一配对对象，排掉就会漏。B 侧循环里的 setA.has(id) 已经足够。
    //   2) 只有**真正取到详情**的歌才能进指纹表。歌单里存在详情拉不回来的条目（下架 / 版权变动），
    //      只按 trackId 建表会拿一条「名字未知」的空记录去配 B 侧的歌，凭空造出一对假的同名版本。
    const idSetA = new Set(idsA);
    const idSetB = new Set(idsB);
    for (const id of idsB) {
      if (idSetA.has(id)) continue; // 同 ID 的已经算过了
      const fp = fingerprint(bd.songs.get(id));
      if (!fp) continue;
      const bucket = fpA.get(fp);
      if (!bucket || !bucket.length) continue;
      const idA = bucket.shift();
      const sa = ad.songs.get(idA);
      const sb = bd.songs.get(id);
      variants.push({
        id,
        name: sb?.name || sa?.name || '',
        artists: sb?.artists || sa?.artists || '',
        album: sb?.album || '',
        cover: sb?.cover || sa?.cover || '',
        dt: sb?.dt || sa?.dt || 0,
        audio: { platform: b.platform, id },
        counterpart: { id: idA, name: sa?.name || '', album: sa?.album || '' },
      });
    }
    // 没匹配上的：先看是不是「ID 对上了但两边都取不到详情」，那是另一种情况，要单独说
    for (const id of idsA) {
      if (hasDetailA.has(id)) continue;
      if (idSetB.has(id)) {
        noDetail.push({ id, name: ad.songs.get(id)?.name || '', reason: 'both' });
        continue;
      }
      unmatchedA.push({ id, name: '', artists: '', reason: 'no-detail' });
    }
    for (const id of idsB) {
      if (idSetA.has(id)) continue; // 同 ID，上面处理过了
      if (hasDetailB.has(id)) continue;
      unmatchedB.push({ id, name: '', artists: '', reason: 'no-detail' });
    }
  } else {
    // —— 跨平台：只能靠「同名 + 同歌手」对上，如实标出这是宽松口径
    for (const id of idsA) {
      const songA = ad.songs.get(id);
      const fp = fingerprint(songA);
      if (!fp) continue; // 没详情 / 没歌名：进不了统计，下面单独计数
      const bucket = fpB.get(fp);
      if (!bucket || !bucket.length) {
        unmatchedA.push({ id, name: songA?.name || '', artists: songA?.artists || '' });
        continue;
      }
      const idB = bucket.shift();
      usedB.add(idB);
      const songB = bd.songs.get(idB);
      // 播放源优先用「能播」的那家
      const audioPlatforms = [a.platform, b.platform].sort(
        (x, y) => ORDER.indexOf(x) - ORDER.indexOf(y)
      );
      const audioPlatform = audioPlatforms[0];
      common.push({
        id,
        name: songA?.name || songB?.name || '',
        artists: songA?.artists || songB?.artists || '',
        album: songA?.album || '',
        cover: songA?.cover || songB?.cover || '',
        dt: songA?.dt || songB?.dt || 0,
        counterpart: { platform: b.platform, id: idB, name: songB?.name || '', album: songB?.album || '' },
        audio: { platform: audioPlatform, id: audioPlatform === a.platform ? id : idB },
      });
    }
    for (const id of idsB) {
      if (usedB.has(id)) continue;
      const songB = bd.songs.get(id);
      if (!hasDetailB.has(id)) {
        unmatchedB.push({ id, name: '', artists: '', reason: 'no-detail' });
        continue;
      }
      unmatchedB.push({ id, name: songB?.name || '', artists: songB?.artists || '' });
    }
  }

  /*
   * —— 统计口径 ——
   * 分子和分母必须来自同一个集合，这是这里唯一的规矩。
   *
   * 歌单里会有拿不到详情的条目（下架 / 版权变动）：它们进不了 common，
   * 但如果分母还按歌单总数算，比例就会**静默偏低**——用户看到的数字是错的，
   * 而且没有任何提示。所以分母改成「本次真正参与对比的并集」：
   *   同平台 = 两侧有详情的 ID 并集（严格口径只认 ID 相等）
   *   跨平台 = 两侧有歌名（能进指纹匹配）的候选并集
   * 被排除掉的数量单独报出来，不藏在分母里。
   *
   * 顺带修掉的旧 bug：跨平台时 union 原来是拿两边的**原始 ID** 去重的，
   * 而网易云是数字 ID、QQ 是字母数字 mid，两个集合永不相交，
   * 于是 union 恒等于 sizeA + sizeB——匹配上的歌从来没被扣掉过。
   */
  const compA = samePlatform
    ? idsA.filter((id) => hasDetailA.has(id)).length
    : candidatesA;
  /*
   * B 侧「参与对比」的数量 = 有详情、且不在 A 的**可比集合**里的。
   * 注意不能只写 `!otherIds.has(id)`（otherIds = B 侧全部 ID）：
   * 有一类歌两边都有、ID 也对得上，但**两边都取不到详情**（下架 / 版权变动）。
   * 这类歌既进不了「共同」，也不该从并集里消失 —— 它们是实打实参与过对比的。
   */
  const compB = samePlatform
    ? idsB.filter((id) => hasDetailB.has(id) && (!otherIds.has(id) || !hasDetailA.has(id))).length
    : candidatesB;
  const count = common.length;
  /*
   * 同平台并集 = 两侧可比 ID 的并集 = compA + compB + noDetail.length。
   *
   * 为什么单独加 noDetail.length：有一类歌两边都有、ID 也对得上，但**两边都取不到详情**
   * （下架 / 版权变动）。它们进不了「共同」（算共同必须有歌名），
   * 但也不能从并集里消失 —— 它们是实打实参与过对比的，只是没法确认是哪首歌。
   * 少了这一项，并集会小 2，比例反而偏高。
   */
  const union = samePlatform
    ? compA + compB + noDetail.length
    : candidatesA + candidatesB - count;
  // 歌单读到的条目数（只作参考，不参与 union；「占较小歌单」那一栏用得到）
  const sizeA = idsA.length;
  const sizeB = idsB.length;
  /*
   * 「占较小歌单」的分母用**读到的歌单条目数**，不是参与对比的数量。
   * 想清楚它回答的问题：TA 的歌单我有几成 —— 那分母就该是 TA 歌单的大小。
   * （用参与对比的数量当分母会算出一个既不是「占歌单」也不是「占并集」的东西；
   *   曾经就是在这上面栽过：620 首的 B 侧比完只剩 532 首可比，分子 88 除以 532 = 16.5%，
   *   而「TA 歌单 620 首里有 88 首在你这」是 14.2% —— 后者才是用户要的答案。）
   */
  const smaller = Math.min(sizeA, sizeB);

  // 被排除的歌：有 ID 但拿不到详情，所以既没进分子也没进分母
  const excludedA = samePlatform
    ? idsA.filter((id) => !hasDetailA.has(id)).length
    : idsA.filter((id) => !ad.songs.get(id) || !fingerprint(ad.songs.get(id))).length;
  const excludedB = samePlatform
    ? idsB.filter((id) => !hasDetailB.has(id)).length
    : idsB.filter((id) => !bd.songs.get(id) || !fingerprint(bd.songs.get(id))).length;

  const warnings = [];
  for (const [side, ad2] of [[a, ad], [b, bd]]) {
    if (side.partial) {
      warnings.push(
        `${side.label} 侧（${getPlatform(side.platform).label}）没读全：${side.note || '只读到部分歌曲'}。` +
          `这一侧的歌曲总数只按读到的算，重合度会偏低。`
      );
    }
    if (side.guessed) {
      warnings.push(
        `${side.label} 侧填的是纯数字，按 ${getPlatform(side.platform).label} 读到的。` +
          `如果不对，请直接粘贴完整链接。`
      );
    }
    /*
     * 截断警告以前是死代码：loadDetails() 把 truncated 放在自己的返回对象上，
     * 这里却检查 loadSide() 那个对象上的 side.truncated，永远为 false。
     */
    if (ad2.truncated) {
      warnings.push(
        `${side.label} 侧歌曲太多，只取了前 ${DETAIL_CAP} 首参与对比。` +
          `重合度是拿这 ${DETAIL_CAP} 首算的，不代表整个歌单。`
      );
    }
  }
  if (excludedA || excludedB) {
    warnings.push(
      `有 ${excludedA + excludedB} 首拿不到歌曲信息（多半已经下架或版权变动），` +
        `没法参与对比，已经从两边和比例里都排除了 —— 剩下的数字仍然只代表参与对比的那些歌。`
    );
  }
  if (noDetail.length) {
    warnings.push(
      `其中 ${noDetail.length} 首两边都有、ID 也对得上，但都没法确认歌曲信息，所以没算进「共同歌曲」。`
    );
  }
  if (!samePlatform) {
    warnings.push(
      `两个平台不是同一家，歌曲 ID 体系不同，所以这里用的是「同名 + 同歌手」的匹配口径，` +
        `比同平台的 ID 精确匹配要宽松。`
    );
  }

  return {
    ok: true,
    matchMode: samePlatform ? 'id' : 'name',
    samePlatform,
    platforms: { a: a.platform, b: b.platform },
    canPlay: PLATFORM_IDS.some((p) => getPlatform(p)?.canPlay),
    elapsedMs: Date.now() - started,
    a: {
      platform: a.platform,
      id: a.id,
      name: a.name,
      cover: a.cover,
      nickname: a.nickname,
      avatar: a.avatar,
      isFavorites: a.isFavorites,
      total: a.trackCount,
      read: sizeA,
      partial: !!a.partial,
      note: a.note || '',
      // 本次真正参与统计的数量（read 是「读到的歌单条目数」，两者可能不等）
      comparable: compA,
    },
    b: {
      platform: b.platform,
      id: b.id,
      name: b.name,
      cover: b.cover,
      nickname: b.nickname,
      avatar: b.avatar,
      isFavorites: b.isFavorites,
      total: b.trackCount,
      read: sizeB,
      partial: !!b.partial,
      note: b.note || '',
      // 本次真正参与统计的数量（read 是「读到的歌单条目数」，两者可能不等）
      comparable: compB,
    },
    total: { a: sizeA, b: sizeB },
    common: {
      count,
      /*
       * 两个比例的分母**都是** union —— 分子分母同源是这里唯一的规矩。
       * ratioOfSmaller 原来用 min(歌单总数) 做分母，遇到拿不到详情的歌会静默偏低，
       * 所以现在跟 ratioOfUnion 取同一个分母；想知道「占整个歌单多少」看 ratioOfPlaylist。
       */
      ratioOfSmaller: union ? count / union : 0,
      ratioOfUnion: union ? count / union : 0,
      ratioOfPlaylist: smaller ? count / smaller : 0,
      union,
      comparable: { a: compA, b: compB },
      excluded: { a: excludedA, b: excludedB },
      noDetail: noDetail.length,
      // 跨平台时 unmatched 意义不大，只透传计数方便排查
      unmatched: { a: unmatchedA.length, b: unmatchedB.length },
    },
    variants,
    songs: common,
    warnings,
  };
}

/* ------------------------------------------------------------------ *
 * 多人对比（3 人及以上）
 * ------------------------------------------------------------------ */

/**
 * 两个人走 compare()：那条路有 ID 精确匹配、指纹宽松匹配、被排除数量这些细节。
 * 三五个人就没法再讲「A 的 ID 也在 B 里」这种两两边关系了，所以换一个更直白的口径：
 *   共同歌曲   = 每一个人都有这首
 *   至少两人有 = 两个人以上有这首（顺手给出，方便看「谁和谁更近」）
 *
 * 匹配键统一用「歌名 + 完整歌手名单」的指纹：
 * 同平台同 ID 天然落在同一个键上，跨平台也只靠指纹对齐，不依赖 ID 体系。
 */
export async function compareMany({ raws }, deps = {}) {
  const doLoadSide = deps.loadSide || loadSide;
  const doLoadDetails = deps.loadDetails || loadDetails;
  const started = Date.now();

  const list = (Array.isArray(raws) ? raws : []).map((r) => String(r ?? '').trim()).filter(Boolean);
  if (list.length < 2) throw new HttpError(400, '至少要有两个人的歌单');
  if (list.length > 8) throw new HttpError(400, '一次最多比 8 个人');

  const sides = [];
  for (let i = 0; i < list.length; i++) sides.push(await doLoadSide(list[i], String(i + 1)));
  const details = await Promise.all(sides.map((s) => doLoadDetails(s)));

  // 每一侧建一张「指纹 → 代表性那首歌」的表；同一指纹只留第一条，避免单侧重复条目重复计数
  const per = details.map((d) => {
    const byKey = new Map();
    for (const id of d.allIds) {
      const song = d.songs.get(id);
      const fp = song && fingerprint(song);
      if (!fp) continue;
      if (!byKey.has(fp)) byKey.set(fp, { id, song });
    }
    return byKey;
  });

  const keyCount = new Map();
  for (const m of per) for (const k of m.keys()) keyCount.set(k, (keyCount.get(k) || 0) + 1);
  const union = keyCount.size;
  const everyKey = [...keyCount].filter(([, n]) => n === per.length).map(([k]) => k);
  const twoKey = [...keyCount].filter(([, n]) => n >= 2).map(([k]) => k);

  const pack = (keys) =>
    keys.map((key) => {
      const holders = [];
      per.forEach((m, i) => { if (m.has(key)) holders.push(i); });
      const first = per[holders[0]].get(key);
      const s = first.song;
      return {
        key,
        id: first.id,
        name: s.name,
        artists: s.artists,
        album: s.album,
        cover: s.cover || '',
        dt: s.dt,
        platform: sides[holders[0]].platform,
        holders,
        audio: { platform: sides[holders[0]].platform, id: first.id },
      };
    });

  const songs = pack(everyKey);
  const atLeastTwoSongs = pack(twoKey);
  const reads = details.map((d) => d.allIds.length);
  const smallest = Math.min(...reads);

  const warnings = [];
  sides.forEach((side, i) => {
    const label = `${i + 1}. ${side.nickname || side.name || '这个人'}`;
    if (side.partial) {
      warnings.push(`${label} 的歌单没读全：${side.note || '只读到部分歌曲'}，这个人的首数按读到的算。`);
    }
    if (side.guessed) {
      warnings.push(`${label} 填的是纯数字，按 ${getPlatform(side.platform).label} 读到的。如果不对，请贴完整链接。`);
    }
    if (details[i].truncated) {
      warnings.push(`${label} 的歌单太大，只取了前 ${DETAIL_CAP} 首参与对比。`);
    }
  });
  const dropped = reads.reduce((n, r, i) => n + (r - per[i].size), 0);
  if (dropped) {
    warnings.push(`有 ${dropped} 首拿不到歌曲信息（多半已下架或版权变动），没参与对比 —— 比例是按真正参与的那些算的。`);
  }
  const platforms = [...new Set(sides.map((s) => s.platform))];
  if (platforms.length > 1) {
    warnings.push('里面有几个平台，歌曲 ID 体系不同，所以用的是「同名 + 同歌手」的匹配口径，比同平台的 ID 精确匹配要宽松。');
  }

  return {
    ok: true,
    kind: 'group',
    people: sides.length,
    canPlay: PLATFORM_IDS.some((p) => getPlatform(p)?.canPlay),
    elapsedMs: Date.now() - started,
    platforms,
    sides: sides.map((side, i) => ({
      index: i,
      label: side.label,
      platform: side.platform,
      name: side.name,
      nickname: side.nickname,
      cover: side.cover,
      avatar: side.avatar,
      isFavorites: side.isFavorites,
      total: side.trackCount,
      read: reads[i],
      comparable: per[i].size,
      partial: !!side.partial,
      note: side.note || '',
    })),
    total: reads,
    smallest,
    common: {
      count: songs.length,
      // 分母只数「读到的条目」，不数歌单自报的 trackCount：自报数可能比实际能读到的多
      ratioOfPlaylist: smallest ? songs.length / smallest : 0,
      ratioOfUnion: union ? songs.length / union : 0,
      union,
    },
    atLeastTwo: { count: atLeastTwoSongs.length, songs: atLeastTwoSongs },
    songs,
    warnings,
  };
}

/* ------------------------------------------------------------------ *
 * 播放地址
 * ------------------------------------------------------------------ */

/**
 * 批量取播放地址。
 * 请求体形如 { groups: [{platform, ids:[...]}, ...] }，
 * 也兼容旧写法 { ids:[...] }（按第一个平台的 ids 处理，用 platform 字段指定）。
 * 返回 { ok, items: { 'platform:id': {playable, fee, reason} }, canPlay }
 */
async function resolveAudioGroups(body) {
  let groups = [];
  if (Array.isArray(body?.groups)) {
    groups = body.groups
      .map((g) => ({
        platform: String(g?.platform || ''),
        ids: [...new Set((Array.isArray(g?.ids) ? g.ids : []).map(String))].filter(Boolean),
      }))
      .filter((g) => g.platform && g.ids.length);
  } else if (Array.isArray(body?.ids)) {
    const platform = String(body?.platform || ORDER[0]);
    groups = [
      { platform, ids: [...new Set(body.ids.map(String))].filter(Boolean) },
    ];
  }

  const items = {};
  const notes = [];

  for (const g of groups) {
    const platform = getPlatform(g.platform);
    if (!platform) {
      for (const id of g.ids) items[`${g.platform}:${id}`] = { playable: false, reason: 'unknown-platform' };
      continue;
    }

    if (platform.canPlay === false) {
      for (const id of g.ids) items[`${g.platform}:${id}`] = { playable: false, reason: 'no-audio-api' };
      notes.push(`${platform.label}：${platform.limitNote || '这个平台拿不到播放地址'}`);
      continue;
    }

    // 回调给前端做分批，这里再兜一层：单次最多 3000 首
    const ids = g.ids.slice(0, 3000);
    if (ids.length < g.ids.length) {
      notes.push(`${platform.label}：一次最多查 3000 首，本次只查了前 3000 首。`);
    }

    let map;
    try {
      map = await platform.fetchAudio(ids);
    } catch (e) {
      notes.push(`${platform.label}：取播放地址失败（${e?.message || e}）。`);
      for (const id of ids) items[`${g.platform}:${id}`] = { playable: false, reason: 'error' };
      continue;
    }

    for (const id of ids) {
      const hit = map.get(id) || map.get(Number(id));
      if (!hit) {
        items[`${g.platform}:${id}`] = { playable: false, reason: 'unknown' };
      } else {
        items[`${g.platform}:${id}`] = {
          playable: !!hit.playable,
          fee: Number(hit.fee) || 0,
          reason: hit.playable ? 'ok' : hit.fee ? 'vip' : 'restricted',
        };
      }
    }
  }

  return { ok: true, items, notes };
}

/* ------------------------------------------------------------------ *
 * 静态文件
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res) {
  const urlPath = (req.url || '/').split('?')[0];
  let rel;
  try {
    rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  } catch {
    fail(res, 400, '路径编码不对');
    return;
  }
  const file = path.join(PUBLIC_DIR, rel);
  /*
   * 必须带上分隔符再比：只写 startsWith(PUBLIC_DIR) 的话，
   * 名字以 "public" 开头的同级目录（比如 public-old/）也会被放行。
   * 这里已经不需要额外防 `..` —— path.join 会先归一化，穿越到 public 之外就落不进来。
   */
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    fail(res, 403, '不允许访问');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      fail(res, 404, '页面不存在');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const route = url.pathname;

  /*
   * 把请求的 Origin 挂到 res 上，给 send() 算 CORS 头用。
   * 不用闭包传参是因为 send() 被几十处调用，改签名不值当。
   */
  res.__origin = String(req.headers.origin || '');

  try {
    /*
     * Host 头白名单。开了 --lan，这个端口就暴露在同网段里了，而「同网段」不等于
     * 「自己人」：一台被访问过的恶意网页可以把某个域名解析到内网 IP（DNS rebinding），
     * 然后以自己域名的名义去调这个服务。请求会带着那个域名的 Host 过来，认不出来就拒。
     * 默认模式（只听 127.0.0.1）也顺手挡掉「本机上的网页用一个陌生 Host 摸进来」。
     */
    const hostname = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (hostname && !ALLOWED_HOSTS.has(hostname)) {
      send(res, 403, { ok: false, error: `不认这个地址：${hostname}。请用本机地址访问。` });
      return;
    }

    /*
     * **任意网页**都能往这个端口发请求：一个 <form> 提交就是一次不带预检的跨站 POST。
     * 所以 POST 一律要求 application/json —— 表单发不出这个 Content-Type，
     * 跨站 JS 想发就得先过 CORS 预检，而本服务不回 CORS 头（--lan 下也只回给本机来源，
     * 见 corsHeaders），浏览器会拦下来。自己的前端本来就是这么发的（fetch + JSON）。
     */
    if (req.method === 'POST') {
      const ct = String(req.headers['content-type'] || '').toLowerCase();
      if (!ct.includes('application/json')) {
        send(res, 415, { ok: false, error: '这个接口只接受 application/json 的请求体' });
        return;
      }
    }

    // —— 平台清单与输入提示
    if (route === '/api/platforms') {
      send(res, 200, { ok: true, platforms: PLATFORM_LIST, hints: allHints() });
      return;
    }

    if (route === '/api/health') {
      send(res, 200, { ok: true, version: PKG.version, platforms: PLATFORM_IDS });
      return;
    }

    // —— 读单侧歌单（前端预览用）
    if (route === '/api/playlist' && req.method === 'POST') {
      const body = await readJson(req);
      const side = await loadSide(body?.input, body?.label || 'A');
      send(res, 200, {
        ok: true,
        platform: side.platform,
        id: side.id,
        name: side.name,
        cover: side.cover,
        nickname: side.nickname,
        avatar: side.avatar,
        isFavorites: side.isFavorites,
        total: side.trackCount,
        read: side.trackIds.length,
        partial: !!side.partial,
        note: side.note || '',
      });
      return;
    }

    // —— 对比
    if (route === '/api/compare' && req.method === 'POST') {
      const body = await readJson(req);
      if (!body?.aRaw || !body?.bRaw) {
        fail(res, 400, '请把左右两个歌单链接都填上');
        return;
      }
      const data = await compare({ aRaw: body.aRaw, bRaw: body.bRaw });
      send(res, 200, data);
      return;
    }

    // —— 多人对比（3 人及以上；2 个人仍然走上面那条，口径更严格）
    if (route === '/api/compare-many' && req.method === 'POST') {
      const body = await readJson(req);
      const raws = Array.isArray(body?.raws) ? body.raws : [];
      if (raws.filter((r) => String(r || '').trim()).length < 2) {
        fail(res, 400, '至少要把两个人的歌单链接填上');
        return;
      }
      const data = await compareMany({ raws });
      send(res, 200, data);
      return;
    }

    // —— 对比记录：本机存一份，谁也别想拿走（不上传、不带账号）
    if (route === '/api/history') {
      if (req.method === 'GET') {
        const h = await readHistory();
        send(res, 200, { ok: true, items: h.items.slice(0, 30) });
        return;
      }
      if (req.method === 'POST') {
        const b = await readJson(req);
        const item = makeHistoryItem(b);
        if (!item) {
          fail(res, 400, '记录要带两边歌单链接和共同数');
          return;
        }
        const h = await readHistory();
        // 同一组歌单再比一次：旧的替换掉，别在列表里堆重复
        const same = (x) => {
          if (Array.isArray(item.raws) && item.raws.length >= 3) {
            return Array.isArray(x.raws) && x.raws.join('\n') === item.raws.join('\n');
          }
          return !Array.isArray(x.raws) && x.a?.link === item.a.link && x.b?.link === item.b.link;
        };
        h.items = [item, ...h.items.filter((x) => !same(x))];
        if (h.items.length > 100) h.items = h.items.slice(0, 100);
        await writeHistory(h);
        send(res, 200, { ok: true, item, total: h.items.length });
        return;
      }
      if (req.method === 'DELETE') {
        await writeHistory({ items: [] });
        send(res, 200, { ok: true, total: 0 });
        return;
      }
    }

    if (route === '/api/history/remove' && req.method === 'POST') {
      const b = await readJson(req);
      const h = await readHistory();
      const before = h.items.length;
      h.items = h.items.filter((x) => x.id !== b?.id);
      await writeHistory(h);
      send(res, 200, { ok: true, removed: before - h.items.length, total: h.items.length });
      return;
    }

    // —— 批量问「这些歌能不能放」
    if (route === '/api/audio-url' && req.method === 'POST') {
      const body = await readJson(req);
      const data = await resolveAudioGroups(body);
      send(res, 200, data);
      return;
    }

    // —— 音频流（透传 Range，进度条才能拖）
    if (route === '/api/audio') {
      const platformId = url.searchParams.get('platform') || '';
      const sid = url.searchParams.get('sid') || url.searchParams.get('id') || '';
      if (!sid) {
        fail(res, 400, '缺少 sid');
        return;
      }

      // 没指定平台（或指定了拿不到地址的平台）时，按优先级挨个试
      const tryOrder = platformId ? [platformId, ...ORDER.filter((p) => p !== platformId)] : ORDER;
      let target = '';
      let used = '';
      for (const pid of tryOrder) {
        const platform = getPlatform(pid);
        if (!platform || platform.canPlay === false) continue;
        try {
          const map = await platform.fetchAudio([String(sid)]);
          const hit = map.get(String(sid)) || map.get(Number(sid));
          if (hit?.playable && hit.url) {
            target = hit.url;
            used = pid;
            break;
          }
        } catch {
          // 这家不行就换下一家
        }
      }

      if (!target) {
        const p = getPlatform(platformId);
        const why = p && p.canPlay === false ? p.limitNote || `${p.label}拿不到播放地址` : '这首歌当前听不了（多半是 VIP 专享或者拿不到授权）';
        fail(res, 404, why, { canPlay: !(p && p.canPlay === false) });
        return;
      }

      // 音频是流式的：用户拖进度条、关页面、切歌都会让这里以 "aborted" 结束。
      // 这是常态，不是故障，所以就地吞掉，别让它冒到进程级兜底里去刷屏。
      streamAudio(req, res, target, getPlatform(used).audioHeaders())
        .catch(() => { /* 客户端提前断开，正常 */ });
      return;
    }

    if (route.startsWith('/api/')) {
      fail(res, 404, `没有这个接口：${route}`);
      return;
    }

    serveStatic(req, res);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status >= 500) console.error('[500]', route, e);
    fail(res, status, e?.message || '服务器出错了');
  }
});

/*
 * 被 import 进来（跑测试）时不要起 HTTP 服务：
 * 端口可能被真实服务占着，测试也不需要它。
 */
if (IS_MAIN && !PROBE_ONLY) {
  /*
   * `--print-port` 还有第二个用法：把这份 JSON 落到 `.started.json`。
   * 起因是 Windows 的「手机访问.bat」——batch 拿不到后台进程的 stdout，
   * 又没法可靠地问出「本机该用哪个局域网地址」（虚拟网卡会混进来）。
   * 让服务自己把地址写成一个文件、脚本轮询它，比在 bat 里猜 IP 靠谱得多。
   */
  const STARTED_FILE = path.join(__dirname, '.started.json');
  const STARTED_URL_FILE = path.join(__dirname, '.started.url');
  /*
   * 退出时擦掉：留着一个过期的地址文件会让下次的「手机访问.bat」认错地址。
   * 用 'exit' 事件而不是 process.on('SIGINT')，因为 Ctrl+C / 关窗口 / 报错退出
   * 都会走到 'exit'，覆盖得更全。
   *
   * 但只擦「自己写过的」：端口被占用时也会走到这里，那种情况下 .started.url 是
   * 正在跑的那台（和启动器刚写的那份）的，擦掉就成了「启动了反而把地址弄丢了」。
   */
  let wroteUrlFile = false;
  process.on('exit', () => {
    for (const f of [STARTED_FILE, ...(wroteUrlFile ? [STARTED_URL_FILE] : [])]) {
      try { fs.unlinkSync(f); } catch { /* 没写过就算了 */ }
    }
  });

  server.listen(PORT, BIND_HOST, () => {
    /*
     * 给启动器的机器可读输出：`--print-port` 时第一行就是 JSON（里面带 url）。
     * POSIX shell 没有「取一个后台进程的 stdout」这种便宜办法，所以约定成
     * 「输出重定向到临时文件，第一行是 JSON」，Mac / Linux 的启动脚本用 sed 从中抠出地址。
     */
    if (PRINT_PORT) {
      const info = {
        ok: true,
        port: PORT,
        url: `http://127.0.0.1:${PORT}`,
        lan: LAN ? LAN_NAMES.map((ip) => `http://${ip}:${PORT}`) : [],
      };
      console.log(JSON.stringify(info));
      /*
       * 顺手落两个文件，给「手机访问」的启动脚本轮询用（见 STARTED_FILE 的注释）：
       *   .started.json —— 完整信息（端口、地址、候选地址）
       *   .started.url  —— 只有一行地址，给懒得解析 JSON 的 .bat 直接 type 出来
       */
      try {
        fs.writeFileSync(STARTED_FILE, JSON.stringify(info), 'utf8');
        const phoneUrl = info.lan[0] || '';
        if (phoneUrl) {
          fs.writeFileSync(STARTED_URL_FILE, phoneUrl, 'utf8');
          wroteUrlFile = true;
        }
      } catch { /* 写不进去也不影响服务本身 */ }
    }
    console.log('');
    console.log('  音乐歌单重合度对比  已启动');
    console.log('  ────────────────────────────────────────');
    console.log(`  打开浏览器访问：  http://127.0.0.1:${PORT}`);
    if (LAN) {
      if (PRIMARY_LAN) {
        console.log('');
        console.log(`  手机（同一个 WiFi）打开：  http://${PRIMARY_LAN}:${PORT}`);
        for (const { name, address } of LAN_IPS.slice(1)) {
          console.log(`      连不上就换这个：        http://${address}:${PORT}   （${name}）`);
        }
        console.log('  · 电脑别关，手机上取歌单和放歌都还是这台电脑在干活');
        console.log('  · 用不上了就 Ctrl+C 停掉（开着等于把这个端口交给同网段）');
      } else {
        console.log('');
        console.log('  [注意] --lan 开了，但没找到局域网地址：确认电脑连上了 WiFi 或网线。');
      }
    }
    console.log(`  支持平台：${PLATFORM_LIST.map((p) => p.label + (p.canPlay ? '' : '（仅对比）')).join(' / ')}`);
    console.log('  按 Ctrl+C 停止');
    console.log('');
  });

  /*
   * 端口被占用：这是双击启动时最容易撞上的情况（上次没关干净，或者开了两个）。
   * 必须给一句人话 + 非零退出码——启动器靠退出码判断要不要提示换端口，
   * 靠这行字告诉用户到底发生了什么。
   */
  server.on('error', (err) => {
    if (err?.code === 'EADDRINUSE') {
      console.error('');
      console.error(`  [端口被占用] ${BIND_HOST}:${PORT} 已经有一个程序在用了。`);
      console.error('');
      console.error('  可能是：');
      console.error(`    · 你之前开的这个工具还没关（那就直接用浏览器打开 http://127.0.0.1:${PORT}）`);
      console.error('    · 别的程序占了这个端口（那就换一个：双击「换个端口启动.bat」）');
      console.error('');
      /*
       * 但「占着端口的正好是这个工具自己」是最常见的一种——上次的窗口没关，
       * 用户又双击了一次启动器。那种情况下退出码 1 会把他引到「换个端口启动」，
       * 而真正需要的东西（手机该输的那个网址）反而被这行报错盖住了。
       *
       * 所以这里**同步**探一次 /api/health：确认对面是本工具之后，把地址重新落盘
       * （启动器已经把它删了）、把地址打印出来，然后以 0 退出——启动器看到 0
       * 就当作正常结束，不会再劝用户换端口、也不会白等这 10 秒。
       */
      const me = probeExistingSync(PORT);
      if (me?.ok) {
        console.log('');
        console.log('  这个工具其实已经在运行了，不用再开一个：');
        console.log(`    浏览器访问：  ${me.url}`);
        if (me.lan?.length) {
          console.log(`    手机（同一个 WiFi）打开：  ${me.lan[0]}`);
          if (me.lan[1]) console.log(`    连不上就换这个：  ${me.lan[1]}`);
          try {
            fs.writeFileSync(STARTED_URL_FILE, me.lan[0], 'utf8');
            /*
             * 标成「我写的」是不对的：这份地址是**正在跑的那台**的，本进程只是
             * 把它补回去。退出时不该把它擦掉——擦掉等于「再启动一次，地址就没了」。
             */
            wroteUrlFile = false;
          } catch { /* 写不进去也不影响 */ }
        }
        console.log('  （要重开的话，先把上次那个窗口关掉）');
        console.log('');
        process.exit(0);
      }
      process.exit(1);
    }
    console.error('  服务启动失败：', err?.message || err);
    process.exit(1);
  });
}
