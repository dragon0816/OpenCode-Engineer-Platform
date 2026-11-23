param(
    [string]$DataRoot = (Join-Path $env:LOCALAPPDATA 'OEP'),
    [string]$CodexExe,
    [string]$CodexVersion,
    [string]$CodexSha256,
    [string]$ClaudeExe,
    [string]$ClaudeVersion,
    [string]$ClaudeSha256
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'external-helper-setup.ps1')
$owner = Initialize-HelperMaintenance
$mutex = New-HelperMutex $owner
$held = $false
try {
    $held = Enter-HelperMutex $mutex
    if (!$held) { throw 'An external helper operation is in progress. Retry when it finishes.' }
    $previous = Get-HelperPolicy
    Assert-HelperOwner $previous $owner
    $profile = Get-HelperDirectory ([Environment]::GetFolderPath('UserProfile'))
    $default = Get-HelperDirectory (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'OEP')
    $data = Get-HelperDirectory $DataRoot
    if (!$default.StartsWith("$profile\", [StringComparison]::OrdinalIgnoreCase) -or
        !$data.StartsWith("$profile\", [StringComparison]::OrdinalIgnoreCase)) { throw 'Use OEP data directories inside the owner profile.' }
    if ($previous -and ($previous.DataRoot -ne $data -or $previous.OwnerProfile -ne $profile -or $previous.DefaultRoot -ne $default)) {
        throw 'The owner or data directory changed. Uninstall the previous isolation setup first.'
    }
    $providers = @(
        @{ Id = 'codex_cli'; Source = $CodexExe; Version = $CodexVersion; Hash = $CodexSha256 },
        @{ Id = 'claude_code'; Source = $ClaudeExe; Version = $ClaudeVersion; Hash = $ClaudeSha256 }
    )
    foreach ($provider in $providers) {
        if (($provider.Source -or $provider.Version -or $provider.Hash) -and
            (!([IO.Path]::IsPathRooted($provider.Source)) -or $provider.Source -notmatch '\.exe$' -or
            $provider.Version -notmatch '^\d{1,5}\.\d{1,5}\.\d{1,5}$' -or $provider.Hash -cnotmatch '^[a-f0-9]{64}$')) {
            throw 'Provide an absolute standalone executable path, exact version, and lowercase SHA-256 for each configured provider.'
        }
    }
    $root = Get-HelperInstallRoot
    $null = Get-HelperDirectory ([IO.Path]::GetDirectoryName($root))
    if (!$previous -and (Test-Path -LiteralPath $root)) { throw 'The reserved helper directory already exists.' }
    $tag = if ($previous.AccountTag) { $previous.AccountTag } else { 'OEP helper ' + [Guid]::NewGuid().ToString('N') }
    $policy = @{
        OwnerSid = $owner; OwnerProfile = $profile; DefaultRoot = $default; DataRoot = $data; InstallRoot = $root
        Roots = @(@($profile, $default, $data) | Select-Object -Unique)
        AccountTag = $tag; PasswordPending = $previous.PasswordPending; HelperSid = $previous.HelperSid
    }
    Import-HelperNative
    $platform = @{
        FindAccount = {
            param($policy)
            $account = Get-HelperLocalUser $policy.AccountTag $policy.HelperSid
            if (!$account -and $policy.HelperSid) { throw 'The dedicated account was removed. Uninstall the old setup before reinstalling.' }
            $account
        }
        HasPassword = { [OepHelperNative]::HasCredential([OepHelperNative]::LaunchCredential) }
        Begin = {
            param($policy)
            if (!(Test-Path -LiteralPath $helperRegistry)) { $null = New-Item -Path $helperRegistry -Force }
            Set-ItemProperty -LiteralPath $helperRegistry -Name Ready -Value 0
            foreach ($key in @('OwnerSid', 'OwnerProfile', 'DefaultRoot', 'DataRoot', 'InstallRoot', 'AccountTag')) {
                Set-ItemProperty -LiteralPath $helperRegistry -Name $key -Value $policy[$key]
            }
        }
        EnsureAccount = {
            param($policy, $account, $rotate)
            if ($account) { Assert-HelperGroups $account }
            if ($rotate) {
                Set-ItemProperty -LiteralPath $helperRegistry -Name PasswordPending -Value 1
                $password = [OepHelperNative]::ProvisionPassword()
                try {
                    if ($account) { Set-LocalUser -SID $account.SID -Password $password -PasswordNeverExpires $true }
                    else {
                        $account = New-LocalUser -Name $helperAccount -Description $policy.AccountTag `
                            -Password $password -PasswordNeverExpires -UserMayNotChangePassword
                    }
                } finally { $password.Dispose() }
                Set-ItemProperty -LiteralPath $helperRegistry -Name PasswordPending -Value 0
            }
            Set-ItemProperty -LiteralPath $helperRegistry -Name HelperSid -Value $account.SID.Value
            Assert-HelperGroups $account
            if (!$account.Enabled) { Enable-LocalUser -SID $account.SID }
            $helperProfile = Get-HelperDirectory ([OepHelperNative]::EnsureProfile($account.SID.Value))
            Set-ItemProperty -LiteralPath $helperRegistry -Name HelperProfile -Value $helperProfile
            $account.SID.Value
        }
        PrivateRoot = { param($path, $sid, $install) Set-HelperPrivateRoot $path $sid $install }
        Install = {
            param($policy, $sid)
            $runtime = Join-Path $policy.InstallRoot 'runtime'
            $runs = Join-Path $policy.InstallRoot 'runs'
            Protect-HelperFolder $policy.InstallRoot $policy.OwnerSid 'ReadAndExecute' $sid 'Traverse'
            Protect-HelperFolder $runtime $policy.OwnerSid 'ReadAndExecute' $sid 'ReadAndExecute' 'ContainerInherit, ObjectInherit'
            Protect-HelperFolder $runs $policy.OwnerSid 'FullControl' $sid 'Traverse'
            $temporary = Join-Path $runtime ([Guid]::NewGuid().ToString('N') + '.exe')
            try {
                # Use a fresh compilation process because the maintenance session already loaded the same types.
                $compiler = Join-Path $PSScriptRoot 'external-helper-compile.ps1'
                & (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoProfile -NonInteractive `
                    -File $compiler -Target $temporary
                if ($LASTEXITCODE -ne 0) { throw 'Could not compile the helper launcher.' }
                Move-Item -LiteralPath $temporary -Destination (Join-Path $runtime 'helper.exe') -Force
            } finally { [IO.File]::Delete($temporary) }
            Install-HelperBinary $runtime $providers
        }
        Complete = { Set-ItemProperty -LiteralPath $helperRegistry -Name Ready -Value 1 }
    }
    Invoke-HelperProvision $policy $platform
    Write-Output 'External helper setup saved. In OEP, open External Helpers and check status before signing in.'
} finally {
    if ($held) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
