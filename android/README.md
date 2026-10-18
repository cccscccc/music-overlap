# android/ — 手机 App

**独立形态**：手机自己就是一个完整的服务，不连电脑、不装 Node、不需要同一个 WiFi。

启动顺序：解压 `assets/app`（server.mjs + platforms + public）和 `assets/libs/*.so` 到应用私有目录 →
执行 node 运行时 → 轮询 `127.0.0.1:8787/api/health` → 起来了就把 WebView 指过去。
起不来的话**不会退回到「连电脑」**（那条路已经删掉了），而是留在启动页，
把失败原因和引擎最后十行输出直接摊在屏幕上，并给一个「再试一次」。

## 运行时是怎么塞进去的

- `android/vendor/node`：**Termux 的 aarch64 node**（bionic 构建，能在普通安卓上跑），
  打包时改名成 `lib/arm64-v8a/libnode.so` —— Android 只允许执行 `nativeLibraryDir` 里
  以 `lib*.so` 命名的文件，这是最稳的口子（`android:extractNativeLibs="true"` 让它真的落到磁盘上）。
- **回退**：少数机型/安装器没按 `extractNativeLibs` 把 so 解出来，这时从自己的 APK
  （`lib/<abi>/libnode.so`）里取一份到 `filesDir/libs/`，`chmod 700` 后执行。
  这条回退要求 `targetSdkVersion="28"` —— Android 10 起，targetSdk 29+ 的应用不允许执行
  自己数据目录里的文件（Termux 同样固定在 28）。
- `android/vendor/libs/*.so`：node 的 ELF 依赖（`libc++_shared`、`libssl`、`libicu*`、`libz` …），
  **按原 soname 放进 `assets/libs/`**，运行时解到 `filesDir/libs`，靠 `LD_LIBRARY_PATH` 找到。
  没放 jniLibs 是因为 Android 只会解出「最后一段叫 .so」的文件，`libssl.so.3` 会被跳过。
- `server.mjs / platforms / public` 直接进 `assets/app/`，运行时解压执行。

体积代价：node 43MB + 依赖库 45MB，APK 约 **32MB**（压缩后）。

## 怎么构建

```bash
# 一次性准备（大约 400MB 下载）
#   JDK 17 解到 android/.jdk
#   Android cmdline-tools 解到 android/.sdk
#   sdkmanager "platforms;android-34" "build-tools;34.0.0"
#   再从 Termux 取 node 与依赖，放进 android/vendor/（node + libs/*.so）

set ANDROID_SDK_ROOT=%CD%\android\.sdk
set JAVA_HOME=%CD%\android\.jdk
node android/build.mjs
# → dist/music-overlap-android.apk
```

构建脚本不用 Gradle：只有 1 个 Activity、0 个第三方依赖、0 个 XML 布局，
直接调 `aapt2` / `javac` / `d8` / `zipalign` / `apksigner`，出错能看清是哪一步。

签名用仓库里的 `debug.keystore`（口令 `android`）。**这是自用签名，不是上架签名**：
换机器重新构建会得到不同证书，覆盖安装会失败，需要先卸载旧的。

## 验证情况

- **真机跑通**（v0.7.0）：装机后自带引擎正常启动，页面 / 对比 / 播放都可用。
  这一条证明了 `nativeLibraryDir` 里的 `libnode.so` 能执行、9 个依赖库能从 `filesDir/libs`
  经 `LD_LIBRARY_PATH` 加载。
- **v0.8.0 在另一台机器上没能启动**，且旧版本把失败原因吞掉了（只显示「没找到」）。
  v0.8.1 起会把环境快照（引擎路径、各文件是否存在与大小）和引擎输出显示在启动页上；
  v0.8.2 起删掉「连电脑」这条退路，并加上「从 APK 里取 node 再执行」的回退。
- **仍未知**：其他机型与 Android 版本（尤其 Android 15 的 16KB 页、部分厂商的 SELinux 策略）；
  低端机上首次解压 88MB 的耗时。
