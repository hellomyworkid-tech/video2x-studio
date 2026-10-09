# macOS 移植验收清单

## 对比方法

Windows 参考输出在 `testdata/reference-windows/`，确切命令见同目录的 `commands.md`。

1. 在 Mac 上用**相同参数**重跑，替换规则如下，输出放进 `testdata/mac/`，文件名与参考输出一致：
   - `video2x` → `build-macos/video2x`
   - `python` → `engine-python/.venv/bin/python`
   - `--device cuda:0` → `--device mps`
   - `-d 0` 不变
2. 批量对比：

   ```bash
   bash scripts/macos/compare.sh --all testdata/mac
   ```

   单个文件：`bash scripts/macos/compare.sh <Mac 输出> <参考输出>`。

3. 判定标准：尺寸与帧数必须完全一致（RIFE ×2 为 143 帧），PSNR 按下表逐文件判定，表与 `compare.sh` 里的 `thresholds()` 同步。

**阈值怎么定的。** 每个阈值都必须高于"最接近的错误结果"的 PSNR，否则模型用错、降噪没生效这类问题会被当成通过。"错误结果"一列是在 Windows 参考集内两两比较实测的。例如降噪开与关之间只差 44.6 dB，所以降噪的阈值定在 47。

| 参考文件 | 平均 ≥ | 单帧 ≥ | 错误结果实测 |
|---|---|---|---|
| `B_lanczos_x2` | 45 | 40 | 与 SPAN 输出比 39.7 |
| `B_lanczos_denoise` | 47 | 42 | 降噪没生效（与 `B_lanczos_x2` 比）44.6，**最紧** |
| `B_lanczos_stab` | 24 | 17 | 防抖没生效 18.8（Mac 上按平台差异从 30/24 下调，见下文） |
| `B_animevideov3_x2`、`B_nomos8kcompact_x2` | 42 | 38 | 两个模型互换 36.6 |
| `B_realcugan_se_x2`、`B_span_x2` | 43 | 39 | 换成 animevideov3 / Lanczos 39.7 |
| `B_anime4k_a` | 42 | 38 | 换成 Lanczos 38.1 |
| `B_rife426_x2fps` | 38 | 32 | 未校准（重点看帧数与人工抽查插帧） |
| `B_swiftvr`、`A_swiftvr_2k` | 38 | 32 | 换成 Lanczos 33.5；换成 SeedVR2 31.8 |
| `B_seedvr2_960` | 38 | 32 | 换成 Lanczos 35.2 |
| `B_realbasicvsr` | 38 | 32 | 未校准 |

如果 Mac 上某项正确实现的结果也只略高于阈值，或低于阈值：

- 先人工对比画面，再判断原因：平台数值差（例如 swscale 的 ARM 与 x86 SIMD 并非逐位一致），还是确实有问题。
- 确属平台差异时可以下调阈值，但必须仍高于"错误结果"一列，并把理由写进提交说明。

**已下调的阈值：`B_lanczos_stab`（2026-10-09，M5 Max）**

- Mac 结果：平均 26.3 dB、最低 18.6 dB，低于原阈值 30/24。
- 防抖确实生效：Mac 上防抖开与关之间是 14.5～19.4 dB，与 Windows 的 14.9～19.4 dB 几乎重合。
- 画面内容一致，只是取景变换不同：对 Mac 与 Windows 的同一帧拟合仿射变换后，PSNR 回到 43.7～45.4 dB（正常编码噪声）。差别是统一约 1.4% 的缩放，以及个别帧最多 32 px 平移、1.7° 旋转。
- 原因：Homebrew 的 libvidstab 1.1.2 在 ARM 上走纯 C 实现，Windows 为 x86 构建，运动估计的结果不同，平滑后的镜头路径与自动缩放随之不同。Mac 上三次重跑输出逐字节相同（确定性）。
- 防抖效果不比 Windows 差：用相位相关测相邻帧平均位移，原片 5.23 px，Windows 防抖后 3.82 px，Mac 防抖后 3.47 px。
- 新阈值 24/17 仍比"防抖没生效"的 18.8 高 5 dB 以上。

为什么不要求逐位一致：

- 两边的 FFmpeg / x264 版本不同。
- GPU 浮点实现不同（MoltenVK 对 CUDA、MPS 对 CUDA）。
- Windows 上的 SwiftVR 用了 FP8 计算。
- 同一台 Windows 机器上，编码后的重跑噪声本身就在 45 dB 上下。

**判断异常的规律**：

- 若所有帧都在 20～30 dB，通常是帧错位（时间戳或分段对齐问题），不是数值误差。
- 只有个别帧偏低、其余正常，通常是分段边界或末尾补帧的问题（Windows 上最后 4 帧本来就偏低）。

## 阶段 0：环境

- [x] `scripts/macos/doctor.sh` 输出已贴进会话，并据此确认芯片、统一内存档位（01 文档 §2）——M5 Max / 36 GB，最高档
- [x] `engine-python/tests/test_resolve_device.py` 通过（7/7）

## 阶段 1：C++ 核心

- [x] `build-macos/video2x -l` 列出 MoltenVK 设备
- [x] 参考集中 `B_lanczos_x2`、`B_lanczos_denoise`、`B_lanczos_stab` 达标（48.6 / 48.9 / 26.3 dB，防抖按下调后的阈值）
- [x] `B_animevideov3_x2`、`B_nomos8kcompact_x2`、`B_realcugan_se_x2`、`B_span_x2` 达标（45.9 / 43.1 / 46.8 / 45.5 dB）
- [x] `B_rife426_x2fps` 帧数 143，并且达标（44.4 dB）
- [x] VFR 回归：拿一个可变帧率片段跑 Lanczos，输出时长与源一致（误差 < 0.1 s），音画同步——10 s 片段（30fps 与 10fps 交替）输出时长、帧数、首末帧时间戳、帧间隔分布均与源一致，音轨 10.000 s
- [x] 失败路径：输入不存在、模型名错误时，退出码为 1，而不是 139（段错误）——输入不存在为 1；模型名错误为参数解析失败，`main` 返回 -1（POSIX 上显示为 255，Windows 上为 -1，同一代码路径），都不是段错误
- [x] 跑完没有残留进程

## 阶段 2：bridge + 界面（`npm run dev` 与 `npm run desktop`）

- [ ] 选择文件对话框：多选；中文和带空格的路径
- [ ] 每个 ncnn 处理器各提交一个任务：进度、速度、剩余时间正常刷新
- [ ] 在检查点暂停 → 恢复（Python 引擎）；真暂停（挂起）→ 解冻，并且看门狗不误杀
- [ ] 中止：子进程树全部退出（`pgrep` 确认）
- [ ] "打开所在文件夹"在 Finder 中选中输出文件；"打开日志目录"可用
- [ ] 同名输出自动去重（包括正在运行的任务）
- [ ] 退出程序再打开：任务队列恢复；可续跑的任务能续跑
- [ ] 网络盘（`/Volumes/` 下的 SMB）输入：触发本地暂存
- [ ] 编码器下拉框在 Mac 上显示 VideoToolbox 选项；`hevc_videotoolbox` 出片，质量参数生效（换不同的 `q:v`，体积会变）
- [ ] 资产下载：断点续传与镜像回退可用

## 阶段 3：PyTorch 引擎（MPS）

- [ ] `B_realbasicvsr` 达标
- [ ] `B_swiftvr`、`A_swiftvr_2k`（统一内存允许的话）达标；`A20.mp4`（480 帧、两个宏分片）帧数为 480，分片边界无跳帧
- [ ] `B_seedvr2_960` 达标（fp16 DiT）
- [ ] 断点续跑：运行中 `kill -9` worker，重新提交后从检查点继续，最终帧数正确
- [ ] OOM / 内存上限：用超大 `--clip-len` 触发，能按 4 的倍数递减重试并完成，不会陷入换页
- [ ] 日志里没有 MPS 回退 CPU 的警告；如有，记录是哪个算子
- [ ] 把 Mac 实测的速度、内存峰值写进 `docs/reports/`（与 Windows 数据并列），并更新界面说明与预检估算

## 阶段 4：Anime4K / HDR

- [ ] `B_anime4k_a` 达标
- [ ] `--hdr` 输出带正确的 HDR 元数据（`ffprobe` 能看到 `color_transfer=smpte2084` 或 `arib-std-b67`）

## 阶段 5：打包

- [ ] `npm run dist:mac` 通过 `check-dist`（Mac 关键文件表）
- [ ] 拷到另一个用户账户或另一台 Mac：清除隔离属性后首次启动即可用，ncnn 与 PyTorch 引擎都能出片
- [ ] 包内不依赖 Homebrew：临时把 `/opt/homebrew` 改名后运行验证；或用 `otool -L` 检查所有 dylib 都指向包内

## 阶段 6：文档

- [ ] README / CHANGELOG / NOTICE / COMPLIANCE 补上 macOS 内容（含 MoltenVK、Vulkan Loader、python-build-standalone 的许可）
- [ ] 本目录文档按实际做法修订（特别是 03-setup.md 里没实测过的命令）
