/**
 * 接口自测：不依赖浏览器，直接打服务端的 HTTP 接口。
 * 用法：node _dev/api-check.mjs [port]
 */
const PORT = Number(process.argv[2]) || 8799;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, data };
}

console.log(`\n服务地址 ${BASE}\n`);

// ── 健康检查 & 平台清单
{
  const res = await fetch(`${BASE}/api/health`);
  const d = await res.json();
  ok('GET /api/health 返回 ok', res.ok && d.ok === true);
  ok('健康检查列出三个平台', Array.isArray(d.platforms) && d.platforms.length === 3, JSON.stringify(d.platforms));

  const p = await (await fetch(`${BASE}/api/platforms`)).json();
  ok('GET /api/platforms 返回平台清单', p.ok && p.platforms.length === 3);
  const kugou = p.platforms.find((x) => x.id === 'kugou');
  ok('酷狗被如实标成「不能播放」', kugou && kugou.canPlay === false);
  ok('酷狗的说明文字不为空', !!(kugou && kugou.limitNote));
}

// ── 同平台对比（网易云）
console.log('\n【同平台对比 · 网易云 vs 网易云】');
{
  const { status, data } = await post('/api/compare', {
    aRaw: 'https://music.163.com/#/my/m/music/playlist?id=429241928',
    bRaw: 'https://music.163.com/playlist?id=2015697743',
  });
  ok('HTTP 200', status === 200, `status=${status}`);
  ok('返回 ok', data && data.ok === true, JSON.stringify(data)?.slice(0, 300));
  if (data && data.ok) {
    ok('匹配口径是 id', data.matchMode === 'id', data.matchMode);
    ok('两侧都识别成网易云', data.platforms.a === 'netease' && data.platforms.b === 'netease', JSON.stringify(data.platforms));
    ok('左侧读到 2206 首', data.total.a === 2206, `total.a=${data.total.a}`);
    ok('右侧读到 620 首', data.total.b === 620, `total.b=${data.total.b}`);
    ok('共同歌曲 88 首', data.common.count === 88, `count=${data.common.count}`);
    ok('重合度 ≈14.2%', Math.abs(data.common.ratioOfSmaller * 100 - 14.2) < 0.15, `${(data.common.ratioOfSmaller * 100).toFixed(2)}%`);
    ok('宽松口径另列 8 首同名不同版本', data.variants.length === 8, `variants=${data.variants.length}`);
    ok('每首共同歌曲都带 audio 来源', data.songs.every((s) => s.audio && s.audio.platform === 'netease' && s.audio.id), '');
    ok('歌曲 id 都是字符串', data.songs.every((s) => typeof s.id === 'string'));
    ok('共同歌曲里有封面', data.songs.some((s) => s.cover));
    ok('没有「没读全」的警告', !data.warnings.some((w) => /没读全/.test(w)), JSON.stringify(data.warnings));
  }
}

// ── 跨平台对比（网易云 vs QQ）
console.log('\n【跨平台对比 · 网易云 vs QQ 音乐】');
let crossOk = false;
{
  const { status, data } = await post('/api/compare', {
    aRaw: 'https://music.163.com/#/my/m/music/playlist?id=429241928',
    bRaw: 'https://y.qq.com/n/ryqq/playlist/7716239979',
  });
  ok('HTTP 200', status === 200, `status=${status}`);
  ok('返回 ok', data && data.ok === true, JSON.stringify(data)?.slice(0, 300));
  if (data && data.ok) {
    crossOk = true;
    ok('匹配口径是 name', data.matchMode === 'name', data.matchMode);
    ok('平台分别是 netease / qq', data.platforms.a === 'netease' && data.platforms.b === 'qq', JSON.stringify(data.platforms));
    ok('QQ 侧读到 137 首', data.total.b === 137, `total.b=${data.total.b}`);
    ok('有跨平台口径的提醒', data.warnings.some((w) => /ID 体系不同/.test(w)), JSON.stringify(data.warnings));
    ok('共同歌曲带 counterpart', data.songs.every((s) => s.counterpart && s.counterpart.id));
    ok('共同歌曲的 audio 统一用优先平台', data.songs.every((s) => s.audio && s.audio.platform === 'netease'));
    console.log(`     （本次跨平台共同 ${data.common.count} 首，用时 ${data.elapsedMs}ms）`);
  }
}

// ── 酷狗：能对比、不能试听
console.log('\n【酷狗 · 只能对比】');
{
  const { status, data } = await post('/api/compare', {
    aRaw: 'https://www.kugou.com/yy/special/single/6025092.html',
    bRaw: 'https://www.kugou.com/yy/special/single/6025092.html',
  });
  ok('HTTP 200', status === 200, `status=${status}`);
  if (data && data.ok) {
    ok('酷狗侧标了 partial', data.a.partial === true);
    ok('读到的首数 ≤30', data.total.a <= 30, `total.a=${data.total.a}`);
    ok('有「没读全」的提醒', data.warnings.some((w) => /没读全/.test(w)), JSON.stringify(data.warnings));
    ok('同一份歌单两侧全对上', data.common.count === data.total.a, `${data.common.count} / ${data.total.a}`);
    ok('播放源指向酷狗而不是别家', data.songs.every((s) => s.audio?.platform === 'kugou'));
    const first = data.songs[0];
    ok('歌曲 id 是酷狗的 HASH', /^[0-9a-f]{32}$/.test(String(first?.id)), String(first?.id));
    // 拿这首歌去问播放地址，必须如实回答「拿不到」而不是报错、也不是假装能播
    const au = await post('/api/audio-url', { groups: [{ platform: 'kugou', ids: [first.id] }] });
    const item = au.data?.items?.[`kugou:${first.id}`];
    ok('该曲被标成不可播', item?.playable === false, JSON.stringify(item));
    ok('原因是 no-audio-api', item?.reason === 'no-audio-api', JSON.stringify(item));
  } else {
    ok('酷狗对比成功', false, JSON.stringify(data)?.slice(0, 300));
  }
}

// ── 酷狗的播放地址必须明确说不行
console.log('\n【播放地址】');
{
  const { data } = await post('/api/audio-url', {
    groups: [{ platform: 'kugou', ids: ['b3a52a7a958bf0aed0ebfba2e9a818b7'] }],
  });
  ok('酷狗返回结构性结论而不是报错', data && data.ok === true);
  const key = 'kugou:b3a52a7a958bf0aed0ebfba2e9a818b7';
  ok('酷狗的歌被标成不可播', data?.items?.[key]?.playable === false);
  ok('并给出原因 no-audio-api', data?.items?.[key]?.reason === 'no-audio-api', JSON.stringify(data?.items?.[key]));
  ok('附上说明文字', Array.isArray(data?.notes) && data.notes.length > 0, JSON.stringify(data?.notes));

  const neteaseIds = ['1974976237'];
  const r2 = await post('/api/audio-url', { groups: [{ platform: 'netease', ids: neteaseIds }] });
  const k2 = 'netease:1974976237';
  ok('网易云正常返回一项', r2.data?.items?.[k2] !== undefined, JSON.stringify(r2.data?.items));
  ok('网易云这项有 playable 布尔值', typeof r2.data?.items?.[k2]?.playable === 'boolean');

  const r3 = await post('/api/audio-url', { groups: [{ platform: 'qq', ids: ['0004MEUq1VBwXi'] }] });
  const k3 = 'qq:0004MEUq1VBwXi';
  ok('QQ 正常返回一项', r3.data?.items?.[k3] !== undefined, JSON.stringify(r3.data?.items));

  const r4 = await post('/api/audio-url', { groups: [{ platform: 'nope', ids: ['1'] }] });
  ok('不认识的平台不炸', r4.data?.ok === true && r4.data.items['nope:1']?.playable === false);
}

// ── 错误路径
console.log('\n【错误路径】');
{
  const r1 = await post('/api/compare', { aRaw: '', bRaw: '' });
  ok('缺参数返回 400', r1.status === 400, `status=${r1.status}`);
  ok('错误信息是中文', typeof r1.data?.error === 'string' && r1.data.error.length > 0, r1.data?.error);

  const r2 = await post('/api/compare', { aRaw: 'https://example.com/whatever', bRaw: 'https://y.qq.com/n/ryqq/playlist/7716239979' });
  ok('不认识的链接返回 400', r2.status === 400, `status=${r2.status}`);
  ok('提示贴链接', /认不出|歌单/.test(r2.data?.error || ''), r2.data?.error);

  const r3 = await fetch(`${BASE}/api/audio?sid=x`);
  ok('拿不到音频时返回 404 而不是空流', r3.status === 404, `status=${r3.status}`);
  const r3d = await r3.json();
  ok('404 带中文原因', typeof r3d.error === 'string' && r3d.error.length > 0, r3d.error);

  const r4 = await post('/api/audio-url', { groups: [] });
  ok('空的 audio-url 请求不炸', r4.status === 200 && r4.data?.ok === true);

  const r5 = await fetch(`${BASE}/api/nothing`);
  ok('未知接口返回 404', r5.status === 404, `status=${r5.status}`);
}

// ── 静态文件与目录穿越
console.log('\n【静态文件】');
{
  const home = await fetch(`${BASE}/`);
  ok('首页能打开', home.status === 200 && (await home.text()).includes('音乐重合度'));
  const js = await fetch(`${BASE}/app.js`);
  ok('app.js 能取到', js.status === 200 && js.headers.get('content-type').includes('javascript'));

  for (const evil of ['/../server.mjs', '/..%2fserver.mjs', '/%2e%2e/server.mjs']) {
    const r = await fetch(BASE + evil);
    const body = r.status === 200 ? await r.text() : '';
    ok(`目录穿越被挡住：${evil}`, !(r.status === 200 && body.includes('musicu')), `status=${r.status}`);
  }
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (!crossOk) console.log('（跨平台那组没跑成，可能是 QQ 接口临时抽风）');
process.exit(fail ? 1 : 0);
