# Core Keeper AWS CDK

AWS CDK v2 / TypeScript で Steam 版 Core Keeper 専用サーバーを構築します。

**EC2・VPC・ワールド用 EBS は新規作成します。S3 は既存バケットの参照と新規作成を選択できます。** 既存 EC2 の再利用やワールドの自動移行、CloudFormation へのリソース取り込みは行いません。

## 1. 準備

Node.js 22 以降、AWS CLI と対象アカウントの一時認証情報を用意します。テストには Python 3 と bash も必要です。以下のコマンドはリポジトリ直下で bash から実行します。

```bash
npm ci
aws sts get-caller-identity
```

構築者には VPC / EC2 / EBS / IAM / S3 / SSM / Scheduler / SQS と PassRole、CDK bootstrap の権限が必要です。Windows 認証を有効にする場合は Roles Anywhere の権限も必要です。

## 2. バックアップ先を選ぶ

### 既存の S3 バケットを使う

すでにバックアップ用バケットがある場合はこちらを選びます。

```bash
cp config.existing-bucket.example.json config.local.json
```

`config.local.json` の `bucketName` を実際のバケット名に変更してください。ARN や `s3://` は含めません。

```json
"backupBucket": {
  "mode": "existing",
  "bucketName": "your-existing-backup-bucket"
}
```

これはバケット名による参照です。**バケットを新規作成せず、既存の Bucket Policy・暗号化・バージョニング・公開制限・Lifecycle・既存オブジェクトも変更しません。** EC2 と任意の Windows ロールに、そのバケットの専用プレフィックスへのアップロード権限を付与します。

同一 AWS アカウント・同一リージョンの SSE-S3 バケットを前提とします。デプロイ前に、バケットの存在と対象アカウント、暗号化、公開制限、バージョニング、必要な保持期間を確認してください。例：

```bash
aws s3api head-bucket --bucket your-existing-backup-bucket --expected-bucket-owner ACCOUNT_ID
aws s3api get-bucket-location --bucket your-existing-backup-bucket
aws s3api get-bucket-encryption --bucket your-existing-backup-bucket
aws s3api get-public-access-block --bucket your-existing-backup-bucket
aws s3api get-bucket-versioning --bucket your-existing-backup-bucket
aws s3api get-bucket-lifecycle-configuration --bucket your-existing-backup-bucket
```

既存 Bucket Policy による Deny は IAM の許可より優先されます。SSE-KMS やクロスアカウントのバケットでは追加の KMS / Bucket Policy 権限設計が必要で、この設定だけでは対応しません。`synth` は存在や実際のアップロード権限を検査しません。

### 新しい S3 バケットを作る

```bash
cp config.example.json config.local.json
```

```json
"backupBucket": { "mode": "create" }
```

非公開・SSE-S3・バージョニング・TLS 強制・30 日の Lifecycle を持つバケットを自動命名で作成し、削除時は `Retain` で保持します。バケット名はデプロイ後の `BackupBucket` 出力で確認できます。

**`backupBucket.mode` の指定は必須です。** 未指定や既存モードでのバケット名未指定はエラーになり、新規バケット作成へ切り替わることはありません。以前の設定 JSON にもこの項目を追加してください。

## 3. 設定して検証する

```bash
export COREKEEPER_CONFIG="$PWD/config.local.json"
npm test
npm run synth -- --quiet
```

以降の diff / deploy でも同じ `COREKEEPER_CONFIG` を使用します。検証と synth は AWS にリソースを作成しません。既存バケット参照時は `cdk.out/corekeeper-stack.template.json` に `AWS::S3::Bucket` / `AWS::S3::BucketPolicy` が含まれないことも確認できます。

| 設定 | 初期値・使い方 |
| --- | --- |
| `backupBucket` | 必須。上記の新規作成 / 既存参照を選択 |
| `name` / `region` | `corekeeper` / `ap-northeast-1` |
| `instanceType` | `t3.large`。amd64 Nitro の t3 / t3a 系 small 以上 |
| `containerImage` | `escaping/core-keeper-dedicated:latest`。本番ではレビューした digest を推奨 |
| `worldName` / `maxPlayers` | `Core Keeper Server` / `4`。ワールド番号は `0` |
| `schedulesEnabled` | `false`。接続・復元確認後に有効化 |
| `startSchedule` / `stopSchedule` | JST 18:00 / 翌 01:00。cron 式で変更 |
| `discordParameterArn` | 任意。既存 SSM SecureString の ARN。Webhook 値は入力しない |
| `windowsCaCertificateFile` | 任意。公開 CA PEM の絶対パス、または設定 JSON からの相対パス |
| `windowsCertificateCn` | `corekeeper-friend-pc` |

Ubuntu 24.04、暗号化 OS 用 16 GiB + データ用 30 GiB gp3 を使用します。受信ポートは開けず、管理は SSM、プレイは Steam Game ID 接続です。稼働時刻と型番は環境に合わせて変更してください。

## 4. 差分を確認してデプロイする

```bash
npm run build
# 初回のみ。ACCOUNT_ID と REGION を設定先に合わせる
npm run cdk -- bootstrap aws://ACCOUNT_ID/REGION
npm run diff
npm run deploy -- --outputs-file cdk-outputs.json
```

差分で S3 の選択、EC2 の新規作成、IAM 権限を確認してから deploy します。既存と同名の SSM Document / ScheduleGroup は競合するため、必要なら事前に `name` を変えてください。EC2・EBS・S3・IPv4・転送・T3 CPU クレジットなどが課金対象です。

すでにこのスタックをデプロイ済みの場合、S3 モードを切り替えてもバックアップはコピーされません。新規作成から既存参照へ変更すると、元のバケットは `Retain` でスタック管理から外れます。一方、旧スタックが管理する Bucket Policy は削除されるため、同じバケットを参照し直す場合も、先に保持設定や管理主体の移行を計画してください。変更にはバックアップ先と権限の確認、および既存 OS 設定への反映が必要です。Launch Template 更新だけでは既存 EC2 の cloud-init は再実行されません。[更新手順の注意](docs/operations.md#既存環境と更新時の注意)を確認してください。

## 5. 接続してバックアップを確認する

`cdk-outputs.json` の `InstanceId` を使用します。ローカル AWS CLI には Session Manager plugin が必要です。

```bash
aws ssm start-session --target INSTANCE_ID --region ap-northeast-1
```

EC2 内で確認します。

```bash
sudo cloud-init status --wait
sudo systemctl status corekeeper --no-pager
sudo docker exec core-keeper-dedicated cat /home/steam/core-keeper-dedicated/GameID.txt
# Steam クライアントから Game ID で参加し、ワールド保存後に実行
sudo /usr/local/sbin/corekeeper-backup
```

`BackupBucket` 出力のバケットで `corekeeper/backups/` にアーカイブが作成されたことを管理者権限で確認します。既存バケットでも必ず実際の送信・復元を試してください。EC2 のロールは取得・一覧・削除を許可しません。

接続・復元の確認後に `schedulesEnabled: true` にして再デプロイします。毎日 JST 00:55 と停止直前にバックアップし、停止処理のバックアップが失敗した場合は EC2 を停止しません。

詳しい[バックアップ・復元、Discord、Windows 認証、既存ワールドの移行、更新手順](docs/operations.md)を参照してください。Windows PC のタスク登録や公式サーバーの導入はこの CDK の対象外です。
