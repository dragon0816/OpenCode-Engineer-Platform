param([ValidateSet('contract', 'contract-relay', 'gateway', 'gateway-capabilities')] [string] $Mode = 'contract')
$ErrorActionPreference = 'Stop'
$pin = Get-Content -Raw config/opencode.pin.json | ConvertFrom-Json
$binary = (Get-FileHash -Algorithm SHA256 .phase0/assets/linux/opencode).Hash
if ($binary -ne $pin.supplementalLinuxX64.binarySha256) { throw 'Binary validation failed.' }
$network = 'none'
$inputData = '{}'
if ($Mode -in 'gateway', 'gateway-capabilities') {
    $network = 'bridge'
    $values = @{}
    foreach ($name in 'OEP_LITELLM_BASE_URL','OEP_LITELLM_API_KEY') {
        $value = [Environment]::GetEnvironmentVariable($name, 'Process')
        if ([string]::IsNullOrWhiteSpace($value)) { $value = [Environment]::GetEnvironmentVariable($name, 'User') }
        if ([string]::IsNullOrWhiteSpace($value)) { throw 'Required gateway variable is missing.' }
        $values[$name] = $value
    }
    $inputData = $values | ConvertTo-Json -Compress
}
$podmanArgs = @('run', '--rm', '-i', '--pull=never', '--network', $network, '--cap-drop', 'all',
    '--security-opt', 'no-new-privileges', '--read-only', '--user', '1000:1000', '--pids-limit', '128',
    '--tmpfs', '/tmp:rw,nosuid,nodev,mode=1777', '--workdir', '/work', '-v', "${PWD}:/work:ro",
    $pin.supplementalLinuxX64.nodeImage, 'node', '--disable-warning=ExperimentalWarning', 'scripts/phase0/opencode-probe.ts', $Mode)
$inputData | podman @podmanArgs
exit $LASTEXITCODE
