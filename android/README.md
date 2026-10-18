# android/ — 手机 App

两种形态，**同一份代码**：

| 形态 | 什么时候 | 手机要不要连电脑 |
| --- | --- | --- |
| **独立版**（默认目标） | `android/vendor/` 里有 node 运行时 | **不要**。手机自己就是一个完整的服务 |
| **连电脑版**（退化） | 没放 vendor，或自带引擎在设备上起不来 | 要。App 扫局域网找电脑上的服务 |

启动顺序是**先试自带的引擎**：解压 `assets/app`（server.mjs + platforms + public）到应用私有目录 →
执行 `lib/arm64-v8a/libnode.so` → 轮询 `127.0.0.1:8787/api/health`；起来了就直接用本地页面，
起不来才退回「扫局域网找电脑」。所以最坏情况也只是回到上一版的行为，不会白屏。

## 独立版是怎么塞进去的

- `android/vendor/node`：**Termux 的 aarch64 node**（bionic 构建，能在普通安卓上跑），
  打包时改名成 `lib/arm64-v8a/libnode.so` —— Android 只允许执行 `nativeLibraryDir` 里
  以 `lib*.so` 命名的文件，这是唯一的口子（`android:extractNativeLibs="true"` 让它真的落到磁盘上）。
- `android/vendor/libs/*.so`：node 的 ELF 依赖（`libc++_shared`、`libssl`、`libicu*`、`libz` …），
  **按原 soname 放进 `assets/libs/`**，运行时解到 `filesDir/libs`，靠 `LD_LIBRARY_PATH` 找到。
  没放 jniLibs 是因为 Android 只会解出「最后一段叫 .so」的文件，`libssl.so.3` 会被跳过。
- `server.mjs / platforms / public` 直接进 `assets/app/`，运行时解压执行。

体积代价：node 45MB + 依赖库十几 MB，APK 大约 **35–45MB**。

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

## 没能验证的地方

- **没有在真机上跑过**：这台开发机没有安卓设备，BIOS 里虚拟化是关的也开不了模拟器。
  能验的只有「APK 能构建、签名有效、清单/资源/运行时文件都在」；装上去点开顺不顺只能靠人试。
- 自带引擎失败的原因可能很隐蔽（缺一个 .so、SELinux、16KB 页对齐），所以保留了「连电脑版」退路。
- 局域网扫描按 /24、64 并发；企业网络更大或开了 AP 隔离时扫不到 —— 手填地址即可。
