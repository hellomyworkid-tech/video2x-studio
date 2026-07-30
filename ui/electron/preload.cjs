// Video2X Studio — Electron preload
// 只暴露一个能力：把拖拽进来的 File 对象解析为真实绝对路径
// （contextIsolation 下渲染进程无法直接访问 webUtils）
const { contextBridge, webUtils } = require('electron');

contextBridge.exposeInMainWorld('v2xElectron', {
    getPathForFile: (file) => {
        try {
            return webUtils.getPathForFile(file);
        } catch {
            return '';
        }
    },
});
