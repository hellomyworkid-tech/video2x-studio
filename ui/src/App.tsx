import { useEffect, useMemo, useState } from 'react';
import type { AssetsState, GpuDevice, InstallStatus, Job, PythonEngineStatus } from '@/types';
import { api, subscribeAssets, subscribeJobs } from '@/lib/api';
import TitleBar from '@/sections/TitleBar';
import NavRail from '@/sections/NavRail';
import StatusBar from '@/sections/StatusBar';
import QueueView from '@/sections/QueueView';
import NewJobView from '@/sections/NewJobView';

export type ViewName = 'queue' | 'new-job';

export default function App() {
    const [view, setView] = useState<ViewName>('queue');
    const [jobs, setJobs] = useState<Job[]>([]);
    const [devices, setDevices] = useState<GpuDevice[]>([]);
    const [cudaDevices, setCudaDevices] = useState<GpuDevice[]>([]);
    const [cliReady, setCliReady] = useState<boolean | null>(null);
    const [pyEngine, setPyEngine] = useState<PythonEngineStatus | null>(null);
    const [install, setInstall] = useState<InstallStatus | null>(null);
    const [assetState, setAssetState] = useState<AssetsState | null>(null);
    // 每次进入新建视图都重置表单
    const [newJobKey, setNewJobKey] = useState(0);

    useEffect(() => {
        const unsub = subscribeJobs(setJobs);
        const unsubAssets = subscribeAssets(setAssetState);
        api.health()
            .then((h) => {
                setCliReady(h.cliExists);
                setPyEngine(h.pythonEngine ?? null);
                setInstall(h.install ?? null);
            })
            .catch(() => setCliReady(false));
        api.devices().then((d) => setDevices(d.devices)).catch(() => {});
        // CUDA 枚举首次约 10s（torch import），后台异步填充，不阻塞界面
        api.cudaDevices().then((d) => setCudaDevices(d.devices)).catch(() => {});
        api.assets().then(setAssetState).catch(() => {});
        // 全局拖放防护：拖到非投放区时阻止窗口直接打开文件
        const prevent = (e: DragEvent) => e.preventDefault();
        window.addEventListener('dragover', prevent);
        window.addEventListener('drop', prevent);
        return () => {
            unsub();
            unsubAssets();
            window.removeEventListener('dragover', prevent);
            window.removeEventListener('drop', prevent);
        };
    }, []);

    const activeCount = useMemo(
        () => jobs.filter((j) => j.status === 'running' || j.status === 'pending').length,
        [jobs]
    );

    const pyReady = !!(pyEngine && pyEngine.exeExists && (pyEngine.realbasicvsrWeights || pyEngine.seedvr2Weights));

    return (
        <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
            <TitleBar devices={devices} cliReady={cliReady} pyEngine={pyEngine} />
            <div className="flex min-h-0 flex-1">
                <NavRail view={view} onNavigate={setView} activeCount={activeCount} />
                <main className="min-w-0 flex-1 overflow-hidden">
                    {view === 'queue' ? (
                        <QueueView
                            jobs={jobs}
                            assetState={assetState}
                            install={install}
                            onNewJob={() => {
                                setNewJobKey((k) => k + 1);
                                setView('new-job');
                            }}
                            onAbort={(id) => api.abortJob(id)}
                        />
                    ) : (
                        <NewJobView
                            key={newJobKey}
                            devices={devices}
                            cudaDevices={cudaDevices}
                            cliReady={cliReady === true}
                            pyReady={pyReady}
                            install={install}
                            onSubmitted={() => setView('queue')}
                            onCancel={() => setView('queue')}
                        />
                    )}
                </main>
            </div>
            <StatusBar jobs={jobs} />
        </div>
    );
}
