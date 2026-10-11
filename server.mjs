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

const PORT = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a))) || 8787;
resolveProxy(process.argv.slice(2));

/*
 * 兜底：这个服务是给普通用户双击 bat 用的，普通用户不会看黑窗口里滚了什么，
 * 更不会去重启它。所以任何一条漏网的 socket 错误（比如远端 RST）
 * 都不该让进程直接消失——那种情况下表现就是「网页突然打不开了」，
 * 用户完全不知道发生了什么。宁可留一条记录继续跑。
 */
process.on('uncaughtException', (err) => {
  console.error(`[${new Date().toLocaleTimeString('zh-CN')}] 忽略了一个未捕获异常，服务继续运行：`, err?.message || err);
});
process.on('unhandledRejection', (err) => {
  console.error(`[${new Date().toLocaleTimeString('zh-CN')}] 忽略了一个未处理的 Promise 拒绝，服务继续运行：`, err?.message || err);
});

const DETAIL_CAP = 8000; // 每侧最多取这么多首的详情，防呆
const MAX_BODY = 4 * 1024 * 1024; // 请求体上限

/** 挂起的凭证：只放在服务端内存里，绝不落盘、绝不进 URL */
const cookies = { netease: '', qq: '' };

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
    const cookie = cookies[cand.platform] || '';
    try {
      const pl = await platform.fetchPlaylist(cand.id, cookie);
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
  const map = await platform.fetchSongs(use, cookies[side.platform] || '', side.raw, side.cover);
  // 统一成字符串 id，跨平台比较时不会因为类型不同而错位
  const norm = new Map();
  for (const [k, v] of map) norm.set(String(k), v);
  return { platform: side.platform, ids: use, truncated, allIds: ids, songs: norm };
}

/**
 * 核心对比。
 * 同平台：按「歌曲 ID 相同」算，这是最严格也最准的口径。
 * 跨平台：不同平台 ID 体系不同，只能按「同名 + 同歌手」算（不剥括号，宁少不虚）。
 */
async function compare({ aRaw, bRaw }) {
  const started = Date.now();

  const a = await loadSide(aRaw, 'A');
  const b = await loadSide(bRaw, 'B');
  const samePlatform = a.platform === b.platform;

  const [ad, bd] = await Promise.all([loadDetails(a), loadDetails(b)]);

  const setA = new Set(ad.allIds);
  const setB = new Set(bd.allIds);
  let union = 0;
  for (const id of setA) union++;
  for (const id of setB) if (!setA.has(id)) union++;

  const common = [];
  const variants = [];
  const unmatchedA = [];
  const unmatchedB = [];
  const usedB = new Set();

  if (samePlatform) {
    // —— 同平台：ID 严格相等
    for (const id of ad.allIds) {
      if (setB.has(id)) {
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
    }
    // 宽松口径：ID 不同但同名同歌手（现场版、Remaster 之类）
    // 两个容易踩的点：
    //   1) A 侧**不能**把「ID 也在 B 里」的歌排除掉——同一首歌两边各有一条 ID 不同的记录时，
    //      那条记录正是 B 侧另一条记录的唯一配对对象，排掉就会漏。B 侧循环里的 setA.has(id) 已经足够。
    //   2) 只有**真正取到详情**的歌才能进指纹表。歌单里存在详情拉不回来的条目（下架 / 版权变动），
    //      只按 trackId 建表会拿一条「名字未知」的空记录去配 B 侧的歌，凭空造出一对假的同名版本。
    const fpA = new Map();
    for (const id of ad.allIds) {
      const s = ad.songs.get(id);
      if (!s) continue;
      const fp = fingerprint(s);
      if (!fp) continue;
      if (!fpA.has(fp)) fpA.set(fp, []);
      fpA.get(fp).push(id);
    }
    for (const id of bd.allIds) {
      if (setA.has(id)) continue;
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
  } else {
    // —— 跨平台：只能靠「同名 + 同歌手」对上，如实标出这是宽松口径
    const byFp = new Map();
    for (const id of bd.allIds) {
      const fp = fingerprint(bd.songs.get(id));
      if (!fp) continue;
      if (!byFp.has(fp)) byFp.set(fp, []);
      byFp.get(fp).push(id);
    }
    for (const id of ad.allIds) {
      const songA = ad.songs.get(id);
      const fp = fingerprint(songA);
      if (!fp) continue;
      const bucket = byFp.get(fp);
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
    for (const id of bd.allIds) {
      if (usedB.has(id)) continue;
      const songB = bd.songs.get(id);
      unmatchedB.push({ id, name: songB?.name || '', artists: songB?.artists || '' });
    }
  }

  const sizeA = ad.allIds.length;
  const sizeB = bd.allIds.length;
  const smaller = Math.min(sizeA, sizeB);
  const count = common.length;

  const warnings = [];
  for (const side of [a, b]) {
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
    if (side.truncated) {
      warnings.push(`${side.label} 侧歌曲太多，只取了前 ${DETAIL_CAP} 首参与对比。`);
    }
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
    },
    total: { a: sizeA, b: sizeB },
    common: {
      count,
      ratioOfSmaller: smaller ? count / smaller : 0,
      ratioOfUnion: union ? count / union : 0,
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
      map = await platform.fetchAudio(ids, cookies[g.platform] || '');
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
  if (!file.startsWith(PUBLIC_DIR)) {
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
    // —— 平台清单与输入提示
    if (route === '/api/platforms') {
      send(res, 200, { ok: true, platforms: PLATFORM_LIST, hints: allHints() });
      return;
    }

    if (route === '/api/health') {
      send(res, 200, { ok: true, version: '0.3.0', platforms: PLATFORM_IDS });
      return;
    }

    // —— 填 / 清登录凭证（只存内存，进程退出就没了）
    if (route === '/api/cookie' && req.method === 'POST') {
      const body = await readJson(req);
      for (const id of ORDER) {
        if (typeof body?.[id] === 'string') cookies[id] = body[id].trim();
      }
      send(res, 200, {
        ok: true,
        has: Object.fromEntries(ORDER.map((id) => [id, !!cookies[id]])),
      });
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
          const map = await platform.fetchAudio([String(sid)], cookies[pid] || '');
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

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  音乐歌单重合度对比  已启动');
  console.log('  ────────────────────────────────────────');
  console.log(`  打开浏览器访问：  http://127.0.0.1:${PORT}`);
  console.log(`  支持平台：${PLATFORM_LIST.map((p) => p.label + (p.canPlay ? '' : '（仅对比）')).join(' / ')}`);
  if (!cookies.netease) console.log('  提示：网易云 / QQ 音乐填了登录凭证后，能播的歌会更多。');
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
