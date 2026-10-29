// Video2X Studio — bridge 的平台差异集中处（docs/macos/01-feasibility.md D9）
// bridge.mjs 只用这里导出的常量与函数，不直接判断 process.platform。
// Windows 分支逐项保持移植前的行为（命令、参数、超时原样搬自 bridge.mjs）；
// macOS 分支对应 docs/macos/02-windows-specific-inventory.md B 节。

import { execFile, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PLATFORM = process.platform;

// ---------------------------------------------------------------------------
// 程序文件位置
// ---------------------------------------------------------------------------

/** CLI 相对项目根的路径（findProjectRoot 据此向上查找项目根） */
export const CLI_REL = IS_WIN
    ? path.join('build-desktop', 'Release', 'video2x.exe')
    : path.join('build-macos', 'video2x');

/** C++ 核心库（安装完整性检查用） */
export const CORE_LIB_REL = IS_WIN
    ? path.join('build-desktop', 'Release', 'libvideo2x.dll')
    : path.join('build-macos', 'libvideo2x.dylib');

/** Python：bundled 为随包的独立运行时，venv 为开发环境（bundled 不存在时回退） */
export function pythonPaths(root) {
    return IS_WIN
        ? {
            bundled: path.join(root, 'engine-python', 'python', 'python.exe'),
            venv: path.join(root, 'engine-python', '.venv', 'Scripts', 'python.exe'),
        }
        : {
            bundled: path.join(root, 'engine-python', 'python', 'bin', 'python3'),
            venv: path.join(root, 'engine-python', '.venv', 'bin', 'python3'),
        };
}

/** FFmpeg 所在目录。Windows 随包分发；macOS 优先用 scripts/macos/build-ffmpeg.sh 编出的
 *  third_party/ffmpeg-macos（带 libplacebo，与 build-core.sh 链接的是同一份），没有时退回
 *  Homebrew 的 ffmpeg@7（keg-only，不在 PATH 上）。可用 VIDEO2X_FFMPEG_DIR 覆盖 */
export function ffmpegDir(root) {
    if (IS_WIN) return path.join(root, 'third_party', 'ffmpeg-shared', 'bin');
    if (process.env.VIDEO2X_FFMPEG_DIR) return process.env.VIDEO2X_FFMPEG_DIR;
    const own = path.join(root, 'third_party', 'ffmpeg-macos', 'bin');
    return fs.existsSync(path.join(own, 'ffmpeg')) ? own : '/opt/homebrew/opt/ffmpeg@7/bin';
}

export const EXE_SUFFIX = IS_WIN ? '.exe' : '';

// DLL search paths required by video2x.exe at runtime（仅 Windows；macOS 靠 rpath）
function dllDirs(root) {
    return [
        path.join(root, 'build-desktop', 'Release'),
        path.join(root, 'third_party', 'ffmpeg-shared', 'bin'),
        path.join(root, 'third_party', 'ncnn-shared', 'x64', 'bin'),
        path.join(root, 'build-desktop', 'third_party', 'librealcugan_ncnn_vulkan', 'src', 'Release'),
        path.join(root, 'build-desktop', 'third_party', 'librealesrgan_ncnn_vulkan', 'src', 'Release'),
        path.join(root, 'build-desktop', 'third_party', 'librife_ncnn_vulkan', 'src', 'Release'),
        path.join(root, 'build-desktop', 'third_party', 'spdlog', 'Release'),
        path.join(root, 'build-desktop', 'third_party', 'boost', 'libs', 'program_options', 'Release'),
    ];
}

/** 引擎子进程（CLI / worker）的环境变量。Windows 把 DLL 目录加进 PATH；
 *  macOS 动态库靠 rpath，只把 ffmpeg 目录传给 worker，保证两边用同一份 ffmpeg */
export function childEnv(root) {
    if (IS_WIN) return { ...process.env, PATH: [...dllDirs(root), process.env.PATH].join(';') };
    return { ...process.env, VIDEO2X_FFMPEG_DIR: ffmpegDir(root) };
}

// ---------------------------------------------------------------------------
// 子进程：spawn 选项、杀进程树、挂起 / 恢复
// ---------------------------------------------------------------------------

/** 引擎子进程的 spawn 选项。macOS 上 detached 让子进程自成进程组（pgid = pid），
 *  杀树、挂起时对整组发信号，worker 拉起的 ffmpeg 一并覆盖 */
export const ENGINE_SPAWN_OPTS = IS_WIN ? { windowsHide: true } : { detached: true };

function signalGroup(pid, sig) {
    try {
        process.kill(-pid, sig);
        return true;
    } catch {
        return false; // 进程组已不存在
    }
}

/** 强杀进程树（异步，不等待结果） */
export function killTree(pid) {
    if (IS_WIN) {
        execFile('taskkill', ['/pid', String(pid), '/t', '/f'], () => {});
        return;
    }
    signalGroup(pid, 'SIGKILL');
}

/** 强杀进程树（同步）：应用退出前的短暂窗口内用 */
export function killTreeSync(pid) {
    if (IS_WIN) {
        spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, timeout: 8000 });
        return;
    }
    signalGroup(pid, 'SIGKILL');
}

// 进程树挂起/恢复（真暂停）：NtSuspendProcess 包装脚本，与本文件同目录
const SUSPEND_PS1 = path.join(__dirname, 'suspend_tree.ps1');

/** 挂起 / 恢复整棵进程树（mode: 'suspend' | 'resume'），回调签名同 execFile：(err, stdout)。
 *  Windows 用 NtSuspendProcess；macOS 对进程组发 SIGSTOP / SIGCONT（不可捕获，立即生效） */
export function suspendTree(pid, mode, cb, timeout = 60000) {
    if (IS_WIN) {
        execFile('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', SUSPEND_PS1,
            '-RootPid', String(pid), '-Mode', mode], { timeout }, cb);
        return;
    }
    const sig = mode === 'suspend' ? 'SIGSTOP' : 'SIGCONT';
    const ok = signalGroup(pid, sig);
    setImmediate(() => (ok ? cb(null, `${sig} → 进程组 ${pid}`) : cb(new Error(`进程组 ${pid} 不存在`), '')));
}

/** 中止任务的进程树。Windows 上已挂起的进程先解冻，保证 taskkill 能干净结束并释放显存；
 *  macOS 的 SIGKILL 对已 SIGSTOP 的进程同样立即生效 */
export function abortTree(pid, suspended) {
    if (IS_WIN && suspended) {
        suspendTree(pid, 'resume', () => killTree(pid), 30000);
        return;
    }
    killTree(pid);
}

/** 单独运行 bridge（npm run bridge / npm run dev）时：Ctrl+C 或 kill 先收掉子进程树再退出。
 *  Windows 维持原状；在 Electron 内由 before-quit 负责 */
export function onTerminate(cb) {
    if (IS_WIN) return;
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.on(sig, () => {
            try { cb(); } finally { process.exit(0); }
        });
    }
}

// ---------------------------------------------------------------------------
// 原生对话框、在文件管理器中定位
// ---------------------------------------------------------------------------

const VIDEO_TYPES = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm2ts', 'ts', 'mpg', 'mpeg', 'rmvb', 'rm',
    'asf', 'vob', '3gp', 'm4v'];

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

/** macOS：AppleScript 对话框（浏览器开发模式用；Electron 内由主进程的原生对话框接管，见 preload.cjs）。
 *  输出 POSIX 路径，每行一个；用户取消（错误 -128）返回空列表 */
function osascriptDialog(kind) {
    let script;
    if (kind === 'dir') {
        script = 'activate\nPOSIX path of (choose folder with prompt "选择输出目录")';
    } else if (kind === 'save') {
        script = 'activate\nPOSIX path of (choose file name with prompt "保存为" default name "output.mp4")';
    } else {
        const types = VIDEO_TYPES.map((t) => `"${t}"`).join(', ');
        script = `activate
set picked to choose file with prompt "选择一个或多个视频文件" of type {${types}} with multiple selections allowed
set out to ""
repeat with f in picked
    set out to out & POSIX path of f & linefeed
end repeat
return out`;
    }
    return new Promise((resolve, reject) => {
        execFile('osascript', ['-e', script], { timeout: 300000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                if (/-128/.test(String(stderr))) return resolve([]);
                return reject(new Error(String(stderr || err.message).trim()));
            }
            // choose folder 返回的目录带结尾 /，去掉以与 Windows 的写法一致
            const files = stdout.split('\n').map((s) => s.trim()).filter(Boolean)
                .map((p) => (p.length > 1 ? p.replace(/\/+$/, '') : p));
            resolve(files);
        });
    });
}

/** 原生文件对话框：kind = 'open'（多选视频）| 'dir'（选目录）| 'save' */
export function nativeDialog(kind) {
    return IS_WIN ? psDialog(kind) : osascriptDialog(kind);
}

function spawnDetached(cmd, args, opts = {}) {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', ...opts });
    child.on('error', () => {}); // 文件管理器的退出码不规范，忽略
    child.unref();
}

/** 在文件管理器中定位输出：文件存在则选中它，否则打开所在目录 */
export function revealOutput(outPath) {
    if (IS_WIN) {
        // 注意：explorer 的 /select 对 UNC 网络路径（\\server\...）解析失败
        // 会静默打开"文档"，因此网络路径一律改为直接打开所在目录。
        const isUnc = outPath.startsWith('\\\\');
        // 路径含空格时 Node 会把整个参数包成 "/select,C:\a b\x.mp4"，explorer 解析不了，
        // 同样静默退回"文档"。改为 windowsVerbatimArguments 手动拼命令行：
        // 只给路径加引号，/select, 前缀留在引号外（实测含空格/中文两种形态均正确定位）。
        const target = !isUnc && fs.existsSync(outPath)
            ? `/select,"${outPath}"`
            : `"${path.dirname(outPath)}"`;
        spawnDetached('explorer.exe', [target], { windowsVerbatimArguments: true });
        return;
    }
    // macOS：open -R 在访达中选中文件（参数直接传给 open，空格与中文无需转义）
    spawnDetached('open', fs.existsSync(outPath) ? ['-R', outPath] : [path.dirname(outPath)]);
}

/** 在文件管理器中打开目录 */
export function openDirectory(dir) {
    if (IS_WIN) {
        spawnDetached('explorer.exe', [`"${dir}"`], { windowsVerbatimArguments: true });
        return;
    }
    spawnDetached('open', [dir]);
}

// ---------------------------------------------------------------------------
// 网络路径：网络盘上的源先整文件拷贝到本地暂存（流式解码大文件可能极慢甚至挂死）
// ---------------------------------------------------------------------------

const NETWORK_FS = new Set(['smbfs', 'nfs', 'afpfs', 'webdav', 'cifs']);
let mountCache = { at: 0, list: [] };

/** 解析 macOS `mount` 输出："<设备> on <挂载点> (<类型>, 选项…)"，按挂载点长度降序（最长前缀优先） */
export function parseMounts(text) {
    const list = [];
    for (const line of String(text).split('\n')) {
        const m = line.match(/^.+? on (.+) \(([^,)]+)/);
        if (m) list.push({ point: m[1], type: m[2].trim() });
    }
    return list.sort((a, b) => b.point.length - a.point.length);
}

function macMounts() {
    if (Date.now() - mountCache.at < 10000) return mountCache.list;
    try {
        const r = spawnSync('/sbin/mount', [], { encoding: 'utf8', timeout: 5000 });
        mountCache = { at: Date.now(), list: parseMounts(r.stdout || '') };
    } catch {
        mountCache = { at: Date.now(), list: [] };
    }
    return mountCache.list;
}

/** 路径是否位于网络盘：Windows 为 UNC（\\ 开头）；macOS 为 /Volumes 下的 smbfs / nfs / afpfs / webdav 挂载 */
export function isNetworkPath(p, mounts) {
    if (IS_WIN) return /^\\\\/.test(p);
    if (!IS_MAC && !mounts) return false;
    const abs = path.resolve(p);
    const m = (mounts || macMounts()).find((x) =>
        abs === x.point || abs.startsWith(x.point.endsWith('/') ? x.point : `${x.point}/`));
    return !!m && NETWORK_FS.has(m.type);
}

// ---------------------------------------------------------------------------
// GPU 与 PyTorch 引擎
// ---------------------------------------------------------------------------

/** 旗舰引擎（PyTorch）设备枚举脚本，输出 {"devices":[...]}。
 *  Windows 枚举 CUDA 卡；macOS 只有一个 MPS 设备，vramGb 取 PyTorch 在本机可用的上限
 *  （recommended_max_memory，与 worker 的内存门槛同一口径），memGb 为整机统一内存 */
export const TORCH_DEVICES_PY = IS_MAC
    ? [
        'import json,subprocess,torch',
        'sc=lambda k: subprocess.run(["sysctl","-n",k],capture_output=True,text=True).stdout.strip()',
        'ok=torch.backends.mps.is_available()',
        'print(json.dumps({"devices":[{"index":0,"name":sc("machdep.cpu.brand_string"),"type":"mps",'
            + '"vramGb":round(torch.mps.recommended_max_memory()/2**30,1),'
            + '"memGb":round(int(sc("hw.memsize"))/2**30)}] if ok else []}))',
    ].join('\n')
    : 'import torch,json;print(json.dumps({"devices":[{"index":i,"name":torch.cuda.get_device_name(i),"vramGb":round(torch.cuda.get_device_properties(i).total_memory/2**30,1)} for i in range(torch.cuda.device_count())]}))';

/** 整机只有一块 GPU 时的统一调度键：Apple Silicon 上 ncnn（MoltenVK）与 PyTorch（MPS）跑在同一块 GPU，
 *  两套枚举的设备名未必一致，直接归到同一个键，保证两种引擎串行；null 表示按设备名区分（Windows 多卡） */
export const SHARED_GPU_KEY = IS_MAC ? 'Apple GPU#0' : null;

/** 本平台已完成移植的 PyTorch 引擎（未列出的在界面上禁用、提交时拒绝）。三个引擎都已支持 MPS（阶段 3） */
export const PY_ENGINES = ['realbasicvsr', 'seedvr2', 'swiftvr'];

/** 预检耗时估算的测试平台与吞吐标定：吞吐 ≈ k / 输出百万像素。
 *  RealBasicVSR 两边实测相近（720p 输入 4×：RTX 5070 Ti 1.4 fps、M5 Max 1.44 fps），沿用同一组数字；
 *  SeedVR2：RTX 5070 Ti 960p 0.47 fps、2K 0.25 fps；M5 Max 960p（1.64 MP）0.22 fps */
export const PERF = IS_MAC
    ? { gpu: 'M5 Max', seedvr2K: 0.36, swiftvrK: 11.3 }
    : { gpu: 'RTX 5070 Ti', seedvr2K: 0.9, swiftvrK: 26 };

/** SeedVR2 在 Mac 上的提示。DiT 载入时 CPU 上有 fp16→bf16 转换副本，M5 Max 36 GB 实测瞬时峰值约 31 GB
 *  （960p 与 2K 输出相同）；实测到 2K 输出（2560×1440 约 0.1 fps），更大的输出未验证 */
export function seedvr2MemoryWarnings(torchDevices, outMp) {
    if (!IS_MAC) return [];
    const warnings = [];
    const mem = Math.max(0, ...torchDevices.map((d) => d.vramGb || 0));
    if (mem > 0 && mem < 24) {
        warnings.push({ level: 'warn', text: `SeedVR2 在 Mac 上载入模型时内存峰值约 31 GB（M5 Max 36 GB 实测），本机 GPU 可用上限 ${mem.toFixed(1)} GB，可能大量换页、极慢甚至失败。建议改用 SwiftVR。` });
    }
    if (outMp > 3.7) {
        warnings.push({ level: 'warn', text: `输出约 ${outMp.toFixed(1)} 百万像素，超过 2K：Mac 上 SeedVR2 只验证到 2K 输出（2560×1440 约 0.1 fps），更大的输出可能放不下且极慢。建议在处理器选项里把目标短边设为 960～1440。` });
    }
    return warnings;
}

/** SeedVR2 DiT 权重：MPS 不支持 FP8 张量，Mac 用官方 fp16 版（D6） */
export const SEEDVR2_DIT = IS_MAC
    ? {
        file: 'seedvr2_ema_3b_fp16.safetensors',
        size: 6783018808,
        sha256: '2fd0e03a3dad24e07086750360727ca437de4ecd456f769856e960ae93e2b304',
        label: 'FP16',
    }
    : {
        file: 'seedvr2_ema_3b_fp8_e4m3fn.safetensors',
        size: 3391544696,
        sha256: '3bf1e43ebedd570e7e7a0b1b60d6a02e105978f505c8128a241cde99a8240cff',
        label: 'FP8',
    };

/** SwiftVR 预检：吞吐 ≈ k / 输出百万像素（实测标定），以及内存门槛提示 */
export function swiftvrPrecheck(outMp, torchDevices) {
    const warnings = [];
    // M5 Max：2K 3.1 fps、960p 6.9 fps；RTX 5070 Ti：2K 7.1 fps
    const tput = Math.min(30, PERF.swiftvrK / Math.max(outMp, 0.1));
    const { gpu } = PERF;
    const mems = torchDevices.map((d) => d.vramGb || 0);
    const maxMem = mems.length > 0 ? Math.max(...mems) : 0;
    if (IS_MAC) {
        if (mems.length > 0 && maxMem < 15) {
            warnings.push({ level: 'error', text: `SwiftVR 在 Mac 上需要约 24 GB 及以上的统一内存（本机 GPU 可用上限 ${maxMem.toFixed(1)} GB）：bf16 权重就要约 10 GB 常驻，再加推理所需内存。请改用 nomos8k-compact 等 NCNN 引擎。` });
        }
        if (outMp > 3.7) {
            warnings.push({ level: 'warn', text: `输出约 ${outMp.toFixed(1)} 百万像素，超过 2K：36 GB 统一内存的 Mac 上 2K 峰值已达 26～29 GB，更大的输出可能放不下（程序会自动减小分段重试，仍不行则报错），建议目标短边不超过 1440。渲染期间尽量少开其他大程序。` });
        }
    } else {
        if (mems.length > 0 && maxMem < 15) {
            warnings.push({ level: 'error', text: `SwiftVR 需要 16 GB 级显存（检测到最大 ${maxMem.toFixed(1)} GB）：模型即使 FP8 量化也需约 5 GB 权重常驻，再加推理所需显存。请改用 nomos8k-compact 等 NCNN 引擎。` });
        }
        if (outMp > 4) {
            warnings.push({ level: 'warn', text: `输出约 ${outMp.toFixed(1)} 百万像素，超过 2K：16 GB 显存可能放不下（程序会自动减小分段重试，仍不行则报错），建议目标短边不超过 1440。` });
        }
    }
    return { tput, gpu, warnings };
}
