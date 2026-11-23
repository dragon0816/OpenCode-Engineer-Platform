$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'external-helper-setup.ps1')
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false, $true)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false, $true)

function Grant-HelperWork($Work, $Scratch, $Inputs, $Policy) {
    $inherit = 'ContainerInherit, ObjectInherit'
    if ($Inputs) {
        Protect-HelperFolder $Inputs $Policy.OwnerSid 'FullControl' $Policy.HelperSid 'ReadAndExecute' $inherit
    }
    foreach ($folder in @($Work, $Scratch)) {
        $acl = Get-Acl -LiteralPath $folder
        $acl.AddAccessRule((New-HelperAccessRule $Policy.HelperSid 'ReadAndExecute, Write'))
        $acl.AddAccessRule((New-HelperAccessRule $Policy.HelperSid 'Modify' $inherit 'InheritOnly'))
        Set-Acl -LiteralPath $folder -AclObject $acl
    }
}

function Set-HelperRunTraverse($Run, $Policy, [bool]$Grant) {
    $folder = Get-HelperDirectory $Run
    $rule = New-HelperAccessRule $Policy.HelperSid 'Traverse'
    $acl = Get-Acl -LiteralPath $folder
    if ($Grant) { $acl.SetAccessRule($rule) }
    else { $acl.RemoveAccessRuleSpecific($rule) }
    Set-Acl -LiteralPath $folder -AclObject $acl
}

function Get-HelperEnvironment($Policy, $Runtime, $Scratch, $Provider) {
    $windows = [Environment]::GetFolderPath('Windows')
    $profile = $Policy.HelperProfile
    $paths = [ordered]@{
        APPDATA = Join-Path $profile 'AppData\Roaming'
        LOCALAPPDATA = Join-Path $profile 'AppData\Local'
        PATH = "$Runtime;$(Join-Path $windows 'System32')"
        SystemRoot = $windows
        TEMP = $Scratch
        TMP = $Scratch
        USERPROFILE = $profile
        WINDIR = $windows
    }
    if ($Provider -eq 'codex_cli') { $paths.CODEX_HOME = Join-Path $profile '.codex' }
    if ($Provider -eq 'claude_code') {
        $paths.CLAUDE_CONFIG_DIR = Join-Path $profile '.claude'
        $paths.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    }
    foreach ($value in $paths.Values) {
        if ($value -match '[\x00-\x1f]' -or ($value.Contains(';') -and $value -ne $paths.PATH)) {
            throw 'Invalid helper environment.'
        }
    }
    (($paths.GetEnumerator() | Sort-Object Key | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join "`0") + "`0`0"
}

function Clear-HelperRun($Runs, $Marker, $Policy) {
    if (![IO.File]::Exists($Marker)) { return }
    $id = [IO.File]::ReadAllText((Get-HelperFile $Marker))
    if ($id -cnotmatch '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$') { throw 'Invalid active helper copy.' }
    $run = Join-Path $Runs $id
    if ([IO.Directory]::Exists($run)) { Set-HelperRunTraverse $run $Policy $false }
    [IO.File]::Delete($Marker)
}

function Get-HelperProvider($Request, $Policy, $Runtime) {
    $provider = $Request.provider
    if ($provider -cnotin @('codex_cli', 'claude_code')) { throw 'Invalid helper provider.' }
    $version = $Policy.("${provider}Version")
    $hash = $Policy.("${provider}Hash")
    if (!$version -and !$hash) { return @{ installation = 'missing' } }
    if ($version -cnotmatch '^\d{1,5}\.\d{1,5}\.\d{1,5}$' -or $hash -cnotmatch '^[a-f0-9]{64}$') {
        return @{ installation = 'unsupported' }
    }
    try {
        $binary = [OepHelperNative]::Pin((Get-HelperFile (Join-Path $Runtime "$provider.exe")), $hash)
        return @{ pin = @{ version = $version; sha256 = $hash }; binary = $binary }
    } catch { return @{ installation = 'unsupported' } }
}

function Invoke-HelperJob($Request, $Policy) {
    $root = Get-HelperDirectory $Policy.InstallRoot
    $runtime = Get-HelperDirectory (Join-Path $root 'runtime')
    $runs = Get-HelperDirectory (Join-Path $root 'runs')
    foreach ($path in (@($Policy.OwnerProfile, $Policy.DefaultRoot, $Policy.DataRoot) | Select-Object -Unique)) {
        if ([IO.File]::ReadAllText((Get-HelperFile (Join-Path $path $helperSentinel))) -cne $helperSentinelContent) {
            throw 'Missing helper access probe.'
        }
    }
    $null = Get-HelperDirectory $Policy.HelperProfile
    $marker = Join-Path $runs 'active-copy'
    Clear-HelperRun $runs $marker $Policy
    $bootstrap = Get-HelperFile (Join-Path $runtime 'helper.exe')
    $timeout = 8000
    $mode = 'headless'
    $provider = Get-HelperProvider $Request $Policy $runtime
    try {
        if ($Request.operation -eq 'inspect') {
            $id = [Guid]::NewGuid().ToString()
            $argsForChild = @('verify')
        } else {
            if (!$provider.pin -or $provider.pin.version -cne $Request.pin.version -or $provider.pin.sha256 -cne $Request.pin.sha256) {
                throw 'Helper executable pin changed.'
            }
            switch -CaseSensitive ($Request.operation) {
                'run' { $timeout = 600000 }
                'cli' { $timeout = 170000; $mode = 'interactive' }
                'key' { }
                'logout' { }
                'status' { }
                'version' { }
                default { throw 'Invalid helper operation.' }
            }
            $id = if ($Request.operation -eq 'run') { $Request.runId } else { [Guid]::NewGuid().ToString() }
            $argsForChild = @($mode, $Request.provider, $Request.operation) + @($Request.arguments)
        }
        if ($id -cnotmatch '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$') { throw 'Invalid helper copy identifier.' }
        $run = Join-Path $runs $id
        $work = Join-Path $run 'work'
        $scratch = Join-Path $run 'scratch'
        $inputs = $null
        $temporary = $Request.operation -ne 'run'
        if ($temporary) {
            $null = New-Item -ItemType Directory -Path $run
            $null = New-Item -ItemType Directory -Path $work, $scratch
        } else {
            $inputs = Get-HelperDirectory (Join-Path $work 'oep-inputs')
        }
        try {
            $work = Get-HelperDirectory $work
            $scratch = Get-HelperDirectory $scratch
            Grant-HelperWork $work $scratch $inputs $Policy
            [IO.File]::WriteAllText($marker, $id, [Text.UTF8Encoding]::new($false))
            Set-HelperRunTraverse $run $Policy $true
            $environment = Get-HelperEnvironment $Policy $runtime $scratch $Request.provider
            $result = [OepHelperNative]::Run($bootstrap, [string[]]$argsForChild, $work, $environment, [string]$Request.input,
                ($mode -eq 'interactive'), ($Request.operation -eq 'run'), [int]$Request.owner, $timeout)
        } finally {
            Clear-HelperRun $runs $marker $Policy
            if ($temporary -and [IO.Directory]::Exists($run)) { Remove-HelperTree (Get-HelperDirectory $run) }
        }
        if ($Request.operation -eq 'inspect') {
            if ($result.exit -ne 0 -or $result.orphans -ne 0 -or $result.reason) { throw 'Helper access probe failed.' }
            if ($provider.pin) { return @{ isolation = 'verified'; pin = $provider.pin; copyRoot = $runs } }
            return @{ isolation = 'verified'; installation = $provider.installation }
        }
        $result
    } finally { if ($provider.binary) { $provider.binary.Dispose() } }
}

$held = $false
$mutex = $null
try {
    $request = [Console]::ReadLine() | ConvertFrom-Json
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $mutex = New-HelperMutex $sid
    $held = Enter-HelperMutex $mutex
    if (!$held) { exit 1 }
    $policy = Get-HelperPolicy
    Assert-HelperOwner $policy $sid
    if (!$policy -or $policy.Ready -ne 1 -or $policy.DataRoot -ne (Get-HelperDirectory $request.dataRoot)) { exit 1 }
    Import-HelperNative
    $result = Invoke-HelperJob $request $policy
    [Console]::WriteLine(($result | ConvertTo-Json -Depth 5 -Compress))
} catch {
    # Do not emit PowerShell error records, request fields, inherited environment, or provider output.
    exit 1
} finally {
    if ($held) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
