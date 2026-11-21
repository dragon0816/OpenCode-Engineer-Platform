#requires -Version 7.0
. "$PSScriptRoot/OEP-Snapshot.ps1"
try {
    foreach ($name in CredentialNames-OEP) {
        $configured = ![string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name, 'User'))
        $status = if ($configured) { '已設定' } else { '未設定' }
        Write-Output "$name $status"
    }
} catch {
    [Console]::Error.WriteLine('讀取使用者環境變數狀態失敗。')
    exit 1
}
