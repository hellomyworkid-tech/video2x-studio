// Electron preload 暴露的桥接对象（浏览器 dev 模式下不存在）
declare global {
    interface Window {
        v2xElectron?: {
            /** 把拖拽进来的 File 对象解析为真实绝对路径；失败返回空串 */
            getPathForFile: (file: File) => string;
            /** 原生文件对话框（仅 macOS 暴露；Windows 走 bridge 的 PowerShell 对话框），取消时返回空数组 */
            showDialog?: (kind: 'open' | 'save' | 'dir') => Promise<string[]>;
        };
    }
}

export {};
