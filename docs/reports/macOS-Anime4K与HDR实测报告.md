# macOS（Apple Silicon）Anime4K 与 SDR 转 HDR 实测报告

> 日期：2026-10-29
> 硬件：Mac Studio，Apple M5 Max（32 核 GPU）/ 36 GB 统一内存 / macOS 27.0.1
> 软件：自编 FFmpeg 7.1.5（`scripts/macos/build-ffmpeg.sh`）、libplacebo 7.387（Homebrew）、MoltenVK 1.4.2
> 对照：Windows 11 + RTX 5070 Ti，同为 FFmpeg 7.1（参考输出的封装器标记是 Lavf61.7）

## 结论

- **Anime4K 达标。** 与 Windows 参考输出比，平均 47.54 dB，最低帧 46.48 dB（阈值 42 / 38）。连续 15 次运行没有坏帧。
- **SDR 转 HDR 可用。** PQ 与 HLG 都能出片：10bit HEVC（Main 10）、BT.2020、正确的传输特性，带 mastering display 与 CLL 元数据。libx265 与苹果硬编（hevc_videotoolbox）都能用。
- **需要自编 FFmpeg。** Homebrew 的 ffmpeg@7 没有 libplacebo；普通 ffmpeg（9.x）没有 vidstab，且与 Windows 不是同一代 API。
- **顺带修了三个问题：** 一个只在 Mac 上出现（Anime4K 随机花屏），两个跨平台（HLG 用不了、HDR 不能配硬件编码器）。

## 速度

| 任务（A20 片段：1280×720，480 帧；hevc_videotoolbox 编码） | 墙钟（含启动） | 速度 |
|---|---|---|
| Anime4K → 2560×1440 | 5.2 s | 92 fps |
| Anime4K → 1920×1080 | 5.1 s | 94 fps |
| Lanczos ×2 + HDR PQ | 3.1 s | 153 fps |
| Lanczos ×2，不加 HDR（对照） | 1.9 s | 257 fps |

- 输出 1080p 与 1440p 几乎一样快，说明瓶颈不在着色器，而在解码、显存上传下载与编码。
- 编码器换成 libx264（CRF 18）时，Anime4K 1440p 约 80 fps（日志只有整秒精度）。
- 没有与 Windows 比速度。Windows 参考只有 B 片段（72 帧，日志记 1 s），时长太短，启动开销占了大头。

## 问题一：Anime4K 随机花屏（只在 Mac 上出现）

**现象：** 每次运行，72 帧里随机有 2～5 帧出现阶梯状斜带，这些帧对参考的 PSNR 低于 38 dB。坏帧位置每次不同。直接用 FFmpeg 命令行（`-init_hw_device vulkan -filter_hw_device`）也能复现。

**定位（每种配置跑 3～4 次，B 片段 72 帧）：**

| 配置 | 坏帧数（每次） |
|---|---|
| video2x 原做法：FFmpeg 建 Vulkan 设备，交给 libplacebo | 5、4、3 |
| FFmpeg 命令行，同样导入 FFmpeg 的设备 | 0、3、2 |
| 同上，再开 MoltenVK 单队列模式（`MVK_CONFIG_VK_SEMAPHORE_SUPPORT_STYLE=0`） | 23、10、71、13，两次报 `VK_ERROR_DEVICE_LOST` |
| FFmpeg 命令行，不传设备，由 libplacebo 自建 | 0、0、0、0，结果逐位相同 |

**原因：** FFmpeg 的 `hwcontext_vulkan` 会把图形、计算、传输分到不同的队列族。MoltenVK 报告 4 个能力相同的队列族，于是三类工作用了三个不同的队列。libplacebo 导入这个设备后，要在队列之间同步，而这种同步在 Metal 上不可靠。libplacebo 自建设备时不这样分。

**修复：** macOS 上，`init_libplacebo` 与 HDR 滤镜都不再创建 FFmpeg 的 Vulkan 设备，由 libplacebo 自建。Apple Silicon 只有一块 GPU，不涉及选卡。改动在 `#ifdef __APPLE__` 里，Windows 不受影响。

**修复后：** 连续 15 次运行都没有坏帧。其中 14 次逐位相同；另 1 次每帧都有 47～49 dB 的细微差异（与其余各次比），是整体的数值差，不是局部损坏，对参考的最低帧仍为 46.54 dB。

**全部 7 个着色器：** a、a+a、b、b+b、c、c+a、v4.1-gan 各跑 3 次，都正常退出。其中 5 个三次逐位相同；c 与 gan 的第 1 次与后两次每帧都有 46～47 dB 的细微差异，后两次相同。这与上面 a 的第 5 次是同一类整体数值差，不是斜带那种局部损坏，原因未定位（推测与 Metal 着色器编译有关）。

**顺带：** 运行时不再需要设置 `DYLD_FALLBACK_LIBRARY_PATH`。原因是 FFmpeg 的 Vulkan 设备按文件名 dlopen `libvulkan.dylib`，而 `/opt/homebrew/lib` 不在 dyld 的默认搜索路径里。

## 问题二：HLG 一直不能用（跨平台）

选 `--hdr-format hlg` 时，HDR 滤镜给 libplacebo 传 `color_trc=hlg`。FFmpeg 7.1 只认标准名 `arib-std-b67`，报 "Unable to parse option value" 后任务直接失败。Windows 参考集里没有 HLG 用例，所以一直没被发现。

已改成 `arib-std-b67`，FFmpeg 6.x～8.x 都认这个名字。改后连续 3 次输出逐位相同。

## 问题三：HDR 不能配硬件编码器（跨平台）

HDR 时编码器的像素格式写死为 `yuv420p10le`，而硬件 HEVC 编码器只收 `p010le`，打开编码器时就失败。受影响的有 hevc_videotoolbox，以及 Windows 上的 hevc_nvenc、hevc_amf。界面提示"将自动切换 libx265"，实际上只有选 libx264 时才会换。

已改为按编码器支持的格式选：支持 `yuv420p10le` 就用它，否则用 `p010le`。验证结果：

- libx265 的 HDR 输出与修改前逐位相同。
- hevc_videotoolbox 输出 Main 10，与 libx265 的输出比 50.0 dB。
- 界面提示已改为如实描述。

Windows 上未验证。

## 已知限制：HDR 峰值亮度（与 Windows 相同）

FFmpeg 7.1 的 libplacebo 滤镜没有 `target_peak` 选项（8.0 才有），逆色调映射会按 PQ 的 10000 nits 上限扩展高光。`--hdr-peak` 只写进容器元数据（mastering display / CLL）。

实测 PQ 输出的 Y 最大值为 967，超过 10bit 有限范围的上限 940。Windows 同为 FFmpeg 7.1，行为一致，代码里已有警告日志。要真正控制峰值，需要换 FFmpeg 8 以上或给 7.1 打补丁，不在本次范围内。

## FFmpeg 构建

用 `scripts/macos/build-ffmpeg.sh` 构建：

- **源码：** 取 FFmpeg 官方 GitHub 仓库的 `n7.1.5` 标签（ffmpeg.org 在国内连不上），并核对 SHA-256。
- **VERSION 文件：** 脚本会补写 `VERSION`。GitHub 标签包没有这个文件，版本号会取成本仓库的提交号。
- **外部库：** 只开项目用到的——x264、x265、libaom、libvpx、dav1d、vidstab、zimg、libplacebo；configure 自动探测到的 X11、SDL2、lzma 都关掉，免得打包时多带。
- **安装位置：** `third_party/ffmpeg-macos`（23 MB）。
- **耗时：** M5 Max 上编译约 1 分钟，国内下载源码约 1.5 分钟。

`build-core.sh`、bridge、worker 都优先用这份 FFmpeg，没有时退回 ffmpeg@7。`doctor.sh` 会检查核心链接的 FFmpeg 与界面用的是同一份。

**阶段 5 打包要注意：** libplacebo 自己链接 vulkan-loader，再经 ICD 清单加载 MoltenVK。所以包里除了 MoltenVK，还要带上 loader 和 ICD 清单。
