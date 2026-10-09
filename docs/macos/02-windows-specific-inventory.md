# Windows 专有代码清单（文件:行号 → Mac 替代）

> 行号基于整理时的提交（`git log -1` 可见）。代码改动后行号会漂移，以函数名或注释为准再定位。
> "阶段"对应 [01-feasibility.md](01-feasibility.md) §5 的路线。

## A. C++ 核心（阶段 1）

| 位置 | 现状 | Mac 处理 |
|---|---|---|
| `src/conversions.cpp:14,71,111`、`src/encoder.cpp:353,449`、`src/libvideo2x.cpp:32`、`src/avutils.cpp:139` | `[[gnu::target_clones("arch=x86-64-v4", "arch=x86-64-v3", "default")]]`。函数多版本依赖 ELF 的 ifunc；MSVC 会忽略这个属性 | 定义宏 `V2X_TARGET_CLONES`（在 `libvideo2x_export.h`）：仅在 `__x86_64__ && __linux__` 时展开为该属性，其他平台为空。7 处统一替换。**实测：** Apple Clang 对它只报警告（每处 4 条）并忽略，不会导致编译失败；改宏是为了清掉这 28 条警告 |
| `CMakeLists.txt:132-168` | `if(WIN32)` 链接 `third_party/ffmpeg-shared` 的 `.lib`；else 分支用 pkg-config | Mac 走 else 分支。configure 时设 `PKG_CONFIG_PATH=$(brew --prefix ffmpeg@7)/lib/pkgconfig`（ffmpeg@7 是 keg-only，必须手动指）。**实测：** else 分支原来链接 `_LIBRARIES`（裸库名 `-lavcodec`），keg-only 时链接器找不到，已改为 `_LINK_LIBRARIES`（完整路径），Linux 上同样适用 |
| `CMakeLists.txt:156` | else 分支 `target_include_directories` 里误写了 `${libavfilter_LIBRARIES}`（应为 `_INCLUDE_DIRS`），上游原样 | 顺手改正，否则 avfilter 头文件可能找不到 |
| `CMakeLists.txt:170-182` | Windows 用 `third_party/ncnn-shared` 预编译 DLL | `-DVIDEO2X_USE_EXTERNAL_NCNN=ON` → `find_package(ncnn)`（Homebrew ncnn，带 MoltenVK）。**实测：** Homebrew 的 ncnn 带 libomp 编译，导出目标依赖 `OpenMP::OpenMP_CXX`，要传 `-DOpenMP_ROOT=$(brew --prefix libomp)`，并且因为项目的 `cmake_minimum_required` 早于 3.12，还要 `-DCMAKE_POLICY_DEFAULT_CMP0074=NEW` 才会生效（已写进 `build-core.sh`） |
| `CMakeLists.txt:44`（Release 链接参数） | `-Wl,-s -Wl,--gc-sections` 是 GNU ld 参数 | **实测：** 苹果的 ld64 不认 `--gc-sections`，链接失败。已加 `if(APPLE)` 分支改用 `-Wl,-dead_strip`，其他平台不变 |
| Vulkan 链接 | CLI 与三个封装库 `find_package(Vulkan)` | **实测：** 默认会找到 vulkan-loader，而 MoltenVK 对 loader 来说是 portability 驱动，`vulkan_utils.cpp` 创建实例时没声明 `VK_KHR_portability_enumeration`，`-l` 报 "Failed to create Vulkan instance"。`build-core.sh` 改为 `-DVulkan_LIBRARY=<molten-vk>/lib/libMoltenVK.dylib`，与 Homebrew 的 ncnn 一样直接链 MoltenVK，进程内只有一套 Vulkan 实现，打包也不用带 loader 和 ICD 清单 |
| `CMakeLists.txt:22-24` | spdlog/Boost 在 Windows 构建脚本里用源码（`=OFF`） | Mac 用 `=ON` + Homebrew `spdlog`（会带上 `fmt`）、`boost`（CLI 用 program_options） |
| `CMakeLists.txt:113-115, 273-` | `add_subdirectory(third_party/lib*_ncnn_vulkan/src)` | 这三个库的源码不在 git 里（`third_party/` 整个被 .gitignore），迁移包里有锁定提交的 git bundle，见 03-setup.md |
| `src/fsutils.cpp`、`include/libvideo2x/fsutils.h`、`tools/video2x/src/argparse.cpp`、`tools/video2x/src/video2x.cpp`（`wmain`、`SetConsoleOutputCP` 等） | `_WIN32` 宽字符路径与控制台 | 已有完整的非 Windows 分支（上游 Linux 在用），编译通过。**实测例外：** `fsutils.cpp` 的 `get_executable_directory()` 非 Windows 分支读 `/proc/self/exe`，macOS 没有 `/proc`，每次运行打 4 行 `[error]`，"在可执行文件旁找资源"这条兜底也失效。已加 `__APPLE__` 分支用 `_NSGetExecutablePath` |
| `src/libplacebo.cpp:113` | `_WIN32` 下把 `\` 换成 `/` | 不用改 |
| `tools/video2x/src/vulkan_utils.cpp` | `-l` 枚举 Vulkan 设备 | MoltenVK 下 Apple GPU 一般报 “Integrated GPU”。bridge 的自动选卡"独显优先，否则 0 号"在 Mac 上自然落到 0 号，不用改 |

## B. bridge（`ui/server/bridge.mjs`，阶段 2）

建议新建 `ui/server/platform.mjs` 收拢下表所有差异（D9）。

| 位置 | 现状 | Mac 处理 |
|---|---|---|
| 28、52、98-99 | 定位项目根与 CLI：`build-desktop/Release/video2x.exe`；`installStatus()` 检查 `video2x.exe`、`libvideo2x.dll`、`ffmpeg.exe` | Mac 上 CMake 单配置生成器产物在 `build-macos/video2x` 与 `build-macos/libvideo2x.dylib`（目录名自定，与 `findProjectRoot` 同步改） |
| 57-62 | Python：`engine-python/python/python.exe`，回退 `.venv/Scripts/python.exe` | 开发期 `engine-python/.venv/bin/python3`；打包期 `engine-python/python/bin/python3`（python-build-standalone） |
| 65-67、1377 | `suspend_tree.ps1` + `powershell.exe`：用 NtSuspendProcess 挂起整棵进程树（"真暂停"） | `process.kill(-pgid, 'SIGSTOP')` / `'SIGCONT'`。前提是 spawn 时 `detached: true`，子进程自成进程组（见下一行）。`.v2xsuspended` 旗标文件的协议保持不变 |
| 711-721（`shutdownBridge`）、1380、1384（中止） | `taskkill /pid N /t /f` 杀进程树 | `process.kill(-pgid, 'SIGKILL')`。Windows 上 spawn 保持现状，Mac 上改 `detached: true` |
| 108-109 | `third_party/ffmpeg-shared/bin/ffmpeg.exe`、`ffprobe.exe` | 开发期取 `$(brew --prefix ffmpeg@7)/bin/ffmpeg`（可用环境变量 `VIDEO2X_FFMPEG_DIR` 覆盖）；打包期放进包内 |
| 489、1022、1214 | `env.PATH = [...DLL_DIRS, PATH].join(';')`，让 exe 找到 DLL | Mac 靠 rpath（CMake `INSTALL_RPATH` / `@loader_path`）；开发期如有需要设 `DYLD_LIBRARY_PATH`。分隔符用 `path.delimiter` |
| 505-514（`DLL_DIRS`） | MSBuild 多配置输出目录 | Mac 不需要 |
| 490、839、1032 | `windowsHide: true` | 无害，保留 |
| 1122-1162（`psDialog`） | PowerShell 的 OpenFileDialog / FolderBrowserDialog | 二选一：(a) `osascript -e 'choose file … with multiple selections allowed'` / `choose folder`，输出 POSIX 路径；(b) 改由 Electron 主进程 `dialog.showOpenDialog`，经 preload 暴露。bridge 也会脱离 Electron 单独运行（`npm run dev`），所以 (a) 更省事 |
| 1566-1597（打开文件夹 / 日志） | `explorer.exe /select,"…"`，`windowsVerbatimArguments`；UNC 特判 | `open -R <文件>`（在 Finder 中选中），目录用 `open <dir>` |
| 755-757（`needsStaging`） | `\\` 开头的 UNC 路径先整文件拷贝到本地暂存 | Mac 的网络盘挂在 `/Volumes/…`，用 `fs.statfsSync(p).type` 或 `mount` 输出判断 smbfs / nfs / afpfs / webdav |
| 1224-1240（`/api/cuda-devices`） | `torch.cuda` 枚举 CUDA 卡与显存 | Mac 返回 `[{index:0, name:<芯片名>, vramGb:<统一内存GB>, type:'mps'}]`。芯片名用 `sysctl -n machdep.cpu.brand_string`，内存用 `sysctl -n hw.memsize`（D8）|
| 933-945（`physicalGpuKey` / `slotKeyOf`） | Python 任务从 `--device cuda:N` 解析卡号 | 识别 `--device mps`，映射到与 MoltenVK 设备相同的物理键 |
| 1796-1840（预检） | SeedVR2 / SwiftVR 吞吐按 RTX 5070 Ti 估算；SwiftVR 要求 ≥15 GB 显存 | Mac 上用实测数据重写估算；内存门槛改按统一内存判断（SwiftVR 建议 ≥32 GB 才开放 2K） |
| 172-230（资产表） | SeedVR2 资产下载 `seedvr2_ema_3b_fp8_e4m3fn.safetensors` | Mac 下载 `seedvr2_ema_3b_fp16.safetensors`（D6）；`PY_WEIGHTS.seedvr2`（68-71 行）同步按平台取 |

## C. 前端（`ui/src`，阶段 2）

| 位置 | 现状 | Mac 处理 |
|---|---|---|
| `lib/args.ts:190` | `` `${dir}\\${name}` `` 拼输出路径 | 按输入路径风格选分隔符（输出目录含 `/` 且不含 `\` 时用 `/`），或由 bridge 拼路径 |
| `lib/args.ts:22` | `--device cuda:N` | Mac 发 `--device mps`（由 `/api/health` 返回的 `platform` 决定） |
| `lib/args.ts:353-372`（`CODECS` / `HWACCELS`） | NVENC、AMF 编码；cuda / d3d11va / dxva2 / qsv 解码 | Mac 列表：`h264_videotoolbox`、`hevc_videotoolbox`、`prores_videotoolbox`；解码 `videotoolbox` |
| `lib/args.ts:131-150`（`qualityOpts`） | nvenc→`cq`、amf→`qvbr_quality_level` | `*_videotoolbox` → `q:v`（0–100，越大越好）。需要实测找一个与 CRF 18 画质接近的值 |
| `sections/form/EncoderSection.tsx:85,133-150` | 编码器说明与测速表均为 N 卡数据 | Mac 上换成 VideoToolbox 实测数据或隐藏 |
| `sections/form/AdvancedSection.tsx:32-55`、`NewJobView.tsx:22,100,330` | "CUDA 设备"选择 | Mac 显示为 "Apple GPU（MPS）"，单设备时可隐藏选择框 |
| `sections/form/FileSection.tsx:188` | 占位符 `D:\Videos\enhanced` | Mac 显示 `~/Movies/enhanced` |
| `sections/form/ProcessorSection.tsx` 各引擎说明 | 速度数据均为 RTX 5070 Ti 实测 | Mac 实测后补一套说明，或在说明里注明测试平台 |
| `NewJobView.tsx:141` | "找不到 video2x.exe" | 文案去掉 `.exe` |

## D. Python 引擎（阶段 3）

| 位置 | 现状 | Mac 处理 |
|---|---|---|
| `engine-python/worker.py:45-48` | 按 `os.name` 设 `PYTORCH_CUDA_ALLOC_CONF` | Mac 上不需要；可以考虑设 `PYTORCH_MPS_HIGH_WATERMARK_RATIO`，让统一内存超限时尽早报 OOM、走减半重试，而不是陷入换页 |
| `worker.py:55-57` | `ffmpeg.exe` / `ffprobe.exe` 固定在 `third_party/ffmpeg-shared/bin` | 按平台取，优先环境变量 `VIDEO2X_FFMPEG_DIR`（由 bridge 传入） |
| `worker.py:72-99`（`resolve_device` / `validate_cuda_device`） | 只认 `cuda[:N]`，其他一律回落 `cpu` | 新增 `mps` 分支（`torch.backends.mps.is_available()`）。`engine-python/tests/test_resolve_device.py` 同步补用例 |
| `worker.py:102-125`（`sageattn_selftest`） | CUDA 专用 | MPS 上直接返回 `(False, 'MPS 不支持')` |
| `worker.py:400-541`（RealBasicVSR 主流程） | `use_cuda`、`torch.cuda.set_device`、`autocast('cuda', fp16)`、`torch.cuda.empty_cache()`、按显存定分块 | MPS：`autocast('mps', dtype=torch.float16)`、`torch.mps.empty_cache()`；分块预算按 `torch.mps.recommended_max_memory()` |
| `vsr_models/realbasicvsr.py:356,408` | 默认 `device='cuda'`；fp16 仅 cuda | 放开 mps |
| `vsr_models/seedvr2_runner.py:59-84`（`pick_attention_mode`） | SageAttention / FlashAttention 选择 | MPS 固定 `sdpa` |
| `seedvr2_runner.py:89-105`（`pick_memory_strategy`） | 按 CUDA 显存选 BlockSwap / VAE 分块 | MPS：`blocks=0`（上游在 macOS 会强制禁用 BlockSwap），分块按统一内存实测重定 |
| `seedvr2_runner.py:112,351,358` | `torch.backends.cudnn.benchmark` 开关 | MPS 上无意义，跳过 |
| `seedvr2_runner.py:136-142` | `fail('SeedVR2 需要 CUDA 设备')` | 允许 `mps` |
| `seedvr2_runner.py:374-380,476` | `result.is_cuda`、`torch.cuda.empty_cache()`、`max_memory_reserved` | 改为设备无关写法（`result.device.type != 'cpu'`、按设备调对应的 `empty_cache`；MPS 用 `torch.mps.driver_allocated_memory()`） |
| `seedvr2_runner.py` DiT 文件名（来自上游 `DEFAULT_DIT`） | fp8 | Mac 用 fp16 文件（D6） |
| `vsr_models/swiftvr_runner.py:61-104`（`FP8Linear`） | FP8 权重 + 前向反量化；sm_89+ 走 `torch._scaled_mm` | MPS 不支持 FP8 张量：新增载入路径，在 CPU 上把 `w8 * scale` 还原为普通 `nn.Linear`（bf16/fp16）后整体 `.to('mps')`（D5） |
| `swiftvr_runner.py:236-250`（`pick_fp8_compute`） | `torch.cuda.get_device_capability` | MPS 直接返回关闭 |
| `swiftvr_runner.py:276`（SageAttention 自检） | — | MPS 跳过，`set_attention_backend('sdpa')` |
| `swiftvr_runner.py:331-342` | 要求 CUDA；按显存定分段；`set_per_process_memory_fraction` 防 Windows 共享内存回退 | 允许 `mps`；用统一内存与 `recommended_max_memory()` 定初始分段；用 `PYTORCH_MPS_HIGH_WATERMARK_RATIO` 代替 memory fraction |
| `swiftvr_runner.py:409,600` | `torch.cuda.memory_allocated`、`empty_cache` | 按设备分派 |
| `vendor/swiftvr/swiftvr/io.py:18` | 模块顶层 `import decord` | 不改 vendor：在 runner 导入 swiftvr 前注入空的 `decord` 模块（D7） |
| `vendor/swiftvr/.../transformer.py:585` | 已有 `torch.backends.mps.is_available()` 分支（RoPE 用 float32） | 上游已兼容 |

## E. 打包与工具链（阶段 5）

| 位置 | 现状 | Mac 处理 |
|---|---|---|
| `ui/package.json` `build.win`、`dist` 脚本里的 `--win dir` | 只有 Windows target | 新增 `build.mac`（target `dir`，`icon` 指 1024 px PNG）与 `dist:mac` 脚本 |
| `ui/package.json` `extraFiles` 过滤器 | `python/Lib/site-packages/...` 是 Windows 布局 | Mac 布局为 `python/lib/python3.12/site-packages/...`；排除 `torch/include` 等的规则同步改 |
| `ui/scripts/check-dist.mjs:19-45,78-90` | 关键文件表全是 `.exe` / `.dll` / Windows 路径；"产物不旧于源码"按 MSBuild 布局 | 按 `process.platform` 分两张表；Mac 检查 `video2x`、`libvideo2x.dylib`、`ffmpeg`、`python/bin/python3`、MoltenVK ICD 等 |
| `build_video2x.ps1`、`find_port.ps1` | PowerShell 构建 / 端口脚本 | 新增 `scripts/macos/build-core.sh`（cmake 配置 + 构建） |
| `ui/build/icon.ico`、`icon.png`（256 px） | — | 用 `ui/build/gen_icon.py` 重出 1024 px PNG，electron-builder 会自动转成 icns |
| `engine-python/python/`（嵌入式 CPython，不在 git 里） | Windows embeddable + pip 安装的依赖 | 依赖清单见 `engine-python/requirements-macos.txt`；Windows 实际环境锁定在 `requirements-windows-lock.txt` |
| `engine-python/swiftvr-libs/`（不在 git 里） | `pip --target` 装的 diffusers 0.36 + decord（Windows 二进制） | Mac 只装 `diffusers==0.36.0`（decord 走 D7） |

## F. 文档

| 位置 | 处理 |
|---|---|
| `README.md`、`COMPLIANCE.md`、`NOTICE`、`WEIGHTS_LICENSES.md` | 补 macOS 运行与分发说明；顺手把 COMPLIANCE 里"FFmpeg LGPL-2.1"更正为实际的 GPL v3 构建（见 01 §6）；Mac 包随附的 MoltenVK（Apache 2.0）、Vulkan Loader（Apache 2.0）、python-build-standalone（PSF 等）要写进 NOTICE |
