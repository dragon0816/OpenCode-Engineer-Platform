$ErrorActionPreference = 'Stop'
$script:failure = '作業失敗。請檢查權限、剩餘空間及使用中的檔案。'
function Fail-OEP($Message) { $script:failure = $Message; throw 'Maintenance failed' }
function Root-OEP([string]$Path) {
    if (![IO.Path]::IsPathFullyQualified($Path)) { Fail-OEP '請指定完整路徑。' }
    $full = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($Path))
    if ($full -eq [IO.Path]::GetPathRoot($full)) { Fail-OEP '請勿指定磁碟根目錄。' }
    for ($at = $full; $at; $at = [IO.Path]::GetDirectoryName($at)) {
        $item = Get-Item -LiteralPath $at -Force -ErrorAction SilentlyContinue
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail-OEP '路徑含有連結。' }
    }
    $full
}
function Within-OEP($Path, $Root) {
    $Path -eq $Root -or $Path.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)
}
function Separate-OEP($A, $B) {
    if ((Within-OEP $A $B) -or (Within-OEP $B $A)) { Fail-OEP '來源與目的地不可重疊。' }
}
function Guard-OEP($Path) {
    if ($env:OEP_MAINTENANCE_TEST -eq '1') {
        Separate-OEP $Path "$env:LOCALAPPDATA\OEP"
        Separate-OEP $Path "$env:LOCALAPPDATA\Programs\OEP"
    }
}
function Tree-OEP($Root) {
    foreach ($item in Get-ChildItem -LiteralPath $Root -Force) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail-OEP '發現檔案或目錄連結。' }
        if ($item.PSIsContainer) { Tree-OEP $item.FullName } else { $item }
    }
}
function Entry-OEP($Root, [string]$Relative) {
    foreach ($part in $Relative.Split('/')) {
        if ($part -notmatch '^[^\\/:*?"<>|\x00-\x1f]+$' -or $part -match '[ .]$|^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(\.|$)') {
            Fail-OEP '清單或壓縮檔含有不安全的路徑。'
        }
    }
    Join-Path $Root $Relative
}
function Hash-OEP($Path) {
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose(); $stream.Dispose() }
}
function Read-OEP($Path) { Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable }
function Write-OEP($Path, $Value) {
    $scratch = "$Path.$([guid]::NewGuid()).tmp"
    try {
        [IO.File]::WriteAllText($scratch, (ConvertTo-Json -InputObject $Value -Depth 30))
        [IO.File]::Move($scratch, $Path, $true)
    } finally { [IO.File]::Delete($scratch) }
}
function Log-OEP($Root, $Operation) {
    $path = Root-OEP (Join-Path $Root 'maintenance.log')
    [IO.File]::AppendAllText($path, "$([DateTime]::UtcNow.ToString('o')) $Operation" + [Environment]::NewLine)
}
function Lock-OEP {
    $mutex = [Threading.Mutex]::new($false, 'Local\OEP.Maintenance')
    try {
        try { $entered = $mutex.WaitOne(0) }
        catch [Threading.AbandonedMutexException] { $entered = $true }
        if (!$entered) { Fail-OEP '另一項 OEP 維護作業正在執行。' }
        $mutex
    } catch { $mutex.Dispose(); throw }
}
function Stopped-OEP([string]$InstallRoot) {
    foreach ($process in Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'opencode.exe'") {
        if ($process.Name -eq 'opencode.exe' -or $process.CommandLine -match '(?i)apps[/\\]+launcher[/\\]+src[/\\]+(?:web|main)\.ts|scripts[/\\]+windows[/\\]+runtime-worker\.mjs') {
            if ($InstallRoot -and $process.ExecutablePath -and (Within-OEP $process.ExecutablePath $InstallRoot)) {
                Fail-OEP '這套 OEP 正在執行。請先從網頁停止服務。'
            }
            Fail-OEP '偵測到正在執行的 OEP 或 OpenCode。請先停止服務。'
        }
    }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $script:runtimeMutex = [Threading.Mutex]::new($false, "Global\OEP.Runtime.$sid")
    try { $script:runtimeHeld = $script:runtimeMutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $script:runtimeHeld = $true }
    if (!$script:runtimeHeld) { Fail-OEP 'OEP 正在啟動或執行。請先停止服務。' }
}
function Unlock-OEP($MaintenanceMutex) {
    if ($script:runtimeMutex) {
        if ($script:runtimeHeld) { $script:runtimeMutex.ReleaseMutex() }
        $script:runtimeMutex.Dispose()
    }
    if ($MaintenanceMutex) { $MaintenanceMutex.ReleaseMutex(); $MaintenanceMutex.Dispose() }
}
function Verify-OEP($Root, $Files, $Manifest) {
    $expected = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $Files) {
        $path = Entry-OEP $Root $entry.path
        if ($path -eq (Join-Path $Root $Manifest) -or !$expected.Add($path) -or $entry.sha256 -cnotmatch '^[a-f0-9]{64}$') {
            Fail-OEP '檔案清單格式錯誤或含有重複項目。'
        }
    }
    foreach ($file in Tree-OEP $Root) {
        if ($file.FullName -eq (Join-Path $Root $Manifest)) { continue }
        if (!$expected.Remove($file.FullName)) { Fail-OEP '發現清單以外的檔案。' }
    }
    if ($expected.Count) { Fail-OEP '缺少清單列出的檔案。' }
    foreach ($entry in $Files) {
        $path = Entry-OEP $Root $entry.path
        if ([IO.FileInfo]::new($path).Length -ne $entry.size -or (Hash-OEP $path) -cne $entry.sha256) {
            Fail-OEP '檔案大小或 SHA-256 不符。'
        }
    }
}
function Version-OEP($Value) {
    if ($Value -cnotmatch '^\d+\.\d+\.\d+$') { Fail-OEP '版本格式錯誤。' }
    [version]$Value
}
function Links-OEP {
    if ($env:OEP_MAINTENANCE_TEST -ne '1') {
        Join-Path ([Environment]::GetFolderPath('Programs')) 'OEP.lnk'
        Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'OEP.lnk'
    }
}
function Publish-OEPShortcuts($Target, $DataRoot) {
    if ($env:OEP_MAINTENANCE_TEST -eq '1') { return }
    $pwsh = Join-Path $PSHOME 'pwsh.exe'
    $start = Join-Path $Target 'scripts/windows/Start-OEP.ps1'
    $arguments = "-NoProfile -WindowStyle Hidden -File ""$start"" -DataRoot ""$DataRoot"""
    $links = @(Links-OEP)
    $shell = New-Object -ComObject WScript.Shell
    foreach ($link in $links) {
        $link = Root-OEP $link
        if ($link -eq $links[1] -and !$DesktopShortcut) { [IO.File]::Delete($link); continue }
        $shortcut = $shell.CreateShortcut($link)
        $shortcut.TargetPath = $pwsh
        $shortcut.Arguments = $arguments
        $shortcut.WorkingDirectory = $Target
        $shortcut.Save()
    }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $name = "OEP-Logon-$sid"
    if ($AutoStart) {
        $action = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $sid
        $principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    } elseif (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
    }
}
