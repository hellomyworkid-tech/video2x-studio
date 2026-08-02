import { Crown, Gauge, Gem, ImagePlus, Layers, Scaling, Sparkles, Timer } from 'lucide-react';
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
    { kind: 'lanczos', name: 'Lanczos', tagline: '纯重采样 · 零伪影 · 高码率清晰源的稳妥之选', icon: Scaling, accent: 'from-slate-400/20 to-slate-500/5' },
    { kind: 'libplacebo', name: 'libplacebo', tagline: 'Anime4K 着色器 · 动漫实时超分', icon: Sparkles, accent: 'from-cyan-500/20 to-cyan-500/5' },
    { kind: 'span', name: 'SPAN', tagline: '实拍首选 · 保真度最高 · 速度快', icon: Gauge, accent: 'from-emerald-500/20 to-emerald-500/5' },
    { kind: 'realesrgan', name: 'Real-ESRGAN', tagline: '通用修复 · 适合低码率/退化源', icon: ImagePlus, accent: 'from-violet-500/20 to-violet-500/5' },
    { kind: 'realcugan', name: 'Real-CUGAN', tagline: '动漫超分王者 · 结构保持最佳', icon: Layers, accent: 'from-fuchsia-500/20 to-fuchsia-500/5' },
    { kind: 'rife', name: 'RIFE 补帧', tagline: '帧率倍增 · 运动更丝滑', icon: Timer, accent: 'from-amber-500/20 to-amber-500/5' },
    { kind: 'realbasicvsr', name: 'RealBasicVSR', tagline: '重建档 · 时域稳定无闪烁 · 仅适合退化源', icon: Crown, accent: 'from-amber-400/20 to-orange-500/5', engine: 'pytorch' },
    { kind: 'seedvr2', name: 'SeedVR2', tagline: '重建档 · 退化源画质天花板 · 极慢', icon: Gem, accent: 'from-indigo-500/20 to-indigo-500/5', engine: 'pytorch' },
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
                            onClick={() => setP(
                                // 初次切到 lanczos 默认走倍率模式（比预设的横屏分辨率更通用）
                                proc.kind === 'lanczos' && p.kind !== 'lanczos'
                                    ? { kind: proc.kind, sizeMode: 'scale' }
                                    : { kind: proc.kind }
                            )}
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
                                    {/* SeedVR2 是目标分辨率模式，不是固定 ×4 */}
                                    {proc.kind === 'seedvr2' ? 'PyTorch 目标分辨率' : 'PyTorch ×4'}
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
                            断点续跑 · BlockSwap + VAE tiling 按显存自动分档（≥8GB 可跑）
                        </div>
                    </div>
                )}

                <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/80">
                    {p.kind === 'lanczos' && '纯 Lanczos 重采样，不含任何神经网络：不占显存、绝不产生伪影或"塑料感"。对高码率清晰源（如 8 Mbps 以上的现代 H.264/HEVC），实测重建保真度反而高于全部 Real-ESRGAN 模型——源没有丢失细节时，AI 的"脑补"只会偏离原貌。想要更锐一点可改用 SPAN。'}
                    {p.kind === 'lanczos' && ' 缩放本身的耗时可忽略（1383 帧加不加 Lanczos 都是 2 秒），因此无需 GPU 加速——实测走 CUDA 硬解+scale_cuda 的全 GPU 链路反而更慢。真正的瓶颈是编码器，占总耗时约 90%：换成 hevc_nvenc 可直接快一倍（详见「编码器」标签页）。'}
                    {p.kind === 'libplacebo' && 'libplacebo 需要显式指定输出分辨率；Anime4K 系列着色器对动漫/动画内容效果最好，速度极快。'}
                    {p.kind === 'realesrgan' && 'realesr-animevideov3 支持 2/3/4×，为动漫视频训练；realesrgan-plus / nomos8k / realwebphoto 仅 4×；realesr-generalv3 仅 4× 但可启用 WDN 降噪变体；nomos8k-compact 仅 2×。缩放选项已按模型实际权重锁定。注意：这些模型均为 GAN 训练，会"再生"细节——源越糊收益越大，对已经清晰的高码率源反而可能不如 Lanczos / SPAN 忠实；真人素材请勿使用 animevideov3（会明显塑料化）。'}
                    {p.kind === 'realcugan' && 'models-se 综合最佳（2× 时另有 1x/2x 精细降噪档）；models-pro 仅 2/3×；models-nose 仅 2× 且固定不降噪。降噪档位随 模型+倍率 联动。为动漫内容设计，真人素材建议改用 SPAN。2K 以上输出显存占用较高。'}
                    {p.kind === 'rife' && '补帧不改变分辨率；场景切换阈值越低检测越敏感（20 表示 20% 差异即判定切换），避免转场处产生伪影。可与 HDR 同用。'}
                    {p.kind === 'span' && 'SPAN 仅支持 2× / 4×，模型体积最小、速度快（720p 输入实测约 12 fps）。偏保真而非"再生"细节，实测在真人实拍素材上重建保真度为全部可选模型最高、且是唯一优于纯 Lanczos 缩放的模型——人脸/浅景深/硬字幕场景不易产生塑料感与振铃，是实拍内容的首选。'}
                    {p.kind === 'realbasicvsr' && 'RealBasicVSR（Apache-2.0）通过双向循环传播 + SPyNet 光流对齐消除帧间闪烁，时序一致性好。但代价很高：720×1280 输入端到端实测约 1.4 fps，约为 Real-ESRGAN 4× 的 1/6、SPAN 2× 的 1/8。显存够时走整帧推理（画质最佳）；输入过大放不下会自动退化为空间分块，实测画质再降约 1.6 dB。仅在源确有明显退化（低码率、噪点、糊）时才值得；清晰源上收益很小。由独立 PyTorch 后端执行，仅编码器与 CRF 可调。'}
                    {p.kind === 'seedvr2' && 'SeedVR2-3B（字节跳动开源，Apache-2.0）单步扩散视频超分，在退化源上的细节再生是当前开源天花板；分辨率不敏感，默认把短边放大 4 倍（可指定目标短边）。速度 0.4 fps 量级（最慢档），支持断点续跑可分多次完成；FP8 权重 3.4 GB，显存策略按显卡自动分档。同样只建议用于确有退化的素材。'}
                </p>
                {(p.kind === 'realbasicvsr' || p.kind === 'seedvr2') && (
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
