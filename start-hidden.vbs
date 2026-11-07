Option Explicit

Dim shell, fileSystem, appDirectory, electronExecutable
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

appDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
electronExecutable = fileSystem.BuildPath(appDirectory, "node_modules\electron\dist\electron.exe")

If Not fileSystem.FileExists(electronExecutable) Then
    MsgBox "Electron non trovato. Installa le dipendenze del progetto e riprova.", vbCritical, "ShadowStream"
    WScript.Quit 1
End If

shell.CurrentDirectory = appDirectory
shell.Run """" & electronExecutable & """ .", 0, False
