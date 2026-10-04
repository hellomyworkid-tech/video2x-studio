// API client + SSE job stream for Video2X Studio

import type {
    AssetsState, GpuDevice, InstallStatus, Job, JobRequest, PrecheckResponse, PythonEngineStatus,
} from '@/types';
import { buildArgsForFile, buildOutputPath, buildPythonArgs, engineFor } from '@/lib/args';

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, init);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `请求失败（${res.status}）`);
    return body as T;
}

export const api = {
    health: () => jsonFetch<{
        ok: boolean; cliPath: string; cliExists: boolean;
        pythonEngine: PythonEngineStatus;
        install?: InstallStatus;
    }>('/api/health'),

    devices: () => jsonFetch<{ devices: GpuDevice[] }>('/api/devices'),

    // CUDA 设备枚举（旗舰引擎专用）：编号空间与 Vulkan 相互独立，不可混用
    cudaDevices: () => jsonFetch<{ devices: GpuDevice[] }>('/api/cuda-devices'),

    browse: (kind: 'open' | 'save' | 'dir') =>
        jsonFetch<{ files: string[] }>('/api/browse', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind }),
        }),

    jobs: () => jsonFetch<{ jobs: Job[] }>('/api/jobs'),

    submitBatch: async (req: JobRequest) => {
        const engine = engineFor(req.processor.kind);
        const items = req.files.map((file) => {
            const outPath = buildOutputPath(req, file);
            const args = engine === 'python'
                ? buildPythonArgs(req, file, outPath)
                : buildArgsForFile(req, file, outPath);
            return { file, outPath, args, engine, autoStage: req.advanced.autoStage };
        });
        return jsonFetch<{ batchId: number; jobs: Job[] }>('/api/jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items }),
        });
    },

    abortJob: (id: number) =>
        jsonFetch<{ ok: boolean }>(`/api/jobs/${id}/abort`, { method: 'POST' }),

    pauseJob: (id: number) =>
        jsonFetch<{ ok: boolean }>(`/api/jobs/${id}/pause`, { method: 'POST' }),

    unpauseJob: (id: number) =>
        jsonFetch<{ ok: boolean }>(`/api/jobs/${id}/unpause`, { method: 'POST' }),

    suspendJob: (id: number) =>
        jsonFetch<{ ok: boolean }>(`/api/jobs/${id}/suspend`, { method: 'POST' }),

    unsuspendJob: (id: number) =>
        jsonFetch<{ ok: boolean }>(`/api/jobs/${id}/unsuspend`, { method: 'POST' }),

    resumeJob: (id: number) =>
        jsonFetch<{ ok: boolean; checkpoint: boolean }>(`/api/jobs/${id}/resume`, { method: 'POST' }),

    cancelPending: () =>
        jsonFetch<{ ok: boolean; count: number }>('/api/jobs/cancel-pending', { method: 'POST' }),

    resumeAll: () =>
        jsonFetch<{ ok: boolean; count: number }>('/api/jobs/resume-all', { method: 'POST' }),

    openFolder: (id: number) =>
        jsonFetch<{ ok: boolean }>(`/api/jobs/${id}/open-folder`, { method: 'POST' }),

    /** 在资源管理器中打开日志目录（cache/logs，按天一个文件，保留 7 天） */
    openLogs: () => jsonFetch<{ ok: boolean; dir: string }>('/api/logs/open', { method: 'POST' }),

    residual: (id: number) =>
        jsonFetch<{ status: string; canResume: boolean; residuals: { path: string; size: number; kind: string }[] }>(`/api/jobs/${id}/residual`),

    residuals: () =>
        jsonFetch<{ items: { id: number; fileName: string; status: string; canResume: boolean; residuals: { path: string; size: number; kind: string }[] }[] }>('/api/jobs/residuals'),

    deleteJob: (id: number, mode: 'record' | 'all' = 'record') =>
        jsonFetch<{ ok: boolean; deletedFiles: number }>(`/api/jobs/${id}/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode }),
        }),

    clearFinished: (mode: 'record' | 'all' = 'record') =>
        jsonFetch<{ ok: boolean; cleared: number; deletedFiles: number }>('/api/jobs/clear-finished', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode }),
        }),

    assets: () => jsonFetch<AssetsState>('/api/assets'),

    downloadAsset: (id: string) =>
        jsonFetch<{ ok: boolean; started?: boolean; already?: boolean }>('/api/assets/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
        }),

    precheck: (file: string, model: string, opts: { outDir: string; forceCfr: boolean; autoStage: boolean }) =>
        jsonFetch<PrecheckResponse>('/api/jobs/precheck', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file, model, ...opts }),
        }),

    expand: (paths: string[]) =>
        jsonFetch<{ files: string[]; truncated: boolean }>('/api/expand', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths }),
        }),
};

// Subscribe to the job stream; returns an unsubscribe function.
export function subscribeJobs(onJobs: (jobs: Job[]) => void): () => void {
    let es: EventSource | null = null;
    let stopped = false;
    let lastEventAt = Date.now();

    const connect = () => {
        if (stopped) return;
        lastEventAt = Date.now();
        es = new EventSource('/api/events');
        es.addEventListener('jobs', (ev) => {
            lastEventAt = Date.now();
            try {
                onJobs(JSON.parse((ev as MessageEvent).data));
            } catch { /* ignore malformed payloads */ }
        });
        es.addEventListener('ping', () => { lastEventAt = Date.now(); });
        es.onerror = () => {
            es?.close();
            es = null;
            if (!stopped) setTimeout(connect, 2000); // auto-reconnect
        };
    };
    connect();

    // 45s 无任何事件（含心跳）判定连接假死（系统休眠恢复后的典型场景），
    // 主动重连；重连后 bridge 会立即补发全量快照，界面自动追上真实状态
    const watchdog = setInterval(() => {
        if (!stopped && Date.now() - lastEventAt > 45000) {
            es?.close();
            es = null;
            connect();
        }
    }, 15000);

    return () => {
        stopped = true;
        clearInterval(watchdog);
        es?.close();
    };
}

// Subscribe to asset download progress; returns an unsubscribe function.
/**
 * 由相邻两次推送的 received 差值估算下载速度。在 SSE 事件回调里计算（而非渲染期或
 * effect 里），既能调用 Date.now()，也不必在 effect 中同步 setState。
 */
export function withDownloadSpeed(prev: AssetsState | null, next: AssetsState): AssetsState {
    const now = Date.now();
    if (!next.active) return { ...next, speed: 0, sampledAt: now };
    const sameFile = prev?.active === next.active && prev?.file === next.file;
    if (sameFile && prev?.sampledAt && next.received > prev.received) {
        const dt = (now - prev.sampledAt) / 1000;
        if (dt > 0) return { ...next, speed: (next.received - prev.received) / dt, sampledAt: now };
    }
    // 同一文件但字节数没变：沿用上次的速度与采样点
    return sameFile ? { ...next, speed: prev?.speed ?? 0, sampledAt: prev?.sampledAt ?? now }
        : { ...next, speed: 0, sampledAt: now };
}

export function subscribeAssets(onState: (s: AssetsState) => void): () => void {
    let es: EventSource | null = null;
    let stopped = false;
    let lastEventAt = Date.now();

    const connect = () => {
        if (stopped) return;
        lastEventAt = Date.now();
        es = new EventSource('/api/events');
        es.addEventListener('assets', (ev) => {
            lastEventAt = Date.now();
            try {
                onState(JSON.parse((ev as MessageEvent).data));
            } catch { /* ignore malformed payloads */ }
        });
        es.addEventListener('ping', () => { lastEventAt = Date.now(); });
        es.onerror = () => {
            es?.close();
            es = null;
            if (!stopped) setTimeout(connect, 3000);
        };
    };
    connect();

    const watchdog = setInterval(() => {
        if (!stopped && Date.now() - lastEventAt > 45000) {
            es?.close();
            es = null;
            connect();
        }
    }, 15000);

    return () => {
        stopped = true;
        clearInterval(watchdog);
        es?.close();
    };
}
