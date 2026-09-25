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
| フェーズ | 実装・ローカル検証完了（AWSデプロイ待ち） |
| 最終更新 | 2026-09-24 |

## 案件背景

PLATEAU（国土交通省の3D都市モデル）のオープンデータ活用をテーマとしたハッカソンが開催される。参加者にAWS上での実装イメージを持ってもらうため、リファレンスとなるサンプルアプリケーションを用意する。企画、実装、ローカル検証は完了しており、対象AWSアカウントと運用情報を確認して非本番環境へデプロイする段階にある。

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
| リージョン | ap-northeast-1（対象データが日本国内、参加者も国内想定）。Lambda@Edge を使う場合のみ us-east-1 が必要 |
| 予算 | TBD（無料枠 + 数ドル/月を想定。ハッカソン期間限定） |
| 可用性 / DR | ハッカソンのデモ用途。SLA要件なし。ただし当日動かないと価値がゼロになるため、外部依存の縮退手段は用意する |
| 性能 | 参加者PCのブラウザ描画性能が事実上のボトルネック |
| ライセンス | PLATEAUデータは PDL1.0（CC BY 4.0 互換）。**アプリ内に出典表記が必須** |
| 技術制約（ユーザー指定） | Webブラウザベース / PLATEAU 3Dデータ使用 / フィルターレイヤー描画 / AWSサーバレスのみ / Cognito認証必須 |

## スケジュール

| 時期 | マイルストーン |
|---|---|
| 2026-09-24（木） | 企画（完了）。`output/proposal/サンプルアプリ企画_20260924.md` |
| 2026-09-25（金） | 実装・ローカル検証（完了）。AWSデプロイは別途実施 |
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
| フォールバックデータ | `.cache/fallback-tiles/`へ約195 MiB、635ファイルを準備し、全参照をローカル相対参照化。AWS未投入 |

### 未検証（AWSデプロイ後に確認）

- Cognito managed loginの実Authorization Code + PKCEフローとtoken endpoint
- API Gateway JWT authorizerからLambdaへ渡る実`sub`、issuer、audience
- 未認証POSTの401、別所有者DELETEの403、GSI反映後の一覧収束
- CloudFront経由のSPAとフォールバックタイル、S3直接アクセス拒否、欠損タイルの4xx
- CloudFront origin限定CORSとBudgets通知

## 決定事項

1. **開催日: 2026-09-26（土）**。実装は 09-25（金）1日のみ。Tier 1（バックエンドなし）→ Tier 2（認証と永続化）の順で積み、Tier 1 単独でデモ成立させる
2. **認証で守る対象**: PLATEAUデータ（公開オープンデータ）ではなく、本アプリが追加する書き込みパスと一覧API。認証を残す根拠は「いたずら防止」ではなく**参加者が自分のアプリで使う型の提示（教材価値）**。Lambda@Edge による静的ファイル保護は不採用
3. **構成**: Pattern A（S3+CloudFront / Cognito / HTTP API / Lambda / DynamoDB）
4. **追加要件**: 保存ビューの一覧画面。認証で保護する。**画面のルートガードはUXであり、セキュリティ境界は `GET /views` の JWT authorizer と Lambda内の絞り込み**。所有者は `event.requestContext.authorizer.jwt.claims.sub` から取得し、クライアント入力を信用しない（IDOR対策）
5. **読み取りは公開、書き込みと一覧は認証**。共有用 viewId は推測不可能な UUID（capability URL）
6. **一覧は「自分のビュー」のみ**（Q-07）。全参加者のビュー一覧はスコープ外
7. **命名**: リポジトリ名 `sample-app-plateau-lens`。全AWSリソースの接頭辞も同一にして短縮しない（残存リソースを接頭辞で判別できるようにする）。表示名は `PLATEAU Lens`、サブタイトルに「非公式」を明記。公式ロゴ・公式カラーは使わない

## ブロッカー / 論点

ローカル実装をブロックする論点はない。AWSデプロイ前後に次を確定・実施する。

1. 対象AWS Account ID、非本番環境であること、使用する最小権限プロファイルを確認する
2. 実在するBudgets通知先と月額上限を確定する
3. フォールバックタイルはローカル準備済み。初回デプロイ後に専用S3へ同期し、CloudFront invalidation後だけURLを有効化する
4. Cognitoテストユーザー2名の発行方法と使用するメールアドレスを確定する
5. 実AWSで認証・認可・CORS・OAC・GSI・フォールバック・Budgetを確認する
6. ハッカソン後のリソース削除日と担当者を確定する

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
