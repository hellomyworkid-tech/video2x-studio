import { Plus, X } from 'lucide-react';
import { CODECS, PIX_FMTS } from '@/lib/args';
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
                            {CODECS.map((c) => <SelectItem key={c.value} value={c.value} className="text-xs">{c.label}</SelectItem>)}
                        </SelectContent>
                    </Select>
                </div>
                <div>
                    <Label className="mb-1.5 block text-xs text-muted-foreground">CRF（-1 默认）</Label>
                    <Input type="number" min={-1} max={51} value={enc.crf} onChange={(e) => setEnc({ crf: Number(e.target.value) })} className="h-9 bg-input/60 text-xs" title="x264/x265 质量因子，越低越清晰，常用 15-23" />
                </div>
                <div>
                    <Label className="mb-1.5 block text-xs text-muted-foreground">码率 bps（0 自动）</Label>
                    <Input type="number" min={0} value={enc.bitRate} onChange={(e) => setEnc({ bitRate: Number(e.target.value) })} className="h-9 bg-input/60 text-xs" />
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

            {enc.codec === 'custom' && (
                <div className="mt-3">
                    <Label className="mb-1.5 block text-xs text-muted-foreground">自定义编码器名（FFmpeg encoder）</Label>
                    <Input value={enc.customCodec} onChange={(e) => setEnc({ customCodec: e.target.value })} placeholder="如 h264_qsv / libsvtav1" className="h-9 bg-input/60 font-mono text-xs" />
                </div>
            )}

            <div className="mt-4 grid grid-cols-3 gap-3">
                <ToggleRow label="复制音频流" desc="保留原视频音轨" checked={enc.copyAudio} onChange={(v) => setEnc({ copyAudio: v })} />
                <ToggleRow label="复制字幕流" desc="保留原视频字幕" checked={enc.copySubs} onChange={(v) => setEnc({ copySubs: v })} />
                <ToggleRow label="重算时间戳" desc="修正输出 PTS（建议开）" checked={enc.recalculatePts} onChange={(v) => setEnc({ recalculatePts: v })} />
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
            </div>
        </SectionCard>
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
