/**
 * 网易云音乐适配器
 *
 * 用到的公开接口：
 *   /api/v6/playlist/detail?id=X     歌单元数据 + 全量 trackIds（含创建者昵称 / 头像）
 *   /api/user/playlist?uid=X         某人的歌单列表（用来定位 specialType=5 的「我喜欢的音乐」）
 *   /api/v3/song/detail?c=[{id},..]  批量取歌曲名 / 歌手 / 专辑 / 封面
 *   /api/song/enhance/player/url/v1  取播放地址
 */

import { getJson, HttpError } from './shared.mjs';

const REFERER = 'https://music.163.com/';

const SONG_BATCH = 200; // 批量取歌曲详情的每批数量
const CONCURRENCY = 3;
const AUDIO_BATCH = 100;

function normCover(url) {
  return url ? String(url).replace(/^http:/, 'https:') : '';
}

const HINTS = [
  'music.163.com/#/my/m/music/playlist?id=429241928  ←「我喜欢的音乐」页面链接',
  'music.163.com/playlist?id=429241928',
  'music.163.com/m/playlist?id=429241928          ← 手机分享链接',
  '429241928                                      ← 纯歌单 ID',
  'music.163.com/#/user/home?id=309183355         ← 用户主页（自动找 TA 的喜欢歌单）',
];

export default {
  id: 'netease',
  label: '网易云音乐',
  short: '网易云',
  canPlay: true,

  /** 能认出这个输入吗？认出就返回 { platform, kind, id } */
  match(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return null;

    if (/^\d{5,}$/.test(s)) return { platform: 'netease', kind: 'auto', id: s };

    const isNetease = /music\.163\.com|163cn\.tv|y\.music\.163\.com|interface\.music\.163\.com/i.test(s);
    const m = s.match(/[?&#]?id=(\d+)/) || s.match(/\/(?:playlist|user)\/(\d+)/);

    if (m) {
      const looksLikeUser = /user\/home|\/user\/|user\?|music\.163\.com\/.*user/.test(s);
      if (looksLikeUser) return { platform: 'netease', kind: 'user', id: m[1] };
      if (isNetease) return { platform: 'netease', kind: 'auto', id: m[1] };
      // 别的平台也可能带 id= 参数，交给后面的平台识别
      return null;
    }
    if (/^\d+$/.test(s)) return { platform: 'netease', kind: 'auto', id: s };
    return null;
  },

  /** 取歌单：元数据 + 全量 trackIds（全程匿名请求，Referer 是接口要求的） */
  async fetchPlaylist(id) {
    const headers = { Referer: REFERER };
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
          `通常是因为它是私密歌单，请让对方改成公开。`
      );
    }

    return {
      platform: 'netease',
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
      partial: false,
      note: '',
      trackIds,
      raw: null,
    };
  },

  /** 从用户主页链接定位 TA 的「我喜欢的音乐」（specialType = 5） */
  async fetchFavorites(uid) {
    const headers = { Referer: REFERER };
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
    return this.fetchPlaylist(fav.id);
  },

  /** 批量取歌曲详情，返回 Map<id, song>（失败的分批跳过，不影响总数） */
  async fetchSongs(ids) {
    const headers = { Referer: REFERER };
    const map = new Map();
    const batches = [];
    for (let i = 0; i < ids.length; i += SONG_BATCH) batches.push(ids.slice(i, i + SONG_BATCH));

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
  },

  /**
   * 批量取播放地址。
   * 匿名（不登录）时网易云只给免费曲（fee 0 / 8）真实地址；VIP 曲（fee 1）返回 code -110 且 url 为 null。
   * 拿不到就如实标成不可播，不伪装。
   * 这个工具不做登录，所以只有这一条路 —— 能放多少就是访客能放多少。
   */
  async fetchAudio(ids) {
    const headers = { Referer: REFERER };
    const out = new Map();
    const batches = [];
    for (let i = 0; i < ids.length; i += AUDIO_BATCH) batches.push(ids.slice(i, i + AUDIO_BATCH));

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
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
    return out;
  },

  /** 音频流要带的头（防盗链） */
  audioHeaders() {
    return { Referer: REFERER };
  },

  /** 这首歌在网易云网页版的位置，用于导出 */
  songUrl(id) {
    return `https://music.163.com/song?id=${id}`;
  },

  hints: HINTS,
};
