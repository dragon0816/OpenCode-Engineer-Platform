$ErrorActionPreference = 'Stop'
$job = $null
$owner = $null
$name = $null
$profileCreated = $false
$verifiedStop = $false
try {
    if ($env:OEP_PLUGIN_INSTANCE -cnotmatch '^[a-f0-9]{32}$') { throw 'Invalid plugin worker instance' }
    $name = 'OEP.Plugin.' + $env:OEP_PLUGIN_INSTANCE
    Add-Type -Path (Join-Path $PSScriptRoot '../phase0/windows-job.cs')
    if ($env:OEP_PLUGIN_RECOVER -eq '1') {
        $result = [PhaseZeroJob]::DeleteAppContainerProfile($name)
        if ($result -ne 0 -and $result -ne -2147024894 -and $result -ne -2147023728) { exit 2 }
        exit 0
    }
    $owner = Get-Process -Id ([int]$env:OEP_PLUGIN_OWNER)
    $null = $owner.Handle
    if (@(Get-Service BFE, MpsSvc | Where-Object Status -ne Running).Count) { throw 'Network isolation unavailable' }
    $profile = ''
    $identity = [PhaseZeroJob]::CreatePluginProfile($name, [ref]$profile)
    $profileCreated = $true
    $sid = [Security.Principal.SecurityIdentifier]::new($identity)
    $profileDirectory = [IO.DirectoryInfo]::new($profile).Parent
    if ($profileDirectory.Name -ine $name -or $profileDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Unexpected plugin profile location'
    }
    $deny = [Security.AccessControl.FileSystemAccessRule]::new(
        $sid, 'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership',
        'ContainerInherit,ObjectInherit', 'None', 'Deny')
    foreach ($folder in @($profileDirectory) + @($profileDirectory.GetDirectories('*', 'AllDirectories'))) {
        if ($folder.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe plugin profile' }
        $permissions = $folder.GetAccessControl()
        $permissions.AddAccessRule($deny)
        $folder.SetAccessControl($permissions)
    }
    & (Join-Path $env:SystemRoot 'System32/icacls.exe') $profileDirectory.FullName /setintegritylevel '(OI)(CI)M' /T | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not raise plugin profile integrity level' }
    $stage = $env:OEP_PLUGIN_STAGE
    $directory = [IO.DirectoryInfo]::new($stage)
    $acl = $directory.GetAccessControl()
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        $sid, 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    $directory.SetAccessControl($acl)
    if ($owner.HasExited -or [IO.File]::Exists($env:OEP_PLUGIN_STOP)) { exit 2 }
    $job = [PhaseZeroJob]::new($true)
    $null = $job.StartPlugin((Join-Path $stage 'python.exe'), (Join-Path $stage 'bootstrap.py'), $stage, $name)
    $elapsed = [Diagnostics.Stopwatch]::StartNew()
    while (!$job.PluginExited(100)) {
        if ($owner.HasExited -or [IO.File]::Exists($env:OEP_PLUGIN_STOP) -or
            $elapsed.ElapsedMilliseconds -ge [int]$env:OEP_PLUGIN_TIMEOUT) { exit 2 }
    }
    $code = $job.PluginExitCode()
    $receipt = $job.TerminateAndWait(3000)
    if ($receipt.Item1 -ne 1 -or $receipt.Item2 -ne 0) { exit 2 }
    $verifiedStop = $true
    if ($code -ne 0) { exit 3 }
} catch {
    [Console]::Error.WriteLine('Plugin worker isolation failed')
    exit 2
} finally {
    if ($job) {
        try {
            if (!$verifiedStop) {
                $receipt = $job.TerminateAndWait(3000)
                if ($receipt.Item2 -ne 0) { throw 'Plugin Job did not empty' }
            }
        } finally { $job.Dispose() }
    }
    if ($owner) { $owner.Dispose() }
    if ($profileCreated) {
        $deleted = [PhaseZeroJob]::DeleteAppContainerProfile($name)
        if ($deleted -ne 0) { exit 2 }
    }
    if ($env:OEP_PLUGIN_CLEAN) { [IO.File]::WriteAllText($env:OEP_PLUGIN_CLEAN, '') }
}
