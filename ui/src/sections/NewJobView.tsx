import { useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeft, FolderOpen, History, Info, Loader2, Rocket, RotateCcw, ShieldAlert, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { buildArgsForFile, buildOutputPath, buildPythonArgs, defaultJobRequest, engineFor } from '@/lib/args';
import type { GpuDevice, InstallStatus, JobRequest, PrecheckWarning } from '@/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
    AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
    AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import FileSection from '@/sections/form/FileSection';
import ProcessorSection from '@/sections/form/ProcessorSection';
import EnhanceSection from '@/sections/form/EnhanceSection';
import EncoderSection from '@/sections/form/EncoderSection';
import AdvancedSection from '@/sections/form/AdvancedSection';

interface Props {
    devices: GpuDevice[];
    /** CUDA 编号空间的设备列表（旗舰引擎专用） */
    cudaDevices: GpuDevice[];
    cliReady: boolean;
    pyReady: boolean;
    /** 程序本体完整性（null = 尚未检测完） */
    install: InstallStatus | null;
    onSubmitted: () => void;
    onCancel: () => void;
}

type TabKey = 'processor' | 'enhance' | 'encoder' | 'advanced';

const TABS: { key: TabKey; label: string }[] = [
    { key: 'processor', label: '处理器' },
    { key: 'enhance', label: '画质增强' },
    { key: 'encoder', label: '编码器' },
    { key: 'advanced', label: '高级' },
];

// ---------------------------------------------------------------------------
// 配置持久化：提交成功后保存，下次新建任务/重开程序自动恢复。
// 文件列表与输出目录不继承（避免误提交旧文件）；字段向后兼容（与默认值合并）。
// ---------------------------------------------------------------------------
const STORAGE_KEY = 'v2x.lastConfig';

function loadSavedConfig(): JobRequest | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const saved = JSON.parse(raw);
        const d = defaultJobRequest();
        return {
            ...d,
            ...saved,
            processor: { ...d.processor, ...(saved.processor || {}) },
            enhance: { ...d.enhance, ...(saved.enhance || {}) },
            encoder: { ...d.encoder, ...(saved.encoder || {}) },
            advanced: { ...d.advanced, ...(saved.advanced || {}) },
            files: [],
            outputDir: '',
        };
    } catch {
        return null;
    }
}

const PROCESSOR_NAMES: Record<string, string> = {
    lanczos: 'Lanczos 缩放', libplacebo: 'libplacebo', realesrgan: 'Real-ESRGAN',
    realcugan: 'Real-CUGAN', rife: 'RIFE 补帧', span: 'SPAN',
    realbasicvsr: 'RealBasicVSR', seedvr2: 'SeedVR2',
};

/** 把隐藏在标签页里的关键设置浓缩成一句话摘要 */
function summarizeConfig(req: JobRequest): string {
    const p = req.processor;
    const parts: string[] = [];
    let procLabel = PROCESSOR_NAMES[p.kind] ?? p.kind;
    if (p.kind === 'realesrgan') procLabel += ` · ${p.realesrganModel} ×${p.scaleFactor}`;
    else if (p.kind === 'realcugan') procLabel += ` · ${p.realcuganModel} ×${p.scaleFactor}`;
    else if (p.kind === 'span') procLabel += ` ×${p.scaleFactor}`;
    else if (p.kind === 'rife') procLabel += ` · ${p.rifeModel} ×${p.frameRateMul}`;
    else if (p.kind === 'libplacebo') procLabel += ` · ${p.width}×${p.height}`;
    else if (p.kind === 'lanczos') procLabel += p.sizeMode === 'explicit' ? ` · ${p.width}×${p.height}` : ` ×${p.scaleFactor}`;
    else if (p.kind === 'seedvr2') procLabel += p.seedvr2Resolution > 0 ? ` · 短边 ${p.seedvr2Resolution}p` : ' · 短边 ×4';
    else procLabel += ' ×4';
    parts.push(procLabel);

    const enh = [req.enhance.stab && '防抖', req.enhance.denoise && '降噪', req.enhance.hdr && 'HDR'].filter(Boolean);
    parts.push(`增强：${enh.length > 0 ? enh.join('+') : '关'}`);

    const codec = req.encoder.codec === 'custom' ? req.encoder.customCodec : req.encoder.codec;
    parts.push(`编码：${codec}${req.encoder.crf >= 0 ? ` CRF${req.encoder.crf}` : ''}`);

    const isPy = engineFor(req.processor.kind) === 'python';
    const adv = isPy
        ? [`CUDA 设备${req.advanced.cudaDeviceIndex ?? 0}`]
        : [`设备${req.advanced.deviceIndex}`];
    if (!isPy && req.advanced.hwaccel && req.advanced.hwaccel !== 'none') adv.push(`硬解 ${req.advanced.hwaccel}`);
    parts.push(`高级：${adv.join(' · ')}`);
    return parts.join('　|　');
}

export default function NewJobView({ devices, cudaDevices, cliReady, pyReady, install, onSubmitted, onCancel }: Props) {
    const [req, setReq] = useState<JobRequest>(() => loadSavedConfig() ?? defaultJobRequest());
    const [submitting, setSubmitting] = useState(false);
    const [prechecking, setPrechecking] = useState(false);
    const [precheckWarnings, setPrecheckWarnings] = useState<PrecheckWarning[] | null>(null);
    const [tab, setTab] = useState<TabKey>('processor');
    // 是否展示「已恢复上次配置」提示条
    const [restored, setRestored] = useState(() => localStorage.getItem(STORAGE_KEY) !== null);

    const patch = (p: Partial<JobRequest>) => setReq((r) => ({ ...r, ...p }));

    const resetToDefault = () => {
        setReq(defaultJobRequest());
        localStorage.removeItem(STORAGE_KEY);
        setRestored(false);
        toast.success('已恢复默认配置');
    };

    const isPython = engineFor(req.processor.kind) === 'python';
    const engineOk = isPython ? pyReady : cliReady;

    // 不可提交的原因（按优先级取第一条）：按钮变灰时必须告诉用户为什么——
    // 程序文件不完整的机器上，此前只有一个灰按钮，用户无从判断问题出在哪
    const blockReason: string | null = (() => {
        if (install && !install.complete) {
            return `程序文件不完整（缺少 ${install.missing[0]}${install.missing.length > 1 ? ` 等 ${install.missing.length} 项` : ''}），请重新完整复制程序文件夹`;
        }
        if (!engineOk) {
            return isPython
                ? 'PyTorch 重建档未就绪：缺少 Python 运行时或模型权重（见队列页顶部提示）'
                : 'ncnn 引擎未就绪：找不到 video2x.exe';
        }
        if (req.files.length === 0 && !req.outputDir.trim()) return '请先添加视频文件并选择输出目录';
        if (req.files.length === 0) return '请先添加视频文件';
        if (!req.outputDir.trim()) return '请选择输出目录';
        const needsSize = req.processor.kind === 'libplacebo'
            || (req.processor.kind === 'lanczos' && req.processor.sizeMode === 'explicit');
        if (needsSize && (req.processor.width <= 0 || req.processor.height <= 0)) return '请填写输出宽度和高度';
        if (req.encoder.codec === 'custom' && req.encoder.customCodec.trim() === '') return '请填写自定义编码器名';
        return null;
    })();
    const canSubmit = blockReason === null;
    // 环境问题（程序文件 / 引擎）醒目提示；"还没选文件"之类的常规引导保持低调
    const blockIsFault = (install !== null && !install.complete) || !engineOk;

    const previewCmd = useMemo(() => {
        if (req.files.length === 0 || !req.outputDir.trim()) return null;
        const file = req.files[0];
        const out = buildOutputPath(req, file);
        if (isPython) return `worker.py ${buildPythonArgs(req, file, out).join(' ')}`;
        return `video2x ${buildArgsForFile(req, file, out).join(' ')}`;
    }, [req, isPython]);

    const doSubmit = async () => {
        setSubmitting(true);
        try {
            const res = await api.submitBatch(req);
            // 提交成功即固化配置，供下次恢复
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...req, files: [], outputDir: '' }));
            } catch { /* 存储失败不影响主流程 */ }
            toast.success(`已加入队列：${res.jobs.length} 个任务`, {
                description: '任务将按顺序串行处理',
            });
            onSubmitted();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : '提交失败');
        } finally {
            setSubmitting(false);
        }
    };

    const submit = async () => {
        if (!canSubmit) return;
        // 提交前预检：网络盘 / 异常封装 / 超长耗时提前预警（逐文件 ffprobe，结果合并去重）
        setPrechecking(true);
        try {
            const model = req.processor.kind;
            // 并发池（6）：大批次同时拉起几百个 ffprobe 会卡死桥进程与系统
            const files = req.files;
            const results: PromiseSettledResult<Awaited<ReturnType<typeof api.precheck>>>[] =
                new Array(files.length);
            let cursor = 0;
            await Promise.all(
                Array.from({ length: Math.min(6, files.length) }, async () => {
                    while (cursor < files.length) {
                        const i = cursor++;
                        try {
                            results[i] = { status: 'fulfilled', value: await api.precheck(files[i], model) };
                        } catch (reason) {
                            results[i] = { status: 'rejected', reason };
                        }
                    }
                })
            );
            const seen = new Set<string>();
            const warnings: PrecheckWarning[] = [];
            for (const r of results) {
                if (r.status !== 'fulfilled') continue;
                for (const w of r.value.warnings) {
                    const key = w.level + '|' + w.text;
                    if (!seen.has(key)) {
                        seen.add(key);
                        warnings.push(w);
                    }
                }
            }
            if (warnings.length > 0) {
                setPrecheckWarnings(warnings);
                return; // 弹窗确认后再提交
            }
            await doSubmit();
        } catch {
            await doSubmit(); // 预检本身失败不阻断提交
        } finally {
            setPrechecking(false);
        }
    };

    return (
        <div className="flex h-full flex-col">
            {/* 固定页头 */}
            <div className="shrink-0 border-b border-border/50 px-6 pb-2.5 pt-4">
                <div className="mx-auto flex max-w-4xl items-center justify-between">
                    <div className="flex items-center gap-3">
                        <Button variant="ghost" size="sm" onClick={onCancel} className="text-muted-foreground">
                            <ArrowLeft className="mr-1 h-4 w-4" /> 返回
                        </Button>
                        <div>
                            <h1 className="text-xl font-bold tracking-tight">新建任务</h1>
                            <p className="mt-0.5 text-xs text-muted-foreground">一次配置，批量应用到所有视频</p>
                        </div>
                    </div>
                    {req.files.length > 0 && (
                        <Badge variant="outline" className="border-cyan-500/40 bg-cyan-500/10 px-3 py-1 text-cyan-300">
                            批量 × {req.files.length}
                        </Badge>
                    )}
                </div>
            </div>

            {/* 表单主体：仅这一层滚动 */}
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3">
                <div className="mx-auto max-w-4xl space-y-4">
                    {/* 上次配置恢复提示：增强/编码/高级藏在标签页里，必须把关键设置亮出来 */}
                    {restored && (
                        <div className="flex items-center gap-3 rounded-xl border border-cyan-500/30 bg-cyan-500/[0.07] px-4 py-2.5 animate-fade-slide-in">
                            <History className="h-4 w-4 shrink-0 text-cyan-300" />
                            <div className="min-w-0 flex-1 text-xs">
                                <span className="font-semibold text-cyan-200">已恢复上次使用的配置</span>
                                <span className="ml-2 text-muted-foreground" title={summarizeConfig(req)}>
                                    {summarizeConfig(req)}
                                </span>
                            </div>
                            <button
                                onClick={resetToDefault}
                                className="flex shrink-0 items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-[11px] text-muted-foreground transition hover:border-amber-400/40 hover:bg-amber-500/10 hover:text-amber-300"
                                title="清空已保存的配置并使用出厂默认"
                            >
                                <RotateCcw className="h-3 w-3" />
                                重置为默认
                            </button>
                            <button
                                onClick={() => setRestored(false)}
                                className="shrink-0 rounded p-1 text-muted-foreground/60 transition hover:bg-secondary hover:text-foreground"
                                title="知道了，隐藏此提示"
                            >
                                <X className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    )}
                    <FileSection req={req} onChange={patch} />

                    {/* 桌面式标签页 */}
                    <div className="glass-card rounded-2xl animate-fade-slide-in">
                        <div className="flex items-center gap-1 border-b border-border/60 px-3 pt-2.5">
                            {TABS.map((t) => (
                                <button
                                    key={t.key}
                                    onClick={() => setTab(t.key)}
                                    className={cn(
                                        'relative rounded-t-lg px-4 pb-2.5 pt-1.5 text-[13px] font-medium transition-colors',
                                        tab === t.key ? 'text-cyan-300' : 'text-muted-foreground hover:text-foreground'
                                    )}
                                >
                                    {t.label}
                                    {tab === t.key && (
                                        <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-cyan-400 shadow-[0_0_8px_1px_hsl(187_92%_55%/0.5)]" />
                                    )}
                                </button>
                            ))}
                        </div>
                        <div className="p-4">
                            {tab === 'processor' && <ProcessorSection req={req} onChange={patch} bare />}
                            {tab === 'enhance' &&
                                (isPython ? (
                                    <NotApplicableCard
                                        title="增强阶段不适用于旗舰引擎"
                                        desc="RealBasicVSR / SeedVR2 内置时序清洁与重建模块，防抖、滤镜降噪、HDR 转制等 FFmpeg 级增强仅对 ncnn 引擎（libplacebo / Real-ESRGAN / Real-CUGAN / RIFE / SPAN）生效。"
                                    />
                                ) : (
                                    <EnhanceSection req={req} onChange={patch} bare />
                                ))}
                            {tab === 'encoder' && (
                                <>
                                    {isPython && (
                                        <p className="mb-3 flex items-start gap-2 rounded-lg border border-cyan-500/25 bg-cyan-500/[0.06] px-3 py-2 text-[11px] leading-relaxed text-cyan-200/90">
                                            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                            旗舰引擎由 Python 推理后端执行：「编码器」「CRF」「码率」生效，像素格式 / AVOption / 流复制开关不适用（音频流默认保留）。
                                        </p>
                                    )}
                                    <EncoderSection req={req} onChange={patch} bare />
                                </>
                            )}
                            {tab === 'advanced' &&
                                (isPython ? (
                                    // 旗舰引擎：仅暴露 CUDA 设备选择（CUDA 编号空间），
                                    // 解码加速/基准等 ncnn 概念不适用
                                    <AdvancedSection req={req} onChange={patch} devices={cudaDevices} python bare />
                                ) : (
                                    <AdvancedSection req={req} onChange={patch} devices={devices} bare />
                                ))}
                        </div>
                    </div>
                </div>
            </div>

            {/* 固定底部操作条 */}
            <div className="shrink-0 border-t border-border/70 bg-background/85 px-6 py-3 backdrop-blur-xl">
                <div className="mx-auto flex max-w-4xl items-center gap-4">
                    <div className="min-w-0 flex-1">
                        {blockReason ? (
                            <div className={cn('flex items-center gap-1.5 text-xs', blockIsFault ? 'text-amber-300' : 'text-muted-foreground')}>
                                {blockIsFault
                                    ? <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                                    : <FolderOpen className="h-3.5 w-3.5 shrink-0" />}
                                <span className="truncate" title={blockReason}>{blockReason}</span>
                            </div>
                        ) : previewCmd ? (
                            <div className="truncate font-mono text-[10.5px] text-muted-foreground" title={previewCmd}>
                                {previewCmd}
                            </div>
                        ) : null}
                    </div>
                    <Button
                        onClick={submit}
                        disabled={!canSubmit || submitting || prechecking}
                        className="glow-primary bg-primary px-6 font-semibold text-primary-foreground hover:bg-cyan-300 disabled:opacity-40"
                    >
                        {prechecking ? (
                            <>
                                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                                预检中…
                            </>
                        ) : (
                            <>
                                <Rocket className="mr-1.5 h-4 w-4" />
                                {submitting ? '提交中…' : req.files.length > 1 ? `开始批量处理（${req.files.length}）` : '开始处理'}
                            </>
                        )}
                    </Button>
                </div>
            </div>

            {/* 提交前预检警告 */}
            <AlertDialog open={precheckWarnings !== null} onOpenChange={(open) => !open && setPrecheckWarnings(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle className="flex items-center gap-2">
                            <ShieldAlert className="h-5 w-5 text-amber-400" />
                            提交前发现以下风险
                        </AlertDialogTitle>
                        <AlertDialogDescription asChild>
                            <div className="space-y-2 text-sm">
                                {(precheckWarnings ?? []).map((w, i) => (
                                    <p key={i} className="flex items-start gap-2">
                                        {w.level === 'error' ? (
                                            <X className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                                        ) : (
                                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                                        )}
                                        <span className={w.level === 'error' ? 'text-red-200' : ''}>{w.text}</span>
                                    </p>
                                ))}
                                <p className="pt-1 text-xs text-muted-foreground">
                                    确认继续则照常加入队列；建议先按上述提示处理源文件以获得稳定结果。
                                </p>
                            </div>
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>取消，先处理源文件</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={() => {
                                setPrecheckWarnings(null);
                                void doSubmit();
                            }}
                            className="bg-amber-500/90 font-semibold text-slate-950 hover:bg-amber-400"
                        >
                            仍要提交
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

function NotApplicableCard({ title, desc }: { title: string; desc: string }) {
    return (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/70 bg-black/20 px-6 py-12 text-center">
            <Info className="mb-3 h-7 w-7 text-muted-foreground/60" />
            <div className="text-sm font-semibold">{title}</div>
            <p className="mt-1.5 max-w-md text-xs leading-relaxed text-muted-foreground">{desc}</p>
        </div>
    );
}

export function SectionCard({
    step,
    title,
    desc,
    children,
    action,
    bare,
}: {
    step: string;
    title: string;
    desc: string;
    children: React.ReactNode;
    action?: React.ReactNode;
    /** 标签页模式：去掉外层卡片与步骤头，只保留内容 */
    bare?: boolean;
}) {
    if (bare) {
        return <div className="animate-fade-slide-in">{children}</div>;
    }
    return (
        <section className="glass-card rounded-2xl p-5 animate-fade-slide-in">
            <header className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-cyan-500/12 font-mono text-[11px] font-bold text-cyan-300">
                        {step}
                    </span>
                    <div>
                        <h2 className="text-[15px] font-semibold">{title}</h2>
                        <p className="text-xs text-muted-foreground">{desc}</p>
                    </div>
                </div>
                {action}
            </header>
            {children}
        </section>
    );
}

export function RemoveChip({ onClick, title }: { onClick: () => void; title?: string }) {
    return (
        <button
            onClick={onClick}
            title={title ?? '移除'}
            className="ml-1 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-red-500/20 hover:text-red-300"
        >
            <X className="h-3 w-3" />
        </button>
    );
}
