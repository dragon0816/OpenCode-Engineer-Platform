$helperRegistry = 'HKLM:\SOFTWARE\OEP\ExternalHelper'
$helperAccount = 'OEPExternalHelper'
$helperSentinel = '.oep-external-helper-sentinel'
$helperSentinelContent = 'OEP external helper access probe'

function Get-HelperDirectory([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if ($full -notmatch '^[a-zA-Z]:\\.+$') { throw 'A local directory is required.' }
    for ($part = $full; $part -and $part -notmatch '^[a-zA-Z]:\\$'; $part = [IO.Path]::GetDirectoryName($part)) {
        $attributes = [IO.File]::GetAttributes($part)
        if (!($attributes -band [IO.FileAttributes]::Directory) -or ($attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'A helper directory is missing or redirected.'
        }
    }
    $full
}

function Get-HelperFile([string]$Path) {
    $directory = Get-HelperDirectory ([IO.Path]::GetDirectoryName($Path))
    $file = Join-Path $directory ([IO.Path]::GetFileName($Path))
    $attributes = [IO.File]::GetAttributes($file)
    if ($attributes -band ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint)) {
        throw 'A helper file is redirected or invalid.'
    }
    $file
}

function Get-HelperInstallRoot {
    Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'OEP-ExternalHelper'
}

function New-HelperMutex($OwnerSid) {
    [Threading.Mutex]::new($false, "Global\OEP.ExternalHelper.$OwnerSid")
}

function Enter-HelperMutex($Mutex) {
    try { $Mutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $true }
}

function Initialize-HelperMaintenance {
    if (![Environment]::Is64BitProcess) { throw 'Run 64-bit Windows PowerShell as the OEP owner.' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        if (!([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole('Administrator')) {
            throw 'Run 64-bit Windows PowerShell as administrator using the OEP owner account.'
        }
        $identity.User.Value
    } finally { $identity.Dispose() }
}

function Get-HelperPolicy {
    if (Test-Path -LiteralPath $helperRegistry) { Get-ItemProperty -LiteralPath $helperRegistry }
}

function Assert-HelperOwner($Policy, $OwnerSid) {
    if ($Policy -and ($Policy.OwnerSid -ne $OwnerSid -or $Policy.InstallRoot -ne (Get-HelperInstallRoot))) {
        throw 'The helper installation belongs to a different Windows owner.'
    }
}

function Set-HelperPrivateRoot($Path, $Sid, [bool]$Install) {
    $directory = Get-HelperDirectory $Path
    $marker = Join-Path $directory $helperSentinel
    if ($Install) {
        if (![IO.File]::Exists($marker)) {
            $stream = [IO.File]::Open($marker, 'CreateNew', 'Write', 'None')
            try {
                $bytes = [Text.Encoding]::UTF8.GetBytes($helperSentinelContent)
                $stream.Write($bytes, 0, $bytes.Length)
            } finally { $stream.Dispose() }
        }
        if ([IO.File]::ReadAllText((Get-HelperFile $marker)) -cne $helperSentinelContent) {
            throw 'The reserved helper sentinel name is already in use.'
        }
    }
    $sidObject = [Security.Principal.SecurityIdentifier]::new($Sid)
    $deny = [Security.AccessControl.FileSystemAccessRule]::new($sidObject, 'FullControl', 'Deny')
    $acl = Get-Acl -LiteralPath $directory
    if ($Install) { $acl.SetAccessRule($deny) }
    else { $acl.RemoveAccessRuleSpecific($deny) }
    Set-Acl -LiteralPath $directory -AclObject $acl

    if ($Install) {
        # Give the sentinel a leaf-level read grant. Only an actual traversal denial can block this probe.
        $markerAcl = Get-Acl -LiteralPath $marker
        $markerAcl.SetAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sidObject, 'Read', 'Allow'))
        Set-Acl -LiteralPath $marker -AclObject $markerAcl
    } elseif ([IO.File]::Exists($marker) -and
        [IO.File]::ReadAllText((Get-HelperFile $marker)) -ceq $helperSentinelContent) {
        [IO.File]::Delete($marker)
    }
}

function New-HelperAccessRule($Sid, $Rights, $Inheritance = 'None', $Propagation = 'None') {
    [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($Sid),
        [Security.AccessControl.FileSystemRights]$Rights, [Security.AccessControl.InheritanceFlags]$Inheritance,
        [Security.AccessControl.PropagationFlags]$Propagation, [Security.AccessControl.AccessControlType]::Allow)
}

function Protect-HelperFolder($Path, $OwnerSid, $OwnerRights, $HelperSid, $HelperRights, $HelperInheritance = 'None') {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $inherit = 'ContainerInherit, ObjectInherit'
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new($OwnerSid))
    $acl.AddAccessRule((New-HelperAccessRule 'S-1-5-18' 'FullControl' $inherit))
    $acl.AddAccessRule((New-HelperAccessRule 'S-1-5-32-544' 'FullControl' $inherit))
    $acl.AddAccessRule((New-HelperAccessRule $OwnerSid $OwnerRights $inherit))
    if ($HelperRights) { $acl.AddAccessRule((New-HelperAccessRule $HelperSid $HelperRights $HelperInheritance)) }
    if ([IO.Directory]::Exists($Path)) { Set-Acl -LiteralPath (Get-HelperDirectory $Path) -AclObject $acl }
    else { $null = [IO.Directory]::CreateDirectory($Path, $acl) }
}

function Remove-HelperTree($Path) {
    # Delete only this entry when it is a reparse point. Never enumerate through one.
    $attributes = [IO.File]::GetAttributes($Path)
    if (!($attributes -band [IO.FileAttributes]::Directory)) { [IO.File]::Delete($Path); return }
    if (!($attributes -band [IO.FileAttributes]::ReparsePoint)) {
        foreach ($entry in [IO.Directory]::GetFileSystemEntries($Path)) { Remove-HelperTree $entry }
    }
    [IO.Directory]::Delete($Path)
}

function Get-HelperLocalUser($AccountTag, $RecordedSid) {
    $account = Get-LocalUser -Name $helperAccount -ErrorAction SilentlyContinue
    if ($account -and ($AccountTag -cnotmatch '^OEP helper [a-f0-9]{32}$' -or $account.Description -cne $AccountTag -or
        ($RecordedSid -and $account.SID.Value -ne $RecordedSid))) { throw 'The reserved local account already belongs to another installation.' }
    $account
}

function Assert-HelperGroups($Account) {
    $users = 'S-1-5-32-545'
    foreach ($group in Get-LocalGroup) {
        if ($group.SID.Value -eq $users) { continue }
        if (Get-LocalGroupMember -SID $group.SID | Where-Object { $_.SID.Value -eq $Account.SID.Value }) {
            throw 'The dedicated helper account must belong only to the local Users group.'
        }
    }
    if (!(Get-LocalGroupMember -SID $users | Where-Object { $_.SID.Value -eq $Account.SID.Value })) {
        Add-LocalGroupMember -SID $users -Member $Account
    }
}

function Invoke-HelperProvision($Policy, $Platform) {
    $account = & $Platform.FindAccount $Policy
    $rotate = !$account -or $Policy.PasswordPending -eq 1 -or !(& $Platform.HasPassword)
    & $Platform.Begin $Policy
    $sid = & $Platform.EnsureAccount $Policy $account $rotate
    foreach ($path in $Policy.Roots) { & $Platform.PrivateRoot $path $sid $true }
    & $Platform.Install $Policy $sid
    & $Platform.Complete $Policy
}

function Invoke-HelperRemoval($Policy, $Platform) {
    $account = & $Platform.FindAccount $Policy
    & $Platform.Begin $Policy
    if ($Policy.HelperSid) {
        foreach ($path in $Policy.Roots) { & $Platform.PrivateRoot $path $Policy.HelperSid $false }
        & $Platform.RemoveProfile $Policy
    }
    if ($account) { & $Platform.RemoveAccount $account }
    & $Platform.RemovePassword
    & $Platform.RemoveInstall $Policy
    & $Platform.Forget
}

function Import-HelperNative {
    Add-Type -Path @((Join-Path $PSScriptRoot '../phase0/windows-job.cs'), (Join-Path $PSScriptRoot 'external-helper-native.cs'))
}

function Install-HelperBinary($Runtime, $Providers) {
    foreach ($provider in $Providers) {
        if (!$provider.Source) { continue }
        $source = [OepHelperNative]::Pin((Get-HelperFile ([IO.Path]::GetFullPath($provider.Source))), $provider.Hash)
        $temporary = Join-Path $Runtime ([Guid]::NewGuid().ToString('N') + '.exe')
        try {
            $source.Position = 0
            $destination = [IO.File]::Open($temporary, 'CreateNew', 'Write', 'None')
            try { $source.CopyTo($destination) } finally { $destination.Dispose() }
            Move-Item -LiteralPath $temporary -Destination (Join-Path $Runtime ($provider.Id + '.exe')) -Force
            Set-ItemProperty -LiteralPath $helperRegistry -Name ($provider.Id + 'Version') -Value $provider.Version
            Set-ItemProperty -LiteralPath $helperRegistry -Name ($provider.Id + 'Hash') -Value $provider.Hash
        } finally {
            $source.Dispose()
            [IO.File]::Delete($temporary)
        }
    }
}
