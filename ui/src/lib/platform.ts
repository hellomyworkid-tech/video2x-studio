// 宿主平台与可选能力。bridge 只监听 127.0.0.1，界面与它必然在同一台机器上：
// 先按 UA 判断，/api/health 返回后以 bridge 报告的为准（App 收到后会整体重渲染）。

export type HostPlatform = 'win32' | 'darwin' | 'linux';

export interface HostFeatures {
    /** FFmpeg 带 libplacebo 滤镜：Anime4K 与 SDR 转 HDR 依赖它（Homebrew 的 ffmpeg@7 没有） */
    libplacebo: boolean;
}

let platform: HostPlatform = /Macintosh|Mac OS X/.test(globalThis.navigator?.userAgent ?? '') ? 'darwin' : 'win32';
let features: HostFeatures = { libplacebo: true };

export function setHost(p?: string, f?: Partial<HostFeatures>) {
    if (p === 'win32' || p === 'darwin' || p === 'linux') platform = p;
    if (f) features = { ...features, ...f };
}

export const isMac = () => platform === 'darwin';
export const hostFeatures = () => features;
