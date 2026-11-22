#requires -Version 7.0
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$Version,
    [switch]$All,
    [string]$InstallRoot = "$env:LOCALAPPDATA\Programs\OEP",
    [string]$DataRoot = $(if ($env:OEP_DATA_DIR) { $env:OEP_DATA_DIR } else { "$env:LOCALAPPDATA\OEP" }),
    [switch]$RemoveData,
    [string]$ConfirmRemoveData
)
. "$PSScriptRoot/OEP-Maintenance.ps1"
$mutex = $null
try {
    $mutex = Lock-OEP
    $InstallRoot = Root-OEP $InstallRoot
    $DataRoot = Root-OEP $DataRoot
    Guard-OEP $InstallRoot
    Guard-OEP $DataRoot
    Separate-OEP $InstallRoot $DataRoot
    $script:failureLogRoot = $InstallRoot
    if ($RemoveData -and $ConfirmRemoveData -cne 'DELETE OEP DATA') {
        Fail-OEP '刪除資料需要 -ConfirmRemoveData "DELETE OEP DATA"。'
    }
    if ($Version -and $All) { Fail-OEP '請選擇單一版本或全部版本。' }
    Stopped-OEP $InstallRoot
    $pointer = Root-OEP (Join-Path $InstallRoot 'current.json')
    $current = if ([IO.File]::Exists($pointer)) { (Read-OEP $pointer).version }
    if ($current) { [void](Version-OEP $current) }
    if (!$Version) { $Version = $current }
    if ($Version) { [void](Version-OEP $Version) }
    $targets = @()
    if ($All -and [IO.Directory]::Exists($InstallRoot)) {
        $targets = @(Get-ChildItem -LiteralPath $InstallRoot -Directory -Force |
            Where-Object Name -Match '^\d+\.\d+\.\d+$' | ForEach-Object FullName)
    } elseif ($Version) { $targets = @(Join-Path $InstallRoot $Version) }
    foreach ($path in $targets) {
        [void](Root-OEP $path)
        if ([IO.Directory]::Exists($path)) {
            [void]@(Tree-OEP $path)
            $manifest = Join-Path $path 'config/release.manifest.json'
            if (![IO.File]::Exists($manifest)) { Fail-OEP '目錄缺少 OEP 發行清單。' $manifest }
        }
    }
    if ($RemoveData -and [IO.Directory]::Exists($DataRoot)) { [void]@(Tree-OEP $DataRoot) }
    if (!$PSCmdlet.ShouldProcess('OEP', '解除安裝')) { return }
    if (($All -or ($Version -and $Version -eq $current)) -and [IO.File]::Exists($pointer)) {
        foreach ($link in Links-OEP) {
            Check-OEP '移除 OEP 捷徑失敗。' 'OEP.lnk'
            [IO.File]::Delete((Root-OEP $link))
        }
        if ($env:OEP_MAINTENANCE_TEST -ne '1') {
            $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
            foreach ($name in @("OEP-Logon-$sid", "OEP-Backup-$sid")) {
                if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
                    Unregister-ScheduledTask -TaskName $name -Confirm:$false
                }
            }
        }
        Check-OEP '移除目前版本指標失敗。' $pointer
        [IO.File]::Delete($pointer)
    }
    foreach ($path in $targets) {
        if ([IO.Directory]::Exists($path)) {
            Check-OEP '移除發行版本目錄失敗。' $path
            [IO.Directory]::Delete($path, $true)
        }
    }
    if ([IO.Directory]::Exists($DataRoot)) {
        if ($RemoveData) {
            Check-OEP '移除資料目錄失敗。' $DataRoot
            [IO.Directory]::Delete($DataRoot, $true)
        }
        else { Log-OEP $DataRoot 'UNINSTALL OK' }
    }
    if ($RemoveData) { Write-Output 'OEP 解除安裝完成，資料已移除。' }
    else { Write-Output 'OEP 解除安裝完成，資料已保留。' }
} catch {
    Report-OEPFailure '解除安裝失敗'
    exit 1
} finally {
    Unlock-OEP $mutex
}
