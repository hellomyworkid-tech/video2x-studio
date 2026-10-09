# macOS 开发环境搭建

> 目标机器：Apple Silicon、macOS 14 及以上（MPS 的 bf16 需要 14+）。以下命令在 Windows 上整理，
> **未在 Mac 上实测**，第一次照做时有出入就修正本文并提交。
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

- `ffmpeg@7`（7.1.x）是 keg-only，不会进 PATH。构建与运行时要显式指过去：
  - 构建：`PKG_CONFIG_PATH="$(brew --prefix ffmpeg@7)/lib/pkgconfig"`
  - 运行：`VIDEO2X_FFMPEG_DIR="$(brew --prefix ffmpeg@7)/bin"`（bridge / worker 移植后读取这个变量）
- 不要装普通的 `ffmpeg` 去替代：9.0 版没有 libvidstab，防抖不可用。
- Anime4K / HDR 需要带 Vulkan + libplacebo 的 FFmpeg，放到阶段 4 处理（见 01 文档 D1）。
- `vulkan-tools` 提供 `vulkaninfo`，用来确认 MoltenVK 能看到 GPU：`vulkaninfo --summary`。

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
