#requires -Version 7.0
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$Source,
    [string]$InstallRoot = "$env:LOCALAPPDATA\Programs\OEP",
    [string]$DataRoot = $(if ($env:OEP_DATA_DIR) { $env:OEP_DATA_DIR } else { "$env:LOCALAPPDATA\OEP" }),
    [switch]$AllowSameVersion
)
. "$PSScriptRoot/OEP-Maintenance.ps1"
. "$PSScriptRoot/OEP-Snapshot.ps1"
. "$PSScriptRoot/OEP-Upgrade.ps1"

$mutex = $null
$marker = $null
$scratch = $null
$stage = $null
$repairReady = $null
$recover = $false
try {
    $mutex = Lock-OEP
    $InstallRoot = Root-OEP $InstallRoot
    $DataRoot = Root-OEP $DataRoot
    Guard-OEP $InstallRoot
    Guard-OEP $DataRoot
    Separate-OEP $InstallRoot $DataRoot
    $journalPath = Root-OEP (Join-Path $InstallRoot 'upgrade.journal.json')
    $journal = Read-UpgradeJournal $journalPath $DataRoot
    if ($journal.state -in @('prepared','restoring')) {
        if ($PSCmdlet.ShouldProcess($InstallRoot, '回退中斷的升級')) {
            $marker = Root-OEP (Join-Path $InstallRoot 'upgrade.active')
            [IO.File]::WriteAllText($marker, '')
            Stopped-OEP $InstallRoot
            Restore-Upgrade $InstallRoot $DataRoot $journalPath $journal
        }
        return
    }
    if (![IO.Directory]::Exists($DataRoot)) { Fail-OEP '找不到 OEP 資料目錄。' }
    $sourcePath = Root-OEP $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Source)
    Separate-OEP $sourcePath $InstallRoot
    Separate-OEP $sourcePath $DataRoot
    if ([IO.File]::Exists($sourcePath) -and ![IO.File]::Exists((Root-OEP (Join-Path (Split-Path $sourcePath) 'SHA256SUMS')))) {
        Fail-OEP '升級 ZIP 旁缺少 SHA256SUMS。'
    }
    $scratch = Join-Path ([IO.Path]::GetTempPath()) ('OEP-release-' + [guid]::NewGuid())
    $release = Read-ReleaseOEP $sourcePath $scratch
    Check-Prerequisites $release
    $currentPath = Root-OEP (Join-Path $InstallRoot 'current.json')
    if (![IO.File]::Exists($currentPath)) { Fail-OEP '找不到已安裝的 OEP 版本。' }
    $current = Read-OEP $currentPath
    $version = Version-OEP $current.version
    if ($release.version -lt $version -or ($release.version -eq $version -and
        (!$AllowSameVersion -or $release.hash -cne $current.manifestSha256))) {
        Fail-OEP '升級需要較新版本。同版本修復須指定 -AllowSameVersion 且發行清單相同。'
    }
    $repair = $release.version -eq $version
    if (!$repair) { [void](Read-InstalledRelease $InstallRoot $current) }
    $target = Root-OEP (Join-Path $InstallRoot $release.manifest.version)
    $migration = 'scripts/windows/migrate-data.ts'
    if (![IO.File]::Exists((Entry-OEP $release.root $migration))) { Fail-OEP '新版缺少離線資料庫遷移程式。' }
    if (!$PSCmdlet.ShouldProcess($target, '備份、遷移與升級 OEP')) { return }
    $marker = Root-OEP (Join-Path $InstallRoot 'upgrade.active')
    [IO.File]::WriteAllText($marker, '')
    Stop-UpgradeLauncher $InstallRoot $current
    $backupRoot = Root-OEP (Join-Path $InstallRoot 'upgrade-backups')
    $id = [guid]::NewGuid().ToString('N')
    $stage = Root-OEP (Join-Path $InstallRoot ".install-$id")
    if ($repair) {
        $repairReady = Root-OEP (Join-Path $InstallRoot ".repair-ready-$id")
        Stage-ReleaseOEP $release $repairReady $stage
    }
    $backup = New-Backup $DataRoot $backupRoot $current.version
    $journal = @{
        format = 1; id = $id; state = 'prepared'; repair = $repair; previous = $current; dataRoot = $DataRoot
        backup = $backup; backupHash = Hash-OEP (Join-Path $backup 'backup.manifest.json')
        next = @{ version = $release.manifest.version; manifestSha256 = $release.hash; installedAt = [DateTime]::UtcNow.ToString('o') }
    }
    Write-OEP $journalPath $journal
    $recover = $true
    Interrupt-Upgrade 'backup'
    if ($repair) { Complete-Repair $InstallRoot $journal }
    else { Stage-ReleaseOEP $release $target $stage }
    $previousRepo = $env:OEP_REPO_ROOT
    try {
        $env:OEP_REPO_ROOT = $target
        $result = & (Node-OEP $target) --disable-warning=ExperimentalWarning (Entry-OEP $target $migration) $DataRoot 2>$null
        if ($LASTEXITCODE) { Fail-OEP '新版資料庫遷移失敗。' }
    } finally { $env:OEP_REPO_ROOT = $previousRepo }
    $journal.migration = $result | ConvertFrom-Json -AsHashtable
    Write-OEP $journalPath $journal
    Interrupt-Upgrade 'migration'
    [void](Read-RollbackBackup $journal)
    & (Node-OEP $target) --disable-warning=ExperimentalWarning "$PSScriptRoot/data-snapshot.mjs" reconcile-upgrade $DataRoot $backup 2>$null
    if ($LASTEXITCODE) { Fail-OEP '升級比對失敗。資料筆數、工作狀態或發布修訂內容有差異。' }
    Select-OEPVersion $InstallRoot $DataRoot $journal.next
    Log-OEP $InstallRoot 'UPGRADE OK'
    [IO.File]::Delete($marker)
    $journal.state = 'committed'
    Write-OEP $journalPath $journal
    Write-Output "已升級至 $($journal.next.version)。資料比對通過。紀錄：$journalPath"
} catch {
    [Console]::Error.WriteLine($script:failure)
    if ($recover) {
        [Console]::Error.WriteLine("升級未完成。升級紀錄：$journalPath")
        try { Restore-Upgrade $InstallRoot $DataRoot $journalPath $journal }
        catch { [Console]::Error.WriteLine("自動回退未完成。請重新執行回退。紀錄：$journalPath") }
    }
    exit 1
} finally {
    if (!$recover -and $repairReady -and [IO.Directory]::Exists($repairReady)) { [IO.Directory]::Delete($repairReady, $true) }
    foreach ($temp in @($scratch, $stage)) {
        if ($temp -and [IO.Directory]::Exists($temp)) { [IO.Directory]::Delete($temp, $true) }
    }
    if ($marker) { [IO.File]::Delete($marker) }
    Unlock-OEP $mutex
}
