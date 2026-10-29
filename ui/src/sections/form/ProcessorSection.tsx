import { Crown, Gauge, Gem, ImagePlus, Layers, Rocket, Scaling, Sparkles, Timer } from 'lucide-react';
import {
    capsFor, CUGAN_NOISE_LABELS, normalizeProcessor, recommendedCrf,
    REALCUGAN_MODELS, REALESRGAN_MODELS, RIFE_MODELS, SHADERS, SPAN_MODELS,
} from '@/lib/args';
import { isMac } from '@/lib/platform';
import type { JobRequest, ProcessorKind } from '@/types';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { SectionCard } from '@/sections/NewJobView';

interface Props {
    req: JobRequest;
    onChange: (p: Partial<JobRequest>) => void;
    bare?: boolean;
    /** 本机不可用的处理器 → 原因（卡片置灰，悬停显示原因） */
    unavailable?: Partial<Record<ProcessorKind, string>>;
}

const PROCESSORS: {
    kind: ProcessorKind;
    name: string;
    tagline: string;
    icon: typeof Sparkles;
    accent: string;
    engine?: 'ncnn' | 'pytorch';
}[] = [
    { kind: 'lanczos', name: 'Lanczos', tagline: '纯重采样 · 零伪影 · 高码率清晰源的稳妥之选', icon: Scaling, accent: 'from-slate-400/20 to-slate-500/5' },
    { kind: 'libplacebo', name: 'libplacebo', tagline: 'Anime4K 着色器 · 动漫实时超分', icon: Sparkles, accent: 'from-cyan-500/20 to-cyan-500/5' },
    { kind: 'span', name: 'SPAN', tagline: '保真优先 · 不重建细节 · 观感偏软', icon: Gauge, accent: 'from-emerald-500/20 to-emerald-500/5' },
    { kind: 'realesrgan', name: 'Real-ESRGAN', tagline: '细节重建 · 观感锐利 · 实拍常用之选', icon: ImagePlus, accent: 'from-violet-500/20 to-violet-500/5' },
    { kind: 'realcugan', name: 'Real-CUGAN', tagline: '动漫超分王者 · 结构保持最佳', icon: Layers, accent: 'from-fuchsia-500/20 to-fuchsia-500/5' },
    { kind: 'rife', name: 'RIFE 补帧', tagline: '帧率倍增 · 运动更丝滑', icon: Timer, accent: 'from-amber-500/20 to-amber-500/5' },
    { kind: 'realbasicvsr', name: 'RealBasicVSR', tagline: '重建档 · 时域稳定无闪烁 · 仅适合退化源', icon: Crown, accent: 'from-amber-400/20 to-orange-500/5', engine: 'pytorch' },
    { kind: 'seedvr2', name: 'SeedVR2', tagline: '重建档 · 退化源画质天花板 · 极慢', icon: Gem, accent: 'from-indigo-500/20 to-indigo-500/5', engine: 'pytorch' },
    { kind: 'swiftvr', name: 'SwiftVR', tagline: '重建档 · 生成式修复 · 比 SeedVR2 快约 15 倍 · 需 16GB 显存', icon: Rocket, accent: 'from-sky-500/20 to-sky-500/5', engine: 'pytorch' },
];

// Mac 上与 Windows 不同的卡片提示（显存口径换成统一内存）
const MAC_TAGLINES: Partial<Record<ProcessorKind, string>> = {
    swiftvr: '重建档 · 生成式修复 · 需 24GB 以上统一内存',
};

const RES_PRESETS = [
    { label: '1080p', w: 1920, h: 1080 },
    { label: '1440p', w: 2560, h: 1440 },
    { label: '4K', w: 3840, h: 2160 },
];

export default function ProcessorSection({ req, onChange, bare, unavailable = {} }: Props) {
    const p = req.processor;
    const setP = (patch: Partial<typeof p>) => {
        const merged = { ...p, ...patch };
        onChange({ processor: normalizeProcessor(merged) });
    };

    /**
     * 切换处理器：顺带把质量档跟到新处理器的推荐值。
     * 仅当当前值仍等于「旧处理器的推荐值」时才跟随 —— 也就是用户没手动调过；
     * 一旦手动改过就视为用户接管，不再覆盖他的选择。
     */
    const pickProcessor = (kind: typeof p.kind) => {
        const next: Partial<typeof p> = { kind };
        // 初次切到 lanczos 默认走倍率模式（预设的横屏分辨率对竖屏源是错的）
        if (kind === 'lanczos' && p.kind !== 'lanczos') next.sizeMode = 'scale';
        const patch: Parameters<typeof onChange>[0] = {
            processor: normalizeProcessor({ ...p, ...next }),
        };
        if (req.encoder.crf === recommendedCrf(p.kind)) {
            patch.encoder = { ...req.encoder, crf: recommendedCrf(kind) };
        }
        onChange(patch);
    };

    const caps = capsFor(p);
    const allowedNoises = caps ? caps.noises(p.scaleFactor) : null;
    const singleScale = caps !== null && caps.scales.length === 1;
    // ESRGAN 只有 realesr-generalv3 消费降噪参数（>0 时切换到 WDN 变体）
    const showEsrganWdn = p.kind === 'realesrgan' && p.realesrganModel === 'realesr-generalv3';
    // CUGAN 的降噪档位由 模型+缩放 共同决定；models-nose 不显示
    const showCuganNoise = p.kind === 'realcugan' && allowedNoises !== null;

    return (
        <SectionCard step="02" title="处理器" desc="选择核心引擎与模型——决定画质/速度的基本盘" bare={bare}>
            {/* processor cards：单行紧凑排列，说明文字进悬停提示 */}
            <div className="mb-3 grid grid-cols-9 gap-1.5">
                {PROCESSORS.map((proc) => {
                    const active = p.kind === proc.kind;
                    const blocked = unavailable[proc.kind];
                    const tagline = (isMac() && MAC_TAGLINES[proc.kind]) || proc.tagline;
                    return (
                        <button
                            key={proc.kind}
                            onClick={() => !blocked && pickProcessor(proc.kind)}
                            title={blocked ? `${proc.name} 暂不可用：${blocked}` : tagline}
                            aria-disabled={!!blocked}
                            className={cn(
                                'group relative flex flex-col items-center gap-1 rounded-lg border bg-gradient-to-b px-1.5 py-2.5 text-center transition-all duration-200',
                                proc.accent,
                                active
                                    ? 'border-cyan-400/60 shadow-[0_0_0_1px_hsl(187_92%_55%/0.3),0_6px_20px_-6px_hsl(187_92%_45%/0.3)]'
                                    : 'border-border/70 hover:border-border hover:bg-secondary/40',
                                blocked && !active && 'cursor-not-allowed opacity-35 hover:border-border/70 hover:bg-transparent'
                            )}
                        >
                            <proc.icon className={cn('h-4.5 w-4.5 h-[18px] w-[18px]', active ? 'text-cyan-300' : 'text-muted-foreground')} />
                            <span className={cn('text-[11px] font-bold leading-tight', active && 'text-cyan-200')}>{proc.name}</span>
                            {blocked ? (
                                <span className="whitespace-nowrap rounded bg-secondary px-1 py-px text-[8.5px] font-semibold leading-tight text-muted-foreground">
                                    暂不可用
                                </span>
                            ) : proc.engine === 'pytorch' && (
                                <span className="whitespace-nowrap rounded bg-amber-500/15 px-1 py-px text-[8.5px] font-semibold leading-tight text-amber-300/90">
                                    {/* SeedVR2 / SwiftVR 是目标分辨率模式，不是固定 ×4 */}
                                    {proc.kind === 'realbasicvsr' ? 'PyTorch ×4' : 'PyTorch 可调尺寸'}
                                </span>
                            )}
                            {active && (
                                <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-cyan-400 shadow-[0_0_8px_2px_hsl(187_92%_55%/0.6)]" />
                            )}
                        </button>
                    );
                })}
            </div>

            {/* 参数区与提示 */}
            <div className="rounded-xl border border-border/60 bg-black/20 p-3">
                {p.kind === 'lanczos' && (
                    <div className="flex flex-wrap items-end gap-3">
                        <div className="w-[200px]">
                            <Label className="mb-1.5 block text-xs text-muted-foreground">输出尺寸方式</Label>
                            <div className="flex h-9 rounded-md border border-border bg-input/40 p-0.5">
                                {([['scale', '按倍率'], ['explicit', '指定分辨率']] as const).map(([mode, label]) => (
                                    <button
                                        key={mode}
                                        onClick={() => setP({ sizeMode: mode })}
                                        className={cn(
                                            'flex-1 rounded text-[11px] font-medium transition-colors',
                                            p.sizeMode === mode
                                                ? 'bg-cyan-500/20 text-cyan-200'
                                                : 'text-muted-foreground hover:text-foreground'
                                        )}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                        </div>
                        {p.sizeMode === 'scale' ? (
                            <div className="w-[150px]">
                                <Label className="mb-1.5 block text-xs text-muted-foreground">缩放倍数</Label>
                                <Select value={String(p.scaleFactor)} onValueChange={(v) => setP({ scaleFactor: Number(v) })}>
                                    <SelectTrigger className="h-9 bg-input/60 text-xs"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        {[2, 3, 4].map((s) => <SelectItem key={s} value={String(s)} className="text-xs">{s}×</SelectItem>)}
                                    </SelectContent>
                                </Select>
                            </div>
                        ) : (
                            <>
                                <div className="w-[110px]">
                                    <Label className="mb-1.5 block text-xs text-muted-foreground">宽 (px)</Label>
                                    <Input type="number" min={16} value={p.width} onChange={(e) => setP({ width: Number(e.target.value) })} className="h-9 bg-input/60 text-xs" />
                                </div>
                                <div className="w-[110px]">
                                    <Label className="mb-1.5 block text-xs text-muted-foreground">高 (px)</Label>
                                    <Input type="number" min={16} value={p.height} onChange={(e) => setP({ height: Number(e.target.value) })} className="h-9 bg-input/60 text-xs" />
                                </div>
                                <div className="flex gap-1.5 pb-0.5">
                                    {RES_PRESETS.map((r) => (
                                        <button
                                            key={r.label}
                                            onClick={() => setP({ width: r.w, height: r.h })}
                                            className={cn(
                                                'rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition-colors',
                                                p.width === r.w && p.height === r.h
                                                    ? 'border-cyan-400/60 bg-cyan-500/15 text-cyan-200'
                                                    : 'border-border bg-secondary/40 text-muted-foreground hover:text-foreground'
                                            )}
                                        >
                                            {r.label}
                                        </button>
                                    ))}
                                </div>
                            </>
                        )}
                        <div className="flex h-9 items-center rounded-md border border-border/60 bg-secondary/30 px-3 text-[11px] text-muted-foreground">
                            无模型 · 不占显存 · 约 60 fps
                        </div>
                    </div>
                )}

                {p.kind === 'libplacebo' && (
                    <div className="grid grid-cols-[1fr_110px_110px_auto] items-end gap-3">
                        <div>
                            <Label className="mb-1.5 block text-xs text-muted-foreground">着色器</Label>
                            <Select value={p.shader} onValueChange={(v) => setP({ shader: v })}>
                                <SelectTrigger className="h-9 bg-input/60 text-xs"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    {SHADERS.map((s) => <SelectItem key={s} value={s} className="text-xs">{s}</SelectItem>)}
                                </SelectContent>
                            </Select>
                        </div>
                        <div>
                            <Label className="mb-1.5 block text-xs text-muted-foreground">宽 (px)</Label>
                            <Input type="number" min={16} value={p.width} onChange={(e) => setP({ width: Number(e.target.value) })} className="h-9 bg-input/60 text-xs" />
                        </div>
                        <div>
                            <Label className="mb-1.5 block text-xs text-muted-foreground">高 (px)</Label>
                            <Input type="number" min={16} value={p.height} onChange={(e) => setP({ height: Number(e.target.value) })} className="h-9 bg-input/60 text-xs" />
                        </div>
                        <div className="flex gap-1.5 pb-0.5">
                            {RES_PRESETS.map((r) => (
                                <button
                                    key={r.label}
                                    onClick={() => setP({ width: r.w, height: r.h })}
                                    className={cn(
                                        'rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition-colors',
                                        p.width === r.w && p.height === r.h
                                            ? 'border-cyan-400/60 bg-cyan-500/15 text-cyan-200'
                                            : 'border-border bg-secondary/40 text-muted-foreground hover:text-foreground'
                                    )}
                                >
                                    {r.label}
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {(p.kind === 'realesrgan' || p.kind === 'realcugan' || p.kind === 'span') && (
                    <div className="space-y-3">
                        <div className="flex flex-wrap items-end gap-3">
                            <div className="min-w-[230px] flex-1">
                                <Label className="mb-1.5 block text-xs text-muted-foreground">模型</Label>
                                {p.kind === 'realesrgan' && (
                                    <Select value={p.realesrganModel} onValueChange={(v) => setP({ realesrganModel: v })}>
                                        <SelectTrigger className="h-9 bg-input/60 text-xs"><SelectValue /></SelectTrigger>
                                        <SelectContent>{REALESRGAN_MODELS.map((m) => <SelectItem key={m} value={m} className="text-xs">{m}</SelectItem>)}</SelectContent>
                                    </Select>
                                )}
                                {p.kind === 'realcugan' && (
                                    <Select value={p.realcuganModel} onValueChange={(v) => setP({ realcuganModel: v })}>
                                        <SelectTrigger className="h-9 bg-input/60 text-xs"><SelectValue /></SelectTrigger>
                                        <SelectContent>{REALCUGAN_MODELS.map((m) => <SelectItem key={m} value={m} className="text-xs">{m}</SelectItem>)}</SelectContent>
                                    </Select>
                                )}
                                {p.kind === 'span' && (
                                    <Select value={p.spanModel} onValueChange={(v) => setP({ spanModel: v })}>
                                        <SelectTrigger className="h-9 bg-input/60 text-xs"><SelectValue /></SelectTrigger>
                                        <SelectContent>{SPAN_MODELS.map((m) => <SelectItem key={m} value={m} className="text-xs">{m}</SelectItem>)}</SelectContent>
                                    </Select>
                                )}
                            </div>
                            <div className="w-[150px]">
                                <Label className="mb-1.5 block text-xs text-muted-foreground">缩放倍数</Label>
                                {caps && singleScale ? (
                                    <div className="flex h-9 items-center gap-1.5 rounded-md border border-cyan-400/30 bg-cyan-500/10 px-3 text-xs font-semibold text-cyan-200">
                                        ×{caps.scales[0]}
                                        <span className="text-[10px] font-normal text-muted-foreground">该模型仅支持此倍率</span>
                                    </div>
                                ) : (
                                    <Select value={String(p.scaleFactor)} onValueChange={(v) => setP({ scaleFactor: Number(v) })}>
                                        <SelectTrigger className="h-9 bg-input/60 text-xs"><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                            {(caps ? caps.scales : [2, 3, 4]).map((s) => <SelectItem key={s} value={String(s)} className="text-xs">{s}×</SelectItem>)}
                                        </SelectContent>
                                    </Select>
                                )}
                            </div>
                            {showEsrganWdn && (
                                <div className="flex h-9 items-center gap-2 pb-0.5">
                                    <Switch
                                        checked={p.noiseLevel > 0}
                                        onCheckedChange={(v) => setP({ noiseLevel: v ? 1 : 0 })}
                                        id="esrgan-wdn"
                                    />
                                    <Label htmlFor="esrgan-wdn" className="text-xs">
                                        WDN 降噪变体<span className="ml-1 text-[10px] text-muted-foreground">（generalv3 专用）</span>
                                    </Label>
                                </div>
                            )}
                            {showCuganNoise && allowedNoises && (
                                <div className="w-[190px]">
                                    <Label className="mb-1.5 block text-xs text-muted-foreground">降噪档位</Label>
                                    <Select value={String(p.noiseLevel)} onValueChange={(v) => setP({ noiseLevel: Number(v) })}>
                                        <SelectTrigger className="h-9 bg-input/60 text-xs"><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                            {allowedNoises.map((n) => (
                                                <SelectItem key={n} value={String(n)} className="text-xs">{CUGAN_NOISE_LABELS[n] ?? String(n)}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                            )}
                        </div>
                        {p.kind === 'realcugan' && (
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <Label className="mb-1.5 block text-xs text-muted-foreground">线程数</Label>
                                    <Input type="number" min={1} max={8} value={p.realcuganThreads} onChange={(e) => setP({ realcuganThreads: Number(e.target.value) })} className="h-9 bg-input/60 text-xs" />
                                </div>
                                <div>
                                    <Label className="mb-1.5 block text-xs text-muted-foreground">Sync Gap（0 精确 ~ 3 最快）</Label>
                                    <Select value={String(p.realcuganSyncgap)} onValueChange={(v) => setP({ realcuganSyncgap: Number(v) })}>
                                        <SelectTrigger className="h-9 bg-input/60 text-xs"><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="0" className="text-xs">0 · 无间隙（最精确）</SelectItem>
                                            <SelectItem value="1" className="text-xs">1 · 精确同步</SelectItem>
                                            <SelectItem value="2" className="text-xs">2 · 粗略同步</SelectItem>
                                            <SelectItem value="3" className="text-xs">3 · 极粗略（最快）</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {p.kind === 'rife' && (
                    <div className="grid grid-cols-[1fr_120px_150px_110px] items-end gap-3">
                        <div>
                            <Label className="mb-1.5 block text-xs text-muted-foreground">RIFE 模型</Label>
                            <Select value={p.rifeModel} onValueChange={(v) => setP({ rifeModel: v })}>
                                <SelectTrigger className="h-9 bg-input/60 text-xs"><SelectValue /></SelectTrigger>
                                <SelectContent>{RIFE_MODELS.map((m) => <SelectItem key={m} value={m} className="text-xs">{m}</SelectItem>)}</SelectContent>
                            </Select>
                        </div>
                        <div>
                            <Label className="mb-1.5 block text-xs text-muted-foreground">帧率倍增</Label>
                            <Select value={String(p.frameRateMul)} onValueChange={(v) => setP({ frameRateMul: Number(v) })}>
                                <SelectTrigger className="h-9 bg-input/60 text-xs"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    {[2, 3, 4].map((m) => <SelectItem key={m} value={String(m)} className="text-xs">{m}×（{m === 2 ? '30→60' : m === 3 ? '30→90' : '30→120'}）</SelectItem>)}
                                </SelectContent>
                            </Select>
                        </div>
                        <div>
                            <Label className="mb-1.5 block text-xs text-muted-foreground">场景切换阈值（默认 100）</Label>
                            <Input type="number" min={1} value={p.sceneThresh} onChange={(e) => setP({ sceneThresh: Number(e.target.value) })} className="h-9 bg-input/60 text-xs" />
                        </div>
                        <div className="flex h-9 items-center gap-2 pb-0.5">
                            <Switch checked={p.rifeUhd} onCheckedChange={(v) => setP({ rifeUhd: v })} id="rife-uhd" />
                            <Label htmlFor="rife-uhd" className="text-xs">UHD 模式</Label>
                        </div>
                    </div>
                )}

                {p.kind === 'realbasicvsr' && (
                    <div className="flex flex-wrap items-end gap-3">
                        <div className="w-[210px]">
                            <Label className="mb-1.5 block text-xs text-muted-foreground">缩放倍数</Label>
                            <div className="flex h-9 items-center gap-1.5 rounded-md border border-amber-400/30 bg-amber-500/10 px-3 text-xs font-semibold text-amber-200">
                                ×4
                                <span className="text-[10px] font-normal text-muted-foreground">该引擎仅支持 4 倍超分</span>
                            </div>
                        </div>
                        <div className="flex h-9 items-center rounded-md border border-border/60 bg-secondary/30 px-3 text-[11px] text-muted-foreground">
                            内置时序清洁传播模块 · 无需降噪档位 · 自动重叠分块处理长视频
                        </div>
                    </div>
                )}

                {p.kind === 'seedvr2' && (
                    <div className="flex flex-wrap items-end gap-3">
                        <div className="w-[210px]">
                            <Label className="mb-1.5 block text-xs text-muted-foreground">目标短边分辨率</Label>
                            <Select value={String(p.seedvr2Resolution)} onValueChange={(v) => setP({ seedvr2Resolution: Number(v) })}>
                                <SelectTrigger className="h-9 bg-input/60 text-xs"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="0" className="text-xs">自动（输入短边 ×4）</SelectItem>
                                    {[720, 1080, 1440, 2160].map((r) => (
                                        <SelectItem key={r} value={String(r)} className="text-xs">{r}p 短边</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="flex h-9 items-center rounded-md border border-border/60 bg-secondary/30 px-3 text-[11px] text-muted-foreground">
                            {isMac()
                                ? '断点续跑 · fp16 权重 · VAE 固定 768 分块 · 建议 36GB 以上统一内存'
                                : '断点续跑 · BlockSwap + VAE tiling 按显存自动分档（≥8GB 可跑）'}
                        </div>
                    </div>
                )}

                {p.kind === 'swiftvr' && (
                    <div className="flex flex-wrap items-end gap-3">
                        <div className="w-[230px]">
                            <Label className="mb-1.5 block text-xs text-muted-foreground">目标短边分辨率</Label>
                            <Select value={String(p.swiftvrResolution)} onValueChange={(v) => setP({ swiftvrResolution: Number(v) })}>
                                <SelectTrigger className="h-9 bg-input/60 text-xs"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="0" className="text-xs">自动（输入短边 ×2，最高 1440）</SelectItem>
                                    {[720, 960, 1080, 1440].map((r) => (
                                        <SelectItem key={r} value={String(r)} className="text-xs">{r}p 短边</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="flex h-9 items-center rounded-md border border-border/60 bg-secondary/30 px-3 text-[11px] text-muted-foreground">
                            {isMac()
                                ? '需约 24GB 以上统一内存 · bf16 权重约 9.4GB 常驻 · 断点续跑 · 内存不足自动减小分段重试'
                                : '需 16GB 级显存 · FP8 权重约 5GB 常驻 · 断点续跑 · 显存不足自动减小分段重试'}
                        </div>
                    </div>
                )}

                <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/80">
                    {p.kind === 'lanczos' && '纯 Lanczos 重采样，不含任何神经网络：不占显存、绝不产生伪影或"塑料感"。对高码率清晰源（如 8 Mbps 以上的现代 H.264/HEVC），逐像素保真度反而高于 Real-ESRGAN 系列——源没丢细节时 AI 的"脑补"只会偏离原貌。但保真高不等于好看：想要更清晰的观感，仍应试试 Real-ESRGAN。'}
                    {p.kind === 'lanczos' && !isMac() && ' 缩放本身的耗时可忽略（1383 帧加不加 Lanczos 都是 2 秒），因此无需 GPU 加速——实测走 CUDA 硬解+scale_cuda 的全 GPU 链路反而更慢。真正的瓶颈是编码器，占总耗时约 90%：换成 hevc_nvenc 可直接快一倍（详见「编码器」标签页）。'}
                    {p.kind === 'lanczos' && isMac() && ' 缩放本身的耗时可忽略，真正的瓶颈是编码器。M5 Max 上 libx264 本身已经很快（2560×1440 约 100 fps）；hevc_videotoolbox 硬编更快，但同画质下体积要大三成左右（详见「编码器」标签页）。'}
                    {p.kind === 'libplacebo' && 'libplacebo 需要显式指定输出分辨率；Anime4K 系列着色器对动漫/动画内容效果最好，速度极快。'}
                    {p.kind === 'realesrgan' && 'realesr-animevideov3 支持 2/3/4×，为动漫视频训练；realesrgan-plus / nomos8k / realwebphoto 仅 4×；realesr-generalv3 仅 4× 但可启用 WDN 降噪变体；nomos8k-compact 仅 2×。缩放选项已按模型实际权重锁定。注意：这些模型均为 GAN 训练，会"再生"细节——源越糊收益越大，代价是不再逐像素忠实于原图，但观感往往更清晰锐利（实拍素材上 nomos8k-compact 与 animevideov3 的发丝/纹理重建明显优于 SPAN）。哪个更合眼缘因片源而异，建议实拍先试 nomos8k-compact，动漫用 animevideov3。'}
                    {p.kind === 'realcugan' && 'models-se 综合最佳（2× 时另有 1x/2x 精细降噪档）；models-pro 仅 2/3×；models-nose 仅 2× 且固定不降噪。降噪档位随 模型+倍率 联动。为动漫内容设计，真人素材建议改用 SPAN。2K 以上输出显存占用较高。'}
                    {p.kind === 'rife' && '补帧不改变分辨率；场景切换阈值越低检测越敏感（20 表示 20% 差异即判定切换），避免转场处产生伪影。可与 HDR 同用。'}
                    {p.kind === 'span' && 'SPAN 仅支持 2× / 4×，模型体积最小、速度快（720p 输入实测约 12 fps）。它是效率竞赛（NTIRE）出身的保真型模型：只做忠实放大、几乎不"再生"细节，因此不会有塑料感与振铃，但观感也偏软——头发、织物等高频区域可能糊成块状。合成退化的保真度测试里它得分最高，但那类测试恰好偏袒它这种训练方式；真实素材上不少人觉得不如 Real-ESRGAN 好看。建议在自己的片段上和 Real-ESRGAN 对比后再定。'}
                    {p.kind === 'realbasicvsr' && 'RealBasicVSR（Apache-2.0）通过双向循环传播 + SPyNet 光流对齐消除帧间闪烁，时序一致性好。但代价很高：720×1280 输入端到端实测约 1.4 fps，约为 Real-ESRGAN 4× 的 1/6、SPAN 2× 的 1/8。显存够时走整帧推理（画质最佳）；输入过大放不下会自动退化为空间分块，实测画质再降约 1.6 dB。仅在源确有明显退化（低码率、噪点、糊）时才值得；清晰源上收益很小。由独立 PyTorch 后端执行，编码器、CRF、码率、像素格式可调。'}
                    {p.kind === 'realbasicvsr' && isMac() && ' M5 Max 实测速度与 RTX 5070 Ti 相当（720p 输入 4× 端到端约 1.4 fps，854×480 输入约 2 fps），模型载入只要 1 秒；720p 输入时内存峰值约 17 GB。'}
                    {p.kind === 'swiftvr' && isMac() && 'SwiftVR（2026 年 6 月开源，Apache-2.0，Wan2.2-5B 底座）单步流式生成式视频修复。M5 Max（36 GB）实测：720p → 2560×1440 稳态约 3 fps，960p 输出约 7 fps，约为 RTX 5070 Ti 的 40%～45%（Mac 没有 FP8 计算，权重以 bf16 常驻约 9.4 GB；画质与 Windows 输出一致）。2K 输出时内存峰值约 26～29 GB，渲染期间尽量少开其他大程序。静止背景的帧间稳定性在 AI 方法中最好（接近 Lanczos）。生成式模型会补出原片没有的细节（发茬、皮肤纹理、发丝），强退化素材收益最大；清晰源上可能"补"得过头。'}
                    {p.kind === 'swiftvr' && !isMac() && 'SwiftVR（2026 年 6 月开源，Apache-2.0，Wan2.2-5B 底座）单步流式生成式视频修复。RTX 5070 Ti 实测：720p → 2560×1440 稳态约 7 fps，约为 SeedVR2 的近 30 倍、不到 nomos8k-compact 的一半（RTX 40/50 系矩阵乘走 FP8 张量核；更早的显卡自动回退 bf16 计算，会慢一些）；静止背景的帧间稳定性在 AI 方法中最好（接近 Lanczos），实测也没有出现 SeedVR2 那样改变脸型的问题。生成式模型会补出原片没有的细节（发茬、皮肤纹理、发丝），强退化素材收益最大；清晰源上可能"补"得过头。需要 16GB 级显存：权重 FP8 量化后约 5GB 常驻。权重量化、FP8 张量核计算各自带来的输出差异都在 PSNR≈50dB，远小于编码损失，肉眼不可辨。'}
                    {p.kind === 'seedvr2' && isMac() && 'SeedVR2-3B（字节跳动开源，Apache-2.0）单步扩散视频超分，在退化源上的细节再生是当前开源天花板；分辨率不敏感，默认把短边放大 4 倍（可指定目标短边）。速度最慢：M5 Max 实测 1708×960 输出约 0.22 fps，约为 RTX 5070 Ti 的一半弱，支持断点续跑可分多次完成；实测在部分人脸上会改变脸型。Mac 不支持 FP8，用官方 fp16 权重（6.8 GB）；载入模型时内存瞬时峰值约 30 GB，建议 36 GB 以上统一内存并少开其他大程序。同样只建议用于确有退化的素材，多数情况 SwiftVR 快约 30 倍。'}
                    {p.kind === 'seedvr2' && !isMac() && 'SeedVR2-3B（字节跳动开源，Apache-2.0）单步扩散视频超分，在退化源上的细节再生是当前开源天花板；分辨率不敏感，默认把短边放大 4 倍（可指定目标短边）。速度最慢：RTX 5070 Ti 实测 2560×1440 输出约 0.25 fps，支持断点续跑可分多次完成；实测在部分人脸上会改变脸型；FP8 权重 3.4 GB，显存策略按显卡自动分档。同样只建议用于确有退化的素材。'}
                    {isMac() && ['realesrgan', 'realcugan', 'span', 'rife'].includes(p.kind) && ' 以上速度为 RTX 5070 Ti 实测；M5 Max 上 NCNN 引擎约慢一倍（经 MoltenVK 运行，没有张量核加速；854×480 放大 2 倍稳态约 13 fps）。'}
                </p>
                {(p.kind === 'realbasicvsr' || p.kind === 'seedvr2' || p.kind === 'swiftvr') && (
                    <p className="mt-2 rounded-md border border-amber-500/25 bg-amber-500/[0.07] px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-200/90">
                        重建档引擎是为<strong>严重退化</strong>素材设计的（老片、极低码率、强压缩、模糊）。
                        若源本身码率高、画面干净，它们不仅慢几十倍，画质也可能不如 Lanczos / SPAN——
                        没有丢失的细节可恢复时，模型只能"编造"。不确定的话先用 SPAN 跑一遍对比。
                    </p>
                )}
            </div>
        </SectionCard>
    );
}
