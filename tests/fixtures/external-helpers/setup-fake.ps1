$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../../scripts/windows/external-helper-setup.ps1')
Import-HelperNative

function Assert-That($Condition, $Message) {
    if (!$Condition) { throw $Message }
}

$state = @{ account = $false; password = $false; rotations = 0; denies = @{}; installed = $false; failure = $false }
$policy = @{ OwnerSid = 'owner'; Ready = 0; Roots = @('profile', 'default-data', 'custom-data') }
$platform = @{
    FindAccount = { if ($state.account) { 'synthetic-account' } }
    HasPassword = { $state.password }
    Begin = { param($target) $target.Ready = 0 }
    EnsureAccount = {
        param($target, $account, $rotate)
        Assert-That ($state.account -eq [bool]$account) 'An existing account must be retained.'
        if ($rotate) { $state.rotations++; $state.password = $true; $target.PasswordPending = 0 }
        $state.account = $true
        $target.HelperSid = 'helper'
        $target.HelperSid
    }
    PrivateRoot = {
        param($path, $sid, $install)
        Assert-That ($sid -eq 'helper') 'ACL operation must target the helper identity.'
        if ($install) { $state.denies[$path] = $sid }
        else { $state.denies.Remove($path) }
    }
    Install = {
        if ($state.failure) { throw 'Synthetic install failure' }
        $state.installed = $true
    }
    Complete = { param($target) $target.Ready = 1 }
    RemoveProfile = { Assert-That (!$policy.Ready) 'Disable launch before removing the profile.' }
    RemoveAccount = { $state.account = $false }
    RemovePassword = { $state.password = $false }
    RemoveInstall = { $state.installed = $false }
    Forget = { $policy.HelperSid = $null }
}
Invoke-HelperProvision $policy $platform
Assert-That ($state.account -and $state.password -and $state.installed -and $state.denies.Count -eq 3 -and $policy.Ready) 'Initial provision was incomplete.'
Invoke-HelperProvision $policy $platform
Assert-That ($state.rotations -eq 1 -and $state.denies.Count -eq 3 -and $policy.Ready) 'Repeat setup changed the password or duplicated ACL entries.'
$state.failure = $true
try { Invoke-HelperProvision $policy $platform; throw 'Expected a setup failure.' }
catch { Assert-That ($_.Exception.Message -eq 'Synthetic install failure') 'Setup returned the wrong error.' }
Assert-That (!$policy.Ready) 'Interrupted setup must remain unavailable.'
$state.failure = $false
Invoke-HelperProvision $policy $platform
Assert-That ($policy.Ready -and $state.rotations -eq 1) 'Repair must preserve valid provider credential storage.'
$policy.PasswordPending = 1
Invoke-HelperProvision $policy $platform
Assert-That ($policy.Ready -and $state.rotations -eq 2) 'An interrupted password change must be repaired.'
Invoke-HelperRemoval $policy $platform
Invoke-HelperRemoval $policy $platform
Assert-That (!$state.account -and !$state.password -and !$state.installed -and !$state.denies.Count -and !$policy.Ready) 'Removal left managed state.'

$probe = @{ stripped = $false; writes = 0; roots = @(); denial = $true; writeFailure = $false }
$strip = [Action] { $probe.stripped = $true }
$deny = [Func[string,bool]] {
    param($root)
    Assert-That $probe.stripped 'Traverse privilege must be stripped before access checks.'
    $probe.roots += $root
    $probe.denial
}
$write = [Action] {
    if ($probe.writeFailure) { throw 'Synthetic unwritable copy' }
    $probe.writes++
}
[OepHelperNative]::VerifyAccess('helper', 'helper', $false, [string[]]$policy.Roots, $strip, $deny, $write)
Assert-That (($probe.roots -join ',') -eq 'profile,default-data,custom-data' -and $probe.writes -eq 1) 'All private roots and copy access must be verified.'
foreach ($invalid in @(
    @{ sid = ''; admin = $false; deny = $true },
    @{ sid = 'other'; admin = $false; deny = $true },
    @{ sid = 'helper'; admin = $true; deny = $true },
    @{ sid = 'helper'; admin = $false; deny = $false },
    @{ sid = 'helper'; admin = $false; deny = $true; writeFailure = $true }
)) {
    $probe.denial = $invalid.deny
    $probe.writeFailure = $invalid.writeFailure
    $rejected = $false
    try { [OepHelperNative]::VerifyAccess('helper', $invalid.sid, $invalid.admin, [string[]]$policy.Roots, $strip, $deny, $write) }
    catch { $rejected = $true }
    Assert-That ($rejected -and $probe.writes -eq 1) 'An invalid identity, readable private folder, or unwritable copy passed verification.'
}
Write-Output 'Synthetic setup, repair, removal and verification passed.'
