/**
 * 对比统计口径的离线测试：不需要网络、不需要服务、不需要歌单。
 *
 * 为什么要有它：`compare()` 原来直接调 loadSide / loadDetails 打网络，
 * 想测「跨平台并集」「ID 命中但没有详情」这些边界，只能靠真歌单碰运气——
 * 这就是这三处 bug 一直没被发现的原因。现在 compare() 接受 deps 注入，
 * 这里喂假数据进去，把边界钉死。
 *
 * 它验的每一件事都对应一个曾经真实存在的错：
 *   1) 跨平台 union 原来是拿两边的**原始 ID** 去重的，而网易云是数字 ID、
 *      QQ 是字母数字 mid，两个集合永不相交 → union 恒等于 sizeA + sizeB，
 *      匹配上的歌从来没被扣掉过，比例必然偏低。
 *   2) 截断警告是死代码：loadDetails() 把 truncated 放在自己的返回对象上，
 *      compare() 里却检查 loadSide() 那个对象，永远为 false。
 *   3) ID 相同、但两边都取不到详情时，原来被 `if (!s) continue` 静默丢弃，
 *      而分母仍按歌单总数算。
 *
 * 用法：node _dev/compare-check.mjs
 */
import { compare } from '../server.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}   ${extra}`); }
}

/* ---------------- 造假数据的工具 ---------------- */

/** 造一首歌的详情。artists 传空字符串就是「不知道歌手」。 */
const song = (name, artists = '某人', album = '某专辑') => ({
  name,
  artists,
  album,
  cover: 'http://example.invalid/c.jpg',
  dt: 200000,
});

/**
 * 造一次对比的两侧。
 * tracks: [{id, song|null}]，song 为 null 表示「这首拿不到详情」（下架 / 版权变动）。
 * 其余可选字段直接透传给 loadSide 的返回值（truncated / partial / note …）。
 */
function fake({ aPlatform, bPlatform, aTracks, bTracks, aExtra = {}, bExtra = {} }) {
  const side = (label, platform, tracks, extra) => ({
    platform,
    label,
    id: `${platform}-${label}`,
    name: `${label} 的歌单`,
    cover: '',
    nickname: '测试',
    avatar: '',
    trackCount: tracks.length,
    readCount: tracks.length,
    isFavorites: false,
    trackIds: tracks.map((t) => t.id),
    ...extra,
  });
  const details = (tracks, extra) => ({
    ids: tracks.map((t) => t.id),
    allIds: tracks.map((t) => t.id),
    truncated: !!extra.truncated,
    songs: new Map(tracks.filter((t) => t.song).map((t) => [String(t.id), t.song])),
  });

  const loadSide = async (raw, label) =>
    (label === 'A'
      ? side('A', aPlatform, aTracks, aExtra)
      : side('B', bPlatform, bTracks, bExtra));

  // 记下每个 label 对应的 tracks，好判断该给哪一份详情
  const byLabel = { A: details(aTracks, aExtra), B: details(bTracks, bExtra) };
  let call = 0;
  const loadDetails = async () => byLabel[call++ === 0 ? 'A' : 'B'];

  return { deps: { loadSide, loadDetails } };
}

/** 造 n 首正常歌的 tracks（id 用 generateId 生成） */
const tracks = (n, generateId, offset = 1, prefix = '歌') =>
  Array.from({ length: n }, (_, i) => ({
    id: generateId(i + offset),
    song: song(`${prefix}${i + offset}`, `歌手${i + offset}`),
  }));

const neteaseId = (n) => String(900000 + n);
const qqId = (n) => `00${(n + 100).toString(36).toUpperCase()}Mid`;

/* ---------------- 用例 1：跨平台并集必须扣掉匹配上的歌 ---------------- */
console.log('\n【1】跨平台：100 对 100、20 首同名同歌手匹配');
{
  // A 侧 20 首在 B 侧有同名同歌手的对应（id 体系完全不同）
  const matched = 20;
  const aTracks = [
    ...tracks(matched, neteaseId, 1, '共同'),
    ...tracks(100 - matched, neteaseId, 1000, '只有A'),
  ];
  const bTracks = [
    ...tracks(matched, qqId, 1, '共同'),
    ...tracks(100 - matched, qqId, 1000, '只有B'),
  ];
  // 同名同歌手：两侧的歌名/歌手必须完全一致，tracks() 生成的就是一致的

  const { deps } = fake({ aPlatform: 'netease', bPlatform: 'qq', aTracks, bTracks });
  const r = await compare({ aRaw: 'A', bRaw: 'B' }, deps);

  ok('匹配到 20 首', r.common.count === 20, `实得 ${r.common.count}`);
  ok('并集 = sizeA + sizeB − count = 180', r.common.union === 180, `实得 ${r.common.union}`);
  ok('整体相似度 ≈ 11.1%', Math.abs(r.common.ratioOfUnion - 20 / 180) < 1e-9,
    `实得 ${(r.common.ratioOfUnion * 100).toFixed(2)}%`);
  ok('两个比例分母一致（不再一个按歌单总数、一个按并集）',
    r.common.ratioOfSmaller === r.common.ratioOfUnion);
  ok('另外单独给出「占较小歌单」的比例 ≈ 20%',
    Math.abs(r.common.ratioOfPlaylist - 0.2) < 1e-9, `实得 ${(r.common.ratioOfPlaylist * 100).toFixed(2)}%`);
  ok('口径标成 name（跨平台）', r.matchMode === 'name');
}

/* ---------------- 用例 2：同平台 ID 匹配 + 宽松口径 ---------------- */
console.log('\n【2】同平台：ID 严格相等，另有 1 首同名不同 ID 进 variants');
{
  const aTracks = [
    ...tracks(30, neteaseId, 1, '共同'),
    ...tracks(20, neteaseId, 500, '只有A'),
    { id: neteaseId(900), song: song('现场版', '某歌手') },   // A 侧是「现场版」这个歌名
  ];
  const bTracks = [
    ...tracks(30, neteaseId, 1, '共同'),
    ...tracks(10, neteaseId, 700, '只有B'),
    { id: neteaseId(901), song: song('现场版', '某歌手') },   // B 侧 ID 不同、名字歌手相同
  ];
  const { deps } = fake({ aPlatform: 'netease', bPlatform: 'netease', aTracks, bTracks });
  const r = await compare({ aRaw: 'A', bRaw: 'B' }, deps);

  ok('严格口径命中 30 首', r.common.count === 30, `实得 ${r.common.count}`);
  ok('宽松口径多出 1 首同名不同 ID 的', r.variants.length === 1, `实得 ${r.variants.length}`);
  /*
   * 并集 = 30（共同）+ 20（只有 A）+ 10（只有 B）+ 1（B 侧那条同名不同 ID 的）
   *      = 61 个不同的 ID。
   * 宽松口径的 variants.count 与 count 是两套口径，不混在一个分子里，
   * 所以并集按「ID 严格相等」这一套算：A 可比 51 首，B 比 A 多出 10 首只有 B 的，
   * 而那条同名不同 ID 的 B 侧记录 ID 不在 A 里，也算进 B 的可比数 → 51 + 11 = 62。
   */
  ok('并集 = 51 + 11 = 62', r.common.union === 62, `实得 ${r.common.union}`);
  ok('口径标成 id（同平台）', r.matchMode === 'id');
  ok('没有「拿不到详情」的歌', r.common.excluded.a === 0 && r.common.excluded.b === 0);
}

/* ---------------- 用例 3：ID 相同但两边都没有详情 ---------------- */
console.log('\n【3】同平台：10 首 ID 对得上，但都取不到详情（下架 / 版权变动）');
{
  const aTracks = [
    ...tracks(40, neteaseId, 1, '共同'),
    { id: neteaseId(800), song: null },
    { id: neteaseId(801), song: null },
    ...tracks(10, neteaseId, 500, '只有A'),
  ];
  const bTracks = [
    ...tracks(40, neteaseId, 1, '共同'),
    { id: neteaseId(800), song: null },
    { id: neteaseId(801), song: null },
    ...tracks(5, neteaseId, 7000, '只有B'), // 用另一段 ID，别和「只有A」撞上
  ];
  const { deps } = fake({ aPlatform: 'netease', bPlatform: 'netease', aTracks, bTracks });
  const r = await compare({ aRaw: 'A', bRaw: 'B' }, deps);

  ok('仍然只算 40 首共同（那 2 首不算进共同）', r.common.count === 40, `实得 ${r.common.count}`);
  ok('那 2 首被单独报出来，不是静默丢弃', r.common.noDetail === 2, `实得 ${r.common.noDetail}`);
  ok('被排除的数量如实给出（A 侧 2 首）', r.common.excluded.a === 2, `实得 ${r.common.excluded.a}`);
  /*
   * 并集：A 可比 50 首（40 共同 + 10 只有 A）；
   * B 侧 = 只有 B 的 5 首 + 那 2 首「两边都没有详情」的 = 7。
   * 那 2 首必须留在并集里：它们 ID 对得上、真的参与过对比，只是没法确认歌名。
   * 合计 50 + 7 = 57（不是 55 —— 漏掉这 2 首的写法会给出 55）。
   */
  ok('并集把「两边都没详情」的那 2 首也算进去 = 57',
    r.common.union === 57, `实得 ${r.common.union}`);
  ok('警告里说清了「拿不到歌曲信息、已排除」',
    r.warnings.some((w) => w.includes('拿不到歌曲信息')));
  ok('警告里说清了「ID 对得上但没算进共同歌曲」',
    r.warnings.some((w) => w.includes('ID 也对得上')));
}

/* ---------------- 用例 4：截断警告必须真的发出来 ---------------- */
console.log('\n【4】详情被截断（歌单超过 DETAIL_CAP）');
{
  const aTracks = tracks(50, neteaseId, 1, '共同');
  const bTracks = tracks(50, qqId, 1, '共同');
  const { deps } = fake({
    aPlatform: 'netease', bPlatform: 'qq', aTracks, bTracks,
    aExtra: { truncated: true },
  });
  const r = await compare({ aRaw: 'A', bRaw: 'B' }, deps);

  ok('A 侧截断的警告真的出现了（原来是死代码）',
    r.warnings.some((w) => w.includes('只取了前') && w.includes('A 侧')),
    JSON.stringify(r.warnings));
  ok('警告里说明了「不代表整个歌单」',
    r.warnings.some((w) => w.includes('不代表整个歌单')));
  ok('B 侧没截断，就不该有 B 侧的截断警告',
    !r.warnings.some((w) => w.includes('B 侧歌曲太多')));
}

/* ---------------- 用例 5：缺歌手时不与有歌手的误配 ---------------- */
console.log('\n【5】缺歌手：只有「两边都缺歌手且歌名相同」才算同指纹');
{
  const aTracks = [
    { id: neteaseId(1), song: song('同名歌', '') },        // A 缺歌手
    { id: neteaseId(2), song: song('另一首', '歌手X') },
  ];
  const bTracks = [
    { id: qqId(1), song: song('同名歌', '真正的歌手') },   // B 有歌手 → 指纹不同，不该配上
    { id: qqId(2), song: song('另一首', '歌手X') },
    { id: qqId(3), song: song('无名歌', '') },             // 两边都缺歌手
  ];
  const aTracks2 = [...aTracks, { id: neteaseId(3), song: song('无名歌', '') }];
  const { deps } = fake({ aPlatform: 'netease', bPlatform: 'qq', aTracks: aTracks2, bTracks });
  const r = await compare({ aRaw: 'A', bRaw: 'B' }, deps);

  const names = r.songs.map((s) => s.name).sort();
  ok('只匹配到「另一首」和「无名歌」（缺歌手的那首没被误配）',
    names.length === 2 && names.includes('另一首') && names.includes('无名歌'),
    JSON.stringify(names));
}

/* ---------------- 用例 6：分子分母同源（拿不到详情的歌不拉低比例） ---------------- */
console.log('\n【6】分母只算真正参与对比的歌');
{
  // A 有 100 首，其中 50 首拿不到详情；B 有 50 首且全部与 A 的另 50 首一一对应
  const aTracks = [
    ...tracks(50, neteaseId, 1, '共同'),
    ...Array.from({ length: 50 }, (_, i) => ({ id: neteaseId(5000 + i), song: null })),
  ];
  const bTracks = tracks(50, neteaseId, 1, '共同');
  const { deps } = fake({ aPlatform: 'netease', bPlatform: 'netease', aTracks, bTracks });
  const r = await compare({ aRaw: 'A', bRaw: 'B' }, deps);

  ok('50 首全部匹配上', r.common.count === 50, `实得 ${r.common.count}`);
  ok('并集 = 50（不是 150，也不是 100）', r.common.union === 50, `实得 ${r.common.union}`);
  ok('参与对比的数量写进了返回体（A 侧 50）', r.a.comparable === 50, `实得 ${r.a.comparable}`);
  ok('歌单条目数仍然如实保留（A 侧 100）', r.a.read === 100, `实得 ${r.a.read}`);
  ok('重合度是 100%，不再被拿不到详情的歌拉低',
    Math.abs(r.common.ratioOfUnion - 1) < 1e-9, `实得 ${(r.common.ratioOfUnion * 100).toFixed(1)}%`);
}

console.log(`\n${'─'.repeat(46)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
