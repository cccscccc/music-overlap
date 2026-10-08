/**
 * 网易云音乐 · 两人「我喜欢的音乐」重合度对比
 * 本地服务（零依赖，只用 Node 内置模块）
 *
 * 启动： node server.mjs           默认 http://127.0.0.1:8787
 *        node server.mjs 9000      指定端口
 *        set MUSIC_PROXY=127.0.0.1:7890 && node server.mjs   走代理
 *
 * 用到的网易云公开接口：
 *   /api/v6/playlist/detail?id=X     歌单元数据 + 全量 trackIds（含创建者昵称 / 头像）
 *   /api/user/playlist?uid=X         某人的歌单列表（用来定位 specialType=5 的「我喜欢的音乐」）
 *   /api/v3/song/detail?c=[{id},..]  批量取歌曲名 / 歌手 / 专辑 / 封面
 *   /api/song/enhance/player/url/v1  取播放地址
 *
 * 对外提供的接口：
 *   POST /api/compare      对比两个歌单
 *   POST /api/audio-url    批量查询哪些歌能播（未登录时免费曲可播，VIP 曲不可）
 *   GET  /api/audio?id=X   音频流代理（透传 Range，供 <audio> 播放与拖动进度条）
 *   GET  /api/health
 */

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const argv = process.argv.slice(2);
const PORT = Number(argv.find((a) => /^\d+$/.test(a)) || process.env.PORT || 8787);
const PROXY =
  argv.find((a) => a.startsWith('--proxy='))?.slice('--proxy='.length) ||
  process.env.MUSIC_PROXY ||
  '';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE_HEADERS = {
  'User-Agent': UA,
  Referer: 'https://music.163.com/',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

const SONG_BATCH = 200; // 批量取歌曲详情的每批数量

/* ────────────────────────── 基础 HTTP ────────────────────────── */

/** 通过 HTTP 代理建立到目标主机的 CONNECT 隧道 */
function proxyTunnel(proxy, host, port, timeout) {
  return new Promise((resolve, reject) => {
    const p = new URL(/^https?:\/\//.test(proxy) ? proxy : `http://${proxy}`);
    const req = http.request({
      host: p.hostname,
      port: p.port || 8080,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { Host: `${host}:${port}`, 'Proxy-Connection': 'keep-alive' },
    });
    req.setTimeout(timeout, () => req.destroy(new Error('代理连接超时')));
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理 CONNECT 失败：HTTP ${res.statusCode}`));
        return;
      }
      resolve(socket);
    });
    req.on('error', reject);
    req.end();
  });
}

/** GET 一段文本，带超时和重试；PROXY 为空时直连 */
function getText(url, extraHeaders = {}, { timeout = 25000, retries = 2 } = {}) {
  const attempt = (left) =>
    new Promise((resolve, reject) => {
      const u = new URL(url);
      const isHttps = u.protocol === 'https:';
      const port = Number(u.port) || (isHttps ? 443 : 80);
      const mod = isHttps ? https : http;
      const options = {
        method: 'GET',
        host: u.hostname,
        port,
        path: u.pathname + u.search,
        headers: { ...BASE_HEADERS, Host: u.hostname, ...extraHeaders },
      };

      const fire = (socket) => {
        if (socket) {
          options.agent = false;
          options.createConnection = () => socket;
        }
        const req = mod.request(options, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            if (res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}`));
              return;
            }
            resolve(Buffer.concat(chunks).toString('utf8'));
          });
        });
        req.setTimeout(timeout, () => req.destroy(new Error('请求超时')));
        req.on('error', reject);
        req.end();
      };

      if (!PROXY) {
        fire(null);
        return;
      }
      proxyTunnel(PROXY, u.hostname, port, timeout)
        .then((socket) => {
          if (!isHttps) {
            fire(socket);
            return;
          }
          // CONNECT 隧道之上再套一层 TLS
          const secure = tls.connect({ socket, servername: u.hostname }, () => fire(secure));
          secure.on('error', reject);
        })
        .catch(reject);
    }).catch((err) => {
      if (left > 0) return attempt(left - 1);
      throw err;
    });

  return attempt(retries);
}

async function getJson(url, headers) {
  const text = await getText(url, headers);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('网易云返回了非 JSON 内容（可能被风控拦截，请稍后重试）');
  }
}

/* ────────────────────────── 输入解析 ────────────────────────── */

/**
 * 支持这些写法：
 *   https://music.163.com/#/my/m/music/playlist?id=429241928   ← 「我喜欢的音乐」页面链接
 *   https://music.163.com/playlist?id=429241928
 *   https://music.163.com/m/playlist?id=429241928             ← 手机分享链接
 *   429241928                                                  ← 纯歌单 ID
 *   https://music.163.com/#/user/home?id=309183355            ← 用户主页（自动找 TA 的喜欢歌单）
 */
function parseInput(raw) {
  const s = String(raw ?? '').trim();
  if (!s) throw new HttpError(400, '请先填写歌单链接');

  if (/^\d{5,}$/.test(s)) return { kind: 'auto', id: s };

  const m = s.match(/[?&#]?id=(\d+)/) || s.match(/\/(?:playlist|user)\/(\d+)/);
  if (m) {
    const looksLikeUser = /user\/home|\/user\/|user\?|music\.163\.com\/.*user/.test(s);
    return { kind: looksLikeUser ? 'user' : 'auto', id: m[1] };
  }
  if (/^\d+$/.test(s)) return { kind: 'auto', id: s };

  throw new HttpError(400, '没看懂这个链接，请直接粘贴网易云歌单页面地址，或填歌单 ID（一串数字）');
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ────────────────────────── 网易云数据 ────────────────────────── */

function normCover(url) {
  return url ? String(url).replace(/^http:/, 'https:') : '';
}

/** 取歌单：返回元数据 + 全量 trackIds */
async function fetchPlaylist(id, cookie) {
  const headers = cookie ? { Cookie: cookie } : {};
  const data = await getJson(
    `https://music.163.com/api/v6/playlist/detail?id=${encodeURIComponent(id)}&n=1`,
    headers
  );

  const pl = data?.playlist;
  if (data?.code === 404 || !pl) {
    throw new HttpError(
      404,
      `没有找到歌单 ${id}。可能链接不对，也可能这个歌单是「私密」的——` +
        `网易云不允许未登录查看私密歌单，需要对方在歌单里把它改成公开。`
    );
  }

  const rawIds = Array.isArray(pl.trackIds) ? pl.trackIds.map((t) => t && t.id).filter(Boolean) : [];
  const trackIds = [...new Set(rawIds.map(Number))];

  if (trackIds.length === 0 && Number(pl.trackCount) > 0) {
    throw new HttpError(
      404,
      `歌单「${pl.name}」读不到歌曲列表（歌单共 ${pl.trackCount} 首）。` +
        `通常是因为它是私密歌单，请让对方改为公开，或填登录 Cookie。`
    );
  }

  return {
    id: Number(pl.id),
    name: pl.name,
    cover: normCover(pl.coverImgUrl),
    userId: Number(pl.userId),
    nickname: pl.creator?.nickname || '',
    avatar: normCover(pl.creator?.avatarUrl),
    trackCount: Number(pl.trackCount) || trackIds.length,
    readCount: trackIds.length,
    specialType: Number(pl.specialType) || 0,
    privacy: Number(pl.privacy) || 0,
    isFavorites: Number(pl.specialType) === 5,
    trackIds,
  };
}

/** 从用户主页链接定位 TA 的「我喜欢的音乐」（specialType = 5） */
async function fetchUserFavorites(uid, cookie) {
  const headers = cookie ? { Cookie: cookie } : {};
  const data = await getJson(
    `https://music.163.com/api/user/playlist?uid=${encodeURIComponent(uid)}&limit=1000&offset=0`,
    headers
  );
  const list = Array.isArray(data?.playlist) ? data.playlist : [];
  const fav = list.find((p) => Number(p.specialType) === 5);
  if (!fav) {
    throw new HttpError(
      404,
      `在用户 ${uid} 的歌单里没找到「我喜欢的音乐」。` +
        `可能 TA 把它设成了私密（这种情况填歌单链接也一样看不到），` +
        `或者这个号根本没有创建过。`
    );
  }
  return fetchPlaylist(fav.id, cookie);
}

/** auto：先当歌单，不行再当用户主页 */
async function loadSide(raw, cookie, label) {
  const { kind, id } = parseInput(raw);
  try {
    if (kind === 'user') return await fetchUserFavorites(id, cookie);
    return await fetchPlaylist(id, cookie);
  } catch (err) {
    if (kind === 'auto' && err.status === 404) {
      try {
        return await fetchUserFavorites(id, cookie);
      } catch {
        /* 落到原始错误 */
      }
    }
    if (err instanceof HttpError) throw new HttpError(err.status, `${label}：${err.message}`);
    throw new HttpError(502, `${label}：${err.message}`);
  }
}

/** 批量取歌曲详情，返回 Map<id, song>（有限并发，失败的分批跳过不影响总数） */
async function fetchSongs(ids, cookie) {
  const headers = cookie ? { Cookie: cookie } : {};
  const map = new Map();
  const batches = [];
  for (let i = 0; i < ids.length; i += SONG_BATCH) batches.push(ids.slice(i, i + SONG_BATCH));

  const CONCURRENCY = 3;
  let cursor = 0;
  const worker = async () => {
    while (cursor < batches.length) {
      const batch = batches[cursor++];
      const c = encodeURIComponent(JSON.stringify(batch.map((id) => ({ id }))));
      let data;
      try {
        data = await getJson(`https://music.163.com/api/v3/song/detail?c=${c}`, headers);
      } catch {
        continue;
      }
      for (const s of data?.songs || []) {
        if (!s || !s.id) continue;
        map.set(Number(s.id), {
          id: Number(s.id),
          name: s.name || '(未知歌名)',
          artists: (s.ar || s.artists || []).map((a) => a.name).filter(Boolean).join(' / '),
          album: s.al?.name || s.album?.name || '',
          cover: normCover(s.al?.picUrl || s.album?.picUrl),
          dt: Number(s.dt || s.duration || 0),
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
  return map;
}

/* ────────────────────────── 核心：对比 ────────────────────────── */

/**
 * 做「同名同歌手」的宽松指纹，用来识别同曲的不同版本。
 * 只做字符层归一化（大小写 / 空格 / 标点），**刻意不剥掉括号**：
 * 「Love is Gone (Acoustic)」和「Love is Gone」录音不同，不该算同一首；
 * 宁可少算，也不要把不同版本混成一首虚高数字。
 */
function fingerprint(song) {
  const normalize = (t) =>
    String(t || '')
      .toLowerCase()
      .replace(/[\s\u3000]+/g, '')
      .replace(/[·・\-—–_.,，。!！?？'":：;；()（）【】\[\]{}]/g, '');
  return `${normalize(song.name)}|${normalize(song.artists)}`;
}

async function compare({ aRaw, bRaw, cookie, strict = true }) {
  const t0 = Date.now();
  if (!aRaw?.trim() || !bRaw?.trim()) throw new HttpError(400, '两边的链接都要填');

  const [a, b] = await Promise.all([
    loadSide(aRaw, cookie, '左边'),
    loadSide(bRaw, cookie, '右边'),
  ]);

  if (a.id === b.id) {
    throw new HttpError(400, `两边填的是同一个歌单（「${a.name}」），换一个再比吧`);
  }

  const setA = new Set(a.trackIds);
  const setB = new Set(b.trackIds);
  const commonIds = a.trackIds.filter((id) => setB.has(id));
  const commonSet = new Set(commonIds);
  const small = Math.min(setA.size, setB.size);
  const union = new Set([...setA, ...setB]).size;

  // 需要详情的歌曲：严格口径只要交集；宽松口径要两边全量（才能做「同名同歌手」匹配）
  const DETAIL_CAP = 8000;
  const needIds = strict
    ? commonIds
    : [...new Set([...a.trackIds, ...b.trackIds])].slice(0, DETAIL_CAP);
  const truncated = !strict && a.trackIds.length + b.trackIds.length > DETAIL_CAP;
  const detailMap = await fetchSongs(needIds, cookie);

  const songs = commonIds.map((id) => ({
    id,
    ...(detailMap.get(id) || { name: `(歌曲 ${id} 详情读取失败)`, artists: '', album: '', cover: '', dt: 0 }),
  }));

  // 宽松口径：严格交集之外，若歌名+歌手相同，也算「同一首」（网易云同曲多版本很常见）
  const variants = [];
  if (!strict) {
    const fpA = new Map();
    for (const id of a.trackIds) {
      const s = detailMap.get(id);
      if (s) fpA.set(fingerprint(s), id);
    }
    const seenFp = new Set();
    for (const id of b.trackIds) {
      if (commonSet.has(id)) continue;
      const s = detailMap.get(id);
      if (!s) continue;
      const fp = fingerprint(s);
      if (!fpA.has(fp) || seenFp.has(fp)) continue;
      seenFp.add(fp);
      const otherId = fpA.get(fp);
      variants.push({
        ...s,
        pairWith: detailMap.get(otherId) || { id: otherId, name: '', artists: '', album: '' },
      });
    }
  }

  const effectiveCommon = songs.length + variants.length;

  return {
    ok: true,
    strict,
    truncated,
    elapsedMs: Date.now() - t0,
    a: pickSide(a),
    b: pickSide(b),
    total: { a: setA.size, b: setB.size },
    common: {
      count: songs.length,
      effective: effectiveCommon,
      ratioOfSmaller: small ? effectiveCommon / small : 0,
      ratioOfUnion: union ? effectiveCommon / union : 0,
    },
    songs,
    variants,
  };
}

function pickSide(p) {
  return {
    id: p.id,
    name: p.name,
    cover: p.cover,
    nickname: p.nickname,
    avatar: p.avatar,
    userId: p.userId,
    trackCount: p.trackCount,
    readCount: p.readCount,
    isFavorites: p.isFavorites,
    privacy: p.privacy,
  };
}

/* ────────────────────────── 音频地址与播放 ────────────────────────── */

/** 最近一次请求携带的登录 Cookie：后续音频流复用，避免把凭证塞进 URL（本地单用户场景） */
let sessionCookie = '';

/** 音频地址缓存：网易给的地址带时间戳会过期，缓存要短 */
const AUDIO_TTL = 90 * 1000;
const audioCache = new Map();

/**
 * 批量取播放地址。
 * 未登录时网易云只给免费曲（fee 0 / 8）真实地址；VIP 曲（fee 1）返回 code -110 且 url 为 null。
 * 拿不到就如实标记为不可播，不伪装。
 */
async function fetchAudioUrls(ids, cookie) {
  const headers = cookie ? { Cookie: cookie } : {};
  const out = new Map();
  const BATCH = 100;
  const batches = [];
  for (let i = 0; i < ids.length; i += BATCH) batches.push(ids.slice(i, i + BATCH));

  const CONCURRENCY = 3;
  let cursor = 0;
  const worker = async () => {
    while (cursor < batches.length) {
      const batch = batches[cursor++];
      const q = encodeURIComponent(JSON.stringify(batch));
      let data;
      try {
        data = await getJson(
          `https://music.163.com/api/song/enhance/player/url/v1?ids=${q}&level=standard&encodeType=mp3`,
          headers
        );
      } catch {
        continue;
      }
      for (const d of data?.data || []) {
        if (!d || !d.id) continue;
        out.set(Number(d.id), {
          url: d.url || '',
          playable: !!d.url && Number(d.code) === 200,
          fee: Number(d.fee) || 0,
          br: Number(d.br) || 0,
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
  return out;
}

/** 解析单曲播放地址（带短缓存） */
async function resolveAudioUrl(id, cookie) {
  const key = `${id}|${cookie ? 'c' : 'n'}`;
  const hit = audioCache.get(key);
  if (hit && Date.now() - hit.at < AUDIO_TTL) return hit.url;
  const map = await fetchAudioUrls([Number(id)], cookie);
  const url = map.get(Number(id))?.url || '';
  audioCache.set(key, { url, at: Date.now() });
  if (audioCache.size > 500) {
    for (const [k, v] of audioCache) if (Date.now() - v.at > AUDIO_TTL) audioCache.delete(k);
  }
  return url;
}

/**
 * 音频流代理：代浏览器去取 mp3 再原样转发。
 * 透传 Range / 206，前端的进度条才能拖动。
 */
function streamAudio(req, res, targetUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    const port = Number(u.port) || (isHttps ? 443 : 80);
    const headers = { ...BASE_HEADERS, Host: u.hostname, Accept: '*/*' };
    if (req.headers.range) headers.Range = req.headers.range;

    let upReq = null;
    let clientGone = false;
    res.on('close', () => {
      clientGone = true;
      if (upReq) upReq.destroy();
    });

    const fire = (socket) => {
      const options = { method: 'GET', host: u.hostname, port, path: u.pathname + u.search, headers };
      if (socket) {
        options.agent = false;
        options.createConnection = () => socket;
      }
      upReq = mod.request(options, (upRes) => {
        if (clientGone) {
          upRes.destroy();
          resolve();
          return;
        }
        const out = { ...upRes.headers };
        delete out['transfer-encoding'];
        delete out.connection;
        res.writeHead(upRes.statusCode || 200, out);
        upRes.pipe(res);
        upRes.on('end', resolve);
        upRes.on('error', reject);
      });
      upReq.setTimeout(30000, () => upReq.destroy(new Error('音频读取超时')));
      upReq.on('error', reject);
      upReq.end();
    };

    if (!PROXY) {
      fire(null);
      return;
    }
    proxyTunnel(PROXY, u.hostname, port, 20000)
      .then((socket) => {
        if (!isHttps) {
          fire(socket);
          return;
        }
        const secure = tls.connect({ socket, servername: u.hostname }, () => fire(secure));
        secure.on('error', reject);
      })
      .catch(reject);
  });
}

/* ────────────────────────── HTTP 服务 ────────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, '请求内容过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const buf = await fsp.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

  try {
    if (url.pathname === '/api/compare') {
      if (req.method !== 'POST') throw new HttpError(405, '只支持 POST');
      const body = JSON.parse((await readBody(req)) || '{}');
      sessionCookie = typeof body.cookie === 'string' ? body.cookie.trim() : '';
      const result = await compare({
        aRaw: body.a,
        bRaw: body.b,
        cookie: sessionCookie,
        strict: body.strict !== false,
      });
      sendJson(res, 200, result);
      return;
    }

    if (url.pathname === '/api/audio-url') {
      if (req.method !== 'POST') throw new HttpError(405, '只支持 POST');
      const body = JSON.parse((await readBody(req)) || '{}');
      const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Boolean).slice(0, 3000) : [];
      if (!ids.length) throw new HttpError(400, '缺少歌曲 id 列表');
      if (typeof body.cookie === 'string' && body.cookie.trim()) sessionCookie = body.cookie.trim();

      const map = await fetchAudioUrls(ids, sessionCookie);
      const items = ids.map((id) => {
        const info = map.get(id);
        return { id, playable: !!(info && info.playable), fee: info ? info.fee : 0 };
      });
      sendJson(res, 200, {
        ok: true,
        total: items.length,
        playable: items.filter((i) => i.playable).length,
        loggedIn: !!sessionCookie,
        items,
      });
      return;
    }

    if (url.pathname === '/api/audio') {
      const id = url.searchParams.get('id') || '';
      if (!/^\d+$/.test(id)) throw new HttpError(400, '缺少歌曲 id');
      const target = await resolveAudioUrl(id, sessionCookie);
      if (!target) {
        throw new HttpError(
          404,
          '这首歌暂时拿不到播放地址。它很可能是 VIP 专享曲，把登录凭证填进「进阶」区就能播放。'
        );
      }
      await streamAudio(req, res, target);
      return;
    }

    if (url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, proxy: PROXY || null, port: PORT, loggedIn: !!sessionCookie });
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res, url.pathname);
      return;
    }

    throw new HttpError(404, 'Not Found');
  } catch (err) {
    if (res.headersSent) {
      res.end();
      return;
    }
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof HttpError ? err.message : `服务出错：${err.message}`;
    sendJson(res, status, { ok: false, error: message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log('');
  console.log('  ♪  网易云 · 喜欢歌单重合度对比');
  console.log('  ─────────────────────────────────');
  console.log(`  已启动：${url}`);
  console.log(`  代理：  ${PROXY || '未设置（直连）'}`);
  console.log('');
  console.log('  关掉这个窗口即可停止服务。');
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  端口 ${PORT} 被占用了。换个端口重开，例如：node server.mjs ${PORT + 1}\n`);
  } else {
    console.error('\n  启动失败：', err.message, '\n');
  }
  process.exit(1);
});
