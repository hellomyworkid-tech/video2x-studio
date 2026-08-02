// Builds video2x CLI argument lists from UI configuration.
// Kept strictly in sync with tools/video2x (see video2x.exe --help).

import type { EngineKind, JobRequest, ProcessorKind } from '@/types';

export const PYTHON_PROCESSORS: ProcessorKind[] = ['realbasicvsr', 'seedvr2'];

/** 决定一个处理器由哪条引擎链路执行：ncnn CLI 还是 Python sidecar */
export function engineFor(kind: ProcessorKind): EngineKind {
    return PYTHON_PROCESSORS.includes(kind) ? 'python' : 'cli';
}

/** Python sidecar（worker.py）参数构建：仅编码器/CRF/分段/设备 生效 */
export function buildPythonArgs(req: JobRequest, inputPath: string, outputPath: string): string[] {
    const p = req.processor;
    const enc = req.encoder;
    const codec = enc.codec === 'custom' ? (enc.customCodec.trim() || 'libx264') : (enc.codec || 'libx264');
    const args = ['--model', p.kind, '-i', inputPath, '-o', outputPath,
        '--codec', codec, '--crf', String(enc.crf >= 0 ? enc.crf : 18),
        // 旗舰引擎用 CUDA 编号空间（不可复用 Vulkan 的 deviceIndex，核显机上会错位）；
        // 旧持久化配置无此字段时回落 0
        '--device', `cuda:${req.advanced.cudaDeviceIndex ?? 0}`];
    if (p.kind === 'seedvr2') {
        args.push('--resolution', String(p.seedvr2Resolution > 0 ? p.seedvr2Resolution : 0));
    }
    return args;
}

export function buildArgsForFile(req: JobRequest, inputPath: string, outputPath: string): string[] {
    const args: string[] = ['-i', inputPath, '-o', outputPath];
    // Clamp processor params to the selected model's real capabilities first,
    // so batch templates can never produce an invalid scale/noise combo.
    const p = normalizeProcessor(req.processor);
    const e = req.enhance;
    const enc = req.encoder;
    const adv = req.advanced;

    args.push('-p', p.kind);
    args.push('-d', String(adv.deviceIndex));
    if (adv.hwaccel && adv.hwaccel !== 'none') {
        args.push('-a', adv.hwaccel);
    }

    // ---- processor-specific ----
    if (p.kind === 'lanczos') {
        // 纯缩放：倍率模式发 -s，指定分辨率模式发 -w/-h（CLI 两者都支持）
        if (p.sizeMode === 'explicit') {
            args.push('-w', String(p.width), '-h', String(p.height));
        } else {
            args.push('-s', String(p.scaleFactor));
        }
    } else if (p.kind === 'libplacebo') {
        args.push('--libplacebo-shader', p.shader);
        args.push('-w', String(p.width), '-h', String(p.height));
    } else if (p.kind === 'realesrgan') {
        args.push('--realesrgan-model', p.realesrganModel);
        args.push('-s', String(p.scaleFactor));
        if (p.noiseLevel >= 0) args.push('-n', String(p.noiseLevel));
    } else if (p.kind === 'realcugan') {
        args.push('--realcugan-model', p.realcuganModel);
        args.push('--realcugan-threads', String(p.realcuganThreads));
        args.push('--realcugan-syncgap', String(p.realcuganSyncgap));
        args.push('-s', String(p.scaleFactor));
        if (p.noiseLevel >= 0) args.push('-n', String(p.noiseLevel));
    } else if (p.kind === 'rife') {
        args.push('--rife-model', p.rifeModel);
        if (p.rifeUhd) args.push('--rife-uhd');
        args.push('-m', String(p.frameRateMul));
        args.push('-t', String(p.sceneThresh));
    } else if (p.kind === 'span') {
        args.push('--span-model', p.spanModel);
        args.push('-s', String(p.scaleFactor));
    }

    // ---- enhancement stages ----
    if (e.stab) {
        args.push('--stab', '--stab-shakiness', String(e.stabShakiness), '--stab-smoothing', String(e.stabSmoothing));
    }
    if (e.denoise) {
        args.push('--denoise', '--denoise-algo', e.denoiseAlgo, '--denoise-luma', String(e.denoiseLuma));
    }
    if (e.hdr) {
        args.push('--hdr', '--hdr-format', e.hdrFormat, '--hdr-peak', String(e.hdrPeak));
    }

    // ---- encoder ----
    const codec = enc.codec === 'custom' ? enc.customCodec.trim() : enc.codec;
    if (codec) args.push('-c', codec);
    if (enc.pixFmt) args.push('--pix-fmt', enc.pixFmt);
    if (enc.bitRate > 0) args.push('--bit-rate', String(enc.bitRate));
    if (!enc.copyAudio) args.push('--no-copy-audio-streams');
    if (!enc.copySubs) args.push('--no-copy-subtitle-streams');
    if (!enc.recalculatePts) args.push('--no-recalculate-pts');
    for (const [k, v] of qualityOpts(codec, enc.crf)) args.push('-e', `${k}=${v}`);
    for (const opt of enc.extraOpts) {
        if (opt.key.trim()) args.push('-e', `${opt.key.trim()}=${opt.value.trim()}`);
    }

    // ---- misc ----
    if (adv.benchmark) args.push('-b');
    if (adv.logLevel && adv.logLevel !== 'info') args.push('--log-level', adv.logLevel);
    // Progress is parsed from stdout; keep the bar enabled (default).

    return args;
}

/**
 * 恒定质量参数名因编码器而异，发错了 FFmpeg 只会打一条 warning 然后**静默忽略**，
 * 任务照常完成但质量控制完全失效（实测 hevc_nvenc 发 crf=20 时产物 112 MB，
 * 发正确的 cq=20 是 97 MB）。因此必须按编码器映射：
 *   crf                 —— libx264 / libx265 / libx264rgb / libaom-av1 / libvpx-vp9
 *   cq                  —— *_nvenc（N 卡硬编）
 *   qvbr_quality_level  —— *_amf（A 卡硬编），且需同时把 rc 切到 qvbr 才生效
 * 数值刻度三者接近（均 0–51，越小越好），可直接沿用同一个数字。
 */
export function qualityOpts(codec: string, crf: number): [string, string][] {
    if (crf < 0 || !codec) return [];
    const q = String(crf);
    if (/_nvenc$/.test(codec)) return [['cq', q]];
    if (/_amf$/.test(codec)) return [['rc', 'qvbr'], ['qvbr_quality_level', q]];
    // 其余（含自定义编码器）沿用 crf：x264/x265/AV1/VP9 系列都用它
    return [['crf', q]];
}

export function buildOutputPath(req: JobRequest, inputPath: string): string {
    const base = inputPath.replace(/\\/g, '/').split('/').pop() || 'output';
    const stem = base.replace(/\.[^.]+$/, '');
    const name = req.nameTemplate
        .replaceAll('{name}', stem)
        .replaceAll('{ext}', req.container);
    const dir = req.outputDir.replace(/[\\/]+$/, '');
    return `${dir}\\${name}`;
}

export function defaultJobRequest(): JobRequest {
    return {
        files: [],
        outputDir: '',
        nameTemplate: '{name}_v2x.{ext}',
        container: 'mp4',
        processor: {
            kind: 'libplacebo',
            shader: 'anime4k-v4-a+a',
            realesrganModel: 'realesr-animevideov3',
            realcuganModel: 'models-se',
            realcuganThreads: 1,
            realcuganSyncgap: 3,
            rifeModel: 'rife-v4.26',
            rifeUhd: false,
            spanModel: 'span',
            sizeMode: 'explicit',
            scaleFactor: 2,
            width: 1920,
            height: 1080,
            noiseLevel: -1,
            frameRateMul: 2,
            sceneThresh: 100,
            seedvr2Resolution: 0,
        },
        enhance: {
            stab: false,
            stabShakiness: 5,
            stabSmoothing: 15,
            denoise: false,
            denoiseAlgo: 'hqdn3d',
            denoiseLuma: 4,
            hdr: false,
            hdrFormat: 'pq',
            hdrPeak: 1000,
        },
        encoder: {
            codec: 'libx264',
            customCodec: '',
            pixFmt: '',
            bitRate: 0,
            crf: -1,
            extraOpts: [],
            copyAudio: true,
            copySubs: true,
            recalculatePts: true,
        },
        advanced: {
            deviceIndex: 0,
            cudaDeviceIndex: 0,
            hwaccel: 'none',
            benchmark: false,
            logLevel: 'info',
            autoStage: true,
        },
    };
}

// Option catalogs (mirrors video2x.exe --help)
export const SHADERS = [
    'anime4k-v4-a', 'anime4k-v4-a+a', 'anime4k-v4-b', 'anime4k-v4-b+b',
    'anime4k-v4-c', 'anime4k-v4-c+a', 'anime4k-v4.1-gan',
];
export const REALESRGAN_MODELS = [
    'realesr-animevideov3', 'realesrgan-plus-anime', 'realesrgan-plus',
    'realesr-generalv3', 'nomos8k', 'realwebphoto', 'nomos8k-compact',
];
export const REALCUGAN_MODELS = ['models-se', 'models-pro', 'models-nose'];
export const RIFE_MODELS = [
    // 便携包只随附这两个：v4.26 为项目默认（最新），v4.6 为社区公认的
    // 质量/稳定平衡点。其余版本仍可从源码树 models/rife/ 手动启用。
    'rife-v4.26', 'rife-v4.6',
];
export const SPAN_MODELS = ['span'];

// ---------------------------------------------------------------------------
// Model capability maps — verified against the weights actually shipped in
// models/ (param/bin files on disk) and the filename logic in
// src/filter_realesrgan.cpp / src/filter_realcugan.cpp.
// ---------------------------------------------------------------------------
export interface SrCaps {
    /** scales that have real weight files on disk */
    scales: number[];
    /** allowed noise levels for a given scale; null = 引擎不消费降噪参数（UI 隐藏控件） */
    noises: (scale: number) => number[] | null;
    /** noise level that always resolves to an existing weight file */
    defaultNoise: number;
}

// Real-ESRGAN: weights are {model}[-wdn]-x{scale}; -wdn exists only for
// realesr-generalv3-x4 and is selected whenever noise > 0.
export const ESRGAN_CAPS: Record<string, SrCaps> = {
    'realesr-animevideov3': { scales: [2, 3, 4], noises: () => null, defaultNoise: -1 },
    'realesrgan-plus-anime': { scales: [4], noises: () => null, defaultNoise: -1 },
    'realesrgan-plus': { scales: [4], noises: () => null, defaultNoise: -1 },
    'realesr-generalv3': { scales: [4], noises: () => [0, 1], defaultNoise: 0 }, // 1 → wdn 降噪变体
    'nomos8k': { scales: [4], noises: () => null, defaultNoise: -1 },
    'realwebphoto': { scales: [4], noises: () => null, defaultNoise: -1 },
    'nomos8k-compact': { scales: [2], noises: () => null, defaultNoise: -1 },
};

// Real-CUGAN: weights are up{scale}x-{conservative|no-denoise|denoiseNx}
// under models/realcugan/{model}/.
export const CUGAN_CAPS: Record<string, SrCaps> = {
    'models-se': { scales: [2, 3, 4], noises: (s) => (s === 2 ? [-1, 0, 1, 2, 3] : [-1, 0, 3]), defaultNoise: -1 },
    'models-pro': { scales: [2, 3], noises: () => [-1, 0, 3], defaultNoise: -1 },
    // models-nose 只有 up2x-no-denoise：必须强制 noise=0，否则引擎会去找不存在的 conservative 权重
    'models-nose': { scales: [2], noises: () => null, defaultNoise: 0 },
};

// SPAN: span-x2 / span-x4，无降噪参数
export const SPAN_CAPS: SrCaps = { scales: [2, 4], noises: () => null, defaultNoise: -1 };

// Lanczos：纯重采样，无模型无权重，任意整数倍率（也可切到指定分辨率模式）
export const LANCZOS_CAPS: SrCaps = { scales: [2, 3, 4], noises: () => null, defaultNoise: -1 };

// 重建档（Python sidecar）：固定 x4，无降噪档位（RealBasicVSR 内置时序清洁模块）
export const FLAGSHIP_CAPS: SrCaps = { scales: [4], noises: () => null, defaultNoise: -1 };

type ProcessorCfg = JobRequest['processor'];

export function capsFor(p: ProcessorCfg): SrCaps | null {
    if (p.kind === 'realesrgan') return ESRGAN_CAPS[p.realesrganModel] ?? null;
    if (p.kind === 'realcugan') return CUGAN_CAPS[p.realcuganModel] ?? null;
    if (p.kind === 'span') return SPAN_CAPS;
    // lanczos 在倍率模式下才受倍率钳制；指定分辨率模式用显式宽高
    if (p.kind === 'lanczos') return p.sizeMode === 'explicit' ? null : LANCZOS_CAPS;
    if (p.kind === 'realbasicvsr' || p.kind === 'seedvr2') return FLAGSHIP_CAPS;
    return null; // libplacebo 用显式宽高；rife 无缩放/降噪概念
}

/** 把处理器参数钳制到所选模型的真实能力范围内（切换模型后、提交任务前都要调用） */
export function normalizeProcessor(p: ProcessorCfg): ProcessorCfg {
    const caps = capsFor(p);
    if (!caps) return p;
    const next = { ...p };
    if (!caps.scales.includes(next.scaleFactor)) next.scaleFactor = caps.scales[0];
    const allowed = caps.noises(next.scaleFactor);
    if (allowed === null || !allowed.includes(next.noiseLevel)) {
        next.noiseLevel = caps.defaultNoise;
    }
    return next;
}

export const CUGAN_NOISE_LABELS: Record<number, string> = {
    [-1]: '保守 (conservative)',
    0: '关闭 (no-denoise)',
    1: '降噪 1x',
    2: '降噪 2x',
    3: '降噪 3x',
};
export const CODECS = [
    { value: 'libx264', label: 'H.264 (libx264) · 兼容优先' },
    { value: 'libx265', label: 'H.265 (libx265) · 体积优先 / HDR' },
    { value: 'libx264rgb', label: 'H.264 RGB (libx264rgb)' },
    { value: 'hevc_nvenc', label: 'H.265 N 卡硬编 (hevc_nvenc)' },
    { value: 'h264_nvenc', label: 'H.264 N 卡硬编 (h264_nvenc)' },
    { value: 'av1_nvenc', label: 'AV1 N 卡硬编 (av1_nvenc)' },
    { value: 'hevc_amf', label: 'H.265 A 卡硬编 (hevc_amf)' },
    { value: 'h264_amf', label: 'H.264 A 卡硬编 (h264_amf)' },
    { value: 'libaom-av1', label: 'AV1 (libaom-av1) · 慢但最省' },
    { value: 'libvpx-vp9', label: 'VP9 (libvpx-vp9)' },
    { value: 'custom', label: '自定义编码器…' },
];
export const PIX_FMTS = ['', 'yuv420p', 'yuv420p10le', 'yuv444p', 'p010le', 'rgb24'];
export const HWACCELS = [
    { value: 'none', label: '无（软件解码）· CPU 解码，兼容性最好' },
    { value: 'cuda', label: 'CUDA (NVIDIA) · N 卡专用，与推理同卡最高效' },
    { value: 'd3d11va', label: 'D3D11VA · Windows 通用，N/A/I 卡通吃' },
    { value: 'dxva2', label: 'DXVA2 · 旧接口，仅老系统兼容用' },
    { value: 'qsv', label: 'Intel QSV · Intel 核显专用' },
];
export const CONTAINERS = ['mp4', 'mkv', 'mov', 'avi', 'webm'];
export const LOG_LEVELS = ['info', 'warn', 'error', 'debug', 'trace'];
