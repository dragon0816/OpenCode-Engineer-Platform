#requires -Version 7.0
param([string]$DataRoot = $(if ($env:OEP_DATA_DIR) { $env:OEP_DATA_DIR } else { "$env:LOCALAPPDATA\OEP" }))
. "$PSScriptRoot/OEP-Maintenance.ps1"
. "$PSScriptRoot/OEP-Snapshot.ps1"
try {
    $DataRoot = Root-OEP $DataRoot
    Guard-OEP $DataRoot
    $script:failureLogRoot = $DataRoot
    CredentialStatus-OEP @(CredentialNames-OEP $DataRoot)
} catch {
    Report-OEPFailure '憑證狀態檢查失敗'
    exit 1
}
if ($script:cleanupFailed) { exit 1 }
