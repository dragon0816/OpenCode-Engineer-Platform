#requires -Version 7.0
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$Source,
    [string]$InstallRoot = "$env:LOCALAPPDATA\Programs\OEP",
    [string]$DataRoot = $(if ($env:OEP_DATA_DIR) { $env:OEP_DATA_DIR } else { "$env:LOCALAPPDATA\OEP" }),
    [switch]$DesktopShortcut,
    [switch]$AutoStart,
    [switch]$AllowDowngrade
)
. "$PSScriptRoot/OEP-Maintenance.ps1"
$mutex = $null
$scratch = $null
$stage = $null
try {
    $mutex = Lock-OEP
    $InstallRoot = Root-OEP $InstallRoot
    $DataRoot = Root-OEP $DataRoot
    Guard-OEP $InstallRoot
    Guard-OEP $DataRoot
    Separate-OEP $InstallRoot $DataRoot
    $sourcePath = Root-OEP $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Source)
    Separate-OEP $sourcePath $InstallRoot
    Separate-OEP $sourcePath $DataRoot
    Check-Prerequisites
    Stopped-OEP $InstallRoot
    $scratch = Join-Path ([IO.Path]::GetTempPath()) ("OEP-release-" + [guid]::NewGuid())
    $release = Read-ReleaseOEP $sourcePath $scratch
    $manifest = $release.manifest
    $manifestHash = $release.hash
    $version = $release.version
    $currentPath = Root-OEP (Join-Path $InstallRoot 'current.json')
    if (Test-Path -LiteralPath $currentPath) {
        $current = Read-OEP $currentPath
        if ($version -lt (Version-OEP $current.version) -and !$AllowDowngrade) { Fail-OEP '已安裝較新版本。若確定要降版，請加上 -AllowDowngrade。' }
    }
    $target = Root-OEP (Join-Path $InstallRoot $manifest.version)
    if (!$PSCmdlet.ShouldProcess($target, '安裝 OEP')) { return }

    $stage = Join-Path $InstallRoot ('.install-' + [guid]::NewGuid())
    Stage-ReleaseOEP $release $target $stage
    [void][IO.Directory]::CreateDirectory($DataRoot)
    Publish-OEPShortcuts $target $DataRoot
    Write-OEP $currentPath @{
        version = $manifest.version
        installedAt = [DateTime]::UtcNow.ToString('o')
        manifestSha256 = $manifestHash
    }
    Write-Output 'OEP 安裝完成。請從開始功能表開啟 OEP。'
} catch {
    [Console]::Error.WriteLine($script:failure)
    exit 1
} finally {
    foreach ($temp in @($scratch, $stage)) {
        if ($temp -and [IO.Directory]::Exists($temp)) { [IO.Directory]::Delete($temp, $true) }
    }
    Unlock-OEP $mutex
}
