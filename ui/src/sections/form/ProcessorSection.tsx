import { Crown, Flame, Gauge, Gem, ImagePlus, Layers, Sparkles, Timer } from 'lucide-react';
import {
    capsFor, CUGAN_NOISE_LABELS, normalizeProcessor,
    REALCUGAN_MODELS, REALESRGAN_MODELS, RIFE_MODELS, SHADERS, SPAN_MODELS,
} from '@/lib/args';
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
}

const PROCESSORS: {
    kind: ProcessorKind;
    name: string;
    tagline: string;
    icon: typeof Sparkles;
    accent: string;
    engine?: 'ncnn' | 'pytorch';
}[] = [
    { kind: 'libplacebo', name: 'libplacebo', tagline: 'Anime4K 着色器 · 动漫实时超分', icon: Sparkles, accent: 'from-cyan-500/20 to-cyan-500/5' },
    { kind: 'realesrgan', name: 'Real-ESRGAN', tagline: '通用修复 · 实拍与动漫皆宜', icon: ImagePlus, accent: 'from-violet-500/20 to-violet-500/5' },
    { kind: 'realcugan', name: 'Real-CUGAN', tagline: '动漫超分王者 · 结构保持最佳', icon: Layers, accent: 'from-fuchsia-500/20 to-fuchsia-500/5' },
    { kind: 'rife', name: 'RIFE 补帧', tagline: '帧率倍增 · 运动更丝滑', icon: Timer, accent: 'from-amber-500/20 to-amber-500/5' },
    { kind: 'span', name: 'SPAN', tagline: '轻量高效 · 快速批量超分', icon: Gauge, accent: 'from-emerald-500/20 to-emerald-500/5' },
    { kind: 'realbasicvsr', name: 'RealBasicVSR', tagline: '旗舰 · 时域稳定无闪烁 · 实拍长视频', icon: Crown, accent: 'from-amber-400/20 to-orange-500/5', engine: 'pytorch' },
    { kind: 'flashvsr', name: 'FlashVSR', tagline: '旗舰 · 扩散模型 · 重度压缩/低质源最强', icon: Flame, accent: 'from-rose-500/20 to-red-500/5', engine: 'pytorch' },
    { kind: 'seedvr2', name: 'SeedVR2', tagline: '旗舰 · 画质天花板 · 分辨率不敏感', icon: Gem, accent: 'from-indigo-500/20 to-indigo-500/5', engine: 'pytorch' },
];

const RES_PRESETS = [
    { label: '1080p', w: 1920, h: 1080 },
    { label: '1440p', w: 2560, h: 1440 },
    { label: '4K', w: 3840, h: 2160 },
];

export default function ProcessorSection({ req, onChange, bare }: Props) {
    const p = req.processor;
    const setP = (patch: Partial<typeof p>) => {
        const merged = { ...p, ...patch };
        onChange({ processor: normalizeProcessor(merged) });
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
            <div className="mb-3 grid grid-cols-8 gap-1.5">
                {PROCESSORS.map((proc) => {
                    const active = p.kind === proc.kind;
                    return (
                        <button
                            key={proc.kind}
                            onClick={() => setP({ kind: proc.kind })}
                            title={proc.tagline}
                            className={cn(
                                'group relative flex flex-col items-center gap-1 rounded-lg border bg-gradient-to-b px-1.5 py-2.5 text-center transition-all duration-200',
                                proc.accent,
                                active
                                    ? 'border-cyan-400/60 shadow-[0_0_0_1px_hsl(187_92%_55%/0.3),0_6px_20px_-6px_hsl(187_92%_45%/0.3)]'
                                    : 'border-border/70 hover:border-border hover:bg-secondary/40'
                            )}
                        >
                            <proc.icon className={cn('h-4.5 w-4.5 h-[18px] w-[18px]', active ? 'text-cyan-300' : 'text-muted-foreground')} />
                            <span className={cn('text-[11px] font-bold leading-tight', active && 'text-cyan-200')}>{proc.name}</span>
                            {proc.engine === 'pytorch' && (
                                <span className="rounded bg-amber-500/15 px-1 py-px text-[8.5px] font-semibold leading-tight text-amber-300/90">
                                    PyTorch ×4
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

                {p.kind === 'flashvsr' && (
                    <div className="flex flex-wrap items-end gap-3">
                        <div className="w-[210px]">
                            <Label className="mb-1.5 block text-xs text-muted-foreground">缩放倍数</Label>
                            <div className="flex h-9 items-center gap-1.5 rounded-md border border-rose-400/30 bg-rose-500/10 px-3 text-xs font-semibold text-rose-200">
                                ×4
                                <span className="text-[10px] font-normal text-muted-foreground">扩散模型固定 4 倍</span>
                            </div>
                        </div>
                        <div className="w-[190px]">
                            <Label className="mb-1.5 block text-xs text-muted-foreground">分段长度（帧）</Label>
                            <Input
                                type="number" min={32} max={600} step={4}
                                value={p.flashvsrSegment}
                                onChange={(e) => setP({ flashvsrSegment: Math.max(32, Number(e.target.value) || 200) })}
                                className="h-9 bg-input/60 text-xs"
                                title="显存足够可加大以减少接缝；16GB 显存建议 200"
                            />
                        </div>
                        <div className="flex h-9 items-center rounded-md border border-border/60 bg-secondary/30 px-3 text-[11px] text-muted-foreground">
                            输出按 128 对齐中心裁切 · 首次运行需加载约 11 GB 权重
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
                            断点续跑 · BlockSwap + VAE tiling 按显存自动分档（≥8GB 可跑）
                        </div>
                    </div>
                )}

                <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/80">
                    {p.kind === 'libplacebo' && 'libplacebo 需要显式指定输出分辨率；Anime4K 系列着色器对动漫/动画内容效果最好，速度极快。'}
                    {p.kind === 'realesrgan' && 'realesr-animevideov3 支持 2/3/4×，适合动漫视频；realesrgan-plus / nomos8k / realwebphoto 仅 4×；realesr-generalv3 仅 4× 但可启用 WDN 降噪变体；nomos8k-compact 仅 2×。缩放选项已按模型实际权重锁定。'}
                    {p.kind === 'realcugan' && 'models-se 综合最佳（2× 时另有 1x/2x 精细降噪档）；models-pro 仅 2/3×；models-nose 仅 2× 且固定不降噪。降噪档位随 模型+倍率 联动。2K 以上输出显存占用较高。'}
                    {p.kind === 'rife' && '补帧不改变分辨率；场景切换阈值越低检测越敏感（20 表示 20% 差异即判定切换），避免转场处产生伪影。可与 HDR 同用。'}
                    {p.kind === 'span' && 'SPAN 仅支持 2× / 4×，模型体积最小、速度最快，画质略逊于 Real-CUGAN，适合大批量快速处理。'}
                    {p.kind === 'realbasicvsr' && 'RealBasicVSR（Apache-2.0）通过双向循环传播 + SPyNet 光流对齐消除帧间闪烁，是实拍/长视频的时序一致性标杆；速度约为 Real-ESRGAN 的 1/3，画质与稳定性显著更好。由独立 PyTorch 后端执行，仅编码器与 CRF 可调。'}
                    {p.kind === 'flashvsr' && 'FlashVSR（阿里开源）基于 Wan2.1 扩散先验，对重度压缩、噪点、低码率源的修复能力目前最强；速度较慢（约 0.6 fps 级），适合短而精的救片场景。分段越长接缝越少但显存占用越高；16 GB 显存建议保持 200。'}
                    {p.kind === 'seedvr2' && 'SeedVR2-3B（字节跳动开源，Apache-2.0）单步扩散视频超分，时序一致性与细节再生均为当前开源天花板；分辨率不敏感，默认把短边放大 4 倍（可指定目标短边）。速度约 0.4 fps 级，但支持断点续跑可分多次完成；FP8 权重 3.4 GB，显存策略按显卡自动分档。'}
                </p>
            </div>
        </SectionCard>
    );
}
