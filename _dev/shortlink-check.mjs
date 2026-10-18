/**
 * 短链解析自检：不联网，用假 fetch 模拟「302 → 歌单页」「200 + meta refresh」几种情况。
 * 跑法：node _dev/shortlink-check.mjs
 */
import { firstUrl, isShortLink, resolveShort } from '../platforms/shortlink.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

/* ── 从分享文案里抠地址 ── */
const neteaseText = '分享歌单: 涔涔侧喜欢的音乐 涔涔侧 https://music.163.com/m/playlist?id=429241928&creatorId=309183355';
ok('网易云分享文案能抠出地址', firstUrl(neteaseText) === 'https://music.163.com/m/playlist?id=429241928&creatorId=309183355', firstUrl(neteaseText));
ok('没地址的文案返回 null', firstUrl('分享歌单：涔涔侧喜欢的音乐') === null);
ok('中文标点不会粘进地址', firstUrl('看这个 https://163cn.tv/abcDEF，好听') === 'https://163cn.tv/abcDEF', firstUrl('看这个 https://163cn.tv/abcDEF，好听'));

/* ── 认短链 ── */
ok('163cn.tv 算短链', isShortLink('分享 https://163cn.tv/abcDEF'));
ok('c6.y.qq.com 算短链', isShortLink('分享歌单 https://c6.y.qq.com/base/fcgi-bin/u?__=AbCd12'));
ok('完整歌单页不算短链', !isShortLink('https://y.qq.com/n/ryqq/playlist/7534777401'));
ok('酷狗歌单页不算短链', !isShortLink('https://www.kugou.com/yy/special/single/1234567.html'));

/* ── 跟跳 ── */
function fakeFetch(map) {
  return async (url) => {
    const hit = map[url];
    if (!hit) return new Response('', { status: 404 });
    return new Response(hit.body || '', { status: hit.status, headers: hit.headers || {} });
  };
}

const neteaseChain = {
  'https://163cn.tv/abcDEF': { status: 302, headers: { location: 'https://music.163.com/playlist?id=429241928' } },
};
const got1 = await resolveShort('分享歌单 https://163cn.tv/abcDEF 好听', { fetch: fakeFetch(neteaseChain) });
ok('163cn 跳一跳拿到歌单地址', got1 === 'https://music.163.com/playlist?id=429241928', String(got1));

const qqChain = {
  'https://c6.y.qq.com/base/fcgi-bin/u?__=AbCd12': { status: 302, headers: { location: '/n/ryqq/playlist/7534777401' } },
};
const got2 = await resolveShort('https://c6.y.qq.com/base/fcgi-bin/u?__=AbCd12', { fetch: fakeFetch(qqChain) });
ok('QQ 短链的相对跳转能补成绝对地址', got2 === 'https://c6.y.qq.com/n/ryqq/playlist/7534777401' || got2.endsWith('/n/ryqq/playlist/7534777401'), String(got2));

const htmlChain = {
  'https://163cn.tv/html1': {
    status: 200,
    body: '<meta http-equiv="refresh" content="0;url=https://music.163.com/playlist?id=998877">',
  },
};
const got3 = await resolveShort('https://163cn.tv/html1', { fetch: fakeFetch(htmlChain) });
ok('200 + meta refresh 也能拿到地址', got3 === 'https://music.163.com/playlist?id=998877', String(got3));

const got4 = await resolveShort('https://163cn.tv/broken', { fetch: fakeFetch({}) });
ok('短链打不开时返回 null，不抛异常', got4 === null, String(got4));

const got5 = await resolveShort('https://y.qq.com/n/ryqq/playlist/7534777401', { fetch: fakeFetch({}) });
ok('非短链直接返回 null（不做无谓请求）', got5 === null, String(got5));

console.log(`\n短链解析自检：${pass} 项通过${fail ? `，${fail} 项失败` : ''}`);
process.exit(fail ? 1 : 0);
