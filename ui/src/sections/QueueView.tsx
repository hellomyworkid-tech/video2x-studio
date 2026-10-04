import { useState } from 'react';
import { Ban, CheckCircle2, CircleDashed, Film, Loader2, Play, Plus, Trash2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import type { AssetsState, InstallStatus, Job } from '@/types';
import { api } from '@/lib/api';
import JobCard from '@/sections/JobCard';
import AssetBanner from '@/sections/AssetBanner';
import InstallBanner from '@/sections/InstallBanner';
import { Button } from '@/components/ui/button';
import {
    AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
    AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface Props {
    jobs: Job[];
    assetState: AssetsState | null;
    /** 程序本体不完整时以红色错误条替代组件下载横幅 */
    install: InstallStatus | null;
    onNewJob: () => void;
    onAbort: (id: number) => void;
}

function fmtSize(bytes: number): string {
    if (bytes >= 1 << 30) return (bytes / (1 << 30)).toFixed(2) + ' GB';
    if (bytes >= 1 << 20) return (bytes / (1 << 20)).toFixed(1) + ' MB';
    return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

export default function QueueView({ jobs, assetState, install, onNewJob, onAbort }: Props) {
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [summary, setSummary] = useState<{ doneCount: number; unfinCount: number; unfinSize: number; resumeCount: number } | null>(null);
    const running = jobs.filter((j) => j.status === 'running');
    const pending = jobs.filter((j) => j.status === 'pending');
    const done = jobs.filter((j) => j.status === 'done');
    const failed = jobs.filter((j) => j.status === 'failed' || j.status === 'aborted');
    const hasFinished = jobs.some((j) => j.status !== 'running' && j.status !== 'pending');
    const continuable = jobs.filter((j) => j.status === 'aborted' || j.status === 'failed');

    const stats = [
        { label: '进行中', value: running.length, icon: Loader2, accent: 'text-cyan-400', spin: running.length > 0 },
        { label: '排队中', value: pending.length, icon: CircleDashed, accent: 'text-slate-400', spin: false },
        { label: '已完成', value: done.length, icon: CheckCircle2, accent: 'text-emerald-400', spin: false },
        { label: '失败 / 中止', value: failed.length, icon: XCircle, accent: 'text-red-400', spin: false },
    ];

    const handleClearClick = async () => {
        try {
            const { items } = await api.residuals();
            const doneItems = items.filter((i) => i.status === 'done');
            const unfin = items.filter((i) => i.status !== 'done');
            setSummary({
                doneCount: doneItems.length,
                unfinCount: unfin.length,
                unfinSize: unfin.reduce((s, i) => s + i.residuals.reduce((a, r) => a + r.size, 0), 0),
                resumeCount: unfin.filter((i) => i.canResume).length,
            });
        } catch {
            setSummary(null);
        }
        setConfirmOpen(true);
    };

    const doClear = async () => {
        setConfirmOpen(false);
        // 'all' 只删失败/中止任务的残余文件；已完成任务的输出文件后端一律保留
        const res = await api.clearFinished('all');
        toast.success(`已清除 ${res.cleared} 条已结束任务`, {
            description: res.deletedFiles > 0
                ? `删除了 ${res.deletedFiles} 个未完成残余文件；已完成作品全部保留`
                : '已完成作品全部保留',
        });
    };

    return (
        <div className="flex h-full flex-col">
            {/* 固定页头 */}
            <div className="shrink-0 border-b border-border/50 px-6 pb-4 pt-5">
                <div className="mx-auto flex max-w-5xl items-end justify-between">
                    <div>
                        <h1 className="text-xl font-bold tracking-tight">任务队列</h1>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                            批量视频增强 · 任务按添加顺序串行处理，保障 GPU 稳定性
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        {pending.length >= 2 && (
                            <Button
                                size="sm" variant="outline"
                                className="border-slate-500/40 text-slate-300 hover:bg-slate-500/10"
                                title="一键取消所有排队中的任务（运行中的不受影响；旗舰引擎断点保留）"
                                onClick={async () => {
                                    try {
                                        const res = await api.cancelPending();
                                        toast.success(`已取消 ${res.count} 条排队任务`, { description: '可随时单独重跑或续跑' });
                                    } catch (e) {
                                        toast.error(e instanceof Error ? e.message : '操作失败');
                                    }
                                }}
                            >
                                <Ban className="mr-1.5 h-3.5 w-3.5" />
                                取消全部排队
                            </Button>
                        )}
                        {continuable.length >= 2 && (
                            <Button
                                size="sm" variant="outline"
                                className="border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10"
                                title="一键继续所有已中止/失败任务：有断点的续跑，没有的从头重跑"
                                onClick={async () => {
                                    try {
                                        const res = await api.resumeAll();
                                        toast.success(`已重新排队 ${res.count} 条任务`, { description: '有断点的从断点续跑，其余从头开始' });
                                    } catch (e) {
                                        toast.error(e instanceof Error ? e.message : '操作失败');
                                    }
                                }}
                            >
                                <Play className="mr-1.5 h-3.5 w-3.5" />
                                全部继续
                            </Button>
                        )}
                        {hasFinished && (
                            <Button
                                size="sm"
                                onClick={handleClearClick}
                                className="border border-amber-400/50 bg-amber-500/15 font-semibold text-amber-300 hover:bg-amber-500/25 hover:text-amber-200"
                            >
                                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                                清除已结束任务
                            </Button>
                        )}
                        <Button onClick={onNewJob} className="glow-primary bg-primary font-semibold text-primary-foreground hover:bg-cyan-300">
                            <Plus className="mr-1.5 h-4 w-4" />
                            新建任务
                        </Button>
                    </div>
                </div>
                <div className="mx-auto mt-4 grid max-w-5xl grid-cols-4 gap-3">
                    {stats.map((s) => (
                        <div key={s.label} className="glass-card flex items-center gap-3 rounded-xl px-4 py-2.5">
                            <s.icon className={`h-[18px] w-[18px] ${s.accent} ${s.spin ? 'animate-spin' : ''}`} />
                            <div className="flex items-baseline gap-2">
                                <span className="text-lg font-bold tabular-nums leading-none">{s.value}</span>
                                <span className="text-[11px] text-muted-foreground">{s.label}</span>
                            </div>
                        </div>
                    ))}
                </div>
                {install && !install.complete
                    ? <InstallBanner install={install} />
                    : <AssetBanner state={assetState} />}
            </div>

            {/* 任务列表：仅此区域内部滚动 */}
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
                <div className="mx-auto max-w-5xl">
                    {jobs.length === 0 ? (
                        <div className="glass-card flex flex-col items-center justify-center rounded-2xl py-24 animate-fade-slide-in">
                            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-secondary">
                                <Film className="h-8 w-8 text-muted-foreground" />
                            </div>
                            <div className="text-lg font-semibold">队列为空</div>
                            <p className="mt-1.5 max-w-sm text-center text-sm text-muted-foreground">
                                添加一批视频，配置超分、补帧、防抖、降噪或 HDR 转制，然后开始批量处理。
                            </p>
                            <Button onClick={onNewJob} variant="outline" className="mt-6 border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10">
                                <Plus className="mr-1.5 h-4 w-4" />
                                创建第一个任务
                            </Button>
                        </div>
                    ) : (
                        <div className="space-y-3 pb-4">
                            {jobs.map((job, i) => (
                                <JobCard key={job.id} job={job} index={i + 1} onAbort={onAbort} />
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* 批量清除确认 */}
            <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>清除已结束任务？</AlertDialogTitle>
                        <AlertDialogDescription asChild>
                            <div className="space-y-2 text-sm">
                                {summary ? (
                                    <>
                                        {summary.doneCount > 0 && (
                                            <p className="flex items-start gap-2">
                                                <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
                                                <span>
                                                    <span className="font-semibold text-emerald-300">{summary.doneCount} 条已完成</span>
                                                    ：仅移除任务记录，<span className="font-semibold">输出视频全部保留</span>，不会被删除。
                                                </span>
                                            </p>
                                        )}
                                        {summary.unfinCount > 0 && (
                                            <p className="flex items-start gap-2">
                                                <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                                                <span>
                                                    <span className="font-semibold text-amber-300">{summary.unfinCount} 条未完成</span>
                                                    {summary.unfinSize > 0
                                                        ? <>：移除记录并<span className="font-semibold">连同 {fmtSize(summary.unfinSize)} 残余文件一并删除</span>（半成品视频与分片）。</>
                                                        : '：移除记录，磁盘上无残余文件。'}
                                                </span>
                                            </p>
                                        )}
                                        {summary.resumeCount > 0 && (
                                            <p className="rounded-md border border-cyan-500/25 bg-cyan-500/[0.06] px-2.5 py-1.5 text-xs text-cyan-200/90">
                                                其中 {summary.resumeCount} 条支持断点续跑，清除后续跑数据将一并删除。如需续跑请先取消。
                                            </p>
                                        )}
                                    </>
                                ) : (
                                    <p>将移除所有已结束任务的记录；已完成作品的输出文件保留，未完成任务的残余文件一并删除。</p>
                                )}
                            </div>
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>取消</AlertDialogCancel>
                        <AlertDialogAction onClick={doClear} className="bg-amber-500/90 font-semibold text-slate-950 hover:bg-amber-400">
                            确认清除
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}
