import { useEffect, useRef, useState } from 'react';
import { DownloadCloud, Loader2, PackageOpen, RefreshCcw, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import type { AssetStatus, AssetsState } from '@/types';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';

function fmtSize(bytes: number): string {
    if (!bytes || bytes <= 0) return '';
    if (bytes >= 1 << 30) return (bytes / (1 << 30)).toFixed(2) + ' GB';
    if (bytes >= 1 << 20) return (bytes / (1 << 20)).toFixed(1) + ' MB';
    return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

function baseName(p: string): string {
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1] || p;
}

/** 队列页顶部：组件缺失提醒 + 一键下载（多镜像自动回退）+ 实时进度 */
export default function AssetBanner({ state }: { state: AssetsState | null }) {
    const [starting, setStarting] = useState<string | null>(null);
    // 速度估算：比较两次 SSE 推送的 received 差值
    const lastSample = useRef<{ received: number; ts: number }>({ received: 0, ts: 0 });
    const [speed, setSpeed] = useState(0);

    const downloading = !!state?.active;
    const received = state?.received ?? 0;

    useEffect(() => {
        const now = Date.now();
        const prev = lastSample.current;
        if (prev.ts > 0 && received > prev.received) {
            const dt = (now - prev.ts) / 1000;
            if (dt > 0) setSpeed((received - prev.received) / dt);
        }
        lastSample.current = { received, ts: now };
    }, [received]);

    useEffect(() => {
        if (!downloading) {
            lastSample.current = { received: 0, ts: 0 };
            setSpeed(0);
            setStarting(null);
        }
    }, [downloading]);

    if (!state) return null;
    const missing = state.assets.filter((a) => !a.installed);
    if (missing.length === 0 && !downloading && !state.error) return null;

    const startDownload = async (a: AssetStatus) => {
        setStarting(a.id);
        try {
            await api.downloadAsset(a.id);
        } catch (e) {
            setStarting(null);
            toast.error(e instanceof Error ? e.message : '下载启动失败');
        }
    };

    const totalMissingSize = (a: AssetStatus) =>
        a.files.filter((f) => !f.ok).reduce((s, f) => s + (f.expectedSize ?? 0), 0);

    const pct = state.total > 0 ? Math.min(100, (received / state.total) * 100) : null;

    return (
        <div className="mx-auto mt-3 max-w-5xl">
            <div className="rounded-xl border border-amber-400/40 bg-amber-500/[0.08] px-4 py-3 animate-fade-slide-in">
                {missing.length > 0 && (
                    <div className="space-y-2">
                        {missing.map((a) => {
                            const missingCount = a.files.filter((f) => !f.ok).length;
                            const size = totalMissingSize(a);
                            const busy = downloading || starting !== null;
                            const isActive = state.active === a.id;
                            return (
                                <div key={a.id} className="flex items-center gap-3">
                                    <PackageOpen className="h-4 w-4 shrink-0 text-amber-300" />
                                    <div className="min-w-0 flex-1 text-xs">
                                        <span className="font-semibold text-amber-200">缺少组件：{a.name}</span>
                                        <span className="ml-2 text-muted-foreground">
                                            {missingCount} 个文件{size > 0 ? ` · 约 ${fmtSize(size)}` : ''}
                                        </span>
                                    </div>
                                    {!isActive && (
                                        <Button
                                            size="sm"
                                            disabled={busy}
                                            onClick={() => startDownload(a)}
                                            className="h-7 border border-amber-400/50 bg-amber-500/20 px-3 text-xs font-semibold text-amber-200 hover:bg-amber-500/35"
                                        >
                                            {starting === a.id ? (
                                                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                            ) : (
                                                <DownloadCloud className="mr-1 h-3 w-3" />
                                            )}
                                            立即下载
                                        </Button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}

                {downloading && (
                    <div className={missing.length > 0 ? 'mt-2.5 border-t border-amber-400/20 pt-2.5' : ''}>
                        <div className="flex items-center gap-2 text-xs">
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-300" />
                            <span className="min-w-0 flex-1 truncate text-cyan-100">
                                正在下载 {state.file ? baseName(state.file) : '…'}
                                <span className="ml-2 text-muted-foreground">
                                    镜像：{state.mirror ?? '…'}
                                    {pct !== null && ` · ${fmtSize(received)} / ${fmtSize(state.total)}`}
                                    {pct === null && received > 0 && ` · 已下载 ${fmtSize(received)}`}
                                    {speed > 0 && ` · ${fmtSize(speed)}/s`}
                                </span>
                            </span>
                            {pct !== null && (
                                <span className="shrink-0 font-mono text-cyan-300">{pct.toFixed(1)}%</span>
                            )}
                        </div>
                        <Progress value={pct ?? 100} className={`mt-1.5 h-1.5 ${pct === null ? 'animate-pulse' : ''}`} />
                        <p className="mt-1 text-[10.5px] text-muted-foreground">
                            支持断点续传；当前镜像失败会自动切换备用源。大文件下载期间可正常排队任务。
                        </p>
                    </div>
                )}

                {state.error && !downloading && (
                    <div className={`flex items-start gap-2 text-xs ${missing.length > 0 ? 'mt-2.5 border-t border-amber-400/20 pt-2.5' : ''}`}>
                        <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
                        <div className="min-w-0 flex-1">
                            <span className="font-semibold text-red-300">下载失败</span>
                            <span className="ml-2 break-all text-muted-foreground">{state.error}</span>
                        </div>
                        <RefreshCcw className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    </div>
                )}
            </div>
        </div>
    );
}
