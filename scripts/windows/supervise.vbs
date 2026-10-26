' Codex Router supervisor.
' Keeps the bridge process alive without a console window.
' Stops when paused.flag exists next to the install directory.
Option Explicit

Dim fso, sh, base, node, router, cmd, logDir
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

base = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
node = Trim(fso.OpenTextFile(base & "\node-path.txt", 1).ReadAll())
router = base & "\codex-router.mjs"
logDir = base & "\logs"

If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)

Do
    If fso.FileExists(base & "\paused.flag") Then WScript.Quit
    If Not fso.FileExists(router) Then WScript.Quit

    cmd = """" & node & """ """ & router & """"
    sh.CurrentDirectory = base
    sh.Run cmd, 0, True

    WScript.Sleep 3000
Loop
