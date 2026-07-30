import { useState } from 'react';
import {
    Ban, CheckCircle2, ChevronDown, CircleDashed, CircleStop, FileVideo, FolderOpen, Loader2, Pause, Play, RotateCcw, Trash2, XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import type { Job, JobStatus } from '@/types';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
    AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
    AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

const STATUS_META: Record<JobStatus, { label: string; className: string; icon: typeof Loader2 }> = {
    pending: { label: '排队中', className: 'bg-slate-500/15 text-slate-300 border-slate-500/30', icon: CircleDashed },
    running: { label: '处理中', className: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30', icon: Loader2 },
    done: { label: '已完成', className: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30', icon: CheckCircle2 },
    failed: { label: '失败', className: 'bg-red-500/15 text-red-300 border-red-500/30', icon: XCircle },
    aborted: { label: '已中止', className: 'bg-amber-500/15 text-amber-300 border-amber-500/30', icon: Ban },
};

const STAGING_META = { label: '预处理中', className: 'bg-violet-500/15 text-violet-300 border-violet-500/30' };

function fmtSize(bytes: number): string {
    if (bytes >= 1 << 30) return (bytes / (1 << 30)).toFixed(2) + ' GB';
    if (bytes >= 1 << 20) return (bytes / (1 << 20)).toFixed(1) + ' MB';
    return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

// Compact human summary of the CLI args for display
function summarizeArgs(args: string[]): string {
    const parts: string[] = [];
    // Python 旗舰引擎：worker.py --model xxx
    const mi = args.indexOf('--model');
    if (mi >= 0) {
        const model = args[mi + 1];
        parts.push(model === 'realbasicvsr' ? 'RealBasicVSR ×4' : model === 'flashvsr' ? 'FlashVSR ×4' : model === 'seedvr2' ? 'SeedVR2 短边×4' : model);
        const ri2 = args.indexOf('--resolution');
        if (ri2 >= 0 && args[ri2 + 1] !== '0') parts.push(`短边 ${args[ri2 + 1]}p`);
        const ci = args.indexOf('--codec');
        if (ci >= 0) parts.push(args[ci + 1]);
        const ri = args.indexOf('--crf');
        if (ri >= 0) parts.push(`crf ${args[ri + 1]}`);
        return parts.join(' · ');
    }
    const idx = args.indexOf('-p');
    if (idx >= 0) parts.push(args[idx + 1]);
    const flagMap: [string, string][] = [
        ['--stab', '防抖'], ['--denoise', '降噪'], ['--hdr', 'HDR'], ['--rife-uhd', 'UHD'],
    ];
    for (const [flag, label] of flagMap) if (args.includes(flag)) parts.push(label);
    const w = args.indexOf('-w');
    if (w >= 0) parts.push(`${args[w + 1]}×${args[w + 3]}`);
    const s = args.indexOf('-s');
    if (s >= 0) parts.push(`${args[s + 1]}×`);
    const m = args.indexOf('-m');
    if (m >= 0) parts.push(`${args[m + 1]}× 帧率`);
    const c = args.indexOf('-c');
    if (c >= 0) parts.push(args[c + 1]);
    return parts.join(' · ');
}

interface Props {
    job: Job;
    index: number; // 列表序号（随删除回收，仅用于显示）
    onAbort: (id: number) => void;
}

export default function JobCard({ job, index, onAbort }: Props) {
    const [expanded, setExpanded] = useState(false);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [residualInfo, setResidualInfo] = useState<{ size: number; count: number; canResume: boolean } | null>(null);
    const meta = STATUS_META[job.status];
    const staging = job.status === 'running' && job.phase === 'staging';
    const suspended = job.status === 'running' && !!job.suspended;
    const badgeMeta = staging
        ? { ...meta, label: STAGING_META.label, className: STAGING_META.className }
        : suspended
            ? { ...meta, label: '已挂起', className: 'bg-amber-500/15 text-amber-300 border-amber-500/30' }
            : meta;
    const active = job.status === 'running' || job.status === 'pending';
    // 支持检查点暂停的引擎：Python 旗舰（RealBasicVSR / SeedVR2）
    const pausable = job.status === 'running' && job.engine === 'python' &&
        (job.args.includes('realbasicvsr') || job.args.includes('seedvr2'));

    const handleDeleteClick = async () => {
        if (job.status === 'done') {
            // 已完成：只移除记录，输出文件绝对不动（无风险，无需弹窗）
            await api.deleteJob(job.id, 'record');
            toast.success('已移除任务记录', { description: '输出文件已保留' });
            return;
        }
        try {
            const r = await api.residual(job.id);
            const total = r.residuals.reduce((s, x) => s + x.size, 0);
            setResidualInfo({ size: total, count: r.residuals.length, canResume: r.canResume });
        } catch {
            setResidualInfo({ size: 0, count: 0, canResume: false });
        }
        setConfirmOpen(true);
    };

    const doDelete = async (mode: 'record' | 'all') => {
        setConfirmOpen(false);
        const res = await api.deleteJob(job.id, mode);
        if (mode === 'all' && res.deletedFiles > 0) {
            toast.success('任务与残余文件已删除', { description: `清理了 ${res.deletedFiles} 个文件` });
        } else {
            toast.success('已移除任务记录', { description: mode === 'record' ? '残余文件保留在磁盘上' : undefined });
        }
    };

    return (
        <div className="glass-card rounded-xl p-4 transition-colors animate-fade-slide-in">
            <div className="flex items-center gap-3">
                <div className={cn(
                    'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                    job.status === 'running' ? (suspended ? 'bg-amber-500/15' : 'bg-cyan-500/15') : 'bg-secondary'
                )}>
                    {job.status === 'running'
                        ? (suspended
                            ? <Pause className="h-5 w-5 text-amber-400" />
                            : <Loader2 className="h-5 w-5 animate-spin text-cyan-400" />)
                        : <FileVideo className="h-5 w-5 text-muted-foreground" />}
                </div>

                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold" title={job.file}>{job.fileName}</span>
                        <Badge variant="outline" className={cn('shrink-0 text-[10px] font-medium', badgeMeta.className)}>
                            {badgeMeta.label}
                        </Badge>
                        <span className="shrink-0 text-[10px] text-muted-foreground/60">#{index}</span>
                    </div>
                    <div className="mt-0.5 truncate text-xs text-muted-foreground" title={job.outPath}>
                        {summarizeArgs(job.args)} → {job.outPath.split(/[\\/]/).pop()}
                    </div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                    {job.status === 'running' && (
                        <div className="mr-2 text-right">
                            <div className={cn('text-sm font-bold tabular-nums',
                                staging ? 'text-violet-300' : suspended ? 'text-amber-300' : 'text-cyan-300')}>
                                {job.progress.toFixed(1)}%
                            </div>
                            <div className="text-[10px] tabular-nums text-muted-foreground">
                                {staging
                                    ? (job.remaining ? `暂存 ${job.remaining}` : '本地暂存中…')
                                    : suspended
                                        ? '已挂起 · 点「继续」恢复'
                                        : `${job.fps.toFixed(1)} fps${job.remaining ? ` · 剩 ${job.remaining}` : ''}`}
                            </div>
                        </div>
                    )}
                    {job.canResume && (
                        <Button
                            size="sm" variant="ghost"
                            className="h-8 border border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20"
                            onClick={async () => {
                                try {
                                    await api.resumeJob(job.id);
                                    toast.success('已从断点续跑', { description: job.fileName });
                                } catch (e) {
                                    toast.error(e instanceof Error ? e.message : '续跑失败');
                                }
                            }}
                        >
                            <Play className="mr-1 h-3.5 w-3.5" /> 续跑
                        </Button>
                    )}
                    {!job.canResume && (job.status === 'aborted' || job.status === 'failed') && (
                        <Button
                            size="sm" variant="ghost"
                            className="h-8 border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
                            title="重新排队，从头开始处理（无需重新添加任务）"
                            onClick={async () => {
                                try {
                                    await api.resumeJob(job.id);
                                    toast.success('已重新排队，从头开始', { description: job.fileName });
                                } catch (e) {
                                    toast.error(e instanceof Error ? e.message : '重跑失败');
                                }
                            }}
                        >
                            <RotateCcw className="mr-1 h-3.5 w-3.5" /> 重跑
                        </Button>
                    )}
                    {job.status === 'running' && (
                        <Button
                            size="sm" variant="ghost"
                            className={cn('h-8', suspended
                                ? 'border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
                                : 'text-amber-300 hover:bg-amber-500/10')}
                            title={suspended
                                ? '立即解冻进程，从挂起处继续（即时）'
                                : '立即冻结整个进程（全引擎通用，随时可继续；显存保持占用）'}
                            onClick={async () => {
                                try {
                                    if (suspended) {
                                        await api.unsuspendJob(job.id);
                                        toast.success('已继续运行', { description: job.fileName });
                                    } else {
                                        await api.suspendJob(job.id);
                                        toast.success('已暂停', { description: '进程已冻结，显存保持占用；点击「继续」即时恢复' });
                                    }
                                } catch (e) {
                                    toast.error(e instanceof Error ? e.message : '操作失败');
                                }
                            }}
                        >
                            {suspended
                                ? <><Play className="mr-1 h-3.5 w-3.5" /> 继续</>
                                : <><Pause className="mr-1 h-3.5 w-3.5" /> 暂停</>}
                        </Button>
                    )}
                    {pausable && !suspended && (
                        <Button
                            size="sm" variant="ghost"
                            className={cn('h-8', job.pauseRequested
                                ? 'border border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20'
                                : 'text-cyan-300 hover:bg-cyan-500/10')}
                            title={job.pauseRequested
                                ? '撤回存点停止请求：任务不再于检查点停止，照常运行'
                                : '在当前分片检查点完成后停止并退出：断点保存，显存释放，之后点「续跑」继续'}
                            onClick={async () => {
                                try {
                                    if (job.pauseRequested) {
                                        await api.unpauseJob(job.id);
                                        toast.success('已取消存点停止', { description: '任务将继续运行' });
                                    } else {
                                        await api.pauseJob(job.id);
                                        toast.success('存点停止请求已发送', { description: '将在当前分片检查点完成后停止并释放显存（SeedVR2 检查点间隔约 5 分钟）' });
                                    }
                                } catch (e) {
                                    toast.error(e instanceof Error ? e.message : '操作失败');
                                }
                            }}
                        >
                            {job.pauseRequested
                                ? <><XCircle className="mr-1 h-3.5 w-3.5" /> 取消存点</>
                                : <><CircleStop className="mr-1 h-3.5 w-3.5" /> 存点停止</>}
                        </Button>
                    )}
                    {active && (
                        <Button size="sm" variant="ghost" className="h-8 text-amber-300 hover:bg-amber-500/10"
                            title={job.status === 'pending' ? '取消排队（旗舰引擎断点保留，可随时续跑）' : '立即结束正在运行的任务'}
                            onClick={() => onAbort(job.id)}>
                            <Ban className="mr-1 h-3.5 w-3.5" /> {job.status === 'pending' ? '取消排队' : '中止'}
                        </Button>
                    )}
                    <Button
                        size="sm" variant="ghost" title="打开所在文件夹"
                        className="h-8 w-8 p-0 text-muted-foreground hover:bg-cyan-500/10 hover:text-cyan-300"
                        onClick={() => api.openFolder(job.id).catch((e) => toast.error(e instanceof Error ? e.message : '打开失败'))}
                    >
                        <FolderOpen className="h-4 w-4" />
                    </Button>
                    {!active && (
                        <Button size="sm" variant="ghost" title="删除任务"
                            className="h-8 w-8 p-0 text-muted-foreground hover:bg-red-500/10 hover:text-red-300"
                            onClick={handleDeleteClick}
                        >
                            <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                    )}
                    <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-muted-foreground" onClick={() => setExpanded(!expanded)}>
                        <ChevronDown className={cn('h-4 w-4 transition-transform', expanded && 'rotate-180')} />
                    </Button>
                </div>
            </div>

            {(job.status === 'running' || (job.status === 'done' && job.progress > 0)) && (
                <div className="mt-3">
                    <Progress value={job.progress} className="h-1.5 bg-secondary [&>div]:bg-gradient-to-r [&>div]:from-cyan-400 [&>div]:to-violet-400" />
                    {job.status === 'running' && (
                        <div className="mt-1.5 text-[10px] tabular-nums text-muted-foreground">
                            {staging
                                ? '网络/高风险源 → 本地暂存（无损）'
                                : `帧 ${job.frame} / ${job.totalFrames || '…'}`}
                            {job.pauseRequested && (
                                <span className="ml-1.5 rounded border border-amber-500/30 bg-amber-500/10 px-1 py-px text-amber-300">
                                    已请求存点停止：到达下一个检查点后停止并释放显存
                                </span>
                            )}
                            {suspended && (
                                <span className="ml-1.5 rounded border border-amber-500/30 bg-amber-500/10 px-1 py-px text-amber-300">
                                    进程已冻结，点「继续」即时恢复
                                </span>
                            )}
                        </div>
                    )}
                </div>
            )}

            {job.error && (
                <div className="mt-3 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                    {job.error}
                </div>
            )}

            {expanded && (
                <div className="mt-3 animate-fade-slide-in rounded-lg border border-border/70 bg-black/30">
                    <div className="border-b border-border/60 px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
                        {job.engine === 'python' ? 'worker.py' : 'video2x'} {job.args.join(' ')}
                    </div>
                    <div className="max-h-48 overflow-y-auto px-3 py-2 font-mono text-[10.5px] leading-relaxed text-muted-foreground/90">
                        {job.logTail.length === 0
                            ? <div>（暂无日志）</div>
                            : job.logTail.map((line, i) => <div key={i} className="whitespace-pre-wrap break-all">{line}</div>)}
                    </div>
                </div>
            )}

            {/* 未完成任务删除确认：完成任务的输出文件绝不会走到这里 */}
            <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>删除未完成的任务？</AlertDialogTitle>
                        <AlertDialogDescription asChild>
                            <div className="space-y-2 text-sm">
                                <p>
                                    「{job.fileName}」{job.status === 'failed' ? '处理失败' : '被中止'}，
                                    {residualInfo && residualInfo.count > 0
                                        ? <>磁盘上留有 <span className="font-semibold text-amber-300">{residualInfo.count} 个残余文件（共 {fmtSize(residualInfo.size)}）</span>，包括半成品视频{residualInfo.canResume ? '与断点续跑数据' : ''}。</>
                                        : '磁盘上没有检测到残余文件。'}
                                </p>
                                {residualInfo?.canResume && (
                                    <p className="rounded-md border border-cyan-500/25 bg-cyan-500/[0.06] px-2.5 py-1.5 text-xs text-cyan-200/90">
                                        该任务支持断点续跑——选择「连同残余文件删除」后检查点将一并清除，无法再续跑。
                                    </p>
                                )}
                            </div>
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>取消</AlertDialogCancel>
                        <AlertDialogAction onClick={() => doDelete('record')} className="bg-secondary text-foreground hover:bg-secondary/80">
                            仅删记录
                        </AlertDialogAction>
                        <AlertDialogAction onClick={() => doDelete('all')} className="bg-red-500/90 text-white hover:bg-red-500">
                            连同残余文件删除
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}
