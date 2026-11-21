function Read-InstalledRelease($InstallRoot, $Pointer) {
    [void](Version-OEP $Pointer.version)
    $target = Root-OEP (Join-Path $InstallRoot $Pointer.version)
    $release = Read-ReleaseOEP $target $null
    if ($release.manifest.version -cne $Pointer.version -or
        ($Pointer.manifestSha256 -and $release.hash -cne $Pointer.manifestSha256)) {
        Fail-OEP '已安裝版本與發行清單不符。'
    }
    $release
}

function Select-OEPVersion($InstallRoot, $DataRoot, $Pointer) {
    $DesktopShortcut = $false
    $AutoStart = $false
    if ($env:OEP_MAINTENANCE_TEST -ne '1') {
        $DesktopShortcut = [IO.File]::Exists((@(Links-OEP))[1])
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $AutoStart = $null -ne (Get-ScheduledTask -TaskName "OEP-Logon-$sid" -ErrorAction SilentlyContinue)
    }
    $target = Root-OEP (Join-Path $InstallRoot $Pointer.version)
    Publish-OEPShortcuts $target $DataRoot
    Write-OEP (Root-OEP (Join-Path $InstallRoot 'current.json')) $Pointer
}

function Read-UpgradeJournal($Path, $DataRoot) {
    if (![IO.File]::Exists($Path)) { return }
    $record = Read-OEP $Path
    if ($record.format -ne 1 -or $record.id -cnotmatch '^[a-f0-9]{32}$' -or
        $record.dataRoot -ne $DataRoot -or $record.state -cnotin @('prepared','committed','restoring','rolledBack')) {
        Fail-OEP '升級紀錄不符。請確認資料目錄及升級紀錄。'
    }
    $record
}

function Interrupt-Upgrade($Point) {
    if ($env:OEP_MAINTENANCE_TEST -eq '1' -and $env:OEP_TEST_INTERRUPT_UPGRADE -ceq $Point) {
        [Environment]::Exit(88)
    }
}

function Read-RollbackBackup($Journal) {
    $backup = Root-OEP $Journal.backup
    if (![IO.Directory]::Exists($backup)) { Fail-OEP '找不到升級備份。請指定原備份的新路徑 -Backup。' }
    $manifest = Read-Backup $backup
    if ((Hash-OEP (Join-Path $backup 'backup.manifest.json')) -cne $Journal.backupHash -or
        $manifest.oepVersion -cne $Journal.previous.version) { Fail-OEP '備份清單與升級紀錄不符。' }
    $manifest
}

function Complete-Repair($InstallRoot, $Journal) {
    if (!$Journal.repair) { return }
    [void](Version-OEP $Journal.previous.version)
    $target = Root-OEP (Join-Path $InstallRoot $Journal.previous.version)
    $ready = Root-OEP (Join-Path $InstallRoot ".repair-ready-$($Journal.id)")
    $original = Root-OEP (Join-Path $InstallRoot ".repair-original-$($Journal.id)")
    if ([IO.Directory]::Exists($ready)) {
        $replacement = Read-ReleaseOEP $ready $null
        if ($replacement.hash -cne $Journal.previous.manifestSha256) { Fail-OEP '同版本修復的發行清單不符。' }
        Move-RestoreStage $ready $target $original
    }
}

function Restore-Upgrade($InstallRoot, $DataRoot, $JournalPath, $Journal) {
    $backup = Root-OEP $Journal.backup
    Separate-OEP $backup $DataRoot
    $manifest = Read-RollbackBackup $Journal
    Complete-Repair $InstallRoot $Journal
    [void](Read-InstalledRelease $InstallRoot $Journal.previous)
    $stage = Root-OEP "$DataRoot.oep-restore-staging-$($Journal.id)"
    $original = Root-OEP "$DataRoot.oep-restore-original-$($Journal.id)"
    Guard-OEP $stage
    Guard-OEP $original

    $report = Root-OEP (Join-Path $InstallRoot "rollback-$($Journal.id).json")
    $Journal.state = 'restoring'
    Write-OEP $JournalPath $Journal
    if (![IO.Directory]::Exists($original) -or ![IO.Directory]::Exists($DataRoot)) {
        if ([IO.Directory]::Exists($stage)) {
            [void]@(Tree-OEP $stage)
            [IO.Directory]::Delete($stage, $true)
        }
        Copy-RestoreStage $backup $manifest $stage
        if ([IO.Directory]::Exists($DataRoot)) {
            & (Maintenance-Node) --disable-warning=ExperimentalWarning "$PSScriptRoot/data-snapshot.mjs" intent-diff $DataRoot $backup $report 2>$null
            if ($LASTEXITCODE) {
                Write-OEP $report @{ status = 'unavailable'; changes = @() }
                Write-Warning '無法比對原資料中的待處理工作。完整原資料仍會保留，供後續檢查。'
            }
        }
        if (![IO.File]::Exists($report)) { Write-OEP $report @{ changes = @() } }
        Move-RestoreStage $stage $DataRoot $original { Interrupt-Upgrade 'rollback' }
    }
    Reconcile-Snapshot $DataRoot $manifest
    Verify-OEP $DataRoot $manifest.inventory 'backup.manifest.json'
    Select-OEPVersion $InstallRoot $DataRoot $Journal.previous
    Log-OEP $InstallRoot 'ROLLBACK OK'
    [IO.File]::Delete((Root-OEP (Join-Path $InstallRoot 'upgrade.active')))
    $Journal.state = 'rolledBack'
    $Journal.safetyCopy = if ([IO.Directory]::Exists($original)) { $original }
    Write-OEP $JournalPath $Journal
    Write-Output "已回退至 $($Journal.previous.version)。資料比對通過。"
    if ($Journal.safetyCopy) { Write-Output "保留的原資料目錄：$original" }
    Write-Output "工作比對報告：$report"
}
function Stop-UpgradeLauncher($InstallRoot, $Pointer) {
    [void](Version-OEP $Pointer.version)
    $target = Root-OEP (Join-Path $InstallRoot $Pointer.version)
    $launcher = Join-Path $target 'apps\launcher\src\web.ts'
    $worker = Join-Path $target 'scripts\windows\runtime-worker.mjs'
    $binary = Join-Path $target 'vendor\opencode\opencode.exe'
    $nodeImage = Node-OEP $target
    $launchers = @()
    foreach ($process in Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'opencode.exe'") {
        $entry = $null
        if ($process.Name -eq 'node.exe') {
            if ($process.CommandLine -match '(?i)apps[/\\]+launcher[/\\]+src[/\\]+(?:web|main)\.ts|scripts[/\\]+windows[/\\]+runtime-worker\.mjs') {
                if ($process.ExecutablePath -eq $nodeImage) {
                    foreach ($candidate in @($launcher,$worker)) {
                        if ($process.CommandLine -match ('(?:^|\s)(?:' + [regex]::Escape($candidate) + '|"' + [regex]::Escape($candidate) + '")(?:\s|$)')) {
                            $entry = $candidate
                        }
                    }
                }
                if (!$entry) { Fail-OEP '偵測到其他 OEP 啟動程式。請先停止該服務。' }
                if ($entry -eq $launcher) { $launchers += $process }
            }
        } elseif ($process.ExecutablePath -ne $binary) {
            Fail-OEP '偵測到其他 OpenCode。請先停止該服務。'
        }
    }
    if (!$launchers) {
        Stopped-OEP $InstallRoot
        return
    }
    if ($launchers.Count -ne 1) { Fail-OEP '無法確認唯一的 OEP 啟動程式。請從網頁停止服務。' }
    $launcherProcess = Get-Process -Id $launchers[0].ProcessId -ErrorAction SilentlyContinue
    if ($launcherProcess) {
        $request = Root-OEP (Join-Path $InstallRoot "stop-$($launcherProcess.Id).request")
        try {
            [IO.File]::WriteAllText($request, '')
            if (!$launcherProcess.WaitForExit(30000)) { Fail-OEP 'OEP 未在 30 秒內停止。請從網頁停止服務後重試。' }
        } finally { [IO.File]::Delete($request); $launcherProcess.Dispose() }
    }
    Stopped-OEP $InstallRoot
}
