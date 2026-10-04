# SeedVR2-3B 第二旗舰引擎集成实施方案

> 日期：2026-07-28 ｜ 状态：待评审 ｜ 前置结论：**许可障碍已消除，可以集成**

---

## 1. 许可核实结论（2026-07-28 重新核实）

之前将 SeedVR2-3B 排除的理由是"非商业许可，不可随项目分发"。该信息已过时，本次从三处官方来源重新核实，结论一致：

| 资产 | 来源 | 结果 |
|---|---|---|
| 模型权重 SeedVR2-3B | HuggingFace 官方仓库 `ByteDance-Seed/SeedVR2-3B` README 原文："SeedVR and SeedVR2 are licensed under the Apache 2.0"；元数据 `license:apache-2.0` | **Apache 2.0** |
| 模型权重 SeedVR2-7B | HuggingFace 官方仓库 `ByteDance-Seed/SeedVR2-7B` 元数据 | **Apache 2.0** |
| 推理代码库 | GitHub `ByteDance-Seed/SeedVR`（API `spdx: Apache-2.0`） | **Apache 2.0** |

**结论**：权重与代码均可自由使用、修改、再分发（含商用），仅需在分发包中保留 Apache 2.0 许可文本与版权声明。集成无法律障碍。

---

## 2. 模型定位

| 维度 | SeedVR2-3B（拟集成） | 现有 FlashVSR v1.1 | 现有 RealBasicVSR |
|---|---|---|---|
| 类型 | 单步扩散（对抗后训练） | 单步扩散（DMD 蒸馏流式） | 双向传播循环网络 |
| 强项 | **重度压缩/低质源最强画质**、任意输出分辨率（分辨率不敏感）、老片/磁带源 | 时序一致性标杆、流式长视频 | 稳定无闪烁、最快、许可最干净 |
| 速度 | ~1.2 fps（FP8+优化）/ FP16 更慢 | ~0.6 fps | ~15 fps |
| 显存 | FP8+BlockSwap：8~12GB 可跑；FP16 舒适区 18~24GB | 8GB+ | 8GB 内 |
| 短板 | 极轻度退化可能过锐化；VAE 是高分辨率瓶颈；大运动场景有失败案例 | 长视频极慢、固定 4x/128 对齐裁切 | 重度压缩源重建能力弱于扩散系 |

**定位**：低质/重度压缩源的"画质天花板"档位，与 FlashVSR（时序旗舰）、RealBasicVSR（中坚）互补，不替代。

---

## 3. 权重资产选型

| 文件 | 大小 | 来源 | 说明 |
|---|---|---|---|
| `seedvr2_ema_3b_fp8_e4m3fn.safetensors` | **3.16 GB** | HF `numz/SeedVR2_comfyUI`（社区转换版，ComfyUI 生态事实标准） | **首选**：8GB 显存可跑的关键 |
| `seedvr2_ema_3b_fp16.safetensors` | 6.32 GB | 同上 | 备选（18GB+ 显存追求极限画质） |
| `ema_vae_fp16.safetensors` | 0.47 GB | 同上 | 必需 |
| `pos_emb.pt` / `neg_emb.pt` | KB 级 | 官方 HF `ByteDance-Seed/SeedVR2-3B` | 正负提示词嵌入，必需 |
| ~~官方 `seedvr2_ema_3b.pth`~~ | ~~12.63 GB~~ | 官方 HF | 不采用：含训练态/EMA 冗余，纯推理浪费 9GB 下载与磁盘 |

**下载源**（复用现有资产下载框架，国内镜像优先）：
- 主链：`https://hf-mirror.com/numz/SeedVR2_comfyUI/resolve/main/<file>`
- 备用：`https://huggingface.co/numz/SeedVR2_comfyUI/resolve/main/<file>`
- pos/neg 嵌入：hf-mirror + 官方 `ByteDance-Seed/SeedVR2-3B`
- 校验：下载后记录 size + sha256（首版以 size 校验，SHA 值在首次集成实测时固化进 `ASSETS` 清单）；社区转换版权重额外加"引擎加载验证"（复用 `verify_ckpt.py` 模式）

合计下载量约 **3.6 GB**（FP8 方案），远小于 FlashVSR 的 6.8GB。

---

## 4. 架构设计

### 4.1 总体链路（与现有旗舰引擎同构）

```
UI（处理器选 SeedVR2-3B） → bridge spawn → worker.py --model seedvr2
    → vsr_models/seedvr2_runner.py → vendor/seedvr2/（官方推理代码裁剪版）
    → ffmpeg 解码（本地暂存后） → 分段推理 → ffmpeg 编码 → 输出
```

### 4.2 新增/改动清单

| 模块 | 动作 | 说明 |
|---|---|---|
| `engine-python/vendor/seedvr2/` | 新增 | vendor 官方推理代码，**裁剪 patch**：去除 apex（NVIDIA Linux 专用库，官方仓库甚至随附 linux whl）、flash-attn 硬依赖，注意力走 PyTorch SDPA——此路径与 FlashVSR vendor 时解决的完全一致，有成熟先例 |
| `engine-python/vsr_models/seedvr2_runner.py` | 新增 | 参考 FlashVSR runner：ffmpeg 管道、分段（复用 `--segment`）、进度回调、看门狗复用 `start_decode_watchdog` |
| `worker.py` | 小改 | `--model` choices 加 `seedvr2`；分发到 seedvr2_runner |
| 断点续跑 | 复用 | 宏分片 + `.v2xckpt.json` 指纹机制原样套用（RealBasicVSR 同款） |
| 输出分辨率 | 新增参数 | SeedVR2 分辨率不敏感：支持 `--target-w/--target-h`（默认 4x 长边 128 对齐），这是它区别于 FlashVSR 固定 4x 的优势，UI 暴露"输出倍率/目标长边" |
| bridge `PY_WEIGHTS` / `ASSETS` | 小改 | 加 seedvr2 条目（3 类文件，镜像+校验） |
| UI ProcessorSection | 小改 | 处理器列表加 "SeedVR2-3B（低质源画质天花板）"；FP8/FP16 做成模型下拉两档 |
| `verify_ckpt.py` | 小改 | 支持 seedvr2 加载验证 |

### 4.3 关键技术约束（来自官方与社区实测，必须在 runner 内处理）

1. **batch_size 必须 4n+1**（1, 5, 9, 13…，时序一致性架构）：分段长度按 4n+1 规划，段间用 temporal_overlap 混合，避免接缝
2. **VAE 是高分辨率瓶颈**：1080p+ 输出必须开 VAE encode/decode tiling（tile 512 / overlap 160 起步），否则 23GB 级显存峰值也爆
3. **8GB 显存可行路径**：FP8 权重 + BlockSwap（DiT 块级 CPU↔GPU 换入换出）+ VAE tiling 三件套缺一不可；牺牲约 30~50% 速度
4. **色彩校正**：默认 wavelet，老片源建议 LAB 校正选项（防色偏）
5. **Python/torch 兼容**：官方要求 torch 2.6+、Python 3.12——与便携运行时现状核对，不满足则随集成一并升级（注意别破坏 FlashVSR/RealBasicVSR，回归测试必须跑）

---

## 5. 分阶段实施计划

| 阶段 | 内容 | 预估工作量 |
|---|---|---|
| P0 准备 | 下载 FP8 权重（3.6GB）、研读官方 inference 代码与 numz ComfyUI 实现的差异（后者已解决 Windows 依赖问题，是裁剪蓝本） | 0.5 天 |
| P1 最小可用 | vendor 代码裁剪（去 apex/flash-attn）+ runner 单段跑通 5 秒测试片（本地文件，暂不接入队列） | 1~1.5 天 |
| P2 工程化 | 分段 4n+1 + overlap 混合、VAE tiling、BlockSwap 显存策略、进度回调、看门狗 | 1 天 |
| P3 集成 | worker 分发、断点续跑、bridge 资产清单+自动下载、UI 选项与说明 | 0.5~1 天 |
| P4 回归 | 三引擎（新+FlashVSR+RealBasicVSR）各跑实测片段；便携版全量打包异目录实测 | 0.5 天 |

合计约 **3~4 天**。

---

## 6. 风险与备选

| 风险 | 概率 | 对策 |
|---|---|---|
| 官方代码 Windows 适配坑（apex、flash-attn、triton） | 中 | 以 numz ComfyUI 实现为裁剪蓝本（已验证 Windows 可跑）；SDPA fallback 有 FlashVSR 先例 |
| 8GB 显存实测速度不可接受（社区低显存实测曾见 35s/帧的极端案例） | 中 | FP8+BlockSwap 三件套；实测不达标则把 3B 标为"12GB+ 推荐"，8GB 用户引导至 RealBasicVSR |
| FP8 画质损失可见 | 低 | FP8 仅影响约 1~2% 指标，社区共识可用；保留 FP16 下载选项 |
| 便携包体积再增 3.6GB（总 ~17GB） | 确定 | 权重不随包，走首次使用时自动下载（框架已就绪）；或出"完整包/精简包"双版本 |
| torch 升级破坏现有引擎 | 低 | P4 回归兜底；必要时锁定现 torch 版本做兼容 patch |

---

## 7. 预期效果（基于官方与社区公开数据，集成后需实测校准）

- 8GB 显存（FP8+优化）：**0.5~1.2 fps**，约 FlashVSR 的 1~2 倍；5 分钟 24fps 片段（7200 帧）约 1.7~4 小时
- 24GB 显存（FP16）：官方演示级画质，低质源细节重建显著优于现有三引擎
- 2 小时长片仍不推荐（任何扩散引擎都是天数级），由 precheck 拦截引导

---

## 8. 决策点（请确认）

1. **权重方案**：默认 FP8（3.6GB 下载），FP16 作为"高画质档"可选下载 —— 同意？
2. **是否随包**：建议不随包、首次使用时自动下载（便携包不再膨胀）—— 同意？
3. **排期**：按 P0→P4 顺序做，还是只做 P1 先验证画质/速度再决定全量投入？（建议后者，风险最低）
