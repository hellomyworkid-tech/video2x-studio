// 阶段 2 / 4 验收（docs/macos/05-acceptance.md）：经与界面相同的 HTTP 接口逐项验证 bridge 在 macOS 上的行为。
//
// 用法（先另起一个 bridge，端口与正在使用的程序错开，测完记得关掉）：
//   BRIDGE_PORT=7299 node ui/server/bridge.mjs &
//   node scripts/macos/accept-bridge.mjs <输出目录>
// 环境变量：BRIDGE_URL 默认 http://127.0.0.1:7299；SKIP_SLOW=1 跳过 SwiftVR 检查点暂停一项
// 需要 testdata/inputs/{B,A20}.mp4（迁移包 restore-on-mac.sh 已放好）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const B = process.env.BRIDGE_URL || 'http://127.0.0.1:7299';
const FFPROBE = path.join(process.env.VIDEO2X_FFMPEG_DIR || '/opt/homebrew/opt/ffmpeg@7/bin', 'ffprobe');
const IN_B = path.join(ROOT, 'testdata', 'inputs', 'B.mp4');
const IN_A20 = path.join(ROOT, 'testdata', 'inputs', 'A20.mp4');
const outDir = path.resolve(process.argv[2] || '');
if (!process.argv[2]) {
    console.error('用法：node scripts/macos/accept-bridge.mjs <输出目录>');
    process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

const get = async (p) => (await fetch(B + p)).json();
const post = async (p, body) => (await fetch(B + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
})).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const job = async (id) => (await get('/api/jobs')).jobs.find((j) => j.id === id);

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
    if (ok) pass++; else fail++;
    console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? `：${detail}` : ''}`);
}

function frames(file) {
    try {
        return execFileSync(FFPROBE, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries',
            'stream=width,height,nb_read_frames', '-of', 'csv=p=0', file]).toString().trim();
    } catch {
        return '无输出';
    }
}

/** 匹配命令行含 pattern 的进程：[{pid, stat, cmd}] */
function procs(pattern) {
    try {
        const out = execFileSync('/bin/ps', ['-axo', 'pid=,stat=,command=']).toString();
        return out.split('\n').filter((l) => l.includes(pattern) && !l.includes('accept-bridge'))
            .map((l) => { const m = l.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/); return m && { pid: +m[1], stat: m[2], cmd: m[3] }; })
            .filter(Boolean);
    } catch {
        return [];
    }
}

async function submit(items) {
    const r = await post('/api/jobs', { items });
    if (!r.jobs) throw new Error(`提交失败：${JSON.stringify(r)}`);
    return r.jobs;
}

/** 等任务结束；记录途中见过的进度（验证进度、速度、剩余时间会刷新） */
async function waitDone(id, timeoutMs = 600000) {
    const seen = { progress: new Set(), fps: false, remaining: false };
    const t0 = Date.now();
    for (;;) {
        const j = await job(id);
        if (j.status === 'running') {
            seen.progress.add(Math.floor(j.progress));
            if (j.fps > 0) seen.fps = true;
            if (j.remaining && j.remaining !== '00:00:00') seen.remaining = true;
        }
        if (!['pending', 'running'].includes(j.status)) return { j, seen, secs: (Date.now() - t0) / 1000 };
        if (Date.now() - t0 > timeoutMs) return { j, seen, secs: (Date.now() - t0) / 1000, timeout: true };
        await sleep(300);
    }
}

const cli = (out, extra) => ({
    file: IN_B, outPath: out, engine: 'cli', autoStage: false,
    args: ['-i', IN_B, '-o', out, ...extra, '-c', 'libx264', '-e', 'crf=18'],
});

const h = await get('/api/health');
console.log(`bridge ${B}：platform=${h.platform} libplacebo=${h.features?.libplacebo} 引擎=${JSON.stringify(h.pythonEngine?.supported)}`);

// ---------------------------------------------------------------------------
console.log('\n[1] 各 ncnn 处理器：进度刷新、输出帧数');
const procCases = [
    ['lanczos', ['-p', 'lanczos', '-s', '2'], '1708,960,72'],
    ['realesrgan', ['-p', 'realesrgan', '--realesrgan-model', 'realesr-animevideov3', '-s', '2', '-d', '-1'], '1708,960,72'],
    ['realcugan', ['-p', 'realcugan', '--realcugan-model', 'models-se', '-s', '2', '-n', '-1', '-d', '-1'], '1708,960,72'],
    ['span', ['-p', 'span', '--span-model', 'span', '-s', '2', '-d', '-1'], '1708,960,72'],
    ['rife', ['-p', 'rife', '--rife-model', 'rife-v4.26', '-m', '2', '-d', '-1'], '854,480,143'],
];
for (const [name, extra, want] of procCases) {
    const out = path.join(outDir, `proc_${name}.mp4`);
    fs.rmSync(out, { force: true });
    const [j0] = await submit([cli(out, extra)]);
    const { j, seen, secs } = await waitDone(j0.id);
    const f = frames(out);
    check(`${name}（${secs.toFixed(0)}s）`, j.status === 'done' && f === want,
        `${j.status}，输出 ${f}，途中进度 ${seen.progress.size} 个取值，fps ${seen.fps ? '有' : '无'}，剩余时间 ${seen.remaining ? '有' : '无'}${j.error ? `，${j.error}` : ''}`);
}
// 自动选卡（-d -1）在 Mac 上应解析到唯一的 Apple GPU
const lastLog = (await job((await get('/api/jobs')).jobs.at(-1).id)).logTail.join('\n');
check('自动选卡与调度槽位', /自动选择 GPU：Vulkan 设备 0/.test(lastLog) && /调度槽位：Apple GPU#0/.test(lastLog));

// ---------------------------------------------------------------------------
console.log('\n[2] 苹果硬编：质量参数生效、HEVC 标 hvc1');
const vtSizes = [];
for (const crf of [18, 28]) {
    const out = path.join(outDir, `vt_crf${crf}.mp4`);
    fs.rmSync(out, { force: true });
    // 与界面 qualityOpts 一致：flags=+qscale + global_quality = q × 118，q = 115 - 2×CRF
    const q = Math.max(1, Math.min(100, Math.round(115 - 2 * crf)));
    const [j0] = await submit([{ file: IN_B, outPath: out, engine: 'cli', autoStage: false,
        args: ['-i', IN_B, '-o', out, '-p', 'lanczos', '-s', '2', '-c', 'hevc_videotoolbox',
            '-e', 'flags=+qscale', '-e', `global_quality=${q * 118}`] }]);
    const { j } = await waitDone(j0.id);
    const tag = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_tag_string',
        '-of', 'csv=p=0', out]).toString().trim();
    vtSizes.push(fs.existsSync(out) ? fs.statSync(out).size : 0);
    check(`hevc_videotoolbox CRF ${crf}（q ${q}）`, j.status === 'done' && tag === 'hvc1'
        && !j.logTail.some((l) => /Failed to set encoder option/.test(l)), `${j.status}，tag ${tag}，${(vtSizes.at(-1) / 1e6).toFixed(2)} MB`);
}
check('质量档改变体积', vtSizes[0] > vtSizes[1] * 1.5, `CRF 18 ${(vtSizes[0] / 1e6).toFixed(2)} MB vs CRF 28 ${(vtSizes[1] / 1e6).toFixed(2)} MB`);

// ---------------------------------------------------------------------------
console.log('\n[3] 真暂停（挂起进程组）→ 解冻 → 中止，进程树全部退出');
{
    const out = path.join(outDir, 'suspend_test.mp4');
    fs.rmSync(out, { force: true });
    const [j0] = await submit([{ file: IN_A20, outPath: out, engine: 'cli', autoStage: false,
        args: ['-i', IN_A20, '-o', out, '-p', 'realesrgan', '--realesrgan-model', 'realesr-animevideov3', '-s', '2',
            '-d', '-1', '-c', 'libx264', '-e', 'crf=18'] }]);
    let j;
    for (let i = 0; i < 200; i++) { j = await job(j0.id); if (j.frame > 20) break; await sleep(300); }
    await post(`/api/jobs/${j0.id}/suspend`);
    await sleep(1500);
    const stopped = procs(out);
    const f1 = (await job(j0.id)).frame;
    await sleep(4000);
    const f2 = (await job(j0.id)).frame;
    check('挂起后进程处于停止状态（T）', stopped.length > 0 && stopped.every((p) => p.stat.includes('T')),
        stopped.map((p) => `${p.pid}:${p.stat}`).join(' '));
    check('挂起期间进度不动', f1 === f2, `帧 ${f1} → ${f2}`);
    check('挂起旗标文件', fs.existsSync(`${out}.v2xsuspended`));
    await post(`/api/jobs/${j0.id}/unsuspend`);
    await sleep(4000);
    const f3 = (await job(j0.id)).frame;
    const running = procs(out);
    check('解冻后继续推进', f3 > f2 && running.every((p) => !p.stat.includes('T')), `帧 ${f2} → ${f3}`);
    await post(`/api/jobs/${j0.id}/abort`);
    await sleep(2000);
    j = await job(j0.id);
    const left = procs(out);
    check('中止：状态 aborted，进程树全部退出', j.status === 'aborted' && left.length === 0,
        `${j.status}，残留 ${left.length} 个进程`);
}

// ---------------------------------------------------------------------------
console.log('\n[4] 同名输出自动去重（含排队中的任务与已存在的文件）');
{
    const out = path.join(outDir, 'dedupe.mp4');
    for (const f of fs.readdirSync(outDir)) if (f.startsWith('dedupe')) fs.rmSync(path.join(outDir, f));
    fs.writeFileSync(out, 'existing');
    const jobs = await submit([cli(out, ['-p', 'lanczos', '-s', '2']), cli(out, ['-p', 'lanczos', '-s', '2'])]);
    const later = await submit([cli(out, ['-p', 'lanczos', '-s', '2'])]);
    const outs = [...jobs, ...later].map((j) => path.basename(j.outPath));
    check('输出名', outs.join(',') === 'dedupe_2.mp4,dedupe_3.mp4,dedupe_4.mp4', outs.join(', '));
    check('-o 参数同步替换', [...jobs, ...later].every((j) => j.args[j.args.indexOf('-o') + 1] === j.outPath));
    for (const j of [...jobs, ...later]) await waitDone(j.id);
}

// ---------------------------------------------------------------------------
console.log('\n[5] 打开所在文件夹 / 日志目录（接口层；访达是否选中需人工确认）');
{
    const last = (await get('/api/jobs')).jobs.at(-1);
    const r1 = await post(`/api/jobs/${last.id}/open-folder`);
    const r2 = await post('/api/logs/open');
    check('接口返回成功', r1.ok === true && r2.ok === true, r2.dir);
}

// ---------------------------------------------------------------------------
console.log('\n[6] Anime4K 与 SDR 转 HDR（阶段 4：自编 FFmpeg 带 libplacebo）');
check('health 报告 libplacebo 可用', h.features?.libplacebo === true, String(h.features?.libplacebo));
{
    const out = path.join(outDir, 'anime4k.mp4');
    fs.rmSync(out, { force: true });
    const [j0] = await submit([cli(out, ['-p', 'libplacebo', '--libplacebo-shader', 'anime4k-v4-a',
        '-w', '1708', '-h', '960', '-d', '-1'])]);
    const { j, secs } = await waitDone(j0.id);
    const f = frames(out);
    check(`Anime4K（${secs.toFixed(0)}s）`, j.status === 'done' && f === '1708,960,72', `${j.status}，输出 ${f}${j.error ? `，${j.error}` : ''}`);
}
// 界面默认编码器 libx264 加 HDR 会自动换成 libx265；苹果硬编走 p010le
for (const [fmt, codec, enc, trc] of [
    ['pq', 'libx264', ['-e', 'crf=18'], 'smpte2084'],
    ['hlg', 'hevc_videotoolbox', ['-e', 'flags=+qscale', '-e', `global_quality=${79 * 118}`], 'arib-std-b67'],
]) {
    const out = path.join(outDir, `hdr_${fmt}.mp4`);
    fs.rmSync(out, { force: true });
    const [j0] = await submit([{ file: IN_B, outPath: out, engine: 'cli', autoStage: false,
        args: ['-i', IN_B, '-o', out, '-p', 'lanczos', '-s', '2', '--hdr', '--hdr-format', fmt, '--hdr-peak', '1000',
            '-c', codec, ...enc] }]);
    const { j, secs } = await waitDone(j0.id);
    let info = '无输出';
    try {
        info = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
            'stream=codec_name,profile,pix_fmt,color_transfer,color_primaries', '-of', 'csv=p=0', out])
            .toString().trim().replace(/,+$/, '');  // 带 side data 的流行尾会多一个逗号
    } catch { /* 留给 check 报告 */ }
    check(`HDR ${fmt.toUpperCase()} + ${codec}（${secs.toFixed(0)}s）`,
        j.status === 'done' && info === `hevc,Main 10,yuv420p10le,${trc},bt2020`, `${j.status}，${info}${j.error ? `，${j.error}` : ''}`);
}

// ---------------------------------------------------------------------------
if (process.env.SKIP_SLOW !== '1') {
    console.log('\n[7] SwiftVR：检查点暂停（退出码 4）→ 续跑，帧数正确');
    const out = path.join(outDir, 'swiftvr_pause.mp4');
    for (const f of fs.readdirSync(outDir)) if (f.startsWith('swiftvr_pause')) fs.rmSync(path.join(outDir, f));
    const args = ['--model', 'swiftvr', '-i', IN_A20, '-o', out, '--codec', 'libx264', '--crf', '18',
        '--device', 'mps', '--resolution', '720'];
    const [j0] = await submit([{ file: IN_A20, outPath: out, engine: 'python', autoStage: false, args }]);
    let j;
    for (let i = 0; i < 600; i++) { j = await job(j0.id); if (j.frame > 30) break; await sleep(500); }
    await post(`/api/jobs/${j0.id}/pause`);
    const r1 = await waitDone(j0.id);
    j = r1.j;
    const ckpt = fs.existsSync(`${out}.v2xckpt.json`) ? JSON.parse(fs.readFileSync(`${out}.v2xckpt.json`, 'utf8')) : null;
    check('在检查点停止', j.status === 'aborted' && j.canResume && ckpt?.nextFrame === 240
        && j.logTail.some((l) => /退出码 4/.test(l)), `${j.status}，canResume=${j.canResume}，nextFrame=${ckpt?.nextFrame}`);
    check('停止后无残留进程', procs(out).length === 0);
    await post(`/api/jobs/${j0.id}/resume`);
    const r2 = await waitDone(j0.id);
    const f = frames(out);
    check('续跑完成', r2.j.status === 'done' && f === '1280,720,480'
        && r2.j.logTail.some((l) => /从第 240 帧续跑/.test(l)), `${r2.j.status}，输出 ${f}`);
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
const stray = procs(path.basename(outDir));
if (stray.length > 0) console.log('警告：有残留进程', stray);
process.exit(fail === 0 ? 0 : 1);
