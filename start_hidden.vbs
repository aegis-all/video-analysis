' ============================================================
'  動画レビュー を「ウィンドウを出さずに」起動する
'
'  ダブルクリックするとサーバーが動き始め、ブラウザが開きます。
'  止めるときは stop.bat をダブルクリックしてください。
'
'  pythonw をここから直接起動していることには理由がある。
'  間に PowerShell や cmd を挟むと、その中継役が終わった時点で
'  借りていたコンソールごと消え、サーバーが応答しなくなる。
' ============================================================

Dim shell, fso, here, scheme, url, wait

Set shell = CreateObject("WScript.Shell")
Set fso   = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)

' 古いサーバーを片付けてから（終わるまで待つ）
shell.Run "powershell -NoProfile -ExecutionPolicy Bypass -File """ & here & "\stop.ps1""", 0, True

' 起動（app.py を相対で渡すので、作業フォルダを合わせておく）
shell.CurrentDirectory = here
shell.Run "pythonw app.py", 0, False

' 証明書があれば https
If fso.FileExists(here & "\data\cert\server.crt") Then
    scheme = "https"
Else
    scheme = "http"
End If

url = scheme & "://localhost:5000/"

' 待ち受けが始まってからブラウザを開く（最大30秒待つ）
wait = "for($i=0;$i -lt 120;$i++){" & _
       "if(Get-NetTCPConnection -State Listen -LocalPort 5000 -EA SilentlyContinue){break};" & _
       "Start-Sleep -Milliseconds 250};" & _
       "Start-Process '" & url & "'"

shell.Run "powershell -NoProfile -ExecutionPolicy Bypass -Command """ & wait & """", 0, False
