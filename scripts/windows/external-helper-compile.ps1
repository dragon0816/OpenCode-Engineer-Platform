param([Parameter(Mandatory)][string]$Target)
$ErrorActionPreference = 'Stop'
Add-Type -Path @((Join-Path $PSScriptRoot '../phase0/windows-job.cs'), (Join-Path $PSScriptRoot 'external-helper-native.cs')) `
    -OutputAssembly $Target -OutputType ConsoleApplication
