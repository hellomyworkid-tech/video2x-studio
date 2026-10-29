// 打包前后的完整性校验。
//
// electron-builder 遇到不存在的 extraFiles 源目录只打一条 debug 级日志就跳过，照样
// 产出一个只有 Electron 外壳的"空壳包"（video2x.exe / Python 运行时 / 权重 / 模型都不在
// git 里，clone 后直接打包就会这样）。因此：
//   node scripts/check-dist.mjs pre   打包前：extraFiles 源目录 + 关键文件必须齐全，
//                                     且 C++ 产物不得旧于源码（防止把旧程序打进包）
//   node scripts/check-dist.mjs post  打包后：输出目录里的关键文件逐个与源文件比对大小
// macOS（npm run dist:mac）按下方 Mac 表校验：包根是 .app/Contents，C++ 核心、FFmpeg、Python 运行时
// 的源文件是 scripts/macos/package-app.mjs pre 处理过的 dist-macos/（改过 @rpath，与 build-macos 里的不同）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IS_MAC = process.platform === 'darwin';
const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(UI_DIR, '..');
const STAGE = path.join(ROOT, 'dist-macos');
const OUT_DIR = IS_MAC
    ? path.join(UI_DIR, 'release', 'mac-arm64', 'Video2X Studio.app', 'Contents')
    : path.join(UI_DIR, 'release', 'win-unpacked');
const pkg = JSON.parse(fs.readFileSync(path.join(UI_DIR, 'package.json'), 'utf8'));

// 运行必需的关键文件（相对项目根 / 包根，两边布局一致）
const WIN_KEY_FILES = [
    'build-desktop/Release/video2x.exe',
    'build-desktop/Release/libvideo2x.dll',
    'third_party/ffmpeg-shared/bin/ffmpeg.exe',
    'third_party/ffmpeg-shared/bin/ffprobe.exe',
    'engine-python/python/python.exe',
    'engine-python/worker.py',
    'engine-python/weights/realbasicvsr_x4.pth',
    'engine-python/weights/spynet.pth',
    'engine-python/weights/SeedVR2-3B/seedvr2_ema_3b_fp8_e4m3fn.safetensors',
    'engine-python/weights/SeedVR2-3B/ema_vae_fp16.safetensors',
    // SwiftVR：推理源码 + 依赖覆盖层（diffusers 0.36 / decord）+ 预转换 FP8 权重
    'engine-python/vsr_models/swiftvr_runner.py',
    'engine-python/vendor/swiftvr/swiftvr/__init__.py',
    'engine-python/swiftvr-libs/diffusers/__init__.py',
    'engine-python/swiftvr-libs/decord/__init__.py',
    'engine-python/weights/SwiftVR/swiftvr_transformer_fp8.safetensors',
    'engine-python/weights/SwiftVR/reae.safetensors',
    'engine-python/weights/SwiftVR/prompt_embedding.safetensors',
    'engine-python/weights/SwiftVR/transformer/config.json',
    // SageAttention + Triton 即时编译（TinyCC、ptxas、Python 头文件与导入库缺一不可，
    // 缺了不会崩——引擎自检后回退 SDPA——但加速会悄悄失效）
    'engine-python/python/Lib/site-packages/sageattention/__init__.py',
    'engine-python/python/Lib/site-packages/triton/__init__.py',
    'engine-python/python/Lib/site-packages/triton/runtime/tcc/tcc.exe',
    'engine-python/python/Lib/site-packages/triton/backends/nvidia/bin/ptxas.exe',
    'engine-python/python/include/Python.h',
    'engine-python/python/libs/python312.lib',
];
const MAC_KEY_FILES = [
    'build-macos/video2x',
    'build-macos/libvideo2x.dylib',
    'build-macos/lib/libncnn.1.dylib',
    'build-macos/lib/libMoltenVK.dylib',
    // libplacebo 经 vulkan-loader 加载 MoltenVK，缺了清单 Anime4K / HDR 会找不到 GPU
    'build-macos/lib/libvulkan.1.dylib',
    'vulkan/icd.d/MoltenVK_icd.json',
    'third_party/ffmpeg-macos/bin/ffmpeg',
    'third_party/ffmpeg-macos/bin/ffprobe',
    'engine-python/python/bin/python3.12',
    'engine-python/python/lib/python3.12/site-packages/torch/__init__.py',
    'engine-python/worker.py',
    'engine-python/weights/realbasicvsr_x4.pth',
    'engine-python/weights/spynet.pth',
    // Mac 用 fp16 DiT（MPS 不支持 FP8）
    'engine-python/weights/SeedVR2-3B/seedvr2_ema_3b_fp16.safetensors',
    'engine-python/weights/SeedVR2-3B/ema_vae_fp16.safetensors',
    // SwiftVR：推理源码 + 依赖覆盖层（diffusers 0.36；decord 由 runner 注入空模块）+ 预转换 FP8 权重
    'engine-python/vsr_models/swiftvr_runner.py',
    'engine-python/vendor/swiftvr/swiftvr/__init__.py',
    'engine-python/swiftvr-libs/diffusers/__init__.py',
    'engine-python/weights/SwiftVR/swiftvr_transformer_fp8.safetensors',
    'engine-python/weights/SwiftVR/reae.safetensors',
    'engine-python/weights/SwiftVR/prompt_embedding.safetensors',
    'engine-python/weights/SwiftVR/transformer/config.json',
    // 随包第三方组件的许可证原文与源码清单（GPL 组件分发时必须附带）
    'licenses/README.txt',
    'licenses/ffmpeg/COPYING.GPLv2',
    'licenses/electron/LICENSES.chromium.html',
];
// Mac 包里不该有的大文件（Mac 用不上；extraFiles 的过滤写错时会让包大出 20 GB 以上）
const MAC_EXCLUDED = [
    'engine-python/weights/SwiftVR/transformer/diffusion_pytorch_model.safetensors',
    'engine-python/weights/SeedVR2-3B/seedvr2_ema_3b_fp8_e4m3fn.safetensors',
    'engine-python/.venv',
];
const KEY_FILES = IS_MAC ? MAC_KEY_FILES : WIN_KEY_FILES;
const KEY_DIRS = ['models/realesrgan', 'models/realcugan', 'models/rife', 'models/span', 'models/libplacebo'];
// 关键文件的源：Mac 上这几个目录由 package-app.mjs pre 准备在 dist-macos/
const MAC_STAGED = ['build-macos/', 'third_party/', 'vulkan/', 'licenses/', 'engine-python/python/'];
const srcOf = (f) => path.join(IS_MAC && MAC_STAGED.some((p) => f.startsWith(p)) ? STAGE : ROOT, f);

const errors = [];
const fail = (msg) => errors.push(msg);

function newestMtime(dir, exts) {
    let newest = 0;
    let file = '';
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const sub = newestMtime(p, exts);
            if (sub.newest > newest) ({ newest, file } = sub);
        } else if (exts.includes(path.extname(entry.name))) {
            const m = fs.statSync(p).mtimeMs;
            if (m > newest) { newest = m; file = p; }
        }
    }
    return { newest, file };
}

function checkPre() {
    // electron-builder 把顶层与平台段的 extraFiles 合并使用
    const extra = [...(pkg.build.extraFiles || []), ...(pkg.build[IS_MAC ? 'mac' : 'win']?.extraFiles || [])];
    for (const e of extra) {
        const from = typeof e === 'string' ? e : e.from;
        if (!fs.existsSync(path.resolve(UI_DIR, from))) fail(`extraFiles 源不存在：${from}`);
    }
    for (const f of KEY_FILES) if (!fs.existsSync(srcOf(f))) fail(`缺少关键文件：${path.relative(ROOT, srcOf(f))}`);
    for (const d of KEY_DIRS) if (!fs.existsSync(path.join(ROOT, d))) fail(`缺少模型目录：${d}`);

    // C++ 产物新鲜度：源码比产物新，说明改了代码没重新编译。各产物只与自己的源码比——
    // 只改 libvideo2x 时 MSBuild 不会重新链接 video2x.exe，exe 旧于 src/ 属正常
    const newest = (dirs) => dirs
        .map(([d, exts]) => newestMtime(path.join(ROOT, d), exts))
        .reduce((a, b) => (b.newest > a.newest ? b : a));
    const include = ['include', ['.h']];
    const [lib, exe, rebuild] = IS_MAC
        ? ['build-macos/libvideo2x.dylib', 'build-macos/video2x', 'bash scripts/macos/build-core.sh']
        : ['build-desktop/Release/libvideo2x.dll', 'build-desktop/Release/video2x.exe',
            'cmake --build build-desktop --config Release --target video2x'];
    const targets = [
        [lib, newest([['src', ['.cpp', '.h']], include])],
        [exe, newest([['tools/video2x/src', ['.cpp', '.h']], include])],
    ];
    for (const [bin, src] of targets) {
        const p = path.join(ROOT, bin);
        if (fs.existsSync(p) && fs.statSync(p).mtimeMs + 1000 < src.newest) {
            fail(`${bin} 旧于源码 ${path.relative(ROOT, src.file)}，请先重新编译：${rebuild}`);
        }
    }
}

function checkPost() {
    if (!fs.existsSync(OUT_DIR)) { fail(`输出目录不存在：${OUT_DIR}`); return; }
    for (const f of KEY_FILES) {
        const src = srcOf(f);
        const dst = path.join(OUT_DIR, f);
        if (!fs.existsSync(dst)) { fail(`包内缺少：${f}`); continue; }
        if (fs.existsSync(src) && fs.statSync(src).size !== fs.statSync(dst).size) {
            fail(`包内文件与源文件大小不一致：${f}`);
        }
    }
    for (const d of KEY_DIRS) if (!fs.existsSync(path.join(OUT_DIR, d))) fail(`包内缺少模型目录：${d}`);
    if (IS_MAC) for (const f of MAC_EXCLUDED) if (fs.existsSync(path.join(OUT_DIR, f))) fail(`包内不应有：${f}`);
    const frontend = path.join(OUT_DIR, IS_MAC ? 'Resources' : 'resources', 'app', 'dist', 'index.html');
    if (!fs.existsSync(frontend)) fail('包内缺少前端 dist');
}

const mode = process.argv[2];
if (mode === 'pre') checkPre();
else if (mode === 'post') checkPost();
else {
    console.error('用法：node scripts/check-dist.mjs pre|post');
    process.exit(2);
}

if (errors.length > 0) {
    console.error(`\n[check-dist ${mode}] 校验失败（${errors.length} 项）：`);
    for (const e of errors) console.error('  ✗ ' + e);
    console.error(mode === 'pre'
        ? '\n打包已中止：请先处理以上问题，否则产出的包不可用或包含旧程序。'
        : '\n输出包不完整，请勿分发。');
    process.exit(1);
}
console.log(`[check-dist ${mode}] 通过：关键文件 ${KEY_FILES.length} 项、模型目录 ${KEY_DIRS.length} 项齐全` +
    (mode === 'pre' ? '，C++ 产物不旧于源码' : '，与源文件大小一致'));
