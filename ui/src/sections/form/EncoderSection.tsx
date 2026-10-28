import { Plus, X } from 'lucide-react';
import { codecOptions, PIX_FMTS, vtQuality } from '@/lib/args';
import { isMac } from '@/lib/platform';
import { cn } from '@/lib/utils';
import type { JobRequest } from '@/types';
import { Button } from '@/components/ui/button';
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

export default function EncoderSection({ req, onChange, bare }: Props) {
    const enc = req.encoder;
    const setEnc = (patch: Partial<typeof enc>) => onChange({ encoder: { ...enc, ...patch } });
    // 码率内部一律以 bps 存储（与 CLI --bit-rate 及已持久化的配置一致），仅界面按 Mbps 显示/输入
    const bitRateMode = enc.bitRate > 0;
    const bitRateMbps = enc.bitRate > 0 ? Math.round(enc.bitRate / 1e4) / 100 : 0;
    const setBitRateMbps = (v: string) => {
        const n = Number(v);
        setEnc({ bitRate: Number.isFinite(n) && n > 0 ? Math.round(n * 1e6) : 0 });
    };

    const addOpt = () => setEnc({ extraOpts: [...enc.extraOpts, { key: '', value: '' }] });
    const setOpt = (i: number, patch: Partial<{ key: string; value: string }>) => {
        const next = [...enc.extraOpts];
        next[i] = { ...next[i], ...patch };
        setEnc({ extraOpts: next });
    };
    const removeOpt = (i: number) => setEnc({ extraOpts: enc.extraOpts.filter((_, idx) => idx !== i) });

    return (
        <SectionCard step="04" title="编码器" desc="输出编码参数——码率控制与封装行为" bare={bare}>
            <div className="grid grid-cols-[1fr_130px_130px_110px] gap-3">
                <div>
                    <Label className="mb-1.5 block text-xs text-muted-foreground">编码器</Label>
                    <Select value={enc.codec} onValueChange={(v) => setEnc({ codec: v })}>
                        <SelectTrigger className="h-9 bg-input/60 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                            {codecOptions().map((c) => <SelectItem key={c.value} value={c.value} className="text-xs">{c.label}</SelectItem>)}
                        </SelectContent>
                    </Select>
                </div>
                <div>
                    <Label className={cn('mb-1.5 block text-xs', bitRateMode ? 'text-muted-foreground/50 line-through' : 'text-muted-foreground')}>质量 CRF（-1 默认）</Label>
                    <Input type="number" min={-1} max={51} value={enc.crf} disabled={bitRateMode}
                        onChange={(e) => setEnc({ crf: Number(e.target.value) })}
                        className={cn('h-9 bg-input/60 text-xs', bitRateMode && 'opacity-40')}
                        title={bitRateMode
                            ? '已设码率：编码器进入码率控制模式，质量档不生效（两者互斥）。码率清零即恢复'
                            : /_videotoolbox$/.test(enc.codec)
                                ? `恒定质量因子（x264 刻度），越低越清晰，常用 15-23。苹果硬编按实测换算为同画质的质量值：当前 CRF ${enc.crf} → q ${vtQuality(enc.crf)}（0–100）`
                                : '恒定质量因子，越低越清晰，常用 15-23。会按所选编码器自动映射为 crf / cq / qvbr_quality_level'} />
                </div>
                <div>
                    <Label className="mb-1.5 block text-xs text-muted-foreground">码率 Mbps（0 = 按质量）</Label>
                    <Input type="number" min={0} step={0.1} value={bitRateMbps} onChange={(e) => setBitRateMbps(e.target.value)} className="h-9 bg-input/60 text-xs"
                        title="平均码率（ABR）。设为 0 时按左侧质量档编码；设了码率后质量档失效。参考：720p 短剧源约 2~8 Mbps，2K 输出 8~16 Mbps" />
                </div>
                <div>
                    <Label className="mb-1.5 block text-xs text-muted-foreground">像素格式</Label>
                    <Select value={enc.pixFmt || 'auto'} onValueChange={(v) => setEnc({ pixFmt: v === 'auto' ? '' : v })}>
                        <SelectTrigger className="h-9 bg-input/60 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                            {PIX_FMTS.map((f) => <SelectItem key={f || 'auto'} value={f || 'auto'} className="text-xs">{f || '自动'}</SelectItem>)}
                        </SelectContent>
                    </Select>
                </div>
            </div>

            {bitRateMode && (
                <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-amber-200/90">
                    <strong>码率控制模式</strong>：编码器按平均 {bitRateMbps} Mbps 输出（ABR），质量 CRF 已停用——两者互斥，
                    同时给编码器只会按 CRF 编码并静默丢弃码率。码率改回 0 即恢复按质量档编码。
                    注意 ABR 是"平均"码率：静态画面段会低于目标、复杂段会高于目标，整体均值贴近设定值。
                </div>
            )}

            {enc.codec === 'custom' && (
                <div className="mt-3">
                    <Label className="mb-1.5 block text-xs text-muted-foreground">自定义编码器名（FFmpeg encoder）</Label>
                    <Input value={enc.customCodec} onChange={(e) => setEnc({ customCodec: e.target.value })} placeholder="如 h264_qsv / libsvtav1" className="h-9 bg-input/60 font-mono text-xs" />
                </div>
            )}

            <div className="mt-4 grid grid-cols-3 gap-3">
                <ToggleRow label="复制音频流" desc="保留原视频音轨" checked={enc.copyAudio} onChange={(v) => setEnc({ copyAudio: v })} />
                <ToggleRow label="复制字幕流" desc="保留原视频字幕" checked={enc.copySubs} onChange={(v) => setEnc({ copySubs: v })} />
                <ToggleRow label="强制恒定帧率" desc="按帧序号重排时间戳（默认关；手机/录屏等可变帧率素材开启会音画不同步）" checked={!!enc.forceCfr} onChange={(v) => setEnc({ forceCfr: v })} />
            </div>

            {/* extra AVOptions */}
            <div className="mt-4">
                <div className="mb-1.5 flex items-center justify-between">
                    <Label className="text-xs text-muted-foreground">高级编码参数（AVOption，-e key=value）</Label>
                    <Button variant="ghost" size="sm" className="h-6 text-[11px] text-cyan-300 hover:bg-cyan-500/10" onClick={addOpt}>
                        <Plus className="mr-1 h-3 w-3" /> 添加
                    </Button>
                </div>
                {enc.extraOpts.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border/70 px-3 py-2.5 text-[11px] text-muted-foreground/70">
                        常用示例：preset=slow、tune=film、profile=high10、rc-lookahead=40
                    </div>
                ) : (
                    <div className="space-y-1.5">
                        {enc.extraOpts.map((opt, i) => (
                            <div key={i} className="flex items-center gap-2">
                                <Input value={opt.key} onChange={(e) => setOpt(i, { key: e.target.value })} placeholder="preset" className="h-8 flex-1 bg-input/60 font-mono text-xs" />
                                <span className="text-muted-foreground">=</span>
                                <Input value={opt.value} onChange={(e) => setOpt(i, { value: e.target.value })} placeholder="slow" className="h-8 flex-1 bg-input/60 font-mono text-xs" />
                                <button onClick={() => removeOpt(i)} className="rounded-md p-1 text-muted-foreground hover:bg-red-500/15 hover:text-red-300">
                                    <X className="h-3.5 w-3.5" />
                                </button>
                            </div>
                        ))}
                    </div>
                )}

                {isMac() ? <MacEncoderGuide /> : (
                <div className="mt-3 rounded-lg border border-border/60 bg-black/20 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground/85">
                    <div className="mb-1 font-medium text-foreground/80">编码器怎么选</div>
                    在相同画质下，各编码器的差别<strong>不在"看起来怎样"，而在体积和速度</strong>。
                    下表为一组实测参考值（<strong>Lanczos ×2</strong>，1383 帧 720×1280→1440×2560，
                    RTX 5070 Ti，PSNR 对无损参考）：
                    <div className="mt-1.5 overflow-x-auto">
                        <table className="w-full text-[10.5px]">
                            <thead className="text-muted-foreground/70">
                                <tr><th className="pr-3 text-left font-normal">编码器</th><th className="pr-3 text-left font-normal">耗时</th><th className="pr-3 text-left font-normal">体积</th><th className="pr-3 text-left font-normal">PSNR</th><th className="text-left font-normal">适合</th></tr>
                            </thead>
                            <tbody className="text-muted-foreground/85">
                                <tr><td className="pr-3">av1_nvenc</td><td className="pr-3">5s</td><td className="pr-3">64MB</td><td className="pr-3">49.2</td><td>速度画质双优，需较新播放器</td></tr>
                                <tr><td className="pr-3">hevc_nvenc</td><td className="pr-3">5s</td><td className="pr-3">59MB</td><td className="pr-3">48.4</td><td>综合最均衡，推荐</td></tr>
                                <tr><td className="pr-3">libx265</td><td className="pr-3">32s</td><td className="pr-3">44MB</td><td className="pr-3">47.2</td><td>体积最小，但最慢</td></tr>
                                <tr><td className="pr-3">libx264</td><td className="pr-3">14s</td><td className="pr-3">64MB</td><td className="pr-3">47.1</td><td>兼容性最好，老设备首选</td></tr>
                                <tr><td className="pr-3">h264_nvenc</td><td className="pr-3">4s</td><td className="pr-3">48MB</td><td className="pr-3">46.3</td><td>最快但码率效率最差</td></tr>
                            </tbody>
                        </table>
                    </div>
                    <div className="mt-1.5">
                        这些 PSNR 都在 46 dB 以上（视觉无损区间），实测同一帧放大后<strong>肉眼无法区分</strong>。
                        所以除非要压到极小体积，按<strong>速度和兼容性</strong>选即可：N 卡优先 hevc_nvenc（快 3 倍且画质不输 x264）；
                        要发给老设备/老播放器就用 libx264。
                    </div>
                    <div className="mt-1.5 border-t border-border/50 pt-1.5">
                        <strong>换处理器后这些数字会变，但排序不变。</strong>
                        同条件换成 SPAN ×2（AI 超分的锐利内容更难压）实测排序完全一致，
                        但同设置下体积大 20~25%、PSNR 低约 1.7 dB；放大倍率翻倍则耗时约涨 3.5 倍
                        （4× 到 2880×5120 时 libx264 约 51s、hevc_nvenc 约 18s）。
                        所以上表适合用来<strong>选编码器</strong>，不适合当作绝对耗时/体积的预估。
                    </div>
                </div>
                )}
            </div>
        </SectionCard>
    );
}

/** Mac 版的编码器选择说明：M5 Max 实测（2026-10，A20 前 240 帧 Lanczos ×2 到 2560×1440，
 *  CRF 18 与等画质的苹果硬编 q 79，Y-PSNR 对无损参考；耗时含约 1.3 s 并行解码参考） */
function MacEncoderGuide() {
    return (
        <div className="mt-3 rounded-lg border border-border/60 bg-black/20 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground/85">
            <div className="mb-1 font-medium text-foreground/80">编码器怎么选（Mac）</div>
            在相同画质下，各编码器的差别<strong>不在"看起来怎样"，而在体积和速度</strong>。
            下表为 M5 Max 实测（<strong>Lanczos ×2</strong>，240 帧 1280×720→2560×1440，同等画质档，PSNR 对无损参考）：
            <div className="mt-1.5 overflow-x-auto">
                <table className="w-full text-[10.5px]">
                    <thead className="text-muted-foreground/70">
                        <tr><th className="pr-3 text-left font-normal">编码器</th><th className="pr-3 text-left font-normal">耗时</th><th className="pr-3 text-left font-normal">体积</th><th className="pr-3 text-left font-normal">PSNR</th><th className="text-left font-normal">适合</th></tr>
                    </thead>
                    <tbody className="text-muted-foreground/85">
                        <tr><td className="pr-3">libx265</td><td className="pr-3">4.7s</td><td className="pr-3">6.8MB</td><td className="pr-3">47.7</td><td>体积最小，速度可接受</td></tr>
                        <tr><td className="pr-3">libx264</td><td className="pr-3">2.4s</td><td className="pr-3">9.5MB</td><td className="pr-3">47.3</td><td>兼容性最好，默认推荐</td></tr>
                        <tr><td className="pr-3">hevc_videotoolbox</td><td className="pr-3">1.4s</td><td className="pr-3">12.3MB</td><td className="pr-3">47.6</td><td>最快，体积约为 x264 的 1.3 倍</td></tr>
                        <tr><td className="pr-3">h264_videotoolbox</td><td className="pr-3">1.4s</td><td className="pr-3">17.1MB</td><td className="pr-3">47.6</td><td>码率效率最差</td></tr>
                    </tbody>
                </table>
            </div>
            <div className="mt-1.5">
                M5 Max 上 x264 本身就很快，苹果硬编的速度优势远不如 Windows 上的 NVENC，体积反而更大。
                建议默认 libx264；要压体积用 libx265；只有编码成了瓶颈（如 Lanczos 大批量）时才选 hevc_videotoolbox。
                苹果硬编的质量档按 CRF 自动换算为同画质的质量值（CRF 18 ≈ q 79）；HEVC 输出自动标记 hvc1，可直接用 QuickTime 和访达预览播放。
            </div>
        </div>
    );
}

function ToggleRow({ label, desc, checked, onChange }: { label: string; desc: string; checked: boolean; onChange: (v: boolean) => void }) {
    return (
        <div className="flex items-center justify-between rounded-lg border border-border/60 bg-black/20 px-3 py-2.5">
            <div>
                <div className="text-xs font-medium">{label}</div>
                <div className="text-[10px] text-muted-foreground">{desc}</div>
            </div>
            <Switch checked={checked} onCheckedChange={onChange} />
        </div>
    );
}
