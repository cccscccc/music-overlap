'use strict';

const $ = (id) => document.getElementById(id);

const el = {
  inputA: $('inputA'), inputB: $('inputB'),
  hintA: $('hintA'), hintB: $('hintB'),
  runBtn: $('runBtn'), demoBtn: $('demoBtn'), swapBtn: $('swapBtn'),
  status: $('status'), result: $('result'),

  avatarA: $('avatarA'), avatarB: $('avatarB'),
  fallbackA: $('fallbackA'), fallbackB: $('fallbackB'),
  nameA: $('nameA'), nameB: $('nameB'),
  listA: $('listA'), listB: $('listB'),
  countA: $('countA'), countB: $('countB'),
  bigNum: $('bigNum'), ratioFill: $('ratioFill'),
  stats: $('stats'), warnBar: $('warnBar'),
  mergeCard: document.querySelector('.merge-card'),
  duo: $('duo'), groupSummary: $('groupSummary'),
  /** 「89 首」那块（大数字 + 进度条）：两人时在 .duo 中间，多人时搬到一排人下面 */
  mergeCore: document.querySelector('.duo .merge-core'),
  morePeople: $('morePeople'), addPersonBtn: $('addPersonBtn'),

  historyList: $('historyList'), historyEmpty: $('historyEmpty'), clearHistoryBtn: $('clearHistoryBtn'),

  songList: $('songList'), songListTitle: $('songListTitle'), listCount: $('listCount'),
  tierSwitch: $('tierSwitch'),
  emptyList: $('emptyList'), filter: $('filter'),
  viewSwitch: $('viewSwitch'),
  copyBtn: $('copyBtn'), csvBtn: $('csvBtn'),
  playAllBtn: $('playAllBtn'), playNote: $('playNote'),

  variantCard: $('variantCard'), variantList: $('variantList'),
  variantCount: $('variantCount'), variantNote: $('variantNote'),

  player: $('player'), audio: $('audio'),
  pCover: $('pCover'), pName: $('pName'), pArtist: $('pArtist'), pSrc: $('pSrc'),
  pPrev: $('pPrev'), pPlay: $('pPlay'), pNext: $('pNext'),
  pBar: $('pBar'), pLoad: $('pLoad'), pFill: $('pFill'), pKnob: $('pKnob'),
  pCur: $('pCur'), pDur: $('pDur'), pCount: $('pCount'),
  pVolBtn: $('pVolBtn'), pVol: $('pVol'), pClose: $('pClose'),
};

/** 平台元信息（跟服务端 platforms/index.mjs 保持一致） */
const PLATFORMS = {
  netease: { label: '网易云音乐', short: '网易云', canPlay: true },
  qq: { label: 'QQ 音乐', short: 'QQ 音乐', canPlay: true },
  kugou: { label: '酷狗音乐', short: '酷狗', canPlay: false },
};
/** 跨平台时按这个顺序挑能用哪家播 */
const PLAY_ORDER = ['netease', 'qq', 'kugou'];

function platformOf(id) {
  return PLATFORMS[id] || { label: id || '未知平台', short: id || '未知', canPlay: false };
}
function platformBadge(id) {
  const p = platformOf(id);
  if (!id) return '';
  return `<span class="pfa pfa-${escapeHtml(id)}" title="${escapeHtml(p.label)}${p.canPlay ? '' : '（只能对比，不能试听）'}">${
    escapeHtml(p.short)}</span>`;
}

/** 播放坐标：平台 + 平台内歌曲 id。不同平台的 id 体系不同，必须成套用 */
function audioKey(platform, id) {
  return platform && id ? `${platform}:${id}` : '';
}
function songAudio(s) {
  if (s.audio && s.audio.platform && s.audio.id) return s.audio;
  return null;
}
/**
 * 这首歌所有可能放出声的来源，按优先级排好。
 *
 * 为什么要第二个：跨平台对比时，服务端挑的可是「按平台顺序靠前」的那家
 * （网易云 → QQ → 酷狗），**并没有查过它到底能不能播**。同一首歌在网易云是 VIP、
 * 在 QQ 却能听的情况很常见，所以另一边的 ID 必须留着当退路 ——
 * 它已经在数据里了（服务端返回的 counterpart），以前只是没人用。
 */
function playableSources(s) {
  const out = [];
  const push = (platform, id) => {
    if (!platform || !id || !platformOf(platform).canPlay) return;
    const key = audioKey(platform, id);
    if (out.some((x) => x.key === key)) return;
    out.push({ platform, id, key });
  };
  const a = songAudio(s);
  if (a) push(a.platform, a.id);
  if (s.counterpart?.platform && s.counterpart?.id) push(s.counterpart.platform, s.counterpart.id);
  return out;
}

/** 这首歌能不能放：所有来源都拿不到、或查出来都不可播，才算不能放 */
function unplayable(s) {
  const srcs = playableSources(s);
  if (!srcs.length) return true;
  // 还没查完就先当作能放，免得列表一上来就全是灰的
  if (!state.checked) return false;
  return srcs.every((x) => {
    const info = state.playable.get(x.key);
    // 查不到的来源不算「确定不可播」，留着当退路
    return !!(info && !info.playable);
  });
}

const DEMO = {
  a: 'https://music.163.com/#/my/m/music/playlist?id=429241928',
  b: 'https://music.163.com/#/my/m/music/playlist?id=2015697743',
};

const VIEWS = ['list', 'sm', 'md', 'lg'];
const SKIP_LIMIT = 8;
const AUDIO_BATCH = 2000;   // 每次问服务端多少首能不能播
const AUDIO_GROUPS = 2;     // 同时问几批
const PLAY_WAIT_MS = 9000;  // 一首歌超过这么久还没出声，就当它放不出来

const state = {
  songs: [],
  variants: [],
  filterText: '',
  view: 'list',
  playable: new Map(),   // 'platform:id' -> { playable, fee, reason }
  checked: false,        // 是否已经问过「哪些能播」
  autoPlay: false,       // 对比完成后是否还要自动起播
};

/** 只在第一次被浏览器拦下时提示一次 */
let playBlockedWarned = false;

/* ───────────────────────── 小工具 ───────────────────────── */

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDuration(ms) {
  if (!ms) return '';
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function fmtClock(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function pct(x) {
  const v = x * 100;
  if (v === 0) return '0%';
  if (v < 0.1) return '<0.1%';
  if (v >= 99.95) return '100%';
  return `${v.toFixed(1)}%`;
}

let toastTimer = null;
function toast(msg) {
  let box = document.querySelector('.toast');
  if (!box) {
    box = document.createElement('div');
    box.className = 'toast';
    document.body.appendChild(box);
  }
  box.textContent = msg;
  requestAnimationFrame(() => box.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), 2600);
}

function animateNumber(node, target, duration = 900) {
  const start = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    node.textContent = Math.round(target * eased).toLocaleString('zh-CN');
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

let statusTimers = [];
function showStatus(text, isError = false) {
  el.status.className = 'status' + (isError ? ' err' : '');
  el.status.innerHTML = isError
    ? `<span>${escapeHtml(text)}</span>`
    : `<span class="spinner"></span><span>${escapeHtml(text)}</span>`;
  el.status.classList.remove('hidden');
}
function hideStatus() {
  statusTimers.forEach(clearTimeout);
  statusTimers = [];
  el.status.classList.add('hidden');
}
function progressMessages() {
  const steps = [
    [0, '正在读取第一个人的歌单…'],
    [900, '正在读取第二个人的歌单…'],
    [1800, '正在一首一首比对…'],
    [3000, '正在整理歌曲信息和封面…'],
  ];
  statusTimers = steps.map(([delay, text]) =>
    setTimeout(() => {
      const span = el.status.querySelector('span:last-child');
      if (span && !el.status.classList.contains('err')) span.textContent = text;
    }, delay));
}

/** 让一组区块按顺序渐进出现（每次重新触发） */
function revealSequence(nodes, step = 70) {
  nodes.forEach((n) => { if (n) { n.classList.remove('reveal'); n.style.removeProperty('--d'); } });
  void document.body.offsetWidth; // 强制回流，让动画能重播
  nodes.forEach((n, i) => {
    if (!n) return;
    n.style.setProperty('--d', `${i * step}ms`);
    n.classList.add('reveal');
  });
}

/* ───────────────────────── 输入识别 ───────────────────────── */

/** 三家平台的链接写法，识别出「哪个平台 + 歌单 id + 是不是用户主页」 */
const LINK_RULES = [
  {
    id: 'netease',
    test: (s) => /music\.163\.com|163cn\.tv|y\.music\.163\.com/.test(s),
    parse(s) {
      const id = (/[?&#]id=(\d+)/.exec(s) || /\/(?:playlist|user)\/(\d+)/.exec(s) || [])[1];
      if (!id) return null;
      const isUser = /user\/home|\/user\/|user\?/.test(s);
      return { platform: 'netease', id, type: isUser ? 'user' : 'playlist' };
    },
  },
  {
    id: 'qq',
    test: (s) => /y\.qq\.com|c\.y\.qq\.com|i\.y\.qq\.com|qq\.com\/base\/fcgi-bin\/u|url\.cn\/.*qq/i.test(s),
    parse(s) {
      const id = (/\/(?:playlist|taoge|songlist)\/(\d{5,})/.exec(s) || /[?&](?:id|disstid|dissid)=(\d{5,})/.exec(s) || [])[1];
      return id ? { platform: 'qq', id, type: 'playlist' } : null;
    },
  },
  {
    id: 'kugou',
    test: (s) => /kugou\.com|kglink|kgstatic/i.test(s),
    parse(s) {
      const id = (/special\/single\/(\d+)/.exec(s) || /share\/(\d+)/.exec(s) || /[?&#](?:id|specialid)=(\d+)/.exec(s) || [])[1];
      return id ? { platform: 'kugou', id, type: 'playlist' } : null;
    },
  },
];

function parseLink(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  // 纯数字：三家都可能，交给服务端按顺序试
  if (/^\d{5,}$/.test(s)) return { platform: '', id: s, type: 'auto', raw: s };
  for (const rule of LINK_RULES) {
    if (!rule.test(s)) continue;
    const hit = rule.parse(s);
    return hit ? { ...hit, raw: s } : { platform: rule.id, id: '', type: 'unknown', raw: s };
  }
  return null;
}

function updateHint(input, hint) {
  const raw = input.value.trim();
  if (!raw) { hint.textContent = ''; hint.className = 'hint'; return; }
  const p = parseLink(raw);
  if (p && p.id) {
    const name = p.platform ? platformOf(p.platform).short : '';
    if (p.type === 'user') {
      hint.textContent = `已识别${name ? ` ${name} ` : ''}用户主页，ID ${p.id} —— 会自动找 TA 的「我喜欢的音乐」`;
    } else if (p.type === 'auto') {
      hint.textContent = `已识别 ${p.id} —— 会依次按网易云 / QQ 音乐 / 酷狗去读，读到哪个算哪个`;
    } else {
      const extra = p.platform === 'kugou' ? '（酷狗只能读到前 30 首，也听不了）' : '';
      hint.textContent = `已识别${name ? ` ${name} ` : ' '}歌单，ID ${p.id}${extra}`;
    }
    hint.className = 'hint ok';
  } else if (p && p.type === 'unknown') {
    hint.textContent = `这是${platformOf(p.platform).label}的链接，但里面没有歌单 ID。请点开歌单页面，从地址栏复制带 id 的完整地址`;
    hint.className = 'hint bad';
  } else {
    hint.textContent = '没识别出歌单，可以贴完整链接或一串数字（支持网易云 / QQ 音乐 / 酷狗）';
    hint.className = 'hint bad';
  }
}

/* ───────────────────────── 渲染 ───────────────────────── */

function sideAvatar(img, fallback, url, nickname) {
  const wrap = img.parentElement;
  wrap.classList.remove('broken');
  fallback.textContent = (nickname || '?').trim().slice(0, 1) || '?';
  if (url) {
    img.onerror = () => wrap.classList.add('broken');
    img.src = url;
  } else {
    wrap.classList.add('broken');
  }
}

function renderSides(data) {
  /*
   * 平台徽章放在「歌单名」那一行，而不是昵称后面。
   * 原因：390px 宽时两侧栏各只有 157px，昵称 + 徽章超过 110px 就会折行，
   * 右边那块会变成「昵称一行、徽章一行、歌单名又跑到徽章左边」的错位样子。
   * 挪到第二行之后两侧都稳定，桌面端读起来也更顺（昵称上、平台+歌单名下）。
   */
  el.nameA.innerHTML = escapeHtml(data.a.nickname || '左边的人');
  el.nameB.innerHTML = escapeHtml(data.b.nickname || '右边的人');
  el.listA.innerHTML = `${platformBadge(data.a.platform)} ${escapeHtml(data.a.name || '')}`;
  el.listB.innerHTML = `${platformBadge(data.b.platform)} ${escapeHtml(data.b.name || '')}`;
  el.countA.textContent = data.total.a.toLocaleString('zh-CN');
  el.countB.textContent = data.total.b.toLocaleString('zh-CN');
  sideAvatar(el.avatarA, el.fallbackA, data.a.avatar, data.a.nickname);
  sideAvatar(el.avatarB, el.fallbackB, data.b.avatar, data.b.nickname);
}

function renderStats(data) {
  const c = data.common;
  const cell = (k, v, tail) =>
    `<span class="cell"><span class="k">${escapeHtml(k)}</span>` +
    (v ? `<span class="v">${v}</span>` : '') +
    (tail ? `<span class="k">${escapeHtml(tail)}</span>` : '') +
    `</span>`;
  const rule = data.matchMode === 'id'
    ? '同一平台，按歌曲 ID 精确匹配'
    : '跨平台，按同名 + 同歌手匹配';
  /*
   * 两个比例刻意用两个不同的分母，因为它们回答的是两个不同的问题：
   *   重合度     = 交集 ÷ 较小的那一侧歌单 —— 「TA 的歌单我有多少」
   *   整体相似度 = 交集 ÷ 并集            —— 「两个人合起来，重合的部分占多少」
   * 这两个数字都是拿**真正参与对比的歌**算的（拿不到详情的下架曲已经从两边排除，
   * 并会单独提示），所以不会出现分子只数一部分、分母却按全量算的偏低。
   */
  el.stats.innerHTML = [
    cell('重合度', pct(c.ratioOfPlaylist), '占较小的歌单'),
    '<span class="sep"></span>',
    cell('整体相似度', pct(c.ratioOfUnion), '交集 ÷ 并集'),
    '<span class="sep"></span>',
    cell('口径', '', rule),
  ].join('');
}

/** 没读全 / 猜平台 / 跨平台这类「数字要打折看」的提醒，明着摆出来 */
function renderWarnings(data) {
  const list = Array.isArray(data.warnings) ? data.warnings : [];
  if (!list.length) {
    el.warnBar.classList.add('hidden');
    el.warnBar.innerHTML = '';
    return;
  }
  el.warnBar.classList.remove('hidden');
  el.warnBar.innerHTML = list
    .map((w) => `<p><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#ic-warn"/></svg><span>${escapeHtml(w)}</span></p>`)
    .join('');
}

function songRow(s, order, realIndex, opts = {}) {
  const mode = opts.mode || 'song';
  const isVariant = mode === 'variant';
  const bad = state.checked && unplayable(s);
  // variants 里跨平台时没有 pairWith，用 counterpart
  const other = s.pairWith || s.counterpart;
  const pair = other
    ? `<div class="s-pair">↔ 另一边：${escapeHtml(other.name || '')}${
        other.album ? ` · ${escapeHtml(other.album)}` : ''}${
        !s.pairWith && other.platform ? ` ${platformBadge(other.platform)}` : ''}</div>`
    : '';
  const meta = [s.artists, s.album].filter(Boolean).join(' · ');
  // 多人结果里每首歌都带 holders（谁有这首）；标出来才看得出「按重合排」到底在排什么
  const holders = Array.isArray(s.holders) && s.holders.length > 1
    ? `<span class="s-holders" title="有这首的：${escapeHtml(s.holders.join('、'))}">${s.holders.length} 人</span>`
    : '';
  const a = songAudio(s);
  const noSource = !a || !platformOf(a.platform).canPlay;
  const flag = bad
    ? `<span class="s-flag">${noSource ? '无法试听' : (state.playable.get(audioKey(a.platform, a.id))?.fee === 1 ? 'VIP 专享' : '受限')}</span>`
    : '';
  const delay = opts.animate ? Math.min(order - 1, 24) * 24 + 200 : 0;
  const playBtn = bad
    ? ''
    : `<button class="s-play" data-play="${realIndex}" title="播放这首歌" aria-label="播放">` +
      `<svg viewBox="0 0 24 24"><use href="#ic-play"/></svg></button>`;

  return `<li class="song${bad ? ' unplayable' : ''}${opts.animate ? '' : ' no-anim'}" ` +
    `data-i="${realIndex}" data-key="${escapeHtml(audioKey(a?.platform, a?.id))}"` +
    `${opts.animate ? ` style="--d:${delay}ms"` : ''}>` +
    `<div class="s-idx"><span class="num">${order}</span>` +
    `<span class="bars"><i></i><i></i><i></i></span></div>` +
    `<div class="s-art">` +
      (s.cover
        ? `<img loading="lazy" src="${escapeHtml(s.cover)}" alt="" referrerpolicy="no-referrer">`
        : '') +
      playBtn +
    `</div>` +
    `<div class="s-txt">` +
      `<div class="s-name">${escapeHtml(s.name)}</div>` +
      `<div class="s-meta"><span>${escapeHtml(meta)}</span>${holders}${flag}</div>` +
      pair +
    `</div>` +
    `<div class="s-dur">${fmtDuration(s.dt)}</div>` +
  `</li>`;
}

function renderList(container, list, opts = {}) {
  const kw = state.filterText.trim().toLowerCase();
  const indexed = list.map((s, i) => ({ s, i }));
  const shown = kw
    ? indexed.filter(({ s }) => `${s.name} ${s.artists} ${s.album}`.toLowerCase().includes(kw))
    : indexed;
  const animate = opts.animate !== false && !kw;
  container.innerHTML = shown
    .map(({ s, i }) => songRow(s, i + 1, i, { mode: opts.mode, animate }))
    .join('');
  return shown.length;
}

/** 只更新受影响的行，避免打断已经播完的入场动画 */
function applyPlayableMarks() {
  if (!state.checked) return;
  el.songList.querySelectorAll('.song').forEach((li) => {
    const key = li.dataset.key;
    const idx = Number(li.dataset.i);
    const bad = state.checked && unplayable(state.songs[idx]);
    const info = state.playable.get(key);
    li.classList.toggle('unplayable', bad);

    const metaBox = li.querySelector('.s-meta');
    if (metaBox) {
      let flag = metaBox.querySelector('.s-flag');
      if (bad) {
        if (!flag) {
          flag = document.createElement('span');
          flag.className = 's-flag';
          metaBox.appendChild(flag);
        }
        const noSource = !songAudio(state.songs[idx]) || !platformOf(songAudio(state.songs[idx]).platform).canPlay;
        flag.textContent = noSource ? '无法试听' : info?.fee === 1 ? 'VIP 专享' : '受限';
      } else if (flag) {
        flag.remove();
      }
    }

    const art = li.querySelector('.s-art');
    if (!art) return;
    const btn = art.querySelector('.s-play');
    if (bad && btn) {
      btn.remove();
    } else if (!bad && !btn) {
      const b = document.createElement('button');
      b.className = 's-play';
      b.dataset.play = String(idx);
      b.title = '播放这首歌';
      b.setAttribute('aria-label', '播放');
      b.innerHTML = '<svg viewBox="0 0 24 24"><use href="#ic-play"/></svg>';
      art.appendChild(b);
    }
  });
}

function markPlaying(index) {
  el.songList.querySelectorAll('.song').forEach((li) => {
    li.classList.toggle('playing', Number(li.dataset.i) === index);
  });
}

function renderResult(data) {
  el.result.classList.remove('hidden');
  // 从多人切回两个人时，把两人对照放回来、把一排人收起来、把大数字搬回中间
  el.duo.classList.remove('hidden');
  el.groupSummary.classList.add('hidden');
  el.tierSwitch.classList.add('hidden');
  state.group = null;
  if (el.mergeCore.parentElement !== el.duo) {
    el.duo.insertBefore(el.mergeCore, el.duo.querySelector('.who-b'));
  }
  const coreLabel = el.mergeCore.querySelector('.merge-label');
  if (coreLabel) coreLabel.textContent = '你们共同喜欢的歌';
  renderSides(data);
  renderWarnings(data);

  animateNumber(el.bigNum, data.common.count);

  const c = data.common;
  // 进度条跟「整体相似度」走：它是对称的，而且分母就是真正参与对比的那些歌
  const ratio = Math.min(1, c.ratioOfUnion);
  el.ratioFill.style.width = '0';
  requestAnimationFrame(() => {
    el.ratioFill.style.width = `${ratio > 0 ? Math.max(ratio * 100, 2) : 0}%`;
  });

  renderStats(data);

  state.songs = data.songs;
  state.variants = data.variants || [];
  state.checked = false;
  state.playable = new Map();
  state.autoPlay = true;

  const canPlayAny = state.songs.some((s) => songAudio(s) && platformOf(songAudio(s).platform).canPlay);

  el.songListTitle.textContent = data.matchMode === 'id' ? '共同歌曲（两边 ID 完全相同）' : '共同歌曲（同名 + 同歌手）';
  const listCard = el.songList.closest('.list-card');
  setView(state.view);
  const n = renderList(el.songList, state.songs, { mode: 'song', animate: true });
  el.listCount.textContent = state.filterText ? `(${n} / ${state.songs.length})` : `(${state.songs.length})`;
  el.emptyList.textContent = '一首都没重合，你们的播放列表平行得很有性格。';
  el.emptyList.classList.toggle('hidden', state.songs.length > 0);

  if (state.variants.length) {
    el.variantCard.classList.remove('hidden');
    renderList(el.variantList, state.variants, { mode: 'variant', animate: true });
    el.variantCount.textContent = `(${state.variants.length})`;
    el.variantNote.textContent = data.matchMode === 'id'
      ? '这些歌在两边名字和歌手一样，但平台里是两条不同的记录（常见于 Live 版、重制版、不同专辑收录）。严格口径下没有计入上面的数字。'
      : '这些是两边名字和歌手一样、但被判定成不同录音的歌（原版 / Live 版 / 重制版）。没有计入上面的数字。';
  } else {
    el.variantCard.classList.add('hidden');
  }

  if (!canPlayAny) {
    const names = [...new Set(state.songs.map((s) => platformOf(songAudio(s)?.platform).short))];
    el.playNote.textContent =
      `这批共同歌曲来自${names.join(' / ')}，这个平台拿不到播放地址（酷狗的音频接口要浏览器行为指纹校验），只能看列表，不能在网页里试听。`;
    el.playAllBtn.disabled = true;
  } else {
    el.playAllBtn.disabled = false;
    el.playNote.textContent = '正在检查哪些歌可以直接播放…';
  }

  revealSequence([el.mergeCard, listCard, state.variants.length ? el.variantCard : null]);

  el.result.scrollIntoView({ behavior: 'smooth', block: 'start' });

  if (!canPlayAny) return;

  // 对比完成就自动起播：等「哪些能播」查完再播，免得先停在 VIP 曲上反复跳
  checkPlayable().then(() => {
    if (!state.autoPlay) return;
    state.autoPlay = false;
    if (!state.songs.length) return;
    const first = state.songs.findIndex((s) => songAudio(s) && !unplayable(s));
    if (first >= 0) playAt(first);
    else toast('这批共同歌曲都是 VIP / 受限曲目，这里放不出来');
  });
}

/* ───────────────────────── 视图模式 ───────────────────────── */

function setView(v) {
  if (!VIEWS.includes(v)) v = 'list';
  state.view = v;
  el.songList.className = `songs view-${v}`;
  el.variantList.className = `songs view-${v}`;
  el.viewSwitch.querySelectorAll('button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.view === v));
  });
  try { localStorage.setItem('music-overlap-view', v); } catch { /* 忽略 */ }
}

/* ───────────────────────── 哪些能播 ───────────────────────── */

/**
 * 按平台把「共同歌曲」分组，分批问服务端。
 * 分批是为了避开服务端一次最多 3000 首的限制——共同歌曲多的时候（几千首）
 * 一次性问会静默丢掉后面的，界面上却看不出来。
 */
function audioGroups() {
  const byPlatform = new Map();
  const add = (platform, id) => {
    if (!platform || !id || !platformOf(platform).canPlay) return;
    if (!byPlatform.has(platform)) byPlatform.set(platform, new Set());
    byPlatform.get(platform).add(String(id));
  };
  for (const s of [...state.songs, ...state.variants]) {
    const a = songAudio(s);
    if (a) add(a.platform, a.id);
    // 同一首歌在另一边也有记录时，那边也可能是可播的来源
    if (s.counterpart?.platform && s.counterpart?.id) add(s.counterpart.platform, s.counterpart.id);
  }
  return [...byPlatform.entries()].map(([platform, ids]) => ({ platform, ids: [...ids] }));
}

async function askAudioBatches(groups) {
  const jobs = [];
  for (const g of groups) {
    for (let i = 0; i < g.ids.length; i += AUDIO_BATCH) {
      jobs.push({ platform: g.platform, ids: g.ids.slice(i, i + AUDIO_BATCH) });
    }
  }

  const items = {};
  const notes = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      const res = await fetch('/api/audio-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groups: [job] }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || '查询失败');
      Object.assign(items, data.items || {});
      if (Array.isArray(data.notes)) notes.push(...data.notes);
    }
  };
  await Promise.all(Array.from({ length: Math.min(AUDIO_GROUPS, jobs.length) }, worker));
  return { items, notes };
}

async function checkPlayable() {
  if (!state.songs.length) return;
  const groups = audioGroups();
  if (!groups.length) {
    state.checked = true;
    state.playable = new Map();
    return;
  }

  try {
    const { items, notes } = await askAudioBatches(groups);
    state.playable = new Map(
      Object.entries(items).map(([key, v]) => [key, { playable: !!v.playable, fee: Number(v.fee) || 0, reason: v.reason }])
    );
    state.checked = true;

    let ok = 0;
    let bad = 0;
    let noSource = 0;
    for (const s of state.songs) {
      const a = songAudio(s);
      if (!a || !platformOf(a.platform).canPlay) {
        noSource++;
        bad++;
        continue;
      }
      const info = state.playable.get(audioKey(a.platform, a.id));
      if (info && info.playable) ok++;
      else bad++;
    }

    const total = state.songs.length;
    // 多人结果里这批歌就是「重合」的，说明文字跟着说清楚
    const scope = state.group ? `重合的 ${total} 首` : `${total} 首`;
    const extra = notes.length ? ` ${notes[0]}` : '';
    if (ok === 0 && noSource) {
      el.playNote.textContent = `${scope}里 ${noSource} 首来自酷狗，酷狗拿不到播放地址，剩下的也多是 VIP / 受限曲目。${extra}`.trim();
    } else if (ok === 0) {
      el.playNote.textContent =
        `${scope}暂时都放不出来（多半是 VIP / 受限曲目，平台不给访客放）。` +
        (noSource ? `另外其中 ${noSource} 首只有酷狗有，酷狗拿不到播放地址。` : '');
    } else if (bad === 0) {
      el.playNote.textContent = `${scope}全部可以直接播放。`;
    } else {
      el.playNote.textContent =
        `${scope}里有 ${ok} 首可以直接播放；另外 ${bad} 首放不出来` +
        `${noSource ? `（其中 ${noSource} 首来自酷狗，这个平台不支持试听）` : '（VIP / 受限）'}，` +
        `放不出来的会自动跳过。${extra}`;
    }

    applyPlayableMarks();
    markPlaying(currentIndex());
  } catch {
    state.checked = false;
    el.playNote.textContent = '没能确认播放权限，直接点播放试试；放不出来的会自动跳过。';
  }
}

/* ───────────────────────── 播放器 ───────────────────────── */

const audio = el.audio;
let skipStreak = 0;

function currentIndex() { return player.index; }
function playlist() { return state.songs; }

const player = { index: -1, playing: false, alt: 0 }; // alt = 正在试第几个来源，见 playableSources()

function setPlayIcon(playing) {
  el.pPlay.querySelector('use').setAttribute('href', playing ? '#ic-pause' : '#ic-play');
  el.pPlay.setAttribute('aria-label', playing ? '暂停' : '播放');
}

function openPlayer() {
  el.player.classList.add('show');
  document.body.classList.add('player-open');
}

function paintPlayer(index, alt = 0) {
  const s = playlist()[index];
  if (!s) return;
  el.pName.textContent = s.name;
  el.pArtist.textContent = [s.artists, s.album].filter(Boolean).join(' · ');
  // 显示**实际正在播**的那个来源，不然跨平台时会标着一边却在放另一边的音
  const src = playableSources(s)[alt];
  el.pSrc.textContent = src ? platformOf(src.platform).short : '';
  el.pCover.src = s.cover || '';
  el.pCover.onerror = () => { el.pCover.style.visibility = 'hidden'; };
  el.pCover.onload = () => { el.pCover.style.visibility = 'visible'; };
  el.pCover.style.visibility = s.cover ? 'visible' : 'hidden';
  el.pCount.textContent = `第 ${index + 1} / ${playlist().length} 首`;
  el.pFill.style.width = '0';
  el.pKnob.style.left = '0';
  el.pCur.textContent = '0:00';
  el.pDur.textContent = fmtDuration(s.dt) || '0:00';
  markPlaying(index);

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: s.name || '',
        artist: s.artists || '',
        album: s.album || '',
        artwork: s.cover ? [{ src: s.cover, sizes: '300x300', type: 'image/jpeg' }] : [],
      });
    } catch { /* 忽略 */ }
  }
}

/** 记下这次要播的是哪首歌，用于判断「迟迟没出声」时还该不该跳 */
let playingKey = '';
let waitTimer = null;

function clearWait() {
  clearTimeout(waitTimer);
  waitTimer = null;
}

/** 长时间没出声就当它放不出来：不能只听 error 事件，有的失败根本不报错 */
function armWaitGuard(key) {
  clearWait();
  waitTimer = setTimeout(() => {
    if (playingKey !== key) return;
    if (audio.readyState >= 2) return; // 已经能播了，只是慢
    if (tryAltSource('这个来源太慢或没反应')) return;
    skipFailed('这首加载了好一会儿也没出声，跳到下一首');
  }, PLAY_WAIT_MS);
}

/** 跳到下一首并给出可见的反馈（之前是静默跳过，用户只看到播放器自己往前窜） */
function skipFailed(msg) {
  if (player.index < 0) return;
  skipStreak += 1;
  if (skipStreak > SKIP_LIMIT) {
    skipStreak = 0;
    toast('连续好几首都放不出来，可能是网络或权限问题，稍后再试');
    setPlayIcon(false);
    return;
  }
  toast(msg);
  step(1);
}

function playAt(index, { auto = false, alt = 0 } = {}) {
  const list = playlist();
  if (!list.length) return;
  if (index < 0) index = list.length - 1;
  if (index >= list.length) index = 0;

  const s = list[index];
  const srcs = playableSources(s);
  const src = srcs[alt] || null;

  // 一个来源都拿不到（例如酷狗）—— 跳过
  if (!src) {
    skipStreak += 1;
    if (skipStreak > SKIP_LIMIT) {
      skipStreak = 0;
      toast(
        `连续好几首都放不出来。${
          srcs.length ? '这张歌单里 VIP / 受限曲目偏多。' : '这些歌来自酷狗，这个平台不支持试听。'
        }`
      );
      return;
    }
    if (!auto) {
      toast(srcs.length ? `「${s.name}」放不出来，已跳到下一首` : `「${s.name}」来自酷狗，拿不到播放地址，已跳到下一首`);
    }
    return playAt(index + 1, { auto: true });
  }

  if (state.checked && unplayable(s)) {
    skipStreak += 1;
    if (skipStreak > SKIP_LIMIT) {
      skipStreak = 0;
      toast('连续好几首都放不出来，这张歌单里 VIP / 受限曲目偏多，这里放不了');
      return;
    }
    if (!auto) {
      const info = state.playable.get(src.key);
      toast(`「${s.name}」是${info?.fee === 1 ? 'VIP 专享' : '受限'}曲目，已跳到下一首`);
    }
    return playAt(index + 1, { auto: true });
  }

  player.index = index;
  player.alt = alt;
  skipStreak = 0;
  openPlayer();
  paintPlayer(index, alt);

  playingKey = src.key;
  audio.src = `/api/audio?platform=${encodeURIComponent(src.platform)}&sid=${encodeURIComponent(src.id)}`;
  armWaitGuard(playingKey);
  audio.play().catch(() => {
    setPlayIcon(false);
    if (!playBlockedWarned) {
      playBlockedWarned = true;
      toast('浏览器拦住了自动播放，点一下播放键就好');
    }
  });
}

/**
 * 首选来源放不出来时，换另一边的 ID 再试一次。
 * 服务端挑来源只看平台顺序、没查过可播性，所以这一步不是锦上添花：
 * 网易云是 VIP、QQ 却能听的歌，退路就在 counterpart 里。
 *
 * 幂等：只在「能换到一个**没试过的**来源」时才动作，所以 error 事件和「等出声」
 * 兜底可以都放心调用它，不会自己踢自己一脚、也不会来回横跳。
 * 返回 true 表示「已经改试另一个来源了」，调用方不要再跳歌。
 */
function tryAltSource(reason) {
  const list = playlist();
  const s = list[player.index];
  if (!s) return false;
  const srcs = playableSources(s);
  const tried = new Set(srcs.slice(0, (player.alt || 0) + 1).map((x) => x.key));
  const nextIndex = srcs.findIndex((x) => !tried.has(x.key));
  if (nextIndex < 0) return false;
  const next = srcs[nextIndex];
  toast(`这个来源放不了（${reason}），换 ${platformOf(next.platform).label} 的同一首再试`);
  playAt(player.index, { auto: true, alt: nextIndex });
  return true;
}

function togglePlay() {
  if (player.index < 0) return playAt(0);
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
}

function step(delta) {
  const list = playlist();
  if (!list.length) return;
  if (player.index < 0) return playAt(0);
  playAt((player.index + delta + list.length) % list.length);
}

function seekRatio(r) {
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
  audio.currentTime = Math.min(audio.duration, Math.max(0, r * audio.duration));
  paintProgress();
}

function paintProgress() {
  const d = audio.duration;
  const r = Number.isFinite(d) && d > 0 ? audio.currentTime / d : 0;
  el.pFill.style.width = `${r * 100}%`;
  el.pKnob.style.left = `${r * 100}%`;
  el.pCur.textContent = fmtClock(audio.currentTime);
  if (Number.isFinite(d) && d > 0) el.pDur.textContent = fmtClock(d);
  try {
    if (audio.buffered.length) {
      el.pLoad.style.width = `${(audio.buffered.end(audio.buffered.length - 1) / d) * 100}%`;
    }
  } catch { /* 忽略 */ }
}

audio.addEventListener('timeupdate', () => { if (!dragging) paintProgress(); });
audio.addEventListener('progress', paintProgress);
audio.addEventListener('loadedmetadata', paintProgress);
audio.addEventListener('canplay', clearWait);
audio.addEventListener('play', () => {
  player.playing = true;
  setPlayIcon(true);
  markPlaying(player.index);
  // 真的出声了才算数，不然「等出声」的兜底会把能播的歌也跳过去
  if (audio.readyState >= 2) clearWait();
});
audio.addEventListener('pause', () => { player.playing = false; setPlayIcon(false); });
audio.addEventListener('ended', () => { clearWait(); step(1); });
/**
 * 播不动时的处理。
 * 以前这里写的是「还没查完能不能播就直接 return」，结果自动起播阶段（或整批查询失败时）
 * 会静默卡住：不提示、不跳歌。现在无论查没查完，都会出声提示并跳到下一首。
 */
audio.addEventListener('error', () => {
  if (player.index < 0) return;
  clearWait();
  // 先试另一边的来源（跨平台时 counterpart 就在数据里），试过才跳歌
  if (tryAltSource('这个来源拿不到音频')) return;
  // 刻意不把这首歌永久标成「不可播」：播放失败可能只是一次网络抖动，
  // 标死了下次点它就再也播不了。
  skipFailed('这首放不出来，跳到下一首');
});

/* 进度条拖动 */
let dragging = false;
function barRatio(e) {
  const r = el.pBar.getBoundingClientRect();
  return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
}
el.pBar.addEventListener('pointerdown', (e) => {
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
  dragging = true;
  el.pBar.classList.add('dragging');
  try { el.pBar.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
  seekRatio(barRatio(e));
});
el.pBar.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const r = barRatio(e);
  el.pFill.style.width = `${r * 100}%`;
  el.pKnob.style.left = `${r * 100}%`;
  el.pCur.textContent = fmtClock(r * (audio.duration || 0));
});
const endDrag = (e) => {
  if (!dragging) return;
  dragging = false;
  el.pBar.classList.remove('dragging');
  seekRatio(barRatio(e));
  try { el.pBar.releasePointerCapture(e.pointerId); } catch { /* 忽略 */ }
};
el.pBar.addEventListener('pointerup', endDrag);
el.pBar.addEventListener('pointercancel', endDrag);
el.pBar.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') { audio.currentTime = Math.max(0, audio.currentTime - 5); paintProgress(); e.preventDefault(); }
  if (e.key === 'ArrowRight') { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5); paintProgress(); e.preventDefault(); }
});

el.pPlay.addEventListener('click', togglePlay);
el.pPrev.addEventListener('click', () => step(-1));
el.pNext.addEventListener('click', () => step(1));

el.pVol.addEventListener('input', () => {
  audio.volume = Number(el.pVol.value);
  audio.muted = audio.volume === 0;
  paintVolIcon();
});
function paintVolIcon() {
  const silent = audio.muted || audio.volume === 0;
  el.pVolBtn.querySelector('use').setAttribute('href', silent ? '#ic-mute' : '#ic-volume');
}
el.pVolBtn.addEventListener('click', () => {
  audio.muted = !audio.muted;
  if (!audio.muted && audio.volume === 0) { audio.volume = Number(el.pVol.value) || 1; }
  paintVolIcon();
});
el.pClose.addEventListener('click', () => {
  audio.pause();
  el.player.classList.remove('show');
  document.body.classList.remove('player-open');
  markPlaying(-1);
});

el.playAllBtn.addEventListener('click', () => { skipStreak = 0; playAt(0); });

document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
  if (!el.player.classList.contains('show')) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
});

if ('mediaSession' in navigator) {
  try {
    navigator.mediaSession.setActionHandler('previoustrack', () => step(-1));
    navigator.mediaSession.setActionHandler('nexttrack', () => step(1));
    navigator.mediaSession.setActionHandler('play', () => audio.play().catch(() => {}));
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  } catch { /* 忽略 */ }
}

/* ───────────────────────── 多人 ─────────────────────────
 * 默认两个人（页面上固定的那两个框），点「添加一个人」往后加，最多到 6 个人。
 * 加出来的行没有固定 id，一律从 DOM 里读：删掉一行就真的没了，不需要额外状态。
 * 人数的分界在服务端：2 个人走 /api/compare（ID 精确匹配那一套严格口径），
 * 3 个人以上走 /api/compare-many（「每个人都得有」）。
 */
const SIDE_COLORS = ['#ff6b81', '#4d9cff', '#7c5cff', '#2ecc71', '#ff9f43', '#22d3ee'];
const EXTRA_NAMES = ['第三', '第四', '第五', '第六'];

function extraInputs() {
  return [...el.morePeople.querySelectorAll('input')];
}

/** 顺序：第一个、第二个、后面加的 */
function allInputs() {
  return [el.inputA, el.inputB, ...extraInputs()];
}

function syncAddBtn() {
  const n = extraInputs().length;
  const lbl = el.addPersonBtn.querySelector('.lbl');
  if (lbl) lbl.textContent = `添加${EXTRA_NAMES[n] || '一'}个人`;
  el.addPersonBtn.classList.toggle('hidden', n >= EXTRA_NAMES.length);
}

function addPerson() {
  const n = extraInputs().length;
  if (n >= EXTRA_NAMES.length) return;
  const row = document.createElement('div');
  row.className = 'side side-extra';
  row.style.setProperty('--c', SIDE_COLORS[n + 2]);
  row.style.setProperty('--c-soft', `${SIDE_COLORS[n + 2]}2e`);
  row.innerHTML =
    `<div class="side-head">` +
      `<label><span class="dot"></span>${EXTRA_NAMES[n]}个人的歌单</label>` +
      `<button class="rm" type="button" aria-label="去掉这个人" title="去掉这个人">×</button>` +
    `</div>` +
    `<input type="text" spellcheck="false" autocomplete="off" placeholder="TA 的歌单链接，或整段分享文案">` +
    `<div class="hint"></div>`;
  const input = row.querySelector('input');
  const hint = row.querySelector('.hint');
  input.addEventListener('input', () => updateHint(input, hint));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  row.querySelector('.rm').addEventListener('click', () => { row.remove(); syncAddBtn(); });
  el.morePeople.appendChild(row);
  syncAddBtn();
  input.focus();
}

/** 多人结果：顶部一排人 + 每人首数，下面是「每个人都有」的共同歌曲 */
function renderGroup(data) {
  el.result.classList.remove('hidden');
  el.duo.classList.add('hidden');
  el.groupSummary.classList.remove('hidden');
  el.tierSwitch.classList.remove('hidden');
  renderWarnings(data);

  animateNumber(el.bigNum, data.common.count);

  const c = data.common;
  const ratio = Math.min(1, c.ratioOfUnion);
  el.ratioFill.style.width = '0';
  requestAnimationFrame(() => {
    el.ratioFill.style.width = `${ratio > 0 ? Math.max(ratio * 100, 2) : 0}%`;
  });

  el.groupSummary.innerHTML =
    `<div class="gs-people">` +
      data.sides.map((s, i) =>
        `<span class="gs-person" style="--c:${SIDE_COLORS[i % SIDE_COLORS.length]}">` +
          `<i aria-hidden="true"></i>` +
          `<span class="gs-name">${escapeHtml(s.nickname || s.name || `第 ${i + 1} 个人`)}</span>` +
          `<b>${(s.read || 0).toLocaleString('zh-CN')}</b><small>首</small>` +
        `</span>`).join('<span class="gs-x" aria-hidden="true">×</span>') +
    `</div>` +
    `<div class="gs-note">全员重合 <b>${(c.everyoneCount || 0).toLocaleString('zh-CN')}</b> 首</div>`;
  // 大数字和进度条原本长在 .duo 里面；多人模式 .duo 要收起来，所以把它们搬过来
  el.groupSummary.prepend(el.mergeCore);
  const coreLabel = el.mergeCore.querySelector('.merge-label');
  if (coreLabel) coreLabel.textContent = '至少两人重合';

  el.stats.innerHTML = [
    `<span class="cell"><span class="k">重合度</span><span class="v">${pct(c.ratioOfUnion)}</span>` +
      `<span class="k">占并集</span></span>`,

    '<span class="sep"></span>',
    `<span class="cell"><span class="k">口径</span><span class="k">至少两人重合 · 同名 + 同歌手</span></span>`,
  ].join('');

  state.group = { people: data.people, any: data.songs || [], all: data.everyone || [] };
  state.tier = 'any';
  const btnAny = el.tierSwitch.querySelector('[data-tier="any"]');
  const btnAll = el.tierSwitch.querySelector('[data-tier="all"]');
  if (btnAny) btnAny.textContent = `至少两人重合 (${state.group.any.length})`;
  if (btnAll) btnAll.textContent = `全员重合 (${state.group.all.length})`;

  state.variants = [];
  el.variantCard.classList.add('hidden');
  state.checked = false;
  state.playable = new Map();
  state.autoPlay = true;

  paintGroupTier();

  revealSequence([el.mergeCard, el.songList.closest('.list-card')]);
  el.result.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // 自动开播只在第一次出结果时做一次；切档位不重播
  const canPlayAny = state.songs.some((s) => songAudio(s) && platformOf(songAudio(s).platform).canPlay);
  if (!canPlayAny) return;
  checkPlayable().then(() => {
    if (!state.autoPlay) return;
    state.autoPlay = false;
    if (!state.songs.length) return;
    const first = state.songs.findIndex((s) => songAudio(s) && !unplayable(s));
    if (first >= 0) playAt(first);
    else toast('这批共同歌曲都是 VIP / 受限曲目，这里放不出来');
  });
}

/**
 * 多人结果的列表：按当前档位刷一遍。
 * 「至少两人」是默认档——三个人各两千首时，全员交集常常是 0，而两两之间有过的那批
 * 通常有几十上百首，还能按票数（3/3、2/3）排个先后。
 */
function paintGroupTier() {
  const g = state.group;
  if (!g) return;
  const tier = state.tier || 'any';
  state.songs = tier === 'all' ? g.all : g.any;

  el.songListTitle.textContent = tier === 'all' ? `${g.people} 个人全都重合` : '至少两人重合';
  setView(state.view);
  const n = renderList(el.songList, state.songs, { mode: 'song', animate: true });
  el.listCount.textContent = state.filterText ? `(${n} / ${state.songs.length})` : `(${state.songs.length})`;

  el.emptyList.textContent = tier === 'all'
    ? `这 ${g.people} 个人没有一首全都重合的歌 —— 播放列表平行得很有性格。`
    : `这 ${g.people} 个人里，任意两个人之间也没有一首重合。`;
  el.emptyList.classList.toggle('hidden', state.songs.length > 0);

  [...el.tierSwitch.querySelectorAll('button')].forEach((b) => {
    const on = b.dataset.tier === tier;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });

  const canPlayAny = state.songs.some((s) => songAudio(s) && platformOf(songAudio(s).platform).canPlay);
  if (!canPlayAny) {
    const names = [...new Set(state.songs.map((s) => platformOf(songAudio(s)?.platform).short))];
    el.playNote.textContent = !state.songs.length
      ? ''
      : `这批歌来自${names.join(' / ')}，这个平台拿不到播放地址（酷狗的音频接口要浏览器行为指纹校验），只能看列表。`;
    el.playAllBtn.disabled = true;
  } else {
    el.playAllBtn.disabled = false;
    el.playNote.textContent = '正在检查哪些歌可以直接播放…';
  }
}

/* ───────────────────────── 主流程 ───────────────────────── */

async function run() {
  const raws = allInputs().map((i) => i.value.trim()).filter(Boolean);
  if (raws.length < 2) return showStatus('至少要把两个人的歌单链接填上才能对比。', true);
  if (new Set(raws).size !== raws.length) return showStatus('有两个人填的是同一个链接，换一个再比吧。', true);
  /*
   * 别把没认出来的串硬发给服务端，但判断要放宽：
   * 现在允许贴「一整段分享文案」（中文标题 + 链接），所以带中文或带 http 的一律放行，
   * 只有那种既不是链接、也不是文案、也不像 ID 的碎片才拦下来。
   */
  const bad = raws.filter((r) => !parseLink(r) && !/https?:\/\//i.test(r) && !/[\u4e00-\u9fa5]/.test(r));
  if (bad.length) {
    return showStatus(
      `有 ${bad.length} 个输入没认出歌单 ID。请点开歌单页面从地址栏复制完整地址（里面有 id= 一串数字），` +
      `也可以直接填那串数字，或者把 App 里「复制链接」得到的整段分享文案贴进来。`,
      true,
    );
  }

  const isGroup = raws.length >= 3;

  el.runBtn.disabled = true;
  el.result.classList.add('hidden');
  el.player.classList.remove('show');
  document.body.classList.remove('player-open');
  audio.pause();
  audio.removeAttribute('src');
  clearWait();
  playingKey = '';
  player.index = -1;
  showStatus(isGroup ? `正在读 ${raws.length} 个人的歌单…` : '正在准备…');
  progressMessages();
  saveInputs();

  try {
    const res = await fetch(isGroup ? '/api/compare-many' : '/api/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(isGroup ? { raws } : { aRaw: raws[0], bRaw: raws[1] }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `请求失败（HTTP ${res.status}）`);
    hideStatus();
    if (isGroup) renderGroup(data);
    else renderResult(data);
    saveHistory(data, raws);
  } catch (err) {
    const msg = err instanceof TypeError
      ? '连不上本地服务。请确认那个黑色命令行窗口还开着，然后刷新这个页面。'
      : err.message;
    hideStatus();
    showStatus(msg, true);
  } finally {
    el.runBtn.disabled = false;
  }
}

/* ───────────────────────── 导出 ───────────────────────── */

/** 每首歌在它自己平台的网页地址（导出用） */
function songLink(platform, id) {
  const s = String(id ?? '');
  if (platform === 'netease') return `https://music.163.com/song?id=${encodeURIComponent(s)}`;
  if (platform === 'qq') return `https://y.qq.com/n/ryqq/songDetail/${encodeURIComponent(s)}`;
  if (platform === 'kugou') return `https://www.kugou.com/song/#hash=${encodeURIComponent(s)}`;
  return '';
}

function buildText(list) {
  return list.map((s, i) => `${i + 1}. ${s.name} - ${s.artists}`).join('\n');
}

async function copyList() {
  if (!state.songs.length) return toast('没有可复制的内容');
  const text = buildText(state.songs);
  try {
    await navigator.clipboard.writeText(text);
    toast(`已复制 ${state.songs.length} 首歌名`);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast(`已复制 ${state.songs.length} 首歌名`);
  }
}

function exportCsv() {
  if (!state.songs.length) return toast('没有可导出的内容');
  const rows = [['序号', '歌曲名', '歌手', '专辑', '时长', '来源平台', '能否播放', '链接']];
  state.songs.forEach((s, i) => {
    const a = songAudio(s);
    const info = a ? state.playable.get(audioKey(a.platform, a.id)) : null;
    const p = a ? platformOf(a.platform) : null;
    rows.push([
      i + 1, s.name, s.artists, s.album, fmtDuration(s.dt),
      p ? p.label : '未知',
      !state.checked ? '未知'
        : !p || !p.canPlay ? '该平台不支持试听'
        : info && info.playable ? '可以直接播放'
        : 'VIP / 受限',
      a ? songLink(a.platform, a.id) : '',
    ]);
  });
  const csv = rows.map((r) => r.map((f) => `"${String(f ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `共同歌曲_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast(`已导出 ${state.songs.length} 首`);
}

/* ───────────────────────── 记忆输入 ───────────────────────── */

function saveInputs() {
  try {
    localStorage.setItem('music-overlap', JSON.stringify({ a: el.inputA.value, b: el.inputB.value }));
  } catch { /* 忽略 */ }
}
function restoreInputs() {
  try {
    const d = JSON.parse(localStorage.getItem('music-overlap') || '{}');
    if (d.a) el.inputA.value = d.a;
    if (d.b) el.inputB.value = d.b;
  } catch { /* 忽略 */ }
  try {
    const v = localStorage.getItem('music-overlap-view');
    if (VIEWS.includes(v)) state.view = v;
  } catch { /* 忽略 */ }
}

/* ───────────────────────── 绑定 ───────────────────────── */

el.inputA.addEventListener('input', () => updateHint(el.inputA, el.hintA));
el.inputB.addEventListener('input', () => updateHint(el.inputB, el.hintB));
el.runBtn.addEventListener('click', run);
el.addPersonBtn.addEventListener('click', addPerson);
syncAddBtn();
[el.inputA, el.inputB].forEach((i) =>
  i.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); }));

el.demoBtn.addEventListener('click', () => {
  el.inputA.value = DEMO.a;
  el.inputB.value = DEMO.b;
  updateHint(el.inputA, el.hintA);
  updateHint(el.inputB, el.hintB);
  toast('已填入两个公开歌单，直接点「开始对比」');
});

el.swapBtn.addEventListener('click', () => {
  const t = el.inputA.value;
  el.inputA.value = el.inputB.value;
  el.inputB.value = t;
  updateHint(el.inputA, el.hintA);
  updateHint(el.inputB, el.hintB);
});

/* ── 对比记录 ──
 * 存在本机服务里（/api/history → data/history.json），手机和电脑各自一份。
 * 点一条记录=把那两个链接填回去再比一次：比的是「现在」的数据，
 * 而不是复读一条可能已经过期的旧结果。 */
function historyWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return d.toDateString() === now.toDateString() ? `今天 ${hm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

function renderHistory(items) {
  if (!el.historyList) return;
  el.historyEmpty.classList.toggle('hidden', items.length > 0);
  el.historyList.innerHTML = items.map((it) => {
    const multi = Array.isArray(it.raws) && it.raws.length >= 3;
    const name = (x, fallback) => escapeHtml(x?.nickname || x?.name || fallback);
    // 多人记录只列前两个名字，剩下的用「+N」表示，不然一行放不下
    const who = multi
      ? `${name(it.a, '第一个')} × ${name(it.b, '第二个')} <span class="h-more">+${it.raws.length - 2}</span>`
      : `${name(it.a, '左边')} × ${name(it.b, '右边')}`;
    const badges = platformBadge(it.a?.platform) +
      (!multi && it.b?.platform && it.b.platform !== it.a.platform ? platformBadge(it.b.platform) : '');
    return `<li class="history-item" data-a="${escapeHtml(it.a?.link || '')}" data-b="${escapeHtml(it.b?.link || '')}"` +
      ` data-raws="${escapeHtml(JSON.stringify(it.raws || []))}">
      <div class="h-main"><span class="h-who">${who}</span><span class="h-num">${it.shared || 0} 首</span></div>
      <div class="h-sub">${badges}<span class="h-when">${escapeHtml(historyWhen(it.at))}</span></div>
    </li>`;
  }).join('');
}

/** 把一条记录填回输入框（两个人的填前两个，多人的连同后面加出来的一起铺开） */
function fillFromHistory(raws) {
  const list = raws.filter((r) => String(r || '').trim());
  if (list.length < 2) return false;
  el.inputA.value = list[0];
  el.inputB.value = list[1];
  // 先清掉现有的附加行，再按记录补回来
  el.morePeople.innerHTML = '';
  for (let i = 2; i < list.length; i++) {
    addPerson();
    const inputs = extraInputs();
    inputs[inputs.length - 1].value = list[i];
  }
  allInputs().forEach((i) => {
    const hint = i.parentElement.querySelector('.hint');
    if (hint) updateHint(i, hint);
  });
  syncAddBtn();
  return true;
}

async function loadHistory() {
  try {
    const r = await fetch('/api/history');
    const d = await r.json();
    renderHistory(Array.isArray(d.items) ? d.items : []);
  } catch {
    renderHistory([]);
  }
}

/** 记一笔；失败就算了，不能因为记录失败把对比结果弄丢 */
async function saveHistory(data, raws) {
  try {
    const multi = raws.length >= 3;
    const sides = multi ? (data.sides || []) : [];
    const pick = (i) => (multi
      ? { name: sides[i]?.name, nickname: sides[i]?.nickname, platform: sides[i]?.platform }
      : { name: data[i === 0 ? 'a' : 'b']?.name, nickname: data[i === 0 ? 'a' : 'b']?.nickname, platform: data[i === 0 ? 'a' : 'b']?.platform });
    const payload = {
      a: { link: raws[0], ...pick(0) },
      b: { link: raws[1], ...pick(1) },
      shared: data.common?.count || 0,
      totalA: multi ? (sides[0]?.read || 0) : (data.total?.a || 0),
      totalB: multi ? (sides[1]?.read || 0) : (data.total?.b || 0),
      ratio: data.common?.ratioOfPlaylist || 0,
      ratioUnion: data.common?.ratioOfUnion || 0,
    };
    if (multi) payload.raws = raws;
    await fetch('/api/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    loadHistory();
  } catch { /* 忽略 */ }
}

if (el.historyList) {
  el.historyList.addEventListener('click', (e) => {
    const li = e.target.closest('.history-item');
    if (!li || !li.dataset.a || !li.dataset.b) return;
    let raws = [];
    try { raws = JSON.parse(li.dataset.raws || '[]'); } catch { raws = []; }
    if (!fillFromHistory(Array.isArray(raws) && raws.length ? raws : [li.dataset.a, li.dataset.b])) return;
    toast(raws.length >= 3 ? `正在重新对比这 ${raws.length} 个歌单…` : '正在重新对比这两个歌单…');
    run();
  });
}

if (el.clearHistoryBtn) {
  el.clearHistoryBtn.addEventListener('click', async () => {
    try {
      await fetch('/api/history', { method: 'DELETE' });
    } catch { /* 忽略 */ }
    renderHistory([]);
    toast('对比记录已清空');
  });
}

loadHistory();

el.filter.addEventListener('input', () => {
  state.filterText = el.filter.value;
  const n = renderList(el.songList, state.songs, { mode: 'song' });
  el.listCount.textContent = state.filterText
    ? `(${n} / ${state.songs.length})`
    : `(${state.songs.length})`;
  markPlaying(player.index);
});

el.viewSwitch.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (btn) setView(btn.dataset.view);
});

el.tierSwitch.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tier]');
  if (!btn || btn.classList.contains('on')) return;
  state.tier = btn.dataset.tier;
  paintGroupTier();
});

el.copyBtn.addEventListener('click', copyList);
el.csvBtn.addEventListener('click', exportCsv);

el.songList.addEventListener('click', (e) => {
  const btn = e.target.closest('.s-play');
  const li = e.target.closest('.song');
  if (!btn && !li) return;
  const idx = btn ? Number(btn.dataset.play) : Number(li.dataset.i);
  if (!Number.isInteger(idx)) return;
  skipStreak = 0;
  playAt(idx);
});

restoreInputs();
setView(state.view);
paintVolIcon();
setPlayIcon(false);
updateHint(el.inputA, el.hintA);
updateHint(el.inputB, el.hintB);
// 平台支持情况以服务端为准，将来加平台不用再改前端
fetch('/api/platforms')
  .then((r) => r.json())
  .then((d) => {
    if (!d?.ok) return;
    for (const p of d.platforms || []) {
      PLATFORMS[p.id] = { label: p.label, short: p.short, canPlay: !!p.canPlay };
    }
  })
  .catch(() => { /* 用前端内置的那份就行 */ });
