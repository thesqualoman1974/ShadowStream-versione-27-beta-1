Option Explicit

Dim shell, fileSystem, clientDirectory, nodeExecutable
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

clientDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
nodeExecutable = shell.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe")

If Not fileSystem.FileExists(nodeExecutable) Then
    nodeExecutable = "node.exe"
End If

shell.CurrentDirectory = clientDirectory
shell.Run """" & nodeExecutable & """ """ & fileSystem.BuildPath(clientDirectory, "dev.js") & """", 0, False
