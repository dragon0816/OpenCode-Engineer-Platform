$ErrorActionPreference = 'Stop'
$script:failure = '【.】維護作業失敗。請檢查權限、剩餘空間及使用中的檔案。'
function Relative-OEP([string]$Path, [string]$Base) {
    if (!$Path) { return '.' }
    if ([IO.Path]::IsPathFullyQualified($Path)) {
        $scope = @($InstallRoot, $DataRoot, $Base) | Where-Object {
            $_ -and [IO.Path]::IsPathFullyQualified($_) -and (Within-OEP $Path $_)
        } | Select-Object -First 1
        $Path = if ($scope) { [IO.Path]::GetRelativePath($scope, $Path) } else { [IO.Path]::GetFileName($Path) }
    }
    ($Path -replace '\\', '/' -replace '[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]', '�').Replace('】', '］')
}
function Check-OEP($Message, $Path = '.', $Base) {
    $script:failure = "【$(Relative-OEP $Path $Base)】$Message"
}
function Fail-OEP($Message, $Path = '.', $Base) {
    Check-OEP $Message $Path $Base
    throw 'Maintenance failed'
}
function Report-OEPFailure($Operation, [switch]$Warning) {
    $message = $script:failure
    if ($Warning) { Write-Warning $message } else { [Console]::Error.WriteLine($message) }
    if ($script:failureLogRoot -and !$WhatIfPreference -and [IO.Directory]::Exists($script:failureLogRoot)) {
        try { Log-OEP $script:failureLogRoot "$Operation $message" }
        catch { [Console]::Error.WriteLine('【maintenance.log】無法寫入維護失敗紀錄。') }
        finally { $script:failure = $message }
    }
}
function Root-OEP([string]$Path) {
    if (![IO.Path]::IsPathFullyQualified($Path)) { Fail-OEP '請指定完整路徑。' }
    $full = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($Path))
    if ($full -eq [IO.Path]::GetPathRoot($full)) { Fail-OEP '請勿指定磁碟根目錄。' }
    for ($at = $full; $at; $at = [IO.Path]::GetDirectoryName($at)) {
        $item = Get-Item -LiteralPath $at -Force -ErrorAction SilentlyContinue
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail-OEP '路徑含有連結。' $at }
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
function Tree-OEP($Root, $Base = $Root) {
    Check-OEP '無法列出目錄。請檢查目錄是否存在及其權限。' $Root $Base
    foreach ($item in Get-ChildItem -LiteralPath $Root -Force) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.LinkType -eq 'HardLink') {
            Fail-OEP '發現檔案或目錄連結。' $item.FullName $Base
        }
        if ($item.PSIsContainer) { Tree-OEP $item.FullName $Base } else { $item }
    }
}
function Assert-EntryOEP($Root, [string]$Relative) {
    foreach ($part in $Relative.Split('/')) {
        if ($part -notmatch '^[^\\/:*?"<>|\x00-\x1f]+$' -or $part -match '[ .]$|^(CON|CONIN\$|CONOUT\$|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(\.|$)') {
            Fail-OEP '清單或壓縮檔含有不安全的路徑。' $Root
        }
    }
}
function Entry-OEP($Root, [string]$Relative) {
    Assert-EntryOEP $Root $Relative
    Join-Path $Root $Relative
}
function Hash-OEP($Path, $Base) {
    Check-OEP '讀取檔案以計算 SHA-256 失敗。' $Path $Base
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose(); $stream.Dispose() }
}
function Read-OEP($Path, $Base) {
    Check-OEP '讀取檔案或解析 JSON 失敗。' $Path $Base
    Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable
}
function Write-OEP($Path, $Value) {
    Check-OEP '原子寫入 JSON 檔案失敗。' $Path
    $scratch = "$Path.$([guid]::NewGuid()).tmp"
    try {
        [IO.File]::WriteAllText($scratch, (ConvertTo-Json -InputObject $Value -Depth 30))
        [IO.File]::Move($scratch, $Path, $true)
    } finally { [IO.File]::Delete($scratch) }
}
function Log-OEP($Root, $Operation) {
    $path = Root-OEP (Join-Path $Root 'maintenance.log')
    Check-OEP '附加維護紀錄失敗。' $path $Root
    [IO.File]::AppendAllText($path, "$([DateTime]::UtcNow.ToString('o')) $Operation" + [Environment]::NewLine)
}
function Lock-OEP {
    Check-OEP '無法取得維護作業鎖。' 'maintenance.log'
    $mutex = [Threading.Mutex]::new($false, 'Local\OEP.Maintenance')
    try {
        try { $entered = $mutex.WaitOne(0) }
        catch [Threading.AbandonedMutexException] { $entered = $true }
        if (!$entered) { Fail-OEP '另一項 OEP 維護作業正在執行。' 'maintenance.log' }
        $mutex
    } catch { $mutex.Dispose(); throw }
}
function Stopped-OEP([string]$InstallRoot) {
    Check-OEP '無法檢查 OEP 執行程序或取得執行鎖。' 'current.json'
    foreach ($process in Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'opencode.exe'") {
        if ($process.Name -eq 'opencode.exe' -or $process.CommandLine -match '(?i)apps[/\\]+launcher[/\\]+src[/\\]+(?:web|main)\.ts|scripts[/\\]+windows[/\\]+runtime-worker\.mjs') {
            if ($InstallRoot -and $process.ExecutablePath -and (Within-OEP $process.ExecutablePath $InstallRoot)) {
                Fail-OEP '這套 OEP 正在執行。請先從網頁停止服務。' 'current.json'
            }
            Fail-OEP '偵測到正在執行的 OEP 或 OpenCode。請先停止服務。' 'current.json'
        }
    }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $script:runtimeMutex = [Threading.Mutex]::new($false, "Global\OEP.Runtime.$sid")
    try { $script:runtimeHeld = $script:runtimeMutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $script:runtimeHeld = $true }
    if (!$script:runtimeHeld) { Fail-OEP 'OEP 正在啟動或執行。請先停止服務。' 'current.json' }
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
            Fail-OEP '檔案清單格式錯誤或含有重複項目。' $path $Root
        }
    }
    foreach ($file in Tree-OEP $Root) {
        if ($file.FullName -eq (Join-Path $Root $Manifest)) { continue }
        if (!$expected.Remove($file.FullName)) { Fail-OEP '發現清單以外的檔案。' $file.FullName $Root }
    }
    if ($expected.Count) { Fail-OEP '缺少清單列出的檔案。' ($expected | Sort-Object | Select-Object -First 1) $Root }
    foreach ($entry in $Files) {
        $path = Entry-OEP $Root $entry.path
        Check-OEP '讀取檔案大小失敗。' $path $Root
        if ([IO.FileInfo]::new($path).Length -ne $entry.size -or (Hash-OEP $path $Root) -cne $entry.sha256) {
            Fail-OEP '檔案大小或 SHA-256 不符。' $path $Root
        }
    }
}
function Version-OEP($Value, $Path = 'current.json') {
    if ($Value -cnotmatch '^\d+\.\d+\.\d+$') { Fail-OEP '版本格式錯誤。' $Path }
    Check-OEP '解析版本失敗。' $Path
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
    $arguments = "-NoProfile -ExecutionPolicy RemoteSigned -WindowStyle Hidden -File ""$start"" -DataRoot ""$DataRoot"""
    $launcher = $pwsh
    if ([IO.File]::Exists((Join-Path $Target 'vendor/node/node.exe'))) {
        $launcher = Join-Path $env:SystemRoot 'System32/wscript.exe'
        $start = Join-Path $Target 'scripts/windows/Start-Bundled-OEP.vbs'
        $arguments = """$start"" ""$DataRoot"""
    }
    $links = @(Links-OEP)
    Check-OEP '建立捷徑管理物件失敗。' 'OEP.lnk'
    $shell = New-Object -ComObject WScript.Shell
    foreach ($link in $links) {
        $link = Root-OEP $link
        Check-OEP '更新 OEP 捷徑失敗。' 'OEP.lnk'
        if ($link -eq $links[1] -and !$DesktopShortcut) { [IO.File]::Delete($link); continue }
        $shortcut = $shell.CreateShortcut($link)
        $shortcut.TargetPath = $launcher
        $shortcut.Arguments = $arguments
        $shortcut.WorkingDirectory = $Target
        $shortcut.Save()
    }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $name = "OEP-Logon-$sid"
    Check-OEP '更新 OEP 登入排程失敗。' 'current.json'
    if ($AutoStart) {
        $action = New-ScheduledTaskAction -Execute $launcher -Argument $arguments
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $sid
        $principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    } elseif (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
    }
}

function Node-OEP($Root) {
    if ($Root) {
        $bundledNode = Join-Path $Root 'vendor/node/node.exe'
        if ([IO.File]::Exists($bundledNode)) { return $bundledNode }
    }
    (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
}
function Maintenance-Node {
    $root = Split-Path (Split-Path $PSScriptRoot)
    $node = Join-Path $root 'vendor/node/node.exe'
    if ([IO.File]::Exists($node)) { return $node }
    if ($InstallRoot) {
        $pointer = Join-Path $InstallRoot 'current.json'
        if ([IO.File]::Exists($pointer)) {
            $current = Read-OEP $pointer
            [void](Version-OEP $current.version)
            return (Node-OEP (Join-Path $InstallRoot $current.version))
        }
    }
    Node-OEP $null
}
function Check-Prerequisites($Release) {
    if (!$IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
        Fail-OEP '需要 Windows x64。'
    }
    $bundled = $Release.manifest.variant -ceq 'bundled'
    $node = if ($bundled) { Entry-OEP $Release.root 'vendor/node/node.exe' } else { Node-OEP $null }
    Check-OEP '執行 Node.js 版本檢查失敗。' 'vendor/node/node.exe'
    if (!$node -or ![IO.File]::Exists($node) -or (& $node -p "process.versions.node.split('.')[0]+'/'+process.arch" 2>$null) -ne '24/x64') {
        if ($bundled) { Fail-OEP '發行套件內的 Node.js 執行環境無法使用。' 'vendor/node/node.exe' }
        Fail-OEP '需要 Node.js 24 x64。請安裝後重新執行。' 'node.exe'
    }
    $python = if ($env:OEP_PYTHON) { $env:OEP_PYTHON } else { 'python.exe' }
    Check-OEP '需要 Python 3.12 和 openpyxl、defusedxml。請依操作文件安裝。' 'python.exe'
    if ($bundled) {
        $python = Entry-OEP $Release.root 'vendor/python/python.exe'
        Check-OEP '發行套件內的 Python 執行環境無法使用。' 'vendor/python/python.exe'
        if (![IO.File]::Exists($python)) { throw 'Maintenance failed' }
    }
    & $python -I -c 'import sys,openpyxl,defusedxml; sys.exit(sys.version_info[:2] != (3,12))' 2>$null
    if ($LASTEXITCODE) { throw 'Maintenance failed' }
}
function Expand-Release($Archive, $Destination) {
    $sums = Root-OEP (Join-Path (Split-Path $Archive) 'SHA256SUMS')
    if (Test-Path -LiteralPath $sums) {
        Check-OEP '讀取 ZIP 雜湊清單失敗。' $sums
        $pattern = '^([a-fA-F0-9]{64})  ' + [regex]::Escape([IO.Path]::GetFileName($Archive)) + '$'
        $matchesForZip = @(Get-Content -LiteralPath $sums | Where-Object { $_ -cmatch $pattern })
        if ($matchesForZip.Count -ne 1 -or $matchesForZip[0].Substring(0,64) -ne (Hash-OEP $Archive)) {
            Fail-OEP 'ZIP 的 SHA-256 與 SHA256SUMS 不符。' $Archive
        }
    }
    Check-OEP '開啟 ZIP 失敗。' $Archive
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        $entries = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($entry in $zip.Entries) {
            Assert-EntryOEP $Archive $entry.FullName
            $path = Join-Path $Destination $entry.FullName
            $mode = ($entry.ExternalAttributes -shr 16) -band 0xf000
            if (!$entries.Add($path) -or ($mode -ne 0 -and $mode -ne 0x8000) -or ($entry.ExternalAttributes -band 0x450)) {
                Fail-OEP '壓縮檔含有連結、目錄或重複項目。' $entry.FullName
            }
            Check-OEP '解壓縮 ZIP 項目失敗。' $entry.FullName
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $path)
        }
    } finally { $zip.Dispose() }
}
function Read-ReleaseOEP($sourcePath, $scratch) {
    $manifestName = 'config/release.manifest.json'
    if ([IO.File]::Exists($sourcePath)) {
        Expand-Release $sourcePath $scratch
        $sourcePath = $scratch
    }
    $manifestPath = Join-Path $sourcePath $manifestName
    [void]@(Tree-OEP $sourcePath)
    $manifest = Read-OEP $manifestPath $sourcePath
    if ($manifest.format -ne 1 -or $manifest.platform -cne 'windows-x64' -or !$manifest.files) {
        Fail-OEP '發行清單格式不符。' $manifestPath $sourcePath
    }
    $version = Version-OEP $manifest.version (Relative-OEP $manifestPath $sourcePath)
    Verify-OEP $sourcePath $manifest.files $manifestName
    $manifestHash = Hash-OEP $manifestPath $sourcePath
    @{ root = $sourcePath; manifest = $manifest; version = $version; hash = $manifestHash }
}
function Stage-ReleaseOEP($Release, $target, $stage) {
    $manifestName = 'config/release.manifest.json'
    $manifest = $Release.manifest
    $manifestHash = $Release.hash
    $sourcePath = $Release.root
    if (Test-Path -LiteralPath $target) {
        Verify-StagedRelease $Release $target
    } else {
        Check-OEP '建立發行版本的安裝目錄失敗。' $target
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
        foreach ($relative in @($manifest.files.path) + $manifestName) {
            $destination = Entry-OEP $stage $relative
            Check-OEP '複製或解除封鎖發行檔案失敗。' (Join-Path $target $relative)
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination))
            [IO.File]::Copy((Entry-OEP $sourcePath $relative), $destination)
            if ($relative -match '\.(?:ps1|vbs)$') { Unblock-File -LiteralPath $destination }
        }
        Verify-StagedRelease $Release $stage
        Check-OEP '將暫存目錄移入發行版本目錄失敗。' $target
        [IO.Directory]::Move($stage, $target)
    }
}
function Verify-StagedRelease($Release, $Target) {
    $manifestName = 'config/release.manifest.json'
    Verify-OEP $Target $Release.manifest.files $manifestName
    $path = Join-Path $Target $manifestName
    if ((Hash-OEP $path $Target) -cne $Release.hash) { Fail-OEP '相同版本的發行清單不同。' $path $Target }
}
