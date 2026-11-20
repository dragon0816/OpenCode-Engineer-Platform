$ErrorActionPreference = 'Stop'
$control = $env:OEP_P0_CONTROL
$directory = $env:OEP_P0_WORKSPACE
$node = $env:OEP_P0_NODE
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$mutex = [Threading.Mutex]::new($false, "Global\OEP.P0.$sid")
if (!$mutex.WaitOne(0)) { $mutex.Dispose(); exit 23 }
$job = $null
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-job.cs')
    $job = [PhaseZeroJob]::new()
    $worker = $job.Start($node, (Join-Path $PSScriptRoot 'windows-opencode-worker.mjs'), $directory, $true)
    $process = Get-Process -Id $worker
    $null = $process.Handle
    $childRecord = Join-Path $control 'child.json'
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    while (!(Test-Path -LiteralPath $childRecord) -and !$process.HasExited -and $deadline.ElapsedMilliseconds -lt 15000) { Start-Sleep -Milliseconds 50 }
    if (!(Test-Path -LiteralPath $childRecord)) { throw 'Native child milestone missing.' }
    $childId = (Get-Content -Raw -LiteralPath $childRecord | ConvertFrom-Json).pid
    $members = @($job.Members())
    if ($childId -notin $members -or $worker -notin $members) { throw 'Native child is outside the Job.' }
    $handles = @($members | ForEach-Object { Get-Process -Id $_ })
    foreach ($member in $handles) { $null = $member.Handle }
    @{ pid=$childId; members=$members.Count } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $control 'job.tmp')
    Move-Item -LiteralPath (Join-Path $control 'job.tmp') -Destination (Join-Path $control 'job.json')

    if (!$process.WaitForExit(45000) -or $process.ExitCode -ne 0) { throw 'Native worker did not stop cleanly.' }
    $job.Dispose()
    $job = $null
    $orphan = @($handles | Where-Object { !$_.WaitForExit(2500) }).Count
    if ($orphan) { throw 'Native Job member still running.' }
    @{ orphan=$orphan; members=$members.Count } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $control 'stopped.json')
} finally {
    if ($job) { $job.Dispose() }
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
