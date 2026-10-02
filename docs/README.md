# 温泉番付のGitHub Pagesコンセプト

公開入口は`index.html`。利用者向け説明は`concept.html`、詳しい設計は[concept.md](./concept.md)。採点基準1.1の全246基本項目と条件別項目から、任意の重み・希望帯・分野予算で番付を計算します。必須条件は生値のAND/OR/NOTで判定します。公開データの調査範囲はmanifestと画面に表示します。

公開データは指定10温泉地・60利用プランの初回部分調査です。[検証結果](./reports/pilot10.html)に地域別の根拠・全基本項目・調査残を掲載しています。架空の公開デモは削除しました。

[現行公式一覧の対象対応表](./reports/roster.html)は温泉キャラクター135人から134の地域調査候補を整理しています。同じ有馬へ対応する2人を統合し、親地域と下位地区の重なりを保持しています。互いに重ならない134温泉地の確定ではありません。指定10地域以外の124候補と、未確認の入浴可否は未調査として残します。

## ローカル確認

リポジトリのルートで次を実行し、`http://127.0.0.1:8765/docs/`を開いてください。JavaScript moduleとJSON fetchを使うため、`file://`で直接開く方法には対応しません。

```sh
python3 -m http.server 8765 --bind 127.0.0.1
```

Node.js 22以降で採点・公開データ・画面入力から再計算と設定復元までを検証できます。画面のテストに開発用のjsdomを使います。

```sh
npm ci
npm test
python3 -m unittest discover -s tests -p 'test_public_build.py'
```

## GitHub Pages

1. 公開対象ブランチに`docs/`を配置する。
2. GitHubのSettings → Pagesで「Deploy from a branch」を選び、ブランチと`/docs`を指定する。
3. 公開URLでJSON・CSS・JavaScriptが取得できることを確認する。

HTML・CSS・JavaScript・JSONのみで動きます。ビルドや採点サーバーは不要です。`.nojekyll`を含め、`./assets/`・`./data/`の相対URLを保持してください。[GitHub公式：公開元の設定](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

## データ変更

公開ファイルは`data/manifest.json`と`data/releases/<snapshot>/`です。新しい版を追加し、件数・参照ID・採点基準コピー・形式版を検証した後にmanifestを切り替えます。公開済みreleaseは上書きしない方針です。

`criteria/scoring-1.1.md`とrelease内の`rubric-1.1.json`はルート原本のコピーです。原本を更新した場合は新しい基準版・データ版として公開コピーを用意し、両者の一致を検証してください。

現行の公開版は`evidence_pilot`（形式版2）です。UIには旧形式`synthetic_demo`の読込互換もありますが、架空データを公開フォルダへ収録していません。未調査項目も選択できますが、E・[0,100]のまま加重計算し、暫定表示します。希望帯は公開行の生値と同じ単位で指定します。共有リンクは元のデータ版・基準版・比較曜日を保持し、異なる版に自動移行しません。

調査原本は`research/regions/<region-id>.json`です。各地域の試行は独立し、同じ固定尺度を使います。他地域の得点や標本最大最小は入力にしません。単独の台帳生成と、10地域をまとめた公開版生成は次のとおりです。

```sh
python3 build_public_data.py --region otemachi
python3 build_public_data.py --publish
```

単独生成は該当地域の台帳とレポートだけを更新します。`--publish`は10地域の入力を読み、索引・候補・対象対応表・manifestも生成します。現在の版は公開前の初回整備用です。公開後に調査を更新する場合は生成処理の`SNAPSHOT`も新しい版へ変更してください。

資料台帳の件数は地域ごとの登録件数です。同一URLの地域別重複と取得失敗の記録を含みます。料金の必須費用や供給対応の未確定な値を補完せず、片側の境界・未知・取得失敗として残しています。

公開データの検証にはmanifestの参照先が全てそろっている必要があります。生成中のreleaseや削除済みreleaseを、架空の値で補いません。
