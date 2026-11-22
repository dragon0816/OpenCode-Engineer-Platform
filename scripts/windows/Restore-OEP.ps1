#requires -Version 7.0
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$Backup,
    [string]$DataRoot = $(if ($env:OEP_DATA_DIR) { $env:OEP_DATA_DIR } else { "$env:LOCALAPPDATA\OEP" }),
    [string]$InstallRoot = "$env:LOCALAPPDATA\Programs\OEP",
    [switch]$Force,
    [string]$ConfirmReplaceData
)
. "$PSScriptRoot/OEP-Maintenance.ps1"
. "$PSScriptRoot/OEP-Snapshot.ps1"
$mutex = $null
$stage = $null
$old = $null
try {
    $mutex = Lock-OEP
    $DataRoot = Root-OEP $DataRoot
    $Backup = Root-OEP $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Backup)
    Guard-OEP $DataRoot
    Separate-OEP $Backup $DataRoot
    $InstallRoot = Root-OEP $InstallRoot
    Guard-OEP $InstallRoot
    Separate-OEP $InstallRoot $DataRoot
    $script:failureLogRoot = if ([IO.Directory]::Exists($InstallRoot)) { $InstallRoot } else { $DataRoot }
    Stopped-OEP $InstallRoot
    $manifest = Read-Backup $Backup
    $nonempty = [IO.Directory]::Exists($DataRoot) -and @(Get-ChildItem -LiteralPath $DataRoot -Force).Count
    if ($nonempty -and (!$Force -or $ConfirmReplaceData -cne 'REPLACE OEP DATA')) {
        Fail-OEP '資料目錄已有檔案。請使用空目錄，或同時指定 -Force 和 -ConfirmReplaceData "REPLACE OEP DATA"。'
    }
    if (!$PSCmdlet.ShouldProcess($DataRoot, '回復 OEP 資料')) { return }
    $id = [guid]::NewGuid()
    $stage = "$DataRoot.oep-restore-staging-$id"
    Copy-RestoreStage $Backup $manifest $stage
    if ($env:OEP_MAINTENANCE_TEST -eq '1' -and $env:OEP_TEST_INTERRUPT_RESTORE -eq '1') {
        [Environment]::Exit(87)
    }
    if ($nonempty) {
        $safetyRoot = Root-OEP "$DataRoot.oep-safety-backups"
        Guard-OEP $safetyRoot
        [void](New-Backup $DataRoot $safetyRoot (Installed-Version $InstallRoot))
    }
    $original = "$DataRoot.oep-restore-original-$id"
    Move-RestoreStage $stage $DataRoot $original
    if ([IO.Directory]::Exists($original)) { $old = $original }
    Reconcile-Snapshot $DataRoot $Backup
    Log-OEP $DataRoot 'RESTORE OK'
    if ($old -and !$nonempty) {
        Check-OEP '移除原空白資料目錄失敗。' '.'
        [IO.Directory]::Delete($old)
    }
    Write-Output '回復比對通過。資料筆數、SQLite 版本與發布修訂雜湊相符。'
    if ($nonempty) { Write-Output '原有資料已保留在旁邊的 oep-restore-original 目錄，另有 oep-safety-backups 備份。' }
    Write-Output '請依需要重新設定下列使用者環境變數，再執行 Check-OEP-Credentials.ps1。'
    CredentialStatus-OEP $manifest.credentials
} catch {
    Report-OEPFailure '回復失敗'
    exit 1
} finally {
    if (!$old) { Clear-OEPArtifact $stage -Directory }
    Unlock-OEP $mutex
    if ($script:cleanupFailed) { exit 1 }
}
