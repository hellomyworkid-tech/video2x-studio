// Video2X Studio — Electron main process
// Starts the local bridge (API + static frontend), then opens a native window.

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// 与 bridge 的 VIDEO_EXTS 一致
const VIDEO_EXTS = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm2ts', 'ts', 'mpg', 'mpeg', 'rmvb', 'rm',
    'asf', 'vob', '3gp', 'm4v'];

// macOS：文件对话框用 Electron 的原生 dialog（挂在主窗口上、无需额外权限）。
// Windows 维持 bridge 的 PowerShell 对话框，preload 也只在 macOS 暴露此接口
if (process.platform === 'darwin') {
    ipcMain.handle('v2x:dialog', async (_event, kind) => {
        const win = BrowserWindow.getFocusedWindow() || mainWindow;
        if (kind === 'save') {
            const r = await dialog.showSaveDialog(win, {
                defaultPath: 'output.mp4',
                filters: [{ name: '视频文件', extensions: ['mp4', 'mkv', 'avi', 'mov', 'webm'] }],
            });
            return r.canceled || !r.filePath ? [] : [r.filePath];
        }
        const r = await dialog.showOpenDialog(win, kind === 'dir'
            ? { title: '选择输出目录', properties: ['openDirectory', 'createDirectory'] }
            : {
                title: '选择一个或多个视频文件',
                properties: ['openFile', 'multiSelections'],
                filters: [{ name: '视频文件', extensions: VIDEO_EXTS }, { name: '所有文件', extensions: ['*'] }],
            });
        return r.canceled ? [] : r.filePaths;
    });
}

const PORT = Number(process.env.BRIDGE_PORT || 7199);
const APP_URL = `http://127.0.0.1:${PORT}/`;

let mainWindow = null;
let bridgeModule = null;

async function waitForBridge(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
            if (res.ok) return true;
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 250));
    }
    return false;
}

async function startBridge() {
    // Serve the vite build from inside the packaged app
    process.env.VIDEO2X_STATIC_DIR = path.join(__dirname, '..', 'dist');
    const bridgePath = path.join(__dirname, '..', 'server', 'bridge.mjs');
    bridgeModule = await import(pathToFileURL(bridgePath).href);
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1380,
        height: 880,
        minWidth: 1100,
        minHeight: 720,
        backgroundColor: '#070b14',
        title: 'Video2X Studio',
        autoHideMenuBar: true,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.join(__dirname, 'preload.cjs'),
        },
    });

    // Open external links in the system browser, never in the app window
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http')) shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.loadURL(APP_URL);
    mainWindow.on('closed', () => { mainWindow = null; });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    app.whenReady().then(async () => {
        // 先探测：上次异常退出残留的 bridge（或已手动启动的实例）仍健康时直接复用，
        // 避免重复监听 7199 端口导致主进程未捕获异常崩溃
        const alreadyUp = await waitForBridge(1200);
        if (!alreadyUp) {
            try {
                await startBridge();
            } catch (err) {
                console.error('[electron] bridge failed to start:', err);
            }
        }
        const up = alreadyUp || (await waitForBridge());
        if (!up) {
            dialog.showErrorBox(
                'Video2X Studio 启动失败',
                `本地服务端口 ${PORT} 被其他程序占用，且不是可复用的 Video2X 服务。\n\n` +
                '请关闭占用该端口的程序（或重启电脑）后再打开本软件。');
            app.quit();
            return;
        }
        createWindow();
    });

    app.on('window-all-closed', () => {
        app.quit();
    });

    // 退出前强杀仍在运行的 worker/ffmpeg 子进程树，避免孤儿进程继续占用 GPU 与显存
    app.on('before-quit', () => {
        try {
            bridgeModule?.shutdownBridge?.();
        } catch (err) {
            console.error('[electron] shutdownBridge failed:', err);
        }
    });
}
