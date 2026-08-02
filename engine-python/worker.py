# -*- coding: utf-8 -*-
"""Video2X Python sidecar worker — PyTorch-based flagship VSR engines.

Spawned by the bridge like:
   python worker.py --model realbasicvsr -i in.mp4 -o out.mp4 --codec libx264 --crf 18

Decode/encode uses the ffmpeg binaries shipped with the project
(third_party/ffmpeg-shared/bin). Progress lines match the bridge regex:
  frame=i/N (P%); fps=F; elapsed=...; remaining=...

Chunking: the video is processed in overlapping chunks (bidirectional
propagation needs temporal context). Each chunk's tail `overlap` frames are
re-computed by the next chunk with better context; encoder receives every
output frame exactly once, in order.

断点续跑（RealBasicVSR）：视频按 --seg-len 宏分片处理，每完成一片立即
落盘 <out>.segNNNNNN.mp4 并更新 <out>.v2xckpt.json（含参数指纹）。
中止/失败后重新以相同参数启动即可从下一个未完成分片继续；
全部完成后自动合并为最终文件并清理分片与检查点。
参数指纹不一致（模型/编码/CRF/输入文件变动/分片长度不同）时拒绝续跑，
从头重跑，防止错误拼接。
"""

import argparse
import glob
import json
import subprocess
import sys
import threading
import time
from pathlib import Path

# Windows 中文系统默认 GBK：worker 的日志与 ffprobe 输出都含 UTF-8 字节，
# 必须显式统一为 UTF-8，否则子进程读线程会 UnicodeDecodeError
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

# 必须在 import torch 之前设置：减少长序列注意力下的显存碎片化。
# expandable_segments 仅 Linux 支持，Windows 上 PyTorch 会打警告后忽略
# （"expandable_segments not supported on this platform"）。
# 注：Windows 分支实测对 RealBasicVSR 吞吐无可测差异（与默认分配器同为 1.46 fps），
# 仅为消除那条误导性警告；真正决定吞吐的是下面的分块显存预算。
import os
if os.name == 'nt':
    os.environ.setdefault('PYTORCH_CUDA_ALLOC_CONF', 'garbage_collection_threshold:0.8')
else:
    os.environ.setdefault('PYTORCH_CUDA_ALLOC_CONF', 'expandable_segments:True')
os.environ.setdefault('PYTHONIOENCODING', 'utf-8')

import numpy as np

ENGINE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = ENGINE_DIR.parent
FFMPEG_DIR = PROJECT_ROOT / 'third_party' / 'ffmpeg-shared' / 'bin'
FFMPEG = FFMPEG_DIR / 'ffmpeg.exe'
FFPROBE = FFMPEG_DIR / 'ffprobe.exe'


CHUNK_AUTO = -1   # --chunk 未显式指定的哨兵值（0 是非法块长，不能兼作哨兵）


def log(msg):
    print(f'[worker] {msg}', flush=True)


def fail(msg, code=1):
    print(f'[worker] ERROR: {msg}', flush=True)
    sys.exit(code)


def resolve_device(raw):
    """把 --device 的各种写法归一成带索引形式（'cuda' / 'cuda:1' → 'cuda:0' / 'cuda:1'）。

    torch.cuda.set_device 不接受无索引的 'cuda'（抛 ValueError），而 .to('cuda')
    可以接受 —— 两个 API 容忍度不同，三个引擎统一在此归一，避免各处重复兜底。
    非 cuda 值（如 'cpu'）原样返回 'cpu'，由调用方决定是否支持。"""
    s = str(raw or 'cuda')
    if not s.startswith('cuda'):
        return 'cpu'
    return s if ':' in s else 'cuda:0'


def validate_cuda_device(device):
    """CUDA 索引合法性校验：畸形/越界时给中文明确错误，而非原始 CUDA 报错。

    注意 CUDA 与 Vulkan 是两套独立编号空间（核显机上必然错位），
    索引越界是多卡/核显机上最容易踩的坑。"""
    if not device.startswith('cuda:'):
        return
    import torch
    try:
        idx = int(device.split(':', 1)[1])
    except ValueError:
        fail(f'无法识别的 CUDA 设备：{device!r}（应为 cuda:0、cuda:1 等形式）')
    n = torch.cuda.device_count()
    if idx < 0 or idx >= n:
        fail(f'本机只有 {n} 张 CUDA 卡（cuda:0 ~ cuda:{n - 1}），无法使用 {device}；'
             '请在高级选项的 CUDA 设备中选择有效的显卡')


def start_decode_watchdog(dec_proc, warn_after=60, kill_after=300, suspend_flag=None,
                          enc_proc=None):
    """管道心跳看门狗。

    只在 read_frame 阻塞等待解码输出、或 write_frame 阻塞写入编码管道期间
    计时（推理阶段不计）。等待超过 warn_after 秒打印警告，超过 kill_after
    秒判定为挂死：强杀解码/编码进程并以退出码 3 结束。
    典型场景：网络源解码挂死、异常封装 seek 卡死、编码端磁盘/NAS 写入停滞
    （编码器停止消费 → 管道反压 → 写入侧永久阻塞，此路径仅本看门狗覆盖）。
    RealBasicVSR/SeedVR2 分片与检查点已落盘，重新启动可从断点续跑。
    suspend_flag：进程挂起旗标文件（bridge 挂起进程树前写入）。旗标存在时
    豁免计时并重置心跳，避免按墙钟把"真暂停"误判为挂死。
    返回 (begin, end, stop)：read/write 前后各调一次，结束后 stop。
    """
    st = {'since': None, 'stop': False}

    def _wd():
        warned = False
        while not st['stop']:
            time.sleep(5)
            if suspend_flag and os.path.exists(suspend_flag):
                # 进程树被挂起（真暂停）：重置计时，解冻后从头计
                st['since'] = None
                warned = False
                continue
            since = st['since']
            if since is None:
                warned = False
                continue
            idle = time.time() - since
            if idle > kill_after:
                log(f'超过 {kill_after}s 无任何进展，判定为挂死'
                    f'（解码停滞、编码端磁盘/网络盘写入卡死，或 GPU 推理 kernel 挂死）。'
                    f'已自动退出；断点已保存，可直接续跑；'
                    f'若怀疑显卡状态异常，建议重启电脑后再续跑；'
                    f'若输出在网络盘上，请检查网络连接或改输出到本地磁盘。')
                for proc in (dec_proc, enc_proc):
                    if proc is None:
                        continue
                    try:
                        proc.kill()
                    except Exception:
                        pass
                os._exit(3)
            if idle > warn_after:
                if not warned:
                    warned = True
                    log(f'警告: 已 {int(idle)}s 无进展'
                        f'（解码/编码管道停滞或推理挂死），仍在等待；'
                        f'超过 {kill_after}s 将自动退出（断点可续跑）。')
            else:
                warned = False

    threading.Thread(target=_wd, daemon=True).start()

    def begin():
        st['since'] = time.time()

    def end():
        st['since'] = None

    def stop():
        st['stop'] = True

    def beat():
        """推理心跳：每个推理块/批开始或推进时调用，重置挂死倒计时。
        GPU kernel 挂死时心跳停止，kill_after 秒后看门狗触发。"""
        st['since'] = time.time()

    return begin, end, stop, beat


def pause_requested(out_path):
    """bridge 通过 <out>.v2xpause 旗标文件请求在检查点优雅暂停。
    看到即删除旗标并返回 True；调用方应在宏分片边界以退出码 4 退出。"""
    p = str(out_path) + '.v2xpause'
    if os.path.exists(p):
        try:
            os.remove(p)
        except OSError:
            pass
        return True
    return False


def probe(path):
    cmd = [str(FFPROBE), '-v', 'quiet', '-print_format', 'json',
           '-show_format', '-show_streams', str(path)]
    # 不用 text=True（会按系统区域 GBK 解码）：手动按 UTF-8 容错解码
    out = subprocess.run(cmd, capture_output=True)
    if out.returncode != 0:
        err = (out.stderr or b'').decode('utf-8', errors='replace')
        fail(f'ffprobe 失败: {err[:300]}')
    info = json.loads(out.stdout.decode('utf-8', errors='replace'))
    vstream = next((s for s in info['streams'] if s['codec_type'] == 'video'), None)
    if vstream is None:
        fail('输入文件没有视频流')
    has_audio = any(s['codec_type'] == 'audio' for s in info['streams'])

    num, den = vstream['avg_frame_rate'].split('/')
    fps = float(num) / float(den) if float(den) > 0 else 25.0

    nb = vstream.get('nb_frames')
    if nb and nb.isdigit():
        total = int(nb)
    else:
        total = int(float(info['format'].get('duration', 0)) * fps)

    return {
        'width': int(vstream['width']),
        'height': int(vstream['height']),
        'fps': fps,
        'total': total,
        'has_audio': has_audio,
        # 音频编码名：合并/直编时判断能否无损拷进目标容器（cook 等需转 AAC）
        'audio_codec': next(
            (s.get('codec_name', '') for s in info['streams'] if s['codec_type'] == 'audio'), ''),
    }


def quality_args(codec, crf):
    """恒定质量参数名因编码器而异；发错了 ffmpeg 只 warning 后静默忽略，
    任务照常完成但质量控制失效（实测 hevc_nvenc 用 -crf 产物比用 -cq 大 15%）。
      crf                —— libx264 / libx265 / libaom-av1 / libvpx-vp9 等
      cq                 —— *_nvenc（N 卡硬编）
      qvbr_quality_level —— *_amf（A 卡硬编），需同时把 rc 切到 qvbr
    """
    c = str(codec or '')
    if c.endswith('_nvenc'):
        return ['-cq', str(crf)]
    if c.endswith('_amf'):
        return ['-rc', 'qvbr', '-qvbr_quality_level', str(crf)]
    return ['-crf', str(crf)]


def fmt_hms(seconds):
    seconds = max(0, int(seconds))
    return f'{seconds // 3600:02d}:{(seconds % 3600) // 60:02d}:{seconds % 60:02d}'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', required=True, choices=['realbasicvsr', 'seedvr2'])
    ap.add_argument('-i', '--input', required=True)
    ap.add_argument('-o', '--output', required=True)
    ap.add_argument('--codec', default='libx264')
    ap.add_argument('--crf', type=int, default=18)
    ap.add_argument('--chunk', type=int, default=CHUNK_AUTO,
                    help='时间分块长度（帧）；不传则按显存自适应')
    ap.add_argument('--tile', type=int, default=-1,
                    help='空间分块边长（px）；0=强制整帧不分块，-1(默认)=按显存自适应')
    ap.add_argument('--overlap', type=int, default=8, help='分块重叠长度（帧）')
    ap.add_argument('--segment', type=int, default=121, help='SeedVR2 内部时序段帧数')
    ap.add_argument('--seg-len', type=int, default=240, help='断点续跑宏分片长度（帧）')
    ap.add_argument('--resolution', type=int, default=0, help='SeedVR2 目标短边像素（0=输入短边×4）')
    ap.add_argument('--batch-size', type=int, default=5, help='SeedVR2 内部批大小（4n+1）')
    ap.add_argument('--blocks-to-swap', type=int, default=-1, help='SeedVR2 BlockSwap 块数（-1=按显存自动）')
    ap.add_argument('--conv3d-workaround', choices=['auto', 'on', 'off'], default='auto',
                    help='SeedVR2 cuDNN Conv3d 绕路（省显存但慢）；auto=显存<12GB 时开启')
    ap.add_argument('--device', default='cuda')
    ap.add_argument('--no-fp16', action='store_true', help='禁用半精度（排障用）')
    ap.add_argument('--max-frames', type=int, default=0, help='仅处理前 N 帧（调试用）')
    ap.add_argument('--debug', action='store_true', help='引擎调试日志')
    args = ap.parse_args()

    if args.model == 'seedvr2':
        sys.path.insert(0, str(ENGINE_DIR))
        if args.seg_len == 240:
            args.seg_len = 120  # SeedVR2 极慢（约 0.4fps）：检查点加密到 120 帧，
                                # 暂停/断点续跑粒度从约 10 分钟降到约 5 分钟
        from vsr_models.seedvr2_runner import main as seed_main
        seed_main(args)
        return

    # 仅在显式指定 chunk 时校验；未指定时 chunk 是哨兵值，由下方显存自适应决定
    if args.chunk != CHUNK_AUTO and args.overlap >= args.chunk:
        fail('overlap 必须小于 chunk')

    if not FFMPEG.exists():
        fail(f'未找到 ffmpeg: {FFMPEG}')

    meta = probe(args.input)
    W, H, FPS, TOTAL = meta['width'], meta['height'], meta['fps'], meta['total']
    if args.max_frames > 0:
        TOTAL = min(TOTAL, args.max_frames)
    OW, OH = W * 4, H * 4  # RealBasicVSR 固定 x4
    log(f'输入: {W}x{H} @ {FPS:.3f}fps, 共 {TOTAL} 帧（RealBasicVSR x4 → {OW}x{OH}）')

    # ---- model (lazy import: keeps --help fast) ----
    import torch
    sys.path.insert(0, str(ENGINE_DIR))
    from vsr_models.realbasicvsr import load_realbasicvsr

    use_cuda = str(args.device).startswith('cuda') and torch.cuda.is_available()
    # resolve_device 统一补索引：'cuda' → 'cuda:0'（set_device 不接受无索引形式）
    device = resolve_device(args.device) if use_cuda else 'cpu'
    if use_cuda:
        # empty_cache() / autocast('cuda') 等都作用于"当前设备"（默认 0 号卡）：
        # 不调用 set_device，多卡下显存回收与 autocast 上下文全部落错卡
        validate_cuda_device(device)  # 索引越界给中文提示，而非原始 CUDA 报错
        torch.cuda.set_device(device)
    fp16 = use_cuda and not args.no_fp16
    spynet_p = ENGINE_DIR / 'weights' / 'spynet.pth'
    if not spynet_p.exists():
        # 商用合规构建会移除 spynet.pth（Max Planck 非商业许可）；
        # 官方 RealBasicVSR 主权重已内嵌全部 SPyNet 键（实测 124 个），效果一致
        log('提示：未找到 weights/spynet.pth，SPyNet 改用主权重内嵌键（效果一致）')
    model = load_realbasicvsr(
        ENGINE_DIR / 'weights' / 'realbasicvsr_x4.pth',
        spynet_p if spynet_p.exists() else None,
        device=device, fp16=fp16)
    log(f'模型已加载（device={device}, fp16={fp16}）')

    # ---- 显存自适应：优先整帧推理，放不下才空间分块 ----
    # 空间分块省显存，但画质有明显代价（RTX 5070 Ti，720x1280，真值重建 PSNR）：
    #   整帧          28.76 dB
    #   分块 TILE=768 27.13 dB  （-1.63 dB）
    #   分块 TILE=512 27.13 dB  （-1.63 dB）
    # 损失是阶跃的：2 块与 6 块几乎一样差，说明代价来自网络失去全局上下文，
    # 而非接缝数量。1.63 dB 远大于其他所有优化项的收益（EMA 权重才 +0.56 dB）。
    #
    # 速度上整帧确实更慢（60 帧端到端实测，含约 15s 模型加载）：
    #   分块768 chunk24  47s      整帧 chunk12  56s（+19%）
    #   分块768 chunk16  56s      整帧 chunk16  59s
    #                             整帧 chunk8  105s（撞显存悬崖）
    # 取舍：长片（一小时级）19% 就是数小时，因此默认走快的分块路径，
    # 需要极致画质时用 --tile 0 换那 1.63 dB。
    # 注意 chunk16 反而比 chunk12 慢——10.2 GB 已进入劣化区，预算须卡在此之前。
    try:
        vram_gb = (torch.cuda.get_device_properties(device).total_memory / (1 << 30)
                   if use_cuda else 0.0)
    except Exception:
        vram_gb = 0.0

    if vram_gb >= 14:
        TILE, TILE_OLAP, TCHUNK = 768, 64, 24
    elif vram_gb >= 10:
        TILE, TILE_OLAP, TCHUNK = 768, 64, 16
    elif vram_gb >= 6:
        TILE, TILE_OLAP, TCHUNK = 512, 64, 16
    else:
        TILE, TILE_OLAP, TCHUNK = 384, 48, 12

    # 峰值显存拟合模型（各实测点误差 <0.3 GB）
    #   整帧：≈ chunk × 输入像素 × 743 B（720x1280 chunk=16 实测 10.2 GB）
    #   分块：≈ 4.7 GB 模型激活 + o(单块 fp32 输出) + acc(整帧 fp16 累加)
    def est_full_gb(c):
        return c * H * W * 743 / (1 << 30)

    def est_tiled_gb(c):
        o_gb = c * 3 * (TILE * 4) ** 2 * 4 / (1 << 30)
        return 4.7 + o_gb + c * 3 * OH * OW * 2 / (1 << 30)

    # 预算必须用「总显存」而非「空闲显存」：检查点指纹含 tiled 字段，
    # 一旦分块与否随当时的空闲显存浮动，续跑时后台多开个占显存的程序就会
    # 让指纹对不上 → 已完成分片被当作参数变更全部删除、从第 0 帧重跑。
    # 0.60：实测 10.2 GB（占 64%）已明显劣化、11.3 GB 直接断崖。
    budget = max(1.0, vram_gb) * 0.60
    CHUNK_FLOOR = 12

    # 是否空间分块：按尺寸判定（确定性，与空闲显存无关）。
    # 整帧画质高约 1.6 dB 但慢约 19%——对动辄一小时的长片是数小时的差距，
    # 因此默认走快的分块路径；需要极致画质时用 --tile 0 强制整帧。
    tiled = H > TILE or W > TILE

    est_peak = est_tiled_gb if tiled else est_full_gb
    while TCHUNK > CHUNK_FLOOR and est_peak(TCHUNK) > budget:
        TCHUNK -= 4
    TOLAP = 6 if TCHUNK >= 12 else max(2, TCHUNK // 4)

    # 显式传入的 --chunk / --tile 优先于自动决策（调参与排障用；
    # 此前无论用户传什么都会被静默覆盖）
    if args.chunk != CHUNK_AUTO:
        TCHUNK = max(2, args.chunk)
        TOLAP = min(args.overlap, TCHUNK - 1)
        log(f'使用显式指定的时间分块 {TCHUNK}/{TOLAP}（跳过显存自适应）')
    if args.tile >= 0:
        TILE = args.tile
        tiled = TILE > 0 and (H > TILE or W > TILE)
        log(f'使用显式指定的空间分块 tile={TILE}（tiled={tiled}）')
    args.chunk, args.overlap = TCHUNK, TOLAP

    if tiled:
        log(f'空间分块 tile={TILE}（速度优先；整帧画质约高 1.6 dB 但慢约 19%，'
            f'可用 --tile 0 强制整帧）：时间分块 {args.chunk}/{args.overlap}，'
            f'预计峰值 {est_tiled_gb(TCHUNK):.1f} GB / 总显存 {vram_gb:.1f} GB')
    else:
        log(f'整帧推理（不分块，画质最佳）：时间分块 {args.chunk}/{args.overlap}，'
            f'预计峰值 {est_full_gb(TCHUNK):.1f} GB / 总显存 {vram_gb:.1f} GB')

    def build_ramp(n, ramp):
        wgt = torch.ones(n)
        if ramp > 0:
            r = torch.linspace(0.0, 1.0, ramp + 2)[1:-1]
            wgt[:ramp] = r
            wgt[-ramp:] = r.flip(0)
        return wgt

    def infer(lqs):
        """lqs: (1,T,3,H,W) 0..1 → (1,T,3,4H,4W)；高分辨率自动分块+羽化"""
        if not tiled:
            with torch.autocast('cuda', dtype=torch.float16, enabled=fp16):
                return model(lqs).float()
        T = lqs.shape[1]
        acc = torch.zeros(1, T, 3, OH, OW, dtype=torch.float16, device=device)
        wacc = torch.zeros(1, 1, 1, OH, OW, dtype=torch.float16, device=device)
        step = TILE - TILE_OLAP
        seen = set()
        for y0 in range(0, H, step):
            for x0 in range(0, W, step):
                y1, x1 = min(y0 + TILE, H), min(x0 + TILE, W)
                if y1 == H:
                    y0 = max(0, H - TILE)
                if x1 == W:
                    x0 = max(0, W - TILE)
                if (y0, x0) in seen:
                    continue
                seen.add((y0, x0))
                with torch.autocast('cuda', dtype=torch.float16, enabled=fp16):
                    # .contiguous()：切片是非连续视图，RealBasicVSR 内部若对输入做
                    # 原地填充/改写会污染 lqs 缓冲，进而影响后续相邻分块
                    o = model(lqs[:, :, :, y0:y1, x0:x1].contiguous()).float()
                oy0, ox0, oy1, ox1 = y0 * 4, x0 * 4, y1 * 4, x1 * 4
                ramp_y = TILE_OLAP * 4 if 0 < y0 or y1 < H else 0
                ramp_x = TILE_OLAP * 4 if 0 < x0 or x1 < W else 0
                wy = build_ramp(oy1 - oy0, ramp_y).view(1, 1, 1, -1, 1)
                wx = build_ramp(ox1 - ox0, ramp_x).view(1, 1, 1, 1, -1)
                wm = (wy * wx).to(device=device, dtype=torch.float16)
                acc[:, :, :, oy0:oy1, ox0:ox1] += o.half() * wm
                wacc[:, :, :, oy0:oy1, ox0:ox1] += wm
                del o
        # 原地相除，避免再产生一块 11GB 级 fp32 副本；写出帧时再转 uint8
        acc.div_(wacc.clamp_min(1e-6))
        del wacc
        torch.cuda.empty_cache()
        return acc  # fp16 (1,T,3,OH,OW)

    # ------------------------------------------------------------------
    # 断点续跑：宏分片 + 检查点
    # ------------------------------------------------------------------
    seg_len = max(24, args.seg_len)
    out_path = str(args.output)
    ckpt_file = Path(out_path + '.v2xckpt.json')

    def seg_path(frame0):
        return f'{out_path}.seg{frame0:06d}.mp4'

    in_stat = os.stat(args.input)
    fingerprint = {
        'model': args.model, 'codec': args.codec, 'crf': args.crf,
        'input': str(Path(args.input).resolve()),
        'isize': in_stat.st_size, 'imtime': int(in_stat.st_mtime),
        'w': W, 'h': H, 'fps': round(FPS, 3), 'total': TOTAL,
        'segLen': seg_len, 'tiled': tiled,
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

    frame_bytes = W * H * 3
    fps_str = f'{FPS:.6f}'.rstrip('0').rstrip('.')
    written = resume_from
    t0 = time.time()

    def emit_progress():
        elapsed = time.time() - t0
        done = written - resume_from
        fps_now = done / elapsed if elapsed > 0 else 0.0
        remain = (TOTAL - written) / fps_now if fps_now > 0 else 0
        pct = 100.0 * written / TOTAL
        print(f'frame={written}/{TOTAL} ({pct:.1f}%); fps={fps_now:.2f}; '
              f'elapsed={fmt_hms(elapsed)}; remaining={fmt_hms(remain)}',
              flush=True)

    def write_ckpt(next_frame):
        tmp = ckpt_file.with_suffix('.tmp')
        tmp.write_text(json.dumps({'nextFrame': next_frame, 'fp': fingerprint}),
                       encoding='utf-8')
        tmp.replace(ckpt_file)

    def run_segment(seg_start, seg_end):
        """推理并编码 [seg_start, seg_end) 帧到独立分片文件"""
        nonlocal written
        seg_file = seg_path(seg_start)
        # 多解 8 帧作为时序上下文，丢弃对应输出，减少分片边界的质量跳变
        # seek_frame=0 时不带 -ss：无索引（cues 缺失）的损坏文件带 -ss 会 seek 到虚空，
        # 导致整段解码 0 帧；不带 -ss 从头解码反而正常
        seek_frame = max(0, seg_start - 8)
        dec_pre = [] if seek_frame == 0 else ['-ss', f'{seek_frame / FPS:.6f}']
        # -frames:v 限定解码帧数：不加的话解码器会一直解到文件尾，等我们读够就
        # 关管道，ffmpeg 拿到 EPIPE 刷一屏 "Broken pipe / Error muxing" 红字
        dec_cmd = [str(FFMPEG), '-hide_banner', '-loglevel', 'error',
                   *dec_pre, '-i', args.input,
                   '-frames:v', str(seg_end - seek_frame),
                   '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']
        enc_cmd = [str(FFMPEG), '-y', '-hide_banner', '-loglevel', 'error',
                   '-f', 'rawvideo', '-pix_fmt', 'rgb24',
                   '-s', f'{OW}x{OH}', '-r', fps_str, '-i', 'pipe:0',
                   '-an', '-c:v', args.codec, *quality_args(args.codec, args.crf),
                   '-pix_fmt', 'yuv420p', seg_file]
        dec = subprocess.Popen(dec_cmd, stdout=subprocess.PIPE,
                               bufsize=frame_bytes * 4)
        enc = subprocess.Popen(enc_cmd, stdin=subprocess.PIPE)
        wd_begin, wd_end, wd_stop, wd_beat = start_decode_watchdog(
            dec, suspend_flag=str(args.output) + '.v2xsuspended', enc_proc=enc)

        def read_frame():
            wd_begin()
            buf = dec.stdout.read(frame_bytes)
            wd_end()
            if not buf or len(buf) < frame_bytes:
                return None
            return np.frombuffer(buf, np.uint8).reshape(H, W, 3)

        def write_frame(t):
            arr = (t.clamp_(0, 1) * 255.0).round().to(torch.uint8)
            wd_begin()
            try:
                enc.stdin.write(arr.permute(1, 2, 0).contiguous().cpu().numpy().tobytes())
            finally:
                wd_end()

        next_read = seek_frame
        pending = []
        eof = False  # 解码器提前 EOF（源尾部损坏/帧数虚报）
        with torch.no_grad():
            while written < seg_end:
                chunk = list(pending)
                s = next_read - len(pending)
                while len(chunk) < args.chunk and next_read < seg_end and not eof:
                    f = read_frame()
                    if f is None:
                        eof = True
                        break
                    next_read += 1
                    chunk.append(torch.from_numpy(f.copy()).permute(2, 0, 1))
                if not chunk:
                    break
                if len(chunk) == 1:  # SPyNet 需要至少 2 帧
                    chunk.append(chunk[0].clone())

                lqs = torch.stack(chunk, dim=0)[None].float().div_(255.0).to(device)
                wd_beat()  # 推理心跳：kernel 挂死时心跳停止，看门狗将自动退出
                out = infer(lqs)
                t_len = out.shape[1]

                # EOF 必须视同末块：否则 pending 帧会被无限重复推理（死循环）
                is_last_chunk = eof or next_read >= seg_end
                take_from = max(0, written - s)
                take_to = t_len if is_last_chunk else t_len - args.overlap
                if take_to <= take_from:      # 异常短块兜底
                    take_to = t_len

                for i in range(take_from, take_to):
                    if written >= seg_end:
                        break
                    write_frame(out[0, i])
                    written += 1
                    if written % 5 == 0 or written == seg_end:
                        emit_progress()
                del out, lqs

                if is_last_chunk:
                    break
                pending = chunk[-args.overlap:]

        if eof and next_read < seg_end:
            log(f'警告: 源在第 {next_read} 帧后无可解码内容（尾部损坏或封装帧数虚报），'
                f'本段只产出 {written - seg_start} 帧，比预期少 {seg_end - next_read} 帧')

        try:
            enc.stdin.close()
        except BrokenPipeError:
            pass
        dec.stdout.close()
        dec.wait()
        wd_stop()
        rc = enc.wait()
        if rc != 0:
            fail(f'ffmpeg 分片编码器退出码 {rc}')
        if written > seg_start:
            # 空分片（源尾部损坏零产出）不落检查点：避免续跑跳过已被守卫删除的分片
            write_ckpt(seg_end)
        log(f'分片完成: {seg_start}-{seg_end} → {Path(seg_file).name}')

    # ---- 逐宏分片处理 ----
    total_out = TOTAL
    for seg_start in range(resume_from, TOTAL, seg_len):
        if pause_requested(out_path):
            log(f'收到暂停请求：停在检查点（已完成 {seg_start}/{TOTAL}，可续跑）')
            sys.exit(4)
        before = written
        run_segment(seg_start, min(seg_start + seg_len, TOTAL))
        if written == before:
            # 源在该分片起点已无可解码帧（尾部损坏）：删除空分片与残留检查点，提前收尾
            log(f'警告: 第 {seg_start} 帧起无可解码内容，按 {written} 帧提前收尾')
            total_out = seg_start
            for p in (seg_path(seg_start), str(ckpt_file)):
                try:
                    os.remove(p)
                except OSError:
                    pass
            break

    # ---- 合并分片（续跑时之前的分片已在盘上） ----
    if total_out == 0 or written == 0:
        fail('源文件完全无法解码（文件损坏或封装异常），没有可输出的帧。'
             '建议先用播放器确认源能正常播放。')

    expected = [seg_path(f) for f in range(0, total_out, seg_len)]
    missing = [p for p in expected if not os.path.exists(p)]
    if missing:
        fail(f'缺少 {len(missing)} 个分片，无法合并（如 {Path(missing[0]).name}）')

    list_file = out_path + '.mergelist.txt'
    with open(list_file, 'w', encoding='utf-8') as lf:
        for p in expected:
            lf.write("file '" + p.replace('\\', '/').replace("'", "'\\''") + "'\n")

    merge_cmd = [str(FFMPEG), '-y', '-hide_banner', '-loglevel', 'error',
                 '-f', 'concat', '-safe', '0', '-i', list_file]
    if meta['has_audio']:
        merge_cmd += ['-i', args.input, '-map', '0:v:0', '-map', '1:a?',
                      '-c:v', 'copy', '-c:a', 'copy', '-shortest']
    else:
        merge_cmd += ['-c:v', 'copy']
    merge_cmd += [out_path]
    m = subprocess.run(merge_cmd, capture_output=True)
    if m.returncode != 0 and meta['has_audio'] and '-c:a' in merge_cmd:
        # 源音频编码无法无损塞进目标容器（如 cook→mp4）：回退 AAC 转码重试一次，
        # 视频流仍保持 copy 无损，代价仅音频重编码
        log('音频无损拷贝进目标容器失败，回退 AAC 转码后重新合并')
        merge_cmd[merge_cmd.index('-c:a') + 1] = 'aac'
        m = subprocess.run(merge_cmd, capture_output=True)
    if m.returncode != 0:
        err = (m.stderr or b'').decode('utf-8', errors='replace')
        fail(f'分片合并失败: {err[:300]}（分片已保留，可重新运行续合并）')

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
    log(f'完成: {args.output}（{written} 帧）')


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        fail(str(e))
