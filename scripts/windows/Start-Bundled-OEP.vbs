Option Explicit
Dim shell, fso, root, env, quote
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)))
Set env = shell.Environment("PROCESS")
If WScript.Arguments.Count > 0 Then env("OEP_DATA_DIR") = WScript.Arguments(0)
env("OEP_PYTHON") = root & "\vendor\python\python.exe"
shell.CurrentDirectory = root
quote = Chr(34)
shell.Run quote & root & "\vendor\node\node.exe" & quote & " --disable-warning=ExperimentalWarning " & quote & root & "\apps\launcher\src\web.ts" & quote, 0, False
