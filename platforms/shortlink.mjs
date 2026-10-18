/**
 * 分享短链 → 真地址
 *
 * 手机 App 里「复制链接」给出的往往不是歌单页地址，而是一条短链：
 *   网易云   https://163cn.tv/xxxxxxx
 *   QQ 音乐  https://c6.y.qq.com/base/fcgi-bin/u?__=xxxxxx
 * 短链只是跳转，里面没有歌单 ID，所以要先跟一跳（最多 4 跳）拿到最终地址，
 * 再交给各平台的 match() 去认。
 */

/** 从一段任意文本里取出第一个 http(s) 地址（分享文案前后常带标题、歌手、表情） */
export function firstUrl(raw) {
  const s = String(raw ?? '');
  const m = /https?:\/\/[^\s"'<>，。；、（）()【】]+/i.exec(s);
  return m ? m[0].replace(/[.,;)]+$/, '') : null;
}

const SHORT_HOSTS = [
  /(^|\/\/)163cn\.tv\//i,
  /(^|\/\/)c6\.y\.qq\.com\/base\/fcgi-bin\/u/i,
  /(^|\/\/)c\.y\.qq\.com\/base\/fcgi-bin\/u/i,
  /(^|\/\/)kglink\.kugou\.com\//i,
  /(^|\/\/)t\.cn\//i,
];

/** 这个地址是不是「还得再跳一下才知道是哪张歌单」的那种 */
export function isShortLink(raw) {
  const url = firstUrl(raw);
  if (!url) return false;
  return SHORT_HOSTS.some((re) => re.test(url));
}

function abs(base, loc) {
  try {
    return new URL(loc, base).toString();
  } catch {
    return loc;
  }
}

const UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

/** 认不出来的地址里，也许正文里藏着真地址（meta refresh / JS 跳转） */
function urlInside(body, base) {
  const direct = /https?:\/\/[^\s"'<>\\]+(?:playlist|taoge|songlist|special)[^\s"'<>\\]*/i.exec(body || '');
  if (direct) return direct[0];
  const meta = /http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=([^"']+)["']/i.exec(body || '');
  if (meta) return abs(base, meta[1]);
  return null;
}

/**
 * 跟着短链跳到最终地址。
 * @returns 最终 URL（认出来时）或 null（不是短链 / 跳不动）
 */
export async function resolveShort(raw, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const url = firstUrl(raw);
  if (!url || !isShortLink(url)) return null;

  let cur = url;
  for (let hop = 0; hop < 4; hop++) {
    let res;
    try {
      res = await fetchImpl(cur, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
        signal: AbortSignal.timeout(deps.timeout || 6000),
      });
    } catch {
      return null;
    }

    const location = res.headers?.get?.('location');
    if (res.status >= 300 && res.status < 400 && location) {
      cur = abs(cur, location);
      // 已经跳到能认出歌单的地址了，就不用再跟
      if (/\/(?:playlist|taoge|songlist|special|share\/details)/i.test(cur)) return cur;
      continue;
    }

    // 有些短链返回 200 + HTML 跳转
    let body = '';
    try {
      body = await res.text();
    } catch {
      return null;
    }
    const inside = urlInside(body, cur);
    if (inside) return inside;
    return null;
  }
  return cur;
}
