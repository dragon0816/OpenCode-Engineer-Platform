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
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.LinkType -eq 'HardLink') {
            Fail-OEP '發現檔案或目錄連結。'
        }
        if ($item.PSIsContainer) { Tree-OEP $item.FullName } else { $item }
    }
}
function Entry-OEP($Root, [string]$Relative) {
    foreach ($part in $Relative.Split('/')) {
        if ($part -notmatch '^[^\\/:*?"<>|\x00-\x1f]+$' -or $part -match '[ .]$|^(CON|CONIN\$|CONOUT\$|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(\.|$)') {
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
    $arguments = "-NoProfile -ExecutionPolicy RemoteSigned -WindowStyle Hidden -File ""$start"" -DataRoot ""$DataRoot"""
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

function Check-Prerequisites {
    if (!$IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
        Fail-OEP '需要 Windows x64。'
    }
    $node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (!$node -or (& $node.Source -p "process.versions.node.split('.')[0]+'/'+process.arch" 2>$null) -ne '24/x64') {
        Fail-OEP '需要 Node.js 24 x64。下載 https://nodejs.org/dist/latest-v24.x/ 或執行 winget install --id OpenJS.NodeJS.LTS --exact，並確認版本為 24。'
    }
    $python = if ($env:OEP_PYTHON) { $env:OEP_PYTHON } else { 'python.exe' }
    $script:failure = '需要 Python 3.12 和 openpyxl、defusedxml。執行 winget install --id Python.Python.3.12 --exact，再依操作文件安裝套件。'
    & $python -I -c 'import sys,openpyxl,defusedxml; sys.exit(sys.version_info[:2] != (3,12))' 2>$null
    if ($LASTEXITCODE) { Fail-OEP $script:failure }
    $script:failure = '作業失敗。請檢查權限、剩餘空間及使用中的檔案。'
}
function Expand-Release($Archive, $Destination) {
    $sums = Root-OEP (Join-Path (Split-Path $Archive) 'SHA256SUMS')
    if (Test-Path -LiteralPath $sums) {
        $pattern = '^([a-fA-F0-9]{64})  ' + [regex]::Escape([IO.Path]::GetFileName($Archive)) + '$'
        $matchesForZip = @(Get-Content -LiteralPath $sums | Where-Object { $_ -cmatch $pattern })
        if ($matchesForZip.Count -ne 1 -or $matchesForZip[0].Substring(0,64) -ne (Hash-OEP $Archive)) {
            Fail-OEP 'ZIP 的 SHA-256 與 SHA256SUMS 不符。'
        }
    }
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        $entries = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($entry in $zip.Entries) {
            $path = Entry-OEP $Destination $entry.FullName
            $mode = ($entry.ExternalAttributes -shr 16) -band 0xf000
            if (!$entries.Add($path) -or ($mode -ne 0 -and $mode -ne 0x8000) -or ($entry.ExternalAttributes -band 0x450)) {
                Fail-OEP '壓縮檔含有連結、目錄或重複項目。'
            }
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
    [void]@(Tree-OEP $sourcePath)
    $manifestPath = Join-Path $sourcePath $manifestName
    $manifest = Read-OEP $manifestPath
    if ($manifest.format -ne 1 -or $manifest.platform -cne 'windows-x64' -or !$manifest.files) { Fail-OEP '發行清單格式不符。' }
    $version = Version-OEP $manifest.version
    Verify-OEP $sourcePath $manifest.files $manifestName
    $manifestHash = Hash-OEP $manifestPath
    @{ root = $sourcePath; manifest = $manifest; version = $version; hash = $manifestHash }
}
function Stage-ReleaseOEP($Release, $target, $stage) {
    $manifestName = 'config/release.manifest.json'
    $manifest = $Release.manifest
    $manifestHash = $Release.hash
    $sourcePath = $Release.root
    if (Test-Path -LiteralPath $target) {
        Verify-OEP $target $manifest.files $manifestName
        if ((Hash-OEP (Join-Path $target $manifestName)) -ne $manifestHash) { Fail-OEP '相同版本的發行清單不同。' }
    } else {
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
        foreach ($relative in @($manifest.files.path) + $manifestName) {
            $destination = Entry-OEP $stage $relative
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination))
            [IO.File]::Copy((Entry-OEP $sourcePath $relative), $destination)
            if ($relative -match '\.(?:ps1|vbs)$') { Unblock-File -LiteralPath $destination }
        }
        Verify-OEP $stage $manifest.files $manifestName
        if ((Hash-OEP (Join-Path $stage $manifestName)) -ne $manifestHash) { Fail-OEP '發行清單在複製時變更。' }
        [IO.Directory]::Move($stage, $target)
    }
}
