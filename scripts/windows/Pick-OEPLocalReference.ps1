param(
    [ValidateSet('file', 'folder')][string]$Kind,
    [ValidateSet('en', 'zh-TW')][string]$Locale
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

$owner = [Windows.Forms.Form]::new()
$owner.StartPosition = 'CenterScreen'
$owner.Size = [Drawing.Size]::new(1, 1)
$owner.FormBorderStyle = 'None'
$owner.ShowInTaskbar = $false
$owner.TopMost = $true
$owner.Opacity = 0
$dialog = $null
try {
    if ($Kind -eq 'file') {
        $dialog = [Windows.Forms.OpenFileDialog]::new()
        $dialog.Title = if ($Locale -eq 'en') { 'Attach local files to OEP' } else { -join ([char[]]@(38468,21152,26412,27231,27284,26696)) }
        $dialog.Multiselect = $true
        $dialog.CheckFileExists = $true
        $dialog.RestoreDirectory = $true
    } else {
        $dialog = [Windows.Forms.FolderBrowserDialog]::new()
        $dialog.Description = if ($Locale -eq 'en') { 'Attach a read-only folder to OEP' } else { -join ([char[]]@(38468,21152,21807,35712,36039,26009,22846)) }
        $dialog.ShowNewFolderButton = $false
    }
    $owner.Show()
    $owner.Activate()
    [Windows.Forms.Application]::DoEvents()
    [string[]]$paths = @()
    if ($dialog.ShowDialog($owner) -eq [Windows.Forms.DialogResult]::OK) {
        if ($Kind -eq 'file') { $paths = $dialog.FileNames }
        else { $paths = @($dialog.SelectedPath) }
    }
    ConvertTo-Json -InputObject $paths -Compress
} finally {
    if ($dialog) { $dialog.Dispose() }
    $owner.Dispose()
}
