# macOS 移植：可行性、硬件预期与路线

> 整理于 2026-10，基于 Windows 版提交 `2dbd56e` 之后的代码。外部事实均已联网核实（见 §3 来源）；
> 标"待实测"的条目必须在 Mac 上验证后再下结论。

## 结论

- **可以移植，而且大部分是成熟路径。**
  - Electron 界面、Node bridge 本身跨平台。
  - C++ 核心上游已支持 Linux（FFmpeg 走 pkg-config，ncnn/spdlog/Boost 可用系统库）。
  - ncnn 系引擎通过 MoltenVK（Vulkan→Metal）在 Apple Silicon 上有现成方案。
- **旗舰 PyTorch 引擎能跑，但会明显变慢。**
  - Windows 上的三项加速在 Mac 上全部不可用：FP8 张量核、SageAttention、Triton。
  - MPS 不支持 FP8 张量，FP8 权重必须先在 CPU 上还原成 fp16/bf16。
  - 能处理的分辨率受统一内存大小限制。
- **建议定位：**
  - Mac 版做到功能完整、日常可用。
  - 大批量的 SwiftVR / SeedVR2 渲染，在 Mac 实测证明够快之前，仍以 Windows + RTX 5070 Ti 为主力。

## 1. 逐组件可行性

| 组件 | Windows 现状 | macOS 方案 | 工作量 | 风险 / 待验证 |
|---|---|---|---|---|
| Electron 外壳 + React 界面 | electron-builder `--win dir` | `--mac dir`（之后可出 dmg）；图标需 ≥512 px（现有 `ui/build/icon.png` 只有 256 px，用 `gen_icon.py` 重出 1024 px） | 小 | 未签名应用会被 Gatekeeper 拦截，自用时清除隔离属性即可 |
| 路径拼接、选择文件、打开文件夹 | `\\` 拼接、PowerShell OpenFileDialog、`explorer /select` | `path.join`；Electron `dialog` 或 `osascript`；`open -R` | 小 | — |
| bridge 进程管理 | `taskkill /t /f` 杀进程树；`suspend_tree.ps1`（NtSuspendProcess）真暂停 | 子进程 `detached:true` 自成进程组，用 `kill(-pgid, SIGKILL / SIGSTOP / SIGCONT)` | 中 | 暂停/恢复后看门狗与旗标文件的语义要保持一致 |
| C++ 核心 libvideo2x + `video2x` CLI | MSVC + 预编译 FFmpeg/ncnn DLL | Apple Clang + CMake；FFmpeg 用 pkg-config，ncnn/spdlog/Boost 用 Homebrew | 中 | `[[gnu::target_clones("arch=x86-64-v4",…)]]` 是 x86/ELF 专用，arm64 + Mach-O 需宏屏蔽（7 处）；`wmain` 等已有 `_WIN32` 分支，非 Windows 分支上游在 Linux 上验证过 |
| FFmpeg | gyan.dev 7.1 full（GPL v3，共享库） | 首选 Homebrew `ffmpeg@7`（7.1.5，同一 API 代，带 libvidstab）；需要 Anime4K 时再自编 7.1 + Vulkan + libplacebo，或迁到 `ffmpeg-full`（9.0，需适配 API） | 中 | 普通 `ffmpeg` 公式（9.0.2）**没有** libvidstab 和 libplacebo，防抖与 Anime4K 会直接不可用 |
| ncnn 引擎（Real-ESRGAN / Real-CUGAN / RIFE / SPAN） | ncnn 20240820 预编译 + Vulkan | Homebrew `ncnn`（20260526，依赖 molten-vk，有 arm64 bottle） | 中 | MoltenVK 下个别 shader 可能有精度/兼容问题，用参考输出比 PSNR |
| libplacebo（Anime4K） | FFmpeg 的 libplacebo 滤镜 + Vulkan | 需要带 `--enable-vulkan --enable-libplacebo` 的 FFmpeg + MoltenVK | 大 | 放到后期阶段；在此之前 Mac 版界面隐藏该处理器 |
| 防抖 / 降噪 / HDR | FFmpeg 滤镜（vidstab、hqdn3d/nlmeans、libplacebo 色调映射） | 防抖、降噪随 ffmpeg@7 可用；HDR 依赖 libplacebo，与 Anime4K 同批 | 小～大 | — |
| 硬件编解码 | NVENC / AMF；解码 cuda / d3d11va / dxva2 / qsv | 编码 `h264_videotoolbox` / `hevc_videotoolbox`；解码 `-a videotoolbox` | 小 | VideoToolbox 的质量参数是 `-q:v`（0–100），与 x264 的 CRF 不同；`qualityOpts()` 需新增分支 |
| RealBasicVSR | CUDA + fp16 autocast | MPS + fp16 | 小 | 实现已去掉 mmcv 自定义算子，纯 PyTorch，MPS 风险低 |
| SwiftVR | CUDA；FP8 权重 + FP8 张量核计算 + SageAttention；显存上限防 Windows 共享内存回退 | MPS；载入时把 FP8 文件在 CPU 上还原为 bf16/fp16（常驻约 10 GB）；SDPA 注意力；decord 用空模块占位 | 中～大 | 速度、2K 是否放得下都待实测；M1–M3 的 bf16 是软件模拟（比 fp16 慢约一倍），可能要用 fp16 |
| SeedVR2-3B | CUDA；FP8 DiT + BlockSwap + VAE 分块 | MPS；改用官方 **fp16** DiT（`seedvr2_ema_3b_fp16.safetensors`，同在 HF `numz/SeedVR2_comfyUI`）；BlockSwap 在 macOS 上由上游自动禁用 | 中 | 速度待实测（Windows 上 960p 已只有 0.55 fps，Mac 上会更慢） |
| 加速库 | SageAttention 2 + triton-windows + `torch._scaled_mm` | 全部不可用，统一走 PyTorch SDPA | — | 现有代码已有自检/回退逻辑，但 SwiftVR/SeedVR2 入口目前硬性要求 `cuda:N`，需放开 |
| 打包 | 嵌入式 CPython（`engine-python/python/python.exe`） | python-build-standalone（可重定位 CPython）放进包内；FFmpeg/ncnn/MoltenVK 的 dylib 随包并修正 rpath | 中 | 正式分发要 Apple Developer ID 签名 + 公证；自用 ad-hoc 签名即可 |

## 2. Mac 硬件预期

先在 Mac 上跑 `scripts/macos/doctor.sh`，确认芯片型号与统一内存大小，再按下表定目标。

| 统一内存 | 预期可行范围 |
|---|---|
| 16 GB | ncnn 引擎、Lanczos、RealBasicVSR。SwiftVR 不可行（bf16 权重就要约 10 GB）。SeedVR2 很勉强 |
| 24 GB | SwiftVR 约 1080p 级输出（待测）；SeedVR2 低分辨率 |
| 36 GB 及以上 | SwiftVR 2K 有希望（Windows 上 2K 峰值约 13.8 GB 显存，另加约 10 GB bf16 权重）；SeedVR2 可用 |

关于速度，下面几点都要等 Mac 实测：

- RTX 5070 Ti 的 bf16 张量核实测约 90 TFLOPS，FP8 再翻倍。Apple 芯片 GPU 的半精度算力低一个数量级上下（取决于芯片档次）。
- MPS 上也没有 FP8 和 SageAttention。
- **预期旗舰引擎会慢数倍到十几倍。**
- ncnn 引擎的差距相对小一些，因为模型小，更依赖带宽而不是算力。

精度选择：

- PyTorch 在 macOS 14+ 的 MPS 上支持 bf16，但 M1–M3 没有 bf16 硬件，是模拟执行，实测比 fp16 慢约一倍；M4 起原生支持。
- 所以 M4 及以后用 bf16（与 Windows 一致）。
- M1–M3 先试 fp16，必须验证没有溢出（输出出现 NaN 或黑帧即溢出）。

### 实测：M5 Max（32 核 GPU）/ 36 GB / macOS 27.0.1，PyTorch 2.14.1（2026-10-09）

| 项目 | 实测 |
|---|---|
| matmul fp16 / bf16（8192³ 稳态） | 47.4 / 47.3 TFLOPS；fp32 约 12 TFLOPS |
| Conv3d 128→128 k3（VAE 量级） | fp16 33 TFLOPS，bf16 41 TFLOPS |
| SDPA fp16（24 头 × 4096 × 128） | 5.0～5.3 ms，约 39 TFLOPS |
| `torch.mps.recommended_max_memory()` | 28.1 GB |
| FP8（`float8_e4m3fn`） | 能拷上 MPS，但转 bf16/fp16、量化、`_scaled_mm` 全部报错（"Undefined type Float8_e4m3fn" / 未实现），即只能存不能算 |
| SwiftVR（阶段 3 实测，详见 `docs/reports/macOS-SwiftVR实测报告.md`） | 2K 稳态 2.9～3.2 fps（Windows FP8 7.1 / bf16 5.7），960p 约 6.9 fps；画质与 Windows 参考 44.3～44.7 dB；2K 内存峰值 26～29 GB |
| RealBasicVSR / SeedVR2（阶段 3 实测，详见 `docs/reports/macOS-RealBasicVSR与SeedVR2实测报告.md`） | RealBasicVSR 与 Windows 相当（720p 输入 4× 端到端约 1.4 fps，画质 43.4 dB）；SeedVR2 960p 约 0.22 fps（Windows 0.55），画质 39.0 dB，载入时内存瞬时峰值约 30 GB |
| ncnn（MoltenVK）Real-ESRGAN animevideov3，854×480→2× | 稳态约 13 fps（去掉编码也一样），启动约 1 s。ncnn 报 `fp16-cm=0`：没有 cooperative matrix，卷积只能走普通着色器 |

与上面预期不同的地方：

- **半精度算力不是低一个数量级，而是约为 RTX 5070 Ti bf16（90 TFLOPS）的一半。** bf16 与 fp16 一样快，SwiftVR 沿用 bf16 即可。旗舰引擎"慢数倍到十几倍"的预期对这台机器偏悲观，按算力比推算 SwiftVR 的上限约为 Windows bf16 版的一半，实际待阶段 3 实测。
- **ncnn 引擎反而差距更大。** 同样 72 帧（含启动），Windows 约 3 s，Mac 约 6～7 s；Mac 稳态每帧约 75 ms。Windows 稳态没有单独测过，按含启动的总时间看约慢 2 倍，稳态差距只会更大。很可能的原因是 MoltenVK 上没有 cooperative matrix（N 卡上走张量核），这是 ncnn + MoltenVK 路线本身的上限。
- **36 GB 放得下 SwiftVR 2K，但偏紧：** 估算是约 19 GB，实测 MPS 峰值 25.9 GB（分段 8），进程峰值 26～29 GB，长片段时系统有少量换页。MPS 的激活内存约为 CUDA 的两倍。分段改 4 能省 7 GB，但画质（帧间稳定性）明显变差，所以不改，见报告。

## 3. 已核实的外部事实（2026-10 联网查证）

- **MPS 不支持 `float8_e4m3fn`：** 上 MPS 会报 “does not have support for that dtype”，社区只有第三方 Metal 内核方案。
  - 来源：[ComfyUI-AppleSilicon-FP8](https://github.com/pawel-mazurkiewicz/ComfyUI-AppleSilicon-FP8)、[Comfy 论坛](https://forum.comfy.org/t/flux-schnell-and-no-support-dtype/678)
- **Conv3d 在 MPS 上的支持：** 早期版本报 “Conv3D is not supported on MPS”，新版 PyTorch 冒烟测试通过。
  - SeedVR2 与 SwiftVR 的 VAE 大量用 Conv3d，`doctor.sh` 里有专门的冒烟测试。
  - 来源：[PyTorch 论坛](https://discuss.pytorch.org/t/will-the-conv3d-operation-be-supported-on-mps-through-pytorch/198233)
- **bf16 on MPS：** macOS 14 起支持；M1–M3 为模拟。
  - 来源：[PyTorch #119641](https://app.semanticdiff.com/gh/strisunshinewentingwang/pytorch/commit/4ee8aac4323c41cd26310217db9eb7a8a65b9035)、[MPS BF16 变慢案例](https://lilting.ch/en/articles/comfyui-qwen-mps-bf16-slowdown)
- **Homebrew FFmpeg：**
  - `ffmpeg` 9.0.2 的依赖里没有 libvidstab、libplacebo。
  - `ffmpeg-full` 9.0.2 两者都有（keg-only）。
  - `ffmpeg@7` 7.1.5 有 libvidstab、没有 libplacebo（keg-only）。
  - 来源：[ffmpeg](https://formulae.brew.sh/formula/ffmpeg)、[ffmpeg-full](https://formulae.brew.sh/formula/ffmpeg-full)、[ffmpeg@7](https://formulae.brew.sh/formula/ffmpeg@7)
- **Homebrew `libplacebo` 7.360.1：** 依赖 vulkan-loader、shaderc、little-cms2。
  - 来源：[libplacebo](https://formulae.brew.sh/formula/libplacebo)
- **Homebrew `ncnn` 20260526：** 依赖 molten-vk、glslang、spirv-tools，有 arm64 bottle（Sequoia / Tahoe）。
  - 来源：[ncnn](https://formulae.brew.sh/formula/ncnn)
  - ncnn 官方说明 macOS 通过 MoltenVK 运行 Vulkan 后端。
- **decord：** 0.6.0 只有 macOS x86_64 wheel，没有 arm64。
  - 替代品 eva-decord 有 arm64 wheel，但只到 CPython 3.11；本项目用 3.12，所以不采用，改用空模块占位，见 D7。
  - 来源：[decord](https://pypi.python.org/pypi/decord)、[eva-decord](https://pypi.org/project/eva-decord/)
- **numz 的 SeedVR2 实现支持 Apple Silicon（MPS）：** 在 macOS 上自动禁用 BlockSwap（统一内存下没有意义），中间张量常驻 MPS。
  - 来源：[ComfyUI-SeedVR2_VideoUpscaler](https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler)
  - 仓库里 vendored 的代码已含 `is_mps_available()` 分支。

## 4. 关键决策（建议，开工时可推翻，但要写明理由）

- **D1 FFmpeg：**
  - 先用 `ffmpeg@7`。它和 Windows 的 7.1 是同一 API 代，C++ 核心不用适配新 API，而且自带 vidstab。
  - Anime4K/HDR 暂时在 Mac 上隐藏。
  - 阶段 4 再二选一：自编 FFmpeg 7.1（`--enable-vulkan --enable-libplacebo --enable-libvidstab`，链接 Homebrew 的 libplacebo / vulkan-loader / molten-vk），或把核心迁到 FFmpeg 9 后用 `ffmpeg-full`。
- **D2 ncnn：** `-DVIDEO2X_USE_EXTERNAL_NCNN=ON` 用 Homebrew ncnn。不行再从源码编，并打开 `-DNCNN_VULKAN=ON`；必要时用 `USE_STATIC_MOLTENVK`。
- **D3 spdlog / Boost：** `-DVIDEO2X_USE_EXTERNAL_SPDLOG=ON -DVIDEO2X_USE_EXTERNAL_BOOST=ON`，用 Homebrew 版。
- **D4 Python：**
  - 开发期用 Homebrew `python@3.12` 建 `engine-python/.venv`。bridge 已有 `.venv` 回退逻辑，只需把 `Scripts/python.exe` 换成 `bin/python3`。
  - 打包期换 python-build-standalone。
  - 版本保持 3.12，与 Windows 一致。
- **D5 SwiftVR 权重：**
  - 新增"MPS 载入路径"：读 `swiftvr_transformer_fp8.safetensors`，在 CPU 上按 `w8 * scale` 还原为 bf16/fp16，再整体搬到 MPS，不用 `FP8Linear`。
  - 也可以一次性用 19 GB 官方原版权重转出一份 bf16 文件（约 10 GB）给 Mac 专用。
  - 两种做法的画质差都在 PSNR≈50 dB 级。
  - 实测补充（M5 Max，torch 2.14.1）：
    - FP8 只能存在 MPS 上，不能在 MPS 上转换，所以"在 CPU 上还原"仍是必要的。
    - 折中做法可行：FP8 以 uint8 常驻 MPS，前向用 256 项查表还原为 bf16。还原结果与 CPU 逐位一致，线性层慢约 30%，权重常驻内存减半（约 5 GB）。36 GB 机器用不上，留给 24 GB 机型。
    - Mac 反正要常驻 bf16 权重，用官方原版权重转出的 bf16 没有 FP8 量化损失，内存占用相同，因此优先用官方原版（迁移包的可选部分，`restore-on-mac.sh --with-optional`）。
- **D6 SeedVR2 权重：**
  - Mac 上资产系统改为下载 `seedvr2_ema_3b_fp16.safetensors`。
  - `bridge.mjs` 的 `PY_WEIGHTS.seedvr2` 与资产表按平台选文件，`seedvr2_runner` 的 DiT 文件名同步。
- **D7 decord：**
  - 在 `swiftvr_runner.py` 导入 `swiftvr` 之前，若 `import decord` 失败，就往 `sys.modules['decord']` 放一个空模块。
  - 理由：本项目用 FFmpeg 管道读帧，从不调用 decord。
  - 这样不改 vendor 代码；NOTICE 里"vendor 未修改"的声明仍成立。
- **D8 设备模型：**
  - `worker.py` 新增 `mps` 设备。
  - bridge 的 `/api/cuda-devices`（建议改名为 `/api/torch-devices`，保留旧路由兼容）在 Mac 上返回一个设备：名称取 `sysctl -n machdep.cpu.brand_string`（如 “Apple M4 Max”），容量取统一内存。
  - 调度槽位的 `physicalGpuKey` 要让 MoltenVK 报告的 GPU 名与这个名字归到同一个键，保证 ncnn 任务与 PyTorch 任务不会同时压同一块 GPU。
- **D9 平台抽象：** 新建 `ui/server/platform.mjs`，集中处理以下差异；`bridge.mjs` 里不要散落 `process.platform` 判断：
  - 可执行文件名
  - Python 路径
  - FFmpeg 路径
  - 动态库搜索路径（Windows 改 `PATH`；Mac 用 rpath，必要时设 `DYLD_LIBRARY_PATH`）
  - 杀进程树、挂起 / 恢复
  - 打开文件夹、选文件对话框
  - 网络路径判断（Windows 的 UNC，对应 Mac 上 `/Volumes/` 下的 smbfs / nfs / afpfs 挂载）
- **D10 打包：** electron-builder 新增 `mac` 段，target `dir`。`check-dist.mjs` 的关键文件表按平台分开。自用 ad-hoc 签名（`codesign -s -`）。

## 5. 分阶段路线

每个阶段结束都按 [05-acceptance.md](05-acceptance.md) 对应小节验收，通过后提交，再进入下一阶段。

| 阶段 | 目标 | 主要工作 | 退出条件 |
|---|---|---|---|
| 0 环境 | 能编、能跑测试 | 按 03-setup.md 装依赖；`doctor.sh` 全绿或明确知道哪项缺；仓库与权重就位 | doctor 报告 + 硬件档位确认 |
| 1 C++ 核心 | `video2x` CLI 在 Mac 上跑通 | 屏蔽 `target_clones`；CMake 用 ffmpeg@7 / Homebrew ncnn / spdlog / Boost；`-l` 能列出 MoltenVK 设备 | Lanczos、Real-ESRGAN、Real-CUGAN、RIFE、SPAN、防抖、降噪与 Windows 参考输出 PSNR 达标 |
| 2 bridge + 界面 | `npm run dev` 在 Mac 上完整可用（ncnn 引擎） | `platform.mjs`；路径/对话框/打开文件夹/杀进程/挂起；编码器与硬件解码列表按平台；`/api/health` 带上平台信息供界面判断 | 新建任务→进度→暂停/恢复/中止→打开文件夹全流程通过 |
| 3 PyTorch 引擎 | 三个旗舰引擎在 MPS 上出片 | `worker.py` 设备层；RealBasicVSR → SwiftVR（D5、D7、按统一内存定分段）→ SeedVR2（D6）；断点续跑协议不变 | 三个引擎与参考输出对比达标 + Mac 实测速度/内存写入报告 |
| 4 Anime4K / HDR | libplacebo 系功能 | 自编 FFmpeg（或迁 FFmpeg 9）+ MoltenVK | Anime4K、HDR 与参考输出对比达标 |
| 5 打包 | 双击可用的 `.app` | python-build-standalone；dylib 收集与 rpath；MoltenVK ICD；`check-dist` Mac 版；ad-hoc 签名 | 拷到另一台 Mac（或新用户账户）首次运行即可出片 |
| 6 收尾 | 文档与合规 | README / CHANGELOG / NOTICE / COMPLIANCE 补 Mac 内容；性能报告写进 `docs/reports/` | 文档与实测一致 |

## 6. 风险清单

- **MPS 回退到 CPU：** `PYTORCH_ENABLE_MPS_FALLBACK=1` 会让不支持的算子悄悄在 CPU 上跑，结果"能出片但极慢"。只在定位问题时临时开，正式运行要知道是哪个算子在回退。
- **统一内存超额会转为换页（swap）。** 不报错，但速度暴跌，与 Windows 显存溢出到共享内存同一类问题。分段长度要按内存定；可用 `PYTORCH_MPS_HIGH_WATERMARK_RATIO` 设上限，让它尽早报 OOM、走现有的减半重试。
- **MoltenVK 与 ncnn 的兼容性：** 个别模型可能输出偏差或失败，以 PSNR 对比为准。
- **FFmpeg 大版本：** 若选 FFmpeg 9，libvideo2x 用到的已废弃 API 可能被移除，需要逐个适配。
- **Gatekeeper：** 未签名的 `.app` 和下载来的二进制会被隔离，需要 `xattr -dr com.apple.quarantine`。
- **许可（顺带发现的既有问题）：** COMPLIANCE.md 把 FFmpeg 写成 LGPL-2.1 动态链接，但 Windows 包里的实际是 gyan.dev 的 **GPL v3** full build。主程序是 AGPL-3.0，与 GPLv3 兼容，所以不构成冲突，但文档表述应更正。Homebrew 的 FFmpeg 同样是 GPL 构建（含 x264/x265）。
