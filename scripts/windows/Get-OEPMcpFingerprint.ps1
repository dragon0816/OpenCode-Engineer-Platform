param([Parameter(Mandatory)][string]$Executable)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$stream = [IO.File]::Open($Executable, 'Open', 'Read', 'Read')
try {
    $signature = Get-AuthenticodeSignature -LiteralPath $Executable
    $certificate = $signature.SignerCertificate
    $hash = Get-FileHash -InputStream $stream -Algorithm SHA256
    @{
        sha256 = $hash.Hash.ToLowerInvariant()
        signer = if ($certificate) { $certificate.Subject } else { $null }
        thumbprint = if ($certificate) { $certificate.Thumbprint.ToLowerInvariant() } else { $null }
        signatureStatus = $signature.Status.ToString()
    } | ConvertTo-Json -Compress
} finally { $stream.Dispose() }
