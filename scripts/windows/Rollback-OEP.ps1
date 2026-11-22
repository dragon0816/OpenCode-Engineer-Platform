#requires -Version 7.0
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$Backup,
    [string]$InstallRoot = "$env:LOCALAPPDATA\Programs\OEP",
    [string]$DataRoot = $(if ($env:OEP_DATA_DIR) { $env:OEP_DATA_DIR } else { "$env:LOCALAPPDATA\OEP" })
)
. "$PSScriptRoot/OEP-Maintenance.ps1"
. "$PSScriptRoot/OEP-Snapshot.ps1"
. "$PSScriptRoot/OEP-Upgrade.ps1"
$mutex = $null
$marker = $null
try {
    $mutex = Lock-OEP
    $InstallRoot = Root-OEP $InstallRoot
    $DataRoot = Root-OEP $DataRoot
    Guard-OEP $InstallRoot
    Guard-OEP $DataRoot
    Separate-OEP $InstallRoot $DataRoot
    $script:failureLogRoot = $InstallRoot
    $journalPath = Root-OEP (Join-Path $InstallRoot 'upgrade.journal.json')
    $journal = Read-UpgradeJournal $journalPath $DataRoot
    if ($journal.state -eq 'rolledBack' -and !$Backup) {
        $stale = Root-OEP (Join-Path $InstallRoot 'upgrade.active')
        if ([IO.File]::Exists($stale) -and $PSCmdlet.ShouldProcess($stale, '清除中斷的維護標記')) {
            [IO.File]::Delete($stale)
        }
        Write-Output '已完成回退，無需再回退。'
        return
    }
    if (!$journal -or ($journal.state -eq 'rolledBack' -and $Backup)) {
        if (!$Backup) { Fail-OEP '找不到升級紀錄。請以 -Backup 指定原備份的位置。' $journalPath }
        $Backup = Root-OEP $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Backup)
        Separate-OEP $Backup $DataRoot
        $manifest = Read-Backup $Backup
        $release = Read-InstalledRelease $InstallRoot @{ version = $manifest.oepVersion }
        $journal = @{
            format = 1; id = [guid]::NewGuid().ToString('N'); state = 'prepared'; dataRoot = $DataRoot
            backup = $Backup; backupHash = Hash-OEP (Join-Path $Backup 'backup.manifest.json')
            previous = @{ version = $manifest.oepVersion; manifestSha256 = $release.hash }
        }
    } elseif ($Backup) {
        $journal.backup = Root-OEP $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Backup)
    }
    [void](Read-RollbackBackup $journal)
    if ($PSCmdlet.ShouldProcess($DataRoot, '回退 OEP 程式和資料')) {
        $marker = Root-OEP (Join-Path $InstallRoot 'upgrade.active')
        Check-OEP '寫入升級執行標記失敗。' $marker
        [IO.File]::WriteAllText($marker, '')
        $currentPath = Root-OEP (Join-Path $InstallRoot 'current.json')
        if ([IO.File]::Exists($currentPath)) { Stop-UpgradeLauncher $InstallRoot (Read-OEP $currentPath) }
        else { Stopped-OEP $InstallRoot }
        Restore-Upgrade $InstallRoot $DataRoot $journalPath $journal
    }
} catch {
    Report-OEPFailure '回退失敗'
    if ($journal) { Record-UpgradeFailure $journalPath $DataRoot '回退失敗' }
    exit 1
} finally {
    if ($marker) { [IO.File]::Delete($marker) }
    Unlock-OEP $mutex
}
