'use strict';

const $ = (id) => document.getElementById(id);
const el = {
  inputA: $('inputA'),
  inputB: $('inputB'),
  hintA: $('hintA'),
  hintB: $('hintB'),
  runBtn: $('runBtn'),
  demoBtn: $('demoBtn'),
  swapBtn: $('swapBtn'),
  loose: $('loose'),
  cookie: $('cookie'),
  status: $('status'),
  result: $('result'),
  bigNum: $('bigNum'),
  heroSub: $('heroSub'),
  ratioFill: $('ratioFill'),
  ratioCaption: $('ratioCaption'),
  stats: $('stats'),
  songList: $('songList'),
  songListTitle: $('songListTitle'),
  listCount: $('listCount'),
  emptyList: $('emptyList'),
  filter: $('filter'),
  copyBtn: $('copyBtn'),
  csvBtn: $('csvBtn'),
  variantCard: $('variantCard'),
  variantList: $('variantList'),
  variantCount: $('variantCount'),
};

const DEMO = {
  a: 'https://music.163.com/#/my/m/music/playlist?id=429241928',
  b: 'https://music.163.com/#/my/m/music/playlist?id=2015697743',
};

let state = { songs: [], variants: [], filterText: '' };

/* ───────── 输入识别 ───────── */

function parseLink(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^\d{5,}$/.test(s)) return { id: s, type: 'playlist', raw: s };
  const m = s.match(/[?&#]?id=(\d+)/) || s.match(/\/(?:playlist|user)\/(\d+)/);
  if (!m) return null;
  const isUser = /user\/home|\/user\/|user\?/.test(s);
  return { id: m[1], type: isUser ? 'user' : 'playlist', raw: s };
}

function updateHint(input, hint, label) {
  const raw = input.value.trim();
  if (!raw) {
    hint.textContent = '';
    hint.className = 'hint';
    return;
  }
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

/* ───────── 提示与状态 ───────── */

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
  toastTimer = setTimeout(() => box.classList.remove('show'), 2200);
}

let statusTimers = [];
function showStatus(text, isError = false) {
  el.status.className = 'card status' + (isError ? ' err' : '');
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
    [3000, '正在整理歌曲信息…'],
  ];
  statusTimers = steps.map(([delay, text]) =>
    setTimeout(() => {
      const span = el.status.querySelector('span:last-child');
      if (span && !el.status.classList.contains('err')) span.textContent = text;
    }, delay)
  );
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ───────── 数字动画 ───────── */

function animateNumber(node, target, duration = 900) {
  const start = performance.now();
  const from = 0;
  const step = (now) => {
    const p = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    node.textContent = Math.round(from + (target - from) * eased).toLocaleString('zh-CN');
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ───────── 渲染 ───────── */

function fmtDuration(ms) {
  if (!ms) return '';
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function pct(x) {
  const v = x * 100;
  if (v === 0) return '0%';
  if (v < 0.1) return '<0.1%';
  return `${v.toFixed(v < 10 ? 1 : 0)}%`;
}

function renderStats(data) {
  const items = [
    { k: '左边歌单', v: data.total.a.toLocaleString('zh-CN'), s: data.a.name },
    { k: '右边歌单', v: data.total.b.toLocaleString('zh-CN'), s: data.b.name },
    {
      k: '共同歌曲',
      v: data.common.effective.toLocaleString('zh-CN'),
      s: data.variants && data.variants.length
        ? `${data.common.count} 首 ID 相同 + ${data.variants.length} 首同名不同版本`
        : '按歌曲 ID 精确匹配',
    },
    { k: '重合度', v: pct(data.common.ratioOfSmaller), s: '占较小的那个歌单' },
  ];
  el.stats.innerHTML = items
    .map(
      (i) => `<div class="stat">
        <div class="k">${escapeHtml(i.k)}</div>
        <div class="v">${i.v}</div>
        <div class="s" title="${escapeHtml(i.s)}">${escapeHtml(i.s)}</div>
      </div>`
    )
    .join('');
}

function songRow(s, index, mode) {
  const url = `https://music.163.com/song?id=${s.id}`;
  const meta = [s.artists, s.album].filter(Boolean).join(' · ');
  const pair = mode === 'variant' && s.pairWith
    ? `<div class="pair">↔ 另一边：${escapeHtml(s.pairWith.name || '')}${
        s.pairWith.album ? ` · ${escapeHtml(s.pairWith.album)}` : ''
      }</div>`
    : '';
  return `<li>
    <div class="idx">${index}</div>
    <div class="info">
      <div class="title"><a href="${url}" target="_blank" rel="noopener">${escapeHtml(s.name)}</a></div>
      <div class="meta">${escapeHtml(meta)}</div>
      ${pair}
    </div>
    <div class="dur">${fmtDuration(s.dt)}</div>
  </li>`;
}

function renderList(container, list, mode) {
  const kw = state.filterText.trim().toLowerCase();
  const shown = kw
    ? list.filter((s) => `${s.name} ${s.artists} ${s.album}`.toLowerCase().includes(kw))
    : list;
  container.innerHTML = shown.map((s, i) => songRow(s, i + 1, mode)).join('');
  return shown.length;
}

function renderResult(data) {
  el.result.classList.remove('hidden');
  animateNumber(el.bigNum, data.common.effective);

  const c = data.common;
  const extra =
    data.variants && data.variants.length
      ? `其中 ${data.songs.length} 首 ID 完全相同，${data.variants.length} 首是同名不同版本`
      : '';
  el.heroSub.textContent =
    `左边 ${data.total.a.toLocaleString('zh-CN')} 首，右边 ${data.total.b.toLocaleString('zh-CN')} 首` +
    (extra ? ` · ${extra}` : '');

  const ratio = Math.min(1, c.ratioOfSmaller);
  el.ratioFill.style.width = '0';
  requestAnimationFrame(() => { el.ratioFill.style.width = `${Math.max(ratio * 100, ratio > 0 ? 2 : 0)}%`; });
  el.ratioCaption.textContent =
    `重合度 ${pct(c.ratioOfSmaller)}（占较小的歌单）· 整体相似度 ${pct(c.ratioOfUnion)}（交集 ÷ 并集）` +
    ` · 用时 ${(data.elapsedMs / 1000).toFixed(1)} 秒`;

  renderStats(data);
  state.songs = data.songs;
  state.variants = data.variants || [];

  el.songListTitle.textContent = state.variants.length ? '共同歌曲（ID 完全相同）' : '共同歌曲';
  const n = renderList(el.songList, state.songs, 'song');
  el.listCount.textContent = state.filterText ? `(${n} / ${state.songs.length})` : `(${state.songs.length})`;
  el.emptyList.classList.toggle('hidden', state.songs.length > 0);

  if (state.variants.length) {
    el.variantCard.classList.remove('hidden');
    renderList(el.variantList, state.variants, 'variant');
    el.variantCount.textContent = `(${state.variants.length})`;
  } else {
    el.variantCard.classList.add('hidden');
  }

  el.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ───────── 主流程 ───────── */

async function run() {
  const a = el.inputA.value.trim();
  const b = el.inputB.value.trim();
  if (!a || !b) {
    showStatus('两边的歌单链接都要填上才能对比。', true);
    return;
  }
  if (a === b) {
    showStatus('两边填的是同一个链接，换一个再比吧。', true);
    return;
  }
  if (!parseLink(a) || !parseLink(b)) {
    showStatus('有链接没识别出歌单 ID。请点开歌单页面后从地址栏复制完整地址（里面有 id= 一串数字），也可以直接填那串数字。', true);
    return;
  }

  el.runBtn.disabled = true;
  el.result.classList.add('hidden');
  showStatus('正在准备…');
  progressMessages();
  saveInputs();

  try {
    const res = await fetch('/api/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        a,
        b,
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

/* ───────── 导出 ───────── */

function buildText(list) {
  return list.map((s, i) => `${i + 1}. ${s.name} - ${s.artists}`).join('\n');
}

async function copyList() {
  const list = state.songs;
  if (!list.length) { toast('没有可复制的内容'); return; }
  const text = buildText(list);
  try {
    await navigator.clipboard.writeText(text);
    toast(`已复制 ${list.length} 首歌名`);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast(`已复制 ${list.length} 首歌名`);
  }
}

function exportCsv() {
  if (!state.songs.length) { toast('没有可导出的内容'); return; }
  const rows = [['序号', '歌曲名', '歌手', '专辑', '时长', '网易云链接']];
  state.songs.forEach((s, i) => {
    rows.push([
      i + 1,
      s.name,
      s.artists,
      s.album,
      fmtDuration(s.dt),
      `https://music.163.com/song?id=${s.id}`,
    ]);
  });
  const csv = rows
    .map((r) => r.map((f) => `"${String(f ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\r\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `共同歌曲_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast(`已导出 ${state.songs.length} 首`);
}

/* ───────── 记忆输入 ───────── */

function saveInputs() {
  try {
    localStorage.setItem('music-overlap', JSON.stringify({
      a: el.inputA.value, b: el.inputB.value,
    }));
  } catch { /* 忽略 */ }
}

function restoreInputs() {
  try {
    const raw = localStorage.getItem('music-overlap');
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d.a) el.inputA.value = d.a;
    if (d.b) el.inputB.value = d.b;
  } catch { /* 忽略 */ }
}

/* ───────── 绑定 ───────── */

el.inputA.addEventListener('input', () => updateHint(el.inputA, el.hintA));
el.inputB.addEventListener('input', () => updateHint(el.inputB, el.hintB));
el.runBtn.addEventListener('click', run);
[el.inputA, el.inputB].forEach((i) =>
  i.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); })
);

el.demoBtn.addEventListener('click', () => {
  el.inputA.value = DEMO.a;
  el.inputB.value = DEMO.b;
  updateHint(el.inputA, el.hintA);
  updateHint(el.inputB, el.hintB);
  toast('已填入两个公开歌单，可以直接点「开始对比」');
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
  const n = renderList(el.songList, state.songs, 'song');
  el.listCount.textContent = state.filterText
    ? `(${n} / ${state.songs.length})`
    : `(${state.songs.length})`;
});

el.copyBtn.addEventListener('click', copyList);
el.csvBtn.addEventListener('click', exportCsv);

restoreInputs();
updateHint(el.inputA, el.hintA);
updateHint(el.inputB, el.hintB);
