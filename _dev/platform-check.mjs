/**
 * 平台适配层自测：逐个平台跑一遍取歌单 → 取详情 → 问播放地址。
 * 用法：node _dev/platform-check.mjs
 */
import netease from '../platforms/netease.mjs';
import qq from '../platforms/qq.mjs';
import kugou from '../platforms/kugou.mjs';

const CASES = [
  { platform: netease, input: 'https://music.163.com/#/my/m/music/playlist?id=429241928', name: '网易云 涔涔侧' },
  { platform: netease, input: 'https://music.163.com/playlist?id=2015697743', name: '网易云 关林017' },
  { platform: qq, input: 'https://y.qq.com/n/ryqq/playlist/7716239979', name: 'QQ 大歌单' },
  { platform: qq, input: 'https://y.qq.com/n/ryqq/playlist/7344515327', name: 'QQ 歌单2' },
  { platform: kugou, input: 'https://www.kugou.com/yy/special/single/6025092.html', name: '酷狗歌单' },
  { platform: kugou, input: '6025092', name: '酷狗纯数字' },
];

const only = process.argv[2] ? process.argv.slice(2) : null;

for (const c of CASES) {
  if (only && !only.some((o) => c.name.includes(o))) continue;
  console.log('\n' + '='.repeat(70));
  console.log(`【${c.name}】${c.platform.label}  input=${c.input}`);
  console.log('='.repeat(70));

  const hit = c.platform.match(c.input);
  console.log('  match →', JSON.stringify(hit));
  if (!hit || !hit.id) {
    console.log('  ✗ 没解析出 id');
    continue;
  }

  const t0 = Date.now();
  let pl;
  try {
    pl = await c.platform.fetchPlaylist(hit.id);
  } catch (e) {
    console.log(`  ✗ 取歌单失败（${Date.now() - t0}ms）:`, e.message);
    continue;
  }
  console.log(`  ✓ 取歌单 ${Date.now() - t0}ms`);
  console.log(`     name="${pl.name}"  作者="${pl.nickname}"  声明总数=${pl.trackCount}  读到=${pl.trackIds.length}  partial=${pl.partial}  note="${pl.note}"`);
  console.log(`     封面=${pl.cover ? pl.cover.slice(0, 80) : '(无)'}`);

  const t1 = Date.now();
  const ids = pl.trackIds.slice(0, 400);
  const songs = await c.platform.fetchSongs(ids, pl.raw);
  console.log(`  ✓ 取详情 ${Date.now() - t1}ms  拿到 ${songs.size}/${ids.length} 首`);
  const sample = [...songs.entries()].slice(0, 3);
  for (const [id, s] of sample) {
    console.log(`     · [${id}] ${s.name} — ${s.artists} 《${s.album}》 ${s.dt}ms 封面=${s.cover ? '有' : '无'}`);
  }
  const noArtist = [...songs.values()].filter((s) => !s.artists).length;
  const noAlbum = [...songs.values()].filter((s) => !s.album).length;
  const noDur = [...songs.values()].filter((s) => !s.dt).length;
  console.log(`     缺歌手 ${noArtist} / 缺专辑 ${noAlbum} / 缺时长 ${noDur}`);

  if (c.platform.canPlay === false) {
    console.log('  ⏭  这个平台声明不支持试听，跳过播放地址检查');
    continue;
  }
  const t2 = Date.now();
  const audio = await c.platform.fetchAudio(pl.trackIds.slice(0, 30));
  const playable = [...audio.values()].filter((a) => a.playable).length;
  console.log(`  ✓ 问播放地址 ${Date.now() - t2}ms  前 30 首里 ${playable} 首可播`);
}
console.log('\n完成。');
