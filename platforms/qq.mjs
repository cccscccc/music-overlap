/**
 * QQ 音乐适配器
 *
 * 两条接口配合用：
 *   歌单详情（新版）  u.y.qq.com/cgi-bin/musicu.fcg  music.srfDissInfo.aiDissInfo/uniform_get_Dissinfo
 *                     → 歌单名、封面、创建者、前 30 首（**一次只给 30 首**）
 *   歌单歌曲（老版）  c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg
 *                     带 total_song_num，且支持 song_begin / song_num 真正翻页
 *                     → 用它分页把整个歌单取全（实测 355 首的歌单能翻完，页间不重叠）
 *
 * 注意：POST 到 musicu.fcg 时必须把 JSON 作为**裸 body** 发（Content-Type: application/json），
 * 用 format=json&data=... 的表单形式会返回 500001/500003。
 *
 * 播放地址：vkey.GetVkeyServer/CgiGetVkey。未登录只放行一部分，
 * 付费曲返回 result=104003 且 purl 为空 —— 拿不到就如实标成不可播。
 */

import { getJson, getText, HttpError, pooled } from './shared.mjs';

const REFERER = 'https://y.qq.com/';
const MUSICU = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const OLD_API = 'https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg';

const QQ_HEADERS = { Referer: REFERER, Origin: 'https://y.qq.com' };
const PAGE_SIZE = 300;   // 老接口一页拿多少首
const MAX_SONGS = 20000; // 保险丝，防止异常循环
const VKEY_BATCH = 100;  // 一次请求多少个播放地址

/**
 * musicu.fcg：裸 JSON POST（用表单格式发会返回 500001/500003）
 * 带上登录 Cookie 能解锁更多可播曲目。
 */
async function musicu(payload, cookie) {
  const text = await getText(
    MUSICU,
    {
      ...QQ_HEADERS,
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    { body: JSON.stringify(payload), timeout: 20000 }
  );
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('QQ 音乐返回了非 JSON 内容（可能被风控拦截，请稍后重试）');
  }
}

const HINTS = [
  'y.qq.com/n/ryqq/playlist/7716239979',
  'y.qq.com/n/ryqq/songDetail/xxxxx',
  'c6.y.qq.com/base/fcgi-bin/u?__=xxxxx   ← 手机分享短链',
  '7716239979                             ← 纯歌单 ID',
];

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function normCover(url) {
  return url ? String(url).replace(/^http:/, 'https:') : '';
}

/** 老接口取一页 */
async function fetchPage(id, begin, num) {
  const url =
    `${OLD_API}?type=1&json=1&utf8=1&onlysong=0&disstid=${encodeURIComponent(id)}` +
    `&song_begin=${begin}&song_num=${num}` +
    `&format=json&platform=yqq.json&needNewCode=0&new_format=1` +
    `&loginUin=0&hostUin=0&inCharset=utf8&outCharset=utf-8`;
  const data = await getJson(url, { Referer: REFERER }, { timeout: 20000 });
  const cd = data?.cdlist?.[0];
  if (!cd) {
    throw new HttpError(
      404,
      `没有找到 QQ 音乐歌单 ${id}。请确认它是一个「歌单」（不是单曲、专辑或电台），` +
        `并且没有被作者删除或设为私密。`
    );
  }
  return cd;
}

const mapSong = (s) => ({
  name: decodeEntities(s.name || s.songname || s.title || '(未知歌名)'),
  artists: (s.singer || []).map((a) => decodeEntities(a.name)).filter(Boolean).join(' / '),
  album: decodeEntities(s.album?.name || ''),
  cover: s.album?.mid ? `https://y.qq.com/music/photo_new/T002R300x300M000${s.album.mid}.jpg` : '',
  dt: (Number(s.interval) || 0) * 1000,
  pay: Number(s.pay?.pay_play) || 0,
});

export default {
  id: 'qq',
  label: 'QQ 音乐',
  short: 'QQ',
  canPlay: true,
  cookieHint: '选填，QQ 音乐登录后的 uin=xxxx; qm_keyst=xxxx',

  match(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return null;

    // 手机分享短链：c6.y.qq.com/base/fcgi-bin/u?__=xxx / i.y.qq.com/n2/m/share/details/...
    if (/y\.qq\.com|qq\.com\/base\/fcgi-bin\/u/i.test(s)) {
      const m = s.match(/\/(?:playlist|taoge|songlist)\/(\d{5,})/) ||
        s.match(/[?&](?:id|disstid|dissid)=(\d{5,})/);
      if (m) return { platform: 'qq', kind: 'auto', id: m[1] };
      return { platform: 'qq', kind: 'short', id: '', url: s };
    }
    return null;
  },

  async fetchPlaylist(rawId, cookie) {
    const id = String(rawId || '').trim();

    // 老接口一次最多给 song_num 首，并且会带上 total_song_num 供翻页
    const cd = await fetchPage(id, 0, PAGE_SIZE);
    const total = Number(cd.total_song_num ?? cd.songnum) || 0;

    const songs = [];
    const seen = new Set();
    const pushAll = (page) => {
      for (const s of page.songlist || []) {
        const mid = s.mid || s.songmid;
        if (!mid || seen.has(mid)) continue;
        seen.add(mid);
        songs.push({ mid, ...s });
      }
    };
    pushAll(cd);

    // 老接口默认只给 30 首，按 total_song_num 续着翻页
    const limit = Math.min(total || MAX_SONGS, MAX_SONGS);
    for (let begin = songs.length; begin < limit && songs.length < MAX_SONGS; begin = songs.length) {
      let page;
      try {
        page = await fetchPage(id, begin, PAGE_SIZE);
      } catch {
        break;
      }
      const before = songs.length;
      pushAll(page);
      if (songs.length === before) break; // 翻不动了，别死循环
    }

    if (!songs.length && total > 0) {
      throw new HttpError(
        404,
        `歌单「${decodeEntities(cd.dissname)}」读不到歌曲列表（共 ${total} 首）。` +
          `可能它需要登录才能查看，或者被作者限制了访问。`
      );
    }

    const mids = songs.map((s) => s.mid);
    return {
      platform: 'qq',
      id: String(id),
      name: decodeEntities(cd.dissname) || 'QQ 音乐歌单',
      cover: normCover(cd.logo),
      userId: String(cd.uin || ''),
      nickname: decodeEntities(cd.nickname || cd.nick || ''),
      avatar: normCover(cd.headurl),
      trackCount: total || mids.length,
      readCount: mids.length,
      specialType: 0,
      privacy: 0,
      isFavorites: false,
      partial: !!total && mids.length < total,
      note: total && mids.length < total ? `只读到 ${mids.length} / ${total} 首` : '',
      trackIds: mids,
      raw: songs, // 歌单接口已经带着名 / 歌手 / 时长 / 封面，后面直接复用
    };
  },

  /**
   * 批量取详情。
   * 歌单接口本身已经把歌名 / 歌手 / 时长 / 封面给全了，所以优先用 raw 里现成的，
   * 不去打详情接口（实测 get_song_detail 对这类歌单限流严重，几乎补不到东西）。
   * items 既可以是 mid 字符串数组，也可以是 raw 里的歌曲对象数组。
   */
  async fetchSongs(items, cookie, raw) {
    const map = new Map();
    const line = new Map();
    for (const s of raw || []) if (s?.mid) line.set(s.mid, s);

    const missing = [];
    const take = (mid) => {
      const s = line.get(mid);
      if (!s) return false;
      map.set(mid, { ...mapSong(s) });
      return true;
    };

    for (const t of items) {
      const mid = typeof t === 'string' ? t : t?.mid || t?.id;
      if (!mid) continue;
      if (take(mid)) continue;
      missing.push(mid);
    }

    if (missing.length) {
      const BATCH = 60;
      const batches = [];
      for (let i = 0; i < missing.length; i += BATCH) batches.push(missing.slice(i, i + BATCH));
      await pooled(batches, 3, async (batch) => {
        const payload = {};
        batch.forEach((mid, i) => {
          payload[`req_${i}`] = { module: 'music.pf_song_detail_svr', method: 'get_song_detail', param: { song_mid: mid } };
        });
        try {
          const data = await musicu(payload, cookie);
          batch.forEach((mid, i) => {
            const info = data?.[`req_${i}`]?.data?.track_info;
            if (info) map.set(mid, { ...mapSong(info) });
          });
        } catch {
          /* 补不到就留空，前端会显示「详情读取失败」 */
        }
      });
    }
    return map;
  },

  /** 批量取播放地址。拿不到就是拿不到，不猜。 */
  async fetchAudio(mids, cookie) {
    const out = new Map();
    const batches = [];
    for (let i = 0; i < mids.length; i += VKEY_BATCH) batches.push(mids.slice(i, i + VKEY_BATCH));

    await pooled(batches, 2, async (batch) => {
      let data;
      try {
        data = await musicu(
          {
            req_0: {
              module: 'vkey.GetVkeyServer',
              method: 'CgiGetVkey',
              param: {
                guid: '10000',
                songmid: batch,
                songtype: batch.map(() => 0),
                uin: '0',
                loginflag: 1,
                platform: '20',
              },
            },
            comm: { uin: 0, format: 'json', ct: 24, cv: 0 },
          },
          cookie
        );
      } catch {
        return;
      }
      const d = data?.req_0?.data;
      const sip = (d?.sip || []).find((s) => /^https?:/.test(s)) || '';
      const httpsSip = sip.replace(/^http:/, 'https:');
      for (const m of d?.midurlinfo || []) {
        if (!m?.songmid) continue;
        const url = m.purl ? httpsSip + m.purl : '';
        out.set(m.songmid, {
          url,
          playable: !!url && Number(m.result) === 0,
          fee: Number(m.result) === 104003 ? 1 : 0,
        });
      }
    });
    return out;
  },

  audioHeaders() {
    return { Referer: REFERER };
  },

  songUrl(id) {
    return `https://y.qq.com/n/ryqq/songDetail/${id}`;
  },

  hints: HINTS,
};
