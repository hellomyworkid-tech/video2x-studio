import type { Job } from '@/types';

interface Props {
    jobs: Job[];
}

export default function StatusBar({ jobs }: Props) {
    const running = jobs.filter((j) => j.status === 'running');
    const pending = jobs.filter((j) => j.status === 'pending');
    const cur = running[0];

    return (
        <footer className="flex h-7 shrink-0 items-center justify-between border-t border-border/70 bg-card/40 px-4 text-[10.5px] text-muted-foreground backdrop-blur">
            <div className="flex items-center gap-3">
                <span className="flex items-center gap-1.5">
                    <span className={`h-1.5 w-1.5 rounded-full ${cur ? 'bg-cyan-400 pulse-dot' : 'bg-emerald-400'}`} />
                    {cur ? '处理中' : '空闲'}
                </span>
                {cur && (
                    <span className="max-w-72 truncate" title={cur.file}>
                        {cur.fileName} · {cur.progress.toFixed(1)}%
                        {cur.fps > 0 && ` · ${cur.fps.toFixed(1)} fps`}
                    </span>
                )}
            </div>
            <div className="flex items-center gap-3">
                {pending.length > 0 && <span>排队 {pending.length}</span>}
                <span>Video2X v6.4.0 · 本地引擎</span>
            </div>
        </footer>
    );
}
