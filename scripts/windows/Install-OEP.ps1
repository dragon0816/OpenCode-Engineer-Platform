#requires -Version 7.0
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$Source,
    [string]$InstallRoot = "$env:LOCALAPPDATA\Programs\OEP",
    [string]$DataRoot = $(if ($env:OEP_DATA_DIR) { $env:OEP_DATA_DIR } else { "$env:LOCALAPPDATA\OEP" }),
    [switch]$DesktopShortcut,
    [switch]$AutoStart,
    [switch]$AllowDowngrade
)
. "$PSScriptRoot/OEP-Maintenance.ps1"
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
            if (!$WhatIfPreference) {
                [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $path)
            }
        }
    } finally { $zip.Dispose() }
}
$mutex = $null
$scratch = $null
$stage = $null
try {
    $mutex = Lock-OEP
    $InstallRoot = Root-OEP $InstallRoot
    $DataRoot = Root-OEP $DataRoot
    Guard-OEP $InstallRoot
    Guard-OEP $DataRoot
    Separate-OEP $InstallRoot $DataRoot
    $sourcePath = Root-OEP $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Source)
    Separate-OEP $sourcePath $InstallRoot
    Separate-OEP $sourcePath $DataRoot
    Check-Prerequisites
    Stopped-OEP $InstallRoot
    $manifestName = 'config/release.manifest.json'
    if ([IO.File]::Exists($sourcePath)) {
        $scratch = Join-Path ([IO.Path]::GetTempPath()) ("OEP-release-" + [guid]::NewGuid())
        Expand-Release $sourcePath $scratch
        if ($WhatIfPreference) { Write-Output '預演完成。正式安裝時會驗證 ZIP 內所有檔案。'; return }
        $sourcePath = $scratch
    }
    [void]@(Tree-OEP $sourcePath)
    $manifestPath = Join-Path $sourcePath $manifestName
    $manifest = Read-OEP $manifestPath
    if ($manifest.format -ne 1 -or $manifest.platform -cne 'windows-x64' -or !$manifest.files) { Fail-OEP '發行清單格式不符。' }
    $version = Version-OEP $manifest.version
    Verify-OEP $sourcePath $manifest.files $manifestName
    $manifestHash = Hash-OEP $manifestPath
    $currentPath = Root-OEP (Join-Path $InstallRoot 'current.json')
    if (Test-Path -LiteralPath $currentPath) {
        $current = Read-OEP $currentPath
        if ($version -lt (Version-OEP $current.version) -and !$AllowDowngrade) { Fail-OEP '已安裝較新版本。若確定要降版，請加上 -AllowDowngrade。' }
    }
    $target = Root-OEP (Join-Path $InstallRoot $manifest.version)
    if (!$PSCmdlet.ShouldProcess($target, '安裝 OEP')) { return }

    if (Test-Path -LiteralPath $target) {
        Verify-OEP $target $manifest.files $manifestName
        if ((Hash-OEP (Join-Path $target $manifestName)) -ne $manifestHash) { Fail-OEP '相同版本的發行清單不同。' }
    } else {
        [void][IO.Directory]::CreateDirectory($InstallRoot)
        $stage = Join-Path $InstallRoot ('.install-' + [guid]::NewGuid())
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
    [void][IO.Directory]::CreateDirectory($DataRoot)
    Publish-OEPShortcuts $target $DataRoot
    Write-OEP $currentPath @{
        version = $manifest.version
        installedAt = [DateTime]::UtcNow.ToString('o')
        manifestSha256 = $manifestHash
    }
    Write-Output 'OEP 安裝完成。請從開始功能表開啟 OEP。'
} catch {
    [Console]::Error.WriteLine($script:failure)
    exit 1
} finally {
    foreach ($temp in @($scratch, $stage)) {
        if ($temp -and [IO.Directory]::Exists($temp)) { [IO.Directory]::Delete($temp, $true) }
    }
    Unlock-OEP $mutex
}
