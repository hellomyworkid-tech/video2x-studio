# -*- coding: utf-8 -*-
"""FlashVSR (v1.1, Tiny streaming pipeline) runner for the Video2X sidecar.

Uses the vendored diffsynth/FlashVSR code in engine-python/vendor/flashvsr
with two local patches: dense-SDPA attention fallback (no custom CUDA
kernels on Windows) and a stream-progress hook.

Long videos are processed in overlapping segments (fresh streaming state per
segment; overlapped outputs discarded) to bound VRAM usage.
"""

import argparse
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

ENGINE_DIR = Path(__file__).resolve().parent.parent
VENDOR_DIR = ENGINE_DIR / 'vendor' / 'flashvsr'
WEIGHTS_DIR = ENGINE_DIR / 'weights' / 'FlashVSR-v1.1'

sys.path.insert(0, str(VENDOR_DIR))
sys.path.insert(0, str(ENGINE_DIR))

# reuse the ffmpeg plumbing from worker.py
from worker import probe, fmt_hms, log, fail, FFMPEG, start_decode_watchdog, resolve_device, validate_cuda_device  # noqa: E402


def compute_scaled_and_target_dims(w0, h0, scale=4.0, multiple=128):
    sW = int(round(w0 * scale))
    sH = int(round(h0 * scale))
    tW = (sW // multiple) * multiple
    tH = (sH // multiple) * multiple
    if tW == 0 or tH == 0:
        fail(f'输入分辨率 {w0}x{h0} 太小，4x 后不足 {multiple} 对齐')
    return sW, sH, tW, tH


def largest_8n1_leq(n):
    return 0 if n < 1 else ((n - 1) // 8) * 8 + 1


def init_pipeline(torch, device='cuda'):
    import torch as _t  # alias
    from diffsynth import ModelManager, FlashVSRTinyPipeline
    from utils.utils import Causal_LQ4x_Proj
    from utils.TCDecoder import build_tcdecoder

    dtype = _t.bfloat16
    safetensors = WEIGHTS_DIR / 'diffusion_pytorch_model_streaming_dmd.safetensors'
    vae_pth = WEIGHTS_DIR / 'Wan2.1_VAE.pth'
    if not safetensors.exists():
        fail(f'缺少 FlashVSR 权重: {safetensors}')

    mm = ModelManager(torch_dtype=dtype, device='cpu')
    mm.load_models([str(safetensors)])
    pipe = FlashVSRTinyPipeline.from_model_manager(mm, device=device)
    if getattr(pipe, 'vae', None) is None:
        log('主权重未包含 VAE，加载独立 Wan2.1_VAE.pth')
        mm.load_models([str(vae_pth)])
        pipe = FlashVSRTinyPipeline.from_model_manager(mm, device=device)

    pipe.denoising_model().LQ_proj_in = Causal_LQ4x_Proj(
        in_dim=3, out_dim=1536, layer_num=1).to(device, dtype=dtype)
    pipe.denoising_model().LQ_proj_in.load_state_dict(
        _t.load(WEIGHTS_DIR / 'LQ_proj_in.ckpt', map_location='cpu', weights_only=True),
        strict=True)
    pipe.denoising_model().LQ_proj_in.to(device)

    multi_scale_channels = [512, 256, 128, 128]
    pipe.TCDecoder = build_tcdecoder(new_channels=multi_scale_channels,
                                     new_latent_channels=16 + 768)
    pipe.TCDecoder.load_state_dict(
        _t.load(WEIGHTS_DIR / 'TCDecoder.ckpt', map_location='cpu', weights_only=True),
        strict=False)

    pipe.to(device)
    pipe.enable_vram_management(num_persistent_param_in_dit=None)
    pipe.init_cross_kv()
    pipe.load_models_to_device(['dit', 'vae'])
    return pipe


def main(args):
    import subprocess

    import torch
    from einops import rearrange

    meta = probe(args.input)
    W, H, FPS, TOTAL = meta['width'], meta['height'], meta['fps'], meta['total']
    if args.max_frames > 0:
        TOTAL = min(TOTAL, args.max_frames)

    sW, sH, tW, tH = compute_scaled_and_target_dims(W, H, scale=4.0)
    # FlashVSR 是 8n+1 帧模式且消耗 4 帧热身：实际输出帧数 = largest_8n1(TOTAL+4)-4
    EXPECTED = max(1, largest_8n1_leq(TOTAL + 4) - 4)
    log(f'输入: {W}x{H} @ {FPS:.3f}fps, 共 {TOTAL} 帧（预计输出 {EXPECTED} 帧）')
    log(f'FlashVSR: 双三次预放大到 {sW}x{sH} → 中心裁切到目标 {tW}x{tH}（128 对齐）')

    # decoder pipe
    # -frames:v 限定解码帧数，避免读够后关管道导致解码器刷 Broken pipe 报错
    dec_cmd = [str(FFMPEG), '-hide_banner', '-loglevel', 'error',
               '-i', args.input, '-frames:v', str(TOTAL),
               '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']
    dec = subprocess.Popen(dec_cmd, stdout=subprocess.PIPE, bufsize=W * H * 3 * 4)

    # encoder pipe (output = tW x tH)
    fps_str = f'{FPS:.6f}'.rstrip('0').rstrip('.')
    enc_cmd = [str(FFMPEG), '-y', '-hide_banner', '-loglevel', 'error',
               '-f', 'rawvideo', '-pix_fmt', 'rgb24',
               '-s', f'{tW}x{tH}', '-r', fps_str, '-i', 'pipe:0']
    if meta['has_audio']:
        # 目标容器不支持无损拷贝的音频编码（如 rmvb 的 cook → mp4）时直接转 AAC，
        # 避免编码器启动后 mux 失败导致整段白跑
        out_ext = Path(args.output).suffix.lower()
        mp4_safe = ('aac', 'mp3', 'ac3', 'eac3', 'alac', 'mp2', 'ac4')
        a_codec = 'copy' if (out_ext not in ('.mp4', '.m4v', '.mov')
                             or meta.get('audio_codec', '') in mp4_safe) else 'aac'
        if a_codec == 'aac':
            print(f"[worker] 源音频编码 {meta.get('audio_codec') or '未知'} 无法无损进 "
                  f'{out_ext} 容器，音频转 AAC', flush=True)
        enc_cmd += ['-i', args.input, '-map', '0:v:0', '-map', '1:a?',
                    '-c:a', a_codec, '-shortest']
    enc_cmd += ['-c:v', args.codec, '-crf', str(args.crf),
                '-pix_fmt', 'yuv420p', args.output]
    enc = subprocess.Popen(enc_cmd, stdin=subprocess.PIPE)
    wd_begin, wd_end, wd_stop, wd_beat = start_decode_watchdog(
        dec, suspend_flag=str(args.output) + '.v2xsuspended', enc_proc=enc)

    # 尊重 UI 高级选项的显卡选择（worker.py --device cuda:N）
    device = resolve_device(args.device)
    if not device.startswith('cuda'):
        fail(f'FlashVSR 需要 CUDA 设备（收到 --device {args.device}）')
    validate_cuda_device(device)
    torch.cuda.set_device(device)  # 让 empty_cache() 作用于所选卡而非恒 0 号卡
    log('加载 FlashVSR 模型（首次约 30~60s）...')
    t_load = time.time()
    pipe = init_pipeline(torch, device)
    log(f'模型加载完成（{time.time() - t_load:.0f}s）')

    frame_bytes = W * H * 3

    def read_frame():
        wd_begin()
        buf = dec.stdout.read(frame_bytes)
        wd_end()
        if not buf or len(buf) < frame_bytes:
            return None
        return np.frombuffer(buf, np.uint8).reshape(H, W, 3)

    def frame_to_target(f):
        img = Image.fromarray(f)
        up = img.resize((sW, sH), Image.BICUBIC)
        l = (sW - tW) // 2
        t = (sH - tH) // 2
        up = up.crop((l, t, l + tW, t + tH))
        arr = np.asarray(up, np.uint8)
        t_ = torch.from_numpy(arr).to(device=device, dtype=torch.float32)
        return (t_.permute(2, 0, 1) / 255.0 * 2.0 - 1.0).to(torch.bfloat16)

    SEG = max(24, args.segment)          # 每段帧数
    OVL = min(16, SEG // 4)              # 段间重叠（丢弃用）
    written = 0
    next_read = 0
    pending = []
    t0 = time.time()
    seg_iters_total = [0, 0]             # [done, total] 供回调换算

    def emit_progress():
        # 分母用 TOTAL：内层守卫也是 TOTAL，末段可写到 TOTAL（超出 EXPECTED 的是真实帧），
        # 用 EXPECTED 当分母会导致 pct >100%
        elapsed = time.time() - t0
        fps_now = written / elapsed if elapsed > 0 else 0.0
        remain = (TOTAL - written) / fps_now if fps_now > 0 else 0
        pct = 100.0 * written / TOTAL
        print(f'frame={written}/{TOTAL} ({pct:.1f}%); fps={fps_now:.2f}; '
              f'elapsed={fmt_hms(elapsed)}; remaining={fmt_hms(remain)}',
              flush=True)

    def on_stream_iter(done, total):
        # 每次流式迭代 ≈ 产出 8 帧
        est = min(TOTAL, written_base[0] + done * 8)
        elapsed = time.time() - t0
        fps_now = est / elapsed if elapsed > 0 else 0.0
        remain = (TOTAL - est) / fps_now if fps_now > 0 else 0
        print(f'frame={est}/{TOTAL} ({100.0 * est / TOTAL:.1f}%); fps={fps_now:.2f}; '
              f'elapsed={fmt_hms(elapsed)}; remaining={fmt_hms(remain)}',
              flush=True)

    written_base = [0]
    pipe.stream_progress_cb = on_stream_iter

    seed, sparse_ratio, kv_ratio, local_range = 0, 2.0, 3.0, 11

    while written < EXPECTED:
        # 收集一段（含与上一段的重叠头部）
        seg = list(pending)
        seg_start = next_read - len(pending)
        eof = False
        while len(seg) < SEG and next_read < TOTAL and not eof:
            f = read_frame()
            if f is None:
                eof = True
                break
            next_read += 1
            seg.append(f)
        if not seg:
            break
        # EOF 必须视同末段：否则 pending 帧会被无限重复推理（死循环）
        is_last_seg = eof or next_read >= TOTAL

        # FlashVSR 要求 8n+1 帧：尾部复制最后一帧补齐
        idx_len = len(seg) + 4
        F = largest_8n1_leq(idx_len)
        if F == 0:
            fail('帧数不足，无法满足 FlashVSR 的 8n+1 要求')
        seg_ext = seg + [seg[-1]] * (F - len(seg))

        LQ = torch.stack([frame_to_target(f) for f in seg_ext], dim=0)
        LQ = LQ.permute(1, 0, 2, 3).unsqueeze(0)  # 1 C F H W

        written_base[0] = written
        wd_beat()  # 推理心跳：kernel 挂死时心跳停止，看门狗将自动退出
        video = pipe(
            prompt='', negative_prompt='', cfg_scale=1.0, num_inference_steps=1,
            seed=seed, LQ_video=LQ, num_frames=F, height=tH, width=tW,
            is_full_block=False, if_buffer=True,
            topk_ratio=sparse_ratio * 768 * 1280 / (tH * tW),
            kv_ratio=kv_ratio, local_range=local_range, color_fix=True,
        )
        del LQ
        torch.cuda.empty_cache()

        frames = rearrange(video, 'C T H W -> T H W C')
        frames = ((frames.float() + 1) * 127.5).clip(0, 255).to(torch.uint8).cpu().numpy()

        drop = 0 if seg_start == 0 else OVL
        keep_to = frames.shape[0]  # 全部可用（补帧已去）
        # 末尾 4 帧是重复补齐帧，除非输入末尾否则丢弃
        if not is_last_seg and frames.shape[0] >= 4:
            keep_to = frames.shape[0] - 4
        for i in range(drop, keep_to):
            if written >= TOTAL:
                break
            wd_begin()
            try:
                enc.stdin.write(frames[i].tobytes())
            finally:
                wd_end()
            written += 1
            if written % 5 == 0 or written == TOTAL:
                emit_progress()

        if is_last_seg:
            break
        # 保留尾部重叠帧作为下一段的上下文
        pending = seg[-OVL:]

    emit_progress()
    try:
        enc.stdin.close()
    except BrokenPipeError:
        pass
    dec.stdout.close()
    dec.wait()
    wd_stop()
    rc = enc.wait()
    if rc != 0:
        fail(f'ffmpeg 编码器退出码 {rc}')
    log(f'完成: {args.output}（{written} 帧，输出 {tW}x{tH}）')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default='flashvsr')
    ap.add_argument('-i', '--input', required=True)
    ap.add_argument('-o', '--output', required=True)
    ap.add_argument('--codec', default='libx264')
    ap.add_argument('--crf', type=int, default=18)
    ap.add_argument('--segment', type=int, default=200, help='每段帧数（长视频分段，0=整段）')
    ap.add_argument('--max-frames', type=int, default=0)
    ap.add_argument('--device', default='cuda', help='推理设备（如 cuda / cuda:1）')
    args = ap.parse_args()
    if args.segment <= 0:
        args.segment = 10 ** 9
    main(args)
