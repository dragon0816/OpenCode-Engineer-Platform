#requires -Version 7.0
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$DataRoot = "$env:LOCALAPPDATA\OEP",
    [string]$Destination = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'OEP-Backups'),
    [ValidatePattern('^(?:[01]\d|2[0-3]):[0-5]\d$')][string]$At = '20:00',
    [ValidateRange(1, 10000)][int]$KeepLast = 14
)
. "$PSScriptRoot/OEP-Maintenance.ps1"
try {
    if ($env:OEP_MAINTENANCE_TEST -eq '1') { Fail-OEP '測試模式不會登記排程。' 'scripts/windows/Backup-OEP.ps1' }
    $DataRoot = Root-OEP $DataRoot
    $Destination = Root-OEP $Destination
    Separate-OEP $DataRoot $Destination
    $script:failureLogRoot = $DataRoot
    if (!$PSCmdlet.ShouldProcess('OEP', '登記每日備份')) { return }
    Check-OEP '登記每日備份排程失敗。' 'scripts/windows/Backup-OEP.ps1'
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $scriptPath = Join-Path $PSScriptRoot 'Backup-OEP.ps1'
    $args = "-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -WindowStyle Hidden -File ""$scriptPath"" -DataRoot ""$DataRoot"" -Destination ""$Destination"" -KeepLast $KeepLast"
    $action = New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'pwsh.exe') -Argument $args
    $trigger = New-ScheduledTaskTrigger -Daily -At ([DateTime]::ParseExact($At, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture))
    $principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName "OEP-Backup-$sid" -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
    Write-Output '每日備份排程已登記。請保持登入，並在排程時間前停止 OEP。'
} catch {
    Report-OEPFailure '排程登記失敗'
    exit 1
}
