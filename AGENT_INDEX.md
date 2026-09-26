# AGENT_INDEX — PLATEAUハッカソン サンプルアプリ

この案件でセッションを開始したエージェント向けの索引。タスク別に読む順序と現在地を示す。

## 案件の状態

| 項目 | 内容 |
|---|---|
| フェーズ | デモ用開発完了。主要経路を実AWSで確認済み、追加検証と後日削除を保留 |
| **リポジトリ名** | **`sample-app-plateau-lens`** |
| 表示名 | PLATEAU Lens |
| 実装ブランチ | `main` |
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
| デプロイのLesson Learnedを確認する | `output/retrospective/振り返りメモ_20260926.md` |
| 企画を変更する | `context.md` の決定事項 → 企画書の該当章 → 実装引き継ぎ書とREADMEを同期する |

## 実装済み成果物

| パス | 内容 |
|---|---|
| `web/` | CesiumJSビューア、属性フィルター、着色、プリセット、URL状態共有、Cognito PKCE、保存・一覧・共有・削除UI、3D表示設定（航空写真・地形・テクスチャ・影と光・2D/3D・視点リセット） |
| `lambda/` | JWT `sub`で所有者を決める保存ビューCRUD API。入力スキーマ、サイズ、UUID、所有者を検証 |
| `infrastructure/` | S3 + CloudFront OAC、Cognito、HTTP API、Lambda、DynamoDB、Budgetsを定義するAWS CDK |
| `scripts/` | Cesium資産同期、フォールバックタイル準備、デプロイ入力検証、シークレット検査 |
| `test/` | Vitest単体・CDK assertionテストとPlaywright E2E |
| `README.md` | ローカル実行、検証、デプロイ、フォールバック、認証・認可、削除手順 |
| `context.md` | 案件前提、決定事項、検証済み事項、残作業 |
| `output/proposal/サンプルアプリ企画_20260924.md` | 企画の全体像、ADR、W-A 6柱、リスク表、デモストーリー |
| `output/proposal/実装引き継ぎ書_20260924.md` | 属性、API契約、DynamoDB設計、実装順序、完成確認チェックリスト |
| `output/retrospective/振り返りメモ_20260926.md` | AWSデプロイ障害、復旧、Lesson Learned、次回チェックリスト |

## ローカル検証実績

- 人間によるローカル画面確認: 完了
- Vitest: 16ファイル、205件成功（3D表示追加後）
- Playwright E2E: 6件成功（3D表示追加後）
- TypeScript型検査、Vite本番ビルド、CDK synth: 成功
- `npm audit`: 脆弱性0件
- Gitleaksとgit-secrets: Git全履歴・作業ツリーとも検出0件
- 独立レビュー: Blocker / High / Medium 0件、APPROVED
- フォールバックタイル: `.cache/fallback-tiles/`の635ファイルを専用S3へ同期済み

## AWS実環境検証実績

- CloudFormation stack: `UPDATE_COMPLETE`（`us-east-1`、2026-09-26に3D表示のWeb資産を再デプロイ）
- CloudFront: `Deployed`。ルートとSPA routeは200、欠損静的ファイル・欠損タイルは403
- 実ブラウザ診断: preflight / PLATEAU表示とも成功、出典表示を確認
- S3: Web・tilesともpublic access block、SSE-S3、直接アクセス403、CloudFront OAC経由
- API: CloudFront originだけCORS許可、localhostは不許可、未認証POSTは401。2名の実ユーザーで保存と所有者別一覧を確認
- Cognito: 自己サインアップ無効、Authorization Code Grant、CloudFront callback/logoutのみ。テストユーザー2名は`CONFIRMED`。Cognito標準Managed Login Brandingを作成し、実ログイン成功
- DynamoDB/GSI: 2名のCognito `sub`ごとに保存ビューが分離し、未ログイン公開共有は200。公開レスポンスに`ownerSub`とemailを含めない
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
12. **地形はCesium ionを使わない**。国土地理院の標高タイルに千代田区のジオイド高36.9 mを加えて楕円体高に合わせる。Cesium ionの無料プランは企業・政府用途に使えないため不採用。ionの地形は有償ライセンス確保後に別PRで検討する
13. **3D表示設定はURL状態と保存ビューに含めない**。v1スキーマと既存データの互換性を保つ

## 3D表示のデプロイ（2026-09-26）

- PR #4をWeb資産だけの再デプロイで反映した。`cdk diff`はWebDeploymentのzip差し替えのみで、デプロイ後は差分なし
- CloudFront上で、preflight合格、ion非依存、航空写真、国土地理院の標高タイル取得、初期の斜め俯瞰を実ブラウザで確認した
- 標高タイルの自前配信（S3ミラー）は行わない（2026-09-26にユーザーが不要と判断）。国土地理院から直接取得し、失敗時は平面で表示する

## 開発完了時の保留事項

デモ成立に必要な実装・deploy・主要経路検証は完了した。次は保留する。

1. 別所有者によるDELETEが403になる実ユーザー検証
2. プライマリ配信を意図的に失敗させる実環境フォールバック検証
3. 検証用DynamoDB itemの整理
4. ハッカソン後の削除日と担当者の確定
5. 明示承認後のアプリstack削除と、CDK bootstrap resourceを削除するかの判断

## 除外対象

- ワークスペース内の他案件フォルダは本案件と無関係
- `node_modules/`、`dist/`、`cdk.out/`、`.cache/`、Playwright結果、セッション固有レビュー文書は生成物またはローカル作業物としてGit対象外
