# 温泉番付のGitHub Pagesコンセプト

公開入口は`index.html`。利用者向け説明は`concept.html`、詳しい設計は[concept.md](./concept.md)。採点基準1.1に沿った、架空6温泉地・9浴槽・6評価軸の日帰りデモです。

## ローカル確認

リポジトリのルートで次を実行し、`http://127.0.0.1:8765/docs/`を開いてください。JavaScript moduleとJSON fetchを使うため、`file://`で直接開く方法には対応しません。

```sh
python3 -m http.server 8765 --bind 127.0.0.1
```

Node.js 22以降で採点とデータ整合性を検証できます。外部パッケージは不要です。

```sh
node --test --test-isolation=none tests/pages-scoring.test.mjs tests/pages-data.test.mjs
```

## GitHub Pages

1. 公開対象ブランチに`docs/`を配置する。
2. GitHubのSettings → Pagesで「Deploy from a branch」を選び、ブランチと`/docs`を指定する。
3. 公開URLでJSON・CSS・JavaScriptが取得できることを確認する。

HTML・CSS・JavaScript・JSONのみで動きます。ビルドや採点サーバーは不要です。`.nojekyll`を含め、`./assets/`・`./data/`の相対URLを保持してください。[GitHub公式：公開元の設定](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

## データ変更

公開ファイルは`data/manifest.json`と`data/releases/<snapshot>/`です。新しい版を追加し、件数・参照ID・採点基準コピー・形式版を検証した後にmanifestを切り替えます。公開済みreleaseは上書きしない方針です。

`criteria/scoring-1.1.md`とrelease内の`rubric-1.1.json`はルート原本のコピーです。原本を更新した場合は新しい基準版・データ版として公開コピーを用意し、両者の一致を検証してください。

現在のUIは`synthetic_demo`かつ形式版1専用です。実在データを投入する前に、出典台帳・確認日・条件整合の生成処理を整備し、架空データと混在しない別releaseとして対応させてください。
