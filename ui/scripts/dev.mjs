// Starts the bridge server (API) and the Vite dev server together.
// Any extra CLI args (e.g. --port, --host) are forwarded to Vite.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);

const bridge = spawn(process.execPath, [path.join(root, 'server', 'bridge.mjs')], {
    stdio: 'inherit',
    cwd: root,
});

const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const vite = spawn(process.execPath, [viteBin, ...args], {
    stdio: 'inherit',
    cwd: root,
});

let shuttingDown = false;
function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    try { bridge.kill(); } catch { /* noop */ }
    try { vite.kill(); } catch { /* noop */ }
    process.exit(code ?? 0);
}

bridge.on('exit', (code) => {
    console.log(`[dev] bridge exited with code ${code}`);
    shutdown(code ?? 0);
});
vite.on('exit', (code) => shutdown(code ?? 0));
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
