/*
 * 离线对比服务：给界面自检用的假后端。
 *
 * 为什么要它：两个界面自检（多平台自检 / 新界面自检）原来打的是真实服务、
 * 真实歌单、真实音频 CDN。这意味着**歌单被删、断网、平台改接口，回归测试就全红**，
 * 而且别人 clone 下来根本跑不了（两份外部评审都提到这一点）。
 *
 * 这个服务把 /api/* 全部用固定假数据回答，静态文件直接发 public/ 里的真文件，
 * 音频发 _dev/fixtures/tone.mp3（真能播的真 MP3）。
 * 于是 CDP 那套「真机点页面」的断言可以原样跑，但完全不碰外部网络。
 *
 * 用法：node _dev/offline-server.mjs [port]        # 默认 8899
 *   然后：set BASE=http://127.0.0.1:8899
 *         node "_dev/多平台自检.mjs"
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.argv[2]) || 8899;

/* ------------------------------------------------------------------ *
 * 假数据
 *
 * 三个歌单互相之间的关系是**故意设计**的，让两个自检脚本的每条断言都有东西可断言：
 *   netease:A（示例/网易云侧，120 首）── 与 B 有 40 首自己人，与 QQ 有 12 首同名同歌手
 *   netease:B（对方/网易云侧，70 首）
 *   qq:B     （QQ 侧，50 首）  ← 其中 12 首的歌名+歌手与 netease:A 完全相同
 *   kugou:A  （酷狗侧，只给 30 首）
 * ------------------------------------------------------------------ */

/** 造一首歌 */
const song = (id, name, artists, album = '测试专辑') => ({
  id: String(id),
  name,
  artists,
  album,
  cover: `http://127.0.0.1:${PORT}/asset/cover.png`,
  dt: 214000,
});

/** 造一个歌单 */
const playlist = ({ platform, id, name, nickname, tracks, trackCount, partial = false, note = '' }) => ({
  platform,
  id: String(id),
  name,
  nickname,
  avatar: `http://127.0.0.1:${PORT}/asset/avatar.png`,
  cover: `http://127.0.0.1:${PORT}/asset/cover.png`,
  trackCount: trackCount ?? tracks.length,
  readCount: tracks.length,
  partial,
  note,
  isFavorites: true,
  tracks,
});

// —— 同平台共同曲：netease:A 与 netease:B 各有一份，ID 完全相同
const SHARED_NET = Array.from({ length: 40 }, (_, i) => ({
  id: 1000 + i,
  name: `共同曲 ${i + 1}`,
  artists: `共同歌手 ${i + 1}`,
}));

// —— 跨平台共同曲：netease:A 与 qq:B 的「歌名 + 歌手」完全相同，ID 体系不同
const SHARED_CROSS = Array.from({ length: 12 }, (_, i) => ({
  name: `跨平台曲 ${i + 1}`,
  artists: `跨平台歌手 ${i + 1}`,
  neteaseId: 2000 + i,
  qqMid: `00CROSS${String(i + 1).padStart(3, '0')}MID`,
}));

const A_TRACKS = [
  ...SHARED_NET.map((s) => song(s.id, s.name, s.artists)),
  ...SHARED_CROSS.map((s) => song(s.neteaseId, s.name, s.artists)),
  ...Array.from({ length: 68 }, (_, i) => song(3000 + i, `只有A ${i + 1}`, `歌手A ${i + 1}`)),
];
const B_TRACKS = [
  ...SHARED_NET.map((s) => song(s.id, s.name, s.artists)),
  ...Array.from({ length: 30 }, (_, i) => song(4000 + i, `只有B ${i + 1}`, `歌手B ${i + 1}`)),
];
const QQ_TRACKS = [
  ...SHARED_CROSS.map((s) => song(s.qqMid, s.name, s.artists, 'QQ 专辑')),
  ...Array.from({ length: 38 }, (_, i) => song(`00ONLYQQ${String(i + 1).padStart(3, '0')}MID`, `只有QQ ${i + 1}`, `QQ歌手 ${i + 1}`)),
];
/*
 * 酷狗侧：只给 30 首。前 3 首的歌名 + 歌手与 netease:A 里的「只有A 1/2/3」相同 ——
 * 这样「网易云 vs 酷狗」能对出 3 首共同曲，界面上的「每行标出另一边」才有的可断言。
 * 酷狗的 ID 是 32 位 HASH 字符串（和网易云的数字 ID 天然不同），跨平台只能靠指纹对上。
 */
const KG_TRACKS = [
  ...['只有A 1', '只有A 2', '只有A 3'].map((name, i) => ({
    id: `KG${String(i + 1).padStart(32, '0')}`,
    name,
    artists: `歌手A ${i + 1}`,
  })),
  ...Array.from({ length: 27 }, (_, i) => {
    const n = i + 4;
    return { id: `KG${String(n).padStart(32, '0')}`, name: `酷狗曲 ${n}`, artists: `酷狗歌手 ${n}` };
  }),
];

const PLAYLISTS = {
  'netease:429241928': playlist({ platform: 'netease', id: 429241928, name: '示例歌单（120 首）', nickname: '左边的人', tracks: A_TRACKS }),
  'netease:2015697743': playlist({ platform: 'netease', id: 2015697743, name: '对方歌单（70 首）', nickname: '右边的人', tracks: B_TRACKS }),
  'qq:7716239979': playlist({ platform: 'qq', id: 7716239979, name: 'QQ 歌单（50 首）', nickname: 'QQ 上的人', tracks: QQ_TRACKS }),
  // 酷狗：只读得到 30 首，而且那个歌单其实是 60 首 —— 界面必须如实提醒
  'kugou:6025092': playlist({
    platform: 'kugou', id: 6025092, name: '酷狗歌单（其实是 60 首）', nickname: '酷狗上的人',
    tracks: KG_TRACKS, trackCount: 60, partial: true, note: '只读到 30 / 60 首',
  }),
};

/* ------------------------------------------------------------------ *
 * 输入解析：和真服务一样认「链接 or 纯数字」
 * ------------------------------------------------------------------ */
function parseInput(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^\d{5,}$/.test(s)) return [
    { platform: 'netease', id: s },
    { platform: 'qq', id: s },
    { platform: 'kugou', id: s },
  ];
  if (/music\.163\.com/.test(s)) {
    const m = s.match(/[?&#](?:id|playlist\?id)=?(\d+)/) || s.match(/id=(\d+)/);
    if (m) return [{ platform: 'netease', id: m[1] }];
  }
  if (/y\.qq\.com/.test(s)) {
    const m = s.match(/(?:playlist|disstid|dissid)\/(\d+)/) || s.match(/[?&](?:id|disstid)=(\d+)/);
    if (m) return [{ platform: 'qq', id: m[1] }];
  }
  if (/kugou\.com/.test(s)) {
    const m = s.match(/single\/(\d+)/) || s.match(/(\d{5,})/);
    if (m) return [{ platform: 'kugou', id: m[1] }];
  }
  return null;
}

/** 指纹规则必须和后端一致：小写 + 去空白 + 去标点，歌手缺失时只按歌名 */
function normalize(v) {
  return String(v ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[·・.,，。、!！?？'"“”‘’()（）\[\]【】\-—_/\\|&+*#:：;；~^]/g, '');
}
function fingerprint(s) {
  const name = normalize(s.name);
  if (!name) return '';
  const artist = normalize(s.artists);
  return artist ? `${name}@@${artist}` : name;
}

function loadSide(raw, label) {
  const cands = parseInput(raw);
  if (!cands) return { error: '这段内容里没认出歌单。请直接粘贴歌单链接（网易云 / QQ 音乐 / 酷狗的歌单页都行），或者粘贴歌单的数字 ID。' };
  const tried = [];
  for (const c of cands) {
    const pl = PLAYLISTS[`${c.platform}:${c.id}`];
    if (pl) return { side: { ...pl, label, guessed: cands.length > 1, tried } };
    tried.push({ platform: c.platform, message: `找不到歌单 ${c.id}` });
    if (cands.length === 1) return { error: `第 ${label} 个输入没能在任何一个平台读到歌单。` };
  }
  return { error: `第 ${label} 个输入没能在任何一个平台读到歌单。挨个试过的结果：\n${tried.map((t) => `· ${t.platform}：${t.message}`).join('\n')}` };
}

/* ------------------------------------------------------------------ *
 * 对比：规则与真后端一致（同平台按 ID，跨平台按歌名+歌手）
 * ------------------------------------------------------------------ */
function compare(aRaw, bRaw) {
  const ra = loadSide(aRaw, 'A');
  if (ra.error) return { status: 400, body: { ok: false, error: ra.error } };
  const rb = loadSide(bRaw, 'B');
  if (rb.error) return { status: 400, body: { ok: false, error: rb.error } };

  const a = ra.side;
  const b = rb.side;
  const samePlatform = a.platform === b.platform;
  const warnings = [];
  if (a.guessed) warnings.push(`A 侧填的是纯数字，按网易云读到的。如果不对，请直接粘贴完整链接。`);

  const idsA = a.tracks.map((t) => String(t.id));
  const idsB = b.tracks.map((t) => String(t.id));
  const mapA = new Map(a.tracks.map((t) => [String(t.id), t]));
  const mapB = new Map(b.tracks.map((t) => [String(t.id), t]));

  const common = [];
  const variants = [];
  if (samePlatform) {
    for (const id of idsA) {
      if (!mapB.has(id)) continue;
      const s = mapA.get(id) || mapB.get(id);
      common.push({ ...s, id, audio: { platform: a.platform, id } });
    }
  } else {
    const usedB = new Set();
    const byB = new Map();
    for (const t of b.tracks) {
      const fp = fingerprint(t);
      if (!fp) continue;
      if (!byB.has(fp)) byB.set(fp, []);
      byB.get(fp).push(String(t.id));
    }
    for (const t of a.tracks) {
      const fp = fingerprint(t);
      if (!fp) continue;
      const bucket = byB.get(fp);
      if (!bucket || !bucket.length) continue;
      const idB = bucket.shift();
      usedB.add(idB);
      const sb = mapB.get(idB);
      const audioPlatforms = [a.platform, b.platform].sort(
        (x, y) => ['netease', 'qq', 'kugou'].indexOf(x) - ['netease', 'qq', 'kugou'].indexOf(y)
      );
      const ap = audioPlatforms[0];
      common.push({
        ...t,
        counterpart: { platform: b.platform, id: idB, name: sb?.name || '', album: sb?.album || '' },
        audio: { platform: ap, id: ap === a.platform ? String(t.id) : idB },
      });
    }
  }

  if (a.partial) warnings.push(`A 侧（酷狗音乐）没读全：${a.note}。这一侧的歌曲总数只按读到的算，重合度会偏低。`);
  if (b.partial) warnings.push(`B 侧（酷狗音乐）没读全：${b.note}。这一侧的歌曲总数只按读到的算，重合度会偏低。`);
  if (!samePlatform) {
    warnings.push('两个平台不是同一家，歌曲 ID 体系不同，所以这里用的是「同名 + 同歌手」的匹配口径，比同平台的 ID 精确匹配要宽松。');
  }

  const compA = a.tracks.length;
  const compB = samePlatform ? idsB.filter((id) => !mapA.has(id)).length : b.tracks.length;
  const count = common.length;
  const union = samePlatform ? compA + compB : compA + compB - count;
  const smaller = Math.min(a.tracks.length, b.tracks.length);

  return {
    status: 200,
    body: {
      ok: true,
      matchMode: samePlatform ? 'id' : 'name',
      samePlatform,
      platforms: { a: a.platform, b: b.platform },
      canPlay: true,
      elapsedMs: 12,
      a: {
        platform: a.platform, id: a.id, name: a.name, cover: a.cover, nickname: a.nickname,
        avatar: a.avatar, isFavorites: true, total: a.trackCount, read: a.tracks.length,
        partial: !!a.partial, note: a.note || '', comparable: compA,
      },
      b: {
        platform: b.platform, id: b.id, name: b.name, cover: b.cover, nickname: b.nickname,
        avatar: b.avatar, isFavorites: true, total: b.trackCount, read: b.tracks.length,
        partial: !!b.partial, note: b.note || '', comparable: samePlatform ? compB : compB,
      },
      total: { a: a.tracks.length, b: b.tracks.length },
      common: {
        count,
        ratioOfSmaller: union ? count / union : 0,
        ratioOfUnion: union ? count / union : 0,
        ratioOfPlaylist: smaller ? count / smaller : 0,
        union,
        comparable: { a: compA, b: compB },
        excluded: { a: 0, b: 0 },
        noDetail: 0,
        unmatched: { a: 0, b: 0 },
      },
      variants,
      songs: common,
      warnings,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 多人对比：规则与真后端一致（按「歌名 + 歌手」算，人数越多交集越窄）
 * ------------------------------------------------------------------ */
function compareMany(raws) {
  const sides = [];
  for (let i = 0; i < raws.length; i++) {
    const r = loadSide(raws[i], String.fromCharCode(65 + i));
    if (r.error) return { status: 400, body: { ok: false, error: r.error } };
    sides.push(r.side);
  }
  if (sides.length < 2) {
    return { status: 400, body: { ok: false, error: '至少要把两个人的歌单链接填上。' } };
  }
  const per = sides.map((s) => {
    const m = new Map();
    for (const t of s.tracks) {
      const fp = fingerprint(t);
      if (fp && !m.has(fp)) m.set(fp, t);
    }
    return m;
  });
  const keys = new Set();
  per.forEach((m) => m.forEach((_, k) => keys.add(k)));

  const songs = [];
  const every = [];
  for (const key of keys) {
    const holders = [];
    per.forEach((m, i) => { if (m.has(key)) holders.push(i); });
    if (holders.length < 2) continue;
    const first = per[holders[0]].get(key);
    const item = {
      ...first,
      holders,
      audio: { platform: sides[holders[0]].platform, id: String(first.id) },
    };
    if (holders.length === sides.length) every.push(item);
    songs.push(item);
  }
  // 和真后端一致：主列表按票数降序，全员都有的单独一份
  songs.sort((x, y) => y.holders.length - x.holders.length || String(x.name).localeCompare(String(y.name), 'zh-CN'));

  const reads = sides.map((s) => s.tracks.length);
  const smallest = Math.min(...reads);
  const union = keys.size;
  const warnings = [];
  const partials = sides.filter((s) => s.partial);
  if (partials.length) {
    warnings.push(`${partials.length} 个歌单没读全（酷狗只给前 30 首），这一侧的歌曲总数只按读到的算，重合度会偏低。`);
  }
  const platforms = [...new Set(sides.map((s) => s.platform))];
  if (platforms.length > 1) {
    warnings.push('里面有几个平台，歌曲 ID 体系不同，所以用的是「同名 + 同歌手」的匹配口径，比同平台的 ID 精确匹配要宽松。');
  }

  return {
    status: 200,
    body: {
      ok: true,
      kind: 'group',
      people: sides.length,
      canPlay: platforms.every((p) => p !== 'kugou'),
      elapsedMs: 15,
      platforms,
      sides: sides.map((s, i) => ({
        index: i,
        label: String.fromCharCode(65 + i),
        platform: s.platform,
        name: s.name,
        nickname: s.nickname,
        cover: s.cover,
        avatar: s.avatar,
        isFavorites: true,
        total: s.trackCount,
        read: reads[i],
        comparable: per[i].size,
        partial: !!s.partial,
        note: s.note || '',
      })),
      total: reads,
      smallest,
      common: {
        count: songs.length,
        everyoneCount: every.length,
        ratioOfPlaylist: smallest ? songs.length / smallest : 0,
        ratioOfUnion: union ? songs.length / union : 0,
        union,
      },
      everyone: every,
      songs,
      warnings,
    },
  };
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wav': 'audio/wav',
};

/*
 * 音频素材是 WAV，不是 MP3，这不是随便选的：
 * 手写合法的 MPEG-1 Layer III 帧要做 Huffman 编码，取巧写出来的文件 Chromium 直接
 * 判 MEDIA_ERR_SRC_NOT_SUPPORTED（error.code=4、readyState 永远 0）——试过，不行。
 * WAV 是未压缩 PCM，没有编码器歧义，改成它之后播放器断言就稳了。
 */
const AUDIO_MIME = 'audio/wav';

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

/** 对比记录：内存里存着，重启就没了（假后端不需要持久化） */
let fakeHistory = [];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const route = url.pathname;

  if (route === '/api/health') {
    return sendJson(res, 200, { ok: true, version: '0.3.1-offline', platforms: ['netease', 'qq', 'kugou'] });
  }

  if (route === '/api/platforms') {
    return sendJson(res, 200, {
      ok: true,
      hints: ['music.163.com', 'y.qq.com', 'kugou.com'],
      platforms: [
        { id: 'netease', label: '网易云音乐', short: '网易云', canPlay: true, limitNote: '' },
        { id: 'qq', label: 'QQ 音乐', short: 'QQ', canPlay: true, limitNote: '' },
        { id: 'kugou', label: '酷狗音乐', short: '酷狗', canPlay: false, limitNote: '酷狗的公开页面只给前 30 首，而且拿不到播放地址，这里只能对比、不能试听。' },
      ],
    });
  }

  if (route === '/api/compare' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const r = compare(body.aRaw, body.bRaw);
    return sendJson(res, r.status, r.body);
  }

  if (route === '/api/compare-many' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const raws = (Array.isArray(body.raws) ? body.raws : []).map((s) => String(s || '').trim()).filter(Boolean);
    const r = compareMany(raws);
    return sendJson(res, r.status, r.body);
  }

  // 假后端也把「对比记录」实现一份：界面会在启动时拉它，缺了首页会多一次失败请求
  if (route === '/api/history') {
    if (req.method === 'GET') return sendJson(res, 200, { ok: true, items: fakeHistory });
    if (req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      fakeHistory = [{ id: 'x' + Date.now(), at: new Date().toISOString(), ...body }, ...fakeHistory].slice(0, 10);
      return sendJson(res, 200, { ok: true, total: fakeHistory.length });
    }
    if (req.method === 'DELETE') {
      fakeHistory = [];
      return sendJson(res, 200, { ok: true, total: 0 });
    }
  }

  if (route === '/api/audio-url' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const items = {};
    const notes = [];
    const groups = Array.isArray(body?.groups) ? body.groups : [];
    for (const g of groups) {
      const platform = String(g.platform || '');
      const ids = Array.isArray(g.ids) ? g.ids.map(String) : [];
      if (platform === 'kugou') {
        for (const id of ids) items[`kugou:${id}`] = { playable: false, reason: 'no-audio-api' };
        notes.push('酷狗音乐：这个平台拿不到播放地址');
        continue;
      }
      for (const id of ids) {
        // 前 2 首在离线环境里给不了地址，用来验证「放不出来要说出来」
        const playable = !/^(1001|1002)$/.test(id);
        items[`${platform}:${id}`] = playable
          ? { playable: true, fee: 0, reason: 'ok' }
          : { playable: false, fee: 1, reason: 'vip' };
      }
    }
    return sendJson(res, 200, { ok: true, items, notes });
  }

  // —— 音频：真发那份素材，支持 Range（播放器的进度条要用）
  if (route === '/api/audio') {
    const file = path.join(HERE, 'fixtures', 'tone.wav');
    const size = fs.statSync(file).size;
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m[1] ? Number(m[1]) : 0;
      let end = m[2] ? Number(m[2]) : size - 1;
      if (!m[1] && m[2]) { start = size - Number(m[2]); end = size - 1; } // bytes=-N
      if (start >= size) { res.writeHead(416); return res.end(); }
      end = Math.min(end, size - 1);
      res.writeHead(206, {
        'Content-Type': AUDIO_MIME,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': AUDIO_MIME, 'Accept-Ranges': 'bytes', 'Content-Length': size });
    return fs.createReadStream(file).pipe(res);
  }

  // —— 图片素材：真实的小 PNG（1x1 会显得像坏了，所以发 64x64 的纯色块）
  if (route.startsWith('/asset/')) {
    const file = path.join(HERE, 'fixtures', 'square.png');
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    return fs.createReadStream(file).pipe(res);
  }

  if (route.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: `离线服务没有这个接口：${route}` });

  // —— 静态文件：直接发 public/ 里的真文件
  const rel = route === '/' ? 'index.html' : decodeURIComponent(route).replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('页面不存在'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`离线对比服务已启动：http://127.0.0.1:${PORT}`);
  console.log('（假数据，不联网。界面自检请设 BASE=http://127.0.0.1:' + PORT + '）');
});
