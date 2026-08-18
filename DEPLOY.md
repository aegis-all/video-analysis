# インターネット公開の手順

社外からも使えるようにするための手順です。
**ドメインとサーバーの契約はご本人の名義・支払いが必要**なので、
そこだけご用意いただければ、あとの設定はこちらで進められます。

---

## 1. 用意していただくもの

| 必要なもの | 目安 | 例 |
|---|---|---|
| **VPS（サーバー）** | 月 600〜1,500円 | さくらのVPS 2GB / ConoHa 2GB / Xserver VPS 2GB |
| **ドメイン** | 年 1,000〜2,000円 | お名前.com / ムームードメイン / Cloudflare |

**推奨スペック**：メモリ 2GB以上、ストレージ 50GB以上、Ubuntu 24.04。

> **なぜ 2GB 以上か**
> スクリーンショット生成（OpenCV）で数百MBのメモリを使います。
> 1GB でも動きますが、長い動画で落ちる可能性があります。
>
> **なぜ 50GB 以上か**
> 動画1本 40MB＋スクショ 180枚で約 50MB、合わせて約 90MB／案件です。
> 500案件で 45GB になる計算です。動画を消す運用なら 20GB でも足ります。

ドメインを取ったら、**A レコードで VPS の IP を指す**設定をしてください
（例：`review.example.com` → `203.0.113.10`）。
ここまでできたら、以下はこちらで実行できます。

---

## 2. サーバー側の設定（所要 30分ほど）

### 2-1. 必要なものを入れる

```bash
sudo apt update
sudo apt install -y python3-venv python3-pip ffmpeg libgl1 libglib2.0-0
```

`libgl1` と `libglib2.0-0` は OpenCV に必要です（これが無いと
`ImportError: libGL.so.1` で止まります）。

### 2-2. アプリを置く

```bash
sudo useradd -m -s /bin/bash review
sudo -u review -i

git clone <このフォルダの中身> ~/video-review    # または scp で転送
cd ~/video-review

python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/pip install gunicorn
```

`auto_screenshot.py` も同じ場所に必要です（`config.py` の
`AUTO_SCREENSHOT_PY` のパスを Linux 側に合わせて直します）。

### 2-3. 常駐させる（systemd）

`/etc/systemd/system/video-review.service`

```ini
[Unit]
Description=video-review
After=network.target

[Service]
User=review
WorkingDirectory=/home/review/video-review
Environment="VR_PORT=5000"
Environment="VR_BEHIND_PROXY=1"
Environment="VR_HTTPS=1"
ExecStart=/home/review/video-review/.venv/bin/gunicorn \
    --workers 2 --threads 4 --timeout 1200 \
    --bind 127.0.0.1:5000 app:app
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now video-review
sudo systemctl status video-review
```

> `--timeout 1200` は必須です。動画のダウンロードとスクショ生成に
> 数分かかるため、既定の30秒だと処理中に切られます。

### 2-4. HTTPS（Let's Encrypt）

**Caddy を使うのが一番簡単です。**証明書の取得も更新も全自動で、
設定はこれだけです。

```bash
sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`

```
review.example.com {
    reverse_proxy 127.0.0.1:5000

    # 動画アップロードのため上限を上げる
    request_body {
        max_size 600MB
    }
}
```

```bash
sudo systemctl reload caddy
```

これで `https://review.example.com` が使えるようになります。
証明書は自動で取得・更新されるので、**警告は出ません**。

### 2-5. 直接アクセスを塞ぐ

```bash
sudo ufw allow 22,80,443/tcp
sudo ufw enable
```

アプリ自体は `127.0.0.1:5000` でしか待ち受けていないので、
外から直接叩かれることはありません。

---

## 3. 公開後の初回設定

1. `https://review.example.com` を開く
2. 最初のユーザー（IDとパスワード）を作る
3. Google Authenticator で QR を読み取る
4. ヘッダーの「ユーザー」からチームの人を追加する

追加された人は、初回ログイン時に自分の QR が出るので、
それぞれのスマートフォンで登録してもらいます。

---

## 4. 運用で気をつけること

### バックアップ

大事なのは `data/` フォルダだけです。

```bash
# 毎日 3 時に7世代残す例
0 3 * * * cd /home/review/video-review && \
  tar czf ~/backup/data-$(date +\%u).tar.gz data/
```

`data/app.db`（入力内容）と `data/screenshots/`（画像）が失われると
復旧できません。VPS のスナップショット機能も併用してください。

### 容量

```bash
du -sh ~/video-review/data/*
```

`data/videos/` が一番かさみます。スクショ生成が終われば元動画は
必ずしも必要ないので、古いものから消す運用もできます
（動画プレイヤーは使えなくなります）。

`data/trash/` は削除した画像の置き場です。ここは消して構いません。

### ログ

```bash
tail -f ~/video-review/data/app.log      # アプリのログ
sudo journalctl -u video-review -f       # 起動・落ちたときのログ
```

---

## 5. 費用のまとめ

| | 月額 | 年額 |
|---|---|---|
| VPS（2GB） | 約 800円 | 約 9,600円 |
| ドメイン | — | 約 1,500円 |
| SSL証明書 | 0円（Let's Encrypt） | 0円 |
| **合計** | | **約 11,000円／年** |

---

## 6. 社内LANのままでよい場合

インターネット公開せず、今のPCで動かし続ける場合はこのファイルは不要です。
`python make_cert.py` で自己署名の証明書を作れば、
`https://192.168.11.5:5000` で社内から使えます
（初回だけブラウザの警告が出ます。[README.md](README.md) を参照）。
