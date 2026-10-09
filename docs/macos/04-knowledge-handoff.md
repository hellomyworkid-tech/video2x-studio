# 项目知识交接（Windows 阶段积累）

> 这份文档把 Windows 开发期间在会话里形成、但代码注释里不完整的知识集中写下来。
> 更早的完整分析在 `docs/reports/`（代码审查报告 1～6、性能与选型分析、SeedVR2 集成方案、短剧素材选型实测）；
> 变更历史见 `CHANGELOG.md` 与 `git log`。

## 1. 架构一图

```
Electron 主进程 (ui/electron/main.cjs)
  └─ import bridge (ui/server/bridge.mjs)  ── HTTP + SSE，127.0.0.1:7199，同时托管 ui/dist 静态页
        ├─ spawn  video2x CLI（C++，tools/video2x + libvideo2x）
        │     处理器：lanczos / libplacebo(Anime4K) / realesrgan / realcugan / rife / span
        │     增强：--stab（vidstab 两遍）/ --denoise / --hdr；ncnn 走 Vulkan
        └─ spawn  engine-python/worker.py（PyTorch 旗舰引擎）
              --model realbasicvsr | seedvr2 | swiftvr
              ffmpeg 管道读帧（rawvideo rgb24）→ 推理 → ffmpeg 管道编码 → 宏分片 → 合并并带回音轨/字幕
React 前端 (ui/src) 只与 bridge 通信；lib/args.ts 负责把表单转成 CLI / worker 参数
```

- Electron 启动时先探测 7199：已有健康的 bridge 就直接复用，避免重复监听导致崩溃。
- 退出前 `shutdownBridge()` 强杀所有子进程树。
- `npm run dev` 会同时起 bridge 和 vite（端口 3000）；也可以单独 `npm run bridge`。
- 冒烟测试惯例：用 `BRIDGE_PORT=7299` 另起一个 bridge，不干扰正在用的程序；测完必须关掉。

## 2. 进程间协议（移植时不要改语义）

**进度行**
- CLI 与 worker 都按这个格式输出到 stdout：`frame=N/T (P%); fps=F; elapsed=HH:MM:SS; remaining=HH:MM:SS`。
- bridge 用 `PROGRESS_RE` 解析（`bridge.mjs` 约 731 行）。
- worker 的普通日志行以 `[worker] ` 开头。

**worker 退出码**

| 退出码 | 含义 |
|---|---|
| 0 | 完成 |
| 1 | 失败（`fail()`，中文原因写在最后一行） |
| 3 | 看门狗判定挂死：管道或推理 300 s 无进展，60 s 起警告 |
| 4 | 按请求在检查点暂停 |

**旗标文件**（都放在输出文件旁边）

| 文件 | 作用 |
|---|---|
| `<out>.v2xpause` | bridge 请求"在检查点暂停"。worker 在宏分片边界看到后删除旗标，并以退出码 4 退出 |
| `<out>.v2xsuspended` | bridge 正在冻结整个进程树（Windows 上是 NtSuspendProcess）。旗标存在期间，看门狗不计时 |
| `<out>.v2xckpt.json` | 检查点：`{nextFrame, fp}`。`fp` 是参数指纹，包含模型、编码器、CRF、码率、像素格式、输出尺寸、输入路径/大小/mtime、帧率、总帧数、分片长度。指纹不一致时清理旧分片并从头跑 |
| `<out>.segNNNNNN.mp4` | 宏分片（默认 240 帧一片）。全部完成后用 concat 合并，并从源文件流复制音轨/字幕（`merge_with_source`） |

**bridge 的其余约定**
- 持久化：任务队列写在 `cache/jobs.json`（重启 / 崩溃后可恢复）。
- 日志：`cache/logs/bridge-YYYYMMDD.log`，保留 7 天。
- API 路由：`grep -oE "route === '[A-Z]+ /api/[^']+'" ui/server/bridge.mjs` 可列出全部。主要有 `/api/health`、`/api/devices`（Vulkan）、`/api/cuda-devices`、`/api/assets`（权重下载，带镜像回退和断点续传）、`/api/jobs*`（提交、预检、暂停、挂起、恢复、中止、打开文件夹）、`/api/events`（SSE）。

## 3. 必须保持的不变量（都是踩坑换来的）

**时间戳（C++ 核心）**
- 帧在整条滤镜链上携带 `AVFrame::time_base`。编码器是输出 PTS 的唯一负责者，并保证单调递增。
- 默认保留源时间戳，保证可变帧率（VFR）音画同步；`--recalculate-pts` 才按帧序号重写成 CFR。
- 旧实现按"帧号 ÷ 名义帧率"重写，60 s 的 VFR 片子结尾会短 10 s。
- RIFE 插出的帧的 PTS = `p0 + (p1-p0)*time_step`；插帧时间基 = 解码时间基 ÷ 倍数，VFR 上也能精确。

**色彩（Python 引擎）**
- rgb24 → yuv 一律按 BT.709，并写入色彩标签（`encode_color_args()`）。
- 旧实现默认走 BT.601 且不打标签，颜色偏差可达 22/255。

**VFR（Python 引擎）**
- 解码时按平均帧率重采样（`decode_cfr_args()`），否则宏分片编号与帧数对不上，每段跳帧、最多漂移 1.66 s。

**码率与 CRF 互斥**
- x264/x265 同时收到两者时，以 CRF 为准、静默丢掉码率。
- UI 以 Mbps 输入，设了码率就只发码率。

**ncnn GPU 实例**
- 必须在所有退出路径上销毁（RAII 守卫），否则 CLI 以段错误 139 退出，而不是 1/2。

**防抖**
- libvidstab 在极小帧（实测 352×64）上会内存越界，现在要求输入 ≥128×128。

**设备编号**
- Vulkan 序号（ncnn CLI 的 `-d`）与 CUDA 序号（worker 的 `--device cuda:N`）是两套编号，核显机上必然错位，不能混用。
- 调度时统一换算成"显卡名#同名序号"（`physicalGpuKey`）：同一张物理卡串行，多卡并行，识别不了的任务独占执行。
- Mac 上要把 MoltenVK 设备与 MPS 映射到同一个键（01 文档 D8）。

**输出命名**
- 默认模板 `{name}_{proc}.{ext}`。同名去重要把正在运行的任务算进去，否则会互相覆盖，甚至抹掉暂停任务的检查点。

**权重校验**
- Python 运行时缺失时，跳过"加载验证"，不要把"验证失败"误判为文件损坏而删掉权重（出过这个事故）。

**打包**
- `ui/scripts/check-dist.mjs` 在打包前后核对关键文件，以及 C++ 产物是否旧于源码。
- 起因：另一台电脑拿到"只有 Electron 外壳"的包，引擎全红、开始按钮不可用。
- 同时加了安装完整性红条（`installStatus()`）：缺程序文件时不再引导用户去下载权重。

## 4. 各引擎要点

**RealBasicVSR**（`vsr_models/realbasicvsr.py` + `worker.py`）
- 已去掉 mmcv / mmengine 依赖，纯 PyTorch。
- 显存够时整帧推理，放不下自动退化为空间分块（实测画质降约 1.6 dB）。
- `spynet.pth` 是 Max Planck 非商业许可：商用分发要删掉它。缺失时自动改用主权重内嵌的同一组 SPyNet 参数（见 COMPLIANCE.md）。

**SeedVR2-3B**（`vsr_models/seedvr2_runner.py` + `vendor/seedvr2`，numz 的 ComfyUI 实现，diffusers 0.33）
- 权重：FP8 DiT + fp16 VAE。
- 16 GB 显卡的策略：BlockSwap 8 块、VAE 分块 768、批大小 5（4n+1）。
- 960p 每 5 帧的阶段耗时：编码 1.88 s、DiT 1.88 s、解码 4.4 s；VAE 占约 76%。
  - 批大小改 21：DiT 每帧快 39%，但 VAE 解码超显存（峰值 16.6 GB），总体反而慢。
  - VAE 不分块：直接溢出，解码慢 5 倍。
  - 所以现行参数就是 16 GB 上的最优解。
- `cudnn.benchmark` 只在 encode 阶段打开（decode 打开反而慢）；首批会多花约 20 s 自动调优。
- 注意力：装了 SageAttention 2 且自检通过就用它（DiT 快 3%）；`V2X_SEEDVR2_ATTN` 可强制指定。

**SwiftVR**（`vsr_models/swiftvr_runner.py` + `vendor/swiftvr`，上游未修改，diffusers 0.36 装在 `swiftvr-libs` 覆盖层）

权重：
- 仅权重 FP8：Linear 按输出通道缩放，存成 `float8_e4m3fn`。
- QKV 预融合，删掉不再使用的投影副本：权重常驻约 5 GB（官方 bf16 是 12 GB）。
- 预转换文件 `swiftvr_transformer_fp8.safetensors` 由 `--convert-fp8` 从官方权重生成。

计算：
- sm_89+ 显卡上，矩阵乘直接走 FP8 张量核（激活按张量动态量化）。sm_120 上 `_scaled_mm` 只支持张量级缩放，按通道的权重缩放在输出端补乘。
- `V2X_SWIFTVR_FP8_COMPUTE=0` 可以关闭。

流式与分段：
- ReAE 时间维 4 倍压缩、首段裁 3 帧，因此输出第 i 帧对应输入第 i 帧。
- 每个宏分片多解码 8 帧作为上下文（输出时丢弃）；末尾补 3 帧重复帧后 flush。
- 分段长度必须是 4 的倍数。OOM 时按 48→24→12→8→4 递减重试（以前 12 减半成 6 会崩）。

内存与 I/O：
- Windows 用 `set_per_process_memory_fraction` 限制显存：超了就报 OOM，而不是被驱动挪到共享内存、慢几十倍。Mac 上统一内存换页是同类问题。
- 读帧、写编码器各占一个后台线程，与 GPU 推理重叠。看门狗只由主线程计时。

| 引擎 / 设置 | 实测速度（RTX 5070 Ti） |
|---|---|
| SwiftVR 2560×1440 稳态（最初版本） | 5.3 fps |
| SwiftVR 2560×1440 稳态（后台 I/O 线程） | 5.7 fps |
| SwiftVR 2560×1440 稳态（+ FP8 张量核） | 7.1 fps |
| SwiftVR 纯 GPU（每步 8 帧 1.33 s） | 6.0 fps |
| SeedVR2-3B 960p 稳态 | 约 0.55 fps |
| SeedVR2-3B 2560×1440 | 约 0.25 fps |
| RealBasicVSR，720p 输入 4× | 约 1.4 fps |

- SwiftVR 2K 显存峰值约 13.8 GB。SageAttention 对 SwiftVR 几乎无效：16×16 窗口注意力只占 GPU 时间约 6%。
- 一次性开销：模型加载约 5～9 s；首次 cuDNN 自动调优约 20 s/进程。

| 画质对比 | PSNR |
|---|---|
| FP8 权重 vs bf16 权重 | 49.9 dB |
| FP8 张量核计算 vs bf16 计算（未编码） | 49.7 dB（片段 A）/ 51.3 dB（片段 B） |
| 同上，编码后 | 平均 45.8 dB（同一配置重跑两次的编码噪声也在这个量级） |

- 生成式模型会补出原片没有的细节，对强退化素材收益最大。
- SwiftVR 的帧间稳定性在 AI 方法里最好，接近 Lanczos；实测没有出现 SeedVR2 那样改变脸型的问题。

**ncnn 引擎**
- Real-ESRGAN（含 nomos8k-compact）、Real-CUGAN、RIFE、SPAN：480p→960p 72 帧各约 3 s（含启动）。

## 5. 方法论与工作习惯（Windows 阶段的教训）

- **数据先于结论。** 用户明确要求过"给我确信的结果"。
  - 测速要扣掉启动开销看稳态（从日志里的 `frame=… elapsed=…` 推算），并说明测试条件。
  - 画质用 PSNR（ffmpeg `psnr` 滤镜；逐帧统计时把 `inf` 当成逐位相同单独计数，不能当 0 平均）。
- **孤儿进程。**
  - 曾经后台残留的 GPU 进程吃满内存，导致"66 W 功耗"之类的测速结论作废并撤回。
  - 跑完必须确认没有 python / ffmpeg / video2x 残留；Mac 上用 `pgrep -fl`。
- **静默降速陷阱。** 显存溢出到系统内存、MPS 算子回退 CPU、统一内存换页：都不报错只变慢。看到速度异常，先查这些。
- **脚本写成文件再执行。** bash heredoc 里的反斜杠、长脚本被改坏过多次。
- **用户偏好。**
  - 用户用中文交流。
  - 改完通常要求"打包给我测试"。
  - 诊断问题时如果说"不要改代码"，就只给结论不动代码。
  - 重视真实测量和诚实的负面结论（例如"SageAttention 没带来提速"要如实说明并给出原因）。
- **提交。** 中文提交说明，结尾加 Co-Authored-By 行。每个相对独立的改动单独提交。
- **国内网络。** npm、Electron 用 npmmirror；权重优先 hf-mirror.com；pip 可用清华源。

## 6. 测试资产

迁移包 `testdata/`（恢复后在仓库根的 `testdata/`，已在 .gitignore 中）：

- `inputs/A.mp4`：1280×720，72 帧
- `inputs/B.mp4`：854×480，72 帧
- `inputs/A20.mp4`：1280×720，480 帧（用于跨宏分片的长测）
- `reference-windows/`：每个引擎一份参考输出，配 `commands.md`（确切命令、耗时、帧数）和各自的日志。Mac 移植的验收以它们为基准，方法见 [05-acceptance.md](05-acceptance.md)。

单元测试：

```bash
engine-python/.venv/bin/python engine-python/tests/test_resolve_device.py
```

设备字符串归一化，Mac 上要补 `mps` 用例。
