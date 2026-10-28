import { Droplets, Sun, Video } from 'lucide-react';
import { hostFeatures } from '@/lib/platform';
import type { JobRequest } from '@/types';
import { cn } from '@/lib/utils';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/sections/NewJobView';

interface Props {
    req: JobRequest;
    onChange: (p: Partial<JobRequest>) => void;
    bare?: boolean;
}

export default function EnhanceSection({ req, onChange, bare }: Props) {
    const e = req.enhance;
    const setE = (patch: Partial<typeof e>) => onChange({ enhance: { ...e, ...patch } });
    // SDR 转 HDR 依赖 FFmpeg 的 libplacebo 滤镜（Homebrew 的 ffmpeg@7 没有）
    const hdrAvailable = hostFeatures().libplacebo;

    return (
        <SectionCard step="03" title="画质增强" desc="可选增强级——防抖、降噪、SDR 转 HDR，按需叠加" bare={bare}>
            <div className="grid grid-cols-3 gap-3">
                {/* 防抖 */}
                <EnhCard
                    icon={<Video className="h-4.5 w-4.5 h-[18px] w-[18px]" />}
                    title="视频防抖"
                    desc="vidstab 两段式稳定"
                    enabled={e.stab}
                    onToggle={(v) => setE({ stab: v })}
                    activeAccent="border-cyan-400/50"
                >
                    <div>
                        <div className="mb-1 flex justify-between text-[11px]">
                            <span className="text-muted-foreground">抖动强度</span>
                            <span className="font-mono text-cyan-300">{e.stabShakiness}</span>
                        </div>
                        <Slider value={[e.stabShakiness]} min={1} max={10} step={1} onValueChange={([v]) => setE({ stabShakiness: v })} disabled={!e.stab} />
                    </div>
                    <div className="mt-3">
                        <div className="mb-1 flex justify-between text-[11px]">
                            <span className="text-muted-foreground">平滑窗口</span>
                            <span className="font-mono text-cyan-300">{e.stabSmoothing} 帧</span>
                        </div>
                        <Slider value={[e.stabSmoothing]} min={1} max={30} step={1} onValueChange={([v]) => setE({ stabSmoothing: v })} disabled={!e.stab} />
                    </div>
                </EnhCard>

                {/* 降噪 */}
                <EnhCard
                    icon={<Droplets className="h-[18px] w-[18px]" />}
                    title="视频降噪"
                    desc="FFmpeg 滤镜级降噪"
                    enabled={e.denoise}
                    onToggle={(v) => setE({ denoise: v })}
                    activeAccent="border-violet-400/50"
                >
                    <div>
                        <Label className="mb-1.5 block text-[11px] text-muted-foreground">算法</Label>
                        <Select value={e.denoiseAlgo} onValueChange={(v) => setE({ denoiseAlgo: v })} disabled={!e.denoise}>
                            <SelectTrigger className="h-8 bg-input/60 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="hqdn3d" className="text-xs">hqdn3d · 快速时域</SelectItem>
                                <SelectItem value="nlmeans" className="text-xs">nlmeans · 高质量慢速</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="mt-3">
                        <div className="mb-1 flex justify-between text-[11px]">
                            <span className="text-muted-foreground">亮度空间强度</span>
                            <span className="font-mono text-violet-300">{e.denoiseLuma}</span>
                        </div>
                        <Slider value={[e.denoiseLuma]} min={1} max={12} step={0.5} onValueChange={([v]) => setE({ denoiseLuma: v })} disabled={!e.denoise} />
                    </div>
                </EnhCard>

                {/* HDR */}
                <EnhCard
                    icon={<Sun className="h-[18px] w-[18px]" />}
                    title="SDR 转 HDR"
                    desc={hdrAvailable ? '逆色调映射 · 10bit' : '当前 FFmpeg 不含 libplacebo，暂不可用'}
                    enabled={e.hdr}
                    onToggle={(v) => setE({ hdr: v })}
                    activeAccent="border-amber-400/50"
                    disabled={!hdrAvailable && !e.hdr}
                >
                    <div>
                        <Label className="mb-1.5 block text-[11px] text-muted-foreground">转换曲线</Label>
                        <Select value={e.hdrFormat} onValueChange={(v) => setE({ hdrFormat: v })} disabled={!e.hdr}>
                            <SelectTrigger className="h-8 bg-input/60 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="pq" className="text-xs">PQ (ST 2084) · HDR10</SelectItem>
                                <SelectItem value="hlg" className="text-xs">HLG · 广播兼容</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="mt-3">
                        <Label className="mb-1.5 block text-[11px] text-muted-foreground">目标峰值亮度（nits）</Label>
                        <Input type="number" min={100} max={10000} step={100} value={e.hdrPeak} onChange={(ev) => setE({ hdrPeak: Number(ev.target.value) })} disabled={!e.hdr} className="h-8 bg-input/60 text-xs" />
                    </div>
                    {e.hdr && (
                        <p className="mt-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-[10px] leading-snug text-amber-200/90">
                            将自动切换 libx265 编码并写入 BT.2020 + mastering display 元数据
                        </p>
                    )}
                </EnhCard>
            </div>
            {(e.stab || e.denoise || e.hdr) && (
                <p className="mt-3 text-[11px] text-muted-foreground/80">
                    处理链：{[e.stab && '防抖', e.denoise && '降噪', '主处理器', e.hdr && 'HDR'].filter(Boolean).join(' → ')}
                    {req.processor.kind === 'rife' && e.hdr && '（HDR 作用于补帧之后的所有帧）'}
                </p>
            )}
        </SectionCard>
    );
}

function EnhCard({
    icon, title, desc, enabled, onToggle, children, activeAccent, disabled,
}: {
    icon: React.ReactNode;
    title: string;
    desc: string;
    enabled: boolean;
    onToggle: (v: boolean) => void;
    children: React.ReactNode;
    activeAccent: string;
    /** 本机不支持：开关置灰（已开启的仍允许关掉） */
    disabled?: boolean;
}) {
    return (
        <div
            className={cn(
                'rounded-xl border p-4 transition-all duration-200',
                enabled ? cn('bg-secondary/30', activeAccent) : 'border-border/70 bg-black/20 opacity-75'
            )}
        >
            <div className="mb-3 flex items-start justify-between">
                <div className="flex items-center gap-2.5">
                    <span className={cn('flex h-8 w-8 items-center justify-center rounded-lg', enabled ? 'bg-secondary text-foreground' : 'bg-secondary/60 text-muted-foreground')}>
                        {icon}
                    </span>
                    <div>
                        <div className="text-[13px] font-semibold">{title}</div>
                        <div className="text-[10px] text-muted-foreground">{desc}</div>
                    </div>
                </div>
                <Switch checked={enabled} onCheckedChange={onToggle} disabled={disabled} />
            </div>
            <div className={cn(!enabled && 'pointer-events-none saturate-50')}>{children}</div>
        </div>
    );
}
