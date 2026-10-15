/**
 * 音乐歌单重合度对比 —— 本地服务
 *
 * 支持网易云音乐 / QQ 音乐 / 酷狗音乐三个平台，可以同平台对比，也可以跨平台对比。
 * 零第三方依赖，只用 Node 内置模块。
 *
 * 启动：node server.mjs [端口]       默认 8787
 * 走代理：node server.mjs --proxy=http://127.0.0.1:7890   或设置环境变量 MUSIC_PROXY
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ORDER,
  PLATFORM_LIST,
  PLATFORM_IDS,
  getPlatform,
  allHints,
  parseInput,
} from './platforms/index.mjs';
import { resolveProxy, HttpError, streamAudio } from './platforms/shared.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

/*
 * 是在跑服务，还是被 import 进来做测试？
 * _dev/api-check.mjs 要能把 compare() 拆出来单独喂假数据跑（不然那些测试只能靠真实网络），
 * 所以被 import 时不要起 HTTP 服务、也不要打印启动横幅。
 */
const IS_MAIN = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

const ARGV = process.argv.slice(2);
const PORT = Number(ARGV.find((a) => /^\d+$/.test(a))) || 8787;
/*
 * `--print-port`：启动后第一行输出机器可读的 JSON（含真实端口）。
 * Mac / Linux 的启动脚本靠它拿到端口——POSIX shell 没有便宜的办法读后台进程的 stdout。
 */
const PRINT_PORT = ARGV.includes('--print-port');
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
const PKG = { version: '0.3.1' };

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

const send = (res, status, body, headers = {}) => {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
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
        '这段内容里没认出歌单。请直接粘贴歌单链接（网易云 / QQ 音乐 / 酷狗的歌单页都行），' +
        '或者粘贴歌单的数字 ID。',
      candidates: [],
    };
  }
  const list = Array.isArray(hit) ? hit : [hit];
  const usable = list.filter((c) => c && c.id);
  if (!usable.length) return { error: '没能从这段内容里认出歌单，请直接粘贴歌单链接', candidates: [] };
  return { candidates: usable, error: '' };
}

/** 按候选顺序依次尝试，返回第一个成功的 */
async function loadSide(raw, label) {
  const { candidates, error } = buildCandidates(raw);
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

  try {
    /*
     * 这个服务只监听 127.0.0.1，但**本机上的任意网页**都能往这个端口发请求：
     * 一个 <form> 提交就是一次不带预检的跨站 POST。
     * 所以 POST 一律要求 application/json —— 表单发不出这个 Content-Type，
     * 想跨站调就得先过 CORS 预检，而本服务从不回 CORS 头，浏览器会拦下来。
     * 自己的前端本来就是这么发的（fetch + Content-Type: application/json）。
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
if (IS_MAIN) {
  server.listen(PORT, '127.0.0.1', () => {
    /*
     * 给启动器的机器可读输出：`--print-port` 时第一行就是 JSON（里面带 url）。
     * POSIX shell 没有「取一个后台进程的 stdout」这种便宜办法，所以约定成
     * 「输出重定向到临时文件，第一行是 JSON」，Mac / Linux 的启动脚本用 sed 从中抠出地址。
     */
    if (PRINT_PORT) {
      console.log(JSON.stringify({ ok: true, port: PORT, url: `http://127.0.0.1:${PORT}` }));
    }
    console.log('');
    console.log('  音乐歌单重合度对比  已启动');
    console.log('  ────────────────────────────────────────');
    console.log(`  打开浏览器访问：  http://127.0.0.1:${PORT}`);
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
      console.error(`  [端口被占用] 127.0.0.1:${PORT} 已经有一个程序在用了。`);
      console.error('');
      console.error('  可能是：');
      console.error(`    · 你之前开的这个工具还没关（那就直接用浏览器打开 http://127.0.0.1:${PORT}）`);
      console.error('    · 别的程序占了这个端口（那就换一个：双击「换个端口启动.bat」）');
      console.error('');
      process.exit(1);
    }
    console.error('  服务启动失败：', err?.message || err);
    process.exit(1);
  });
}
