// Shared types for Video2X Studio

export type ProcessorKind =
    | 'lanczos' | 'libplacebo' | 'realesrgan' | 'realcugan' | 'rife' | 'span'
    | 'realbasicvsr' | 'seedvr2';

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
    recalculatePts: boolean;
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
    nameTemplate: string; // {name} {ext}
    container: string;
    processor: ProcessorConfig;
    enhance: EnhanceConfig;
    encoder: EncoderConfig;
    advanced: AdvancedConfig;
}

export interface GpuDevice {
    index: number;
    name: string;
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
