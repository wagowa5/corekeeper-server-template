# Core Keeper AWS template

Steam 版 Core Keeper 専用サーバーを AWS に構築する Terraform です。AWS への適用はまだ行っていません。

## 構成

- 東京リージョン / Ubuntu Server 24.04 amd64 / `t3.large`（変更可能）
- 専用 VPC、パブリックサブネット、動的パブリック IPv4。NAT Gateway / 固定 IP は使用しません。
- 受信ポートなし。Steam Datagram Relay の Game ID で接続し、管理には SSM Session Manager を使用します。
- `escaping/core-keeper-dedicated` を systemd 管理で起動。ワールド番号は `0`、初期プレイヤー数は 4。
- OS 用 16 GiB EBS と、データ用の暗号化 30 GiB gp3 EBS を分離。
- 非公開 S3、SSE-S3、バージョニング、TLS 強制、バックアップの Lifecycle。
- JST 00:55 の systemd バックアップ。EventBridge Scheduler は既定で無効、設定例は JST 18:00 起動 / 翌 01:00 停止。
- 停止スケジュールは SSM Automation を開始し、正常終了・S3 バックアップに成功した後だけ EC2 を停止します。
- Discord 通知は既存 SSM SecureString を指定した場合に有効。
- Windows バックアップ用 IAM Roles Anywhere は公開 CA 証明書を指定した場合に有効。

添付履歴では冒頭が `t3.small`、後半が「2 vCPU / 8 GiB」でした。現在の正確な型番、運転時刻、既存リソース ID は未確認です。`t3.large` と時刻は仮の初期値であり、既存環境の完全再現を保証するものではありません。Windows PC の移行・タスク登録はこの Terraform の対象外です。

## 検証と新規構築

Terraform 1.13 以降、AWS CLI、対象アカウントの一時認証情報を用意します。EC2 実行用ロールとは別に、構築者には VPC / EC2 / EBS / IAM / S3 / SSM / Scheduler / SQS（任意で Roles Anywhere）の作成と PassRole 権限が必要です。

```bash
cd infra
terraform init -lockfile=readonly
terraform fmt -check -recursive
terraform validate
terraform test
cp terraform.tfvars.example terraform.tfvars
# terraform.tfvars を編集
aws sts get-caller-identity
terraform plan -out=corekeeper.tfplan
# 内容と課金対象を確認してから実施
terraform apply corekeeper.tfplan
```

`terraform test` は AWS provider を mock 化し、実リソースを作成しません。`plan/apply` は実 AWS 認証が必要です。状態は既定でローカルに保存されます。共有運用前には、このスタックと別管理の暗号化・アクセス制限・バージョニング付き S3 backend と `use_lockfile = true` を構成し、`terraform init -migrate-state` で移行してください。状態・plan・秘密鍵は Git に登録しません。

`latest` は可変タグです。本番ではレビューした amd64 対応イメージの digest を `container_image` に指定してください。ゲーム本体はコンテナ起動時に Steam から取得・更新されるため、イメージ固定だけではゲームのバージョンは固定されません。ARM のインスタンス型はこの構成の対象外です。

## 初回確認

EC2 が Running でも cloud-init と Steam のダウンロードには時間がかかります。SSM で接続して確認します（ローカル AWS CLI の場合は Session Manager plugin が必要です）。

```bash
aws ssm start-session --target "$(terraform output -raw instance_id)" --region ap-northeast-1
```

以降は EC2 内で実行します。

```bash
sudo cloud-init status --wait
sudo systemctl status corekeeper --no-pager
sudo journalctl -u corekeeper -n 100 --no-pager
sudo docker exec core-keeper-dedicated cat /home/steam/core-keeper-dedicated/GameID.txt
sudo systemctl list-timers corekeeper-backup.timer
```

Game ID から実際に Steam クライアントで参加し、ワールドを確認してください。PID やファイルの存在だけではプレイ可能と判断しません。初回バックアップ前に `worlds/0.world.gzip` が実際に生成・保存されていることも確認してください。

```bash
sudo /usr/local/sbin/corekeeper-backup
sudo journalctl -u corekeeper-backup --no-pager
```

管理者の AWS 認証で S3 内のアーカイブを取得し、`tar -tzf` で内容を検査します。別の停止済みテスト環境へ展開し、ゲームから拠点・建築物・探索状況を確認する復元テストも必要です。EC2 の実行ロールはアップロード専用で、ダウンロード・削除権限を付与していません。

## バックアップと停止

データは `/srv/corekeeper/server-data`、サーバー実行ファイルは `/srv/corekeeper/server-files` に保持します。バックアップ対象は `server-data` 全体で、S3 の `corekeeper/backups/` に UTC 日時と UUID を含む名前で格納します。

バックアップは排他ロックを取り、systemd を停止してから tar.gz を作成します。Docker が終了猶予 120 秒を超えて SIGKILL された場合はアップロードを拒否します。通常バックアップ後は元々起動していたサーバーを再開します。S3 送信失敗時も再開を試み、失敗アーカイブはローカルに残します。失敗アーカイブは容量監視と手動整理が必要です。電源断や OOM などでは cleanup 自体が実行されない可能性があります。

スケジュール停止では `--leave-stopped` でバックアップし、成功した場合だけ Automation が EC2 を停止します。失敗時はインスタンスが動き続けるため、料金と障害を監視してください。停止直前にもバックアップするため、00:55 の分と合わせて通常は 1 日 2 本です。約 30 世代という固定数ではなく、現行オブジェクトの保存期間が 30 日になります。非現行バージョンも非現行化から 30 日後に削除されるため、実データが約 60 日残る場合があります。Object Lock は設定していません。

初回の接続・復元確認後に `schedules_enabled = true` にして適用します。Scheduler の再試行は 0 回で、古い停止処理が後の起動を取り消すのを避けます。API 呼び出し失敗は SQS DLQ、Automation 内部の失敗は SSM Automation の実行履歴で確認します。DLQ は Automation の成功を監視するものではありません。監視先の通知アラームは別途設定してください。手動の EC2 Stop や OS の電源断では自動バックアップは実行されません。

## Discord

管理者が SSM Parameter Store に `/corekeeper/discord` などの SecureString を別途作成し、その ARN を `discord_parameter_arn` に指定します。AWS 管理の SSM KMS キーを使用してください（カスタム KMS キー用の復号権限は含めていません）。Webhook の値は tfvars、user data、Terraform state に渡しません。

起動時に EC2 ロールで取得し、root 専用の `/run/corekeeper/container.env` に書き込みます。通知内容はイメージの標準機能（起動時の Game ID、参加・退出など）です。Docker 管理者はコンテナ環境変数を閲覧できるため、SSM とホストの管理権限も制限してください。Parameter の取得に失敗するとサーバー起動も失敗するため、通知が不要なら ARN を指定しません。

## Windows 向け認証（任意）

公開 CA PEM を `TF_VAR_windows_ca_certificate` に渡すと、Trust Anchor、Profile、専用ロールが作成されます。CA の秘密鍵・PC 用秘密鍵・証明書発行は Terraform の外で管理します。Subject CN は既定で `corekeeper-friend-pc` です。

```bash
export TF_VAR_windows_ca_certificate="$(cat /secure/path/ca-public.pem)"
terraform plan
```

PC 証明書の秘密鍵を Windows の実行ユーザーの証明書ストアへ非エクスポート可能として登録します。AWS 公式 `aws_signing_helper` の署名・チェックサムを確認して導入し、`terraform output -json windows_auth` の ARN を使って AWS CLI の profile を設定します。

```ini
[profile corekeeper-backup]
region = ap-northeast-1
credential_process = "C:\CoreKeeperBackup\aws_signing_helper.exe" credential-process --cert-selector Key=x509Subject,Value=CN=corekeeper-friend-pc --role-arn ROLE_ARN --trust-anchor-arn TRUST_ANCHOR_ARN --profile-arn PROFILE_ARN
```

`aws sts get-caller-identity --profile corekeeper-backup` で認証を確認します。このロールは `windows/backups/*` へのアップロードと不完全 multipart の中止だけを許可し、一覧・取得・削除を許可しません。ファイル名には日時と UUID を含めてください。同名キーへの新バージョン作成は防がないため、書き込み権限だけで改ざん耐性が完成するわけではありません。Profile はデフォルトの X.509 Subject CN マッピングを使用します。

証明書の期限監視・更新、漏えい時の Trust Anchor/Profile 無効化または CRL 運用が必要です。Windows での正常終了、自動圧縮・送信・再起動、タスク登録と実機検証は別作業です。

## 既存 AWS 環境を取り込む場合

このコードをそのまま apply すると**新規環境**を作成します。既存 EC2 / S3 を自動検出・移行しません。既存のバックアップを取得し、現在の VPC・サブネット・SG・ロール・EBS・バケット・スケジュールを棚卸ししてから、構成と resource address を合わせて import してください。S3 はバケット本体だけでなく、バージョニング・暗号化・公開制限・Lifecycle・ポリシーも個別に取り込みます。特に既存 Lifecycle を plan で確認し、保持規則を意図せず上書きしないでください。

旧データのパスは `/home/ubuntu/corekeeper/server-data`、新環境では `/srv/corekeeper/server-data` です。両方のサーバーと既存スケジュールを停止し、旧環境で最終バックアップを取得します。新環境でも `sudo systemctl stop corekeeper` 後、空のデータを退避してからアーカイブの `server-data/` を `/srv/corekeeper` 配下へ展開し、所有者を `1000:1000` に合わせます。`worlds/0.world.gzip` の存在とワールド番号を確認して再開してください。復元確認まで旧環境は保持し、同じワールドを二重運用しません。

ワールド EBS と S3 は `prevent_destroy` で削除を拒否します。EC2 の user data / AMI 更新などはインスタンス置き換えを伴うことがあります。変更前にバックアップと plan の確認が必要です。EBS は同じ AZ 内で再接続します。root volume のみは置き換え時に破棄されます。`prevent_destroy` は Terraform 外の削除やコードからリソース自体を除去した場合の保護ではありません。

## ローカルの検証

```bash
python -m unittest discover -s tests -v
bash -n infra/templates/backup.sh
cd infra
terraform init -backend=false -lockfile=readonly
terraform validate
terraform test
```

Python テストはコマンドの代替を使い、アップロード成功・失敗、強制終了、空ワールド拒否、停止後の再開を検証します。Terraform テストは mock provider で構成を検証します。実 AWS 上の cloud-init、IAM 実効権限、Steam 接続、Discord 通知、Windows 認証・復元は apply 後の実機確認が必要です。EC2・EBS・S3・IPv4・データ転送・T3 CPU クレジットなどが課金対象です。
