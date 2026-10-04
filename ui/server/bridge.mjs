// Video2X Studio — local bridge server
// Bridges the web UI to the video2x CLI: device enumeration, native file
// dialogs, batch job queue, progress parsing, and SSE push.
// Zero external dependencies (Node >= 20).

import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Project root resolution order:
// 1. VIDEO2X_PROJECT_ROOT env
// 2. walk up from the portable-exe dir / cwd / exec dir looking for the CLI
// 3. dev fallback: ui/server/../..
function findProjectRoot() {
    if (process.env.VIDEO2X_PROJECT_ROOT) {
        return path.resolve(process.env.VIDEO2X_PROJECT_ROOT);
    }
    const cliRel = path.join('build-desktop', 'Release', 'video2x.exe');
    const starts = [];
    if (process.env.PORTABLE_EXECUTABLE_DIR) starts.push(process.env.PORTABLE_EXECUTABLE_DIR);
    starts.push(process.cwd(), path.dirname(process.execPath));
    for (const start of starts) {
        let dir = path.resolve(start);
        for (let i = 0; i < 6; i++) {
            if (fs.existsSync(path.join(dir, cliRel))) return dir;
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    }
    return path.resolve(__dirname, '..', '..');
}

const PROJECT_ROOT = findProjectRoot();
const PORT = Number(process.env.BRIDGE_PORT || 7199);
// Static frontend (production): built by `vite build` into ui/dist
const STATIC_DIR =
    process.env.VIDEO2X_STATIC_DIR || path.join(__dirname, '..', 'dist');

const CLI_PATH =
    process.env.VIDEO2X_CLI ||
    path.join(PROJECT_ROOT, 'build-desktop', 'Release', 'video2x.exe');

// Python sidecar (PyTorch engines: RealBasicVSR / SeedVR2)
// 优先使用随包携带的独立运行时 engine-python/python（便携版）；
// 不存在时回退到开发环境的 .venv
const PYTHON_BUNDLED = path.join(PROJECT_ROOT, 'engine-python', 'python', 'python.exe');
const PYTHON_EXE =
    process.env.VIDEO2X_PYTHON ||
    (fs.existsSync(PYTHON_BUNDLED)
        ? PYTHON_BUNDLED
        : path.join(PROJECT_ROOT, 'engine-python', '.venv', 'Scripts', 'python.exe'));
const PY_WORKER = path.join(PROJECT_ROOT, 'engine-python', 'worker.py');

// 进程树挂起/恢复（真暂停）：NtSuspendProcess 包装脚本，与本文件同目录
const SUSPEND_PS1 = path.join(__dirname, 'suspend_tree.ps1');
const PS_EXE = 'powershell.exe';
const PY_WEIGHTS = {
    realbasicvsr: path.join(PROJECT_ROOT, 'engine-python', 'weights', 'realbasicvsr_x4.pth'),
    seedvr2: path.join(PROJECT_ROOT, 'engine-python', 'weights', 'SeedVR2-3B', 'seedvr2_ema_3b_fp8_e4m3fn.safetensors'),
};

function pythonEngineStatus() {
    return {
        exeExists: fs.existsSync(PYTHON_EXE),
        realbasicvsrWeights: fs.existsSync(PY_WEIGHTS.realbasicvsr),
        seedvr2Weights: fs.existsSync(PY_WEIGHTS.seedvr2),
    };
}

const FFPROBE = path.join(PROJECT_ROOT, 'third_party', 'ffmpeg-shared', 'bin', 'ffprobe.exe');
const FFMPEG = path.join(PROJECT_ROOT, 'third_party', 'ffmpeg-shared', 'bin', 'ffmpeg.exe');

// ---------------------------------------------------------------------------
// 自动预处理（本地暂存）：网络盘或高风险封装的输入先落地再处理
// - UNC 路径（\\ 开头）：整文件拷贝到本地暂存（网络流式解码可能挂死）
// - rmvb/rm/wmv/asf/flv：先 remux 为 MKV（-c copy 无损），失败回退整文件拷贝
// 暂存文件名 = 源路径+大小+mtime 的哈希，天然去重，断点续跑自动复用
// ---------------------------------------------------------------------------
const CACHE_DIR = path.join(PROJECT_ROOT, 'cache');
const RISKY_EXTS = new Set(['.rmvb', '.rm', '.wmv', '.asf', '.flv']);
const VIDEO_EXTS = new Set([
    '.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv', '.wmv', '.m2ts', '.ts',
    '.mpg', '.mpeg', '.rmvb', '.rm', '.asf', '.vob', '.3gp', '.m4v',
]);

// ---------------------------------------------------------------------------
// 组件资产清单（自动下载 + 多镜像回退）
// verify: 'hash' = size+sha256 字节级校验；'load' = 用引擎真实加载路径验证
// 镜像按优先级排序：国内镜像在前，官方源在后；全部失败则报错
// ---------------------------------------------------------------------------
const HF = 'https://huggingface.co';
const HF_MIRROR = 'https://hf-mirror.com';
const RBVSR_REPO = '/akhaliq/RealBasicVSR_x4/resolve/main/RealBasicVSR_x4.pth';
const SEEDVR2_REPO = '/numz/SeedVR2_comfyUI/resolve/main/';

const ASSETS = [
    {
        id: 'realbasicvsr',
        name: 'RealBasicVSR 引擎权重',
        files: [
            {
                rel: path.join('engine-python', 'weights', 'spynet.pth'),
                size: 5770988,
                sha256: 'c6c1bd09b52d05ba17f3e701f549d6faf5e314aabce8ae462c1c171a8d6c4914',
                verify: 'hash',
                urls: [
                    'https://download.openmmlab.com/mmediting/restorers/basicvsr/spynet_20210409-c6c1bd09.pth',
                ],
            },
            {
                // 镜像仓权重与随包权重非同一份字节（训练检查点封装不同），
                // 因此不做哈希校验，改为下载后用引擎 loader 实际加载验证
                rel: path.join('engine-python', 'weights', 'realbasicvsr_x4.pth'),
                size: null,
                sha256: null,
                verify: 'load',
                urls: [HF_MIRROR + RBVSR_REPO, HF + RBVSR_REPO],
            },
        ],
    },
    // video2x.exe / NCNN models / Python 运行时随便携包分发，不提供自动下载
    {
        id: 'seedvr2',
        name: 'SeedVR2-3B 引擎权重（FP8）',
        files: [
            {
                rel: path.join('engine-python', 'weights', 'SeedVR2-3B', 'seedvr2_ema_3b_fp8_e4m3fn.safetensors'),
                size: 3391544696,
                sha256: '3bf1e43ebedd570e7e7a0b1b60d6a02e105978f505c8128a241cde99a8240cff',
                verify: 'hash',
                urls: [HF_MIRROR + SEEDVR2_REPO + 'seedvr2_ema_3b_fp8_e4m3fn.safetensors',
                       HF + SEEDVR2_REPO + 'seedvr2_ema_3b_fp8_e4m3fn.safetensors'],
            },
            {
                rel: path.join('engine-python', 'weights', 'SeedVR2-3B', 'ema_vae_fp16.safetensors'),
                size: 501324814,
                sha256: '20678548f420d98d26f11442d3528f8b8c94e57ee046ef93dbb7633da8612ca1',
                verify: 'hash',
                urls: [HF_MIRROR + SEEDVR2_REPO + 'ema_vae_fp16.safetensors',
                       HF + SEEDVR2_REPO + 'ema_vae_fp16.safetensors'],
            },
        ],
    },
];

function assetFileStatus(f) {
    const abs = path.join(PROJECT_ROOT, f.rel);
    let exists = false;
    let diskSize = 0;
    try {
        const st = fs.statSync(abs);
        exists = st.isFile();
        diskSize = st.size;
    } catch { /* missing */ }
    const sizeOk = exists && (f.size == null || diskSize === f.size);
    return { rel: f.rel, exists, size: diskSize, expectedSize: f.size, ok: sizeOk };
}

function assetsStatus() {
    return ASSETS.map((a) => {
        const files = a.files.map(assetFileStatus);
        return {
            id: a.id,
            name: a.name,
            installed: files.every((f) => f.ok),
            files,
        };
    });
}

// ---- 下载器（单任务串行；.part 断点续传；镜像自动回退；SSE 进度） ----
const dlState = {
    active: null,       // assetId | null
    file: null,         // 当前文件 rel
    mirror: null,
    received: 0,
    total: 0,
    error: null,
    doneAssets: [],
};

function broadcastAssets() {
    sseBroadcast('assets', {
        ...dlState,
        assets: assetsStatus(),
    });
}

function httpGetFollow(url, redirects, headers) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('http:') ? http : https;
        const req = mod.get(url, { headers }, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                const loc = res.headers.location;
                res.resume();
                if (!loc) return reject(new Error(`HTTP ${res.statusCode} 无跳转地址`));
                if (redirects <= 0) return reject(new Error('重定向次数过多'));
                const next = new URL(loc, url).toString();
                return resolve(httpGetFollow(next, redirects - 1, headers));
            }
            resolve(res);
        });
        req.on('error', reject);
        req.setTimeout(60000, () => req.destroy(new Error('连接超时（60s 无数据）')));
    });
}

/** 下载单个 URL → dest.part（支持续传），返回 {bytes, sha256}；失败抛错 */
async function downloadTo(url, destAbs, onProgress) {
    const part = destAbs + '.part';
    let resumeAt = 0;
    try {
        resumeAt = fs.statSync(part).size;
    } catch { /* no part */ }
    const headers = { 'User-Agent': 'video2x-studio/1.0' };
    if (resumeAt > 0) headers.Range = `bytes=${resumeAt}-`;
    const res = await httpGetFollow(url, 8, headers);
    if (res.statusCode === 416 && resumeAt > 0) {
        // 服务端认为已完整：流式重算哈希后返回
        res.resume();
        const h = crypto.createHash('sha256');
        await new Promise((resolve, reject) => {
            fs.createReadStream(part)
                .on('data', (c) => h.update(c))
                .on('end', resolve)
                .on('error', reject);
        });
        const sz = fs.statSync(part).size;
        return { bytes: sz, sha256: h.digest('hex') };
    }
    if (res.statusCode === 200 && resumeAt > 0) {
        // 服务端不支持 Range：从头重下
        resumeAt = 0;
    }
    if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume();
        throw new Error(`HTTP ${res.statusCode}`);
    }
    const total = res.statusCode === 206
        ? resumeAt + Number(res.headers['content-length'] || 0)
        : Number(res.headers['content-length'] || 0);
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    const out = fs.createWriteStream(part, { flags: resumeAt > 0 ? 'a' : 'w' });
    const hash = crypto.createHash('sha256');
    if (resumeAt > 0) {
        // 续传：先流式把已有部分喂进哈希（避免整文件入内存）
        await new Promise((resolve, reject) => {
            fs.createReadStream(part)
                .on('data', (c) => hash.update(c))
                .on('end', resolve)
                .on('error', reject);
        });
    }
    let received = resumeAt;
    let lastTick = 0;
    await new Promise((resolve, reject) => {
        res.on('data', (chunk) => {
            hash.update(chunk);
            received += chunk.length;
            const now = Date.now();
            if (now - lastTick > 300) {
                lastTick = now;
                onProgress(received, total);
            }
            if (!out.write(chunk)) {
                res.pause();
                out.once('drain', () => res.resume());
            }
        });
        res.on('end', resolve);
        res.on('error', reject);
        out.on('error', reject);
        res.socket?.on('timeout', () => reject(new Error('读取超时')));
    });
    await new Promise((r) => out.end(r));
    onProgress(received, total);
    return { bytes: received, sha256: hash.digest('hex') };
}

function verifyCheckpoint(ckptAbs, spynetAbs) {
    return new Promise((resolve) => {
        const script = path.join(PROJECT_ROOT, 'engine-python', 'verify_ckpt.py');
        execFile(PYTHON_EXE, [script, ckptAbs, spynetAbs || '-'],
            // 大权重 torch.load 在慢盘/杀软扫描下可能较久，超时给到 10 分钟
            { timeout: 600000, maxBuffer: 4 * 1024 * 1024 },
            (err, stdout) => {
                if (err && (err.killed || err.signal === 'SIGTERM')) {
                    // 超时被杀 ≠ 权重损坏：此时绝不能删文件（否则 500MB+ 权重被迫重下），
                    // 按"跳过验证"放行，真实损坏会在任务启动时报错
                    resolve({ ok: true, skipped: true, detail: '加载验证超时，已跳过' });
                    return;
                }
                const ok = !err && /VERIFY_OK/.test(String(stdout));
                resolve({ ok, detail: String(stdout).trim().slice(-300) });
            });
    });
}

async function downloadAsset(asset) {
    for (const f of asset.files) {
        const destAbs = path.join(PROJECT_ROOT, f.rel);
        if (assetFileStatus(f).ok) continue; // 已就位
        let lastErr = null;
        let done = false;
        for (const url of f.urls) {
            dlState.file = f.rel;
            dlState.mirror = new URL(url).hostname;
            dlState.received = 0;
            dlState.total = f.size || 0;
            broadcastAssets();
            try {
                const r = await downloadTo(url, destAbs, (received, total) => {
                    dlState.received = received;
                    if (total) dlState.total = total;
                    broadcastAssets();
                });
                // 校验
                if (f.verify === 'hash') {
                    if (f.size != null && r.bytes !== f.size) {
                        throw new Error(`大小不符（${r.bytes} ≠ ${f.size}）`);
                    }
                    if (f.sha256 && r.sha256 !== f.sha256) {
                        throw new Error('SHA-256 校验不符（文件损坏或镜像内容被替换）');
                    }
                }
                const part = destAbs + '.part';
                fs.renameSync(part, destAbs);
                if (f.verify === 'load') {
                    dlState.mirror = '校验中…';
                    broadcastAssets();
                    const spy = path.join(PROJECT_ROOT, 'engine-python', 'weights', 'spynet.pth');
                    const v = await verifyCheckpoint(destAbs, fs.existsSync(spy) ? spy : null);
                    if (!v.ok) {
                        try { fs.unlinkSync(destAbs); } catch { /* ignore */ }
                        throw new Error(`引擎加载验证未通过：${v.detail || '未知原因'}`);
                    }
                }
                done = true;
                break;
            } catch (e) {
                lastErr = e;
                dlState.error = `${path.basename(f.rel)} @ ${dlState.mirror}: ${e.message}`;
                broadcastAssets();
                // 换下一个镜像
            }
        }
        if (!done) {
            throw new Error(`${asset.name} 下载失败：${lastErr ? lastErr.message : '无可用镜像'}`);
        }
    }
}

// DLL search paths required by video2x.exe at runtime
const DLL_DIRS = [
    path.join(PROJECT_ROOT, 'build-desktop', 'Release'),
    path.join(PROJECT_ROOT, 'third_party', 'ffmpeg-shared', 'bin'),
    path.join(PROJECT_ROOT, 'third_party', 'ncnn-shared', 'x64', 'bin'),
    path.join(PROJECT_ROOT, 'build-desktop', 'third_party', 'librealcugan_ncnn_vulkan', 'src', 'Release'),
    path.join(PROJECT_ROOT, 'build-desktop', 'third_party', 'librealesrgan_ncnn_vulkan', 'src', 'Release'),
    path.join(PROJECT_ROOT, 'build-desktop', 'third_party', 'librife_ncnn_vulkan', 'src', 'Release'),
    path.join(PROJECT_ROOT, 'build-desktop', 'third_party', 'spdlog', 'Release'),
    path.join(PROJECT_ROOT, 'build-desktop', 'third_party', 'boost', 'libs', 'program_options', 'Release'),
];

// ---------------------------------------------------------------------------
// Job store
// ---------------------------------------------------------------------------
let nextJobId = 1;
let nextBatchId = 1;
const jobs = new Map(); // id -> job
const jobOrder = []; // creation order
let runnerActive = false;

// ---------------------------------------------------------------------------
// 任务持久化：记录落盘 cache/jobs.json，程序重启/崩溃后队列不丢
// ---------------------------------------------------------------------------
const JOBS_FILE = path.join(CACHE_DIR, 'jobs.json');
let persistTimer = null;

function persistJobs() {
    if (persistTimer) return; // 合并高频进度广播，1.2s 落一次
    persistTimer = setTimeout(() => {
        persistTimer = null;
        try {
            fs.mkdirSync(CACHE_DIR, { recursive: true });
            const data = {
                nextJobId,
                nextBatchId,
                jobs: jobOrder.map((id) => {
                    const j = jobs.get(id);
                    return { ...j, child: undefined, log: (j.log || []).slice(-100) };
                }),
            };
            const tmp = JOBS_FILE + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(data));
            fs.renameSync(tmp, JOBS_FILE);
        } catch { /* 落盘失败不影响运行 */ }
    }, 1200);
}

function loadJobs() {
    let data;
    try {
        data = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
    } catch { return; }
    if (!data || !Array.isArray(data.jobs)) return;
    for (const j of data.jobs) {
        if (!j || typeof j.id !== 'number') continue;
        j.child = undefined;
        j.suspended = false;
        j.pauseRequested = false;
        // 清理残留旗标：遗留的挂起旗标会永久豁免看门狗，必须清掉
        if (j.outPath) {
            try { fs.unlinkSync(j.outPath + '.v2xsuspended'); } catch { /* best effort */ }
            try { fs.unlinkSync(j.outPath + '.v2xpause'); } catch { /* best effort */ }
        }
        if (j.status === 'running') {
            // 上次程序退出时任务被中断；断点（若有）仍在磁盘上，可续跑/重跑
            j.status = 'aborted';
            j.error = '程序退出导致任务中断；断点已保留，可续跑或重跑';
            j.finishedAt = Date.now();
            if (Array.isArray(j.log)) {
                j.log.push('[bridge] 程序重启：运行中的任务已标记为中断，可续跑/重跑');
            }
        }
        jobs.set(j.id, j);
        jobOrder.push(j.id);
    }
    nextJobId = Math.max(Number(data.nextJobId) || 1, ...[...jobs.keys()].map((i) => i + 1), 1);
    nextBatchId = Number(data.nextBatchId) || 1;
    if (jobs.size > 0) {
        console.log(`[bridge] 已恢复 ${jobs.size} 条任务记录（cache/jobs.json）`);
    }
}

const sseClients = new Set();

function sseBroadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
        try { res.write(payload); } catch { /* client gone */ }
    }
}

function publicJob(job) {
    return {
        id: job.id,
        batchId: job.batchId,
        file: job.file,
        fileName: path.basename(job.file),
        outPath: job.outPath,
        args: job.args,
        engine: job.engine || 'cli',
        status: job.status, // pending | running | done | failed | aborted
        phase: job.phase || null, // staging | processing（仅运行中有意义）
        stagedPath: job.stagedPath || null,
        progress: job.progress,
        fps: job.fps,
        remaining: job.remaining,
        frame: job.frame,
        totalFrames: job.totalFrames,
        error: job.error,
        canResume: canResume(job),
        suspended: !!job.suspended,
        pauseRequested: !!job.pauseRequested,
        logTail: job.log.slice(-200),
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
    };
}

// ---------------------------------------------------------------------------
// 断点续跑 / 残余文件（服务端是唯一事实来源，删除规则在此强制）
// ---------------------------------------------------------------------------
function ckptPath(job) {
    return job.outPath + '.v2xckpt.json';
}

function listResiduals(job) {
    // 返回该任务可能留下的产物：半成品输出、分片、检查点、本地暂存副本
    // （均按我们自己的命名规则匹配）
    const out = [];
    try {
        if (job.outPath && fs.existsSync(job.outPath) && fs.statSync(job.outPath).isFile()) {
            out.push({ path: job.outPath, size: fs.statSync(job.outPath).size, kind: 'output' });
        }
    } catch { /* ignore */ }
    try {
        if (fs.existsSync(ckptPath(job))) {
            out.push({ path: ckptPath(job), size: fs.statSync(ckptPath(job)).size, kind: 'ckpt' });
        }
        if (fs.existsSync(job.outPath + '.v2xpause')) {
            const p = job.outPath + '.v2xpause';
            out.push({ path: p, size: fs.statSync(p).size, kind: 'pause-flag' });
        }
    } catch { /* ignore */ }
    try {
        const dir = path.dirname(job.outPath);
        const base = path.basename(job.outPath);
        for (const name of fs.readdirSync(dir)) {
            if (name.startsWith(base + '.seg') && name.endsWith('.mp4')) {
                const p = path.join(dir, name);
                out.push({ path: p, size: fs.statSync(p).size, kind: 'seg' });
            }
        }
    } catch { /* ignore */ }
    try {
        if (job.stagedPath && fs.existsSync(job.stagedPath)) {
            out.push({ path: job.stagedPath, size: fs.statSync(job.stagedPath).size, kind: 'stage' });
        }
    } catch { /* ignore */ }
    return out;
}

function canResume(job) {
    if (job.engine !== 'python') return false;
    if (job.status !== 'failed' && job.status !== 'aborted') return false;
    if (!job.args.includes('realbasicvsr') && !job.args.includes('seedvr2')) return false;
    try {
        return fs.existsSync(ckptPath(job));
    } catch {
        return false;
    }
}

/** 安全删除残余文件：仅允许删除失败/中止任务的产物，且绝不触碰输入源文件 */
function deleteResiduals(job) {
    if (job.status !== 'failed' && job.status !== 'aborted') {
        return { deleted: [], skipped: '任务状态不允许删除文件' };
    }
    const inputResolved = path.resolve(job.file);
    const deleted = [];
    for (const r of listResiduals(job)) {
        // 双保险：解析后的绝对路径等于输入文件时跳过，防止任何误删源文件的可能
        if (path.resolve(r.path) === inputResolved) continue;
        // 三保险：同一来源的多个任务共享同一 stage_<hash> 暂存副本，
        // 只要还有其他任务在引用该暂存（含 pending/running/已完成的复用），就不删
        if (r.kind === 'stage') {
            const inUse = [...jobs.values()].some((o) =>
                o.id !== job.id && o.stagedPath &&
                path.resolve(o.stagedPath) === path.resolve(r.path));
            if (inUse) continue;
        }
        try {
            fs.unlinkSync(r.path);
            deleted.push(r.path);
        } catch { /* 文件被占用等情况：跳过但不阻断记录删除 */ }
    }
    return { deleted };
}

/** 应用退出前调用：同步强杀所有活动子进程树，防止 worker/ffmpeg 成为孤儿占用显存 */
export function shutdownBridge() {
    for (const job of jobs.values()) {
        if (job.status === 'running' && job.child && job.child.pid) {
            try {
                // spawnSync 保证在 before-quit 短暂窗口内完成
                spawnSync('taskkill', ['/pid', String(job.child.pid), '/t', '/f'],
                    { windowsHide: true, timeout: 8000 });
            } catch { /* best effort */ }
        }
    }
}

function broadcastJobs() {
    sseBroadcast('jobs', jobOrder.map((id) => publicJob(jobs.get(id))));
    persistJobs();
}

// ---------------------------------------------------------------------------
// Runner — serial queue (GPU workloads should not run concurrently)
// ---------------------------------------------------------------------------
const PROGRESS_RE = /frame=(\d+)\/(\d+) \(([\d.]+)%\); fps=([\d.]+); elapsed=(\S+); remaining=(\S+)/;

// ---------------------------------------------------------------------------
// 自动预处理：网络盘 / 高风险封装 → 本地暂存
// ---------------------------------------------------------------------------
function inputStat(file) {
    try {
        const st = fs.statSync(file);
        return { size: st.size, mtime: Math.floor(st.mtimeMs) };
    } catch {
        return { size: 0, mtime: 0 };
    }
}

function needsStaging(job) {
    if (job.autoStage === false) return false;
    if (/^\\\\/.test(job.file)) return true; // UNC 网络路径
    return RISKY_EXTS.has(path.extname(job.file).toLowerCase());
}

function stagedPathFor(job) {
    const h = crypto.createHash('sha1')
        .update(`${path.resolve(job.file)}|${job.fileSize}|${job.fileMtime}`)
        .digest('hex').slice(0, 12);
    const risky = RISKY_EXTS.has(path.extname(job.file).toLowerCase());
    const ext = risky ? '.mkv' : path.extname(job.file).toLowerCase();
    return path.join(CACHE_DIR, `stage_${h}${ext}`);
}

/** 整文件拷贝（带进度与中止支持），写 .part 完成后改名 */
function copyWithProgress(job, dest) {
    return new Promise((resolve, reject) => {
        const part = dest + '.part';
        const total = Math.max(1, job.fileSize);
        let copied = 0;
        let lastTick = 0;
        const rs = fs.createReadStream(job.file);
        const ws = fs.createWriteStream(part);
        const onAbort = setInterval(() => {
            if (job.abortRequested) {
                rs.destroy();
                ws.destroy();
                try { fs.unlinkSync(part); } catch { /* ignore */ }
                clearInterval(onAbort);
                reject(new Error('已被用户中止'));
            }
        }, 300);
        rs.on('data', (c) => {
            copied += c.length;
            const now = Date.now();
            if (now - lastTick > 300) {
                lastTick = now;
                job.progress = Math.min(99, (copied / total) * 100);
                job.remaining = `${(copied / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB`;
                broadcastJobs();
            }
        });
        rs.on('error', (e) => { clearInterval(onAbort); reject(new Error(`读取源文件失败：${e.message}`)); });
        ws.on('error', (e) => { clearInterval(onAbort); reject(new Error(`写入暂存失败：${e.message}`)); });
        ws.on('finish', () => {
            clearInterval(onAbort);
            try {
                fs.renameSync(part, dest);
                job.progress = 100;
                resolve();
            } catch (e) {
                reject(new Error(`暂存改名失败：${e.message}`));
            }
        });
        rs.pipe(ws);
    });
}

/** remux 为 MKV，带 -progress 解析；失败抛错由调用方回退。
 *  transcodeAudio=false：-c copy 全流无损（RMVB 的 cook 音频 MKV 不支持会失败）
 *  transcodeAudio=true ：视频 copy 无损 + 音频转 AAC（cook 音频的兜底）
 *  注意输出必须显式 -f matroska：目标是 .part 临时文件，
 *  ffmpeg 无法从扩展名推断封装格式时会报 Invalid argument 直接失败 */
function remuxToMkv(job, dest, transcodeAudio) {
    return new Promise(async (resolve, reject) => {
        // 先探测时长用于进度估算
        let duration = 0;
        try {
            const out = await new Promise((res, rej) => {
                execFile(FFPROBE, ['-v', 'quiet', '-print_format', 'json', '-show_format', job.file],
                    { timeout: 120000 }, (e, stdout) => (e ? rej(e) : res(stdout)));
            });
            duration = Number(JSON.parse(out).format?.duration || 0);
        } catch { /* 探测失败也继续尝试 remux */ }
        const part = dest + '.part';
        const child = spawn(FFMPEG, [
            '-y', '-hide_banner', '-loglevel', 'error',
            '-i', job.file,
            // 只取第一个视频流 + 可选音频：RMVB 等封装常带异常数据流，
            // -map 0 全量映射会让 MKV 封装器初始化失败（Invalid argument）
            '-map', '0:v:0', '-map', '0:a?',
            ...(transcodeAudio ? ['-c:v', 'copy', '-c:a', 'aac'] : ['-c', 'copy']),
            '-progress', 'pipe:1', '-nostats', '-f', 'matroska', part,
        ], { windowsHide: true });
        job.child = child; // 复用中止端点的 taskkill
        let lastTick = 0;
        let errTail = '';
        const onLine = (chunk) => {
            const text = chunk.toString('utf8');
            errTail = (errTail + text).slice(-500);
            for (const m of text.matchAll(/out_time_us=(\d+)/g)) {
                const us = Number(m[1]);
                if (duration > 0) {
                    const now = Date.now();
                    if (now - lastTick > 300) {
                        lastTick = now;
                        job.progress = Math.min(99, (us / 1e6 / duration) * 100);
                        job.remaining = `${(us / 1e6).toFixed(0)} / ${duration.toFixed(0)} s`;
                        broadcastJobs();
                    }
                }
            }
        };
        child.stdout.on('data', onLine);
        child.stderr.on('data', onLine);
        child.on('error', reject);
        child.on('close', (code) => {
            job.child = undefined;
            if (job.abortRequested) {
                try { fs.unlinkSync(part); } catch { /* ignore */ }
                return reject(new Error('已被用户中止'));
            }
            if (code !== 0) {
                try { fs.unlinkSync(part); } catch { /* ignore */ }
                return reject(new Error(`remux 退出码 ${code}：${errTail.slice(-200)}`));
            }
            try {
                fs.renameSync(part, dest);
                job.progress = 100;
                resolve();
            } catch (e) {
                reject(new Error(`暂存改名失败：${e.message}`));
            }
        });
    });
}

async function ensureStaged(job) {
    if (!needsStaging(job)) return;
    const dest = stagedPathFor(job);
    job.stagedPath = dest;
    try {
        if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
            job.log.push(`[bridge] 预处理：复用已有本地副本 cache/${path.basename(dest)}`);
            return;
        }
    } catch { /* fallthrough */ }
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const risky = RISKY_EXTS.has(path.extname(job.file).toLowerCase());
    job.phase = 'staging';
    job.progress = 0;
    job.fps = 0;
    job.frame = 0;
    job.totalFrames = 0;
    job.remaining = '';
    const why = /^\\\\/.test(job.file) ? '网络共享盘源' : '高风险封装';
    job.log.push(`[bridge] 预处理（${why}）：${risky ? '无损重封装为 MKV' : '拷贝到本地暂存'} → cache/${path.basename(dest)}`);
    broadcastJobs();
    if (risky) {
        try {
            await remuxToMkv(job, dest, false);
        } catch (e1) {
            if (job.abortRequested) throw e1;
            job.log.push(`[bridge] 无损 remux 失败（${e1.message.slice(0, 120)}），尝试视频无损+音频转码`);
            job.progress = 0;
            broadcastJobs();
            try {
                await remuxToMkv(job, dest, true);
            } catch (e2) {
                if (job.abortRequested) throw e2;
                job.log.push(`[bridge] remux 仍失败（${e2.message.slice(0, 120)}），回退为整文件拷贝`);
                job.progress = 0;
                broadcastJobs();
                await copyWithProgress(job, dest);
            }
        }
    } else {
        await copyWithProgress(job, dest);
    }
    job.phase = 'processing';
    job.progress = 0;
    job.remaining = '';
    job.log.push('[bridge] 预处理完成，开始正式处理');
    broadcastJobs();
}

function runNext() {
    if (runnerActive) return;
    const job = jobOrder.map((id) => jobs.get(id)).find((j) => j.status === 'pending');
    if (!job) return;

    runnerActive = true;
    job.status = 'running';
    job.startedAt = Date.now();
    job.phase = 'processing';
    broadcastJobs();

    ensureStaged(job)
        .then(() => spawnJob(job))
        .catch((e) => {
            job.child = undefined;
            job.suspended = false;
            job.finishedAt = Date.now();
            job.phase = null;
            if (job.abortRequested) {
                job.status = 'aborted';
            } else {
                job.status = 'failed';
                job.error = `预处理失败：${e.message}`;
            }
            runnerActive = false;
            broadcastJobs();
            setImmediate(runNext);
        });
}

function spawnJob(job) {
    // 输入路径替换为本地暂存副本（若有）：-i 之后的那个参数
    const finalArgs = job.stagedPath
        ? job.args.map((v, i) => (i > 0 && job.args[i - 1] === '-i' ? job.stagedPath : v))
        : job.args;

    const env = { ...process.env };
    env.PATH = [...DLL_DIRS, env.PATH].join(';');

    const isPy = job.engine === 'python';
    const spawnCmd = isPy ? PYTHON_EXE : CLI_PATH;
    const spawnArgs = isPy ? [PY_WORKER, ...finalArgs] : finalArgs;
    job.log.push(`[bridge] spawn(${job.engine}): ${path.basename(spawnCmd)} ${spawnArgs.join(' ')}`);
    const child = spawn(spawnCmd, spawnArgs, {
        cwd: PROJECT_ROOT, // models/ 与 engine-python/weights 均相对项目根解析
        env,
        windowsHide: true,
    });
    job.child = child;

    let lineBuf = '';
    let lastPush = 0;
    const onData = (chunk) => {
        const text = chunk.toString('utf8');
        lineBuf += text;
        // Progress lines are separated by \r; log lines by \n
        const segments = lineBuf.split(/[\r\n]+/);
        lineBuf = segments.pop() ?? '';
        for (const seg of segments) {
            const clean = seg.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
            if (!clean) continue;
            const m = clean.match(PROGRESS_RE);
            if (m) {
                job.frame = Number(m[1]);
                job.totalFrames = Number(m[2]);
                job.progress = Number(m[3]);
                job.fps = Number(m[4]);
                job.remaining = m[6];
            } else {
                job.log.push(clean);
                if (job.log.length > 400) job.log.splice(0, job.log.length - 400);
            }
        }
        const now = Date.now();
        if (now - lastPush > 400) {
            lastPush = now;
            broadcastJobs();
        }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    let settled = false; // error 与 close 会先后触发，收尾逻辑必须幂等
    child.on('error', (err) => {
        if (settled) return;
        settled = true;
        job.child = undefined;
        job.status = 'failed';
        job.error = `无法启动 video2x：${err.message}`;
        job.finishedAt = Date.now();
        runnerActive = false;
        broadcastJobs();
        setImmediate(runNext);
    });

    child.on('close', (code) => {
        if (settled) return;
        settled = true;
        job.child = undefined;
        job.suspended = false;
        job.finishedAt = Date.now();
        job.phase = null;
        if (job.status === 'running') {
            if (code === 0) {
                job.status = 'done';
                job.progress = 100;
                // 成功完成后本地暂存副本即无用，立即回收磁盘空间；
                // 失败/中止则保留，供断点续跑复用（清除任务时随残余一并删除）
                if (job.stagedPath) {
                    try { fs.unlinkSync(job.stagedPath); } catch { /* best effort */ }
                    job.stagedPath = null;
                }
            } else if (code === 4) {
                // worker 仅以退出码 4 表示"已在检查点停止"：即使 pauseRequested 被
                // 「取消存点」抢先清除（竞态），断点也已落盘，必须按可续跑处理
                job.status = 'aborted';
                job.error = '已暂停：断点已保存，点击「续跑」随时继续';
                job.log.push('[bridge] 已在检查点暂停；断点数据已保存');
            } else if (job.abortRequested) {
                job.status = 'aborted';
            } else {
                job.status = 'failed';
                job.error = `video2x 退出码 ${code}（查看日志尾部了解详情）`;
            }
        }
        runnerActive = false;
        broadcastJobs();
        setImmediate(runNext);
    });
}

// ---------------------------------------------------------------------------
// Native dialogs via PowerShell (real Windows paths, no browser sandbox)
// ---------------------------------------------------------------------------
function psDialog(kind) {
    return new Promise((resolve, reject) => {
        let script;
        if (kind === 'dir') {
            script = `
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = '选择输出目录'
if ($d.ShowDialog() -eq 'OK') { [Console]::OutputEncoding=[Text.Encoding]::UTF8; Write-Output $d.SelectedPath }`;
        } else if (kind === 'save') {
            script = `
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.SaveFileDialog
$d.Filter = '视频文件|*.mp4;*.mkv;*.avi;*.mov;*.webm|所有文件|*.*'
if ($d.ShowDialog() -eq 'OK') { [Console]::OutputEncoding=[Text.Encoding]::UTF8; Write-Output $d.FileName }`;
        } else {
            script = `
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Multiselect = $true
$d.Filter = '视频文件|*.mp4;*.mkv;*.avi;*.mov;*.webm;*.flv;*.wmv;*.m2ts;*.ts;*.mpg;*.mpeg|所有文件|*.*'
$d.Title = '选择一个或多个视频文件'
if ($d.ShowDialog() -eq 'OK') { [Console]::OutputEncoding=[Text.Encoding]::UTF8; $d.FileNames | ForEach-Object { Write-Output $_ } }`;
        }
        execFile(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
            { timeout: 300000, maxBuffer: 4 * 1024 * 1024 },
            (err, stdout) => {
                if (err) return reject(err);
                const files = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
                resolve(files);
            }
        );
    });
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------
function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (c) => { data += c; if (data.length > 8e6) req.destroy(); });
        req.on('end', () => {
            try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
        });
        req.on('error', reject);
    });
}

function send(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        // 仅回显本机来源（Electron 同源无需此头；vite dev 为 localhost:3000），
        // 不再使用通配符 *，防止任意网页跨域驱动本地接口
        ...(res.corsOrigin ? { 'Access-Control-Allow-Origin': res.corsOrigin } : {}),
    });
    res.end(body);
}

let cudaDevicesCache = null; // CUDA 设备枚举缓存（torch import 慢，成功后常驻）

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const route = `${req.method} ${url.pathname}`;
    const origin = req.headers.origin;
    res.corsOrigin = (origin && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin))
        ? origin : null;
    // CSRF 写侧拦截：CORS 头只挡"读响应"，挡不住请求送达（text/plain 简单请求无预检），
    // 非本机来源的 /api/* 必须在路由前直接 403；无 Origin（Electron 同源/curl）放行
    if (origin && !res.corsOrigin && url.pathname.startsWith('/api/')) {
        return send(res, 403, { error: 'Forbidden: cross-origin request rejected' });
    }

    try {
        if (route === 'GET /api/health') {
            return send(res, 200, {
                ok: true,
                cliPath: CLI_PATH,
                cliExists: fs.existsSync(CLI_PATH),
                projectRoot: PROJECT_ROOT,
                staticDir: STATIC_DIR,
                staticDirExists: fs.existsSync(STATIC_DIR),
                pythonEngine: pythonEngineStatus(),
            });
        }

        if (route === 'GET /api/devices') {
            const env = { ...process.env };
            env.PATH = [...DLL_DIRS, env.PATH].join(';');
            execFile(CLI_PATH, ['-l'], { env, cwd: PROJECT_ROOT, timeout: 30000 }, (err, stdout, stderr) => {
                const out = `${stdout}\n${stderr}`;
                const devices = [];
                const re = /^(\d+)\.\s+(.+)$/gm;
                let m;
                while ((m = re.exec(out)) !== null) {
                    devices.push({ index: Number(m[1]), name: m[2].trim() });
                }
                send(res, 200, { devices, raw: out.trim(), error: err ? String(err) : null });
            });
            return;
        }

        if (route === 'GET /api/cuda-devices') {
            // CUDA 与 Vulkan 是两套独立编号空间（核显机上必然错位）：
            // 旗舰引擎（PyTorch）的设备选择必须用这份 CUDA 枚举，不能复用上方 Vulkan 列表
            if (cudaDevicesCache) return send(res, 200, cudaDevicesCache);
            execFile(PYTHON_EXE, ['-c',
                'import torch,json;print(json.dumps({"devices":[{"index":i,"name":torch.cuda.get_device_name(i)} for i in range(torch.cuda.device_count())]}))'],
                // torch import 较慢（首次约 10s），成功后永久缓存；失败不缓存（环境可能未就绪）
                { timeout: 120000 }, (err, stdout) => {
                    if (!err) {
                        try {
                            cudaDevicesCache = JSON.parse(String(stdout).trim());
                            return send(res, 200, cudaDevicesCache);
                        } catch { /* fallthrough */ }
                    }
                    send(res, 200, { devices: [], error: err ? String(err).slice(0, 160) : 'CUDA 枚举失败' });
                });
            return;
        }

        if (route === 'POST /api/browse') {
            const body = await readBody(req);
            const files = await psDialog(body.kind || 'open');
            return send(res, 200, { files });
        }

        if (route === 'POST /api/expand') {
            // 拖拽添加：把文件/文件夹路径展开为视频文件清单（目录递归，限深 6）
            const body = await readBody(req);
            const inputs = Array.isArray(body.paths) ? body.paths.map(String) : [];
            const found = [];
            const seen = new Set();
            const MAX = 1000;
            const visit = (p, depth) => {
                if (found.length >= MAX || depth > 6) return;
                let st;
                try { st = fs.statSync(p); } catch { return; }
                if (st.isDirectory()) {
                    let entries;
                    try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
                    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
                    for (const ent of entries) {
                        if (ent.name.startsWith('.') || ent.name.startsWith('$')) continue;
                        visit(path.join(p, ent.name), depth + 1);
                        if (found.length >= MAX) break;
                    }
                } else if (st.isFile() && VIDEO_EXTS.has(path.extname(p).toLowerCase())) {
                    const key = path.resolve(p).toLowerCase();
                    if (!seen.has(key)) {
                        seen.add(key);
                        found.push(p);
                    }
                }
            };
            for (const p of inputs) visit(p, 0);
            return send(res, 200, { files: found, truncated: found.length >= MAX });
        }

        if (route === 'GET /api/jobs') {
            return send(res, 200, { jobs: jobOrder.map((id) => publicJob(jobs.get(id))) });
        }

        if (route === 'POST /api/jobs') {
            const body = await readBody(req);
            const items = Array.isArray(body.items) ? body.items : [];
            if (items.length === 0) return send(res, 400, { error: '任务列表为空' });
            const batchId = nextBatchId++;
            const created = [];
            // 输出路径去重：同一路径已存在输出（或同批次撞名）时自动追加 _2/_3…，
            // 历史输出一律保留，绝不覆盖（断点续跑不走此接口，不受影响）
            const assigned = new Set();
            // 尚未落盘的输出也要占位：排队/运行中的任务，以及可续跑的中止/失败任务。
            // 否则分两次提交同名输出（如同一视频换模型对比）会拿到同一路径，后跑完的
            // 覆盖先跑完的；PyTorch 引擎还会因断点指纹不符清掉前一个任务的续跑分片
            for (const o of jobs.values()) {
                const live = o.status === 'pending' || o.status === 'running'
                    || ((o.status === 'aborted' || o.status === 'failed') && canResume(o));
                if (live && o.outPath) assigned.add(o.outPath.toLowerCase());
            }
            const dedupeOutPath = (p) => {
                if (!p) return p;
                const dir = path.dirname(p);
                const ext = path.extname(p);
                const stem = path.basename(p, ext);
                let candidate = p;
                let n = 2;
                while (assigned.has(candidate.toLowerCase()) || fs.existsSync(candidate)) {
                    candidate = path.join(dir, `${stem}_${n}${ext}`);
                    n++;
                }
                assigned.add(candidate.toLowerCase());
                return candidate;
            };
            for (const item of items) {
                const finalOut = dedupeOutPath(String(item.outPath || ''));
                // worker 的命令行输出参数同步替换（-o 之后的值）
                const finalArgs = Array.isArray(item.args) ? item.args.map(String) : [];
                const oi = finalArgs.indexOf('-o');
                if (oi >= 0 && oi + 1 < finalArgs.length) finalArgs[oi + 1] = finalOut;
                const srcFile = String(item.file || '');
                const st = inputStat(srcFile);
                const job = {
                    id: nextJobId++,
                    batchId,
                    file: srcFile,
                    fileSize: st.size,
                    fileMtime: st.mtime,
                    autoStage: item.autoStage !== false,
                    phase: null,
                    stagedPath: null,
                    outPath: finalOut,
                    args: finalArgs,
                    engine: item.engine === 'python' ? 'python' : 'cli',
                    status: 'pending',
                    progress: 0,
                    fps: 0,
                    remaining: '',
                    frame: 0,
                    totalFrames: 0,
                    error: null,
                    log: [],
                    createdAt: Date.now(),
                    startedAt: null,
                    finishedAt: null,
                    child: undefined,
                    abortRequested: false,
                    pauseRequested: false,
                    suspended: false,
                };
                jobs.set(job.id, job);
                jobOrder.push(job.id);
                created.push(publicJob(job));
            }
            broadcastJobs();
            setImmediate(runNext);
            return send(res, 200, { batchId, jobs: created });
        }

        const abortMatch = route.match(/^POST \/api\/jobs\/(\d+)\/abort$/);
        if (abortMatch) {
            const job = jobs.get(Number(abortMatch[1]));
            if (!job) return send(res, 404, { error: '任务不存在' });
            if (job.status === 'pending') {
                job.status = 'aborted';
                job.finishedAt = Date.now();
            } else if (job.status === 'running') {
                // 无条件置旗标：预处理整文件拷贝轮询 abortRequested（无 child 可杀），
                // remux/正式处理再叠加 taskkill
                job.abortRequested = true;
                if (job.child) {
                    try {
                        if (job.suspended) {
                            // 已挂起的进程先解冻，保证 taskkill 能干净结束并释放显存
                            job.suspended = false;
                            execFile(PS_EXE, ['-ExecutionPolicy', 'Bypass', '-File', SUSPEND_PS1,
                                '-RootPid', String(job.child.pid), '-Mode', 'resume'],
                                { timeout: 30000 }, () => {
                                    execFile('taskkill', ['/pid', String(job.child.pid), '/t', '/f'], () => {});
                                });
                            try { fs.unlinkSync(job.outPath + '.v2xsuspended'); } catch { /* best effort */ }
                        } else {
                            execFile('taskkill', ['/pid', String(job.child.pid), '/t', '/f'], () => {});
                        }
                    } catch { /* best effort */ }
                }
            }
            broadcastJobs();
            return send(res, 200, { ok: true });
        }

        const pauseMatch = route.match(/^POST \/api\/jobs\/(\d+)\/pause$/);
        if (pauseMatch) {
            const job = jobs.get(Number(pauseMatch[1]));
            if (!job) return send(res, 404, { error: '任务不存在' });
            if (job.status !== 'running') return send(res, 409, { error: '任务未在运行' });
            if (job.engine !== 'python' || (!job.args.includes('realbasicvsr') && !job.args.includes('seedvr2'))) {
                return send(res, 409, { error: '该引擎不支持检查点暂停（仅 RealBasicVSR / SeedVR2）' });
            }
            // 落一个旗标文件，worker 在下一个宏分片检查点看到后优雅退出（退出码 4）
            job.pauseRequested = true;
            try { fs.writeFileSync(job.outPath + '.v2xpause', String(Date.now())); } catch { /* best effort */ }
            job.log.push('[bridge] 收到暂停请求：将在当前分片检查点完成后停止（可随时续跑）');
            broadcastJobs();
            return send(res, 200, { ok: true });
        }

        // 取消存点停止：worker 尚未到达检查点前撤回旗标，任务照常运行
        const unpauseMatch = route.match(/^POST \/api\/jobs\/(\d+)\/unpause$/);
        if (unpauseMatch) {
            const job = jobs.get(Number(unpauseMatch[1]));
            if (!job) return send(res, 404, { error: '任务不存在' });
            if (job.status !== 'running' || !job.pauseRequested) {
                return send(res, 409, { error: '没有待取消的存点停止请求' });
            }
            job.pauseRequested = false;
            try { fs.unlinkSync(job.outPath + '.v2xpause'); } catch { /* 无旗标则忽略 */ }
            job.log.push('[bridge] 已取消存点停止请求：任务将继续运行');
            broadcastJobs();
            return send(res, 200, { ok: true });
        }

        // ------------------------------------------------------------------
        // 真暂停：挂起整个进程树（全引擎通用，立即冻结；显存保持占用）
        // ------------------------------------------------------------------
        const suspendMatch = route.match(/^POST \/api\/jobs\/(\d+)\/suspend$/);
        if (suspendMatch) {
            const job = jobs.get(Number(suspendMatch[1]));
            if (!job) return send(res, 404, { error: '任务不存在' });
            if (job.status !== 'running' || !job.child) return send(res, 409, { error: '任务未在运行' });
            if (job.suspended) return send(res, 200, { ok: true, already: true });
            // 挂起旗标：worker 解码看门狗据此豁免计时，避免解冻后按墙钟误杀
            try { fs.writeFileSync(job.outPath + '.v2xsuspended', String(Date.now())); } catch { /* best effort */ }
            const pid = job.child.pid;
            job.suspended = true; // 先置位，防双击并发
            broadcastJobs();
            execFile(PS_EXE, ['-ExecutionPolicy', 'Bypass', '-File', SUSPEND_PS1,
                '-RootPid', String(pid), '-Mode', 'suspend'], { timeout: 60000 }, (err, stdout) => {
                if (err) {
                    job.suspended = false;
                    try { fs.unlinkSync(job.outPath + '.v2xsuspended'); } catch { /* best effort */ }
                    job.log.push(`[bridge] 挂起失败：${err.message}`);
                } else {
                    const tail = stdout ? stdout.trim().split(/\r?\n/).pop() : '';
                    job.log.push(`[bridge] 已暂停（进程冻结，显存仍占用）${tail ? '：' + tail : ''}`);
                }
                broadcastJobs();
            });
            return send(res, 200, { ok: true });
        }

        const unsuspendMatch = route.match(/^POST \/api\/jobs\/(\d+)\/unsuspend$/);
        if (unsuspendMatch) {
            const job = jobs.get(Number(unsuspendMatch[1]));
            if (!job) return send(res, 404, { error: '任务不存在' });
            if (job.status !== 'running' || !job.child) return send(res, 409, { error: '任务未在运行' });
            if (!job.suspended) return send(res, 200, { ok: true, already: true });
            const pid = job.child.pid;
            job.suspended = false; // 先置位，防双击并发
            broadcastJobs();
            execFile(PS_EXE, ['-ExecutionPolicy', 'Bypass', '-File', SUSPEND_PS1,
                '-RootPid', String(pid), '-Mode', 'resume'], { timeout: 60000 }, (err, stdout) => {
                if (err) {
                    job.suspended = true; // 恢复失败，回到挂起态
                    job.log.push(`[bridge] 恢复失败：${err.message}`);
                } else {
                    const tail = stdout ? stdout.trim().split(/\r?\n/).pop() : '';
                    job.log.push(`[bridge] 已继续运行${tail ? '：' + tail : ''}`);
                    // 延迟删旗标：看门狗每 5s 一轮，必须让它在解冻后先看到旗标并重置计时
                    setTimeout(() => {
                        try { fs.unlinkSync(job.outPath + '.v2xsuspended'); } catch { /* best effort */ }
                    }, 10000);
                }
                broadcastJobs();
            });
            return send(res, 200, { ok: true });
        }

        const deleteMatch = route.match(/^POST \/api\/jobs\/(\d+)\/delete$/);
        if (deleteMatch) {
            const id = Number(deleteMatch[1]);
            const job = jobs.get(id);
            if (!job) return send(res, 404, { error: '任务不存在' });
            if (job.status === 'running') return send(res, 409, { error: '任务正在运行，请先中止' });
            const body = await readBody(req);
            // mode: 'record' 仅删记录 | 'all' 连同残余文件（仅对失败/中止生效；已完成任务的输出文件永不删除）
            let result = { deleted: [] };
            if (body.mode === 'all') result = deleteResiduals(job);
            jobs.delete(id);
            const idx = jobOrder.indexOf(id);
            if (idx >= 0) jobOrder.splice(idx, 1);
            broadcastJobs();
            return send(res, 200, { ok: true, deletedFiles: result.deleted.length });
        }

        // 重排队：断点续跑（旗舰引擎）或从头重跑（普通引擎），共用入口
        function requeueJob(job) {
            const checkpoint = canResume(job);
            job.status = 'pending';
            job.error = null;
            job.abortRequested = false;
            job.pauseRequested = false;
            job.suspended = false;
            try { fs.unlinkSync(job.outPath + '.v2xpause'); } catch { /* 无旗标则忽略 */ }
            try { fs.unlinkSync(job.outPath + '.v2xsuspended'); } catch { /* 无旗标则忽略 */ }
            job.startedAt = null;
            job.finishedAt = null;
            if (!checkpoint) {
                // 从头重跑：清零进度显示，半成品输出由引擎覆写（ffmpeg -y）
                job.progress = 0;
                job.frame = 0;
                job.fps = 0;
                job.remaining = '';
            }
            job.log.push(checkpoint
                ? '[bridge] 断点续跑：从最近的分片检查点继续'
                : '[bridge] 重新排队：从头开始处理');
            return checkpoint;
        }

        const resumeMatch = route.match(/^POST \/api\/jobs\/(\d+)\/resume$/);
        if (resumeMatch) {
            const job = jobs.get(Number(resumeMatch[1]));
            if (!job) return send(res, 404, { error: '任务不存在' });
            if (job.status !== 'aborted' && job.status !== 'failed') {
                return send(res, 409, { error: '仅已中止/失败的任务可以重新排队' });
            }
            const checkpoint = requeueJob(job);
            broadcastJobs();
            setImmediate(runNext);
            return send(res, 200, { ok: true, checkpoint });
        }

        // 一键取消全部排队中的任务（运行中的不受影响；旗舰引擎断点保留，可随时续跑）
        if (route === 'POST /api/jobs/cancel-pending') {
            let count = 0;
            for (const id of jobOrder) {
                const job = jobs.get(id);
                if (job && job.status === 'pending') {
                    job.status = 'aborted';
                    job.finishedAt = Date.now();
                    job.log.push('[bridge] 已取消排队（批量操作）');
                    count++;
                }
            }
            broadcastJobs();
            return send(res, 200, { ok: true, count });
        }

        // 一键继续：所有已中止/失败任务重新排队（有断点的续跑，没有的从头重跑）
        if (route === 'POST /api/jobs/resume-all') {
            let count = 0;
            for (const id of jobOrder) {
                const job = jobs.get(id);
                if (job && (job.status === 'aborted' || job.status === 'failed')) {
                    requeueJob(job);
                    count++;
                }
            }
            broadcastJobs();
            if (count > 0) setImmediate(runNext);
            return send(res, 200, { ok: true, count });
        }

        const folderMatch = route.match(/^POST \/api\/jobs\/(\d+)\/open-folder$/);
        if (folderMatch) {
            const job = jobs.get(Number(folderMatch[1]));
            if (!job) return send(res, 404, { error: '任务不存在' });
            // 输出文件存在则定位到文件，否则打开所在目录。
            // 注意：explorer 的 /select 对 UNC 网络路径（\\server\...）解析失败
            // 会静默打开"文档"，因此网络路径一律改为直接打开所在目录。
            const isUnc = job.outPath.startsWith('\\\\');
            // 路径含空格时 Node 会把整个参数包成 "/select,C:\a b\x.mp4"，explorer 解析不了，
            // 同样静默退回"文档"。改为 windowsVerbatimArguments 手动拼命令行：
            // 只给路径加引号，/select, 前缀留在引号外（实测含空格/中文两种形态均正确定位）。
            const target = !isUnc && fs.existsSync(job.outPath)
                ? `/select,"${job.outPath}"`
                : `"${path.dirname(job.outPath)}"`;
            const child = spawn('explorer.exe', [target], {
                detached: true, stdio: 'ignore', windowsVerbatimArguments: true,
            });
            child.on('error', () => {}); // explorer 退出码不规范，忽略
            child.unref();
            return send(res, 200, { ok: true });
        }

        const residualMatch = route.match(/^GET \/api\/jobs\/(\d+)\/residual$/);
        if (residualMatch) {
            const job = jobs.get(Number(residualMatch[1]));
            if (!job) return send(res, 404, { error: '任务不存在' });
            return send(res, 200, {
                status: job.status,
                canResume: canResume(job),
                residuals: listResiduals(job),
            });
        }

        if (route === 'GET /api/jobs/residuals') {
            // 汇总所有已结束任务的残余文件（供「清除已结束任务」确认弹窗展示）
            const items = [];
            for (const id of jobOrder) {
                const job = jobs.get(id);
                if (!job || job.status === 'running' || job.status === 'pending') continue;
                items.push({
                    id: job.id,
                    fileName: path.basename(job.file),
                    status: job.status,
                    canResume: canResume(job),
                    residuals: listResiduals(job),
                });
            }
            return send(res, 200, { items });
        }

        if (route === 'POST /api/jobs/clear-finished') {
            const body = await readBody(req);
            // mode='all' 时：仅失败/中止任务的残余文件会被删除；已完成任务的输出文件一律保留
            let cleared = 0;
            let deletedFiles = 0;
            for (const id of [...jobOrder]) {
                const job = jobs.get(id);
                if (job && job.status !== 'running' && job.status !== 'pending') {
                    if (body.mode === 'all') deletedFiles += deleteResiduals(job).deleted.length;
                    jobs.delete(id);
                    jobOrder.splice(jobOrder.indexOf(id), 1);
                    cleared++;
                }
            }
            broadcastJobs();
            return send(res, 200, { ok: true, cleared, deletedFiles });
        }

        if (route === 'GET /api/assets') {
            // 与 SSE 'assets' 事件同构：{...下载状态, assets[], pythonExe}
            return send(res, 200, {
                ...dlState,
                assets: assetsStatus(),
                pythonExe: { path: PYTHON_EXE, exists: fs.existsSync(PYTHON_EXE) },
            });
        }

        const dlMatch = route.match(/^POST \/api\/assets\/download$/);
        if (dlMatch) {
            const body = await readBody(req);
            const asset = ASSETS.find((a) => a.id === body.id);
            if (!asset) return send(res, 404, { error: '未知组件' });
            if (dlState.active) return send(res, 409, { error: '已有下载任务进行中' });
            if (asset.files.every((f) => assetFileStatus(f).ok)) {
                return send(res, 200, { ok: true, already: true });
            }
            dlState.active = asset.id;
            dlState.error = null;
            broadcastAssets();
            downloadAsset(asset)
                .then(() => {
                    dlState.active = null;
                    dlState.file = null;
                    dlState.mirror = null;
                    dlState.error = null;
                    broadcastAssets();
                })
                .catch((e) => {
                    dlState.active = null;
                    dlState.file = null;
                    dlState.mirror = null;
                    dlState.error = e.message;
                    broadcastAssets();
                });
            return send(res, 200, { ok: true, started: true });
        }

        if (route === 'POST /api/jobs/precheck') {
            // 提交前预检：网络盘/异常封装/超长耗时提前预警
            const body = await readBody(req);
            const file = String(body.file || '');
            const model = String(body.model || '');
            const warnings = [];
            const probeInfo = { width: 0, height: 0, fps: 0, frames: 0, duration: 0, hasAudio: false };
            let rFrameRate = ''; // r_frame_rate 与 avg_frame_rate 不一致 → VFR 源
            if (!file || !fs.existsSync(file)) {
                return send(res, 200, { ok: false, warnings: [{ level: 'error', text: '输入文件不存在或不可读' }], probe: probeInfo });
            }
            try {
                const out = await new Promise((resolve, reject) => {
                    execFile(FFPROBE, ['-v', 'quiet', '-print_format', 'json',
                        '-show_format', '-show_streams', file],
                        { timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
                        (err, stdout) => (err ? reject(err) : resolve(stdout)));
                });
                const info = JSON.parse(out);
                const vs = (info.streams || []).find((s) => s.codec_type === 'video');
                if (!vs) throw new Error('没有视频流');
                const [rn, rd] = String(vs.avg_frame_rate || '25/1').split('/').map(Number);
                const fps = rd ? rn / rd : 25;
                rFrameRate = String(vs.r_frame_rate || '');
                const dur = Number(info.format?.duration || 0);
                probeInfo.width = Number(vs.width || 0);
                probeInfo.height = Number(vs.height || 0);
                probeInfo.fps = fps;
                probeInfo.duration = dur;
                probeInfo.frames = /^\d+$/.test(String(vs.nb_frames || ''))
                    ? Number(vs.nb_frames)
                    : Math.round(dur * fps);
                probeInfo.hasAudio = (info.streams || []).some((s) => s.codec_type === 'audio');
            } catch (e) {
                warnings.push({ level: 'error', text: `ffprobe 探测失败：${String(e.message || e).slice(0, 200)}（文件可能损坏或封装异常）` });
                return send(res, 200, { ok: false, warnings, probe: probeInfo });
            }

            if (/^\\\\/.test(file)) {
                warnings.push({ level: 'warn', text: '输入文件位于网络共享盘：流式解码大文件可能极慢甚至挂死，强烈建议先拷贝到本地磁盘再处理。' });
            }
            const ext = path.extname(file).toLowerCase();
            if (['.rmvb', '.rm', '.wmv', '.asf', '.flv'].includes(ext)) {
                warnings.push({ level: 'warn', text: `${ext} 封装常带索引异常，按帧流式解码可能中途挂死；建议先转封装为 MP4/MKV（无损 remux 即可）。` });
            }
            // VFR 源检测：r_frame_rate（基准）与 avg_frame_rate（平均）不一致即为可变帧率，
            // 引擎按帧重建时间轴后音画可能逐渐不同步
            const [vrn, vrd] = String(rFrameRate || '0/1').split('/').map(Number);
            const baseFps = vrd ? vrn / vrd : 0;
            if (baseFps > 0 && Math.abs(baseFps - probeInfo.fps) / baseFps > 0.01) {
                warnings.push({
                    level: 'warn',
                    text: `可变帧率（VFR）源（基准 ${baseFps.toFixed(2)}fps / 平均 ${probeInfo.fps.toFixed(2)}fps）：处理后音画可能逐渐不同步，建议先转码为恒定帧率（CFR）再处理。`,
                });
            }
            const frames = probeInfo.frames;
            if (model === 'realbasicvsr') {
                // 吞吐随输入尺寸差一个数量级：RTX 5070 Ti 端到端实测 720x1280 约 1.4 fps，
                // 小尺寸（各边 ≤512px）才有 ~8 fps。原先固定按 15 fps 估算，
                // 对竖屏 720p 素材低估约 10 倍。
                const heavy = probeInfo.width > 512 || probeInfo.height > 512;
                const tput = heavy ? 1.4 : 8;
                const hours = frames / tput / 3600;
                if (hours > 0.25) {
                    warnings.push({ level: 'warn', text: `RealBasicVSR 吞吐约 ${tput} fps（参考 RTX 5070 Ti 实测；${heavy ? '大尺寸输入显著更慢' : '小尺寸输入'}）：${frames} 帧预计耗时约 ${hours.toFixed(1)} 小时（支持断点续跑，可分多次完成）。若源本身码率高、画面干净，建议改用 SPAN 或 Lanczos——快数十倍且更忠实于原貌。` });
                }
                // 显存不足以整帧推理时会退化为空间分块，画质有实测可见的损失
                const estFullGb = 12 * probeInfo.width * probeInfo.height * 743 / (1024 ** 3);
                if (estFullGb > 8) {
                    warnings.push({ level: 'warn', text: `输入尺寸较大：整帧推理约需 ${estFullGb.toFixed(1)} GB 显存，显存不足时会自动退化为空间分块——实测画质约损失 1.6 dB（网络被切开后拿不到全局上下文）。追求画质建议先把源缩到 720p 级别再超分。` });
                }
            } else if (model === 'seedvr2') {
                const hours = frames / 0.4 / 3600;
                if (hours > 0.5) {
                    warnings.push({ level: 'warn', text: `SeedVR2-3B 是画质旗舰引擎，吞吐约 0.4 fps（16GB 显存实测）：${frames} 帧预计耗时约 ${hours.toFixed(1)} 小时。支持断点续跑，可分多次完成；赶时间建议改用 SPAN / Real-ESRGAN 等 NCNN 引擎。` });
                }
                if (probeInfo.width * probeInfo.height >= 1920 * 1080) {
                    warnings.push({ level: 'warn', text: '输入 ≥1080p：SeedVR2 默认短边 4x 后输出超 4K，显存与时间开销极大，建议在高级选项中调低目标短边分辨率。' });
                }
            }
            return send(res, 200, { ok: true, warnings, probe: probeInfo });
        }

        if (route === 'GET /api/events') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
                ...(res.corsOrigin ? { 'Access-Control-Allow-Origin': res.corsOrigin } : {}),
            });
            res.write(': connected\n\n');
            sseClients.add(res);
            // 15s 心跳：防止系统休眠/网络异常后连接半开，前端状态永久过期
            const heartbeat = setInterval(() => {
                try {
                    res.write('event: ping\ndata: {}\n\n');
                } catch { /* client gone */ }
            }, 15000);
            req.on('close', () => {
                clearInterval(heartbeat);
                sseClients.delete(res);
            });
            // 新客户端立即补发当前快照：持久化恢复的任务/资产状态
            // 不能干等下一次广播，否则界面上一直显示"队列为空"
            try {
                res.write(`event: jobs\ndata: ${JSON.stringify(jobOrder.map((id) => publicJob(jobs.get(id))))}\n\n`);
                res.write(`event: assets\ndata: ${JSON.stringify({ ...dlState, assets: assetsStatus() })}\n\n`);
            } catch { /* client gone */ }
            return;
        }

        // ---- static frontend (production / Electron) ----
        if (req.method === 'GET' && fs.existsSync(STATIC_DIR)) {
            const mime = {
                '.html': 'text/html; charset=utf-8',
                '.js': 'text/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8',
                '.json': 'application/json; charset=utf-8',
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.svg': 'image/svg+xml',
                '.ico': 'image/x-icon',
                '.woff': 'font/woff',
                '.woff2': 'font/woff2',
                '.map': 'application/json',
            };
            let rel = decodeURIComponent(url.pathname);
            if (rel === '/' || rel === '') rel = '/index.html';
            // prevent path traversal
            const filePath = path.join(STATIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
            if (filePath.startsWith(STATIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                res.writeHead(200, { 'Content-Type': mime[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
                fs.createReadStream(filePath).pipe(res);
                return;
            }
            // SPA fallback: unknown non-API GET → index.html
            if (!url.pathname.startsWith('/api/')) {
                const indexPath = path.join(STATIC_DIR, 'index.html');
                if (fs.existsSync(indexPath)) {
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    fs.createReadStream(indexPath).pipe(res);
                    return;
                }
            }
        }

        send(res, 404, { error: `未知接口: ${route}` });
    } catch (e) {
        send(res, 500, { error: String(e && e.message ? e.message : e) });
    }
});

// 端口被占用时（通常是上次异常退出留下的 bridge 仍在服务，或重复启动）
// 不允许以未捕获异常崩溃宿主进程（Electron 主进程会弹 JS 错误框）：
// 记录日志后保持静默，由 Electron 主进程通过 /api/health 探测复用现有实例。
server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
        console.error(`[bridge] 端口 ${PORT} 已被占用，本实例不再监听；` +
            `若已有健康实例在运行，前端将直接复用。`);
        return;
    }
    throw err;
});

loadJobs();
if (jobOrder.length > 0) {
    // 恢复队列：上次排队中的任务自动继续；被中断的运行任务已转中止，待用户续跑/重跑
    setImmediate(runNext);
}

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[bridge] Video2X Studio bridge listening on http://127.0.0.1:${PORT}`);
    console.log(`[bridge] PROJECT_ROOT: ${PROJECT_ROOT}`);
    console.log(`[bridge] CLI: ${CLI_PATH} (exists=${fs.existsSync(CLI_PATH)})`);
    console.log(`[bridge] STATIC_DIR: ${STATIC_DIR} (exists=${fs.existsSync(STATIC_DIR)})`);
});
