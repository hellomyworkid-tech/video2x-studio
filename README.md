<p align="center">
   <img src="https://github.com/user-attachments/assets/5cd63373-e806-474f-94ec-6e04963bf90f"
        alt="Video2X: A machine learning-based video super resolution and frame interpolation framework."/>
   </br>
   <img src="https://img.shields.io/github/v/release/k4yt3x/video2x?style=flat-square"/>
   <img src="https://img.shields.io/github/downloads/k4yt3x/video2x/total?style=flat-square"/>
   <img src="https://img.shields.io/github/license/k4yt3x/video2x?style=flat-square"/>
   <img src="https://img.shields.io/github/sponsors/k4yt3x?style=flat-square&link=https%3A%2F%2Fgithub.com%2Fsponsors%2Fk4yt3x"/>
   <img src="https://img.shields.io/badge/dynamic/json?color=%23e85b46&label=Patreon&query=data.attributes.patron_count&suffix=%20patrons&url=https%3A%2F%2Fwww.patreon.com%2Fapi%2Fcampaigns%2F4507807&style=flat-square"/>
</p>

---

# Video2X Studio

> 本仓库是开源项目 [Video2X](https://github.com/k4yt3x/video2x) 的**非官方修改分支**，与上游作者 K4YT3X
> 没有隶属或背书关系；页首徽章与下文的安装包、文档、社区链接都指向上游原版。
> *An unofficial modified branch of Video2X, not affiliated with or endorsed by its author.
> The badges above and the install, docs and community links below refer to upstream Video2X.*

**一台装在自己电脑上的视频修复工作室。**

低清的、抖的、满是噪点的老片子，批量丢进去——出来就是高清的、稳的、干净的版本。
全程本地运行，免费开源，不设上限。

## 为什么是 Video2X Studio

**① 旗舰级画质引擎，专治"没救"的片源**

内置 **SwiftVR**——单步流式生成式视频修复，2K 输出稳态实测约 7 fps（RTX 5070 Ti），
比同类扩散模型快一个数量级、帧间稳定；字节跳动开源的 **SeedVR2-3B** 扩散模型引擎——
重度压缩、低码率、实拍老片的最强修复力；以及 **RealBasicVSR**——双向循环传播，时序稳定无闪烁。
经典档覆盖全场景：Real-ESRGAN / Real-CUGAN（实拍与动漫）、SPAN、Anime4K、
Lanczos 纯缩放，外加 RIFE 补帧，最高把 24 帧老片顺成丝滑高帧率。

**② 挂上队列就不用管**

批量拖入整个文件夹，剩下的交给它：断电、崩溃、手滑关了窗口都不怕——
分片检查点让任务从中断处继续，不浪费一秒已完成的算力。
跑之前还能随时暂停。模型文件缺失？自动下载，内置国内镜像，不用折腾网络。
NAS 网络盘里的片源直接处理，自动封装预处理。

**③ 解压即用，不用当运维**

Windows 便携包解压即跑：Python、CUDA 运行时、FFmpeg、模型全部内置，
不污染系统，不折腾环境。macOS（Apple Silicon）版打包成双击即用的 .app，同样自带 Python、FFmpeg 与模型。
界面就是拖进去、选档位、点开始三件事。

## 它能帮你做什么

- **老 DV / DVD / 演唱会录像** → 4K 修复，噪点、块效应一并抹掉
- **手持拍摄晃得厉害** → vidstab 双通道防抖，先分析再校正
- **SDR 老片** → 一键转 HDR，暗部与高光重新活过来
- **动漫老番** → Real-CUGAN 高清放大 + RIFE 补帧
- **网课、会议、录屏** → 模糊文字重新变得可读

## 引擎档位速查

| 档位 | 引擎 | 放大 | 适合片源 | 硬件建议 |
|---|---|---|---|---|
| 旗舰 | SwiftVR（Apache 2.0，Wan2.2-5B 底座） | 目标分辨率（默认短边 ×2，≤1440） | 退化源的生成式修复，2K 约 7 fps | 16GB 级显存 |
| 旗舰 | SeedVR2-3B（字节跳动，Apache 2.0） | 目标分辨率 | 重度压缩 / 低码率 / 老片实拍 | 大显存显卡 |
| 重建 | RealBasicVSR（Apache 2.0） | 4× | 实拍老片，稳定无闪烁 | 主流显卡 |
| 经典 | Real-ESRGAN / Real-CUGAN / SPAN | 2×/3×/4× | 实拍与动漫全场景 | 入门显卡即可 |
| 无模型 | Lanczos 纯缩放 | 2×/3×/4× 或指定分辨率 | 高码率清晰源；零伪影 | 无需显卡 |
| 补帧 | RIFE（14 个版本可选） | — | 任意，提升到高帧率 | 入门显卡即可 |

降噪、防抖、SDR→HDR 可与任意超分引擎自由串联成流水线（FilterChain）。

**开源（AGPL-3.0）、免费、许可透明**：全部组件与权重许可逐项可查
（[COMPLIANCE.md](COMPLIANCE.md)），个人与科研使用零门槛。

---

## 🌟 Version 6.0.0

Video2X 6.0.0 highlights:

- Complete rewrite of the Video2X project in C/C++.
- Faster and more efficient architecture.
- Cross-platform support for Windows and Linux.
- Vastly improved output quality.
- New GUI and installer for easy setup on Windows.

<details>
<summary>Click to see more details</summary>

Version 6.0.0 is a complete rewrite of this project in C/C++. It:

- genuinely works this time, with much less hassle compared to the 5.0.0 beta;
- is blazing fast, thanks to the new optimized pipeline and the efficiency of C/C++;
- is cross-platform, available now for both Windows and Linux;
- offers significantly better output quality with Anime4K v4, Real-ESRGAN, Real-CUGAN, and RIFE;
- supports two modes: filtering (upscaling) and frame interpolation;
- supports Anime4K v4 and all custom MPV-compatible GLSL shaders;
- supports Real-ESRGAN, Real-CUGAN, and RIFE (all models) via ncnn and Vulkan;
- requires zero additional disk space during processing, just space for the final output.

</details>

![6.4.0-screenshot](https://github.com/user-attachments/assets/9b1cc8a7-2903-4d2c-80a2-8d81f007e45b)

## 🚀 This Branch / 本分支新增功能

This branch extends upstream Video2X 6.x with the following major additions
(本分支在上游 6.x 基础上新增以下主要功能):

### 🖥️ Video2X Studio desktop application（`ui/`）

A full Windows desktop app (Electron + React) that wraps the C++ core and the
Python engines: batch queue processing, per-job pause / resume-at-checkpoint /
resume-after-crash (sharded checkpoints for the flagship engines), open-output-folder
shortcuts, network-share (NAS) source pre-processing with lossless-remux-then-transcode
fallback, automatic download of missing models/binaries (with China mirror fallback),
persistent per-user last configuration, and per-GPU CUDA device selection.

### 🧠 Two Python VSR engines（`engine-python/`）

| Tier 档位 | Engine | Scale | Notes |
|---|---|---|---|
| Flagship 旗舰 | **SwiftVR** (H-oliday, Apache 2.0; Wan2.2-5B base) | target-resolution | One-step streaming generative restoration; ~7 fps at 2560×1440 on an RTX 5070 Ti (FP8 weights, FP8 tensor-core matmuls on RTX 40/50; 16 GB VRAM) |
| Flagship 旗舰 | **SeedVR2-3B** (ByteDance-Seed, Apache 2.0) | target-resolution | Diffusion VSR; strongest on heavily-compressed/low-quality sources |
| Mid 中坚 | **RealBasicVSR** (OpenMMLab, Apache 2.0) | 4× | Recurrent VSR, temporally stable, flicker-free |

Both support pause (process freeze), stop-at-checkpoint, and resume
(`engine-python/worker.py`, `seedvr2_runner.py`).

### ⛓️ FilterChain & new CLI flags（C++ core）

- **`--denoise`** — FFmpeg-based denoising stage in the new FilterChain (`src/filter_chain.cpp`, `src/filter_ffmpeg_graph.cpp`)
- **`--stab`** — video stabilization prepass via vidstabdetect/vidstabtransform (`src/stab_prepass.cpp`), runs as a two-pass analyze → transform pipeline
- **`--hdr`** — SDR→HDR tone mapping (`src/filter_hdr.cpp`, libplacebo-based `src/filter_libplacebo.cpp`)
- **SPAN** super-resolution model support via ncnn/Vulkan (`src/filter_span.cpp`, `models/span/`)
- Decoder flush fix and FilterChain composability: denoise/stab/HDR chain freely with any upscaler

### 🍎 macOS（Apple Silicon）

全部处理器、增强滤镜与批量队列都已移植到 macOS（M 系列芯片，macOS 14+）；CUDA 专属的加速
（SageAttention、FP8 计算）在 Mac 上不可用。

- ncnn 引擎（Real-ESRGAN / Real-CUGAN / RIFE 等）经 MoltenVK 跑在 Apple GPU 上；SwiftVR、SeedVR2、RealBasicVSR
  用 PyTorch MPS；编码可选 VideoToolbox 硬件编码。
- Anime4K 与 SDR→HDR 需要带 libplacebo 的 FFmpeg：`scripts/macos/build-ffmpeg.sh` 从官方源码编译 FFmpeg 7.1.5。
- 搭环境、编译、打包见 [docs/macos/03-setup.md](docs/macos/03-setup.md)；`cd ui && npm run dist:mac`
  产出双击可用的 `Video2X Studio.app`（ad-hoc 签名，未经 Apple 公证）。
- 验收以 Windows 版的参考输出为基准逐帧比 PSNR，方法与结果见 [docs/macos/05-acceptance.md](docs/macos/05-acceptance.md)；
  速度与画质实测见 `docs/reports/macOS-*`。

## 🖥️ Hardware Requirements

Your system must meet the minimum hardware requirements below to run Video2X.

- **CPU**
  - The precompiled binaries require CPUs with AVX2 support.
  - **Intel**: Haswell (Q2 2013) or newer
  - **AMD**: Excavator (Q2 2015) or newer
- **GPU**
  - The GPU must support Vulkan.
  - **NVIDIA**: Kepler (GTX 600 series, Q2 2012) or newer
  - **AMD**: GCN 1.0 (Radeon HD 7000 series, Q1 2012) or newer
  - **Intel**: HD Graphics 4000 (Q2 2012) or newer

## [🪟 Install on Windows](https://docs.video2x.org/installing/windows-qt6.html)

**[Download the Latest Windows Installer Executable (6.4.0)](https://github.com/k4yt3x/video2x/releases/download/6.4.0/video2x-qt6-windows-amd64-installer.exe)**

You can download the latest Windows release on the [releases page](https://github.com/k4yt3x/video2x/releases/latest). For basic GUI usage, refer to the [documentation](https://docs.video2x.org/running/desktop.html). If you're unable to download directly from GitHub, try the [mirror site](https://files.k4yt3x.com). The GUI currently supports the following languages:

- English (United States)
- 简体中文（中国）
- 日本語（日本）
- Português (Portugal)
- Français (France)
- Deutsch (Deutschland)

## [🐧 Install on Linux](https://docs.video2x.org/installing/linux.html)

Video2X packages are available for the Linux distros listed below. A universal AppImage is also available for other distros. If you'd like to build it from source code, refer to the [PKGBUILD](packaging/arch/PKGBUILD) file for a general overview of the required dependencies and commands.

- Arch Linux: AUR packages, maintained by [@K4YT3X](https://github.com/k4yt3x).
  - [aur/video2x](https://aur.archlinux.org/packages/video2x)
  - [aur/video2x-git](https://aur.archlinux.org/packages/video2x-git)
  - [aur/video2x-qt6](https://aur.archlinux.org/packages/video2x-qt6)
  - [aur/video2x-qt6-git](https://aur.archlinux.org/packages/video2x-qt6-git)
- Arch Linux (Chinese Mainland): archlinuxcn packages, maintained by [@Integral-Tech](https://github.com/Integral-Tech).
  - [archlinuxcn/video2x](https://github.com/archlinuxcn/repo/tree/master/archlinuxcn/video2x)
  - [archlinuxcn/video2x-git](https://github.com/archlinuxcn/repo/tree/master/archlinuxcn/video2x-git)
  - [archlinuxcn/video2x-qt6](https://github.com/archlinuxcn/repo/tree/master/archlinuxcn/video2x-qt6)
  - [archlinuxcn/video2x-qt6-git](https://github.com/archlinuxcn/repo/tree/master/archlinuxcn/video2x-qt6-git)
- Other distros: `Video2X-x86_64.AppImage` on the [releases page](https://github.com/k4yt3x/video2x/releases/latest).

## [📦 Container Image](https://docs.video2x.org/running/container.html)

Video2X [container images](https://github.com/k4yt3x/video2x/pkgs/container/video2x) are available on the GitHub Container Registry for easy deployment on Linux and macOS. If you already have Docker/Podman installed, only one command is needed to start upscaling a video. For more information on how to use Video2X's Docker image, please refer to the [documentation](https://docs.video2x.org/running/container.html).

## [📔 Google Colab](https://colab.research.google.com/drive/1gWEwcA9y57EsxwOjmLNmNMXPsafw0kGo)

You can use Video2X on [Google Colab](https://colab.research.google.com/) **for free** if you don't have a powerful GPU of your own. You can borrow a powerful GPU (NVIDIA T4, L4, or A100) on Google's server for free for a maximum of 12 hours per session. **Please use the free resource fairly** and do not create sessions back-to-back and run upscaling 24/7. This might result in you getting banned. You can get [Colab Pro/Pro+](https://colab.research.google.com/signup/pricing) if you'd like to use better GPUs and get longer runtimes. Usage instructions are embedded in the [Colab Notebook](https://colab.research.google.com/drive/1gWEwcA9y57EsxwOjmLNmNMXPsafw0kGo).

## [💬 Telegram Discussion Group](https://t.me/video2x)

Join our Telegram discussion group to ask any questions you have about Video2X, chat directly with the developers, or discuss super resolution, frame interpolation technologies, or the future of Video2X in general.

## [📖 Documentation](https://docs.video2x.org/)

Comprehensive documentation for Video2X is available at [https://docs.video2x.org/](https://docs.video2x.org/). It offers detailed instructions on how to [build](https://docs.video2x.org/building/index.html), [install](https://docs.video2x.org/installing/index.html), [use](https://docs.video2x.org/running/index.html), and [develop](https://docs.video2x.org/developing/index.html) with this program.

## 📽️ Video Demos (Outdated)

![Spirited Away Demo](https://user-images.githubusercontent.com/21986859/49412428-65083280-f73a-11e8-8237-bb34158a545e.png)\
_Upscale demo: Spirited Away's movie trailer_

- **Spirited Away**: [YouTube](https://youtu.be/mGEfasQl2Zo) | [Bilibili](https://www.bilibili.com/video/BV1V5411471i/)
  - 360P to 4K
  - The [original video](https://www.youtube.com/watch?v=ByXuk9QqQkk)'s copyright belongs to 株式会社スタジオジブリ
- **Bad Apple!!**: [YouTube](https://youtu.be/A81rW_FI3cw) | [Bilibili](https://www.bilibili.com/video/BV16K411K7ue)
  - 384P 30 FPS to 4K 120 FPS with waifu2x and DAIN
  - The [original video](https://www.nicovideo.jp/watch/sm8628149)'s copyright belongs to あにら
- **The Pet Girl of Sakurasou**: [YouTube](https://youtu.be/M0vDI1HH2_Y) | [Bilibili](https://www.bilibili.com/video/BV14k4y167KP/)
  - 240P 29.97 to 1080P 60 FPS with waifu2x and DAIN
  - The original video's copyright belongs to ASCII Media Works

### Standard Test Clip

The following clip can be used to test if your setup works properly. This is also the standard clip used for running performance benchmarks.

- [Standard Test Clip (240P)](https://files.k4yt3x.com/resources/videos/standard-test.mp4) 4.54 MiB
- [Real-CUGAN Upscaled Sample (1704P)](https://files.k4yt3x.com/resources/videos/standard-realcugan.mp4) 3.5 MiB
- [Real-ESRGAN Upscaled Sample (1704P)](https://files.k4yt3x.com/resources/videos/standard-realesrgan.mp4) 3.1 MiB
- [waifu2x Upscaled Sample (1080P)](https://files.k4yt3x.com/resources/videos/standard-waifu2x.mp4) 4.54 MiB
- [Ground Truth (1080P)](https://files.k4yt3x.com/resources/videos/standard-original.mp4) 22.2 MiB

The original clip came from the anime "さくら荘のペットな彼女."\
Copyright of this clip belongs to 株式会社アニプレックス.

## ⚖️ License

This project is licensed under [GNU AGPL version 3](https://www.gnu.org/licenses/agpl-3.0.txt).\
Copyright (C) 2018-2025 K4YT3X and [contributors](https://github.com/k4yt3x/video2x/graphs/contributors).

![AGPLv3](https://www.gnu.org/graphics/agplv3-155x51.png)

### Source Code Availability / 源码获取

This repository is a **modified branch** of Video2X: it adds the Video2X Studio
desktop application (`ui/`), three Python VSR engines (`engine-python/`), a
macOS port, and changes to the C++ core (FilterChain, HDR, VidStab, SPAN, …).
In compliance with AGPL-3.0 §13, the complete corresponding source of this
modified version, with full history, is this public repository:
<https://github.com/hellomyworkid-tech/video2x-studio>. The upstream, unmodified
project (without this branch's additions) lives at <https://github.com/k4yt3x/video2x>.

本仓库是 Video2X 的**修改分支**，新增 Studio 桌面程序、Python 超分引擎、macOS 移植与 C++ 核心改动。
依 AGPL-3.0 §13，这些修改的完整对应源码（含提交历史）就是本公开仓库；发布包内附带的 `SOURCE.txt`
写的是同一地址。上游原版（不含本分支新增内容）见上述链接。

This project includes or depends on these following projects:

| Project                                                                               | License         |
| ------------------------------------------------------------------------------------- | --------------- |
| [FFmpeg/FFmpeg](https://www.ffmpeg.org/)                                              | LGPLv2.1, GPLv2（本分支随包的构建为 GPL，见 COMPLIANCE.md §6） |
| [Tencent/ncnn](https://github.com/Tencent/ncnn)                                       | BSD 3-Clause    |
| [bloc97/Anime4K](https://github.com/bloc97/Anime4K)                                   | MIT License     |
| [nihui/realcugan-ncnn-vulkan](https://github.com/nihui/realcugan-ncnn-vulkan)         | MIT License     |
| [nihui/rife-ncnn-vulkan](https://github.com/nihui/rife-ncnn-vulkan)                   | MIT License     |
| [xinntao/Real-ESRGAN-ncnn-vulkan](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan) | MIT License     |
| [pytorch/pytorch](https://github.com/pytorch/pytorch)                                 | BSD 3-Clause    |
| [electron/electron](https://github.com/electron/electron)                             | MIT License     |
| [open-mmlab/mmagic (MMEditing)](https://github.com/open-mmlab/mmagic)                 | Apache 2.0      |
| [ByteDance-Seed/SeedVR (SeedVR2)](https://github.com/ByteDance-Seed/SeedVR)           | Apache 2.0      |
| [numz/ComfyUI-SeedVR2_VideoUpscaler](https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler) | Apache 2.0 |
| [H-oliday/SwiftVR](https://github.com/H-oliday/SwiftVR)（底座 [Wan2.2](https://github.com/Wan-Video/Wan2.2)） | Apache 2.0 |
| [huggingface/diffusers](https://github.com/huggingface/diffusers)、[dmlc/decord](https://github.com/dmlc/decord) | Apache 2.0 |
| [haasn/libplacebo](https://code.videolan.org/videolan/libplacebo)                     | LGPLv2.1+       |
| [KhronosGroup/MoltenVK](https://github.com/KhronosGroup/MoltenVK)、[Vulkan-Loader](https://github.com/KhronosGroup/Vulkan-Loader)（macOS 随包） | Apache 2.0 |
| [x264](https://code.videolan.org/videolan/x264)、[x265](https://github.com/Multicorewareinc/x265)、[vid.stab](https://github.com/georgmartius/vid.stab)（macOS 随包） | GPLv2+ |
| [astral-sh/python-build-standalone](https://github.com/astral-sh/python-build-standalone)（macOS 随包 CPython） | PSF 2.0 等 |
| [anuragranj/spynet](https://github.com/anuragranj/spynet)（仅权重，经 OpenMMLab 分发） | 非商业/科研用途 |

More licensing information can be found in the [NOTICE](NOTICE) file.
Model-weight-specific terms are listed in [WEIGHTS_LICENSES.md](WEIGHTS_LICENSES.md).
A full redistribution & commercial-use compliance guide is in [COMPLIANCE.md](COMPLIANCE.md).

## 🌺 Special Thanks

Special thanks to the following individuals for their significant contributions to the project, listed in alphabetical order.

- [@ArchieMeng](https://github.com/archiemeng)
- [@BrianPetkovsek](https://github.com/BrianPetkovsek)
- [@Integral-Tech](https://github.com/Integral-Tech)
- [@ddouglas87](https://github.com/ddouglas87)
- [@lhanjian](https://github.com/lhanjian)
- [@nihui](https://github.com/nihui)
- [@sat3ll](https://github.com/sat3ll)
