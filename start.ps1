# =============================================================
#  動画レビュー のサーバーを起動する
#
#  -Hidden … ウィンドウを出さずに起動する（普段はこちら）
#
#  隠して動かすときは pythonw.exe を使うこと。
#  python.exe を隠しコンソールで動かすと、コンソールへの書き込みで
#  止まってしまい「TCP は繋がるのに応答しない」状態になる。
#  pythonw はコンソールを持たないのでこれが起きない。
#  画面に出るはずだった内容は data\app.log に記録される。
# =============================================================

param(
    [switch]$Hidden,
    [switch]$NoBrowser
)

Set-Location -Path $PSScriptRoot

$port = if ($env:VR_PORT) { [int]$env:VR_PORT } else { 5000 }

# 古いサーバーを確実に片付けてから始める（二重待ち受けの防止）
& "$PSScriptRoot\stop.ps1"

$scheme = if (Test-Path "$PSScriptRoot\data\cert\server.crt") { "https" } else { "http" }
$url = "{0}://localhost:{1}/" -f $scheme, $port

if (-not $Hidden) {
    Write-Host ""
    Write-Host ("  {0} で起動します" -f $url)
    Write-Host ""
    & python app.py
    exit
}

Start-Process -FilePath "pythonw" `
    -ArgumentList "app.py" `
    -WorkingDirectory $PSScriptRoot `
    -WindowStyle Hidden

# 待ち受けを始めるまで待つ（最大 20 秒）
$ready = $false

for ($i = 0; $i -lt 80; $i++) {
    Start-Sleep -Milliseconds 250
    if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
        $ready = $true
        break
    }
}

if ($ready) {
    Write-Host ("  起動しました: {0}" -f $url)
    if (-not $NoBrowser) {
        Start-Process $url
    }
}
else {
    Write-Host "  起動できませんでした。data\app.log を確認してください。"
}
