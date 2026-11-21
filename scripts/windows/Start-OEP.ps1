param([string]$DataRoot)
$ErrorActionPreference = 'Stop'
if ($DataRoot) { $env:OEP_DATA_DIR = $DataRoot }
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Set-Location -LiteralPath $root

try {
    $node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
    if ((& $node -p "process.versions.node.split('.')[0] + '/' + process.arch") -ne '24/x64') {
        throw 'Node.js 24 x64 is required.'
    }
    $python = if ($env:OEP_PYTHON) { $env:OEP_PYTHON } else { 'python.exe' }
    $release = Test-Path -LiteralPath 'config/release.manifest.json'
    $pythonCheck = if ($release) { 'import ctypes, zipfile, xml.etree.ElementTree, openpyxl, defusedxml' } else { 'import ctypes, zipfile, xml.etree.ElementTree' }
    & $python -I -c $pythonCheck
    if ($LASTEXITCODE) { throw 'Python is required.' }
    $pwsh = Join-Path $env:ProgramFiles 'PowerShell/7/pwsh.exe'
    if (!(Test-Path -LiteralPath $pwsh)) {
        $pwsh = (Get-Command pwsh.exe -CommandType Application | Select-Object -First 1).Source
    }
    if (!(Test-Path -LiteralPath $pwsh)) { throw 'PowerShell 7 is required.' }
    $env:OEP_PWSH = $pwsh

    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $bootstrap = [Threading.Mutex]::new($false, "Global\OEP.Bootstrap.$sid")
    $locked = $false
    try {
        try { $locked = $bootstrap.WaitOne([TimeSpan]::FromMinutes(10)) }
        catch [Threading.AbandonedMutexException] { $locked = $true }
        if (!$locked) { throw 'OEP setup is already running.' }
        if (!(Test-Path -LiteralPath 'node_modules/@opencode/client/package.json') -or
            !(Test-Path -LiteralPath 'node_modules/fflate/package.json')) {
            if ($release) { throw '發行套件缺少必要檔案。' }
            $npm = Join-Path (Split-Path $node -Parent) 'npm.cmd'
            & $npm ci --cache .phase0/npm-cache
            if ($LASTEXITCODE) { throw 'OEP dependencies could not be installed.' }
        }
        if (!$release -and (!(Test-Path -LiteralPath '.phase0/assets/unpacked/opencode.exe') -or
            !(Test-Path -LiteralPath '.phase0/source/openapi.json'))) {
            & $pwsh -NoProfile -NonInteractive -File (Join-Path $root 'scripts/phase0/fetch-pins.ps1') -WindowsOnly
            if ($LASTEXITCODE) { throw 'Pinned OpenCode could not be installed.' }
        }
    } finally {
        if ($locked) { $bootstrap.ReleaseMutex() }
        $bootstrap.Dispose()
    }

    & $node --disable-warning=ExperimentalWarning (Join-Path $root 'apps/launcher/src/web.ts')
    exit $LASTEXITCODE
} catch {
    Write-Error 'OEP setup or startup failed. See docs/validation/p2-windows-web.md.'
    exit 1
}
