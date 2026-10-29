# macOS（Apple Silicon）RealBasicVSR 与 SeedVR2 实测报告

> 日期：2026-10-29
> 硬件：Mac Studio，Apple M5 Max（32 核 GPU）/ 36 GB 统一内存 / macOS 27.0.1
> 软件：PyTorch 2.14.1（MPS）、Python 3.12.15、Homebrew ffmpeg@7 7.1.5
> 对照：Windows 11 + RTX 5070 Ti 16 GB（`docs/macos/04-knowledge-handoff.md`、`testdata/reference-windows/`）
> SwiftVR 的 Mac 实测见 `macOS-SwiftVR实测报告.md`

## 结论

- **RealBasicVSR：速度与 Windows 相当，画质一致。** 它以卷积为主，没有用到 FP8 之类 N 卡专用加速，M5 Max 不吃亏。
- **SeedVR2：能出片，画质与 Windows 一致，速度约为 Windows 的 40%。** 实测 960p 输出约 0.22 fps，Windows 约 0.55 fps，是三个旗舰引擎里最慢的。
- **SeedVR2 在 36 GB 机型上内存偏紧。** 载入模型时有约 31 GB 的瞬时峰值（960p 与 2K 输出相同），24 GB 机型不建议用。实测到 2K 输出（约 0.1 fps），更大的输出未验证；预检会提示。
- **多数情况选 SwiftVR。** 同属生成式修复，960p 输出时 Mac 上 SwiftVR 约 6.9 fps，是 SeedVR2 的 30 倍左右。

## RealBasicVSR

| 输入 → 输出 | 帧数 | Mac M5 Max | Windows RTX 5070 Ti |
|---|---|---|---|
| 854×480 → 3416×1920（`B_realbasicvsr`） | 72 | 总耗时 38.3 s（端到端 2.0 fps，载入 1 s） | 总耗时 39 s |
| 1280×720 → 5120×2880 | 72 | 端到端 1.44 fps（稳态 1.84 fps） | 端到端约 1.4 fps（720×1280） |

- 内存峰值：854×480 输入 11.2 GB；720p 输入 17.3 GB。
- 显存自适应在 MPS 上读 `recommended_max_memory`（本机 28.1 GB），分块参数（tile 768、时间分块 24）与 16 GB 卡相同，输出可以直接和 Windows 参考对比。
- fp16：与 CUDA 相同，主体 fp16 + autocast，SPyNet 光流保持 fp32。
- 与 Windows 参考比对：平均 43.36 dB，最低 42.32 dB，达标（阈值 38 / 32）。

## SeedVR2-3B

| 配置（前三行为 1708×960 输出、72 帧） | 总耗时 | 进程内存峰值 | 与 Windows 参考的 PSNR |
|---|---|---|---|
| VAE 编码不分块、解码 1024 分块（按容量自动分档会选到这一档） | 369 s | 38.2 GB（超过物理内存，系统换页） | 38.73 dB |
| **编解码都按 768 分块（Mac 默认）** | **327 s** | **30.8 GB** | **39.03 dB** |
| Windows：BlockSwap 8 块、编解码 768 分块 | 164 s | 显存约 16 GB | — |
| 2560×1440 输出（A 片段前 21 帧，Mac 默认配置） | 209 s（约 0.10 fps） | 31.4 GB | —（无 2K 参考输出） |

各阶段耗时（768 分块，41 帧共 9 批，vendor 的 `--debug` 日志）：

| 阶段 | Mac 每批 | Windows 每批 | 倍数 |
|---|---|---|---|
| VAE 编码 | 4.7 s | 1.88 s | 2.5 |
| DiT | 5.1 s | 1.88 s | 2.7 |
| VAE 解码 | 10.4 s | 4.4 s | 2.4 |

- **权重：** MPS 不支持 FP8，用官方 fp16 DiT（`seedvr2_ema_3b_fp16.safetensors`，6.8 GB）。vendor 载入时在 CPU 上转成 bf16 再搬上 GPU。
- **内存峰值是瞬时的：** 实际分配在 VAE 阶段不到 1 GB，DiT 阶段约 7 GB（主要是权重）。约 30 GB 的峰值出现在 DiT 载入那一刻：CPU 上的 fp16 与 bf16 两份副本，加上 VAE 阶段留下的约 11 GB 缓存。
- **为什么 Mac 固定 768 分块：** 统一内存与系统共用。按 28 GB 上限自动分档会选"编码不分块"，结果更慢、更占内存，与 Windows 参考也更远。
- **系统态 CPU 时间偏高（约 70 s）：** vendor 在每次 VAE 编码 / 解码调用后执行 `torch.mps.empty_cache()`，用来规避 PyTorch 的 MPS 内存泄漏（pytorch#155060）。分块后每块都会清一次缓存、再重新申请内存。这是上游的取舍，vendor 未修改。
- **BlockSwap：** vendor 在 macOS 上自动禁用（统一内存下没有意义）；注意力只有 PyTorch 原生 SDPA。

## 顺带发现并修复：vendor 代码缺文件

`.gitignore` 第 2 行的 `data/`（与此前的 `models/` 同类问题）没有前导 `/`，把 `engine-python/vendor/seedvr2/src/data/`（4 个图像变换模块）也忽略了，Windows 打包的 git 仓库里没有这些文件，SeedVR2 一启动就报 `No module named 'src.data'`。已从上游锁定版本（numz @ baec4b6）补回，规则改为 `/data/`。两个 vendor 包的全部模块（SeedVR2 38 个、SwiftVR 10 个）现在都能导入。
