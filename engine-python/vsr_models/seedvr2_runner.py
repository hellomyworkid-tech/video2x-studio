# -*- coding: utf-8 -*-
"""SeedVR2-3B (FP8, one-step diffusion) runner for the Video2X sidecar.

Uses the vendored numz core in engine-python/vendor/seedvr2 (Apache 2.0,
ComfyUI-SeedVR2_VideoUpscaler 的独立推理核心，已去除 ComfyUI 接口层)。

视频按重叠分段处理（模型常驻，段间重叠输出丢弃），输出帧经 ffmpeg
管道编码。分辨率不敏感：默认短边 4x，可用 --resolution 指定目标短边。

断点续跑：与 worker.py 的 RealBasicVSR 相同的宏分片协议——每完成一个
--seg-len 宏分片落盘 <out>.segNNNNNN.mp4 并更新 <out>.v2xckpt.json
（含参数指纹）。中止/失败后以相同参数重启即从下一个未完成分片继续；
全部完成后自动合并（音频从输入拷贝）并清理分片与检查点。
参数指纹不一致时拒绝续跑，从头重跑，防止错误拼接。
"""

import glob
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

ENGINE_DIR = Path(__file__).resolve().parent.parent
VENDOR_DIR = ENGINE_DIR / 'vendor' / 'seedvr2'
WEIGHTS_DIR = ENGINE_DIR / 'weights' / 'SeedVR2-3B'

sys.path.insert(0, str(VENDOR_DIR))
sys.path.insert(0, str(ENGINE_DIR))

from worker import probe, fmt_hms, log, fail, FFMPEG, start_decode_watchdog, pause_requested, resolve_device, validate_cuda_device, quality_args, decode_cfr_args, encode_color_args, merge_with_source, sageattn_selftest  # noqa: E402


def compute_output_dims(w0, h0, resolution):
    """复现 vendor 的变换几何：短边→resolution，长边等比(round)，再 16 对齐 pad。
    返回 (裁剪后有效宽, 有效高, pad 后宽, pad 后高)。

    有效宽高强制为偶数：libx264/yuv420p 要求偶数尺寸，奇数宽（如 1271）
    会被编码器直接拒绝（width not divisible by 2）。"""
    short, long_ = (h0, w0) if h0 <= w0 else (w0, h0)
    new_short = max(2, resolution & ~1)
    new_long = int(round(long_ * resolution / short))
    if new_long % 2:
        new_long -= 1
    new_long = max(2, new_long)
    oW = new_long if w0 >= h0 else new_short
    oH = new_short if w0 >= h0 else new_long
    pW = (oW + 15) // 16 * 16
    pH = (oH + 15) // 16 * 16
    return oW, oH, pW, pH


ATTN_MODES = ('sdpa', 'sageattn_2', 'sageattn_3', 'flash_attn_2', 'flash_attn_3')


def pick_attention_mode(device='cuda:0'):
    """按已安装的加速库选择注意力后端；全部未装时为 PyTorch 原生 SDPA（当前便携包即如此）。
    优先级：SageAttention 2（官方称精度优于 v3，画质优先）> SageAttention 3（仅 Blackwell）
    > FlashAttention 3（仅 Hopper）> FlashAttention 2 > SDPA。
    环境变量 V2X_SEEDVR2_ATTN 可强制指定（取值见 ATTN_MODES），便于对比测速。
    """
    forced = os.environ.get('V2X_SEEDVR2_ATTN', '').strip().lower()
    if forced in ATTN_MODES:
        return forced, '环境变量指定'
    try:
        import torch
        from src.optimization import compatibility as compat
        major = torch.cuda.get_device_capability(device)[0] if torch.cuda.is_available() else 0
    except Exception:
        return 'sdpa', '加速库检测失败'
    sage_note = ''
    if compat.SAGE_ATTN_2_AVAILABLE:
        ok, why = sageattn_selftest(device, varlen=True)
        if ok:
            return 'sageattn_2', '检测到 SageAttention 2，自检通过'
        sage_note = f'；SageAttention 2 自检失败已跳过（{why}）'
    if compat.SAGE_ATTN_3_AVAILABLE and major >= 10:
        return 'sageattn_3', '检测到 SageAttention 3（Blackwell）'
    if compat.FLASH_ATTN_3_AVAILABLE and major == 9:
        return 'flash_attn_3', '检测到 FlashAttention 3（Hopper）'
    if compat.FLASH_ATTN_2_AVAILABLE:
        return 'flash_attn_2', '检测到 FlashAttention 2' + sage_note
    return 'sdpa', (sage_note.lstrip('；') if sage_note else '未安装 SageAttention / FlashAttention')


def pick_memory_strategy(device='cuda:0'):
    """按可用显存选 BlockSwap / VAE tiling 策略（可被 --blocks-to-swap 覆盖）。

    conv3d_wa=True 表示保留 numz 的 cuDNN Conv3d 绕路（省显存但 VAE 慢约 3-5 倍）；
    显存 ≥12GB 时用标准 dispatch（配合 VAE tiling，内存安全且快得多）。
    device 必须是实际推理用卡：异构多卡下按 0 号卡评估会把大显存卡误判成低显存。"""
    try:
        import torch
        total_gb = torch.cuda.get_device_properties(device).total_memory / (1 << 30)
    except Exception:
        total_gb = 8
    if total_gb < 12:
        return dict(blocks=16, swap_io=True, enc_tiled=True, dec_tiled=True, tile=512,
                    conv3d_wa=True)
    if total_gb < 20:
        return dict(blocks=8, swap_io=True, enc_tiled=True, dec_tiled=True, tile=768,
                    conv3d_wa=False)
    return dict(blocks=0, swap_io=False, enc_tiled=False, dec_tiled=True, tile=1024,
                conv3d_wa=False)


def main(args):
    import torch
    torch.backends.cudnn.benchmark = False  # 默认关：decode/DiT 阶段反而更快；encode 前单独开

    from src.core.generation_utils import (
        setup_generation_context, prepare_runner, compute_generation_info,
        log_generation_start, load_text_embeddings, script_directory,
    )
    from src.core.generation_phases import (
        encode_all_batches, upscale_all_batches,
        decode_all_batches, postprocess_all_batches,
    )
    from src.utils.debug import Debug
    from src.utils.model_registry import DEFAULT_DIT, DEFAULT_VAE
    from src.models.video_vae_v3.modules import causal_inflation_lib

    meta = probe(args.input)
    W, H, FPS, TOTAL = meta['width'], meta['height'], meta['fps'], meta['total']
    if args.max_frames > 0:
        TOTAL = min(TOTAL, args.max_frames)

    resolution = args.resolution if args.resolution > 0 else min(W, H) * 4
    oW, oH, pW, pH = compute_output_dims(W, H, resolution)
    log(f'输入: {W}x{H} @ {FPS:.3f}fps, 共 {TOTAL} 帧')
    log(f'SeedVR2: 目标短边 {resolution}px → 输出 {oW}x{oH}（内部 16 对齐 {pW}x{pH}）')

    # 尊重 UI 高级选项的显卡选择（worker.py --device cuda:N）：
    # 显存策略评估、empty_cache 的"当前设备"语义都必须落到这张卡
    dev = resolve_device(args.device)
    if not dev.startswith('cuda'):
        fail(f'SeedVR2 需要 CUDA 设备（收到 --device {args.device}）')
    validate_cuda_device(dev)
    torch.cuda.set_device(dev)
    mem = pick_memory_strategy(dev)
    if args.tile == 0:                   # --tile 0：VAE 整帧编解码
        mem.update(enc_tiled=False, dec_tiled=False)
    elif args.tile > 0:
        mem.update(enc_tiled=True, dec_tiled=True, tile=args.tile)
    blocks = args.blocks_to_swap if args.blocks_to_swap >= 0 else mem['blocks']
    conv3d_wa = {'on': True, 'off': False}.get(args.conv3d_workaround, mem['conv3d_wa'])
    causal_inflation_lib.NVIDIA_CONV3D_MEMORY_BUG_WORKAROUND = conv3d_wa
    log(f'显存策略: blocks_to_swap={blocks}, swap_io={mem["swap_io"]}, '
        f'VAE tiling enc={mem["enc_tiled"]}/dec={mem["dec_tiled"]}({mem["tile"]}), '
        f'conv3d绕路={conv3d_wa}')
    attn_mode, attn_why = pick_attention_mode(dev)
    log(f'注意力后端: {attn_mode}（{attn_why}）')

    # ------------------------------------------------------------------
    # 断点续跑：宏分片 + 检查点（协议与 worker.py RealBasicVSR 一致）
    # ------------------------------------------------------------------
    seg_len = max(48, args.seg_len)
    out_path = str(args.output)
    ckpt_file = Path(out_path + '.v2xckpt.json')

    def seg_path(frame0):
        return f'{out_path}.seg{frame0:06d}.mp4'

    in_stat = os.stat(args.input)
    fingerprint = {
        'model': 'seedvr2', 'codec': args.codec, 'crf': args.crf,
        'bitRate': int(getattr(args, 'bit_rate', 0) or 0), 'pipe': 2,  # 同 worker.py
        'pixFmt': getattr(args, 'pix_fmt', 'yuv420p'),
        'resolution': resolution,
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
        else:
            if old and old.get('fp') == fingerprint and int(old.get('nextFrame', 0)) >= TOTAL:
                resume_from = TOTAL  # 分片已齐，直接进入合并
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
        tmp.write_text(json.dumps({'nextFrame': next_frame, 'fp': fingerprint}),
                       encoding='utf-8')
        tmp.replace(ckpt_file)

    # ---- 模型加载（常驻，跨宏分片复用；已完成全部宏分片则跳过加载直接合并） ----
    runner = None
    ctx = None
    debug = Debug(enabled=bool(args.debug))
    if resume_from < TOTAL:
        log('加载 SeedVR2 模型（首次约 30~60s）...')
        t_load = time.time()
        ctx = setup_generation_context(
            dit_device=dev, vae_device=dev,
            dit_offload_device='cpu', vae_offload_device=None,
            tensor_offload_device='cpu', debug=debug)
        runner, cache_context = prepare_runner(
            dit_model=DEFAULT_DIT, vae_model=DEFAULT_VAE,
            model_dir=str(WEIGHTS_DIR), debug=debug, ctx=ctx,
            block_swap_config={
                'blocks_to_swap': blocks,
                'swap_io_components': mem['swap_io'],
                'offload_device': 'cpu',
            },
            encode_tiled=mem['enc_tiled'],
            encode_tile_size=(mem['tile'], mem['tile']),
            encode_tile_overlap=(mem['tile'] // 8, mem['tile'] // 8),
            decode_tiled=mem['dec_tiled'],
            decode_tile_size=(mem['tile'], mem['tile']),
            decode_tile_overlap=(mem['tile'] // 8, mem['tile'] // 8),
            attention_mode=attn_mode)
        ctx['cache_context'] = cache_context
        ctx['text_embeds'] = load_text_embeddings(
            str(script_directory), ctx['dit_device'], ctx['compute_dtype'], debug)
        log(f'模型加载完成（{time.time() - t_load:.0f}s）')

    SEG = max(25, args.segment)          # 每段帧数（模型内部时序窗口）
    OVL = min(8, SEG // 8)               # 段间重叠（丢弃用）
    BATCH = max(5, args.batch_size)      # 内部批（4n+1）
    t0 = time.time()
    EXPECTED = TOTAL
    written = resume_from
    seg_progress = [0.0]                 # 当前段内完成度 0..1
    wd_beat_ref = [None]                 # 当前宏分片的看门狗心跳（run_macro 内赋值）
    frame_bytes = W * H * 3
    fps_str = f'{FPS:.6f}'.rstrip('0').rstrip('.')

    # 阶段耗时权重：encode / upscale(DiT) / decode / post
    PHASE_W = {'encode': 0.15, 'upscale': 0.60, 'decode': 0.20, 'post': 0.05}

    def emit_progress():
        if wd_beat_ref[0] is not None:
            wd_beat_ref[0]()  # 推理心跳：kernel 挂死时回调停摆，看门狗将自动退出
        cur = min(EXPECTED, written + seg_progress[0] * min(SEG, EXPECTED - written))
        elapsed = time.time() - t0
        done = cur - resume_from
        fps_now = done / elapsed if elapsed > 0 else 0.0
        remain = (EXPECTED - cur) / fps_now if fps_now > 0 else 0
        pct = 100.0 * cur / EXPECTED
        print(f'frame={int(cur)}/{EXPECTED} ({pct:.1f}%); fps={fps_now:.2f}; '
              f'elapsed={fmt_hms(elapsed)}; remaining={fmt_hms(remain)}',
              flush=True)

    def make_phase_cb():
        phase_base = [0.0]  # 已完成阶段的权重累计

        def cb(current, total, frames, phase_name):
            key = 'post' if 'post' in phase_name else (
                'decode' if 'decode' in phase_name else (
                    'upscale' if 'upscale' in phase_name.lower() or 'dit' in phase_name.lower() else 'encode'))
            w = PHASE_W.get(key, 0.1)
            seg_progress[0] = min(1.0, phase_base[0] + w * current / max(1, total))
            emit_progress()
        return cb, phase_base

    def run_macro(seg_start, seg_end):
        """推理并编码 [seg_start, seg_end) 帧到独立宏分片文件"""
        nonlocal written, runner, ctx
        seg_file = seg_path(seg_start)
        # 多解 8 帧作为时序上下文，丢弃对应输出，减少分片边界的质量跳变
        # 多解 8 帧作为时序上下文，丢弃对应输出，减少分片边界的质量跳变
        # seek_frame=0 时不带 -ss：无索引的损坏文件带 -ss 会 seek 到虚空，整段 0 帧
        seek_frame = max(0, seg_start - 8)
        dec_pre = [] if seek_frame == 0 else ['-ss', f'{seek_frame / FPS:.6f}']
        # -frames:v 限定解码帧数，避免读够后关管道导致解码器刷 Broken pipe 报错
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
        dec = subprocess.Popen(dec_cmd, stdout=subprocess.PIPE,
                               bufsize=frame_bytes * 4)
        enc = subprocess.Popen(enc_cmd, stdin=subprocess.PIPE)
        wd_begin, wd_end, wd_stop, wd_beat = start_decode_watchdog(
            dec, suspend_flag=str(args.output) + '.v2xsuspended', enc_proc=enc)
        wd_beat_ref[0] = wd_beat

        def read_frame():
            wd_begin()
            buf = dec.stdout.read(frame_bytes)
            wd_end()
            if not buf or len(buf) < frame_bytes:
                return None
            return np.frombuffer(buf, np.uint8).reshape(H, W, 3)

        next_read = seek_frame
        pending = []
        first_sub = True
        while written < seg_end:
            seg = list(pending)
            eof = False
            while len(seg) < SEG and next_read < seg_end:
                f = read_frame()
                if f is None:
                    eof = True
                    break
                next_read += 1
                seg.append(f)
            if not seg:
                break
            is_last_seg = eof or next_read >= seg_end
            # 仅"最后一个宏分片的最后一个子段"允许删模型，其余一律保留（跨宏分片复用）
            last_overall = is_last_seg and seg_end >= TOTAL

            # [T,H,W,C] float32 0..1
            seg_np = np.stack(seg, axis=0)
            frames_tensor = torch.from_numpy(seg_np).float().div_(255.0)
            del seg_np

            seg_progress[0] = 0.0
            cb, phase_base = make_phase_cb()
            with torch.no_grad():
                frames_tensor, gen_info = compute_generation_info(
                    ctx=ctx, images=frames_tensor, resolution=resolution,
                    max_resolution=0, batch_size=BATCH, uniform_batch_size=False,
                    seed=42, prepend_frames=0, temporal_overlap=0, debug=debug)
                if args.debug:
                    log_generation_start(gen_info, debug)
                torch.backends.cudnn.benchmark = True   # 实测仅 encode 受益
                ctx = encode_all_batches(
                    runner, ctx=ctx, images=frames_tensor, debug=debug,
                    batch_size=BATCH, uniform_batch_size=False, seed=42,
                    progress_callback=cb, temporal_overlap=0,
                    resolution=resolution, max_resolution=0,
                    input_noise_scale=0.0, color_correction='lab')
                torch.backends.cudnn.benchmark = False  # decode 开了反而慢
                phase_base[0] += PHASE_W['encode']
                ctx = upscale_all_batches(
                    runner, ctx=ctx, debug=debug, progress_callback=cb,
                    seed=42, latent_noise_scale=0.0, cache_model=not last_overall)
                phase_base[0] += PHASE_W['upscale']
                ctx = decode_all_batches(
                    runner, ctx=ctx, debug=debug, progress_callback=cb,
                    cache_model=not last_overall)
                phase_base[0] += PHASE_W['decode']
                ctx = postprocess_all_batches(
                    ctx=ctx, debug=debug, progress_callback=cb,
                    color_correction='lab', prepend_frames=0,
                    temporal_overlap=0, batch_size=BATCH)

            result = ctx['final_video']
            if result.is_cuda:
                result = result.cpu()
            if result.dtype in (torch.bfloat16, torch.float8_e4m3fn, torch.float8_e5m2):
                result = result.to(torch.float32)
            out = (result.clamp_(0, 1) * 255.0).round().to(torch.uint8).numpy()
            del result, frames_tensor
            torch.cuda.empty_cache()
            # 兼容 [C,T,H,W] / [T,C,H,W] / [T,H,W,C] 三种输出布局
            if out.ndim == 4 and out.shape[0] in (1, 3) and out.shape[-1] not in (1, 3):
                out = np.transpose(out, (1, 2, 3, 0))
            elif out.ndim == 4 and out.shape[1] in (1, 3) and out.shape[-1] not in (1, 3):
                out = np.transpose(out, (0, 2, 3, 1))
            # 裁掉右侧/下侧的 16 对齐黑边
            out = out[:, :oH, :oW, :]

            def fit_frame(f):
                """兜底：模型实际输出尺寸与声明尺寸不一致时（奇偶取舍差异），
                裁齐或边缘补齐到编码器声明的 (oH, oW)，保证字节数精确。"""
                fh, fw = f.shape[:2]
                if fh == oH and fw == oW:
                    return f
                f = f[:min(fh, oH), :min(fw, oW)]
                ph, pw = oH - f.shape[0], oW - f.shape[1]
                if ph > 0 or pw > 0:
                    f = np.pad(f, ((0, max(0, ph)), (0, max(0, pw)), (0, 0)),
                               mode='edge')
                return np.ascontiguousarray(f)

            if first_sub:  # 丢弃宏分片头部的时序上下文帧
                drop = min(seg_start - seek_frame, out.shape[0])
                first_sub = False
            else:
                drop = min(OVL, out.shape[0])
            for i in range(drop, out.shape[0]):
                if written >= seg_end:
                    break
                wd_begin()
                try:
                    enc.stdin.write(fit_frame(out[i]).tobytes())
                finally:
                    wd_end()
                written += 1
            del out
            seg_progress[0] = 1.0
            emit_progress()

            if is_last_seg:
                break
            pending = seg[-OVL:]

        try:
            enc.stdin.close()
        except BrokenPipeError:
            pass
        dec.stdout.close()
        dec.wait()
        wd_stop()
        rc = enc.wait()
        if rc != 0:
            fail(f'ffmpeg 宏分片编码器退出码 {rc}')
        if written < seg_end:
            fail(f'解码器仅产出到第 {written} 帧（预期 {seg_end}），'
                 f'输入文件可能损坏；本宏分片未写入检查点，重跑将从此分片重来')
        write_ckpt(seg_end)
        log(f'宏分片完成: {seg_start}-{seg_end} → {Path(seg_file).name}')

    # ---- 逐宏分片处理 ----
    for seg_start in range(resume_from, TOTAL, seg_len):
        if pause_requested(out_path):
            log(f'收到暂停请求：停在检查点（已完成 {seg_start}/{TOTAL}，可续跑）')
            sys.exit(4)
        run_macro(seg_start, min(seg_start + seg_len, TOTAL))

    # ---- 合并宏分片（续跑时之前的分片已在盘上），音频从输入拷贝 ----
    expected = [seg_path(f) for f in range(0, TOTAL, seg_len)]
    missing = [p for p in expected if not os.path.exists(p)]
    if missing:
        fail(f'缺少 {len(missing)} 个宏分片，无法合并（如 {Path(missing[0]).name}）')

    list_file = out_path + '.mergelist.txt'
    with open(list_file, 'w', encoding='utf-8') as lf:
        for p in expected:
            lf.write("file '" + p.replace('\\', '/').replace("'", "'\\''") + "'\n")

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
    log(f'完成: {args.output}（{written} 帧，输出 {oW}x{oH}，'
        f'显存峰值 {torch.cuda.max_memory_reserved(dev) / 2**30:.1f} GB）')


if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default='seedvr2')
    ap.add_argument('-i', '--input', required=True)
    ap.add_argument('-o', '--output', required=True)
    ap.add_argument('--codec', default='libx264')
    ap.add_argument('--crf', type=int, default=18)
    ap.add_argument('--bit-rate', type=int, default=0, help='平均码率 bps；>0 时进入码率控制并忽略 --crf')
    ap.add_argument('--pix-fmt', default='yuv420p')
    ap.add_argument('--no-copy-audio', action='store_true')
    ap.add_argument('--no-copy-subs', action='store_true')
    ap.add_argument('--resolution', type=int, default=0, help='目标短边像素（0=输入短边×4）')
    ap.add_argument('--segment', type=int, default=121, help='模型内部时序段帧数')
    ap.add_argument('--seg-len', type=int, default=240, help='断点续跑宏分片长度（帧）')
    ap.add_argument('--batch-size', type=int, default=5, help='内部批大小（4n+1）')
    ap.add_argument('--blocks-to-swap', type=int, default=-1, help='BlockSwap 块数（-1=按显存自动）')
    ap.add_argument('--conv3d-workaround', choices=['auto', 'on', 'off'], default='auto',
                    help='cuDNN Conv3d 绕路（省显存但慢）；auto=显存<12GB 时开启')
    ap.add_argument('--max-frames', type=int, default=0)
    ap.add_argument('--debug', action='store_true')
    ap.add_argument('--device', default='cuda', help='推理设备（如 cuda / cuda:1）')
    args = ap.parse_args()
    main(args)
