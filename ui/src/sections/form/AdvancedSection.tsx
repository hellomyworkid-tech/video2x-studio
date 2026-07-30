import { Cpu } from 'lucide-react';
import { HWACCELS, LOG_LEVELS } from '@/lib/args';
import type { GpuDevice, JobRequest } from '@/types';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { SectionCard } from '@/sections/NewJobView';

interface Props {
    req: JobRequest;
    onChange: (p: Partial<JobRequest>) => void;
    devices: GpuDevice[];
    /** 旗舰引擎模式：devices 为 CUDA 枚举，仅暴露 CUDA 设备选择 */
    python?: boolean;
    bare?: boolean;
}

export default function AdvancedSection({ req, onChange, devices, python, bare }: Props) {
    const adv = req.advanced;
    const setAdv = (patch: Partial<typeof adv>) => onChange({ advanced: { ...adv, ...patch } });

    if (python) {
        // 旗舰引擎（PyTorch）：CUDA 与 Vulkan 是两套独立编号空间，
        // 这里的序号只发给 worker.py --device，与 ncnn 的 Vulkan 序号互不影响
        return (
            <SectionCard step="05" title="高级" desc="旗舰引擎硬件调度" bare={bare}>
                <div className="max-w-sm">
                    <Label className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Cpu className="h-3 w-3" /> CUDA 设备（GPU）
                    </Label>
                    <Select value={String(adv.cudaDeviceIndex ?? 0)} onValueChange={(v) => setAdv({ cudaDeviceIndex: Number(v) })}>
                        <SelectTrigger className="h-9 bg-input/60 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                            {devices.length === 0 && <SelectItem value="0" className="text-xs">cuda:0（默认）</SelectItem>}
                            {devices.map((d) => (
                                <SelectItem key={d.index} value={String(d.index)} className="text-xs">
                                    cuda:{d.index} · {d.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/80">
                    {devices.length > 1
                        ? `检测到 ${devices.length} 张 CUDA 显卡：旗舰引擎将完整在所选卡上推理。注意 CUDA 序号与 ncnn 的 Vulkan 序号是两套编号，各自独立选择。`
                        : 'CUDA 设备即旗舰引擎执行推理的显卡，单卡机器保持默认即可。首次枚举约需 10 秒（加载 PyTorch），若列表为空请稍后重开本页。'}
                </p>
            </SectionCard>
        );
    }

    return (
        <SectionCard step="05" title="高级" desc="硬件调度与调试选项" bare={bare}>
            <div className="grid grid-cols-[1fr_1fr_130px_130px] items-end gap-3">
                <div>
                    <Label className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Cpu className="h-3 w-3" /> Vulkan 设备（GPU）
                    </Label>
                    <Select value={String(adv.deviceIndex)} onValueChange={(v) => setAdv({ deviceIndex: Number(v) })}>
                        <SelectTrigger className="h-9 bg-input/60 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                            {devices.length === 0 && <SelectItem value="0" className="text-xs">设备 0（默认）</SelectItem>}
                            {devices.map((d) => (
                                <SelectItem key={d.index} value={String(d.index)} className="text-xs">
                                    {d.index} · {d.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <div>
                    <Label className="mb-1.5 block text-xs text-muted-foreground">解码硬件加速</Label>
                    <Select value={adv.hwaccel} onValueChange={(v) => setAdv({ hwaccel: v })}>
                        <SelectTrigger className="h-9 bg-input/60 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                            {HWACCELS.map((h) => <SelectItem key={h.value} value={h.value} className="text-xs">{h.label}</SelectItem>)}
                        </SelectContent>
                    </Select>
                </div>
                <div>
                    <Label className="mb-1.5 block text-xs text-muted-foreground">日志级别</Label>
                    <Select value={adv.logLevel} onValueChange={(v) => setAdv({ logLevel: v })}>
                        <SelectTrigger className="h-9 bg-input/60 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                            {LOG_LEVELS.map((l) => <SelectItem key={l} value={l} className="text-xs">{l}</SelectItem>)}
                        </SelectContent>
                    </Select>
                </div>
                <div className="flex h-9 items-center gap-2">
                    <Switch checked={adv.benchmark} onCheckedChange={(v) => setAdv({ benchmark: v })} id="benchmark" />
                    <Label htmlFor="benchmark" className="text-xs leading-tight">
                        基准模式
                        <span className="block text-[10px] text-muted-foreground">丢弃帧测速</span>
                    </Label>
                </div>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/80">
                {devices.length > 1
                    ? `检测到 ${devices.length} 张显卡：超分/补帧建议选性能最强的独显（如 RTX 系列），显存更大、算力更高；核显仅适合轻量任务。解码硬件加速与推理用卡无需一致。`
                    : 'Vulkan 设备即执行超分/补帧推理的显卡，单卡机器保持默认即可。基准模式只测速不输出视频，用于对比不同卡/参数的速度。'}
            </p>
        </SectionCard>
    );
}
