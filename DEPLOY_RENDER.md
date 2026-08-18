# Render に置く手順

GitHub にコードを上げて、Render につなぐだけです。
サーバーの管理（OSの更新など）は要りません。証明書も自動で付きます。

---

## 0. なぜ Supabase ではないか

Supabase が貸してくれるのは **データベース・ファイル保管・ログイン機能** で、
Python のアプリを常駐させる場所はありません。
このアプリは Flask が画面を組み立て、`auto_screenshot.py` が動画を解析し、
動画ファイルそのものを配信しています。置き場所としては使えません。

Render は Python をそのまま動かせるので、**いまのコードを書き換えずに**載せられます。

---

## 1. 用意していただくもの

| | |
|---|---|
| GitHub アカウント | 無料 |
| Render アカウント | GitHub でログインできます |
| 支払い方法（カード） | 下記のとおり月額がかかります |

### 費用の目安

| | 月額 |
|---|---|
| Starter プラン（アプリ本体） | $7 |
| ディスク 20GB（$0.25/GB） | $5 |
| **合計** | **約 $12（月 1,900円ほど）** |

**無料プランは使えません。**保存領域を付けられないため、
入れ替えのたびに動画もデータベースも消えてしまいます。

> 動画を残さない運用（スクショ生成後に消す）に変えると、
> ディスクは 1GB で足り、月 $7 ほどに下がります。

---

## 2. GitHub に上げる

このフォルダはすでに準備済みです（`.gitignore` で `data/` を除外しています）。

```powershell
cd C:\Users\AI\video-review
git remote add origin https://github.com/<あなたのID>/video-analysis.git
git branch -M main
git push -u origin main
```

> **`data/` は絶対に上げません。**
> 294MB の動画は GitHub の上限（1ファイル100MB）を超えますし、
> `data/secret_key` が漏れると誰でもログインできてしまいます。

---

## 3. Render につなぐ

1. <https://render.com> を開き、**GitHub でログイン**
2. 「New +」→「Blueprint」
3. さきほどのリポジトリを選ぶ
4. `render.yaml` が読み込まれ、内容が表示される → 「Apply」

これだけです。5分ほどで
`https://video-analysis-xxxx.onrender.com` のようなアドレスが発行されます。
**証明書は自動で付くので、警告は出ません。**

以降は `git push` するたびに自動で入れ替わります。

---

## 4. いまのデータを移す

新しいアドレスを開くと、まっさらな状態（最初のユーザーを作る画面）で始まります。
いまの案件7件・スクリーンショット243行を持っていく場合は、
Render の Shell から `data/` を流し込みます。

```powershell
# この PC 側：data フォルダを固める（294MBの動画を含むので数分かかります）
cd C:\Users\AI\video-review
tar -czf data.tgz data
```

Render の画面 →「Shell」を開いて、転送用の受け口を作ります。
容量が大きいので、いったんどこかに置いてから `curl` で取るのが確実です。

```bash
cd /var/data
curl -L "<data.tgz を置いた場所のURL>" -o data.tgz
tar -xzf data.tgz --strip-components=1
rm data.tgz
```

移したあと、Render の画面から「Manual Deploy」→「Restart」をします。

> **動画が要らなければ**、`data/videos` を除いて固めると 30MB ほどで済み、
> ブラウザからの転送で足ります。スクリーンショットと入力内容は残ります。

---

## 5. 動かしてみる

1. 発行されたアドレスを開く
2. 最初のユーザー（IDとパスワードと表示名）を作る
3. Google Authenticator で QR を読み取る
4. ヘッダーの「ユーザー」からチームの人を追加する

データを移した場合は、いままでの ID とパスワードでそのまま入れます。

---

## 6. 気をつけること

### スクリーンショット生成の時間

Starter プランは CPU が控えめなので、この PC より遅くなります。
60秒の動画で 20秒 → 40〜60秒ほどを見込んでください。
打ち切り時間は `VR_JOB_TIMEOUT`（既定 1800秒）で変えられます。

### ディスクは減らせない

Render のディスクは増やせますが減らせません。
20GB で始めて、足りなくなったら増やしてください。
いまの使用量は 323MB（うち動画 294MB）です。

### バックアップ

Render のディスクは自動でバックアップされません。
`data/app.db` と `data/screenshots/` が失われると復旧できないので、
月に一度は Shell から固めて手元に落としてください。

```bash
cd /var/data && tar -czf /tmp/backup.tgz app.db screenshots
```

### 動くのは1台だけ

データベースに SQLite を使っているので、**台数を増やすことはできません**
（増やすと別々のデータベースを見てしまいます）。
数人で使う分には1台で足ります。人数が増えて重くなってきたら、
そのときに PostgreSQL へ移す判断をしてください。

---

## 7. この PC で動かし続ける場合

Render を使わず、いまの PC のままでよければ [README.md](README.md) を参照してください。
社内LANからは `https://192.168.11.5:5000/` で開けます。
