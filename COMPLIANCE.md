# 合规说明（COMPLIANCE）

> 适用对象：Video2X Studio（Video2X 桌面增强分支）的全部使用者、拷贝接收者与二次分发者。
> 最后更新：2026-10-29。本文档为工程合规指引，不构成法律意见；涉及商业决策时请咨询专业人士。

---

## 1. 一句话结论

- **个人 / 家庭 / 科研使用：开箱即用，无任何限制。**
- **把程序拷贝给他人：可以。** 保持包内许可文件齐全（打包已自动附带，见 §5），并让对方拿得到源码：
  本项目源码公开在 GitHub（§2），随包 FFmpeg 等 GPL 组件的源码地址见 §6。
- **商业用途或商业分发：先删除一个文件 `engine-python/weights/spynet.pth`**（理由与影响见 §4）。其余组件都允许商用；
  GPL 组件（FFmpeg 等）的条件同样只是提供源码，不限制商用。

---

## 2. 主程序许可：GNU AGPL-3.0

本项目是 [k4yt3x/video2x](https://github.com/k4yt3x/video2x) 的修改分支，继承其
**GNU Affero General Public License v3.0**（全文见根目录 `LICENSE`，便携包内为 `LICENSE.txt`）。

AGPL-3.0 赋予你的权利：

| 行为 | 是否允许 | 条件 |
|---|---|---|
| 运行、使用（含商业场景下运行） | ✅ | 无 |
| 原样拷贝分发 | ✅ | 附带许可文本与源码获取说明（§5 清单） |
| 修改后自用 | ✅ | 无 |
| 修改后分发 / 提供网络服务 | ✅ | 衍生作品整体仍按 AGPL-3.0 发布，并向接收者提供**修改版的完整对应源码**（§13） |
| 闭源再分发 | ❌ | AGPL-3.0 不允许 |

**源码提供义务的落实方式**：本分支的全部修改（Studio 桌面程序、Python 引擎、C++ 核心改动）
均提交在 git 仓库中；每次分发的包内附 `SOURCE.txt`，说明源码获取方式。
公开仓库：<https://github.com/hellomyworkid-tech/video2x-studio>（含全部提交历史；README 的 License 节与包内
`SOURCE.txt` 写的是同一地址）。

## 3. 第三方代码组件

完整清单见根目录 `NOTICE`（便携包内 `NOTICE.txt`）；macOS 包另在 `Contents/licenses/` 附带每个随包原生库的
许可证原文、版本与同版本源码地址（`licenses/README.txt`）。按许可类型分类（标"macOS"的只在 Mac 包里）：

- **MIT**：Anime4K、Real-ESRGAN ncnn、Real-CUGAN ncnn、RIFE ncnn、Electron、React、spdlog、
  triton-windows（Triton 的 Windows 版，SageAttention 的即时编译依赖）；macOS：fmt、Little CMS
- **BSD**：ncnn、PyTorch；macOS：libvpx（3-Clause），dav1d、libaom（2-Clause，libaom 另附 AOMedia 专利许可），
  libvmaf（BSD-2-Clause-Patent）
- **Apache 2.0**：MMEditing（RealBasicVSR 实现）、SeedVR2（字节，代码与权重）、
  ComfyUI-SeedVR2_VideoUpscaler（numz 实现）、SwiftVR（代码与权重，底座 Wan2.2）、
  diffusers、decord、SageAttention 2（清华 THU-ML）、Vulkan-Headers；macOS：MoltenVK、Vulkan Loader、
  SPIRV-Tools、shaderc、LLVM OpenMP（附 LLVM 例外）、OpenSSL（随包 Python 静态链接）
- **PSF 2.0**：CPython（随包 Python 运行时；macOS 用 python-build-standalone 的构建）
- **其他宽松许可**：Boost（BSL-1.0）；macOS：zimg（WTFPL）、glslang（BSD / MIT / Apache，其 Bison 生成的
  解析器为带 Bison 例外的 GPL-3.0）
- **LGPL**：libplacebo（2.1+）、TinyCC（2.1，随 triton-windows 附带）、easydict（3.0，Python 包，原样使用）
- **GPL**：两个平台随包的 FFmpeg 构建、imageio-ffmpeg 自带的 FFmpeg 程序；macOS：x264、x265、vid.stab（见 §6）
- **NVIDIA CUDA EULA**：ptxas.exe 与 CUDA 头文件（随 triton-windows 附带，与 PyPI 上
  NVIDIA 官方发布的组件相同，按其 EULA 随应用再分发）

以上许可都允许商用与再分发。宽松许可与 LGPL 只需保留许可文本与声明（`NOTICE.txt`、macOS 的 `licenses/`
与各 Python 包的 `*.dist-info` 都已随包附带）；GPL 组件还要求向接收者提供对应源码（§6）。

## 4. 模型权重许可（重点：唯一的非商业组件）

逐项清单见 `WEIGHTS_LICENSES.md`（便携包内同名文件）。结论：

| 权重 | 许可 | 商用 |
|---|---|---|
| Real-ESRGAN / Real-CUGAN / RIFE / SPAN（ncnn） | MIT | ✅ |
| RealBasicVSR x4 | Apache 2.0 | ✅ |
| SeedVR2-3B（字节官方） | Apache 2.0 | ✅ |
| SwiftVR（随包为 FP8 修改版，NOTICE 已注明修改） | Apache 2.0 | ✅ |
| **SPyNet 光流权重（spynet.pth）** | **Max Planck 非商业/科研许可** | ❌（商用须联系 ps-license@tue.mpg.de 取得授权） |

**商用合规构建的操作方法**（已经实机验证）：

1. 删除 `engine-python/weights/spynet.pth`；
2. 完成。程序检测到文件缺失会自动改用 RealBasicVSR 主权重内嵌的同一组 SPyNet 参数
   （实测覆盖 62/62 个所需键，与独立文件加载的是同一份权重），
   **输出效果完全一致，无画质损失**；
3. 启动日志会打印 `使用主权重内嵌键（62/62）` 作为合规构建的确认凭据。

> 注意：早期"SeedVR2-3B 为非商业许可"的顾虑经复核**不成立**——字节跳动官方仓库明确
> SeedVR/SeedVR2 的代码与 3B/7B 权重均为 Apache 2.0。

## 5. 再分发清单（拷贝给他人时核对）

每次分发（压缩包、U 盘、网盘均可），确保包内包含以下文件：

- [ ] `LICENSE.txt`（AGPL-3.0 全文）
- [ ] `NOTICE.txt`（第三方组件声明）
- [ ] `SOURCE.txt`（源码获取说明，中英双语）
- [ ] `WEIGHTS_LICENSES.md`（权重许可清单）

macOS 包（`Video2X Studio.app`）里这四项在 `Contents/` 下，同目录还有：

- [ ] `licenses/`（随包第三方原生库与 Electron / Chromium 的许可证原文和源码清单，打包时自动生成）

以上各项已接入 `ui/package.json` 的 electron-builder `extraFiles`（Windows 在 `build.win`，macOS 在 `build.mac`），
**任何由打包流程产出的发布包都会自动附带**，无需手工操作；`npm run dist` / `dist:mac` 收尾的检查会确认它们在包里。
手工拼装目录时请从仓库根目录复制同名文件（`LICENSE`/`NOTICE` 复制后加 `.txt` 后缀）。

## 6. FFmpeg 与其他 GPL / LGPL 组件

FFmpeg 本身是 LGPL，但**两个平台随包的 FFmpeg 都是 GPL 构建**：启用了 x264、x265、vid.stab 等 GPL 组件后，
构建整体按 GPL 发布。（2026-10-29 之前本文写作"LGPL-2.1"，不准确，已更正。）

| 平台 | 随包 FFmpeg | 许可 |
|---|---|---|
| Windows | gyan.dev 7.1 "full" 共享库构建（`third_party/ffmpeg-shared`） | GPL v3 |
| macOS | 官方 7.1.5 源码自编（`scripts/macos/build-ffmpeg.sh`，`--enable-gpl`），另带 Homebrew 编译的 x264、x265、vid.stab | GPL v2 或更新版本 |

- **与 AGPL-3.0 兼容**：GPL v3 与 AGPL v3 各自的第 13 条明确允许两者组合；"GPL v2 或更新版本"可按 v3 使用。
- **本项目未修改 FFmpeg 及这些库的源码**，以动态库 / 独立程序的形式使用。
- **分发二进制时的义务**：让接收者拿得到这些 GPL 组件的对应源码（GPL v2 第 3 条、GPL v3 第 6 条）。
  - macOS：`Contents/licenses/README.txt` 列出每个随包库的版本与**同一版本**的源码地址；FFmpeg 的源码包地址、
    SHA-256 与全部编译参数在 `scripts/macos/build-ffmpeg.sh`。
  - Windows：FFmpeg 源码见官方仓库的 7.1 标签；gyan.dev 构建所含外部库的清单与版本由 gyan.dev 随构建公布。
  - 稳妥做法：把对应版本的源码包与发布包一起存档，有人索取时直接提供。
- **LGPL 组件**：libplacebo（LGPL-2.1+）以动态库使用，未修改，可整体替换；
  TinyCC（`engine-python/python/Lib/site-packages/triton/runtime/tcc`）以独立可执行文件 / DLL 形式
  随 triton-windows 原样附带，源码见 https://repo.or.cz/tinycc.git；easydict（LGPL-3.0）是纯 Python 包，原样使用。
- **imageio-ffmpeg**（SwiftVR 的依赖）的 wheel 自带一个预编译 FFmpeg 程序（macOS arm64 版为 GPL 构建），
  来源与源码说明见 https://github.com/imageio/imageio-ffmpeg 。
- 以上声明均已包含在 `NOTICE.txt` 中（macOS 包另见 `licenses/README.txt`）。

## 7. 商标与命名

"Video2X" 名称与标识归属上游作者 K4YT3X。本分支为衍生版本，以
**"Video2X Studio"** 标识以作区分；分发时不得暗示与上游官方存在隶属或背书关系。

## 8. 隐私与网络行为

- 本软件**不包含任何遥测、统计或数据上报**；
- 唯一的网络请求是用户触发或模型/组件缺失时的**下载请求**（官方源或备用镜像），
  不传输任何用户文件或个人信息；
- 全部处理在本地完成，视频文件不会离开你的机器。

## 9. 免责

本软件按"现状"提供，不附带任何明示或默示担保（详见 AGPL-3.0 第 15、16 条）。
本文档是工程层面的合规梳理，**不构成法律意见**。

---

## English Summary

Video2X Studio is a modified branch of Video2X, licensed under **GNU AGPL-3.0**
(see `LICENSE`); its complete source, with history, is public at
<https://github.com/hellomyworkid-tech/video2x-studio>. All bundled code and model
weights may be used commercially and redistributed **except one**: the SPyNet
optical-flow weights (`engine-python/weights/spynet.pth`), which are
**non-commercial / research-only** (Max Planck Institute; contact
ps-license@tue.mpg.de for commercial licensing).

- Personal / research use: no restrictions.
- Redistribution: keep `LICENSE.txt`, `NOTICE.txt`, `SOURCE.txt` and
  `WEIGHTS_LICENSES.md` (plus the `licenses/` folder in the macOS app) inside the
  package (the build attaches them automatically).
- The bundled FFmpeg builds are GPL, not LGPL (Windows: gyan.dev 7.1 "full",
  GPLv3; macOS: FFmpeg 7.1.5 with `--enable-gpl` plus x264 / x265 / vid.stab,
  GPLv2 or later). When redistributing binaries, make their corresponding source
  available; the macOS app's `licenses/README.txt` lists version-matched source URLs.
- Commercial use or distribution: delete `spynet.pth`. The program then loads the
  identical SPyNet parameters embedded in the RealBasicVSR checkpoint
  (verified 62/62 keys, byte-identical behavior, zero quality loss).

Per AGPL-3.0 §13, the complete corresponding source of this modified version is
available at the repository above and from the distributor.
This document is an engineering summary, not legal advice.
