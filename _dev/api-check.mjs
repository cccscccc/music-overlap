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
    const sizeA = data.total.a;
    const sizeB = data.total.b;
    const hit = data.common.count;
    const lower = Math.min(sizeA, sizeB);
    const sum = sizeA + sizeB;
    const expectUnion = sum - hit;

    ok('两侧都读到了成百上千首（歌单是活的，不写死数字）',
      sizeA > 1500 && sizeB > 300, `a=${sizeA} b=${sizeB}`);
    ok('共同歌曲比两边都少（交集的真义）',
      hit > 0 && hit < lower, `count=${hit} lower=${lower}`);
    /*
     * 断言写成**结构关系**而不是写死数字：
     * 这两个歌单是别人的真实歌单，我今天量到 2205 × 629 / 89 首，明天对方加两首就会变。
     * 写死数字只会让自检变成「歌单有没有变」的仪表盘，而不是在验代码。
     * 真正要钉住的是口径 —— 下面每一条都是修完统计 bug 之后才成立的：
     *   ratioOfPlaylist = 交集 ÷ 较小的一侧歌单
     *   ratioOfUnion    = 交集 ÷ 真正参与对比的并集
     * 两者不相等是**正常的**：它们回答的是两个不同的问题。
     * 曾经的问题是 ratioOfSmaller 拿 min(歌单总数) 当分母、分子却只有「有详情的歌」，
     * 于是同一个数字既能当 14% 又能被静默拉低；而且跨平台时并集恒等于 sizeA+sizeB。
     * 现在：两个比例的分母都只来自参与对比的集合，playlist 口径单独一个字段。
     */
    ok('重合度 = 交集 ÷ 较小歌单',
      Math.abs(data.common.ratioOfPlaylist - hit / lower) < 0.005,
      `${(data.common.ratioOfPlaylist * 100).toFixed(2)}% vs ${((hit / lower) * 100).toFixed(2)}%`);
    ok('整体相似度 = 交集 ÷ 并集',
      Math.abs(data.common.ratioOfUnion - hit / data.common.union) < 0.005,
      `${(data.common.ratioOfUnion * 100).toFixed(2)}% vs ${((hit / data.common.union) * 100).toFixed(2)}%`);
    ok('并集 = 左边 + 右边 − 交集（同平台 ID 就够算）',
      data.common.union === expectUnion, `union=${data.common.union} 期望=${expectUnion}`);
    ok('两个比例都是正数、且整体相似度不会大于重合度',
      data.common.ratioOfUnion > 0 && data.common.ratioOfUnion <= data.common.ratioOfPlaylist,
      `${(data.common.ratioOfUnion * 100).toFixed(2)}% <= ${(data.common.ratioOfPlaylist * 100).toFixed(2)}%`);
    ok('ratioOfSmaller 是兼容用的旧字段，与 ratioOfUnion 同分母',
      data.common.ratioOfSmaller === data.common.ratioOfUnion,
      `${data.common.ratioOfSmaller} vs ${data.common.ratioOfUnion}`);
    ok('报出了「拿不到详情」的数量（不再静默丢弃）',
      data.common.excluded && typeof data.common.excluded.a === 'number' &&
      typeof data.common.excluded.b === 'number' && typeof data.common.noDetail === 'number',
      JSON.stringify(data.common.excluded) + ' noDetail=' + data.common.noDetail);
    ok('a/b 两侧各自给出参与对比的数量',
      data.a.comparable > 0 && data.b.comparable > 0 && data.a.comparable <= data.a.read,
      `a=${data.a.comparable}/${data.a.read} b=${data.b.comparable}/${data.b.read}`);
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
    // 注意：这个歌单是歌单主自己的，他随时可能增删歌。所以只断言「翻页确实读到了
    // 一个量级正确的结果、且和歌单自己声明的总数对得上」，不要写死某个具体数字——
    // 写死的话别人一改歌单，这条断言就莫名其妙地红了。（曾经写死 137，后来歌单变成 135）
    ok(
      'QQ 侧读到了完整歌单（>100 首，且与声明总数一致）',
      data.total.b > 100 && data.b.total === data.total.b,
      `total.b=${data.total.b}，歌单声明=${data.b.total}，readCount=${data.b.read}`
    );
    ok('有跨平台口径的提醒', data.warnings.some((w) => /ID 体系不同/.test(w)), JSON.stringify(data.warnings));
    ok('共同歌曲带 counterpart', data.songs.every((s) => s.counterpart && s.counterpart.id));
    ok('共同歌曲的 audio 统一用优先平台', data.songs.every((s) => s.audio && s.audio.platform === 'netease'));
    /*
     * 跨平台并集必须扣掉匹配上的歌。
     * 原来这里算的是两侧**原始 ID** 的并集，而网易云是数字 ID、QQ 是字母数字 mid，
     * 两个集合永不相交 → union 恒等于 sizeA + sizeB，匹配上的歌从来没被扣掉过。
     * 真实数据下没法精确预言 union 是多少（歌单随时会变），所以断言的是「自洽」：
     * union = 参与对比的候选总数 − 匹配数，且严格小于两侧候选数之和。
     */
    ok('跨平台并集扣掉了匹配上的歌（不是 sizeA + sizeB）',
      data.common.union === data.common.comparable.a + data.common.comparable.b - data.common.count,
      `union=${data.common.union}，a=${data.common.comparable.a} b=${data.common.comparable.b} count=${data.common.count}`);
    ok('并集小于两侧候选数之和', data.common.union < data.common.comparable.a + data.common.comparable.b,
      `union=${data.common.union} < ${data.common.comparable.a + data.common.comparable.b}`);
    ok('跨平台也有「占较小歌单」的参考比例', data.common.ratioOfPlaylist >= data.common.ratioOfUnion,
      `playlist=${(data.common.ratioOfPlaylist * 100).toFixed(2)}% union=${(data.common.ratioOfUnion * 100).toFixed(2)}%`);
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

  /*
   * POST 只收 application/json。
   * 理由：服务只监听 127.0.0.1，但**本机任意网页**都能发一个跨站 <form> POST
   * （表单不需要预检）打到这个端口。要求 JSON 之后表单发不出来，
   * 跨站 JS 得先过 CORS 预检，而本服务从不回 CORS 头，浏览器会拦下来。
   */
  const form = await fetch(`${BASE}/api/compare`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify({
      aRaw: 'https://music.163.com/#/playlist?id=1',
      bRaw: 'https://music.163.com/#/playlist?id=2',
    }),
  });
  ok('跨站表单式 POST（text/plain）被拒', form.status === 415, `status=${form.status}`);
  const formData = await form.json();
  ok('拒绝时给出中文说明', /application\/json/.test(formData?.error || ''), formData?.error);

  // 登录/凭证那一条线已经整条删除，这里固定住「别再悄悄长回来」
  const gone = await fetch(`${BASE}/api/cookie`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  ok('凭证接口已彻底移除（/api/cookie 不存在）', gone.status === 404, `status=${gone.status}`);
  const homeHtml = await (await fetch(`${BASE}/`)).text();
  ok('页面里不再有凭证输入框', !/id="cookie/.test(homeHtml));
}

// ── 对比记录
console.log('\n【对比记录】');
{
  await fetch(`${BASE}/api/history`, { method: 'DELETE' });
  const empty = await (await fetch(`${BASE}/api/history`)).json();
  ok('清空后列表为空', empty.ok && Array.isArray(empty.items) && empty.items.length === 0);

  const saved = await post('/api/history', {
    a: { link: 'https://music.163.com/#/my/m/music/playlist?id=429241928', name: '甲的喜欢', nickname: '甲', platform: 'netease' },
    b: { link: 'https://y.qq.com/n/ryqq/playlist/7716239979', name: '乙的收藏', nickname: '乙', platform: 'qq' },
    shared: 42, totalA: 2205, totalB: 629, ratio: 0.067, ratioUnion: 0.02,
  });
  ok('POST 能存一条', saved.status === 200 && saved.data?.item?.id, `status=${saved.status}`);
  ok('存下来的字段没丢', saved.data?.item?.shared === 42 && saved.data?.item?.a?.platform === 'netease');

  const one = await (await fetch(`${BASE}/api/history`)).json();
  ok('读回来有 1 条', one.items.length === 1, `len=${one.items.length}`);
  ok('记录里带时间戳', /^\d{4}-\d{2}-\d{2}T/.test(one.items[0]?.at || ''), one.items[0]?.at);

  // 同一对歌单再存一次：应该替换，不是堆两条
  await post('/api/history', {
    a: { link: 'https://music.163.com/#/my/m/music/playlist?id=429241928', platform: 'netease' },
    b: { link: 'https://y.qq.com/n/ryqq/playlist/7716239979', platform: 'qq' },
    shared: 43,
  });
  const dedup = await (await fetch(`${BASE}/api/history`)).json();
  ok('同一对歌单不重复堆叠', dedup.items.length === 1, `len=${dedup.items.length}`);
  ok('重复保存时用新的数字', dedup.items[0]?.shared === 43, `shared=${dedup.items[0]?.shared}`);

  const noLink = await post('/api/history', { a: { link: '' }, b: { link: '' }, shared: 1 });
  ok('缺链接的被拒（400）', noLink.status === 400, `status=${noLink.status}`);

  const del = await fetch(`${BASE}/api/history`, { method: 'DELETE' });
  ok('DELETE 清空返回 ok', del.status === 200);
  const after = await (await fetch(`${BASE}/api/history`)).json();
  ok('清空后真的空了', after.items.length === 0);

  const homeHtml2 = await (await fetch(`${BASE}/`)).text();
  ok('首页有「对比记录」这一块', /id="historyList"/.test(homeHtml2));
}

// ── 多人对比
console.log('\n【多人对比】');
{
  const raws = [
    'https://music.163.com/playlist?id=429241928',
    'https://music.163.com/playlist?id=2015697743',
    'https://music.163.com/playlist?id=71384707',
  ];
  const r = await post('/api/compare-many', { raws });
  ok('三个人能比（200）', r.status === 200 && r.data?.ok === true, `status=${r.status}`);
  const d = r.data || {};
  ok('返回 kind=group', d.kind === 'group');
  ok('people 等于 3', d.people === 3, `people=${d.people}`);
  ok('sides 有 3 条且带每人首数',
    Array.isArray(d.sides) && d.sides.length === 3 && d.sides.every((s) => Number.isFinite(s.read) && s.read > 0));
  ok('共同歌曲不多于「至少两人有」', d.common.count <= d.atLeastTwo.count,
    `${d.common.count} > ${d.atLeastTwo.count}`);
  ok('「至少两人有」不多于并集', d.atLeastTwo.count <= d.common.union,
    `${d.atLeastTwo.count} > ${d.common.union}`);
  ok('并集不小于任何一个人的可比数',
    d.common.union >= Math.max(...d.sides.map((s) => s.comparable)));
  ok('两个比例都在 0..1',
    d.common.ratioOfPlaylist >= 0 && d.common.ratioOfPlaylist <= 1 &&
    d.common.ratioOfUnion >= 0 && d.common.ratioOfUnion <= 1);
  ok('交集占比 ≤ 占最小歌单（交集÷并集 ≤ 交集÷最小值）',
    d.common.ratioOfUnion <= d.common.ratioOfPlaylist + 1e-9,
    `${d.common.ratioOfUnion} > ${d.common.ratioOfPlaylist}`);
  ok('共同歌曲都标了 holders（长度 = 3）',
    d.songs.every((s) => Array.isArray(s.holders) && s.holders.length === 3));
  ok('共同歌曲都带可播来源字段', d.songs.every((s) => s.audio && s.audio.platform));

  const one = await post('/api/compare-many', { raws: ['https://music.163.com/playlist?id=429241928'] });
  ok('只填一个人被拒（400）', one.status === 400, `status=${one.status}`);
  const empty = await post('/api/compare-many', {});
  ok('完全不填被拒（400）', empty.status === 400, `status=${empty.status}`);
  const tooMany = await post('/api/compare-many', { raws: Array(9).fill('https://music.163.com/playlist?id=429241928') });
  ok('超过 8 个人被拒（400）', tooMany.status === 400, `status=${tooMany.status}`);
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
