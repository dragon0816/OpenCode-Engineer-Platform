$ErrorActionPreference = 'Stop'
$control = $env:OEP_JOB_CONTROL
$node = $env:OEP_JOB_NODE
$owner = Get-Process -Id ([int]$env:OEP_JOB_OWNER)
$null = $owner.Handle
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$scope = $env:OEP_JOB_TEST_SCOPE
if ($scope -and $scope -cnotmatch '^[a-f0-9]{32}$') { throw 'Invalid test job scope' }
$mutexName = if ($scope) { "Global\OEP.Runtime.Test.$sid.$scope" } else { "Global\OEP.Runtime.$sid" }
$mutex = [Threading.Mutex]::new($false, $mutexName)
$job = $null
$locked = $false
$worker = $null

function Write-Record($Name, $Values) {
    $temporary = Join-Path $control "$Name.tmp"
    $Values | ConvertTo-Json -Compress | Set-Content -LiteralPath $temporary
    Move-Item -LiteralPath $temporary -Destination (Join-Path $control "$Name.json")
}

try {
    try { $locked = $mutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $locked = $true }
    if (!$locked) { exit 23 }
    Add-Type -Path (Join-Path $PSScriptRoot '../phase0/windows-job.cs')
    $job = [PhaseZeroJob]::new()
    $workerId = $job.Start($node, (Join-Path $PSScriptRoot 'runtime-worker.mjs'), $PWD.Path, $true)
    $worker = Get-Process -Id $workerId
    $null = $worker.Handle
    $childRecord = Join-Path $control 'child.json'
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while (!(Test-Path -LiteralPath $childRecord)) {
        if ($owner.HasExited -or $worker.WaitForExit(50) -or $watch.ElapsedMilliseconds -ge 12000) {
            throw 'OpenCode process did not start.'
        }
    }
    $childId = (Get-Content -Raw -LiteralPath $childRecord | ConvertFrom-Json).pid
    $members = @($job.Members())
    if ($childId -notin $members -or $workerId -notin $members) { throw 'OpenCode Job membership failed.' }
    Write-Record 'job' @{ pid=$childId; members=$members.Count; memberPIDs=$members; supervisorPID=$PID }
    while (!$worker.WaitForExit(100)) {
        if ($owner.HasExited) { throw 'OEP launcher exited.' }
    }
    $code = $worker.ExitCode
    $stopped = $job.TerminateAndWait(3000)
    $job.Dispose()
    $job = $null
    Write-Record 'stopped' @{ members=$stopped.Item1; orphans=$stopped.Item2 }
    if ($null -eq $code -or $code -ne 0 -or $stopped.Item2) { exit 1 }
} finally {
    if ($job) { $job.Dispose() }
    if ($worker) { $worker.Dispose() }
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
    $owner.Dispose()
}
