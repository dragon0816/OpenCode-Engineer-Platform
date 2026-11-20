param([string] $WorkerRoot, [switch] $HoldSuspended)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$shell = (Get-Process -Id $PID).Path

function Wait-Record([string] $Path, [Diagnostics.Process] $Process) {
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    while (!(Test-Path -LiteralPath $Path) -and !$Process.HasExited -and $deadline.ElapsedMilliseconds -lt 10000) {
        Start-Sleep -Milliseconds 50
    }
    if (!(Test-Path -LiteralPath $Path)) { throw 'Worker milestone missing.' }
    Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
}

function Publish-Record([string] $Directory, [string] $Name, $Record) {
    $pending = Join-Path $Directory "$Name.tmp"
    $Record | ConvertTo-Json -Compress | Set-Content -LiteralPath $pending
    Move-Item -LiteralPath $pending -Destination (Join-Path $Directory "$Name.json")
}

if ($WorkerRoot) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $mutex = [Threading.Mutex]::new($false, "Global\OEP.P0.$sid")
    if (!$mutex.WaitOne(0)) { $mutex.Dispose(); exit 23 }
    $job = $null
    try {
        Add-Type -Path (Join-Path $PSScriptRoot 'windows-job.cs')
        $job = [PhaseZeroJob]::new()
        $node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
        $worker = $job.Start($node, (Join-Path $PSScriptRoot 'windows-worker.mjs'), $WorkerRoot, !$HoldSuspended)
        $process = Get-Process -Id $worker
        if (!$HoldSuspended) { $null = Wait-Record (Join-Path $WorkerRoot 'ready.json') $process }
        $membership = @($job.Members())
        $processes = @(Get-Process -Id $membership | ForEach-Object { @{ id=$_.Id; name=$_.ProcessName } })
        Publish-Record $WorkerRoot 'job' @{ worker=$worker; members=$processes }
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
    $otherRoot = Join-Path $repo ".phase0/windows/競爭 空間 $id"
    New-Item -ItemType Directory -Force -Path $root, $otherRoot | Out-Null
    $modeArgs = if ($Mode -eq 'before-ready') { '-HoldSuspended' } else { '' }
    $arguments = "-NoProfile -File `"$PSCommandPath`" -WorkerRoot `"$root`" $modeArgs"
    $supervisor = Start-Process -FilePath $shell -ArgumentList $arguments -WindowStyle Hidden -PassThru
    $copy = $null
    try {
        $job = Wait-Record (Join-Path $root 'job.json') $supervisor
        $readyPath = Join-Path $root 'ready.json'
        $ready = Test-Path -LiteralPath $readyPath
        $expected = @($job.worker)
        $record = $null
        if ($Mode -eq 'before-ready') {
            if ($ready) { throw 'Early-abort worker became ready.' }
        } else {
            $record = Wait-Record $readyPath $supervisor
            if ($record.worker -ne $job.worker -or $record.conflict -ne 'EADDRINUSE') { throw 'Worker identity or conflict mismatch.' }
            $expected += $record.grandchild
        }
        $jobIds = @($job.members | ForEach-Object id)
        $helpers = @($job.members | Where-Object id -notin $expected)
        if (@($expected | Where-Object { $_ -notin $jobIds }).Count -or @($helpers | Where-Object name -ne 'conhost').Count) {
            throw 'Unexpected Job membership.'
        }
        $members = @($jobIds | ForEach-Object { Get-Process -Id $_ })
        foreach ($member in $members) { $null = $member.Handle }
        $arguments = "-NoProfile -File `"$PSCommandPath`" -WorkerRoot `"$otherRoot`""
        $copy = Start-Process -FilePath $shell -ArgumentList $arguments -WindowStyle Hidden -PassThru
        if (!$copy.WaitForExit(3000) -or $copy.ExitCode -ne 23 -or (Test-Path -LiteralPath (Join-Path $otherRoot 'job.json'))) { throw 'Per-user single-instance check failed.' }
        $listeners = @(Get-NetTCPConnection -State Listen | Where-Object OwningProcess -in $jobIds)
        if ($Mode -eq 'before-ready') {
            if ($listeners.Count) { throw 'Suspended worker unexpectedly listening.' }
        } elseif ($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne '127.0.0.1' -or $listeners[0].OwningProcess -ne $job.worker) {
            throw 'Unexpected Job listeners.'
        }
        $stop = [Diagnostics.Stopwatch]::StartNew()
        if ($Mode -eq 'normal') { New-Item -ItemType File -Path (Join-Path $root 'stop') | Out-Null }
        else { $supervisor.Kill() }
        while (@($members | Where-Object { !$_.HasExited }).Count -and $stop.ElapsedMilliseconds -lt 10000) { Start-Sleep -Milliseconds 50 }
        $remaining = @($members | Where-Object { !$_.HasExited }).Count
        $elapsed = $stop.ElapsedMilliseconds
        if ($remaining -or $elapsed -gt 10000 -or !$supervisor.WaitForExit(1500) -or (($Mode -eq 'normal') -ne ($supervisor.ExitCode -eq 0))) {
            throw 'Lifecycle check failed.'
        }
        if ($Mode -eq 'before-ready' -and (Test-Path -LiteralPath $readyPath)) { throw 'Worker published readiness after early abort.' }
        [pscustomobject]@{ mode=$Mode; managed=$members.Count; consoleHelpers=$helpers.Count; orphan=$remaining; elapsedMs=$elapsed; mutex=$copy.ExitCode; conflict=$record.conflict; listeners=$listeners.Count; readiness=$ready; supervisorExit=$supervisor.ExitCode; unicodeAndSpace=$true } | ConvertTo-Json -Compress
    } finally {
        if ($copy -and !$copy.HasExited) { $copy.Kill(); $copy.WaitForExit() }
        if (!$supervisor.HasExited) { $supervisor.Kill(); $supervisor.WaitForExit() }
    }
}

Test-Worker 'normal'
Test-Worker 'forced'
Test-Worker 'before-ready'
