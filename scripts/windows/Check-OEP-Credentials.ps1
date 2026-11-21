#requires -Version 7.0
param([string]$DataRoot = $(if ($env:OEP_DATA_DIR) { $env:OEP_DATA_DIR } else { "$env:LOCALAPPDATA\OEP" }))
. "$PSScriptRoot/OEP-Maintenance.ps1"
. "$PSScriptRoot/OEP-Snapshot.ps1"
try {
    $DataRoot = Root-OEP $DataRoot
    Guard-OEP $DataRoot
    CredentialStatus-OEP @(CredentialNames-OEP $DataRoot)
} catch {
    [Console]::Error.WriteLine('讀取使用者環境變數狀態失敗。')
    exit 1
}
