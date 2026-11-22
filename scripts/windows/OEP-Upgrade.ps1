function Read-InstalledRelease($InstallRoot, $Pointer) {
    [void](Version-OEP $Pointer.version)
    $target = Root-OEP (Join-Path $InstallRoot $Pointer.version)
    $release = Read-ReleaseOEP $target $null
    if ($release.manifest.version -cne $Pointer.version -or
        ($Pointer.manifestSha256 -and $release.hash -cne $Pointer.manifestSha256)) {
        Fail-OEP '已安裝版本與發行清單不符。' (Join-Path $target 'config/release.manifest.json')
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
        Fail-OEP '升級紀錄不符。請確認資料目錄及升級紀錄。' $Path
    }
    $record
}

function Record-UpgradeFailure($Path, $DataRoot, $Operation) {
    if ($WhatIfPreference -or !$Path -or ![IO.File]::Exists($Path)) { return }
    $message = $script:failure
    try {
        $record = Read-UpgradeJournal $Path $DataRoot
        $record.failures = @($record.failures | Where-Object { $_ }) + @{
            time = [DateTime]::UtcNow.ToString('o'); operation = $Operation; message = $message
        }
        Write-OEP $Path $record
    } catch { [Console]::Error.WriteLine('【upgrade.journal.json】無法寫入升級或回退的失敗紀錄。') }
    finally { $script:failure = $message }
}

function Interrupt-Upgrade($Point) {
    if ($env:OEP_MAINTENANCE_TEST -eq '1' -and $env:OEP_TEST_INTERRUPT_UPGRADE -ceq $Point) {
        [Environment]::Exit(88)
    }
}

function Read-RollbackBackup($Journal) {
    $backup = Root-OEP $Journal.backup
    if (![IO.Directory]::Exists($backup)) { Fail-OEP '找不到升級備份。請以 -Backup 指定原備份的位置。' $backup }
    $manifest = Read-Backup $backup
    $manifestPath = Join-Path $backup 'backup.manifest.json'
    if ((Hash-OEP $manifestPath $backup) -cne $Journal.backupHash -or $manifest.oepVersion -cne $Journal.previous.version) {
        Fail-OEP '備份清單與升級紀錄不符。' $manifestPath $backup
    }
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
        if ($replacement.hash -cne $Journal.previous.manifestSha256) {
            Fail-OEP '同版本修復的發行清單不符。' (Join-Path $ready 'config/release.manifest.json')
        }
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
            try {
                [void](Invoke-OEPDataTool (Maintenance-Node) "$PSScriptRoot/data-snapshot.mjs" @('intent-diff', $DataRoot, $backup, $report) '無法比對待處理工作。' (Relative-OEP $report))
            } catch {
                Report-OEPFailure '待處理工作比對失敗' -Warning
                $Journal.failures = @($Journal.failures | Where-Object { $_ }) + @{
                    time = [DateTime]::UtcNow.ToString('o'); operation = '待處理工作比對失敗'; message = $script:failure
                }
                Write-OEP $report @{ status = 'unavailable'; changes = @(); reason = $Journal.failures[-1].message }
            }
        }
        if (![IO.File]::Exists($report)) { Write-OEP $report @{ changes = @() } }
        Move-RestoreStage $stage $DataRoot $original { Interrupt-Upgrade 'rollback' }
    }
    Reconcile-Snapshot $DataRoot $backup
    Verify-OEP $DataRoot $manifest.inventory 'backup.manifest.json'
    Select-OEPVersion $InstallRoot $DataRoot $Journal.previous
    Log-OEP $InstallRoot 'ROLLBACK OK'
    Check-OEP '移除升級執行標記失敗。' 'upgrade.active'
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
    Check-OEP '無法檢查 OEP 執行程序。' $launcher
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
                if (!$entry) { Fail-OEP '偵測到其他 OEP 啟動程式。請先停止該服務。' $launcher }
                if ($entry -eq $launcher) { $launchers += $process }
            }
        } elseif ($process.ExecutablePath -ne $binary) {
            Fail-OEP '偵測到其他 OpenCode。請先停止該服務。' $binary
        }
    }
    if (!$launchers) {
        Stopped-OEP $InstallRoot
        return
    }
    if ($launchers.Count -ne 1) { Fail-OEP '無法確認唯一的 OEP 啟動程式。請從網頁停止服務。' $launcher }
    $launcherProcess = Get-Process -Id $launchers[0].ProcessId -ErrorAction SilentlyContinue
    if ($launcherProcess) {
        $request = Root-OEP (Join-Path $InstallRoot "stop-$($launcherProcess.Id).request")
        try {
            Check-OEP '寫入 OEP 停止要求失敗。' $request
            [IO.File]::WriteAllText($request, '')
            Check-OEP '等候 OEP 停止失敗。' $request
            if (!$launcherProcess.WaitForExit(30000)) { Fail-OEP 'OEP 未在 30 秒內停止。請從網頁停止服務後重試。' $request }
        } finally { [IO.File]::Delete($request); $launcherProcess.Dispose() }
    }
    Stopped-OEP $InstallRoot
}
