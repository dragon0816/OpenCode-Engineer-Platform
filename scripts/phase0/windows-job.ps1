param([string] $WorkerRoot, [string] $Instance)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$shell = (Get-Process -Id $PID).Path

if ($WorkerRoot) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $mutex = [Threading.Mutex]::new($false, "Global\OEP.P0.$sid.$Instance")
    if (!$mutex.WaitOne(0)) { $mutex.Dispose(); exit 23 }
    $job = $null
    try {
        Add-Type -Path (Join-Path $PSScriptRoot 'windows-job.cs')
        $job = [PhaseZeroJob]::new()
        $node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
        $worker = $job.Start($node, (Join-Path $PSScriptRoot 'windows-worker.mjs'), $WorkerRoot)
        $process = Get-Process -Id $worker
        $process.WaitForExit()
        exit $process.ExitCode
    } finally {
        if ($job) { $job.Dispose() }
        $mutex.ReleaseMutex()
        $mutex.Dispose()
    }
}

function Test-Worker([string] $Mode) {
    $id = [guid]::NewGuid().ToString('N')
    $root = Join-Path $repo ".phase0/windows/中文 空間 $id"
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    $arguments = "-NoProfile -File `"$PSCommandPath`" -WorkerRoot `"$root`" -Instance $id"
    $supervisor = Start-Process -FilePath $shell -ArgumentList $arguments -WindowStyle Hidden -PassThru
    try {
        $ready = Join-Path $root 'ready.json'
        $deadline = [Diagnostics.Stopwatch]::StartNew()
        while (!(Test-Path -LiteralPath $ready) -and !$supervisor.HasExited -and $deadline.ElapsedMilliseconds -lt 10000) { Start-Sleep -Milliseconds 80 }
        if (!(Test-Path -LiteralPath $ready)) { throw 'Worker readiness failed.' }
        $record = Get-Content -Raw -LiteralPath $ready | ConvertFrom-Json
        $members = @((Get-Process -Id $record.worker), (Get-Process -Id $record.grandchild))
        foreach ($member in $members) { $null = $member.Handle }
        $copy = Start-Process -FilePath $shell -ArgumentList $arguments -WindowStyle Hidden -PassThru
        if (!$copy.WaitForExit(3000) -or $copy.ExitCode -ne 23) { throw 'Single-instance check failed.' }
        $listeners = @(Get-NetTCPConnection -State Listen -OwningProcess $record.worker -ErrorAction Stop)
        $stop = [Diagnostics.Stopwatch]::StartNew()
        if ($Mode -eq 'normal') { New-Item -ItemType File -Path (Join-Path $root 'stop') | Out-Null }
        else { $supervisor.Kill() }
        while (@($members | Where-Object { !$_.HasExited }).Count -and $stop.ElapsedMilliseconds -lt 10000) { Start-Sleep -Milliseconds 50 }
        $remaining = @($members | Where-Object { !$_.HasExited }).Count
        [pscustomobject]@{ mode=$Mode; managed=$members.Count; orphan=$remaining; elapsedMs=$stop.ElapsedMilliseconds; mutex=$copy.ExitCode; conflict=$record.conflict; loopbackOnly=(@($listeners | Where-Object LocalAddress -ne '127.0.0.1').Count -eq 0); unicodeAndSpace=$true } | ConvertTo-Json -Compress
        if ($remaining -or $record.conflict -ne 'EADDRINUSE' -or !$supervisor.WaitForExit(1500)) { throw 'Lifecycle check failed.' }
    } finally {
        if (!$supervisor.HasExited) { $supervisor.Kill(); $supervisor.WaitForExit() }
    }
}

Test-Worker 'normal'
Test-Worker 'forced'
