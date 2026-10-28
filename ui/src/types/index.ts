// Shared types for Video2X Studio

export type ProcessorKind =
    | 'lanczos' | 'libplacebo' | 'realesrgan' | 'realcugan' | 'rife' | 'span'
    | 'realbasicvsr' | 'seedvr2' | 'swiftvr';

export type EngineKind = 'cli' | 'python';

export interface ProcessorConfig {
    kind: ProcessorKind;
    // libplacebo
    shader: string;
    // model-based processors
    realesrganModel: string;
    realcuganModel: string;
    realcuganThreads: number;
    realcuganSyncgap: number;
    rifeModel: string;
    rifeUhd: boolean;
    spanModel: string;
    // sizing
    sizeMode: 'scale' | 'explicit';
    scaleFactor: number;
    width: number;
    height: number;
    noiseLevel: number; // -1 = unset
    // interpolation
    frameRateMul: number;
    sceneThresh: number;
    // SeedVR2（0 = 输入短边×4）
    seedvr2Resolution: number;
    // SwiftVR 目标短边（0 = 输入短边×2，最高 1440）
    swiftvrResolution: number;
}

export interface EnhanceConfig {
    stab: boolean;
    stabShakiness: number;
    stabSmoothing: number;
    denoise: boolean;
    denoiseAlgo: string;
    denoiseLuma: number;
    hdr: boolean;
    hdrFormat: string;
    hdrPeak: number;
}

export interface EncoderConfig {
    codec: string;
    customCodec: string;
    pixFmt: string;
    bitRate: number; // 0 = auto
    crf: number; // -1 = unset (passed via -e crf=)
    extraOpts: { key: string; value: string }[];
    copyAudio: boolean;
    copySubs: boolean;
    /** 按帧序号重排时间戳（强制恒定帧率）。默认关：保留源时间戳，可变帧率源才能音画同步。
     *  字段改名自旧的 recalculatePts（默认开），使已持久化的旧值失效、回落到新默认 */
    forceCfr: boolean;
}

export interface AdvancedConfig {
    /** ncnn CLI 的 Vulkan 设备序号（video2x.exe -l 枚举） */
    deviceIndex: number;
    /** 旗舰引擎（PyTorch）的 CUDA 设备序号：与 Vulkan 编号空间相互独立 */
    cudaDeviceIndex: number;
    hwaccel: string;
    benchmark: boolean;
    logLevel: string;
    /** 网络盘/高风险封装先落地本地再处理（默认开启） */
    autoStage: boolean;
}

export interface JobRequest {
    files: string[];
    outputDir: string;
    nameTemplate: string; // {name} {proc} {ext}
    container: string;
    processor: ProcessorConfig;
    enhance: EnhanceConfig;
    encoder: EncoderConfig;
    advanced: AdvancedConfig;
}

export interface GpuDevice {
    index: number;
    name: string;
    /** Vulkan 设备类型（Discrete GPU / Integrated GPU…）；CUDA 枚举无此字段，MPS 为 'mps' */
    type?: string;
    /** CUDA 枚举附带的显存容量（GB）；MPS 为 PyTorch 在本机可用的上限 */
    vramGb?: number;
    /** MPS：整机统一内存（GB） */
    memGb?: number;
}

export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'aborted';

/** 运行中任务的内部阶段：staging=本地暂存预处理，processing=正式增强 */
export type JobPhase = 'staging' | 'processing' | null;

export interface Job {
    id: number;
    batchId: number;
    file: string;
    fileName: string;
    outPath: string;
    args: string[];
    engine: EngineKind;
    status: JobStatus;
    phase?: JobPhase;
    stagedPath?: string | null;
    progress: number;
    fps: number;
    remaining: string;
    frame: number;
    totalFrames: number;
    error: string | null;
    canResume?: boolean;
    suspended?: boolean;
    pauseRequested?: boolean;
    logTail: string[];
    createdAt: number;
    startedAt: number | null;
    finishedAt: number | null;
}

export interface PythonEngineStatus {
    exeExists: boolean;
    realbasicvsrWeights: boolean;
    seedvr2Weights: boolean;
    swiftvrWeights?: boolean;
    /** 本平台已完成移植的引擎（旧版 bridge 无此字段：视为全部支持） */
    supported?: string[];
}

// ---------------------------------------------------------------------------
// 组件资产（自动下载）
// ---------------------------------------------------------------------------
export interface AssetFileStatus {
    rel: string;
    exists: boolean;
    size: number;
    expectedSize: number | null;
    ok: boolean;
}

export interface AssetStatus {
    id: string;
    name: string;
    installed: boolean;
    files: AssetFileStatus[];
}

export interface AssetDownloadState {
    active: string | null;
    file: string | null;
    mirror: string | null;
    received: number;
    total: number;
    error: string | null;
}

export interface AssetsState extends AssetDownloadState {
    assets: AssetStatus[];
    /** 客户端估算的下载速度（字节/秒）与采样时刻，见 withDownloadSpeed */
    speed?: number;
    sampledAt?: number;
    install?: InstallStatus;
}

/** 程序本体完整性：随便携包分发、不提供下载的运行时文件（CLI / Python / FFmpeg / 模型目录） */
export interface InstallStatus {
    complete: boolean;
    /** false：未在 exe 附近找到 video2x.exe，根目录已回退 */
    rootFound: boolean;
    root: string;
    missing: string[];
}

export interface PrecheckWarning {
    level: 'warn' | 'error';
    text: string;
}

export interface PrecheckResponse {
    ok: boolean;
    warnings: PrecheckWarning[];
    probe: {
        width: number; height: number; fps: number;
        frames: number; duration: number; hasAudio: boolean;
    };
}
