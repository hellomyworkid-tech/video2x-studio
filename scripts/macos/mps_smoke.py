"""PyTorch MPS 冒烟测试（只读）：本项目用到的关键算子在 MPS 上能否运行、速度如何。

由 scripts/macos/doctor.sh 调用，也可单独运行：
    engine-python/.venv/bin/python scripts/macos/mps_smoke.py
"""
import sys
import time

import torch

print(f'  torch {torch.__version__}；MPS 已编译 {torch.backends.mps.is_built()}，可用 {torch.backends.mps.is_available()}')
if not torch.backends.mps.is_available():
    print('  [FAIL] MPS 不可用（需要 Apple Silicon + macOS 12.3 以上，bf16 需要 14 以上）')
    sys.exit(1)

dev = torch.device('mps')
try:
    print(f'  建议内存上限 recommended_max_memory = {torch.mps.recommended_max_memory() / 2**30:.1f} GB')
except Exception:  # noqa: BLE001  旧版 PyTorch 没有该接口
    pass


def bench(fn, n=10):
    fn()
    torch.mps.synchronize()
    t = time.perf_counter()
    for _ in range(n):
        fn()
    torch.mps.synchronize()
    return (time.perf_counter() - t) / n * 1000


def check(label, fn):
    try:
        ms = bench(fn)
        print(f'  [OK]   {label}：{ms:.2f} ms')
        return ms
    except Exception as e:  # noqa: BLE001
        print(f'  [FAIL] {label}：{type(e).__name__}: {str(e).splitlines()[0][:150] if str(e) else ""}')
        return None


# 1) Conv3d：SeedVR2 / SwiftVR 的 VAE 主体
for dt in (torch.float16, torch.bfloat16):
    conv = torch.nn.Conv3d(64, 64, 3, padding=1).to(dev, dt)
    x = torch.randn(1, 64, 8, 64, 64, device=dev, dtype=dt)
    with torch.inference_mode():
        check(f'Conv3d {str(dt).split(".")[1]}', lambda: conv(x))

# 2) SDPA：两个旗舰模型的注意力（Mac 上没有 SageAttention / FlashAttention）
q = torch.randn(1, 24, 4096, 128, device=dev, dtype=torch.float16)
check('scaled_dot_product_attention fp16（24 头 × 4096 × 128）',
      lambda: torch.nn.functional.scaled_dot_product_attention(q, q, q))

# 3) 矩阵乘吞吐：决定 SwiftVR 在这台机器上用 bf16 还是 fp16（M1–M3 的 bf16 是模拟执行）
N = 4096
res = {}
for dt in (torch.float32, torch.float16, torch.bfloat16):
    a = torch.randn(N, N, device=dev, dtype=dt)
    ms = check(f'matmul {N}³ {str(dt).split(".")[1]}', lambda: a @ a)
    if ms:
        res[dt] = 2 * N ** 3 / (ms / 1000) / 1e12
if res:
    print('  吞吐：' + '，'.join(f'{str(k).split(".")[1]} {v:.1f} TFLOPS' for k, v in res.items()))
    if torch.float16 in res and torch.bfloat16 in res:
        r = res[torch.bfloat16] / res[torch.float16]
        hint = 'bf16 与 fp16 相当，SwiftVR 可沿用 bf16' if r > 0.8 else 'bf16 明显慢于 fp16（模拟执行），SwiftVR 应优先试 fp16 并检查溢出'
        print(f'  bf16/fp16 = {r:.2f} → {hint}')

# 4) RealBasicVSR 的光流对齐（grid_sample）与 SeedVR2 用到的抗锯齿双三次缩放
img = torch.randn(1, 64, 270, 480, device=dev, dtype=torch.float16)
grid = torch.rand(1, 270, 480, 2, device=dev, dtype=torch.float16) * 2 - 1
check('grid_sample fp16', lambda: torch.nn.functional.grid_sample(img, grid, align_corners=True))
check('interpolate bicubic + antialias', lambda: torch.nn.functional.interpolate(
    img.float(), scale_factor=0.5, mode='bicubic', antialias=True))

# 5) FP8：SwiftVR 的 FP8Linear 前向要在设备上把 w8 还原为 bf16（docs/macos/01-feasibility.md D5）。
#    只测"能否放上 MPS"会误报：torch 2.14 上 fp8 张量能拷上 MPS，但任何转换都报 Undefined type。
try:
    w8 = torch.zeros(16, dtype=torch.float8_e4m3fn).to(dev)
except Exception as e:  # noqa: BLE001
    print(f'  [INFO] float8_e4m3fn 不能放上 MPS（D5 成立）：{str(e).splitlines()[0][:100]}')
else:
    try:
        w8.to(torch.bfloat16)
        print('  [INFO] MPS 上 float8_e4m3fn → bf16 可用（与 2026-10 的结论不同，值得重新评估 D5）')
    except Exception as e:  # noqa: BLE001
        print(f'  [INFO] float8_e4m3fn 能放上 MPS，但不能在 MPS 上转换（D5 成立：在 CPU 上还原）：'
              f'{str(e).splitlines()[0][:100]}')
