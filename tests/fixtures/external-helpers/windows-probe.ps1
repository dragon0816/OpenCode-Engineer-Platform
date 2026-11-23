param([string]$Canary)
$ErrorActionPreference = 'Stop'
Add-Type -Path @((Join-Path $PSScriptRoot '../../../scripts/phase0/windows-job.cs'), (Join-Path $PSScriptRoot 'windows-probe.cs'))
if ($Canary) {
    [HelperJobProbe]::ProtectCanary($Canary)
    exit
}
$request = [Console]::ReadLine() | ConvertFrom-Json
$envBlock = ($request.environment.PSObject.Properties | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join "`0"
try {
    $result = [HelperJobProbe]::Run($request.file, [string[]]$request.arguments, $request.cwd,
        $envBlock + "`0`0", [Convert]::FromBase64String($request.input), $request.owner)
    [Console]::WriteLine((@{
        exit = $result.exit
        stdout = [Convert]::ToBase64String($result.stdout)
        members = $result.members
        orphans = $result.orphans
        observed = @($result.observed)
        diagnosis = $result.diagnosis
        reason = $result.reason
    } | ConvertTo-Json -Compress))
} catch {
    # Only in this synthetic fixture. Include native error codes without paths or raw output.
    $cause = $_.Exception.GetBaseException()
    [Console]::Error.WriteLine("Synthetic Job failure: $($cause.GetType().Name) $($cause.NativeErrorCode) $($cause.TargetSite.Name)")
    exit 1
}
