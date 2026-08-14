Option Explicit

Dim shell, fso, projectRoot, scriptPath, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

projectRoot = fso.GetParentFolderName(WScript.ScriptFullName)
scriptPath = fso.BuildPath(projectRoot, "deploy\linux\deploy-ecs-one-click.ps1")
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptPath & """"

shell.Run command, 0, False
