# 挂起/恢复整个进程树（NtSuspendProcess / NtResumeProcess）
# 用法: powershell -ExecutionPolicy Bypass -File suspend_tree.ps1 -RootPid 1234 -Mode suspend|resume
param(
    [Parameter(Mandatory=$true)][int]$RootPid,
    [ValidateSet('suspend','resume')][string]$Mode = 'suspend'
)

$sig = @'
using System;
using System.Runtime.InteropServices;
public static class NtProc {
    [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h);
    [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(int access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
}
'@
Add-Type -TypeDefinition $sig -ErrorAction Stop

function Get-Tree([int]$root) {
    # 返回 [root] + 全部后代 pid（子先父后由调用方控制顺序）
    $result = New-Object System.Collections.Generic.List[int]
    $result.Add($root)
    # 记录每个 pid 的创建时间：父进程死亡后其 PID 可能被无关新进程复用，
    # 此时"ParentProcessId=cur"查到的其实是别人的孩子。子进程的创建时间必然
    # 不早于其父进程，据此过滤掉 PID 复用造成的假父子关系。
    $created = @{}
    $rp = Get-CimInstance Win32_Process -Filter "ProcessId=$root" -ErrorAction SilentlyContinue
    if ($rp) { $created[$root] = $rp.CreationDate }
    $queue = New-Object 'System.Collections.Generic.Queue[int]'
    $queue.Enqueue($root)
    while ($queue.Count -gt 0) {
        $cur = $queue.Dequeue()
        $kids = Get-CimInstance Win32_Process -Filter "ParentProcessId=$cur" -ErrorAction SilentlyContinue
        foreach ($k in $kids) {
            $kid = [int]$k.ProcessId
            if ($created.ContainsKey($cur) -and $k.CreationDate -and $k.CreationDate -lt $created[$cur]) { continue }
            if (-not $result.Contains($kid)) {
                $result.Add($kid)
                $created[$kid] = $k.CreationDate
                $queue.Enqueue($kid)
            }
        }
    }
    return $result
}

$tree = Get-Tree $RootPid
if ($Mode -eq 'suspend') { $order = $tree } else { $order = @(); for ($i=$tree.Count-1; $i -ge 0; $i--) { $order += $tree[$i] } }

$ok = 0
foreach ($p in $order) {
    $h = [NtProc]::OpenProcess(0x0800, $false, $p)   # PROCESS_SUSPEND_RESUME
    if ($h -eq [IntPtr]::Zero) { Write-Output "SKIP $p (open failed)"; continue }
    try {
        if ($Mode -eq 'suspend') { $r = [NtProc]::NtSuspendProcess($h) } else { $r = [NtProc]::NtResumeProcess($h) }
        if ($r -eq 0) { $ok++; Write-Output "OK $Mode $p" } else { Write-Output "FAIL $p status=$r" }
    } finally { [NtProc]::CloseHandle($h) | Out-Null }
}
Write-Output "DONE $Mode $ok/$($tree.Count)"
