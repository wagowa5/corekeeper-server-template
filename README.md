# Core Keeper AWS CDK template

AWS CDK v2 / TypeScript で Steam 版 Core Keeper 専用サーバーを構築します。Terraform 版を CDK に置き換えました。AWS への適用はまだ行っていません。

## 構成

- 東京リージョン / Ubuntu Server 24.04 amd64 / `t3.large`（変更可能）
- 専用 VPC とパブリックサブネット、動的パブリック IPv4。NAT Gateway / 固定 IP は使用しません。
- 受信ポートなし。Steam Datagram Relay の Game ID で接続し、管理は SSM Session Manager。
- `escaping/core-keeper-dedicated` を systemd 管理で起動。ワールド番号は `0`、初期プレイヤー数は 4。
- OS 用 16 GiB と、データ用の暗号化 30 GiB gp3 EBS を分離。
- 非公開 S3、SSE-S3、バージョニング、TLS 強制、バックアップの Lifecycle。
- JST 00:55 の systemd バックアップ。EventBridge Scheduler は既定で無効。設定例は JST 18:00 起動 / 翌 01:00 停止。
- 停止スケジュールでは SSM Automation が正常終了・S3 バックアップに成功した後だけ EC2 を停止。
- Discord 通知は既存 SSM SecureString ARN を指定した場合に有効。
- Windows 用 IAM Roles Anywhere は公開 CA 証明書ファイルを指定した場合に有効。

添付履歴では冒頭が `t3.small`、後半が「2 vCPU / 8 GiB」でした。現在の正確な型番、運転時刻、既存リソース ID は未確認です。`t3.large` と時刻は仮の初期値です。Windows PC の移行・タスク登録はこのスタックの対象外です。

## ローカル検証

Node.js 22 以降と Python 3、bash が必要です。依存関係は `package-lock.json` に固定しています。

```bash
npm ci
npm test
npm run synth -- --quiet
```

CDK assertions テストは CloudFormation テンプレートの権限、ネットワーク、保持設定、停止手順と user data を検証します。Python テストはバックアップの成功・送信失敗・強制終了・ワールド未生成時の動作を検証します。これらと `synth` は AWS のリソースを作成せず、AWS 認証なしで実行できます。

構成は `lib/corekeeper-stack.ts`、設定読み込みは `lib/config.ts`、EC2 内の処理は `infra/templates/` にあります。`dist/` と `cdk.out/` は生成物です。

## 設定

```bash
cp config.example.json config.local.json
# config.local.json を編集
export COREKEEPER_CONFIG="$PWD/config.local.json"
npm run synth -- --quiet
```

`COREKEEPER_CONFIG` を指定しなければ初期値を使用します。指定した場合は JSON の値で上書きします。以降の synth / diff / deploy / bootstrap でも同じ設定を使用してください。

| キー | 初期値・用途 |
| --- | --- |
| `name` | `corekeeper`。小文字英字で始まる英数字とハイフン、3〜30 文字 |
| `region` | `ap-northeast-1` |
| `instanceType` | `t3.large`。amd64 Nitro の t3 / t3a 系 small 以上に対応 |
| `containerImage` | `escaping/core-keeper-dedicated:latest` |
| `worldName` / `maxPlayers` | `Core Keeper Server` / `4` |
| `schedulesEnabled` | `false` |
| `startSchedule` / `stopSchedule` | `cron(0 18 * * ? *)` / `cron(0 1 * * ? *)`。Asia/Tokyo |
| `discordParameterArn` | 任意。既存 SecureString の ARN のみ |
| `windowsCaCertificateFile` | 任意。JSON ファイルからの相対パス、または絶対パスで公開 CA PEM を指定 |
| `windowsCertificateCn` | `corekeeper-friend-pc` |

本番ではレビューした amd64 対応イメージの digest を指定してください。`latest` は可変タグです。ゲーム本体は起動時に Steam から取得・更新されるため、イメージ固定だけでゲームのバージョンは固定されません。Ubuntu AMI は CloudFormation の SSM パラメーターでデプロイ時に解決します。

## 新規デプロイ

対象アカウントの一時認証情報を用意し、作成者に VPC / EC2 / EBS / IAM / S3 / SSM / Scheduler / SQS（任意で Roles Anywhere）と PassRole の権限を付与します。CDK bootstrap 用の権限も必要です。

```bash
aws sts get-caller-identity
npm run build
# ACCOUNT_ID と REGION を設定先に合わせる
npm run cdk -- bootstrap aws://ACCOUNT_ID/REGION
npm run diff
# 差分・IAM 権限・課金対象を確認してから実行
npm run deploy -- --outputs-file cdk-outputs.json
```

CloudFormation が状態を管理します。CDK bootstrap は専用スタックと S3 などを作成します。EC2 の起動・CloudFormation の完了だけでは cloud-init / Steam ダウンロードの完了を保証しません。

## 初回の動作確認

`cdk-outputs.json` または CloudFormation Outputs の `InstanceId` を使って SSM 接続します。ローカル AWS CLI の場合は Session Manager plugin が必要です。

```bash
aws ssm start-session --target INSTANCE_ID --region ap-northeast-1
```

EC2 内で実行します。

```bash
sudo cloud-init status --wait
sudo systemctl status corekeeper --no-pager
sudo journalctl -u corekeeper -n 100 --no-pager
sudo docker exec core-keeper-dedicated cat /home/steam/core-keeper-dedicated/GameID.txt
sudo systemctl list-timers corekeeper-backup.timer
sudo /usr/local/sbin/corekeeper-backup
```

Steam クライアントから実際に Game ID で参加し、ワールドを確認してください。初回バックアップ前に `worlds/0.world.gzip` の生成・保存も確認します。バックアップの手動コマンドの出力、タイマー実行時は `journalctl -u corekeeper-backup` を確認します。

管理者権限で S3 のアーカイブを取得し、`tar -tzf` で内容を検査します。停止済みテスト環境へ復元し、拠点・建築物・探索状況が残っていることをゲームから確認してください。EC2 ロールはアップロード専用で、ダウンロード・削除は許可しません。

## バックアップと停止

保存先は `/srv/corekeeper/server-data`、実行ファイルは `/srv/corekeeper/server-files` です。バックアップは `server-data` 全体を圧縮し、`corekeeper/backups/` に UTC 日時と UUID を含む名前で格納します。

排他ロック後に systemd を停止し、Docker が 120 秒の猶予後に SIGKILL された場合は送信を拒否します。通常バックアップ後は元々起動していたサーバーを再開します。送信失敗時も再開を試み、ローカルの失敗アーカイブを残します。失敗アーカイブの容量監視・手動整理が必要です。電源断や OOM では cleanup が実行されない場合があります。

スケジュール停止は `--leave-stopped` でバックアップし、成功後だけ EC2 を停止します。失敗するとインスタンスが稼働し続けます。00:55 と停止直前の通常 1 日 2 本を保存するため、固定 30 世代ではありません。現行オブジェクトは 30 日後、非現行バージョンは非現行化から 30 日後に削除するので、実データが約 60 日残る場合があります。Object Lock は設定していません。

初回の接続・復元確認後に `schedulesEnabled` を有効にしてデプロイします。Scheduler の再試行は 0 回にし、古い停止処理が後の起動を取り消すのを避けます。API 呼び出し失敗は SQS DLQ、Automation 内の失敗は SSM Automation 実行履歴で確認します。DLQ は Automation 内部の成否を監視しません。通知アラームは別途設定してください。手動の EC2 Stop や電源断では自動バックアップされません。

## Discord と Windows 認証

管理者が SSM Parameter Store に AWS 管理の SSM KMS キーで SecureString を作成し、`discordParameterArn` に ARN を指定します。Webhook 値は設定 JSON や CDK コードに入れません。EC2 が起動時に取得して root 専用の `/run/corekeeper/container.env` に保存します。通知はイメージの標準機能（Game ID、参加・退出など）です。Docker 管理者は環境変数を閲覧できるため、ホストの管理権限も制限してください。Parameter の取得に失敗するとサーバー起動も失敗します。カスタム KMS キー用の復号権限は含めていません。

Windows は `windowsCaCertificateFile` に公開 CA PEM を設定すると Trust Anchor、Profile、IAM ロールを作成します。秘密鍵や証明書発行は CDK の外で管理します。PC 証明書の CN は設定値と一致させ、秘密鍵はタスク実行ユーザーの Windows 証明書ストアへ非エクスポート可能として登録します。

AWS 公式 `aws_signing_helper` の署名・チェックサムを確認して導入し、CloudFormation Outputs の `WindowsRoleArn`、`WindowsTrustAnchorArn`、`WindowsProfileArn` で AWS CLI を設定します。

```ini
[profile corekeeper-backup]
region = ap-northeast-1
credential_process = "C:\CoreKeeperBackup\aws_signing_helper.exe" credential-process --cert-selector Key=x509Subject,Value=CN=corekeeper-friend-pc --role-arn ROLE_ARN --trust-anchor-arn TRUST_ANCHOR_ARN --profile-arn PROFILE_ARN
```

`aws sts get-caller-identity --profile corekeeper-backup` で認証を確認します。ロールは `windows/backups/*` への PutObject と不完全 multipart の中止だけを許可し、一覧・取得・削除は許可しません。日時と UUID を含むキーを使用します。同名キーへの新バージョン作成は防ぎません。証明書の更新、漏えい時の無効化 / CRL 運用が必要です。Windows の正常終了・圧縮・送信・再起動・タスク登録は別作業です。

## 既存環境と更新時の注意

この CDK は新規環境を作成します。既存 EC2 / S3 や Terraform state を自動で引き継ぎません。旧 Terraform をすでに適用している場合、二重管理を避けて所有権移行と CloudFormation import を別途設計してください。今回このリポジトリからはまだ AWS に適用していません。

既存環境を取り込む場合は最終バックアップ後にリソースを棚卸しし、実際の設定に CDK を合わせて、対象リソースが CloudFormation import に対応しているか確認します。取り込みの対象と手順を確定する前に deploy しないでください。既存と同名の SSM Document / ScheduleGroup も競合します。

ワールドを新規環境に移す場合は、両方のサーバーと旧スケジュールを停止し、旧 `/home/ubuntu/corekeeper/server-data` 一式を取得します。新環境で空データを退避し、`server-data/` を `/srv/corekeeper` 配下へ展開して所有者を `1000:1000` に合わせ、ワールド番号 `0` を確認して再開します。復元確認まで旧環境は残し、二重運用しません。

S3 とワールド EBS には CloudFormation の **DeletionPolicy / UpdateReplacePolicy: Retain** を設定します。これは Terraform の `prevent_destroy` と異なり、削除操作自体を拒否するのではなく、実リソースを残してスタック管理から外します。スタック削除後も費用が発生し、再デプロイで自動的には再利用されません。

EC2 の置き換えやデータ EBS の変更は停止を伴う保守作業です。接続中の EBS を CloudFormation が自動で安全に切り離す保証はありません。事前にスケジュール無効化、正常終了・最終バックアップ、EC2 停止、必要な段階的デタッチ・再接続を計画してください。同じ EBS を稼働中の新旧 EC2 へ同時接続できません。Launch Template の user data 更新だけでは既存 OS の cloud-init は再実行されないため、更新内容の再適用または計画したインスタンス置き換えが必要です。毎回 `cdk diff` と CloudFormation change set を確認してください。

実 AWS の cloud-init、IAM 実効権限、Steam 接続、Discord 通知、Windows 認証・復元はデプロイ後の実機検証が必要です。EC2・EBS・S3・IPv4・転送・T3 CPU クレジットなどが課金対象です。
