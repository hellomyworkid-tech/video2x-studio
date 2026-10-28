// bridge 端到端冒烟（跨平台）：经与界面相同的 HTTP 接口提交 SwiftVR / SeedVR2 短任务，核对输出帧数与日志里的后端信息。
//
// 用法（先另起一个 bridge，端口与正在使用的程序错开，测完记得关掉）：
//   BRIDGE_PORT=7299 node ui/server/bridge.mjs &
//   node scripts/macos/smoke-bridge.mjs testdata/inputs/A.mp4 testdata/inputs/B.mp4 /tmp/smoke
// 环境变量：
//   BRIDGE_URL  默认 http://127.0.0.1:7299
//   DEVICE      默认 macOS 为 mps，其他平台为 cuda:0
//   FFPROBE     默认 $VIDEO2X_FFMPEG_DIR/ffprobe，否则用 PATH 里的 ffprobe
// 预期日志关键字按平台不同：Windows 为 SageAttention / FP8 张量核；macOS 为 SDPA / bf16 或 fp16（移植后的实际写法为准）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const B = process.env.BRIDGE_URL || 'http://127.0.0.1:7299';
const DEVICE = process.env.DEVICE || (process.platform === 'darwin' ? 'mps' : 'cuda:0');
const FFPROBE = process.env.FFPROBE
    || (process.env.VIDEO2X_FFMPEG_DIR ? path.join(process.env.VIDEO2X_FFMPEG_DIR, 'ffprobe') : 'ffprobe');
const [, , inA, inB, outDir] = process.argv;
if (!inA || !inB || !outDir) {
    console.error('用法：node scripts/macos/smoke-bridge.mjs <A.mp4> <B.mp4> <输出目录>');
    process.exit(2);
}
for (const f of [inA, inB]) {
    if (!fs.existsSync(f)) { console.error(`输入不存在：${path.resolve(f)}`); process.exit(2); }
}
fs.mkdirSync(outDir, { recursive: true });
const get = async (p) => (await fetch(B + p)).json();
const post = async (p, body) => (await fetch(B + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})).json();

const h = await get('/api/health');
console.log('projectRoot:', h.projectRoot, '| pythonEngine:', JSON.stringify(h.pythonEngine), '| device:', DEVICE);

async function run(label, input, args, outPath, expectFrames) {
    fs.rmSync(outPath, { force: true });
    const r = await post('/api/jobs', { items: [{ file: path.resolve(input), outPath, args, engine: 'python', autoStage: false }] });
    const id = r.jobs[0].id;
    const t0 = Date.now();
    let j;
    for (;;) {
        j = (await get('/api/jobs')).jobs.find((x) => x.id === id);
        if (!['pending', 'running'].includes(j.status)) break;
        await new Promise((res) => setTimeout(res, 1000));
    }
    let frames = '无输出';
    try {
        frames = execFileSync(FFPROBE, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries',
            'stream=nb_read_frames,width,height', '-of', 'csv=p=0', outPath]).toString().trim();
    } catch { /* 没有输出文件 */ }
    const okFrames = frames.endsWith(`,${expectFrames}`);
    console.log(`\n[${label}] ${j.status}（${((Date.now() - t0) / 1000).toFixed(0)}s）输出 ${frames} ` +
        `${okFrames ? '✓' : `✗ 预期 ${expectFrames} 帧`}${j.error ? ' 错误: ' + j.error : ''}`);
    for (const line of (j.logTail || [])) {
        if (/注意力后端|矩阵乘|自检|显存|内存|Traceback|Error|fallback|回退/.test(line)) console.log('   ', line.slice(0, 160));
    }
    if (j.status !== 'done') {
        console.log('    —— 日志末尾 ——');
        for (const line of (j.logTail || []).slice(-8)) console.log('   ', line.slice(0, 200));
    }
    return j.status === 'done' && okFrames;
}

// 只跑本平台已完成移植的引擎（bridge 会拒绝其余的）；旧版 bridge 不报告时全部都跑
const supported = h.pythonEngine?.supported || ['swiftvr', 'seedvr2'];
const outA = path.resolve(outDir, 'smoke_swiftvr.mp4');
const outB = path.resolve(outDir, 'smoke_seedvr2.mp4');
const results = [];
if (supported.includes('swiftvr')) {
    results.push(await run('SwiftVR', inA, ['--model', 'swiftvr', '-i', path.resolve(inA), '-o', outA, '--codec', 'libx264',
        '--crf', '18', '--device', DEVICE, '--resolution', '0', '--max-frames', '48'], outA, 48));
}
if (supported.includes('seedvr2')) {
    results.push(await run('SeedVR2 960p', inB, ['--model', 'seedvr2', '-i', path.resolve(inB), '-o', outB, '--codec', 'libx264',
        '--crf', '18', '--device', DEVICE, '--resolution', '960', '--max-frames', '20'], outB, 20));
} else {
    console.log('\n[SeedVR2] 跳过：本平台尚未完成移植');
}
const ok = results.length > 0 && results.every(Boolean);
console.log(ok ? '\n全部通过' : '\n有失败项');
process.exit(ok ? 0 : 1);
