# 模型权重许可清单（WEIGHTS_LICENSES）

本文件逐个列出本项目使用/分发的模型权重及其许可条款，用于判断"能否随便携包分发"。
代码许可见根目录 `NOTICE`；各 vendor 代码的许可证全文见 `engine-python/vendor/*/LICENSE*`。

最后核实日期：2026-07-30

## 总览表

| 权重 | 位置 | 来源 | 许可 | 可随包分发？ |
|---|---|---|---|---|
| Real-ESRGAN ncnn（含 nomos8k、realwebphoto 等 7 个模型） | `models/realesrgan/` | [xinntao/Real-ESRGAN-ncnn-vulkan](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan) | MIT | ✅ 是 |
| Real-CUGAN ncnn（se / pro / nose） | `models/realcugan/` | [nihui/realcugan-ncnn-vulkan](https://github.com/nihui/realcugan-ncnn-vulkan)（上游 bilibili Real-CUGAN） | MIT | ✅ 是 |
| RIFE ncnn（v2.x–v4.x 共 14 个版本） | `models/rife/` | [nihui/rife-ncnn-vulkan](https://github.com/nihui/rife-ncnn-vulkan)（上游 hzwer RIFE） | MIT | ✅ 是 |
| SPAN ncnn 模型 | `models/span/` | ncnn 社区转换版 | 随 ncnn 生态分发，许可见上游仓库 | ✅ 是 |
| RealBasicVSR x4 | `engine-python/weights/realbasicvsr_x4.pth` | [OpenMMLab MMEditing](https://github.com/open-mmlab/mmediting) | Apache 2.0 | ✅ 是 |
| SPyNet（光流辅助权重） | `engine-python/weights/spynet.pth` | 经 OpenMMLab 分发；原始作者 Ranjan & Black（Max Planck） | **仅限非商业与科研用途**；商用须联系 ps-license@tue.mpg.de | ⚠️ 可随包分发用于非商业用途；**若本项目被用于商业场景，须移除此文件**——程序已实测支持缺失时自动改用主权重内嵌的同一组 SPyNet 键（官方 checkpoint 内嵌全部 62 键（与独立文件同一份参数），**输出效果完全一致**，见 `engine-python/worker.py` 与 `vsr_models/realbasicvsr.py`） |
| FlashVSR DiT（streaming_dmd） | `engine-python/weights/FlashVSR-v1.1/diffusion_pytorch_model_streaming_dmd.safetensors` | [OpenImagingLab/FlashVSR](https://github.com/OpenImagingLab/FlashVSR)（HuggingFace: JunhaoZhuang/FlashVSR-v1.1） | Apache 2.0 | ✅ 是 |
| FlashVSR TCDecoder | `engine-python/weights/FlashVSR-v1.1/TCDecoder.ckpt` | 同上 | Apache 2.0 | ✅ 是 |
| FlashVSR LQ 投影 | `engine-python/weights/FlashVSR-v1.1/LQ_proj_in.ckpt` | 同上 | Apache 2.0 | ✅ 是 |
| Wan2.1 VAE | `engine-python/weights/FlashVSR-v1.1/Wan2.1_VAE.pth` | [Wan-Video/Wan2.1](https://github.com/Wan-Video/Wan2.1)（阿里巴巴） | Apache 2.0 | ✅ 是 |
| SeedVR2-3B 权重及配套（neg_emb.pt / pos_emb.pt / configs_3b） | `engine-python/weights/SeedVR2-3B/`、`engine-python/vendor/seedvr2/` | [ByteDance-Seed/SeedVR](https://github.com/ByteDance-Seed/SeedVR)；推理实现 [numz/ComfyUI-SeedVR2_VideoUpscaler](https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler) | Apache 2.0（代码与 3B/7B 权重同许可） | ✅ 是 |

## 结论

- **唯一有商业限制的权重是 SPyNet**（Max Planck 非商业许可）。个人/家庭/科研使用无任何问题；若要商业分发，删除 `engine-python/weights/spynet.pth` 即可——官方 RealBasicVSR 主权重已内嵌全部 62 个 SPyNet 键（同一组权重），程序检测到文件缺失会自动改用内嵌键，**输出效果完全一致**（该路径已实测验证：CPU 下 `spynet_path=None` 加载成功并打印 `使用主权重内嵌键（62/62）`）。
- 其余全部权重（Real-ESRGAN / Real-CUGAN / RIFE / RealBasicVSR / FlashVSR / Wan2.1 VAE / SeedVR2）均为 MIT 或 Apache 2.0，可自由随便携包分发，包括商业场景。
- **早前"SeedVR2-3B 为非商业许可"的顾虑经复核不成立**：字节跳动官方仓库明确 SeedVR 与 SeedVR2 均为 Apache 2.0，numz 推理实现亦为 Apache 2.0。

## 附：上游许可证全文位置

- `engine-python/vendor/seedvr2/LICENSE` — ComfyUI-SeedVR2_VideoUpscaler（Apache 2.0）
- `engine-python/vendor/flashvsr/LICENSE` — OpenImagingLab/FlashVSR（Apache 2.0）
- `engine-python/vendor/flashvsr/LICENSE.diffsynth` — DiffSynth-Studio（Apache 2.0）
