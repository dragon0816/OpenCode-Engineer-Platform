Option Explicit
Dim shell, fs, script, powerShell, result
Set shell = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
script = fs.BuildPath(fs.GetParentFolderName(WScript.ScriptFullName), "Start-OEP.ps1")
powerShell = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
result = shell.Run("""" & powerShell & """ -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File """ & script & """", 0, True)
If result <> 0 Then
  MsgBox "OEP could not start or stop. See docs/validation/p2-windows-web.md and the local OEP data directory.", 16, "OpenCode Engineer Platform"
End If
WScript.Quit result
