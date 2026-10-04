import { Clapperboard, Cpu, Zap, Flame } from 'lucide-react';
import type { GpuDevice, PythonEngineStatus } from '@/types';
import { cn } from '@/lib/utils';

interface Props {
    devices: GpuDevice[];
    cliReady: boolean | null;
    pyEngine: PythonEngineStatus | null;
}

function EngineBadge({ ok, label, icon: Icon }: { ok: boolean | null; label: string; icon: typeof Zap }) {
    return (
        <span
            className={cn(
                'flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10.5px] font-medium',
                ok === true && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
                ok === false && 'border-red-500/30 bg-red-500/10 text-red-300',
                ok === null && 'border-border bg-secondary/50 text-muted-foreground'
            )}
            title={ok === false ? `${label}不可用` : `${label}就绪`}
        >
            <Icon className="h-3 w-3" />
            {label}
            <span className={cn('h-1.5 w-1.5 rounded-full',
                ok === true && 'bg-emerald-400',
                ok === false && 'bg-red-400',
                ok === null && 'bg-amber-400 pulse-dot')} />
        </span>
    );
}

export default function TitleBar({ devices, cliReady, pyEngine }: Props) {
    const gpu = devices.length > 0 ? devices[0].name : null;
    const pyOk = pyEngine === null ? null
        : pyEngine.exeExists && (pyEngine.realbasicvsrWeights || pyEngine.seedvr2Weights || !!pyEngine.swiftvrWeights);
    return (
        <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border/70 bg-card/40 px-4 backdrop-blur">
            <div className="flex h-6.5 w-6.5 h-[26px] w-[26px] items-center justify-center rounded-md bg-gradient-to-br from-cyan-400 to-violet-500 shadow shadow-cyan-500/25">
                <Clapperboard className="h-3.5 w-3.5 text-slate-950" strokeWidth={2.4} />
            </div>
            <div className="text-[13px] font-bold tracking-tight">
                Video2X <span className="text-gradient">Studio</span>
            </div>
            <span className="hidden text-[10px] text-muted-foreground/70 sm:block">超分 · 补帧 · 防抖 · 降噪 · HDR</span>

            <div className="ml-auto flex items-center gap-2">
                {gpu && (
                    <span className="hidden items-center gap-1.5 rounded-md border border-border/70 bg-secondary/40 px-2 py-1 text-[10.5px] text-muted-foreground md:flex" title={gpu}>
                        <Cpu className="h-3 w-3 text-cyan-400/80" />
                        <span className="max-w-52 truncate">{gpu}</span>
                    </span>
                )}
                <EngineBadge ok={cliReady} label="ncnn 引擎" icon={Zap} />
                <EngineBadge ok={pyOk} label="PyTorch 重建档" icon={Flame} />
            </div>
        </header>
    );
}
