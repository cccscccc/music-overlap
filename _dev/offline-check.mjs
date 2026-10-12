/*
 * 离线跑一遍两个界面自检：一个命令，不联网、不需要真实歌单。
 *
 *   node _dev/offline-check.mjs
 *
 * 它做三件事：
 *   1) 起 _dev/offline-server.mjs（假后端，端口 8899）
 *   2) 依次跑 多平台自检.mjs 与 新界面自检.mjs（把 BASE 指过去）
 *   3) 无论成败都把假后端关掉
 *
 * 为什么要包这一层：两个界面自检默认打真实服务 + 真实歌单，歌单被删、断网、
 * 平台改接口就全红，别人 clone 下来也跑不了。这个入口让回归测试变成一条命令。
 *
 * 注意：它验的是**界面行为**（渲染、交互、播放器、导出）。
 * 统计口径的边界在 _dev/compare-check.mjs，接口契约在 _dev/api-check.mjs。
 * 真实歌单那条路仍然值得偶尔跑一次（`node server.mjs 8799` 之后再跑这两个脚本），
 * 因为只有它才能发现「平台接口变了」——离线假数据发现不了。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.OFFLINE_PORT) || 8899;
const BASE = `http://127.0.0.1:${PORT}`;

const run = (args, extraEnv = {}) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, args, {
      cwd: path.resolve(HERE, '..'),
      env: { ...process.env, ...extraEnv },
      stdio: 'inherit',
    });
    p.on('exit', (code) => resolve(code ?? 1));
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waitHealth = async (tries = 40) => {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(150);
  }
  return false;
};

console.log(`\n══ 起假后端：${BASE} ══`);
const srv = spawn(process.execPath, [path.join(HERE, 'offline-server.mjs'), String(PORT)], {
  cwd: path.resolve(HERE, '..'),
  stdio: 'inherit',
});

let code = 1;
try {
  if (!(await waitHealth())) {
    console.error('假后端没起来，检查端口是否被占用');
  } else {
    const a = await run([path.join(HERE, '多平台自检.mjs')], { BASE });
    const b = await run([path.join(HERE, '新界面自检.mjs')], { BASE });
    code = a === 0 && b === 0 ? 0 : 1;
    console.log(`\n══ 离线自检结果：多平台 ${a === 0 ? '通过' : '有失败'} / 新界面 ${b === 0 ? '通过' : '有失败'} ══`);
  }
} finally {
  srv.kill();
}

process.exit(code);
