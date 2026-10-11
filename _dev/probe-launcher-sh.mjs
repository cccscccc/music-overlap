/**
 * `启动.sh` 里那段「找 node」的判断，用四种包内状态各跑一遍，看它选了什么、说了什么。
 *
 * 为什么要单独测：这台机器上没有任何 POSIX shell（sh / bash / WSL 都没有），
 * 启动脚本没法在这里真跑一遍。但「选哪个可执行文件、没得选时怎么说话」这一段是纯判断，
 * 把它原样抠出来、用几种包内状态喂进去看结果，比只读一遍代码可信得多。
 *
 * **它验到的边界，别说过头**：脚本先把 `启动.sh` 里那段 sh 原样抠出来（一个字都不改），
 * 再机械翻译成 Python 跑。所以它验的是**分支逻辑**——四种情况下各选了哪个 node、该说的话说了没有；
 * 它**不是**在真的 sh 里跑过，shell 层面的语法错（引号、`[ ]` 写法）它看不出来。
 * 判断逻辑一共 6 行，这个投入只在这种「没有别的办法」的情况下才划算，
 * 不要为了别的脚本也写翻译器。shell 的真实执行只能在 Mac / Linux 上验证。
 *
 * 它读的是**已经打包好的** `dist/音乐重合度-便携版/启动.sh`，
 * 所以改了 `build-portable.mjs` 之后要先重新打包，否则测的还是旧的。
 *
 * 用法：node _dev/probe-launcher-sh.mjs   （需要 PYTHON_EXE 指向真 Python）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shPath = path.join(ROOT, 'dist', '音乐重合度-便携版', '启动.sh');
if (!fs.existsSync(shPath)) {
  console.error(`找不到 ${shPath}，先跑 node _dev/build-portable.mjs`);
  process.exit(1);
}
const src = fs.readFileSync(shPath, 'utf8');

// ---- 从真实启动脚本里抠出那段选择逻辑（一个字都不改） ----
const start = src.indexOf('EXE=""');
const endMark = '\n\nPORT=';
const end = src.indexOf(endMark);
if (start < 0 || end < 0 || end < start) {
  console.error('在 启动.sh 里找不到要抠的那一段，脚本结构可能变了');
  process.exit(1);
}
const chooser = src.slice(start, end).trimEnd();
console.log('从 启动.sh 抠出的判断逻辑：');
console.log(chooser.split('\n').map((l) => `  │ ${l}`).join('\n'));
console.log();

const PY = process.env.PYTHON_EXE;
if (!PY || !fs.existsSync(PY)) {
  console.error('需要一个真 Python 来解释这段逻辑：设 PYTHON_EXE 环境变量');
  process.exit(2);
}

/*
 * 用 Python 来解释它 —— 这不是在跑 sh，只是把每条判断按等价语义翻过去：
 *   [ -x F ]      → os.path.isfile(F) and os.access(F, os.X_OK)
 *   [ -f F ]      → os.path.isfile(F)
 *   command -v C  → shutil.which(C)
 * if/elif/else/fi 的层级与缩进一一对应，所以这段能机械翻译。
 */
function toPython(body) {
  const out = ['def choose(ctx):', '    DIR = ctx["DIR"]', '    EXE = ""', '    say = []'];
  // sh 的 if / elif / else / fi 用关键字配对，Python 用缩进。这里用一个栈来跟住层级：
  // if 压栈，elif / else 先弹再压（同一个 if 的兄弟分支），fi 弹栈。
  const stack = [];
  const emit = (s) => out.push('    '.repeat(stack.length + 1) + s);
  const flag = (s) => out.push('    '.repeat(Math.max(stack.length, 1)) + s);
  const lines = body.split('\n').map((l) => l.trim()).filter((l) => l && l !== 'EXE=""');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^if\s/.test(line) || /^elif\s/.test(line)) {
      const m = line.match(/^(?:if|elif)\s+(.*?);\s*then$/);
      if (!m) { emit(`# 没看懂的判断：${line}`); continue; }
      if (/^elif/.test(line)) stack.pop(); // elif 与 if 同级
      const cond = translateCond(m[1]);
      emit(`${/^elif/.test(line) ? 'elif' : 'if'} ${cond}:`);
      stack.push('if');
      continue;
    }
    if (line === 'else') {
      stack.pop();
      emit('else:');
      stack.push('else');
      // `else` 后面紧跟 `fi` 时，Python 需要一个占位语句
      if ((lines[i + 1] || '') === 'fi') emit('pass');
      continue;
    }
    if (line === 'fi') { stack.pop(); continue; }

    if (/^echo\s+"(.+)"$/.test(line)) {
      const text = line.replace(/^echo\s+"(.*)"$/, '$1').replace(/\$\{?DIR\}?/g, '');
      emit(`say.append(${JSON.stringify(text)})`);
    } else if (/^command\s+-v\s+(\w+).*&&\s*EXE=/.test(line)) {
      // sh 里常见的 `command -v node >/dev/null 2>&1 && EXE="node"` 一行写法
      const c = line.match(/^command\s+-v\s+(\w+)/)[1];
      emit(`if shutil.which("${c}") is not None: EXE = "node"`);
    } else if (/^EXE=/.test(line)) {
      emit(`EXE = ${line.slice(4).replace(/\$\{?DIR\}?/g, 'DIR')}`);
    } else if (/^exit\s+\d+$/.test(line)) {
      emit('return "", [s for s in say if s.strip()]');
    } else {
      emit(`# 跳过：${line}`);
    }
  }
  flag('return EXE, [s for s in say if s.strip()]');
  return out.join('\n');
}

/** 把 sh 的 test 表达式翻成 Python。只覆盖这个脚本里出现过的那几种写法。 */
function translateCond(raw) {
  return raw
    .replace(/\[\s+!\s+"\$(\w+)"\s*=\s*"([^"]+)"\s*\]/g, (_, v, r) => `${v} != ${pyPath(r)}`)
    .replace(/\[\s+"\$(\w+)"\s*=\s*"([^"]+)"\s*\]/g, (_, v, r) => `${v} == ${pyPath(r)}`)
    .replace(/\[\s+-x\s+"([^"]+)"\s*\]/g, (_, f) => {
      const p = pyPath(f);
      return `(os.path.isfile(${p}) and os.access(${p}, os.X_OK))`;
    })
    .replace(/\[\s+-f\s+"([^"]+)"\s*\]/g, (_, f) => `os.path.isfile(${pyPath(f)})`)
    .replace(/\[\s+-z\s+"\$(\w+)"\s*\]/g, (_, v) => `${v} == ""`)
    .replace(/\[\s+-n\s+"\$(\w+)"\s*\]/g, (_, v) => `${v} != ""`)
    .replace(/command\s+-v\s+(\w+)/g, (_, c) => `shutil.which("${c}") is not None`)
    .replace(/\s+2>&1/g, '')
    .replace(/&&/g, ' and ')
    .replace(/\|\|/g, ' or ');
}

/** `"$DIR/bin/node"` → `DIR + "/bin/node"`（sh 里 $DIR 后面直接跟 / 不用加分隔符） */
function pyPath(shExpr) {
  const m = shExpr.match(/^\$\{?DIR\}?(\/.*)?$/);
  if (m) return m[1] ? `DIR + ${JSON.stringify(m[1])}` : 'DIR';
  return JSON.stringify(shExpr);
}

const cases = [
  { name: '① Windows 上打出来的包 + 系统里有 node（最常见）→ 用系统的，但要说清「自带的那个是 Windows 版」', files: ['bin/node.exe'], systemNode: true, expectExe: 'node', expectSay: 'Windows 版' },
  { name: '② 在 Mac/Linux 上重新打过包（有 bin/node）→ 优先用它，不必再解释', files: ['bin/node.exe', 'bin/node'], systemNode: true, expectExe: 'DIR/bin/node', expectSay: null },
  { name: '③ 包里没有 Unix 运行时、系统也没装 node，但包里躺着 node.exe → 必须说清别去点它', files: ['bin/node.exe'], systemNode: false, expectExe: '', expectSay: 'Windows 版' },
  { name: '④ 什么都没有（连 bin/node.exe 都没有）→ 直接给安装办法', files: [], systemNode: false, expectExe: '', expectSay: 'nodejs.org' },
];

let pass = 0;
let fail = 0;
const check = (n, cond, d = '') => {
  if (cond) { pass++; console.log(`  ✓ ${n}${d ? `  → ${d}` : ''}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? `  → ${d}` : ''}`); }
};

for (const c of cases) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-probe-'));
  for (const f of c.files) {
    fs.mkdirSync(path.join(tmp, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(tmp, f), 'x');
    fs.chmodSync(path.join(tmp, f), 0o755);
  }
  const py = `
import os, shutil, sys
from pathlib import Path
DIR = r"${tmp}"
${toPython(chooser).replace('EXE = "DIR/bin/node"', 'EXE = DIR + "/bin/node"')}
exe, say = choose({"DIR": DIR})
# 一律转成 POSIX 形式再打印：Windows 路径里的反斜杠会绕过 repr 的转义，把结果搞乱
print("EXE=" + (Path(exe).as_posix() if exe else ""))
print("SAY=" + " | ".join(say))
`;
  // 「系统里有没有 node」用 PATH 模拟：清空 PATH 就等于没有
  const r = spawnSync(PY, ['-c', py], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PATH: c.systemNode ? process.env.PATH : '' },
  });
  if (r.status !== 0) {
    console.log(`\n${c.name}\n  （解释失败）${(r.stderr || '').split('\n').slice(-10).join('\n')}`);
    console.log('  ── 翻译出来的 Python ──');
    console.log(py.split('\n').map((l) => `  │ ${l}`).join('\n'));
    fail++;
    fs.rmSync(tmp, { recursive: true, force: true });
    continue;
  }

  const rawExe = (/EXE=(.*)/.exec(r.stdout) || [])[1] ?? '(没输出)';
  const say = (/SAY=(.*)/.exec(r.stdout) || [])[1] ?? '';
  // Python 那边已经把路径统一成 POSIX 形式了，这里只需把临时目录换成一个短名字
  const escTmp = tmp.replace(/\\/g, '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const got = rawExe.trim().split(escTmp).join('DIR');

  console.log(`\n${c.name}`);
  console.log(`  选中的可执行文件： ${got || '(空 —— 会打印下面的说明并退出)'}`);
  console.log(`  对用户说的话：     ${say || '（无）'}`);

  check('选对了要跑的可执行文件', got === c.expectExe, `期望 ${c.expectExe || '(空)'}，实得 ${got || '(空)'}`);
  if (c.expectSay) check(`说清了「${c.expectSay}」`, say.includes(c.expectSay));
  else check('不需要解释时就不啰嗦', !say.includes('提示：') && !say.includes('还差一步'));

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${'─'.repeat(52)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log('\n注意：这里验的是「判断逻辑对不对」，不是在真的 sh 里跑过。');
console.log('这台机器上没有 sh / bash / WSL，启动脚本的**真实执行**只能在 Mac 或 Linux 上才算验过。');
process.exit(fail === 0 ? 0 : 1);
