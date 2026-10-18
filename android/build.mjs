/*
 * 打一个安卓 APK（不用 Gradle）。
 *
 *   node android/build.mjs
 *
 * 为什么绕开 Gradle：这个 App 只有 1 个 Activity、0 个第三方依赖、0 个 XML 布局，
 * 走 Gradle 要拉一整套插件和构建缓存（几百 MB、还要联网）；直接调 SDK 里那四个
 * 命令行工具（aapt2 / javac / d8 / zipalign / apksigner）就是几十行的事，而且
 * 每一步出错都看得见是哪一步，不用读 Gradle 的黑箱日志。
 *
 * 需要的环境：
 *   ANDROID_SDK_ROOT（或 ANDROID_HOME，或 android/.sdk）
 *   JAVA_HOME（或 PATH 里的 java）—— javac / keytool / apksigner 都要它
 *   PYTHON_EXE 可选，用来把 classes.dex 塞进 apk（默认找 PATH 里的 python）
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILD = path.join(HERE, 'build');
const OUT = path.join(ROOT, 'dist');
const APK_NAME = 'music-overlap-android.apk';

const BUILD_TOOLS = '34.0.0';
const PLATFORM = 'android-34';
const MIN_SDK = '24';

const log = (...a) => console.log(...a);

/* ── 找工具链 ── */
const sdk = [process.env.ANDROID_SDK_ROOT, process.env.ANDROID_HOME, path.join(HERE, '.sdk')]
  .filter(Boolean)
  .find((p) => fs.existsSync(p));
if (!sdk) {
  console.error('找不到 Android SDK。装一份，或者把 ANDROID_SDK_ROOT 指过去。');
  console.error('  https://developer.android.com/studio#command-tools');
  process.exit(2);
}
const bt = path.join(sdk, 'build-tools', BUILD_TOOLS);
const androidJar = path.join(sdk, 'platforms', PLATFORM, 'android.jar');
// build-tools 里 aapt2/zipalign 是 .exe，d8/apksigner 却只有 .bat，得按实际存在的后缀找
const exe = (n) => {
  const names = process.platform === 'win32' ? [`${n}.exe`, `${n}.bat`, `${n}.cmd`] : [n];
  return names.map((f) => path.join(bt, f)).find((p) => fs.existsSync(p)) || path.join(bt, names[0]);
};

for (const [name, p] of [['build-tools ' + BUILD_TOOLS, bt], ['platforms ' + PLATFORM, androidJar]]) {
  if (!fs.existsSync(p)) {
    console.error(`缺少 ${name}：${p}`);
    console.error(`  sdkmanager "build-tools;${BUILD_TOOLS}" "platforms;${PLATFORM}"`);
    process.exit(2);
  }
}

const javaHome = [process.env.JAVA_HOME, path.join(HERE, '.jdk')].filter(Boolean).find((p) =>
  fs.existsSync(path.join(p, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac'))
);
const javac = javaHome
  ? path.join(javaHome, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac')
  : 'javac';

const python = process.env.PYTHON_EXE || 'python';

/* ── 清理 ── */
fs.rmSync(BUILD, { recursive: true, force: true });
for (const d of ['res', 'classes', 'dex', 'out', 'assets', 'jniLibs']) {
  fs.mkdirSync(path.join(BUILD, d), { recursive: true });
}
fs.mkdirSync(OUT, { recursive: true });

/*
 * 自带引擎（可选）：android/vendor/node 是安卓 aarch64 的 node 二进制，
 * android/vendor/libs/*.so 是它的依赖。有就打成「独立版」，没有就打成「连电脑版」。
 *
 * 为什么依赖库放在 assets 而不是 jniLibs：Android 只会把 lib/*.so 里**最后一段叫 .so**
 * 的文件解到 nativeLibraryDir，而 node 依赖里有一堆 libssl.so.3 这种名字，改了名它又找不到。
 * 所以只有 node 本身进 jniLibs（改名 libnode.so 才能被 exec），其余库自己解到 filesDir/libs。
 */
const VENDOR = path.join(HERE, 'vendor');
const NODE_BIN = path.join(VENDOR, 'node');
const VENDOR_LIBS = path.join(VENDOR, 'libs');
const hasNode = fs.existsSync(NODE_BIN);

const assetApp = path.join(BUILD, 'assets', 'app');
fs.cpSync(path.join(ROOT, 'server.mjs'), path.join(assetApp, 'server.mjs'));
for (const d of ['platforms', 'public']) {
  fs.cpSync(path.join(ROOT, d), path.join(assetApp, d), { recursive: true });
}
let vendorLibs = [];
if (fs.existsSync(VENDOR_LIBS)) {
  vendorLibs = fs.readdirSync(VENDOR_LIBS).filter((f) => f.endsWith('.so') || f.includes('.so.'));
  fs.mkdirSync(path.join(BUILD, 'assets', 'libs'), { recursive: true });
  for (const f of vendorLibs) {
    fs.copyFileSync(path.join(VENDOR_LIBS, f), path.join(BUILD, 'assets', 'libs', f));
  }
}
if (hasNode) {
  fs.mkdirSync(path.join(BUILD, 'jniLibs', 'arm64-v8a'), { recursive: true });
  fs.copyFileSync(NODE_BIN, path.join(BUILD, 'jniLibs', 'arm64-v8a', 'libnode.so'));
  log(`[自带引擎] node ${(fs.statSync(NODE_BIN).size / 1048576).toFixed(1)} MB + ${vendorLibs.length} 个依赖库`);
} else {
  log('[连电脑版] 没找到 android/vendor/node，不塞运行时（手机上要有电脑配合）');
}

const env = {
  ...process.env,
  PATH: [javaHome && path.join(javaHome, 'bin'), bt, process.env.PATH].filter(Boolean).join(path.delimiter),
  JAVA_HOME: javaHome || process.env.JAVA_HOME || '',
};
// Node 20+ 不允许直接 spawn .bat/.cmd（EINVAL），得经 cmd.exe 跑，参数自己加引号
const quoteArg = (s) => {
  s = String(s);
  return /[\s"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const run = (cmd, args, opts = {}) => {
  const batch = process.platform === 'win32' && /\.(bat|cmd)$/i.test(cmd);
  const r = execFileSync(
    batch ? process.env.ComSpec || 'cmd.exe' : cmd,
    batch ? ['/d', '/s', '/c', `"${[cmd, ...args].map(quoteArg).join(' ')}"`] : args,
    { cwd: HERE, env, stdio: 'pipe', encoding: 'utf8', windowsVerbatimArguments: batch, ...opts }
  );
  return r || '';
};

/* ── 1. 编译资源 ── */
log('[1/7] aapt2 compile');
run(exe('aapt2'), ['compile', '--dir', 'res', '-o', path.join('build', 'res.zip')]);

/* ── 2. 链接成未签名 apk ── */
log('[2/7] aapt2 link');
const unsigned = path.join(BUILD, 'out', 'app.unsigned.apk');
run(exe('aapt2'), [
  'link', '-o', unsigned,
  '-I', androidJar,
  '--manifest', 'AndroidManifest.xml',
  path.join('build', 'res.zip'),
  '-A', path.join('build', 'assets'),
  '--auto-add-overlay',
  '--min-sdk-version', MIN_SDK,
  '--target-sdk-version', '34',
]);

/* ── 3. 编译 Java ── */
log('[3/7] javac');
const javaFiles = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.java')) javaFiles.push(p);
  }
};
walk(path.join(HERE, 'java'));
run(javac, [
  '-encoding', 'UTF-8', '-source', '8', '-target', '8',
  '-classpath', androidJar, '-d', path.join('build', 'classes'),
  ...javaFiles,
]);

/* ── 4. dex ── */
log('[4/7] d8');
const classFiles = [];
const walkClass = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkClass(p);
    else if (e.name.endsWith('.class')) classFiles.push(p);
  }
};
walkClass(path.join(BUILD, 'classes'));
run(exe('d8'), ['--lib', androidJar, '--min-api', MIN_SDK, '--output', path.join('build', 'dex'), ...classFiles]);

/* ── 5. 把 classes.dex（和可选的 node 运行时）塞进 apk ──
   Python 的 zipfile 最省事：Node 内置没有解压，aapt2 又不认 lib/ 和任意 assets 追加。 */
log('[5/7] 打包 classes.dex' + (hasNode ? ' + 自带 node' : ''));
const withDex = path.join(BUILD, 'out', 'app.withdex.apk');
const extras = [];
// lib/arm64-v8a/libnode.so —— 只有它必须进 jniLibs（要能被 exec）
if (hasNode) {
  extras.push(`lib/arm64-v8a/libnode.so::${path.join(BUILD, 'jniLibs', 'arm64-v8a', 'libnode.so')}`);
}
const PY_ADD = [
  'import sys, zipfile, shutil',
  'src, dex, out = sys.argv[1:4]',
  'shutil.copyfile(src, out)',
  "z = zipfile.ZipFile(out, 'a', zipfile.ZIP_DEFLATED)",
  "z.write(dex, 'classes.dex')",
  'for pair in sys.argv[4:]:',
  "    arc, p = pair.split('::', 1)",
  '    z.write(p, arc)',
  'z.close()',
].join('\n');
run(python, ['-c', PY_ADD, unsigned, path.join(BUILD, 'dex', 'classes.dex'), withDex, ...extras]);

/* ── 6. 对齐 ── */
log('[6/7] zipalign');
const aligned = path.join(BUILD, 'out', 'app.aligned.apk');
run(exe('zipalign'), ['-f', '4', withDex, aligned]);

/* ── 7. 签名 ── */
log('[7/7] apksigner');
const ks = path.join(HERE, 'debug.keystore');
if (!fs.existsSync(ks)) {
  log('  生成签名用的 keystore（一次就够，之后复用）…');
  run(javaHome ? path.join(javaHome, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool') : 'keytool', [
    '-genkeypair', '-v',
    '-keystore', ks, '-storepass', 'android', '-keypass', 'android',
    '-alias', 'android', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
    '-dname', 'CN=MusicOverlap, OU=dev, O=local, L=local, ST=local, C=CN',
  ]);
}
const apk = path.join(OUT, APK_NAME);
run(exe('apksigner'), [
  'sign', '--ks', ks, '--ks-pass', 'pass:android', '--key-pass', 'pass:android',
  '--min-sdk-version', MIN_SDK, '--out', apk, aligned,
]);

/* ── 验收 ── */
log('\n验收');
const certs = run(exe('apksigner'), ['verify', '--print-certs', apk]);
log('  apksigner verify: ' + (certs.trim().split('\n')[0] || 'OK'));
const badging = run(exe('aapt2'), ['dump', 'badging', apk]);
for (const line of badging.split('\n')) {
  if (/^(package|application-label|launchable-activity|sdkVersion|targetSdkVersion|uses-permission)/.test(line)) {
    log('  ' + line.trim());
  }
}
const size = (fs.statSync(apk).size / 1024).toFixed(0);
log(`\n产物：${apk}（${size} KB）`);
log('装到手机：把 apk 拷过去点开安装（或 adb install -r）。第一次装需要允许「未知来源」。');
