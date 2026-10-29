// macOS 打包（docs/macos/01-feasibility.md D4 / D10，验收见 05-acceptance.md 阶段 5）。
// ui/package.json 的 dist:mac 依次运行：
//   node ../scripts/macos/package-app.mjs pre
//       在 dist-macos/ 准备包内文件：C++ 核心与 FFmpeg 命令行，连同它们用到的全部 Homebrew 动态库
//       （收进 build-macos/lib，引用改成 @rpath 后重新 ad-hoc 签名）；MoltenVK 的 ICD 清单
//       （libplacebo 经 vulkan-loader 加载 MoltenVK 要用）；随包 Python（python-build-standalone
//       + engine-python/requirements-macos-lock.txt）；App 图标；随包第三方组件的许可证原文与源码清单
//       （dist-macos/licenses，GPL 组件的源码地址取与随包二进制同一版本）
//   electron-builder --mac dir
//       按 package.json 的 mac.extraFiles 把 dist-macos、模型、Mac 用的权重拷进 .app/Contents，
//       布局与项目根相同（bridge 的 findProjectRoot 会把 Contents 当作项目根）
//   node ../scripts/macos/package-app.mjs post
//       在 .app 内预编译 .pyc（包内只读，运行时不写）、整体 ad-hoc 签名，
//       并检查包内所有 Mach-O 都不引用包外（Homebrew、本仓库）的动态库
// 环境变量 VIDEO2X_CN=1（或参数 --cn）：Python 运行时取 npmmirror 镜像、pip 用清华源；
// 下载内容一律按官方 SHA-256 与锁定版本核对。
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAGE = path.join(ROOT, 'dist-macos');
const APP = path.join(ROOT, 'ui', 'release', 'mac-arm64', 'Video2X Studio.app');
const LIB_REL = path.join('build-macos', 'lib');
const CN = process.argv.includes('--cn') || process.env.VIDEO2X_CN === '1';

// python-build-standalone：与开发环境同为 3.12；文件名与 SHA-256 取自官方发布页的 SHA256SUMS
const PBS_TAG = '20261026';
const PBS_FILE = `cpython-3.12.16+${PBS_TAG}-aarch64-apple-darwin-install_only.tar.gz`;
const PBS_SHA256 = 'fbf4afef53c2a6b72bb741bc06d5671a9dfaf87bd84e5aa73ac9b3d0d589f14e';
const PBS_URL = (CN
    ? `https://registry.npmmirror.com/-/binary/python-build-standalone/${PBS_TAG}/`
    : `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/`)
    + encodeURIComponent(PBS_FILE);

const run = (cmd, args, opts = {}) =>
    execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 << 20, ...opts });
const step = (msg) => console.log(`\n==> ${msg}`);
function fail(msg) {
    console.error(`\n✗ ${msg}`);
    process.exit(1);
}
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// ---------------------------------------------------------------------------
// Mach-O 工具
// ---------------------------------------------------------------------------

const isSystemLib = (p) => p.startsWith('/usr/lib/') || p.startsWith('/System/');

function isMachO(file) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        const b = Buffer.alloc(4);
        if (fs.readSync(fd, b, 0, 4, 0) < 4) return false;
        const m = b.readUInt32BE(0);
        return m === 0xcffaedfe || m === 0xfeedfacf || m === 0xcafebabe;
    } catch {
        return false;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

/** 解析 otool -l：本库的 install name、依赖（含 weak）、LC_RPATH */
function loadCommands(file) {
    const res = { id: null, deps: [], weak: new Set(), rpaths: [] };
    let cmd = null;
    const value = (t, key) => t.slice(key.length + 1).replace(/ \(offset \d+\)$/, '');
    // otool 把以 "(…)" 结尾的路径当成静态库成员（lib.a(member.o)），
    // Electron 的 "Helper (GPU)" 之类要经一个不带括号的软链接去读
    let target = file;
    let tmp = null;
    if (/\)$/.test(file)) {
        tmp = fs.mkdtempSync(path.join(STAGE, 'otool-'));
        target = path.join(tmp, 'macho');
        fs.symlinkSync(file, target);
    }
    let out;
    try {
        out = run('otool', ['-l', target]);
    } finally {
        if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    }
    for (const line of out.split('\n')) {
        const t = line.trim();
        if (t.startsWith('cmd ')) cmd = t.slice(4);
        else if (t.startsWith('name ') && cmd === 'LC_ID_DYLIB') res.id = value(t, 'name');
        else if (t.startsWith('name ') && /^LC_(LOAD|LOAD_WEAK|REEXPORT|LOAD_UPWARD|LAZY_LOAD)_DYLIB$/.test(cmd)) {
            const dep = value(t, 'name');
            res.deps.push(dep);
            if (cmd === 'LC_LOAD_WEAK_DYLIB') res.weak.add(dep);
        } else if (t.startsWith('path ') && cmd === 'LC_RPATH') res.rpaths.push(value(t, 'path'));
    }
    return res;
}

/** 按 dyld 规则在原安装位置找到依赖的真实文件；rpath 沿加载链继承 */
function resolveDep(dep, file, rpathDirs) {
    const expand = (p) => p.replace(/^@loader_path/, path.dirname(file)).replace(/^@executable_path/, path.dirname(file));
    const real = (p) => (fs.existsSync(p) ? fs.realpathSync(p) : null);
    if (dep.startsWith('@rpath/')) {
        for (const dir of rpathDirs) {
            const hit = real(path.join(dir, dep.slice('@rpath/'.length)));
            if (hit) return hit;
        }
        return null;
    }
    return real(expand(dep));
}

function signAdhoc(file) {
    run('codesign', ['--force', '--sign', '-', '--timestamp=none', file], { stdio: 'pipe' });
}

// ---------------------------------------------------------------------------
// pre：C++ 核心与 FFmpeg 命令行，连同依赖的动态库，改成可重定位
// ---------------------------------------------------------------------------

function stageNative() {
    step('收集 C++ 核心与 FFmpeg 依赖的动态库 → dist-macos/build-macos/lib');
    for (const d of ['build-macos', 'third_party', 'vulkan']) fs.rmSync(path.join(STAGE, d), { recursive: true, force: true });

    const ffLib = path.join('..', '..', '..', LIB_REL);
    const roots = [
        { rel: path.join('build-macos', 'video2x'), rpaths: ['@executable_path', '@executable_path/lib'] },
        { rel: path.join('build-macos', 'libvideo2x.dylib'), rpaths: ['@loader_path/lib'] },
        { rel: path.join('third_party', 'ffmpeg-macos', 'bin', 'ffmpeg'), rpaths: [`@executable_path/${ffLib}`] },
        { rel: path.join('third_party', 'ffmpeg-macos', 'bin', 'ffprobe'), rpaths: [`@executable_path/${ffLib}`] },
    ];
    // 真实路径 → 包内条目；同一个库被不同路径（opt 与 Cellar、带不带版本号）引用时只收一份
    const entries = new Map();
    const names = new Map();
    for (const r of roots) {
        const src = path.join(ROOT, r.rel);
        if (!fs.existsSync(src)) fail(`缺少 ${r.rel}（先运行 scripts/macos/build-core.sh 与 build-ffmpeg.sh）`);
        const real = fs.realpathSync(src);
        entries.set(real, { src: real, dst: path.join(STAGE, r.rel), rpaths: r.rpaths, name: path.basename(r.rel), inherited: [] });
        names.set(path.basename(r.rel), real);
    }

    const queue = [...entries.values()];
    while (queue.length > 0) {
        const e = queue.shift();
        const lc = loadCommands(e.src);
        const own = lc.rpaths.map((p) => p.replace(/^@(loader|executable)_path/, path.dirname(e.src)));
        const rpathDirs = [...own, ...e.inherited];
        e.lc = lc;
        e.changes = [];
        for (const dep of lc.deps) {
            if (dep === lc.id || isSystemLib(dep)) continue;
            const real = resolveDep(dep, e.src, rpathDirs);
            if (!real) {
                if (lc.weak.has(dep)) continue;
                fail(`找不到 ${dep}（被 ${e.src} 引用）`);
            }
            let target = entries.get(real);
            if (!target) {
                const name = path.basename(dep);
                if (names.has(name) && names.get(name) !== real) fail(`两个不同的库同名 ${name}：${names.get(name)} 与 ${real}`);
                target = { src: real, dst: path.join(STAGE, LIB_REL, name), rpaths: ['@loader_path'], name, inherited: rpathDirs };
                entries.set(real, target);
                names.set(name, real);
                queue.push(target);
            }
            e.changes.push([dep, `@rpath/${target.name}`]);
        }
    }

    for (const e of entries.values()) {
        fs.mkdirSync(path.dirname(e.dst), { recursive: true });
        fs.copyFileSync(e.src, e.dst);
        fs.chmodSync(e.dst, 0o755);
        const args = [];
        if (e.lc.id) args.push('-id', `@rpath/${e.name}`);
        for (const [from, to] of e.changes) if (from !== to) args.push('-change', from, to);
        for (const p of e.lc.rpaths) if (!e.rpaths.includes(p)) args.push('-delete_rpath', p);
        for (const p of e.rpaths) if (!e.lc.rpaths.includes(p)) args.push('-add_rpath', p);
        if (args.length > 0) run('install_name_tool', [...args, e.dst], { stdio: 'pipe' });
        signAdhoc(e.dst);
    }
    const libs = [...entries.values()].filter((e) => path.dirname(e.dst) === path.join(STAGE, LIB_REL));
    console.log(`  ${roots.length} 个入口，${libs.length} 个依赖库：${libs.map((e) => e.name).sort().join(' ')}`);

    // libplacebo 经 vulkan-loader 加载 MoltenVK：ICD 清单里的库路径相对清单所在目录
    const brewMvk = run('brew', ['--prefix', 'molten-vk']).trim();
    const icd = JSON.parse(fs.readFileSync(path.join(brewMvk, 'etc', 'vulkan', 'icd.d', 'MoltenVK_icd.json'), 'utf8'));
    if (!fs.existsSync(path.join(STAGE, LIB_REL, 'libMoltenVK.dylib'))) fail('依赖里没有 libMoltenVK.dylib');
    icd.ICD.library_path = path.join('..', '..', LIB_REL, 'libMoltenVK.dylib');
    fs.mkdirSync(path.join(STAGE, 'vulkan', 'icd.d'), { recursive: true });
    fs.writeFileSync(path.join(STAGE, 'vulkan', 'icd.d', 'MoltenVK_icd.json'), `${JSON.stringify(icd, null, 4)}\n`);
    return [...entries.values()];
}

// ---------------------------------------------------------------------------
// pre：随包 Python
// ---------------------------------------------------------------------------

function stagePython() {
    step(`随包 Python：python-build-standalone ${PBS_FILE}`);
    const pyDir = path.join(STAGE, 'engine-python', 'python');
    const py = path.join(pyDir, 'bin', 'python3');
    const lock = path.join(ROOT, 'engine-python', 'requirements-macos-lock.txt');
    const marker = path.join(pyDir, '.video2x-lock');
    const want = `${PBS_FILE}\n${sha256(lock)}\n`;
    if (fs.existsSync(py) && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === want) {
        console.log('  已就绪（运行时版本与锁定文件都没变）');
        return;
    }

    const dl = path.join(STAGE, 'downloads', PBS_FILE);
    if (!fs.existsSync(dl) || sha256(dl) !== PBS_SHA256) {
        console.log(`  下载 ${PBS_URL}`);
        fs.mkdirSync(path.dirname(dl), { recursive: true });
        run('curl', ['-fL', '--retry', '3', '-o', `${dl}.part`, PBS_URL], { stdio: 'inherit' });
        fs.renameSync(`${dl}.part`, dl);
    }
    if (sha256(dl) !== PBS_SHA256) fail(`SHA-256 不符：${dl}（期望 ${PBS_SHA256}）`);

    fs.rmSync(pyDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(pyDir), { recursive: true });
    run('tar', ['-xzf', dl, '-C', path.dirname(pyDir)]);
    if (!fs.existsSync(py)) fail(`解压后没有 ${py}`);

    console.log('  按 requirements-macos-lock.txt 安装依赖（--no-deps，版本全部锁定）');
    const env = { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1' };
    if (CN) env.PIP_INDEX_URL = 'https://pypi.tuna.tsinghua.edu.cn/simple';
    // 不在这里编译 .pyc：post 阶段在 .app 内统一编译成 unchecked-hash
    const r = spawnSync(py, ['-m', 'pip', 'install', '--no-deps', '--no-compile', '--no-warn-script-location', '-r', lock],
        { env, stdio: 'inherit' });
    if (r.status !== 0) fail('pip install 失败');
    fs.writeFileSync(marker, want);
}

// ---------------------------------------------------------------------------
// pre：图标
// ---------------------------------------------------------------------------

function stageIcon() {
    const icns = path.join(ROOT, 'ui', 'build', 'icon.icns');
    if (fs.existsSync(icns)) return;
    step('生成 App 图标 ui/build/icon.icns');
    // 仓库里只有上游 Video2X 的 256×256 图标；大尺寸由它放大，换成 1024×1024 的原图会更清楚
    const src = path.join(ROOT, 'packaging', 'appimage', 'video2x.png');
    const set = path.join(STAGE, 'icon.iconset');
    fs.rmSync(set, { recursive: true, force: true });
    fs.mkdirSync(set, { recursive: true });
    for (const size of [16, 32, 128, 256, 512]) {
        run('sips', ['-z', String(size), String(size), src, '--out', path.join(set, `icon_${size}x${size}.png`)], { stdio: 'pipe' });
        run('sips', ['-z', String(size * 2), String(size * 2), src, '--out', path.join(set, `icon_${size}x${size}@2x.png`)], { stdio: 'pipe' });
    }
    fs.mkdirSync(path.dirname(icns), { recursive: true });
    run('iconutil', ['-c', 'icns', set, '-o', icns]);
}

// ---------------------------------------------------------------------------
// pre：第三方许可证与源码清单
// ---------------------------------------------------------------------------

const LICENSE_NAME = /^(licen[cs]e|copying|copyright|notice|patents)(\.[a-z0-9.]+)?$/i;
const licenseFiles = (dir) =>
    (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => LICENSE_NAME.test(n)).sort().map((n) => path.join(dir, n)) : []);

/** 随包文件属于哪个组件；本项目自己的程序返回 null（许可见 LICENSE.txt） */
function componentOf(src) {
    const keg = src.match(/^((?:\/opt\/homebrew|\/usr\/local)\/Cellar\/([^/]+)\/([^/]+))\//);
    if (keg) return { key: keg[2], kind: 'brew', keg: keg[1], version: keg[3] };
    const [top, sub, name] = path.relative(ROOT, src).split(path.sep);
    if (top === 'third_party' && sub === 'ffmpeg-macos') return { key: 'ffmpeg', kind: 'ffmpeg' };
    if (top === 'build-macos' && sub === 'third_party') return { key: name, kind: 'submodule' };
    if (top === 'build-macos') return null;
    fail(`不知道 ${src} 属于哪个组件，没法附上它的许可证`);
}

/** keg 里 Homebrew 留下的配方副本记着安装时的源码地址（与随包二进制同一版本；git 源带 tag / revision） */
function kegSource(keg, formula) {
    const rb = path.join(keg, '.brew', `${formula}.rb`);
    if (!fs.existsSync(rb)) return null;
    const m = fs.readFileSync(rb, 'utf8').match(/^\s*url "([^"]+)"(?:,\s*(?:tag|revision):\s*"([^"]+)")?/m);
    return m && (m[2] ? `${m[1]} @ ${m[2]}` : m[1]);
}

function ffmpegComponent() {
    const sh = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'build-ffmpeg.sh'), 'utf8');
    const ver = sh.match(/^VER=(\S+)$/m)?.[1];
    const sha = sh.match(/^SHA256=(\S+)$/m)?.[1];
    const url = sh.match(/FFMPEG_TARBALL_URL:-([^}]+)\}/)?.[1].replace('$VER', ver);
    if (!ver || !sha || !url) fail('读不出 scripts/macos/build-ffmpeg.sh 里的 VER / SHA256 / URL');
    const dir = path.join(ROOT, 'third_party', 'ffmpeg-src', `FFmpeg-n${ver}`);
    const texts = ['LICENSE.md', 'COPYING.GPLv2', 'COPYING.LGPLv2.1'].map((n) => path.join(dir, n));
    for (const t of texts) if (!fs.existsSync(t)) fail(`缺少 ${path.relative(ROOT, t)}（先运行 scripts/macos/build-ffmpeg.sh）`);
    return {
        name: 'FFmpeg', version: ver, texts,
        license: 'GPL-2.0-or-later（以 --enable-gpl 编译；编译参数见本项目源码 scripts/macos/build-ffmpeg.sh）',
        source: `${url}（SHA-256 ${sha}）`,
    };
}

function submoduleComponent(name) {
    const texts = licenseFiles(path.join(ROOT, 'third_party', name));
    if (texts.length === 0) fail(`third_party/${name} 里没有许可证文件`);
    const url = fs.readFileSync(path.join(ROOT, '.gitmodules'), 'utf8')
        .match(new RegExp(`path = third_party/${name}\\s+url = (\\S+)`))?.[1];
    const mit = /^\s*(The )?MIT License/i.test(fs.readFileSync(texts[0], 'utf8'));
    return { name, license: mit ? 'MIT' : '见许可证文件', source: url ?? '见 .gitmodules', texts };
}

function electronComponent() {
    const dir = path.join(ROOT, 'ui', 'node_modules', 'electron');
    const { version } = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    // electron-builder 打 Windows 包时会把这两份放在程序旁边，Mac 的 .app 里没有，要自己带上
    const texts = ['LICENSE', 'LICENSES.chromium.html'].map((n) => path.join(dir, 'dist', n));
    for (const t of texts) if (!fs.existsSync(t)) fail(`缺少 ${path.relative(ROOT, t)}（先在 ui/ 运行 npm install）`);
    return {
        name: 'Electron', version, texts, files: ['MacOS/', 'Frameworks/'],
        license: 'MIT；Chromium 及其第三方组件的许可见 LICENSES.chromium.html',
        source: `https://github.com/electron/electron/tree/v${version}`,
    };
}

/** 随包 Python 静态链接的库与版本（从随包解释器读，换 python-build-standalone 版本后自动跟上） */
function pythonRuntime() {
    const probe = `
import importlib, json, sys
def ver(mod, get):
    try:
        m = importlib.import_module(mod)
    except ImportError:
        return None
    return get(m) if get else ""
libs = [
    ("OpenSSL", "Apache-2.0", ver("_ssl", lambda m: m.OPENSSL_VERSION.split()[1])),
    ("SQLite", "public domain", ver("_sqlite3", lambda m: m.sqlite_version)),
    ("mpdecimal", "BSD-2-Clause", ver("_decimal", lambda m: m.__libmpdec_version__)),
    ("expat", "MIT", ver("pyexpat", lambda m: m.EXPAT_VERSION.split("_")[-1])),
    ("libffi", "MIT", ver("_ctypes", None)),
    ("XZ Utils", "0BSD", ver("_lzma", None)),
    ("bzip2", "bzip2-1.0.6", ver("_bz2", None)),
    ("Tcl/Tk", "TCL", ver("_tkinter", lambda m: str(m.TK_VERSION))),
]
print(json.dumps({"python": sys.version.split()[0], "libs": [l for l in libs if l[2] is not None]}))`;
    const py = path.join(STAGE, 'engine-python', 'python', 'bin', 'python3');
    return JSON.parse(run(py, ['-I', '-c', probe]));
}

function stageLicenses(entries) {
    step('随包第三方组件的许可证与源码清单 → dist-macos/licenses');
    const out = path.join(STAGE, 'licenses');
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });

    const groups = new Map();
    for (const e of entries) {
        const c = componentOf(e.src);
        if (!c) continue;
        if (!groups.has(c.key)) groups.set(c.key, { ...c, files: [] });
        groups.get(c.key).files.push(path.relative(STAGE, e.dst));
    }
    const brew = [...groups.values()].filter((g) => g.kind === 'brew').map((g) => g.key);
    const brewLicense = brew.length === 0 ? {} : Object.fromEntries(
        JSON.parse(run('brew', ['info', '--json=v2', ...brew])).formulae.map((f) => [f.name, f.license]));

    const comps = [];
    for (const g of [...groups.values()].sort((a, b) => (a.kind === 'ffmpeg' ? -1 : b.kind === 'ffmpeg' ? 1 : a.key.localeCompare(b.key)))) {
        let c;
        if (g.kind === 'ffmpeg') c = ffmpegComponent();
        else if (g.kind === 'submodule') c = submoduleComponent(g.key);
        else {
            c = {
                name: g.key, version: g.version, texts: licenseFiles(g.keg),
                license: brewLicense[g.key] || '见许可证文件',
                source: kegSource(g.keg, g.key) || '见 Homebrew 配方',
            };
        }
        comps.push({ ...c, key: g.key, files: g.files.sort() });
    }
    comps.push({ ...electronComponent(), key: 'electron' });

    const blocks = comps.map((c) => {
        for (const t of c.texts) {
            fs.mkdirSync(path.join(out, c.key), { recursive: true });
            fs.copyFileSync(t, path.join(out, c.key, path.basename(t)));
        }
        return [
            `${c.name}${c.version ? `  ${c.version}` : ''}`,
            `  许可 License   : ${c.license}`,
            `  源码 Source    : ${c.source}`,
            `  许可证 Texts   : ${c.texts.length > 0 ? c.texts.map((t) => `licenses/${c.key}/${path.basename(t)}`).join('  ') : '（keg 内没有许可证文件 / none shipped by the package）'}`,
            `  随包文件 Files : ${c.files.join('  ')}`,
        ].join('\n');
    });

    const rt = pythonRuntime();
    const site = path.join(STAGE, 'engine-python', 'python', 'lib', 'python3.12', 'site-packages');
    const python = [
        `Python 运行时 / Python runtime：CPython ${rt.python}（python-build-standalone ${PBS_TAG}）`,
        '  许可 License   : PSF-2.0（engine-python/python/lib/python3.12/LICENSE.txt）',
        `  源码 Source    : https://github.com/astral-sh/python-build-standalone/releases/tag/${PBS_TAG}`,
        `  静态链接 Statically linked: ${rt.libs.map(([n, l, v]) => `${n}${v ? ` ${v}` : ''} (${l})`).join(', ')}`,
        '  这些库的许可证全文随 python-build-standalone 同一版本的 full 归档发布（python/licenses/）。',
        '  Their full license texts ship in the same release\'s "full" archive (python/licenses/).',
        '  Python 依赖包 / packages: 各自的许可证在 engine-python/python/lib/python3.12/site-packages/*.dist-info/ 内',
    ];
    const ffDir = path.join(site, 'imageio_ffmpeg', 'binaries');
    for (const n of fs.existsSync(ffDir) ? fs.readdirSync(ffDir).filter((f) => f.startsWith('ffmpeg')) : []) {
        const gpl = fs.readFileSync(path.join(ffDir, n)).includes('--enable-gpl');
        python.push(`  ${path.relative(STAGE, path.join(ffDir, n))}: imageio-ffmpeg 的 wheel 自带的 FFmpeg 程序${gpl ? '（GPL 构建）' : ''}，`
            + '来源与源码说明见 https://github.com/imageio/imageio-ffmpeg');
    }

    const rule = '-'.repeat(78);
    const readme = [
        'Video2X Studio.app — 随包第三方组件的许可证与源码 / Third-party licenses and sources',
        '由 scripts/macos/package-app.mjs 在打包时生成。Generated at packaging time.',
        '',
        '每个子目录对应一个组件，内含该组件的许可证原文。下面列出随包文件（相对 .app/Contents）、版本、许可',
        '与源码地址；源码地址与随包二进制是同一版本，GPL 组件的对应源码可从这些地址获取。',
        '本项目自身的许可与源码见 LICENSE.txt、SOURCE.txt。',
        '',
        'Each subdirectory holds one component\'s license texts. Files (relative to .app/Contents),',
        'versions, licenses and source URLs are listed below; the URLs match the bundled versions,',
        'so the corresponding source of the GPL components is available there.',
        'See LICENSE.txt and SOURCE.txt for this project itself.',
        '',
        ...[...blocks, python.join('\n')].flatMap((b) => [rule, b]),
        '',
    ].join('\n');
    fs.writeFileSync(path.join(out, 'README.txt'), readme);
    console.log(`  ${comps.length} 个组件：${comps.map((c) => c.key).join(' ')}；另附 Python 运行时说明`);
}

// ---------------------------------------------------------------------------
// post：.app 内预编译、签名、检查
// ---------------------------------------------------------------------------

function* walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) yield* walk(p);
        else if (ent.isFile()) yield p;
    }
}

function post() {
    if (!fs.existsSync(APP)) fail(`没有 ${APP}（electron-builder --mac dir 没有成功？）`);
    const contents = path.join(APP, 'Contents');

    step('在包内预编译 .pyc（unchecked-hash：不按源文件时间戳失效，运行时也不需要写）');
    const py = path.join(contents, 'engine-python', 'python', 'bin', 'python3');
    const r = spawnSync(py, ['-m', 'compileall', '-q', '-f', '-j', '0', '--invalidation-mode', 'unchecked-hash',
        path.join(contents, 'engine-python')], { encoding: 'utf8', maxBuffer: 256 << 20 });
    const bad = (r.stdout || '').split('\n').filter((l) => l.startsWith('*** Error compiling'));
    console.log(`  完成；${bad.length} 个文件无法编译（第三方包里的测试数据或旧语法文件，运行时不导入）`);
    for (const l of bad.slice(0, 5)) console.log(`    ${l}`);

    step('检查包内 Mach-O 只引用系统库与包内的库');
    let machos = 0;
    const outside = [];
    const absRpaths = new Set();
    for (const f of walk(contents)) {
        if (!isMachO(f)) continue;
        machos++;
        const lc = loadCommands(f);
        for (const dep of lc.deps) if (!isSystemLib(dep) && !dep.startsWith('@')) outside.push(`${path.relative(contents, f)} → ${dep}`);
        for (const p of lc.rpaths) if (!p.startsWith('@')) absRpaths.add(p);
    }
    console.log(`  共 ${machos} 个 Mach-O`);
    if (absRpaths.size > 0) {
        console.log(`  提示：有指向包外的 LC_RPATH（只影响查找顺序，依赖都已在包内解析）：${[...absRpaths].slice(0, 5).join('、')}`);
    }
    if (outside.length > 0) {
        for (const l of outside.slice(0, 20)) console.error(`  ✗ ${l}`);
        fail(`${outside.length} 处引用包外的动态库`);
    }

    step('清掉扩展属性，整体 ad-hoc 签名');
    run('xattr', ['-cr', APP]);
    run('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', APP], { stdio: 'inherit' });
    const v = spawnSync('codesign', ['--verify', '--deep', '--strict', APP], { encoding: 'utf8' });
    if (v.status !== 0) fail(`签名校验失败：${(v.stderr || '').trim()}`);
    console.log('  codesign --verify --deep --strict 通过');
    console.log(`\n完成：${APP}（${run('du', ['-sh', APP]).split('\t')[0]}）`);
}

// ---------------------------------------------------------------------------

const mode = process.argv[2];
if (process.platform !== 'darwin') fail('只能在 macOS 上运行');
if (mode === 'pre') {
    const native = stageNative();
    stagePython();
    stageIcon();
    stageLicenses(native);
    console.log('\n准备完成：dist-macos/');
} else if (mode === 'post') {
    post();
} else {
    console.error('用法：node scripts/macos/package-app.mjs pre|post [--cn]');
    process.exit(2);
}
