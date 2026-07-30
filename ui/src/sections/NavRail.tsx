import { LayoutList, PlusCircle } from 'lucide-react';
import type { ViewName } from '@/App';
import { cn } from '@/lib/utils';

interface Props {
    view: ViewName;
    onNavigate: (v: ViewName) => void;
    activeCount: number; // running + pending
}

const NAV_ITEMS: { key: ViewName; label: string; icon: typeof LayoutList }[] = [
    { key: 'queue', label: '队列', icon: LayoutList },
    { key: 'new-job', label: '新建', icon: PlusCircle },
];

export default function NavRail({ view, onNavigate, activeCount }: Props) {
    return (
        <nav className="flex w-[68px] shrink-0 flex-col items-center gap-1.5 border-r border-border/70 bg-card/30 py-3">
            {NAV_ITEMS.map((item) => {
                const active = view === item.key;
                return (
                    <button
                        key={item.key}
                        onClick={() => onNavigate(item.key)}
                        className={cn(
                            'relative flex w-[52px] flex-col items-center gap-1 rounded-xl py-2.5 transition-all duration-150',
                            active
                                ? 'bg-cyan-500/15 text-cyan-300 shadow-[inset_0_0_0_1px_hsl(187_92%_55%/0.25)]'
                                : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
                        )}
                    >
                        <item.icon className="h-[18px] w-[18px]" />
                        <span className="text-[10px] font-medium">{item.label}</span>
                        {item.key === 'queue' && activeCount > 0 && (
                            <span className="absolute right-1 top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-cyan-500 px-1 text-[8.5px] font-bold text-slate-950">
                                {activeCount}
                            </span>
                        )}
                    </button>
                );
            })}
        </nav>
    );
}
