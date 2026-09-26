# Git変更の取り込み手順

このリポジトリの変更は、topicブランチからPRを作り、`main`へマージする。`main`へ直接コミットやpushをしない。

## 1. ブランチを作る

1. `git switch main && git pull --ff-only`で`main`を最新にする。
2. 作業ツリーがクリーンであることを`git status -sb`で確認する。
3. 用途に合う接頭辞でブランチを作る。`feat/`、`fix/`、`docs/`、`chore/`、`test/`のいずれかを使う。

## 2. 変更を検証する

変更範囲に合わせて、コミット前に次を実行する。

| 変更範囲 | 実行するコマンド |
|---|---|
| `web/`、`lambda/`、`infrastructure/`、`scripts/`、`test/` | `npm run typecheck`、`npm test`、`npm run build`、`npm run synth -- -c budgetEmail=alerts@example.com -c budgetAmount=10` |
| UIやタイル読込の挙動 | 上記に加えて`npm run test:e2e` |
| ドキュメントだけ | `npm run secrets:scan` |

失敗した場合は原因を直してから次へ進む。

## 3. コミットする

- ステージは`git add <path>`でファイルを名前指定する。`git add -A`や`git add .`は使わない。
- メッセージはConventional Commits形式にする（例：`feat: add storm surge filter`、`docs: update README`）。
- 1つのPRには1つの目的の変更だけを入れる。

## 4. pushする

- `git push -u origin <branch>`を実行する。
- `.githooks/pre-push`がGit Defenderと`scripts/scan-secrets.sh`を順に実行する。`--no-verify`で回避しない。検出があれば値を除去してからpushし直す。

## 5. PRを作る

- `gh`が使える場合は`gh pr create --base main`で作る。使えない場合は`https://github.com/KojiHys/sample-app-plateau-lens/compare/main...<branch>?expand=1`をユーザーに示す。
- 本文には、目的、主な変更点、実行した検証とその結果を書く。

## 6. マージする

- マージはユーザーの承認を得てから行う。
- 既存履歴に合わせてmerge commitでマージする。

## 7. マージ後に片付ける

1. `git switch main && git pull --ff-only`で`main`を同期する。
2. `git merge-base --is-ancestor <branch> main`でtopicブランチがマージ済みであることと、作業ツリーがクリーンであることを確認する。
3. `git branch -d <branch>`でローカルブランチを消す。`-D`で強制削除しない。
4. リモートにブランチが残っていれば`git push origin --delete <branch>`で消す。
5. `git fetch --prune`を実行し、`git branch -a`でローカルとリモートに`main`だけが残っていることを確認する。

AWSへのデプロイはこの手順に含めない。`README.md`の「AWSへデプロイする前の確認」に従い、対象と影響を示して別途承認を得る。
