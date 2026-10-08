'use strict';

const $ = (id) => document.getElementById(id);

const el = {
  inputA: $('inputA'), inputB: $('inputB'),
  hintA: $('hintA'), hintB: $('hintB'),
  runBtn: $('runBtn'), demoBtn: $('demoBtn'), swapBtn: $('swapBtn'),
  loose: $('loose'), cookie: $('cookie'),
  status: $('status'), result: $('result'),

  avatarA: $('avatarA'), avatarB: $('avatarB'),
  fallbackA: $('fallbackA'), fallbackB: $('fallbackB'),
  nameA: $('nameA'), nameB: $('nameB'),
  listA: $('listA'), listB: $('listB'),
  countA: $('countA'), countB: $('countB'),
  bigNum: $('bigNum'), ratioFill: $('ratioFill'),
  stats: $('stats'),
  mergeCard: document.querySelector('.merge-card'),

  songList: $('songList'), songListTitle: $('songListTitle'), listCount: $('listCount'),
  emptyList: $('emptyList'), filter: $('filter'),
  viewSwitch: $('viewSwitch'),
  copyBtn: $('copyBtn'), csvBtn: $('csvBtn'),
  playAllBtn: $('playAllBtn'), playNote: $('playNote'),

  variantCard: $('variantCard'), variantList: $('variantList'), variantCount: $('variantCount'),

  player: $('player'), audio: $('audio'),
  pCover: $('pCover'), pName: $('pName'), pArtist: $('pArtist'),
  pPrev: $('pPrev'), pPlay: $('pPlay'), pNext: $('pNext'),
  pBar: $('pBar'), pLoad: $('pLoad'), pFill: $('pFill'), pKnob: $('pKnob'),
  pCur: $('pCur'), pDur: $('pDur'), pCount: $('pCount'),
  pVolBtn: $('pVolBtn'), pVol: $('pVol'), pClose: $('pClose'),
};

const DEMO = {
  a: 'https://music.163.com/#/my/m/music/playlist?id=429241928',
  b: 'https://music.163.com/#/my/m/music/playlist?id=2015697743',
};

const VIEWS = ['list', 'sm', 'md', 'lg'];
const SKIP_LIMIT = 8;

const state = {
  songs: [],
  variants: [],
  filterText: '',
  view: 'list',
  playable: new Map(),   // id -> { playable, fee }
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

function parseLink(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^\d{5,}$/.test(s)) return { id: s, type: 'playlist', raw: s };
  const m = s.match(/[?&#]?id=(\d+)/) || s.match(/\/(?:playlist|user)\/(\d+)/);
  if (!m) return null;
  const isUser = /user\/home|\/user\/|user\?/.test(s);
  return { id: m[1], type: isUser ? 'user' : 'playlist', raw: s };
}

function updateHint(input, hint) {
  const raw = input.value.trim();
  if (!raw) { hint.textContent = ''; hint.className = 'hint'; return; }
  const p = parseLink(raw);
  if (p) {
    hint.textContent = p.type === 'user'
      ? `已识别用户主页，ID ${p.id} —— 会自动找 TA 的「我喜欢的音乐」`
      : `已识别歌单 ID ${p.id}`;
    hint.className = 'hint ok';
  } else if (/163cn\.tv|music\.163\.com/.test(raw)) {
    hint.textContent = '这是个网易云链接，但里面没有歌单 ID。请点开链接后，从地址栏复制带 ?id= 的完整地址';
    hint.className = 'hint bad';
  } else {
    hint.textContent = '没识别出歌单 ID，可以填完整链接或一串数字';
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
  el.nameA.textContent = data.a.nickname || '左边的人';
  el.nameB.textContent = data.b.nickname || '右边的人';
  el.listA.textContent = data.a.name || '';
  el.listB.textContent = data.b.name || '';
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
  const rule = data.strict
    ? '按歌曲 ID 精确匹配'
    : `同名同歌手也算${data.variants && data.variants.length ? `（另列 ${data.variants.length} 首）` : ''}`;
  el.stats.innerHTML = [
    cell('重合度', pct(c.ratioOfSmaller), '占较小的歌单'),
    '<span class="sep"></span>',
    cell('整体相似度', pct(c.ratioOfUnion), '交集 ÷ 并集'),
    '<span class="sep"></span>',
    cell('口径', '', rule),
  ].join('');
}

function songRow(s, order, realIndex, opts = {}) {
  const mode = opts.mode || 'song';
  const info = state.playable.get(s.id);
  const bad = state.checked && info && !info.playable;
  const pair = mode === 'variant' && s.pairWith
    ? `<div class="s-pair">↔ 另一边：${escapeHtml(s.pairWith.name || '')}${
        s.pairWith.album ? ` · ${escapeHtml(s.pairWith.album)}` : ''}</div>`
    : '';
  const meta = [s.artists, s.album].filter(Boolean).join(' · ');
  const flag = bad
    ? `<span class="s-flag">${info.fee === 1 ? 'VIP 专享' : '受限'}</span>`
    : '';
  const delay = opts.animate ? Math.min(order - 1, 24) * 24 + 200 : 0;
  const playBtn = bad
    ? ''
    : `<button class="s-play" data-play="${realIndex}" title="播放这首歌" aria-label="播放">` +
      `<svg viewBox="0 0 24 24"><use href="#ic-play"/></svg></button>`;

  return `<li class="song${bad ? ' unplayable' : ''}${opts.animate ? '' : ' no-anim'}" ` +
    `data-i="${realIndex}" data-id="${s.id}"` +
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
      `<div class="s-meta"><span>${escapeHtml(meta)}</span>${flag}</div>` +
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
    const id = Number(li.dataset.id);
    const idx = Number(li.dataset.i);
    const info = state.playable.get(id);
    const bad = !!(info && !info.playable);
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
        flag.textContent = info.fee === 1 ? 'VIP 专享' : '受限';
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
  renderSides(data);

  animateNumber(el.bigNum, data.common.effective);

  const c = data.common;
  const ratio = Math.min(1, c.ratioOfSmaller);
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

  el.songListTitle.textContent = state.variants.length ? '共同歌曲（ID 完全相同）' : '共同歌曲';
  const listCard = el.songList.closest('.list-card');
  setView(state.view);
  const n = renderList(el.songList, state.songs, { mode: 'song', animate: true });
  el.listCount.textContent = state.filterText ? `(${n} / ${state.songs.length})` : `(${state.songs.length})`;
  el.emptyList.classList.toggle('hidden', state.songs.length > 0);

  if (state.variants.length) {
    el.variantCard.classList.remove('hidden');
    renderList(el.variantList, state.variants, { mode: 'variant', animate: true });
    el.variantCount.textContent = `(${state.variants.length})`;
  } else {
    el.variantCard.classList.add('hidden');
  }

  el.playNote.textContent = '正在检查哪些歌可以直接播放…';

  revealSequence([el.mergeCard, listCard, state.variants.length ? el.variantCard : null]);

  el.result.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // 对比完成就自动起播：等「哪些能播」查完再播，免得先停在 VIP 曲上反复跳
  checkPlayable().then(() => {
    if (!state.autoPlay) return;
    state.autoPlay = false;
    if (!state.songs.length) return;
    const first = state.songs.findIndex((s) => {
      const info = state.playable.get(s.id);
      return !info || info.playable;
    });
    if (first >= 0) playAt(first);
    else toast('这批共同歌曲都是 VIP / 受限曲目，填登录凭证后才能听');
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

async function checkPlayable() {
  if (!state.songs.length) return;
  const ids = state.songs.map((s) => s.id);
  try {
    const res = await fetch('/api/audio-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || '查询失败');

    state.playable = new Map(data.items.map((i) => [i.id, { playable: i.playable, fee: i.fee }]));
    state.checked = true;

    const ok = data.playable;
    const total = data.total;
    const bad = total - ok;
    if (ok === 0) {
      el.playNote.textContent = `${total} 首暂时都放不出来（多半是 VIP 专享曲）。把登录凭证填进上面的「进阶」区就能播。`;
    } else if (bad === 0) {
      el.playNote.textContent = `${total} 首全部可以直接播放。`;
    } else {
      el.playNote.textContent =
        `${total} 首里有 ${ok} 首可以直接播放；另外 ${bad} 首是 VIP / 受限曲目，${data.loggedIn ? '当前凭证也放不了' : '填登录凭证后可以播放'}。`;
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

const player = { index: -1, playing: false };

function setPlayIcon(playing) {
  el.pPlay.querySelector('use').setAttribute('href', playing ? '#ic-pause' : '#ic-play');
  el.pPlay.setAttribute('aria-label', playing ? '暂停' : '播放');
}

function openPlayer() {
  el.player.classList.add('show');
  document.body.classList.add('player-open');
}

function paintPlayer(index) {
  const s = playlist()[index];
  if (!s) return;
  el.pName.textContent = s.name;
  el.pArtist.textContent = [s.artists, s.album].filter(Boolean).join(' · ');
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

function playAt(index, { auto = false } = {}) {
  const list = playlist();
  if (!list.length) return;
  if (index < 0) index = list.length - 1;
  if (index >= list.length) index = 0;

  const s = list[index];
  const info = state.playable.get(s.id);

  if (state.checked && info && !info.playable) {
    skipStreak += 1;
    if (skipStreak > SKIP_LIMIT) {
      skipStreak = 0;
      toast('连续好几首都放不出来，这张歌单里 VIP 曲目偏多，把登录凭证填进「进阶」区就能一起听');
      return;
    }
    if (!auto) toast(`「${s.name}」是${info.fee === 1 ? 'VIP 专享' : '受限'}曲目，已跳到下一首`);
    return playAt(index + 1, { auto: true });
  }

  player.index = index;
  skipStreak = 0;
  openPlayer();
  paintPlayer(index);

  audio.src = `/api/audio?id=${s.id}`;
  audio.play().catch(() => {
    setPlayIcon(false);
    if (!playBlockedWarned) {
      playBlockedWarned = true;
      toast('浏览器拦住了自动播放，点一下播放键就好');
    }
  });
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
audio.addEventListener('play', () => { player.playing = true; setPlayIcon(true); markPlaying(player.index); });
audio.addEventListener('pause', () => { player.playing = false; setPlayIcon(false); });
audio.addEventListener('ended', () => { step(1); });
audio.addEventListener('error', () => {
  if (player.index < 0) return;
  const s = playlist()[player.index];
  if (s && state.playable.get(s.id)) state.playable.set(s.id, { ...state.playable.get(s.id), playable: false });
  if (!state.checked) return;
  skipStreak += 1;
  if (skipStreak > SKIP_LIMIT) {
    skipStreak = 0;
    toast('连续好几首都放不出来，可能是网络或风控问题，稍后再试');
    return;
  }
  toast('这首放不出来，跳到下一首');
  step(1);
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

/* ───────────────────────── 主流程 ───────────────────────── */

async function run() {
  const a = el.inputA.value.trim();
  const b = el.inputB.value.trim();
  if (!a || !b) return showStatus('两边的歌单链接都要填上才能对比。', true);
  if (a === b) return showStatus('两边填的是同一个链接，换一个再比吧。', true);
  if (!parseLink(a) || !parseLink(b)) {
    return showStatus('有链接没识别出歌单 ID。请点开歌单页面后从地址栏复制完整地址（里面有 id= 一串数字），也可以直接填那串数字。', true);
  }

  el.runBtn.disabled = true;
  el.result.classList.add('hidden');
  el.player.classList.remove('show');
  document.body.classList.remove('player-open');
  audio.pause();
  audio.removeAttribute('src');
  player.index = -1;
  showStatus('正在准备…');
  progressMessages();
  saveInputs();

  try {
    const res = await fetch('/api/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        a, b,
        cookie: el.cookie.value.trim(),
        strict: !el.loose.checked,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `请求失败（HTTP ${res.status}）`);
    hideStatus();
    renderResult(data);
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
  const rows = [['序号', '歌曲名', '歌手', '专辑', '时长', '能否播放', '网易云链接']];
  state.songs.forEach((s, i) => {
    const info = state.playable.get(s.id);
    rows.push([
      i + 1, s.name, s.artists, s.album, fmtDuration(s.dt),
      !state.checked ? '未知' : info && info.playable ? '可以直接播放' : 'VIP / 受限',
      `https://music.163.com/song?id=${s.id}`,
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

el.loose.addEventListener('change', () => {
  if (!el.result.classList.contains('hidden')) toast('口径变了，重新点一次「开始对比」才会生效');
});

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
