$c = Get-NetTCPConnection -LocalPort 7199 -State Listen -ErrorAction SilentlyContinue
if ($c) {
    $c | Select-Object OwningProcess -Unique | ForEach-Object {
        $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
        if ($p) { Write-Output ("PID=" + $p.Id + " " + $p.ProcessName + " " + $p.Path) }
    }
} else {
    Write-Output "FREE"
}
