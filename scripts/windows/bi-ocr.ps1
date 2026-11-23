param([ValidateSet('auto', 'en-US', 'zh-Hant-TW', 'probe')][string]$Language = 'auto')

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Write-Result($Value) {
    [Console]::WriteLine((ConvertTo-Json -InputObject $Value -Depth 6 -Compress))
}

try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $ocr = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
    $languages = @($ocr::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
} catch {
    Write-Result @{ error = 'unavailable' }
    exit 0
}

if ($Language -eq 'probe') {
    Write-Result @{ languages = $languages }
    exit 0
}

$targets = if ($Language -eq 'auto') { @('en-US', 'zh-Hant-TW') } else { @($Language) }
$targets = @($targets | Where-Object { $languages -contains $_ })
if (!$targets.Count) {
    Write-Result @{ error = 'unavailable' }
    exit 0
}

try {
    $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Length -eq 1 -and
        $_.GetParameters().Length -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
    function Await($Operation, [Type]$Result) {
        $task = $asTask.MakeGenericMethod($Result).Invoke($null, @($Operation))
        $task.GetAwaiter().GetResult()
    }

    $decoderType = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]
    $bitmapType = [Windows.Graphics.Imaging.SoftwareBitmap,Windows.Foundation,ContentType=WindowsRuntime]
    $languageType = [Windows.Globalization.Language,Windows.Foundation,ContentType=WindowsRuntime]
    $transformType = [Windows.Graphics.Imaging.BitmapTransform,Windows.Foundation,ContentType=WindowsRuntime]
    $resultType = [Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime]

    $bytes = [IO.MemoryStream]::new()
    $inputStream = [Console]::OpenStandardInput()
    $inputStream.CopyTo($bytes)
    if (!$bytes.Length -or $bytes.Length -gt 10MB) { throw 'Image size' }
    $bytes.Position = 0
    $stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($bytes)
    $decoder = Await ($decoderType::CreateAsync($stream)) $decoderType
    if ([double]$decoder.PixelWidth * $decoder.PixelHeight -gt 50MB) { throw 'Image dimensions' }
    $maxDimension = [Math]::Min(2600, $ocr::MaxImageDimension)
    $scale = [Math]::Min(1.0, $maxDimension / [double][Math]::Max($decoder.PixelWidth, $decoder.PixelHeight))
    $transform = $transformType::new()
    $transform.ScaledWidth = [uint32][Math]::Max(1, [Math]::Floor($decoder.PixelWidth * $scale))
    $transform.ScaledHeight = [uint32][Math]::Max(1, [Math]::Floor($decoder.PixelHeight * $scale))
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync('Bgra8', 'Ignore', $transform, 'RespectExifOrientation', 'DoNotColorManage')) $bitmapType

    $results = @(foreach ($tag in $targets) {
        $engine = $ocr::TryCreateFromLanguage($languageType::new($tag))
        if (!$engine) { continue }
        $result = Await ($engine.RecognizeAsync($bitmap)) $resultType
        $lines = @(foreach ($line in $result.Lines) {
            $left = $top = [double]::PositiveInfinity
            $right = $bottom = 0
            foreach ($word in $line.Words) {
                $rect = $word.BoundingRect
                $left = [Math]::Min($left, $rect.X)
                $top = [Math]::Min($top, $rect.Y)
                $right = [Math]::Max($right, $rect.X + $rect.Width)
                $bottom = [Math]::Max($bottom, $rect.Y + $rect.Height)
            }
            if ($right -gt $left -and $bottom -gt $top) {
                @{ text = $line.Text; box = @($left, $top, ($right - $left), ($bottom - $top)) }
            }
        })
        @{ language = $tag; width = $bitmap.PixelWidth; height = $bitmap.PixelHeight; lines = $lines }
    })
    Write-Result @{ results = $results }
} catch {
    Write-Result @{ error = 'failed' }
} finally {
    if ($bitmap) { $bitmap.Dispose() }
    if ($stream) { $stream.Dispose() }
    if ($bytes) { $bytes.Dispose() }
}
