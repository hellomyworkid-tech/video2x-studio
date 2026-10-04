# 合规说明（COMPLIANCE）

> 适用对象：Video2X Studio（Video2X 桌面增强分支）的全部使用者、拷贝接收者与二次分发者。
> 最后更新：2026-07-30。本文档为工程合规指引，不构成法律意见；涉及商业决策时请咨询专业人士。

---

## 1. 一句话结论

- **个人 / 家庭 / 科研使用：开箱即用，无任何限制。**
- **把程序拷贝给他人：可以，保持包内 4 个许可文件齐全即可**（打包已自动附带，见 §5）。
- **商业用途或商业分发：先删除一个文件 `engine-python/weights/spynet.pth`**（理由与影响见 §4），其余组件均为宽松许可，可商用。

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
公开发布地址（推送后生效）：见 README 的 License 节。

## 3. 第三方代码组件

完整清单见根目录 `NOTICE`（便携包内 `NOTICE.txt`）。按许可宽松度分类：

- **MIT**：Anime4K、Real-ESRGAN ncnn、Real-CUGAN ncnn、RIFE ncnn、Electron、React、spdlog
- **BSD 3-Clause**：ncnn、PyTorch
- **Apache 2.0**：MMEditing（RealBasicVSR 实现）、SeedVR2（字节，代码与权重）、
  ComfyUI-SeedVR2_VideoUpscaler（numz 实现）、SwiftVR（代码与权重，底座 Wan2.2）、
  diffusers、decord、Vulkan-Headers
- **Boost Software License 1.0**：Boost
- **LGPL-2.1**：FFmpeg、libplacebo（见 §6 专项说明）

以上均为宽松或弱 copyleft 许可，允许商用与再分发，仅需保留许可文本与声明
（`NOTICE.txt` 已汇总，随包附带即满足）。

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

以上四项已接入 `ui/package.json` 的 electron-builder `extraFiles`，
**任何由打包流程产出的发布包都会自动附带**，无需手工操作。
手工拼装目录时请从仓库根目录复制同名文件（`LICENSE`/`NOTICE` 复制后加 `.txt` 后缀）。

## 6. FFmpeg / libplacebo（LGPL-2.1）专项

- 本项目以**动态链接**方式使用 FFmpeg（DLL 独立存在，未静态合并），符合 LGPL-2.1
  对"使用库作品"的要求；
- FFmpeg 源码可从 https://github.com/FFmpeg/FFmpeg 获取，本项目未修改 FFmpeg 源码；
- libplacebo 同样以动态链接使用，未修改其源码；
- 两者的声明已包含在 `NOTICE.txt` 中。

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
(see `LICENSE`). All bundled code and model weights use permissive licenses
(MIT / BSD / Apache-2.0 / BSL-1.0 / LGPL-2.1 via dynamic linking) **except one**:
the SPyNet optical-flow weights (`engine-python/weights/spynet.pth`), which are
**non-commercial / research-only** (Max Planck Institute; contact
ps-license@tue.mpg.de for commercial licensing).

- Personal / research use: no restrictions.
- Redistribution: keep `LICENSE.txt`, `NOTICE.txt`, `SOURCE.txt` and
  `WEIGHTS_LICENSES.md` inside the package (the build attaches them automatically).
- Commercial use or distribution: delete `spynet.pth`. The program then loads the
  identical SPyNet parameters embedded in the RealBasicVSR checkpoint
  (verified 62/62 keys, byte-identical behavior, zero quality loss).

Per AGPL-3.0 §13, the complete corresponding source of this modified version is
available from the distributor and via the repository URL stated in `SOURCE.txt`.
This document is an engineering summary, not legal advice.
