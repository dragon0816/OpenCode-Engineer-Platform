$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'external-helper-setup.ps1')
$owner = Initialize-HelperMaintenance
$mutex = New-HelperMutex $owner
$held = $false
try {
    $held = Enter-HelperMutex $mutex
    if (!$held) { throw 'An external helper operation is in progress. Retry when it finishes.' }
    $policy = Get-HelperPolicy
    Assert-HelperOwner $policy $owner
    if (!$policy) { Write-Output 'External helper isolation is already absent.'; return }
    $policy | Add-Member -NotePropertyName Roots -NotePropertyValue @(@($policy.OwnerProfile, $policy.DefaultRoot, $policy.DataRoot) | Select-Object -Unique)
    Import-HelperNative
    $platform = @{
        FindAccount = { param($policy) Get-HelperLocalUser $policy.AccountTag $policy.HelperSid }
        Begin = { Set-ItemProperty -LiteralPath $helperRegistry -Name Ready -Value 0 }
        PrivateRoot = {
            param($path, $sid, $install)
            if ([IO.Directory]::Exists($path)) { Set-HelperPrivateRoot $path $sid $install }
        }
        RemoveProfile = {
            param($policy)
            if ($policy.HelperProfile) {
                [OepHelperNative]::RemoveProfile($policy.HelperSid, $policy.HelperProfile)
            }
        }
        RemoveAccount = { param($account) Remove-LocalUser -SID $account.SID }
        RemovePassword = { [OepHelperNative]::DeleteCredential([OepHelperNative]::LaunchCredential) }
        RemoveInstall = {
            param($policy)
            if ([IO.Directory]::Exists($policy.InstallRoot)) { Remove-HelperTree (Get-HelperDirectory $policy.InstallRoot) }
        }
        Forget = { Remove-Item -LiteralPath $helperRegistry }
    }
    Invoke-HelperRemoval $policy $platform
    Write-Output 'External helper account, credentials, working copies and isolation settings were removed.'
} finally {
    if ($held) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
