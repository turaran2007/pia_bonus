# Pia Bot（pia_bonus）

Discord 用のピアボーナス Bot です。
決めた絵文字を入れて相手をメンションすると、送った人（give）と受け取った人（receive）の回数を記録し、
毎週決まった曜日・時刻にランキングをスレッドへ投稿します。

## 使い方

| コマンド | 内容 |
|---|---|
| `/pia_config` | 設定メニュー（サーバーの管理者と Bot の管理者のみ）。下の「設定できること」を参照 |
| `/pia_total` | 累計ランキング |
| `/pia_weekly` | 直近7日間（今日を含む）のランキング |
| `/pia_monthly` | 月間ランキング（今月／先月） |
| `/pia_yearly` | 年間ランキング（今年／去年） |
| `/pia_me` | 自分の送受信数（累計・今年・今月・直近7日間）と、よく送った相手・よくもらった相手 |
| `/pia_settings` | 現在の設定と次回の投稿日時 |
| `/pia_help` | ヘルプ |

Bot のメッセージはすべて Discord の新しい表示方式（Components V2）のカードで表示します。
古い Discord クライアントでは正しく表示されないことがあるので、アプリを最新にしてください。

### 設定できること（`/pia_config`）

設定パネルの各項目の［変更］から入力画面を開いて設定します。保存すると、パネルがその場で更新されます。


| 項目 | 内容 | 既定値 |
|---|---|---|
| チャンネル・曜日・時刻 | 週次集計を投稿する場所と日時（日本時間） | 未設定（投稿しない） |
| 絵文字 | 記録の対象にする絵文字 | 未設定（記録しない） |
| 連投の上限 | 同じ人から同じ相手へ、1日に何回まで数えるか（0 で無制限） | 無制限 |
| メンションの対象 | ロールへのメンション、@everyone / @here を記録するか。ユーザーへの直接メンションは常に記録 | どちらも記録する |
| 除外チャンネル | 記録しないチャンネル・カテゴリー（最大25件）。スレッドは親チャンネルの設定に従う | なし |
| 記録リセット | 累計データ、または今週のデータを削除 | |
| 設定リセット | 上記の設定をすべて既定値に戻す | |

- Bot の管理者（アプリケーションの所有者と `BOT_ADMIN_IDS` のアカウント）は、そのサーバーの管理者でなくても `/pia_config` を使えます。Discord 上の権限やロールは変わりません。
- 記録には Bot と送った本人は含みません。
- 定期投稿は、設定した曜日・時刻に「前日までの7日間」を集計します。送信日当日の記録は次回に入るので、取りこぼしも重複もありません。
- 設定時刻に Bot が止まっていても、**同じ日のうちに再開すれば**その時点で投稿します（同じ日に二重に投稿することはありません）。曜日・時刻を「今日の、もう過ぎた時刻」に変えた場合は、その日は投稿せず次回からになります。
- 「よく送った相手・よくもらった相手」と連投の上限は、このバージョン以降の記録から数えます。
- 日付はすべて日本時間で扱います。

## 構成

```
index.js            Bot 本体（イベント処理、定期投稿、ヘルスチェック）
src/db.js           PostgreSQL へのアクセス
src/time.js         日付・時刻の処理（日本時間）
src/format.js       ランキングの並べ替え
src/awards.js       記録する相手の決定、除外チャンネルの判定
src/views.js        画面（Components V2 のカードと入力画面）の組み立て
scripts/            旧データの移行、旧コマンドの削除
k8s/                k3s 用のマニフェスト
test/               テスト（node --test）
```

必要な環境変数：

| 名前 | 内容 |
|---|---|
| `BOT_TOKEN` | Discord の Bot トークン（必須） |
| `DATABASE_URL` または `PGHOST` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` | PostgreSQL の接続先 |
| `BOT_ADMIN_IDS` | 全サーバーで設定の変更とリセットができるアカウント（Discord のユーザー ID、カンマ区切り）。Bot のアプリケーションの所有者は指定しなくても自動で含まれる |
| `HEALTH_PORT` | ヘルスチェックのポート（省略時 8080）。`/healthz` は Discord 接続、`/readyz` は Discord と DB の両方を確認 |

Discord Developer Portal の Bot 設定で **SERVER MEMBERS INTENT** と **MESSAGE CONTENT INTENT** を有効にしてください。
スラッシュコマンドは起動時に自動で登録されます（`CLIENT_ID` は不要になりました）。

## ローカルで動かす

```bash
cp .env.example .env   # BOT_TOKEN と DATABASE_URL を入れる
npm install
npm start
```

テスト（DB のテストは `TEST_DATABASE_URL` を設定したときだけ実行されます。中のテーブルは消されるので専用の DB を使ってください）：

```bash
TEST_DATABASE_URL=postgres://postgres@localhost:5432/pia_test npm test
```

## k3s で動かす

### 1. コンテナイメージ

`main` に push すると GitHub Actions がテストを実行し、`ghcr.io/turaran2007/pia_bonus:latest`（amd64 / arm64）を作ります。

リポジトリが非公開の場合、イメージも非公開になります。次のどちらかを行ってください。

- GitHub の Packages 設定でイメージを Public にする
- `read:packages` 権限のトークンで pull 用の Secret を作り、`k8s/bot.yaml` に `imagePullSecrets` を追加する

```bash
kubectl -n pia-bonus create secret docker-registry ghcr --docker-server=ghcr.io --docker-username=<GitHubユーザー名> --docker-password=<トークン>
```

GHCR を使わず、k3s のノード上でビルドして直接読み込むこともできます。この場合は `k8s/bot.yaml` の `image` を `pia_bonus:local`、`imagePullPolicy` を `IfNotPresent` に変更してください。

```bash
docker build -t pia_bonus:local .
```

```bash
docker save pia_bonus:local | sudo k3s ctr images import -
```

### 2. Secret の作成

```bash
cp k8s/secret.example.yaml k8s/secret.yaml
```

`k8s/secret.yaml` に Bot トークンと PostgreSQL のパスワードを書きます（このファイルはコミットされません）。

```bash
kubectl apply -f k8s/namespace.yaml
```

```bash
kubectl apply -f k8s/secret.yaml
```

### 3. デプロイ

```bash
kubectl apply -k k8s/
```

```bash
kubectl -n pia-bonus get pods
```

```bash
kubectl -n pia-bonus logs deploy/pia-bonus -f
```

- PostgreSQL のデータは k3s 標準の `local-path` ストレージ（1Gi）に保存されます。
- Bot は必ず 1 台で動かしてください（2 台以上だと記録や返信が重複します）。
- 新しいイメージに更新するときは次を実行します。

```bash
kubectl -n pia-bonus rollout restart deploy/pia-bonus
```

### 4. 旧バージョン（SQLite）からのデータ移行

旧バージョンの `emojiStats.db` がある場合は、Bot をデプロイしたあとに移行します。
まず、手元から k3s 内の PostgreSQL に接続できるようにします（このコマンドは動かしたままにします）。

```bash
kubectl -n pia-bonus port-forward svc/postgres 5432:5432
```

別のターミナルで、リポジトリのディレクトリから実行します。

```bash
npm install && npm install --no-save better-sqlite3
```

```bash
DATABASE_URL=postgres://pia:<POSTGRES_PASSWORD>@localhost:5432/pia_bonus npm run migrate:sqlite -- ./emojiStats.db
```

- 何度実行しても結果は同じです（同じデータは SQLite 側の値で上書きします）。
- 旧バージョンは日別データを UTC の日付で保存していたため、移行前のデータは日本時間 0〜9 時の記録が前日扱いのままになります。

旧バージョンの `deploy-commands.js` でサーバーにコマンドを登録していた場合は、動かなくなった `/pia_setemoji` などを削除できます。

```bash
BOT_TOKEN=<トークン> GUILD_ID=<サーバーID> npm run clear-guild-commands
```
