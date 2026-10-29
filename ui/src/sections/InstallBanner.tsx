import { XCircle } from 'lucide-react';
import { isMac } from '@/lib/platform';
import type { InstallStatus } from '@/types';

/**
 * 程序本体不完整（拷贝/打包缺文件）时的红色错误条。
 * 这类文件随便携包分发、不提供下载，所以此时不展示"立即下载"——那只会把权重下到
 * 错误目录，且解决不了引擎缺失。
 */
export default function InstallBanner({ install }: { install: InstallStatus }) {
    return (
        <div className="mx-auto mt-3 max-w-5xl">
            <div className="rounded-xl border border-red-400/40 bg-red-500/[0.08] px-4 py-3 animate-fade-slide-in">
                <div className="flex items-start gap-2.5">
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
                    <div className="min-w-0 flex-1 text-xs leading-relaxed">
                        <div className="font-semibold text-red-200">程序文件不完整，处理功能不可用</div>
                        <div className="mt-1 text-muted-foreground">
                            缺少以下文件（相对于 <span className="font-mono text-foreground/80">{install.root}</span>）：
                        </div>
                        <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-red-200/90">
                            {install.missing.map((m) => <li key={m}>· {m}</li>)}
                        </ul>
                        {isMac() ? (
                            <div className="mt-1.5 text-muted-foreground">
                                这些是程序本体文件，无法在线下载。开发环境下请按 docs/macos/03-setup.md 编译 C++ 核心
                                （scripts/macos/build-core.sh）并安装依赖（scripts/macos/bootstrap.sh）；
                                FFmpeg 缺失时运行 scripts/macos/build-ffmpeg.sh（Homebrew 的 ffmpeg@7 也能用，但没有 Anime4K 与 HDR）。
                            </div>
                        ) : (
                            <div className="mt-1.5 text-muted-foreground">
                                这些是程序本体文件，无法在线下载。请把完整的程序文件夹（约 9 GB，含
                                build-desktop、engine-python、models、third_party）重新整体复制过来；
                                若只有个别 .exe 缺失，请检查杀毒软件的隔离区。
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
