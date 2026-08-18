# =============================================================
#  動画レビュー のサーバーを止める
#
#  止め残しがあると、Windows は SO_REUSEADDR で同じポートに
#  二重 bind できてしまうため、古い方のソケットへ接続が吸われて
#  「TCP は繋がるのに応答しない」状態になる。
#  そのため
#    ・ポートを持っているプロセス
#    ・app.py / serve.py を動かしている python / pythonw
#  の両方から止め、ポートが本当に空くまで待つ。
# =============================================================

$port = if ($env:VR_PORT) { [int]$env:VR_PORT } else { 5000 }

$targets = @{}

# 1) ポートを掴んでいるプロセス
Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
    ForEach-Object { $targets[[int]$_.OwningProcess] = $true }

# 2) app.py / serve.py を動かしている python 系
#    （Python Manager 経由だと中継のプロセスも挟まるので、両方拾う）
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
        $_.Name -match '^python(w)?\.exe$' -and
        ($_.CommandLine -like '*app.py*' -or $_.CommandLine -like '*serve.py*')
    } |
    ForEach-Object { $targets[[int]$_.ProcessId] = $true }

if ($targets.Count -eq 0) {
    Write-Host "  動いているサーバーはありませんでした。"
}
else {
    foreach ($pid_ in $targets.Keys) {
        try {
            Stop-Process -Id $pid_ -Force -ErrorAction Stop
            Write-Host ("  停止しました (PID {0})" -f $pid_)
        }
        catch {
            # すでに終了しているだけなら気にしない
        }
    }
}

# ポートが解放されるまで最大 15 秒待つ
for ($i = 0; $i -lt 60; $i++) {
    if (-not (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)) {
        break
    }
    Start-Sleep -Milliseconds 250
}

if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
    Write-Host ("  警告: ポート {0} がまだ使われています" -f $port)
}
else {
    Write-Host ("  ポート {0} が空きました" -f $port)
}
