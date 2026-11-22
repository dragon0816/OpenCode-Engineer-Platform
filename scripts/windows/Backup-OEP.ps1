#requires -Version 7.0
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$DataRoot = $(if ($env:OEP_DATA_DIR) { $env:OEP_DATA_DIR } else { "$env:LOCALAPPDATA\OEP" }),
    [string]$InstallRoot = "$env:LOCALAPPDATA\Programs\OEP",
    [string]$Destination = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'OEP-Backups'),
    [ValidateRange(0, 10000)][int]$KeepLast = 0
)
. "$PSScriptRoot/OEP-Maintenance.ps1"
. "$PSScriptRoot/OEP-Snapshot.ps1"
$mutex = $null
try {
    $mutex = Lock-OEP
    $DataRoot = Root-OEP $DataRoot
    $Destination = Root-OEP $Destination
    Guard-OEP $DataRoot
    Guard-OEP $Destination
    Separate-OEP $DataRoot $Destination
    $InstallRoot = Root-OEP $InstallRoot
    Guard-OEP $InstallRoot
    Separate-OEP $InstallRoot $Destination
    $script:failureLogRoot = if ([IO.Directory]::Exists($InstallRoot)) { $InstallRoot } else { $DataRoot }
    Stopped-OEP $InstallRoot
    if (![IO.Directory]::Exists($DataRoot)) { Fail-OEP '找不到 OEP 資料目錄。' }
    if (!$PSCmdlet.ShouldProcess($Destination, '建立 OEP 備份')) { return }
    $target = New-Backup $DataRoot $Destination (Installed-Version $InstallRoot)
    if ($KeepLast) {
        $verified = foreach ($folder in Get-ChildItem -LiteralPath $Destination -Directory -Force) {
            if ($folder.Name -notmatch '^OEP-backup-\d{8}T\d{13}Z-[a-f0-9]{32}$') { continue }
            try {
                $previous = Read-Backup (Root-OEP $folder.FullName)
                if ($previous.backupId -ceq $folder.Name) { $folder }
            } catch { continue }
        }
        foreach ($old in @($verified | Sort-Object Name -Descending | Select-Object -Skip $KeepLast)) {
            if ($PSCmdlet.ShouldProcess($old.FullName, '移除較舊的 OEP 備份')) {
                Check-OEP '移除較舊的備份目錄失敗。' $old.FullName $Destination
                [IO.Directory]::Delete($old.FullName, $true)
            }
        }
    }
    Log-OEP $DataRoot 'BACKUP OK'
    Write-Output ('備份完成。備份資料夾為 ' + [IO.Path]::GetFileName($target))
} catch {
    Report-OEPFailure '備份失敗'
    exit 1
} finally {
    Unlock-OEP $mutex
    if ($script:cleanupFailed) { exit 1 }
}
