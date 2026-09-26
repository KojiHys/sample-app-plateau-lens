# PLATEAUハッカソン サンプルアプリ

## 基本情報

| 項目 | 値 |
|---|---|
| 顧客名 | TBD（ハッカソン主催者。国土交通省系イベントか、コミュニティ主催か未確認） |
| 案件名 | PLATEAUオープンデータ活用ハッカソン 参加者向けサンプルアプリケーション |
| リポジトリ名 | `sample-app-plateau-lens` |
| 表示名 | PLATEAU Lens |
| Opportunity ID | TBD |
| Account ID | TBD |
| SFDC Link | TBD |
| フェーズ | managed login branding更新・ログインフォーム復旧完了（初回ログイン・実認証検証待ち） |
| 最終更新 | 2026-09-25 |

## 案件背景

PLATEAU（国土交通省の3D都市モデル）のオープンデータ活用をテーマとしたハッカソンが開催される。参加者にAWS上での実装イメージを持ってもらうため、リファレンスとなるサンプルアプリケーションを用意する。企画、実装、ローカル検証、`us-east-1`へのdeploy、基盤検証、フォールバック有効化、テストユーザー2名の作成、managed login branding更新は完了した。現在は招待メール受信後の初回ログインと認証・認可の実ユーザー検証を残している。

## 体制

| 役割 | 組織 / 担当 |
|---|---|
| 顧客側オーナー | TBD（ハッカソン主催者） |
| 顧客側技術窓口 | TBD |
| パートナー / SI | ― |
| 運用事業者 | ― |
| 競合 | ― |

## アーキテクチャ前提

- **対象システム**: PLATEAU 3D都市モデルのブラウザビューア + フィルター機能 + ビュー共有API
- **現行環境**: 新規構築（既存システムなし）
- **主要ミドルウェア**: CesiumJS（3D描画）、Amazon Cognito、API Gateway HTTP API、Lambda、DynamoDB、S3 + CloudFront
- **移行方式の想定**: 該当なし（新規）

## 制約条件

| 種別 | 内容 |
|---|---|
| コンプライアンス | 特になし（オープンデータのみ扱う。個人情報を保持しない設計とする） |
| リージョン | us-east-1（デプロイ先として確定）。Lambda@Edgeは引き続き不採用 |
| 予算 | 月額 10 USD。実費が80%を超えた時点で通知（支出停止機能ではない） |
| 可用性 / DR | ハッカソンのデモ用途。SLA要件なし。ただし当日動かないと価値がゼロになるため、外部依存の縮退手段は用意する |
| 性能 | 参加者PCのブラウザ描画性能が事実上のボトルネック |
| ライセンス | PLATEAUデータは PDL1.0（CC BY 4.0 互換）。**アプリ内に出典表記が必須** |
| 技術制約（ユーザー指定） | Webブラウザベース / PLATEAU 3Dデータ使用 / フィルターレイヤー描画 / AWSサーバレスのみ / Cognito認証必須 |

## スケジュール

| 時期 | マイルストーン |
|---|---|
| 2026-09-24（木） | 企画（完了）。`output/proposal/サンプルアプリ企画_20260924.md` |
| 2026-09-25（金） | 実装・ローカル検証・AWS deploy・フォールバック有効化完了 |
| **2026-09-26（土）** | **ハッカソン開催（確定）** |
| 2026年10月上旬 | リソース削除 |

## 技術検証状況

### 検証済み（2026-09-24 実測）

| 項目 | 結果 |
|---|---|
| PLATEAU配信サービスのCORS | `api.plateauview.mlit.go.jp`、`assets.cms.plateau.reearth.io`、`tile.plateauview.mlit.go.jp` いずれも `access-control-allow-origin: *`。**ブラウザから直接ロード可能。プロキシ不要** |
| 3D Tiles実体のホスト先 | 複合 tileset.json は `assets.cms.plateau.reearth.io`（Re:Earth CMS）を参照。MLIT以外の外部依存が1つ増える |
| フィルター可能な属性 | 千代田区 LOD2 の tileset.json `properties` に63項目。用途・高さ・階数・建蔽率・容積率・用途地域・耐火構造種別に加え、**建物単位の浸水深／浸水ランクが事前結合済み**。数値項目は min/max 付き（スライダーUIにそのまま使える） |
| 認証方式 | Cognito managed login + Authorization Code Grant with PKCE、`AllowAdminCreateUserOnly` で自己サインアップ抑止、HTTP API の JWT authorizer で保護 |
| JWT authorizer のルート単位設定 | **1つのHTTP APIに認証あり／なしのルートを混在させられる**。クレームは `event.requestContext.authorizer.jwt.claims` でLambdaに渡る |
| API Gateway のスロットリング | HTTP API はルートレベルでのスロットリング設定が可能（`update-stage --route-settings`）。アカウントレベル上限を超えない範囲 |
| エッジ認証の可否 | CloudFront Functions はネットワーク呼び出し不可のため JWKS 検証ができない。静的ファイルまで隠すなら Lambda@Edge が必要（us-east-1、環境変数なし、同一イベントで CFF と併用不可）。**今回は不採用** |

### 実装・ローカル検証済み

| 項目 | 結果 |
|---|---|
| Cesium ion非依存 | 実ブラウザでPLATEAUタイルと建物描画を確認。`cesium.com`宛て通信0件 |
| 日本語・記号入り属性 | CesiumJS 1.145で `${feature["属性名"]}` 形式を実評価し、浸水深フィルターが動作 |
| Tier 1 | 属性フィルター、着色、プリセット、属性パネル、状態URL、出典表示を実装。人間による画面確認完了 |
| Tier 2 | Cognito PKCE、保存、マイビュー一覧、公開共有、所有者限定削除を実装。ローカルE2EはAPIをモックして確認 |
| 外部配信縮退 | 子タイル3回失敗または15秒タイムアウトで一度だけフォールバックへ交換。実ブラウザE2Eで確認 |
| Lambda | JWT `sub`による所有者決定、厳格な保存状態スキーマ、GSI Query、条件付きDELETEを実装 |
| CDK | S3+CloudFront OAC、Cognito、HTTP API、Lambda、DynamoDB、Budgetsをsynth。保持リソースなし |
| 自動検証 | Vitest 188件、Playwright 5件、型検査、本番ビルド、CDK synthが成功 |
| セキュリティ検査 | `npm audit`脆弱性0件。Gitleaksとgit-secretsでGit全履歴・作業ツリーとも検出0件 |
| フォールバックデータ | `.cache/fallback-tiles/`の635ファイルを専用S3へ同期し、CloudFront invalidation後にURLを有効化。root/child/b3dmの200を確認 |

### 実AWS検証済み（2026-09-25）

- CloudFormation stackは`us-east-1`で`CREATE_COMPLETE`。CDK bootstrap version 32
- CloudFrontは`Deployed`。ルートとSPA routeは200、欠損静的ファイル・欠損タイルは403
- 実ブラウザ診断でpreflightとPLATEAU表示が成功し、出典表示を確認
- Web・tiles S3はpublic access blockとSSE-S3を設定。S3直接アクセスは403、CloudFrontはOAC経由
- API CORSはCloudFront originだけを許可し、localhostにはCORSヘッダーを返さない
- `POST /views`、`GET /views`、`DELETE /views/{viewId}`はJWT必須。公開`GET /views/{viewId}`は認証なし。未認証POSTは401
- POST/DELETE routeのスロットリングはburst 5、rate 2
- Cognitoは自己サインアップ無効、Authorization Code Grant、CloudFront callback/logoutのみ。テストユーザー2名はEnabledかつ`FORCE_CHANGE_PASSWORD`
- Cognito標準Managed Login Brandingは`CREATE_COMPLETE`。既存User Pool/client/domain/userを維持し、実ブラウザでemail/password form表示を確認
- LambdaはNode.js 22でActive。DynamoDB tableとGSIはActive、PAY_PER_REQUEST。Log Group保持は7日
- Budgetは月額10 USD、実費80%通知、通知先subscriberを確認
- runtime configは`us-east-1`、CloudFront redirect URI、フォールバックURLを設定済み
- 専用S3の`tiles/`配下は635オブジェクト、203,290,095 bytes。CloudFront `/tiles/*` invalidation完了。root tileset、参照child JSON、sample b3dmは200

### 未検証（招待メール受信・初回ログイン後に確認）

- Cognito managed loginの実Authorization Code + PKCEフローとtoken endpoint
- API Gateway JWT authorizerからLambdaへ渡る実`sub`、issuer、audience
- 別所有者DELETEの403、GSI反映後の一覧収束
- 保存ビューの公開共有
- 実障害時の自動フォールバック切り替え（ローカルE2Eでは検証済み）

## 決定事項

1. **開催日: 2026-09-26（土）**。実装は 09-25（金）1日のみ。Tier 1（バックエンドなし）→ Tier 2（認証と永続化）の順で積み、Tier 1 単独でデモ成立させる
2. **認証で守る対象**: PLATEAUデータ（公開オープンデータ）ではなく、本アプリが追加する書き込みパスと一覧API。認証を残す根拠は「いたずら防止」ではなく**参加者が自分のアプリで使う型の提示（教材価値）**。Lambda@Edge による静的ファイル保護は不採用
3. **構成**: Pattern A（S3+CloudFront / Cognito / HTTP API / Lambda / DynamoDB）
4. **追加要件**: 保存ビューの一覧画面。認証で保護する。**画面のルートガードはUXであり、セキュリティ境界は `GET /views` の JWT authorizer と Lambda内の絞り込み**。所有者は `event.requestContext.authorizer.jwt.claims.sub` から取得し、クライアント入力を信用しない（IDOR対策）
5. **読み取りは公開、書き込みと一覧は認証**。共有用 viewId は推測不可能な UUID（capability URL）
6. **一覧は「自分のビュー」のみ**（Q-07）。全参加者のビュー一覧はスコープ外
7. **命名**: リポジトリ名 `sample-app-plateau-lens`。全AWSリソースの接頭辞も同一にして短縮しない（残存リソースを接頭辞で判別できるようにする）。表示名は `PLATEAU Lens`、サブタイトルに「非公式」を明記。公式ロゴ・公式カラーは使わない

## ブロッカー / 論点

ローカル実装と初回deployをブロックする論点はない。ハッカソン運用に向けて次を実施する。

1. 対象devアカウント、`us-east-1`、Adminプロファイル、CDK bootstrap version 32、初回deployの`CREATE_COMPLETE`を確認済み
2. Budgets通知先と月額上限10 USDは確定・作成・読み取り検証済み。Budgetは支出停止ではなく、実費80%超過時の通知
3. `DEV_ORIGIN`は指定していない。CloudFront originだけをAPI CORSとCognito callback/logout URLへ設定済み
4. フォールバックタイル635ファイルを専用S3へ同期し、CloudFront invalidation後にURLを有効化済み
5. Cognitoテストユーザー2名とCognito標準Managed Login Brandingは作成済み。実ブラウザでlogin form表示を確認
6. 招待メール到達と7日以内の初回パスワード変更を確認する
7. 初回ログイン後、実ユーザーで認証・認可・GSI・公開共有と、実障害時の自動フォールバック切り替えを確認する
8. ハッカソン後のリソース削除日と担当者を確定する

## 成果物

| 種別 | パス | 用途 |
|---|---|---|
| エージェント索引 | `AGENT_INDEX.md` | セッション開始時の起点、現在地、残作業 |
| 実行・運用手順 | `README.md` | ローカル実行、検証、デプロイ、フォールバック、削除 |
| フロントエンド | `web/` | CesiumJS、Tier 1、Cognito PKCE、保存ビューUI |
| バックエンド | `lambda/` | ビューCRUD、JWT所有者認可、入力検証 |
| IaC | `infrastructure/` | AWS CDKによる全サーバーレスリソース |
| テスト | `test/` | Vitest単体・CDK assertion、Playwright E2E |
| 補助スクリプト | `scripts/` | 資産同期、フォールバック取得、デプロイガード、シークレット検査 |
| 企画書 | `output/proposal/サンプルアプリ企画_20260924.md` | 判断の経緯、3パターン比較、W-A 6柱、リスク表 |
| 実装引き継ぎ書 | `output/proposal/実装引き継ぎ書_20260924.md` | 確定仕様、属性、API契約、完成確認チェックリスト |
