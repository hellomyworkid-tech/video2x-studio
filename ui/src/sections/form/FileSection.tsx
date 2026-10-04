import { useRef, useState } from 'react';
import { FilePlus2, FileVideo, FolderOpen, HardDriveDownload, Import, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { CONTAINERS } from '@/lib/args';
import type { JobRequest } from '@/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SectionCard, RemoveChip } from '@/sections/NewJobView';

interface Props {
    req: JobRequest;
    onChange: (p: Partial<JobRequest>) => void;
}

export default function FileSection({ req, onChange }: Props) {
    const [browsing, setBrowsing] = useState<'open' | 'dir' | null>(null);
    const [dragOver, setDragOver] = useState(false);
    const [expanding, setExpanding] = useState(false);
    const dragDepth = useRef(0);

    const addFiles = (files: string[]) => {
        const merged = [...req.files];
        let added = 0;
        for (const f of files) {
            if (!merged.includes(f)) {
                merged.push(f);
                added++;
            }
        }
        if (added === 0) {
            toast.info('拖拽的文件已全部在列表中');
            return;
        }
        const patch: Partial<JobRequest> = { files: merged };
        if (!req.outputDir) {
            const f0 = merged[0];
            patch.outputDir = f0.slice(0, Math.max(f0.lastIndexOf('\\'), f0.lastIndexOf('/')));
        }
        onChange(patch);
        toast.success(`已添加 ${added} 个视频`, { description: `共 ${merged.length} 个待处理` });
    };

    const browse = async (kind: 'open' | 'dir') => {
        setBrowsing(kind);
        try {
            const { files } = await api.browse(kind);
            if (files.length > 0) {
                if (kind === 'open') {
                    addFiles(files);
                } else {
                    onChange({ outputDir: files[0] });
                }
            }
        } catch (e) {
            toast.error('文件对话框调用失败：' + (e instanceof Error ? e.message : String(e)));
        } finally {
            setBrowsing(null);
        }
    };

    const onDrop = async (e: React.DragEvent) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragOver(false);
        const bridgeObj = window.v2xElectron;
        if (!bridgeObj) {
            toast.error('浏览器预览模式拿不到文件真实路径，请使用「添加视频」按钮');
            return;
        }
        const paths: string[] = [];
        for (const f of Array.from(e.dataTransfer.files)) {
            const p = bridgeObj.getPathForFile(f);
            if (p) paths.push(p);
        }
        if (paths.length === 0) {
            toast.error('无法读取拖拽内容的路径');
            return;
        }
        setExpanding(true);
        try {
            const { files, truncated } = await api.expand(paths);
            if (files.length === 0) {
                toast.info('拖拽内容中没有可识别的视频文件', {
                    description: '支持 mp4 / mkv / avi / mov / webm / ts / rmvb / wmv 等',
                });
                return;
            }
            addFiles(files);
            if (truncated) toast.warning('文件数量过多，仅导入前 1000 个');
        } catch (err) {
            toast.error('解析拖拽内容失败：' + (err instanceof Error ? err.message : String(err)));
        } finally {
            setExpanding(false);
        }
    };

    const removeFile = (f: string) => onChange({ files: req.files.filter((x) => x !== f) });

    return (
        <SectionCard step="01" title="输入与输出" desc="添加一个或多个视频，设置输出位置与命名规则">
            {/* file list + drop zone */}
            <div
                className={cn(
                    'relative mb-4 rounded-xl transition-colors',
                    dragOver && 'ring-2 ring-cyan-400/70 ring-offset-2 ring-offset-background'
                )}
                onDragEnter={(e) => {
                    e.preventDefault();
                    dragDepth.current++;
                    setDragOver(true);
                }}
                onDragOver={(e) => e.preventDefault()}
                onDragLeave={() => {
                    dragDepth.current--;
                    if (dragDepth.current <= 0) {
                        dragDepth.current = 0;
                        setDragOver(false);
                    }
                }}
                onDrop={onDrop}
            >
                {dragOver && (
                    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-cyan-400/80 bg-cyan-500/15 backdrop-blur-[2px]">
                        <div className="flex items-center gap-2 text-sm font-semibold text-cyan-200">
                            <Import className="h-4 w-4" />
                            松开以添加视频（支持文件与文件夹）
                        </div>
                    </div>
                )}
                <div className="mb-2 flex items-center justify-between">
                    <Label className="text-xs text-muted-foreground">视频文件（{req.files.length}）</Label>
                    <div className="flex gap-2">
                        {req.files.length > 0 && (
                            <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={() => onChange({ files: [] })}>
                                <Trash2 className="mr-1 h-3 w-3" /> 清空
                            </Button>
                        )}
                        <Button variant="outline" size="sm" className="h-7 border-cyan-500/40 text-xs text-cyan-300 hover:bg-cyan-500/10" onClick={() => browse('open')} disabled={browsing !== null}>
                            {browsing === 'open' ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <FilePlus2 className="mr-1 h-3 w-3" />}
                            添加视频（可多选）
                        </Button>
                    </div>
                </div>

                {req.files.length === 0 ? (
                    <button
                        onClick={() => browse('open')}
                        className="flex w-full items-center justify-center gap-2.5 rounded-lg border border-dashed border-border py-3 text-muted-foreground transition-colors hover:border-cyan-500/40 hover:bg-cyan-500/5 hover:text-cyan-300"
                    >
                        {expanding ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <FileVideo className="h-4 w-4" />
                        )}
                        <span className="text-xs">点击选择，或直接把视频 / 文件夹拖到这里</span>
                        <span className="text-[10px] opacity-60">mp4 / mkv / avi / mov / webm / ts / rmvb · 可多选批量</span>
                    </button>
                ) : (
                    <div className="max-h-[104px] space-y-1 overflow-y-auto rounded-xl border border-border/70 bg-black/20 p-1.5">
                        {req.files.map((f) => {
                            const name = f.split(/[\\/]/).pop();
                            return (
                                <div key={f} className="group flex items-center gap-2 rounded-lg px-2 py-1 text-xs hover:bg-secondary/60" title={f}>
                                    <FileVideo className="h-3.5 w-3.5 shrink-0 text-cyan-400/70" />
                                    <span className="flex-1 truncate font-medium">{name}</span>
                                    <span className="hidden max-w-[40%] truncate text-[10px] text-muted-foreground/60 group-hover:block">{f}</span>
                                    <RemoveChip onClick={() => removeFile(f)} />
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* output */}
            <div className="grid grid-cols-[1fr_130px_170px] gap-3">
                <div>
                    <Label className="mb-1.5 block text-xs text-muted-foreground">输出目录</Label>
                    <div className="flex gap-1.5">
                        <Input
                            value={req.outputDir}
                            onChange={(e) => onChange({ outputDir: e.target.value })}
                            placeholder="D:\Videos\enhanced"
                            className="h-9 bg-input/60 text-xs"
                        />
                        <Button variant="outline" size="sm" className="h-9 shrink-0 px-2.5" onClick={() => browse('dir')} disabled={browsing !== null}>
                            {browsing === 'dir' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}
                        </Button>
                    </div>
                </div>
                <div>
                    <Label className="mb-1.5 block text-xs text-muted-foreground">容器格式</Label>
                    <Select value={req.container} onValueChange={(v) => onChange({ container: v })}>
                        <SelectTrigger className="h-9 bg-input/60 text-xs">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {CONTAINERS.map((c) => (
                                <SelectItem key={c} value={c} className="text-xs">.{c}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <div>
                    <Label className="mb-1.5 block text-xs text-muted-foreground">命名模板</Label>
                    <Input
                        value={req.nameTemplate}
                        onChange={(e) => onChange({ nameTemplate: e.target.value })}
                        placeholder="{name}_{proc}.{ext}"
                        className="h-9 bg-input/60 font-mono text-xs"
                        title="{name}=原文件名 {proc}=处理器与模型（如 esrgan-nomos8k-compact） {ext}=容器扩展名"
                    />
                </div>
            </div>

            {/* 自动预处理开关：网络盘/高风险封装先落地本地 */}
            <div className="mt-3 flex items-center justify-between rounded-lg border border-border/60 bg-black/20 px-3 py-2">
                <div className="flex items-center gap-2">
                    <HardDriveDownload className="h-3.5 w-3.5 text-violet-300/80" />
                    <div className="text-[11px] leading-tight">
                        <span className="font-medium">自动本地暂存</span>
                        <span className="ml-1.5 text-muted-foreground">
                            网络盘 / RMVB·WMV·FLV 等源先无损落地到本地再处理，防挂死；输出仍写回你指定的目录
                        </span>
                    </div>
                </div>
                <Switch
                    checked={req.advanced.autoStage}
                    onCheckedChange={(v) => onChange({ advanced: { ...req.advanced, autoStage: v } })}
                />
            </div>
        </SectionCard>
    );
}
