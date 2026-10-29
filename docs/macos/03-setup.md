# macOS 开发环境搭建

> 目标机器：Apple Silicon、macOS 14 及以上（MPS 的 bf16 需要 14+）。以下命令最初在 Windows 上整理，
> 阶段 0–5 在 Mac 上照做时已按实际情况逐节修正；以后再有出入，修正本文并提交。
> 一键版：迁移包里的 `restore-on-mac.sh` 负责恢复仓库与权重，`scripts/macos/bootstrap.sh` 负责装依赖。

## 0. 前置

```bash
xcode-select --install          # Apple Clang、git、make
```

**Homebrew。** 国内网络慢时，可在 `~/.zprofile` 里加入清华或中科大镜像：

```bash
export HOMEBREW_API_DOMAIN="https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/api"
export HOMEBREW_BOTTLE_DOMAIN="https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles"
```

**Claude Code** 按官方文档安装（原生安装器或 npm 均可）。在项目根目录启动 `claude`，它会自动读取仓库根的 `CLAUDE.md`。

## 1. 恢复仓库与资产

用迁移包根目录的脚本（默认恢复到 `~/Projects/video2x-studio`，可用第一个参数改路径）：

```bash
bash /Volumes/<U盘>/Video2X-Studio-macOS-Kit/restore-on-mac.sh
```

它会依次做这些事：

1. 校验迁移包完整性（`MANIFEST.sha256`）。
2. 从 `repo/video2x-studio.bundle` 克隆出完整 git 历史。
3. 把 `third_party/` 里锁定版本的源码解压到位（这些不在 git 里）。
4. 把模型与权重拷进 `models/`、`engine-python/weights/`。
5. 把测试素材放到 `testdata/`（已在 .gitignore 中）。

第三方源码锁定版本如下（迁移包里是 `git archive` 打的源码包，目录里的 `COMMIT` 文件记录了提交号）：

| 目录 | 来源 | 提交 |
|---|---|---|
| `third_party/librealesrgan_ncnn_vulkan` | github.com/k4yt3x/librealesrgan-ncnn-vulkan | `c1f2555` |
| `third_party/librealcugan_ncnn_vulkan` | github.com/k4yt3x/librealcugan-ncnn-vulkan | `d9c5a7e` |
| `third_party/librife_ncnn_vulkan` | github.com/k4yt3x/librife-ncnn-vulkan | `f1de3a9` |
| `third_party/spdlog`（备用；默认用 Homebrew） | github.com/gabime/spdlog | `f544fce` |

Windows 用的 ncnn 预编译版是 20240820，Mac 改用 Homebrew ncnn。Boost 在 Mac 上用 Homebrew 版（CLI 只用到 program_options）。

## 2. Homebrew 依赖

```bash
brew install cmake ninja pkgconf git \
             ffmpeg@7 \
             ncnn molten-vk vulkan-loader vulkan-headers vulkan-tools \
             spdlog fmt boost \
             python@3.12 node
```

- 不要装普通的 `ffmpeg` 去替代：9.0 版没有 libvidstab，防抖不可用。
- `vulkan-tools` 提供 `vulkaninfo`，用来确认 MoltenVK 能看到 GPU：`vulkaninfo --summary`。

### 2.1 自编 FFmpeg 7.1.5（Anime4K / HDR 需要）

Homebrew 的 `ffmpeg@7` 没有 libplacebo 滤镜，Anime4K 与 SDR 转 HDR 用不了。用脚本自编一份同版本的：

```bash
bash scripts/macos/build-ffmpeg.sh      # 产物：third_party/ffmpeg-macos（约 23 MB，已被 .gitignore 忽略）
```

- 源码取 FFmpeg 官方 GitHub 仓库的 `n7.1.5` 标签（ffmpeg.org 在国内连不上），下载后核对 SHA-256；缺的 Homebrew 依赖（libplacebo、x264、x265 等）脚本会自动装。
- M5 Max 上编译约 1 分钟，国内下载源码约 1.5 分钟。已装好时直接跳过，`--force` 强制重编。`bootstrap.sh` 已包含这一步。
- 装好后，`build-core.sh`、bridge、worker 都优先用它；没有时退回 `ffmpeg@7`（其余功能正常，只是界面把 Anime4K 与 HDR 置灰）。`ffmpeg@7` 仍要装，作后备，`compare.sh` 也用它。
- 可用 `VIDEO2X_FFMPEG_DIR` 指定别的 FFmpeg 目录（bridge 会把同一路径传给 Python 引擎）。核心链接的 FFmpeg 必须与它一致，`doctor.sh` 会检查。

## 3. Python 环境

开发期用虚拟环境 `engine-python/.venv`（bridge 已有回退到 `.venv` 的逻辑，移植时把 Windows 的 `Scripts/python.exe` 改成 `bin/python3`）：

```bash
cd ~/Projects/video2x-studio
"$(brew --prefix python@3.12)/bin/python3.12" -m venv engine-python/.venv
engine-python/.venv/bin/pip install -U pip
engine-python/.venv/bin/pip install -r engine-python/requirements-macos.txt
# 国内可加：-i https://pypi.tuna.tsinghua.edu.cn/simple
```

SwiftVR 需要的依赖覆盖层：diffusers 0.36 与 SeedVR2 用的 0.33 不能共存，所以单独装一个目录，只在 SwiftVR 进程里排在 `sys.path` 最前：

```bash
engine-python/.venv/bin/pip install --no-deps --target engine-python/swiftvr-libs diffusers==0.36.0
```

decord 在 macOS arm64 + Python 3.12 上没有可用 wheel，不装。runner 会注入空模块（D7，阶段 3 实现）。

## 4. 前端依赖

```bash
cd ui
npm config set registry https://registry.npmmirror.com      # 国内可选
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
npm ci
node node_modules/electron/install.js   # Electron 43 起 npm ci 不再下载本体，要显式下载（带上面的镜像变量）
```

Windows 端当时用 Node 24.14、npm 11.11。vite 7 要求 Node ≥ 20.19。Mac 上实测 Homebrew 的 Node 26.11 / npm 11.20 可用。

npm 11.20 会提示 `electron-winstaller`、`esbuild`、`fsevents` 的安装脚本"not yet covered by allowScripts"而跳过。实测不影响开发：esbuild 的平台二进制由可选依赖直接提供，`electron-winstaller` 只用于 Windows 打包。

## 5. 权重与模型放置

`restore-on-mac.sh` 已经拷好下面这些文件，这里列出来备查：

| 路径 | 用途 | Mac 上可直接用？ |
|---|---|---|
| `models/realesrgan`、`realcugan`、`rife`、`span`、`libplacebo` | ncnn 模型与 Anime4K 着色器 | 是 |
| `engine-python/weights/realbasicvsr_x4.pth`、`spynet.pth` | RealBasicVSR | 是 |
| `engine-python/weights/SeedVR2-3B/ema_vae_fp16.safetensors`、`neg_emb.pt`、`pos_emb.pt` | SeedVR2 的 VAE 与文本嵌入 | 是 |
| `engine-python/weights/SeedVR2-3B/seedvr2_ema_3b_fp8_e4m3fn.safetensors` | SeedVR2 DiT（FP8） | **否**，MPS 不支持 FP8，需要下面的 fp16 版 |
| `engine-python/weights/SwiftVR/swiftvr_transformer_fp8.safetensors` 等 | SwiftVR（FP8 权重 + reae + prompt_embedding + config） | 需在 CPU 上还原为 bf16/fp16 后再上 MPS（D5，阶段 3） |
| `engine-python/weights/SwiftVR/transformer/diffusion_pytorch_model.safetensors` | SwiftVR 官方原版 FP32（18.6 GB，可选） | 可用来一次性转出 bf16 文件 |

SeedVR2 fp16 DiT 需要另行下载（约 7 GB），SHA256 来自 `vendor/seedvr2/src/utils/model_registry.py`：

```bash
cd ~/Projects/video2x-studio/engine-python/weights/SeedVR2-3B
curl -L -C - -o seedvr2_ema_3b_fp16.safetensors \
  https://hf-mirror.com/numz/SeedVR2_comfyUI/resolve/main/seedvr2_ema_3b_fp16.safetensors
shasum -a 256 seedvr2_ema_3b_fp16.safetensors
# 应为 2fd0e03a3dad24e07086750360727ca437de4ecd456f769856e960ae93e2b304
```

## 6. 体检

```bash
bash scripts/macos/doctor.sh
```

报告芯片 / 内存 / 系统版本，以及 Homebrew 依赖、FFmpeg 滤镜（vidstab / libplacebo）、MoltenVK 设备、PyTorch MPS 冒烟（含 Conv3d、bf16、fp16）、权重就位情况。把输出贴进 Claude Code 会话，作为阶段 0 的结论。

## 7. 编译 C++ 核心（阶段 1）

```bash
bash scripts/macos/build-core.sh        # 产物：build-macos/video2x、build-macos/libvideo2x.dylib
```

在 M5 Max 上全量编译约 5 秒。第一次在 Mac 上编译时遇到并已修复的问题（`target_clones` 只报警告，并不会失败）：

- Homebrew ncnn 依赖 OpenMP：`build-core.sh` 传 `OpenMP_ROOT` 与 `CMP0074`
- GNU ld 链接参数：`CMakeLists.txt` 加 `APPLE` 分支
- keg-only 的 ffmpeg@7 链接不到：改用 `_LINK_LIBRARIES`
- `-l` 创建 Vulkan 实例失败：直接链接 MoltenVK

详见 02 文档 A 节的"实测"说明。

脚本优先链接 `third_party/ffmpeg-macos`（见 §2.1），没有时用 `ffmpeg@7`。换了 FFmpeg 后再运行，脚本会发现 CMake 缓存里的 FFmpeg 路径不同，自动 `--fresh` 重新配置。

## 8. 运行界面（阶段 2）

```bash
cd ui
npm run build      # 生成 ui/dist（bridge 与 Electron 用它托管界面）
npm run desktop    # 桌面窗口：Electron 内启动 bridge（127.0.0.1:7199）
npm run dev        # 或开发模式：bridge + vite（浏览器打开 http://localhost:3000）
```

- ffmpeg 默认用 `third_party/ffmpeg-macos/bin`，没有时用 `/opt/homebrew/opt/ffmpeg@7/bin`；可用 `VIDEO2X_FFMPEG_DIR` 覆盖，bridge 会把同一路径传给 Python 引擎。界面按这份 ffmpeg 是否带 libplacebo 决定 Anime4K 与 HDR 是否可选。
- 桌面窗口里的"添加视频""选择输出目录"用 macOS 原生对话框；浏览器开发模式下由 bridge 调 osascript 弹出，对话框可能出现在浏览器窗口后面。
- 第一次读写桌面、文稿、下载、网络盘等位置时，系统会弹窗请求授权（隐私与安全性），允许即可。
- 验收脚本（另起一个 7299 端口的 bridge，测完关掉）：
  `BRIDGE_PORT=7299 node server/bridge.mjs &`，然后 `node scripts/macos/accept-bridge.mjs <输出目录>`。
  测试 bridge 与正式程序共用 `cache/jobs.json`，测试期间不要同时开着桌面程序。

## 9. 打包成 .app（阶段 5）

```bash
cd ui
npm run dist:mac
# 国内网络：VIDEO2X_CN=1 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run dist:mac
```

产物：`ui/release/mac-arm64/Video2X Studio.app`，约 14 GB，模型与权重都在包里，双击即可用。

流程：`scripts/macos/package-app.mjs` 与 `ui/scripts/check-dist.mjs` 依次做下面几步。

1. **pre：** 在 `dist-macos/`（已忽略）准备包内文件：
   - C++ 核心与 FFmpeg 命令行，连同 34 个 Homebrew 动态库，收进 `build-macos/lib`，引用改成 `@rpath`，再重新 ad-hoc 签名。
   - MoltenVK 的 ICD 清单。
   - 随包 Python：python-build-standalone 3.12.16，核对官方 SHA-256，按 `engine-python/requirements-macos-lock.txt` 安装。首次约 15 分钟，主要是 pip 下载约 1 GB 依赖；之后复用。
   - App 图标。
   - 第三方许可证与源码清单 `dist-macos/licenses/`，进包后在 `Contents/licenses/`：每个随包库一个子目录放许可证原文，`README.txt` 列出随包文件、版本、许可与同版本的源码地址（Homebrew 库的地址取自 keg 里的配方副本），另附 Electron / Chromium 的许可。GPL 组件分发时要能提供源码，见 COMPLIANCE.md §6。
2. **check-dist pre：** 关键文件齐全，C++ 产物不旧于源码。
3. **electron-builder --mac dir：** 按 `package.json` 的 `mac.extraFiles` 拷进 `.app/Contents`，布局与项目根相同。
   - 只带 Mac 用的权重：SeedVR2 fp16、SwiftVR FP8。
   - 不带 SwiftVR 官方 FP32 和 SeedVR2 FP8，这两个合计 21.8 GB。
4. **post：**
   - 在包内预编译 .pyc（unchecked-hash）。
   - 检查所有 Mach-O 都不引用包外的库。
   - 整体 ad-hoc 签名，并用 `codesign --verify --deep --strict` 校验。
5. **check-dist post：** 关键文件与源文件大小一致，不该带的大文件不在包里。

Python 运行时首次准备好之后，重新打包约 1 分钟。

运行时与开发环境的差异（`ui/server/platform.mjs`）：

- **缓存目录：** 包内按只读对待，任务记录、日志、本地暂存放在 `~/Library/Application Support/Video2X Studio/cache`。开发环境仍是项目根下的 `cache/`。
- **`VK_DRIVER_FILES`：** 子进程都设这个变量，指向包内的 ICD 清单。
  - libplacebo 经 vulkan-loader，ncnn 经自带的简易 loader，都靠它找到包内的 MoltenVK。
  - 不设的话，ncnn 会去 Homebrew 目录找；没装 Homebrew 的机器上会报 `vkCreateInstance failed -9`，然后崩溃。
- **`PYTHONDONTWRITEBYTECODE=1`：** 子进程都设，Python 不往包内写 `__pycache__`。

使用注意：

- **首次运行等待：** 系统的 XProtect 会扫描包内程序，第一个任务要多等约 30 秒，只有第一次。
- **拷到别的 Mac：** 自用 ad-hoc 签名，没有公证。拷过去后先清除隔离属性：`xattr -dr com.apple.quarantine "/Applications/Video2X Studio.app"`。
- **不要与开发版桌面程序同时开：** 两者都用 7199 端口，后开的会直接复用先开的那个服务。
