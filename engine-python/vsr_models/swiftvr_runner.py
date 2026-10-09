# -*- coding: utf-8 -*-
"""SwiftVR（单步生成式流式视频修复，Wan2.2-TI2V-5B 底座）runner。

推理核心为 engine-python/vendor/swiftvr（H-oliday/SwiftVR，Apache 2.0）。它依赖
diffusers 0.36 的新接口，而 SeedVR2 依赖 0.33——两者不能共存于同一 site-packages，
因此 diffusers 0.36 与 decord 装在独立覆盖层 engine-python/swiftvr-libs，仅本进程
把它排在 sys.path 最前；torch / numpy 等仍复用主环境。

显存：50 亿参数 bf16 权重约 10 GB，16 GB 卡上留给推理的余量不足以输出 2K。这里做
仅权重 FP8（Linear 按输出通道缩放存 float8_e4m3fn，前向逐层还原为 bf16），并在融合
QKV 后删掉不再使用的原始投影层，权重常驻约 5 GB。

帧对齐：ReAE 编码时间维 4 倍压缩，解码首段裁掉 3 帧，使输出第 i 帧对应输入第 i 帧；
每个宏分片末尾补 3 帧重复末帧再 flush，把解码器里滞留的尾帧推出来。

断点续跑、色彩（BT.709）、可变帧率（解码按平均帧率重采样）、音频/字幕合并与
RealBasicVSR / SeedVR2 共用 worker.py 的同一套协议与工具函数。
"""

import glob
import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

import numpy as np

ENGINE_DIR = Path(__file__).resolve().parent.parent
VENDOR_DIR = ENGINE_DIR / 'vendor' / 'swiftvr'
LIBS_DIR = ENGINE_DIR / 'swiftvr-libs'
# V2X_SWIFTVR_WEIGHTS：指向另一份权重目录（调试 / 转换 FP8 时用）
WEIGHTS_DIR = Path(os.environ.get('V2X_SWIFTVR_WEIGHTS') or ENGINE_DIR / 'weights' / 'SwiftVR')
FP8_FILE = WEIGHTS_DIR / 'swiftvr_transformer_fp8.safetensors'

# 覆盖层必须排在最前：本进程内 diffusers 解析为 0.36
for p in (str(ENGINE_DIR), str(VENDOR_DIR), str(LIBS_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

# vendor 的 swiftvr/io.py 在模块顶层 import decord，但本项目用 ffmpeg 管道读帧，从不调用它。
# decord 没有 macOS arm64 + Python 3.12 的 wheel：缺失时放一个空模块占位，不改 vendor 代码
try:
    import decord  # noqa: F401
except ImportError:
    import types
    sys.modules['decord'] = types.SimpleNamespace(bridge=types.SimpleNamespace(set_bridge=lambda *a, **k: None))

from worker import (probe, fmt_hms, log, fail, FFMPEG, start_decode_watchdog,  # noqa: E402
                    pause_requested, resolve_device, validate_cuda_device, quality_args,
                    decode_cfr_args, encode_color_args, merge_with_source, sageattn_selftest,
                    is_oom_error, empty_device_cache, device_allocated_gb)

FP8_MAX = 448.0          # float8_e4m3fn 可表示的最大值
FP8_MIN_PARAMS = 1 << 20  # 参数量不足此值的 Linear 保持原精度（省不了多少显存，最影响数值）
# 矩阵乘直接走 FP8 张量核（激活也按张量量化为 FP8）：Ada/Hopper/Blackwell 上默认开启，
# 由 load_pipeline 探测后设置。V2X_SWIFTVR_FP8_COMPUTE=0 强制关闭（回到 bf16 计算）
FP8_COMPUTE = False


# ---------------------------------------------------------------------------
# 仅权重 FP8
# ---------------------------------------------------------------------------

def _fp8_linear_cls():
    import torch
    import torch.nn as nn
    import torch.nn.functional as F

    class FP8Linear(nn.Module):
        """权重以 float8_e4m3fn + 按输出通道缩放存储，前向时还原为激活的精度。"""

        def __init__(self, in_features, out_features, bias, dtype, device=None):
            super().__init__()
            self.in_features, self.out_features = in_features, out_features
            self.register_buffer('w8', torch.empty(out_features, in_features,
                                                   dtype=torch.float8_e4m3fn, device=device))
            self.register_buffer('scale', torch.empty(out_features, 1, dtype=dtype, device=device))
            self.bias = nn.Parameter(torch.empty(out_features, dtype=dtype, device=device)) if bias else None

        @torch.no_grad()
        def set_weight(self, w):
            scale = (w.abs().amax(dim=1, keepdim=True).float() / FP8_MAX).clamp_(min=1e-12)
            self.w8.copy_((w.float() / scale).to(torch.float8_e4m3fn))
            self.scale.copy_(scale.to(self.scale.dtype))

        def forward(self, x):
            if FP8_COMPUTE and x.dtype == torch.bfloat16:
                return self._forward_w8a8(x)
            w = self.w8.to(x.dtype) * self.scale.to(x.dtype)
            return F.linear(x, w, self.bias)

        def _forward_w8a8(self, x):
            """激活按张量动态量化为 FP8，直接走 FP8 张量核（sm_120 上 _scaled_mm 只支持张量级缩放，
            权重的按通道缩放在输出端补乘）"""
            shp = x.shape
            x2 = x.reshape(-1, shp[-1])
            lo, hi = torch.aminmax(x2)                # 不像 abs().amax() 那样产生激活大小的临时张量
            sx = (torch.maximum(hi.abs(), lo.abs()).float() / FP8_MAX).clamp_(min=1e-12)
            x8 = (x2 / sx).to(torch.float8_e4m3fn)
            if getattr(self, '_one', None) is None or self._one.device != x.device:
                self._one = torch.ones((), device=x.device)
            y = torch._scaled_mm(x8, self.w8.t(), scale_a=sx, scale_b=self._one, out_dtype=x.dtype)
            s = self.scale.t()
            y = torch.addcmul(self.bias, y, s) if self.bias is not None else y * s
            return y.reshape(*shp[:-1], -1)

    return FP8Linear


def _swap_in_fp8(module, FP8Linear, dtype):
    """把子树里足够大的 nn.Linear 换成 FP8Linear 外壳（meta 设备上只换结构，不分配显存）。"""
    import torch.nn as nn
    for name, child in list(module.named_children()):
        if isinstance(child, nn.Linear) and child.in_features * child.out_features >= FP8_MIN_PARAMS:
            setattr(module, name, FP8Linear(child.in_features, child.out_features,
                                            child.bias is not None, dtype, device='meta'))
        else:
            _swap_in_fp8(child, FP8Linear, dtype)


def _fuse_projections_fp8(transformer, FP8Linear, dtype):
    """在 FP8 下融合 QKV，并删掉不再使用的原始投影层（与 WanAttention.fuse_projections
    等价）。按输出通道缩放的 FP8 权重按行拼接，结果与"先融合再量化"逐位一致；
    全程不需要 bf16 全量副本，meta 与真实张量上都可执行。
    融合后自注意力只用 to_qkv，交叉注意力用 to_q + to_kv——原实现保留原始层不删，
    多占约 14 亿参数。"""
    import torch
    import torch.nn as nn
    from swiftvr.models.transformer import WanAttention
    for m in transformer.modules():
        if not isinstance(m, WanAttention) or getattr(m, 'fused_projections', False):
            continue
        if getattr(m, 'added_kv_proj_dim', None) is not None:
            raise RuntimeError('暂不支持带 added_kv 投影的配置')
        self_attn = m.cross_attention_dim_head is None
        names = ('to_q', 'to_k', 'to_v') if self_attn else ('to_k', 'to_v')
        parts = [getattr(m, n) for n in names]
        if not all(isinstance(x, FP8Linear) for x in parts):
            raise RuntimeError('融合前投影层必须已是 FP8')
        fused = FP8Linear(parts[0].in_features, sum(x.out_features for x in parts), True, dtype,
                          device=parts[0].w8.device)
        with torch.no_grad():
            fused.w8 = torch.cat([x.w8 for x in parts])
            fused.scale = torch.cat([x.scale for x in parts])
            fused.bias = nn.Parameter(torch.cat([x.bias for x in parts]), requires_grad=False)
        setattr(m, 'to_qkv' if self_attn else 'to_kv', fused)
        for n in names:
            delattr(m, n)
        m.fused_projections = True


def build_fp8_transformer(dev, dtype, log_fn):
    """构造已融合 + 仅权重 FP8 的 transformer，权重常驻约 5 GB。权重来源二选一：
    - 预转换文件 swiftvr_transformer_fp8.safetensors（便携包随附，约 5 GB，直接载入）
    - 官方原版 transformer/diffusion_pytorch_model.safetensors（FP32，约 19 GB）：逐张量读入、
      读入即量化，再在 FP8 下融合。全程不生成 bf16 全量副本，显存与内存峰值都很低
    """
    import torch
    from safetensors import safe_open
    from swiftvr.models import WanTransformer3DModel

    cfg = json.loads((WEIGHTS_DIR / 'transformer' / 'config.json').read_text(encoding='utf-8'))
    cfg = {k: v for k, v in cfg.items() if not k.startswith('_')}
    # meta 上构造（不占内存/显存）；默认 dtype 设为计算精度，与官方 .to(bf16) 后的状态一致
    prev_dtype = torch.get_default_dtype()
    torch.set_default_dtype(dtype)
    try:
        with torch.device('meta'):
            tr = WanTransformer3DModel(**cfg)
    finally:
        torch.set_default_dtype(prev_dtype)
    FP8Linear = _fp8_linear_cls()
    _swap_in_fp8(tr.blocks, FP8Linear, dtype)

    if FP8_FILE.exists():
        log_fn(f'载入预转换 FP8 权重：{FP8_FILE.name}')
        _fuse_projections_fp8(tr, FP8Linear, dtype)       # meta 上先融合出与文件一致的结构
        tr = tr.to_empty(device=dev)
        with safe_open(str(FP8_FILE), framework='pt', device=str(dev)) as f:
            keys = set(f.keys())
            state = tr.state_dict()
            missing = [k for k in state if k not in keys]
            if missing:
                raise RuntimeError(f'FP8 权重文件缺少 {len(missing)} 个张量（如 {missing[0]}）')
            with torch.no_grad():
                for k, t in state.items():
                    t.copy_(f.get_tensor(k))
    else:
        src = WEIGHTS_DIR / 'transformer' / 'diffusion_pytorch_model.safetensors'
        if not src.exists():
            raise FileNotFoundError(f'未找到 SwiftVR 权重：{FP8_FILE.name} 或 {src}')
        log_fn('载入官方原版权重（FP32 → FP8，读入即量化，约 1~2 分钟）')
        tr = tr.to_empty(device=dev)
        fp8_mods = {n: m for n, m in tr.named_modules() if isinstance(m, FP8Linear)}
        with safe_open(str(src), framework='pt', device='cpu') as f:
            keys = set(f.keys())
            state = tr.state_dict()
            with torch.no_grad():
                for name, mod in fp8_mods.items():
                    wk, bk = f'{name}.weight', f'{name}.bias'
                    if wk not in keys:
                        raise RuntimeError(f'官方权重文件缺少 {wk}')
                    mod.set_weight(f.get_tensor(wk).to(dev))
                    if mod.bias is not None:
                        mod.bias.copy_(f.get_tensor(bk).to(dev, mod.bias.dtype))
                rest = [k for k in state if not any(k.startswith(n + '.') for n in fp8_mods)]
                missing = [k for k in rest if k not in keys]
                if missing:
                    raise RuntimeError(f'官方权重文件缺少 {len(missing)} 个张量（如 {missing[0]}）')
                for k in rest:
                    state[k].copy_(f.get_tensor(k).to(dev, state[k].dtype))
        _fuse_projections_fp8(tr, FP8Linear, dtype)
    # rope 等非持久缓冲不在 state_dict 里，to_empty 后是未初始化内存，需按配置重算
    _reinit_nonpersistent_buffers(tr, cfg, dev, dtype)
    torch.cuda.empty_cache()
    return tr


def _fuse_projections_linear(transformer):
    """bf16 版的 QKV 融合：用 vendor 的 fuse_projections 拼出 to_qkv / to_kv，再删掉不再使用的
    原始投影层（与 _fuse_projections_fp8 相同的省内存做法）"""
    from swiftvr.models.transformer import WanAttention
    for m in transformer.modules():
        if not isinstance(m, WanAttention) or getattr(m, 'fused_projections', False):
            continue
        if getattr(m, 'added_kv_proj_dim', None) is not None:
            raise RuntimeError('暂不支持带 added_kv 投影的配置')
        m.fuse_projections()
        for n in (('to_q', 'to_k', 'to_v') if m.cross_attention_dim_head is None else ('to_k', 'to_v')):
            delattr(m, n)


def build_bf16_transformer(dev, dtype, log_fn):
    """MPS 用：构造已融合的普通 bf16 transformer，权重常驻约 10 GB。
    MPS 能存 float8_e4m3fn 却不能在设备上转换（实测 torch 2.14："Undefined type Float8_e4m3fn"），
    FP8Linear 的前向还原无法在 MPS 上执行。权重来源：
    - 官方原版 FP32（transformer/diffusion_pytorch_model.safetensors）：直接转 bf16，没有 FP8 量化损失，优先使用
    - 预转换 FP8 文件：在 CPU 上逐层按 FP8Linear 前向的同一算式（w8.to(bf16) * scale）还原，再搬上设备
    """
    import torch
    import torch.nn as nn
    from safetensors import safe_open
    from swiftvr.models import WanTransformer3DModel

    cfg = json.loads((WEIGHTS_DIR / 'transformer' / 'config.json').read_text(encoding='utf-8'))
    cfg = {k: v for k, v in cfg.items() if not k.startswith('_')}
    prev_dtype = torch.get_default_dtype()
    torch.set_default_dtype(dtype)
    try:
        with torch.device('meta'):
            tr = WanTransformer3DModel(**cfg)
    finally:
        torch.set_default_dtype(prev_dtype)

    src = WEIGHTS_DIR / 'transformer' / 'diffusion_pytorch_model.safetensors'
    if src.exists():
        log_fn('载入官方原版权重（FP32 → bf16）')
        tr = tr.to_empty(device=dev)
        with safe_open(str(src), framework='pt', device='cpu') as f:
            keys = set(f.keys())
            state = tr.state_dict()
            missing = [k for k in state if k not in keys]
            if missing:
                raise RuntimeError(f'官方权重文件缺少 {len(missing)} 个张量（如 {missing[0]}）')
            with torch.no_grad():
                for k, t in state.items():
                    t.copy_(f.get_tensor(k).to(t.dtype))
        _fuse_projections_linear(tr)
    elif FP8_FILE.exists():
        log_fn(f'载入预转换 FP8 权重并在 CPU 上还原为 bf16：{FP8_FILE.name}')
        FP8Linear = _fp8_linear_cls()
        _swap_in_fp8(tr.blocks, FP8Linear, dtype)
        _fuse_projections_fp8(tr, FP8Linear, dtype)
        tr = tr.to_empty(device='cpu')
        with safe_open(str(FP8_FILE), framework='pt', device='cpu') as f:
            keys = set(f.keys())
            state = tr.state_dict()
            missing = [k for k in state if k not in keys]
            if missing:
                raise RuntimeError(f'FP8 权重文件缺少 {len(missing)} 个张量（如 {missing[0]}）')
            with torch.no_grad():
                for k, t in state.items():
                    t.copy_(f.get_tensor(k))
        with torch.no_grad():
            for name, mod in [(n, m) for n, m in tr.named_modules() if isinstance(m, FP8Linear)]:
                lin = nn.Linear(mod.in_features, mod.out_features, bias=mod.bias is not None,
                                device=dev, dtype=dtype)
                lin.weight.copy_(mod.w8.to(dtype) * mod.scale.to(dtype))
                if mod.bias is not None:
                    lin.bias.copy_(mod.bias)
                parent, _, attr = name.rpartition('.')
                setattr(tr.get_submodule(parent), attr, lin)   # 逐层替换，CPU 上的 FP8 副本随之释放
        tr = tr.to(dev)
    else:
        raise FileNotFoundError(f'未找到 SwiftVR 权重：{src} 或 {FP8_FILE.name}')
    _reinit_nonpersistent_buffers(tr, cfg, dev, dtype)
    empty_device_cache(dev)
    return tr


def _reinit_nonpersistent_buffers(tr, cfg, dev, dtype):
    """meta 构造 + to_empty 后，不在 state_dict 里的缓冲（如 RoPE 频率表）是垃圾内存。
    用同配置在 CPU 上构造一个只含这些缓冲的模块副本，把值拷回来。"""
    import torch
    persistent = set(tr.state_dict().keys())
    pending = [(n, b) for n, b in tr.named_buffers() if n not in persistent]
    if not pending:
        return
    # 目前只有 RoPE 频率表是非持久缓冲：在 CPU 上按同配置构造一份，拷回（转为缓冲自身的 dtype）
    with torch.device('cpu'):
        rope = type(tr.rope)(cfg['attention_head_dim'], tuple(cfg.get('patch_size', [1, 2, 2])),
                             cfg.get('rope_max_seq_len', 1024))
    ref_bufs = dict(rope.named_buffers())
    for n, b in pending:
        short = n[len('rope.'):] if n.startswith('rope.') else None
        if short is None or short not in ref_bufs:
            raise RuntimeError(f'无法恢复非持久缓冲 {n}')
        with torch.no_grad():
            b.copy_(ref_bufs[short].to(b.device, b.dtype))


def pick_fp8_compute(dev):
    """FP8 张量核计算是否可用：返回 (开关, 说明)。需 sm_89 及以上（Ada / Hopper / Blackwell），
    并实际跑一次 _scaled_mm 确认当前 PyTorch 支持。"""
    import torch
    if not str(dev).startswith('cuda'):
        return False, 'bf16（MPS 不支持 FP8 计算）'
    if os.environ.get('V2X_SWIFTVR_FP8_COMPUTE', '').strip() == '0':
        return False, 'bf16（V2X_SWIFTVR_FP8_COMPUTE=0 强制关闭）'
    cap = torch.cuda.get_device_capability(dev)
    if cap < (8, 9):
        return False, f'bf16（显卡 sm_{cap[0]}{cap[1]} 无 FP8 张量核，需 RTX 40 系 / Ada 及以上）'
    try:
        a = torch.zeros(32, 64, device=dev).to(torch.float8_e4m3fn)
        b = torch.zeros(32, 64, device=dev).to(torch.float8_e4m3fn)
        one = torch.ones((), device=dev)
        torch._scaled_mm(a, b.t(), scale_a=one, scale_b=one, out_dtype=torch.bfloat16)
    except Exception as e:  # noqa: BLE001
        return False, f'bf16（FP8 矩阵乘不可用：{type(e).__name__}）'
    return True, 'FP8 张量核（权重与激活均为 FP8）'


def load_pipeline(dev, log_fn):
    import torch
    from safetensors.torch import load_file
    from swiftvr import SwiftVRPipeline
    from swiftvr.models import ReAE
    from swiftvr.runner import enable_max_fps_runtime

    dtype = torch.bfloat16
    if dev == 'mps':
        transformer = build_bf16_transformer(dev, dtype, log_fn)
    else:
        transformer = build_fp8_transformer(dev, dtype, log_fn)
    reae = ReAE(str(WEIGHTS_DIR / 'reae.safetensors'))
    prompt_emb = load_file(str(WEIGHTS_DIR / 'prompt_embedding.safetensors'))['prompt_emb'][0]
    pipe = SwiftVRPipeline(reae, transformer, prompt_emb)
    # 不能调用 pipe.to(dtype=...)：module.to(dtype) 会把 FP8 缓冲转回 bf16，前功尽弃。
    # 这里手工完成 pipe.to() 的其余工作
    pipe.device, pipe.dtype = torch.device(dev), dtype
    reae.to(dev, dtype).eval()
    enable_max_fps_runtime(allow_tf32=True)
    transformer.prepare_for_inference(attention_backend='auto', use_torch_compile=False)
    pipe._prepared = True
    from swiftvr.models.transformer import (get_attention_backend, list_available_attention_backends,
                                            set_attention_backend)
    if get_attention_backend() == 'sageattention':
        ok, why = sageattn_selftest(dev)
        if not ok:
            set_attention_backend('sdpa')
            log_fn(f'SageAttention 自检失败，改用 SDPA（{why}）')
    log_fn(f'注意力后端: {get_attention_backend()}（可用: {", ".join(list_available_attention_backends())}）')
    global FP8_COMPUTE
    FP8_COMPUTE, why = pick_fp8_compute(dev)
    log_fn(f'矩阵乘: {why}')
    return pipe


# ---------------------------------------------------------------------------
# 分辨率与分段长度
# ---------------------------------------------------------------------------

def compute_output_dims(w, h, short_target):
    """目标短边 → 输出宽高（保持宽高比，取偶数）。short_target<=0 时为短边×2、上限 1440。"""
    short = min(w, h)
    if short_target <= 0:
        short_target = min(short * 2, 1440)
    s = short_target / short
    ow, oh = int(round(w * s / 2)) * 2, int(round(h * s / 2)) * 2
    return max(2, ow), max(2, oh)


def initial_clip_len(out_pixels, vram_gb):
    """按输出像素与显存给初始分段（4 的倍数）。16 GB 卡实测（FP8、去冗余投影后）：
    2K 用 8、1080p 用 16、更小用 24；分段越大吞吐略高但峰值显存越大。
    推理中若 OOM 会自动减半重试，这里只是起点。"""
    mp = out_pixels / 1e6
    if vram_gb < 15:
        return 4
    if mp > 2.5:
        return 8
    if mp > 1.2:
        return 16
    return 24


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def main(args):
    import torch

    meta = probe(args.input)
    W, H, FPS, TOTAL = meta['width'], meta['height'], meta['fps'], meta['total']
    if args.max_frames > 0:
        TOTAL = min(TOTAL, args.max_frames)
    oW, oH = compute_output_dims(W, H, args.resolution)
    log(f'输入: {W}x{H} @ {FPS:.3f}fps, 共 {TOTAL} 帧')
    log(f'SwiftVR: 输出 {oW}x{oH}')

    dev = resolve_device(args.device)
    if dev == 'mps':
        if not torch.backends.mps.is_available():
            fail('MPS 不可用：需要 Apple Silicon 与 macOS 14 及以上')
        # 统一内存：PyTorch 可用的上限是 recommended_max_memory（worker.py 已把 MPS 水位卡在 1.0 倍，
        # 超出即 OOM，不会转为换页）。bf16 权重常驻约 10 GB，比 CUDA 的 FP8 多约 5 GB
        rec_gb = torch.mps.recommended_max_memory() / 2**30
        if rec_gb < 15:
            fail(f'SwiftVR 在 Mac 上需要约 24 GB 及以上的统一内存（当前 GPU 可用上限 {rec_gb:.1f} GB）：'
                 'bf16 权重就要约 10 GB 常驻，再加推理所需内存')
        # 初始分段沿用 CUDA 的经验表（按扣掉多出的 5 GB 权重后的等效显存查），与 Windows 输出一致。
        # 不为省内存改小：分段即 DiT 每次联合处理的时间跨度（clip/4 个潜空间帧，runner 不做重叠），
        # M5 Max 实测（720p 真值、640x360 劣化输入）：分段 4 / 8 / 16 / 24 的 PSNR 为
        # 26.84 / 27.33 / 27.45 / 27.47 dB，帧间闪烁 3.51 / 3.20 / 3.16 / 3.14，分段 4 明显更差；
        # 而 MPS 上速度几乎不随分段变（2K：4 帧 3.14 fps、8 帧 3.09 fps），省内存换不来速度
        clip_len = max(4, args.clip_len // 4 * 4) if args.clip_len > 0 else initial_clip_len(oW * oH, rec_gb - 5)
        log(f'统一内存：GPU 可用上限 {rec_gb:.1f} GB，初始分段 {clip_len} 帧')
    else:
        if not dev.startswith('cuda'):
            fail(f'SwiftVR 需要 CUDA 或 MPS 设备（收到 --device {args.device}）')
        validate_cuda_device(dev)
        torch.cuda.set_device(dev)
        total_gb = torch.cuda.get_device_properties(dev).total_memory / 2**30
        free_gb = torch.cuda.mem_get_info(dev)[0] / 2**30
        if total_gb < 15:
            fail(f'SwiftVR 需要 16 GB 级显存（当前 {total_gb:.1f} GB）：50 亿参数模型即使 FP8 也需约 5 GB 权重常驻，'
                 '再加推理所需显存')
        # 显存上限：超出即 OOM（随后自动减小分段重试），而不是被 Windows 驱动挪到
        # 系统内存——那样不报错，但速度会跌到原来的几十分之一
        torch.cuda.set_per_process_memory_fraction(max(0.5, (free_gb - 0.3) / total_gb), dev)
        # 模型要求 4 的倍数（ReAE 时间维 4 倍压缩）
        clip_len = max(4, args.clip_len // 4 * 4) if args.clip_len > 0 else initial_clip_len(oW * oH, total_gb)
        log(f'显存 {total_gb:.1f} GB（空闲 {free_gb:.1f} GB），初始分段 {clip_len} 帧')

    # ------------------------------------------------------------------
    # 断点续跑：宏分片 + 检查点（协议与 worker.py / seedvr2_runner.py 一致）
    # ------------------------------------------------------------------
    seg_len = max(48, args.seg_len)
    out_path = str(args.output)
    ckpt_file = Path(out_path + '.v2xckpt.json')

    def seg_path(frame0):
        return f'{out_path}.seg{frame0:06d}.mp4'

    in_stat = os.stat(args.input)
    fingerprint = {
        'model': 'swiftvr', 'codec': args.codec, 'crf': args.crf,
        'bitRate': int(getattr(args, 'bit_rate', 0) or 0), 'pipe': 2,
        'pixFmt': getattr(args, 'pix_fmt', 'yuv420p'),
        'out': [oW, oH],
        'input': str(Path(args.input).resolve()),
        'isize': in_stat.st_size, 'imtime': int(in_stat.st_mtime),
        'w': W, 'h': H, 'fps': round(FPS, 3), 'total': TOTAL,
        'segLen': seg_len,
    }

    def cleanup_stale_segs():
        for f in glob.glob(f'{out_path}.seg*.mp4'):
            try:
                os.remove(f)
            except OSError:
                pass

    resume_from = 0
    if ckpt_file.exists():
        try:
            old = json.loads(ckpt_file.read_text(encoding='utf-8'))
        except Exception:
            old = None
        if old and old.get('fp') == fingerprint and 0 < int(old.get('nextFrame', 0)) < TOTAL:
            resume_from = int(old['nextFrame'])
            log(f'检测到有效断点：从第 {resume_from} 帧续跑（已完成 {resume_from}/{TOTAL}）')
        elif old and old.get('fp') == fingerprint and int(old.get('nextFrame', 0)) >= TOTAL:
            resume_from = TOTAL
            log('分片已全部完成，直接执行合并')
        else:
            log('检查点缺失或参数指纹不一致，从头重跑（清理旧分片）')
            cleanup_stale_segs()
            try:
                ckpt_file.unlink(missing_ok=True)
            except OSError:
                pass

    def write_ckpt(next_frame):
        tmp = ckpt_file.with_suffix('.tmp')
        tmp.write_text(json.dumps({'nextFrame': next_frame, 'fp': fingerprint}), encoding='utf-8')
        tmp.replace(ckpt_file)

    pipe = None
    if resume_from < TOTAL:
        t_load = time.time()
        log('加载 SwiftVR 模型...')
        try:
            pipe = load_pipeline(dev, log)
        except Exception as e:  # noqa: BLE001
            if not is_oom_error(e):
                raise
            fail('加载模型时显存不足：请关闭其他占用显存的程序后重试')
        w_gb = device_allocated_gb(dev)
        log(f'模型加载完成（{time.time() - t_load:.0f}s，权重常驻 {w_gb:.1f} GB）')

    frame_bytes = W * H * 3
    fps_str = f'{FPS:.6f}'.rstrip('0').rstrip('.')
    written = resume_from
    t0 = time.time()

    def emit_progress():
        elapsed = time.time() - t0
        done = written - resume_from
        fps_now = done / elapsed if elapsed > 0 else 0.0
        remain = (TOTAL - written) / fps_now if fps_now > 0 else 0
        print(f'frame={written}/{TOTAL} ({100.0 * written / TOTAL:.1f}%); fps={fps_now:.2f}; '
              f'elapsed={fmt_hms(elapsed)}; remaining={fmt_hms(remain)}', flush=True)

    def run_macro(seg_start, seg_end, clip):
        """推理并编码 [seg_start, seg_end) 到独立宏分片；OOM 时抛出由外层减小分段重试"""
        nonlocal written
        seg_file = seg_path(seg_start)
        seek_frame = max(0, seg_start - 8)      # 多解 8 帧作时序上下文，输出丢弃
        dec_pre = [] if seek_frame == 0 else ['-ss', f'{seek_frame / FPS:.6f}']
        dec_cmd = [str(FFMPEG), '-hide_banner', '-loglevel', 'error',
                   *dec_pre, '-i', args.input, *decode_cfr_args(fps_str),
                   '-frames:v', str(seg_end - seek_frame),
                   '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']
        enc_cmd = [str(FFMPEG), '-y', '-hide_banner', '-loglevel', 'error',
                   '-f', 'rawvideo', '-pix_fmt', 'rgb24',
                   '-s', f'{oW}x{oH}', '-r', fps_str, '-i', 'pipe:0',
                   '-an', '-c:v', args.codec,
                   *quality_args(args.codec, args.crf, getattr(args, 'bit_rate', 0)),
                   *encode_color_args(), '-pix_fmt', getattr(args, 'pix_fmt', 'yuv420p'), seg_file]
        dec = subprocess.Popen(dec_cmd, stdout=subprocess.PIPE, bufsize=frame_bytes * 4)
        enc = subprocess.Popen(enc_cmd, stdin=subprocess.PIPE)
        wd_begin, wd_end, wd_stop, wd_beat = start_decode_watchdog(
            dec, suspend_flag=str(args.output) + '.v2xsuspended', enc_proc=enc)

        seg_written = 0
        out_index = 0                            # 已产出的输出帧序号（对应输入帧 seek_frame+out_index）
        drop = seg_start - seek_frame
        need = seg_end - seg_start
        last_frame = None

        # 解码读取、编码写入各占一个后台线程，与 GPU 推理重叠（串行时 GPU 每步空等
        # 读写约 15%）。看门狗只由主线程计时：等读线程出批、或编码端停滞导致输出
        # 交不出去时，主线程阻塞在队列上，超时即判定挂死
        stop = threading.Event()
        in_q = queue.Queue(maxsize=2)            # 读线程 → 主线程：(帧批 | None, 是否末批)
        out_q = queue.Queue(maxsize=2)           # 主线程 → 写线程：uint8 帧数组；None 表示结束
        werr = []

        def put(q, item):
            """可被 stop 打断的阻塞 put"""
            while not stop.is_set():
                try:
                    q.put(item, timeout=0.5)
                    return True
                except queue.Full:
                    pass
            return False

        def reader():
            batch = []
            try:
                while not stop.is_set():
                    raw = dec.stdout.read(frame_bytes)
                    if not raw or len(raw) < frame_bytes:
                        break
                    batch.append(np.frombuffer(raw, np.uint8).reshape(H, W, 3))
                    if len(batch) == clip:
                        if not put(in_q, (np.stack(batch), False)):
                            return
                        batch = []
            except (OSError, ValueError):        # 管道已被主线程关闭
                batch = []
            finally:
                put(in_q, (np.stack(batch) if batch else None, True))

        def writer():
            while True:
                try:
                    arr = out_q.get(timeout=0.5)
                except queue.Empty:
                    if stop.is_set():
                        return
                    continue
                if arr is None or stop.is_set():
                    return
                if werr:
                    continue                     # 编码器已退出：照常取走，免得主线程卡在 put
                try:
                    enc.stdin.write(arr.reshape(-1).data)
                except (BrokenPipeError, OSError) as e:
                    werr.append(e)

        rt = threading.Thread(target=reader, daemon=True)
        wt = threading.Thread(target=writer, daemon=True)
        rt.start()
        wt.start()

        def consume(y):
            """把会话输出交给写线程：丢弃上下文帧，截断补帧产生的多余尾帧"""
            nonlocal out_index, seg_written, written
            if y is None:
                return
            arr = ((y[0].clamp(0, 1) * 255.0).round().to(torch.uint8)
                   .permute(0, 2, 3, 1).contiguous().cpu().numpy())
            lo = max(0, drop - out_index)
            hi = min(len(arr), drop + need - out_index)
            out_index += len(arr)
            if hi > lo:
                wd_begin()
                try:
                    put(out_q, arr[lo:hi])
                finally:
                    wd_end()
                if werr:
                    raise werr[0]
                seg_written += hi - lo
                written += hi - lo
            emit_progress()

        ok = False
        broken = None
        try:
            with torch.inference_mode():
                sess = pipe.stream(clip_len=clip, resolution=(oW, oH), dit_overlap=0)
                eof = False
                while not eof:
                    wd_begin()
                    try:
                        batch, eof = in_q.get()
                    finally:
                        wd_end()
                    if batch is not None:
                        last_frame = batch[-1].copy()
                        wd_beat()
                        consume(sess.step(torch.from_numpy(batch)))
                if last_frame is not None:
                    # 补 3 帧重复末帧再 flush：把解码器滞留的尾帧推出来（多出的会被截断）
                    pad = torch.from_numpy(np.stack([last_frame] * 3))
                    consume(sess.step(pad))
                    consume(sess.flush())
            wd_begin()
            try:
                put(out_q, None)
                wt.join()                        # 等写线程把排队的帧写完
            finally:
                wd_end()
            ok = True
        except (BrokenPipeError, OSError) as e:
            if not werr:
                raise
            broken = e                           # 编码器先退出了：下面按其退出码报错
        finally:
            stop.set()
            wt.join(timeout=10)
            try:
                enc.stdin.close()
            except (BrokenPipeError, OSError):
                pass
            if not ok and dec.poll() is None:
                dec.kill()                       # 异常路径（如 OOM 重试）不再需要解码输出
            rt.join(timeout=10)
            dec.stdout.close()
            dec.wait()
            wd_stop()
            rc = enc.wait()
        if rc != 0:
            fail(f'ffmpeg 宏分片编码器退出码 {rc}')
        if broken is not None:
            fail(f'写入编码器失败：{broken}')
        if seg_written < need:
            fail(f'本分片只产出 {seg_written} 帧（预期 {need}），输入文件可能损坏；'
                 f'本分片未写入检查点，重跑将从此分片重来')
        write_ckpt(seg_end)
        log(f'宏分片完成: {seg_start}-{seg_end} → {Path(seg_file).name}')

    clip = clip_len
    for seg_start in range(resume_from, TOTAL, seg_len):
        if pause_requested(out_path):
            log(f'收到暂停请求：停在检查点（已完成 {seg_start}/{TOTAL}，可续跑）')
            sys.exit(4)
        seg_end = min(seg_start + seg_len, TOTAL)
        while True:
            base = written
            try:
                run_macro(seg_start, seg_end, clip)
                break
            except Exception as e:  # noqa: BLE001
                if not is_oom_error(e):
                    raise
                written = base
                empty_device_cache(dev)
                if clip <= 4:
                    fail(f'显存不足：输出 {oW}x{oH} 在最小分段下仍放不下。请降低目标分辨率，'
                         '或关闭其他占用显存的程序')
                clip = max(4, (clip // 2 + 3) // 4 * 4)   # 减半并取 4 的倍数：48→24→12→8→4
                log(f'显存不足，分段减小到 {clip} 帧后重试本分片')
                try:
                    os.remove(seg_path(seg_start))
                except OSError:
                    pass

    # ---- 合并宏分片，音频/字幕从输入带回 ----
    expected = [seg_path(f) for f in range(0, TOTAL, seg_len)]
    missing = [p for p in expected if not os.path.exists(p)]
    if missing:
        fail(f'缺少 {len(missing)} 个宏分片，无法合并（如 {Path(missing[0]).name}）')
    list_file = out_path + '.mergelist.txt'
    with open(list_file, 'w', encoding='utf-8') as lf:
        for p in expected:
            # concat 按清单文件所在目录解析相对路径：-o 传相对路径时会拼成 dir/dir/...，统一写绝对路径
            lf.write("file '" + os.path.abspath(p).replace('\\', '/').replace("'", "'\\''") + "'\n")
    m = merge_with_source(list_file, args.input, out_path, meta, args,
                          lambda msg: print(f'[worker] {msg}', flush=True))
    if m.returncode != 0:
        err = (m.stderr or b'').decode('utf-8', errors='replace')
        fail(f'宏分片合并失败: {err[:300]}（分片已保留，可重新运行续合并）')
    for p in expected:
        try:
            os.remove(p)
        except OSError:
            pass
    try:
        os.remove(list_file)
        ckpt_file.unlink(missing_ok=True)
    except OSError:
        pass
    emit_progress()
    log(f'完成: {args.output}（{written} 帧，输出 {oW}x{oH}）')


# ---------------------------------------------------------------------------
# 官方权重 → 预转换 FP8 单文件（便携包随附此文件：约 5 GB，对比官方 FP32 的 19 GB）
# ---------------------------------------------------------------------------

def convert_official_to_fp8(dst=None):
    """读官方 FP32 权重，按与运行时完全相同的流程量化、融合，保存为单个 safetensors。
    运行时检测到该文件即直接载入，结构与数值与现场转换逐位一致。"""
    import torch
    from safetensors.torch import save_file
    dst = Path(dst) if dst else FP8_FILE
    if dst.exists():
        dst.unlink()  # 确保走官方权重路径
    tr = build_fp8_transformer('cuda:0', torch.bfloat16, log)
    state = {k: v.detach().contiguous() for k, v in tr.state_dict().items()}
    n_fp8 = sum(1 for v in state.values() if v.dtype == torch.float8_e4m3fn)
    save_file(state, str(dst), metadata={'format': 'pt', 'swiftvr_fp8': '1',
                                         'note': 'weight-only fp8 (per-output-channel scale), fused qkv'})
    log(f'已保存 {dst}（{dst.stat().st_size / 2**30:.2f} GB，{len(state)} 个张量，其中 FP8 {n_fp8} 个）')


if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser(description='SwiftVR 工具')
    ap.add_argument('--convert-fp8', metavar='DST', nargs='?', const='',
                    help='把 WEIGHTS_DIR 下的官方权重转换为预转换 FP8 文件（默认写到 WEIGHTS_DIR）')
    a = ap.parse_args()
    if a.convert_fp8 is not None:
        convert_official_to_fp8(a.convert_fp8 or None)
    else:
        ap.print_help()
