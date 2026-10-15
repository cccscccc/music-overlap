/**
 * 酷狗音乐适配器
 *
 * ⚠️ 关于酷狗的两个真实限制（如实说明，不假装能行）：
 *
 * 1. 歌单只能读到前 30 首。
 *    酷狗把歌曲数据内联在歌单页 HTML 的 `var data=[...]` 里，页面本身只渲染 30 首，
 *    翻页参数（?page= / ?p= / pagesize=）无效，页面也不会再发任何加载请求（已用无头浏览器
 *    抓包确认）。歌单全量接口 /v3/get_list_info 需要设备通过风控，未通过时恒返回 error_code 20028。
 *    → 这里如实把 partial 标出来，界面上会明说「只读到前 30 首」。
 *
 * 2. 不能在线试听。
 *    取播放地址的接口（gateway.kugou.com/v5/url、wwwapi.../play/getdata）会校验浏览器侧的
 *    行为指纹（SID/EDT），纯服务端请求一律返回「本次请求需要验证」/ err_code 30020。
 *    → canPlay = false，界面上把播放按钮置灰并说明原因，而不是点了没反应。
 *
 * 能用的部分：歌单链接 → 歌单名 / 作者 / 封面 / 前 30 首的完整元数据（歌名、歌手、专辑、时长），
 * 足够参与重合度对比。
 */

import { getText, HttpError } from './shared.mjs';

const REFERER = 'https://www.kugou.com/';
const KUGOU_LIMIT = 30; // 歌单页固定给这么多首，实测无翻页入口

const HINTS = [
  'kugou.com/yy/special/single/6025092.html   ← 歌单页（能读前 30 首）',
  't1.kugou.com/song.html?id=xxxxx            ← 手机分享短链',
  '6025092                                    ← 只要数字，优先当酷狗歌单试',
];

/** 从歌单页 HTML 里把 var data=[...] 抠出来（按括号配对，别用贪婪正则） */
function extractArray(html, marker) {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.indexOf('[', at);
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** specialInfo 是个对象字面量，同样按括号配对取 */
function extractObject(html, marker) {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.indexOf('{', at);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function normCover(url) {
  return url ? String(url).replace(/^http:/, 'https:') : '';
}

export default {
  id: 'kugou',
  label: '酷狗音乐',
  short: '酷狗',
  canPlay: false,
  limitNote: `酷狗的歌单页只公开前 ${KUGOU_LIMIT} 首，且不提供在线试听，所以酷狗这边只参与「对比」，不能播放。`,

  match(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return null;
    if (/^\d{5,}$/.test(s)) return { platform: 'kugou', kind: 'auto', id: s };
    if (!/kugou\.com|kglink|kgstatic/i.test(s)) return null;

    const m =
      s.match(/special\/single\/(\d+)/) ||
      s.match(/[?&#](?:id|specialid)=(\d+)/) ||
      s.match(/share\/(\d+)/);
    if (m) return { platform: 'kugou', kind: 'auto', id: m[1] };
    return { platform: 'kugou', kind: 'unknown', id: '', url: s };
  },

  async fetchPlaylist(rawId) {
    const id = String(rawId || '').trim();
    const url = `https://www.kugou.com/yy/special/single/${encodeURIComponent(id)}.html`;
    const html = await getText(url, { Referer: REFERER }, { timeout: 20000 });

    const list = extractArray(html, 'var data=');
    const info = extractObject(html, 'specialInfo') || {};

    if (!list || !list.length) {
      throw new HttpError(
        404,
        `没有读到酷狗歌单 ${id} 的歌曲。请确认链接形如 ` +
          `https://www.kugou.com/yy/special/single/${id}.html —— 酷狗的「单曲」「专辑」「排行榜」页面 ` +
          `结构不一样，这个工具只认歌单（精选集）页面。`
      );
    }

    const seen = new Set();
    const tracks = [];
    for (const s of list) {
      const hash = String(s.HASH || s.hash || '').toLowerCase();
      if (!hash || seen.has(hash)) continue;
      seen.add(hash);
      tracks.push(s);
    }

    const title =
      info.name ||
      (/<title>([^<]*)<\/title>/.exec(html)?.[1] || '').split('_')[0].trim() ||
      '酷狗歌单';

    const declared = Number(list[0]?.song_count || info.song_count || 0) || 0;

    return {
      platform: 'kugou',
      id: String(id),
      name: title,
      cover: normCover(info.image),
      userId: '',
      nickname: info.nickname || '',
      avatar: '',
      trackCount: declared || tracks.length,
      readCount: tracks.length,
      specialType: 0,
      privacy: 0,
      isFavorites: false,
      // 页面只给 30 首；就算声明总数也是 30，也仍然可能被截断，所以一律标出来
      partial: true,
      note: `酷狗的公开页面只给前 ${tracks.length} 首，剩下的读不到`,
      trackIds: tracks.map((s) => String(s.HASH).toLowerCase()),
      raw: tracks,
    };
  },

  fetchFavorites() {
    throw new HttpError(400, '酷狗没有「用户主页」这种可以直接读的入口，请粘贴歌单链接。');
  },

  /**
   * 酷狗歌单页已经把歌名 / 歌手 / 专辑 / 时长都给全了，不需要再请求。
   * items 是 trackIds（小写 hash），raw 里有原始对象。
   */
  async fetchSongs(items, raw, listCover) {
    const map = new Map();
    const byHash = new Map();
    for (const s of raw || []) byHash.set(String(s.HASH).toLowerCase(), s);

    for (const t of items) {
      const id = typeof t === 'string' ? t : t.id;
      const s = byHash.get(String(id).toLowerCase());
      if (!s) continue;
      const authors = (s.authors || []).map((a) => a.author_name).filter(Boolean);
      map.set(String(id).toLowerCase(), {
        name: s.songname || s.song_name || '(未知歌名)',
        artists: authors.length ? authors.join(' / ') : s.singername || '',
        album: s.album_name || '',
        // 歌单页里没有每首歌的封面，用歌单封面兜底，列表不至于一边有图一边空着
        cover: normCover(listCover || ''),
        dt: Number(s.duration) || 0,
      });
    }
    return map;
  },

  /** 酷狗拿不到播放地址（见文件顶部说明），这里明确返回空表 */
  async fetchAudio() {
    return new Map();
  },

  audioHeaders() {
    return { Referer: REFERER };
  },

  songUrl(id) {
    return `https://www.kugou.com/song/#hash=${id}`;
  },

  hints: HINTS,
};
