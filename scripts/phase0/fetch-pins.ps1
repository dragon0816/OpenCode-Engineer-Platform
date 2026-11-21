param([switch]$WindowsOnly)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$pin = Get-Content -Raw config/opencode.pin.json | ConvertFrom-Json
$release = "https://github.com/anomalyco/opencode/releases/download/$($pin.tag)"
$metadata = Invoke-RestMethod "https://api.github.com/repos/anomalyco/opencode/releases/tags/$($pin.tag)"
$tag = git ls-remote https://github.com/anomalyco/opencode.git "refs/tags/$($pin.tag)"
if ($LASTEXITCODE -or $tag -notmatch "^$($pin.commit)\s" -or !$metadata.immutable) { throw 'Release identity mismatch.' }
New-Item -ItemType Directory -Force .phase0/assets, .phase0/source | Out-Null

function Confirm-Sha256($Path, $Expected) {
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
    if ($actual -cne $Expected) { throw 'Pinned hash mismatch.' }
    $actual
}

function Save-Asset($Spec, $Path) {
    $asset = @($metadata.assets | Where-Object name -eq $Spec.asset)
    if ($asset.Count -ne 1 -or $asset[0].digest -cne "sha256:$($Spec.sha256)") { throw 'Release digest mismatch.' }
    if (!(Test-Path -LiteralPath $Path)) { Invoke-WebRequest "$release/$($Spec.asset)" -OutFile $Path }
    Confirm-Sha256 $Path $Spec.sha256
}

Save-Asset $pin.windowsX64 .phase0/assets/windows.zip
$windowsExe = '.phase0/assets/unpacked/opencode.exe'
if (!(Test-Path -LiteralPath $windowsExe)) {
    Expand-Archive -LiteralPath .phase0/assets/windows.zip -DestinationPath .phase0/assets/unpacked -Force
}
Confirm-Sha256 .phase0/assets/unpacked/opencode.exe $pin.windowsX64.binarySha256
if (!$WindowsOnly) {
    New-Item -ItemType Directory -Force .phase0/assets/linux | Out-Null
    Save-Asset $pin.supplementalLinuxX64 .phase0/assets/linux.tar.gz
    tar -xf .phase0/assets/linux.tar.gz -C .phase0/assets/linux
    if ($LASTEXITCODE) { throw 'Linux asset extraction failed.' }
    Confirm-Sha256 .phase0/assets/linux/opencode $pin.supplementalLinuxX64.binarySha256
}

$root = "https://api.github.com/repos/anomalyco/opencode"
$tree = Invoke-RestMethod "$root/git/trees/$($pin.commit)?recursive=1"
$spec = @($tree.tree | Where-Object path -eq $pin.openapi.path)
if ($spec.Count -ne 1 -or $spec[0].sha -cne $pin.openapi.gitBlob) { throw 'OpenAPI blob mismatch.' }
$blob = Invoke-RestMethod "$root/git/blobs/$($pin.openapi.gitBlob)"
[IO.File]::WriteAllBytes((Join-Path $PWD '.phase0/source/openapi.json'), [Convert]::FromBase64String($blob.content))
Confirm-Sha256 .phase0/source/openapi.json $pin.openapi.sha256
$client = (Get-Content -Raw package-lock.json | ConvertFrom-Json -AsHashtable).packages.'node_modules/@opencode/client'
if ($client.version -cne $pin.client.version -or $client.integrity -cne $pin.client.integrity) { throw 'Client lock mismatch.' }
'@opencode/client 2.3.2 integrity matches'
