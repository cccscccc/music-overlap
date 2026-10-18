/**
 * 平台注册表
 * 输入 → 平台；平台 → 适配器。server.mjs 只跟这里打交道。
 */

import netease from './netease.mjs';
import qq from './qq.mjs';
import kugou from './kugou.mjs';
import { firstUrl } from './shortlink.mjs';

export const PLATFORMS = { netease, qq, kugou };

/** 展示顺序：这个顺序也用于「跨平台时优先用哪家的音频」 */
export const ORDER = ['netease', 'qq', 'kugou'];

export const PLATFORM_IDS = [...ORDER];

export function getPlatform(id) {
  return PLATFORMS[id] || null;
}

export const PLATFORM_LIST = ORDER.map((id) => ({
  id,
  label: PLATFORMS[id].label,
  short: PLATFORMS[id].short,
  canPlay: PLATFORMS[id].canPlay !== false,
  limitNote: PLATFORMS[id].limitNote || '',
  hints: PLATFORMS[id].hints || [],
}));

/** 每个平台支持的链接写法（填在界面提示里） */
export function allHints() {
  return ORDER.flatMap((id) => PLATFORMS[id].hints || []);
}

/**
 * 解析用户填的东西。
 * 纯数字是三家都可能的写法（网易云歌单 ID / QQ 歌单 ID / 酷狗精选集 ID），
 * 所以按「先网易云 → 再 QQ → 再酷狗」的顺序猜，猜错时 server.mjs 会自动换下一家重试。
 */
export function parseInput(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;

  const digits = /^\d{5,}$/.test(s);
  if (!digits) {
    // 手机 App 的「复制链接」会带上一串文案（分享歌单: 歌单名 歌手 <地址>），
    // 先把地址抠出来再识别，免得文案里的字被当成路径的一部分
    // （比如文案里有 “user” 会被误判成用户主页）。
    const target = firstUrl(s) || s;
    for (const id of ORDER) {
      const hit = PLATFORMS[id].match(target);
      if (hit) return hit;
    }
    return null;
  }

  return ORDER.map((id) => ({ platform: id, kind: 'auto', id: s }));
}

/** 输入的候选列表（纯数字会有多个候选平台） */
export function candidates(raw) {
  const hit = parseInput(raw);
  if (!hit) return null;
  return Array.isArray(hit) ? hit : [hit];
}
