function CredentialNames-OEP($Path) {
    'OEP_LITELLM_BASE_URL'
    'OEP_LITELLM_API_KEY'
    'OEP_TELEGRAM_MAIN_BOT_TOKEN'
    'OEP_TELEGRAM_BI_BOT_TOKEN'
    'OEP_TELEGRAM_ALLOWED_USER_ID'
    $report = Join-Path ([IO.Path]::GetTempPath()) ("OEP-credentials-" + [guid]::NewGuid() + '.json')
    try {
        Invoke-Snapshot 'credentials' $Path $report
        Read-OEP $report
    } finally { [IO.File]::Delete($report) }
}
function CredentialStatus-OEP($Names) {
    foreach ($name in $Names) {
        $configured = ![string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name, 'User'))
        $status = if ($configured) { '已設定' } else { '未設定' }
        Write-Output "$name $status"
    }
}
function Invoke-Snapshot($Mode, $Source, $Destination) {
    & (Maintenance-Node) --disable-warning=ExperimentalWarning "$PSScriptRoot/data-snapshot.mjs" $Mode $Source $Destination 2>$null
    if ($LASTEXITCODE) { Fail-OEP 'SQLite 快照或資料比對失敗。' }
}
function Describe-Snapshot($Path) {
    $report = Join-Path ([IO.Path]::GetTempPath()) ("OEP-inventory-" + [guid]::NewGuid() + '.json')
    try {
        Invoke-Snapshot 'describe' $Path $report
        Read-OEP $report
    } finally { [IO.File]::Delete($report) }
}
function Read-Backup($Path) {
    [void]@(Tree-OEP $Path)
    $manifest = Read-OEP (Join-Path $Path 'backup.manifest.json')
    if ($manifest.format -ne 1 -or $manifest.tool -cne 'OEP.Backup' -or !$manifest.Contains('inventory') -or
        !$manifest.Contains('databases')) {
        Fail-OEP '備份清單格式錯誤。'
    }
    Verify-OEP $Path $manifest.inventory 'backup.manifest.json'
    if (($manifest.credentials -join '|') -cne ((CredentialNames-OEP $Path) -join '|')) {
        Fail-OEP '備份憑證名稱與資料庫不符。'
    }
    $manifest
}
function Reconcile-Snapshot($Path, $Manifest) {
    $actual = Describe-Snapshot $Path
    if ((ConvertTo-Json -InputObject $actual.databases -Depth 30 -Compress) -cne
        (ConvertTo-Json -InputObject $Manifest.databases -Depth 30 -Compress)) {
        Fail-OEP '回復比對失敗。資料筆數、SQLite 版本或發布修訂雜湊不符。'
    }
}
function New-Backup($Source, $Destination, $Version) {
    [void]@(Tree-OEP $Source)
    [void][IO.Directory]::CreateDirectory($Destination)
    $id = [guid]::NewGuid().ToString('N')
    $stage = Join-Path $Destination ".oep-backup-$id"
    $name = 'OEP-backup-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffffffZ') + "-$id"
    $target = Join-Path $Destination $name
    [void][IO.Directory]::CreateDirectory($stage)
    try {
        Invoke-Snapshot 'copy' $Source $stage
        $manifest = Describe-Snapshot $stage
        $manifest.format = 1
        $manifest.tool = 'OEP.Backup'
        $manifest.backupId = $name
        $manifest.createdAt = [DateTime]::UtcNow.ToString('o')
        $manifest.oepVersion = $Version
        $manifest.credentials = @(CredentialNames-OEP $stage)
        $manifest.credentialNotice = '備份未讀取使用者環境變數的值。請重新設定下列名稱。'
        Write-OEP (Join-Path $stage 'backup.manifest.json') $manifest
        [IO.Directory]::Move($stage, $target)
        $target
    } finally { if ([IO.Directory]::Exists($stage)) { [IO.Directory]::Delete($stage, $true) } }
}
function Installed-Version($Root) {
    $pointer = Root-OEP (Join-Path $Root 'current.json')
    if ([IO.File]::Exists($pointer)) { return (Version-OEP (Read-OEP $pointer).version).ToString() }
    $release = Join-Path $PSScriptRoot '../../config/release.manifest.json'
    if ([IO.File]::Exists($release)) { return (Version-OEP (Read-OEP $release).version).ToString() }
    $package = Join-Path $PSScriptRoot '../../package.json'
    (Version-OEP (Read-OEP $package).version).ToString()
}
function Copy-RestoreStage($Backup, $Manifest, $Stage) {
    [void][IO.Directory]::CreateDirectory($Stage)
    foreach ($entry in $Manifest.inventory) {
        $path = Entry-OEP $Stage $entry.path
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))
        [IO.File]::Copy((Entry-OEP $Backup $entry.path), $path)
    }
    Verify-OEP $Stage $Manifest.inventory 'backup.manifest.json'
    Reconcile-Snapshot $Stage $Manifest
}

function Move-RestoreStage($Stage, $DataRoot, $Original, [scriptblock]$BeforeSwap) {
    if ([IO.Directory]::Exists($DataRoot)) { [IO.Directory]::Move($DataRoot, $Original) }
    try {
        if ($BeforeSwap) { & $BeforeSwap }
        [IO.Directory]::Move($Stage, $DataRoot)
    }
    catch {
        if ([IO.Directory]::Exists($Original) -and ![IO.Directory]::Exists($DataRoot)) {
            [IO.Directory]::Move($Original, $DataRoot)
        }
        throw
    }
}
