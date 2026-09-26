# AGENT_INDEX — PLATEAUハッカソン サンプルアプリ

この案件でセッションを開始したエージェント向けの索引。タスク別に読む順序と現在地を示す。

## 案件の状態

| 項目 | 内容 |
|---|---|
| フェーズ | deploy・フォールバック・managed login復旧完了 → 初回ログインと実認証検証待ち |
| **リポジトリ名** | **`sample-app-plateau-lens`** |
| 表示名 | PLATEAU Lens |
| 実装ブランチ | `fix/aws-deployment-readiness` |
| 開催日 | **2026-09-26（土）** |
| 実装可能日 | 2026-09-25（金）のみ |
| 企画確定日 | 2026-09-24 |

## タスク別の参照先

| タスク | 読む順序 |
|---|---|
| **AWSへデプロイする** | `README.md` の「AWSへデプロイする前の確認」から読む。対象アカウント・環境・最小権限プロファイル・Budget通知先を確認してから、フォールバック無効の初回デプロイへ進む |
| ローカルで動かす・検証する | `README.md` の「ローカルでTier 1を動かす」「テストとビルド」「push前のシークレット検査」 |
| 実装を変更する | `output/proposal/実装引き継ぎ書_20260924.md` で固定要件を確認し、`web/`、`lambda/`、`infrastructure/`、`test/`を変更する |
| 設計判断の背景を知る | `context.md` → `output/proposal/サンプルアプリ企画_20260924.md` |
| 企画を変更する | `context.md` の決定事項 → 企画書の該当章 → 実装引き継ぎ書とREADMEを同期する |

## 実装済み成果物

| パス | 内容 |
|---|---|
| `web/` | CesiumJSビューア、属性フィルター、着色、プリセット、URL状態共有、Cognito PKCE、保存・一覧・共有・削除UI |
| `lambda/` | JWT `sub`で所有者を決める保存ビューCRUD API。入力スキーマ、サイズ、UUID、所有者を検証 |
| `infrastructure/` | S3 + CloudFront OAC、Cognito、HTTP API、Lambda、DynamoDB、Budgetsを定義するAWS CDK |
| `scripts/` | Cesium資産同期、フォールバックタイル準備、デプロイ入力検証、シークレット検査 |
| `test/` | Vitest単体・CDK assertionテストとPlaywright E2E |
| `README.md` | ローカル実行、検証、デプロイ、フォールバック、認証・認可、削除手順 |
| `context.md` | 案件前提、決定事項、検証済み事項、残作業 |
| `output/proposal/サンプルアプリ企画_20260924.md` | 企画の全体像、ADR、W-A 6柱、リスク表、デモストーリー |
| `output/proposal/実装引き継ぎ書_20260924.md` | 属性、API契約、DynamoDB設計、実装順序、完成確認チェックリスト |

## ローカル検証実績

- 人間によるローカル画面確認: 完了
- Vitest: 14ファイル、188件成功
- Playwright E2E: 5件成功
- TypeScript型検査、Vite本番ビルド、CDK synth: 成功
- `npm audit`: 脆弱性0件
- Gitleaksとgit-secrets: Git全履歴・作業ツリーとも検出0件
- 独立レビュー: Blocker / High / Medium 0件、APPROVED
- フォールバックタイル: `.cache/fallback-tiles/`の635ファイルを専用S3へ同期済み

## AWS実環境検証実績

- CloudFormation stack: `UPDATE_COMPLETE`（`us-east-1`）
- CloudFront: `Deployed`。ルートとSPA routeは200、欠損静的ファイル・欠損タイルは403
- 実ブラウザ診断: preflight / PLATEAU表示とも成功、出典表示を確認
- S3: Web・tilesともpublic access block、SSE-S3、直接アクセス403、CloudFront OAC経由
- API: CloudFront originだけCORS許可、localhostは不許可、未認証POSTは401
- Cognito: 自己サインアップ無効、Authorization Code Grant、CloudFront callback/logoutのみ。テストユーザー2名を作成済みで`FORCE_CHANGE_PASSWORD`。Cognito標準Managed Login Brandingを作成し、実ブラウザでemail/password form表示を確認
- Lambda: Node.js 22でActive。DynamoDBとGSIはActive、PAY_PER_REQUEST
- Budget: 月額10 USD、実費80%通知、通知先subscriberを確認
- フォールバック: 専用S3へ635ファイル（203,290,095 bytes）を同期済み。`/tiles/*` invalidation完了、URL有効化済み、root/child/b3dmをCloudFront経由で200確認

## 確定済みの重要判断（変更時に覆さない）

1. **構成は Pattern A**: S3+CloudFront / Cognito / API Gateway HTTP API / Lambda / DynamoDB
2. **3D描画とフィルターは100%クライアントサイド**。Lambdaによるタイルプロキシは作らない
3. **認証の対象は本アプリが追加する書き込みパスと一覧API**。公開PLATEAUデータを認証で守らない
4. **読み取りは公開、書き込みと一覧は認証**
5. **一覧は自分のビューのみ**。所有者は `event.requestContext.authorizer.jwt.claims.sub` から取得し、クライアント入力を信用しない
6. **出典表記は削らない**（PLATEAUのライセンス上の必須事項）
7. Lambda@Edgeによる静的ファイルの認証保護は不採用
8. **全AWSリソースの接頭辞は `sample-app-plateau-lens`** に統一する。公式ロゴ・公式カラーを使わず、サブタイトルに「非公式」を明記する
9. フォールバックURLは、タイルをS3へ投入してCloudFront invalidationを確認した後だけ有効化する
10. AWSリソースは短期サンプル用で、`cdk destroy`時に削除する。実行前に対象と影響の明示確認が必要
11. **デプロイ先リージョンは`us-east-1`**。Budget月額上限は10 USD、`DEV_ORIGIN`は指定しない

## AWSデプロイ前後の残作業

1. 対象devアカウント、`us-east-1`、AdminプロファイルのAccountとRoleは確認済み。CDK bootstrap version 32は完了
2. Budget通知先と月額上限10 USDは確定・作成・読み取り検証済み。`DEV_ORIGIN`は指定していない
3. 1回目のRouteSettings表記不備、2回目のStage/Route作成順序競合を修正し、3回目の初回deployは`CREATE_COMPLETE`
4. フォールバックタイル635ファイルを専用S3へ同期し、`/tiles/*` invalidation後にURLを有効化済み。CloudFront経由のroot/child/b3dmは200
5. Cognitoテストユーザー2名とCognito標準Managed Login Brandingは作成済み。実ブラウザでlogin form表示を確認
6. 招待メール到達と初回パスワード変更を確認する
7. 初回ログイン後、実環境でPKCE、JWT `sub`、別所有者DELETE 403、公開共有、GSI収束、実障害時のフォールバック切り替えを確認する
8. ハッカソン後の削除日と担当者を確定し、明示承認後に削除する

## 除外対象

- ワークスペース内の他案件フォルダは本案件と無関係
- `node_modules/`、`dist/`、`cdk.out/`、`.cache/`、Playwright結果、セッション固有レビュー文書は生成物またはローカル作業物としてGit対象外
