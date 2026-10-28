// Video2X Studio — Electron preload
// 暴露给渲染进程的能力（contextIsolation 下渲染进程无法直接访问 webUtils / ipcRenderer）：
// - 把拖拽进来的 File 对象解析为真实绝对路径
// - macOS：原生文件对话框（主进程 dialog，窗口模态、无需额外权限）。
//   Windows 不暴露，界面回落到 bridge 的 PowerShell 对话框，行为与移植前一致
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('v2xElectron', {
    getPathForFile: (file) => {
        try {
            return webUtils.getPathForFile(file);
        } catch {
            return '';
        }
    },
    ...(process.platform === 'darwin'
        ? { showDialog: (kind) => ipcRenderer.invoke('v2x:dialog', kind) }
        : {}),
});
