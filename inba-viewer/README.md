# 印旛沼周辺 3Dビューア

千葉県の印旛沼周辺を対象にした、CesiumJSの静的Webビューアです。地形、航空写真、3D建物、河川ベクタを重ねて表示します。PLATEAU Lens（`web/`）とは独立しており、ビルドもバックエンドも不要です。

すべて公的機関の配信サービスを直接参照し、自前のデータホスティングは行いません。Cesium ionは使いません。

## 使うデータ

| レイヤー | データ | 配信 |
|---|---|---|
| 地形 | PLATEAU-Terrain（quantized-mesh、楕円体高） | `https://tile.plateauview.mlit.go.jp/terrain` |
| 背景画像 | 地理院タイル（全国最新写真（シームレス）／標準地図） | `https://cyberjapandata.gsi.go.jp/xyz/...` |
| 3D建物 | PLATEAU 3D都市モデル（八千代市 LOD2、テクスチャなし） | `assets.cms.plateau.reearth.io` |
| 河川 | 国土数値情報 河川データ（W05、2008年度・千葉県） | 利用者が手元で変換（下記） |

PLATEAU-Terrainは地理院DEMにジオイド高を加えた楕円体高で配信されるため、PLATEAU 3D Tilesと高さが揃います。標高補正のコードはありません。

### 3D建物の範囲

2026-09時点のPLATEAUデータカタログでは、印西市・佐倉市・成田市の建築物モデルは未提供です。周辺で提供済みの八千代市（新川流域）だけを表示し、その他の地域には建物がありません。提供が始まったら、`config.js`の`buildings`配列へtileset.jsonのURLを追加します。

`api.plateauview.mlit.go.jp/datacatalog/3dtiles/{市区町村コード}-bldg-...-latest/tileset.json`は、未提供の市でも中身が空のtilesetを200で返します。読込エラーにならないため、URLはデータカタログAPIで実在を確かめてから追加してください。

```bash
curl -s -X POST https://api.plateauview.mlit.go.jp/datacatalog/graphql \
  -H 'content-type: application/json' \
  -d '{"query":"{ area(code:\"12\"){ ... on Prefecture { cities { code name datasets(input:{includeTypes:[\"bldg\"]}){ ... on PlateauDataset { items { lod texture url } } } } } } }"}'
```

## 動かす

リポジトリのルートで実行します。

```bash
npm ci
npm run inba:rivers   # 国土数値情報W05を取得し、inba-viewer/data/w05-inba.geojson を生成
npm run inba:dev      # http://127.0.0.1:5174/ で配信
```

`inba-viewer/`は静的ファイルだけで構成されているため、任意の静的サーバーでも動きます（例：`python3 -m http.server -d inba-viewer 5174`）。`file://`で直接開くと、ES moduleとGeoJSONの読み込みがブラウザに拒否されます。

河川GeoJSONがない場合、河川レイヤーだけが無効になり、画面に生成コマンドを表示します。

### 河川データの変換

`scripts/convert-w05.mjs`は外部パッケージを使わずに次を行います。

1. `W05-08_12_GML.zip`（千葉県、約2.9 MB）を取得する。手元のzipは`--zip <path>`で渡せる
2. zip内の`W05-08_12-g_Stream.shp`と`.dbf`（Shift_JIS）を読む
3. 経度139.95〜140.40、緯度35.60〜35.95と交差する流路（約650件）を残す
4. 属性はW05の元のキー（`W05_001`〜`W05_006`）のままGeoJSONへ書き出す

GDALを使う場合の同等手順と、GMLではなくShapefileを変換元にする理由は、スクリプト冒頭のコメントに記載しています。

**W05の使用許諾条件は「非商用」です。** 生成したGeoJSONは`.gitignore`で除外しています。コミットや公開サーバーへの配置で再配布しないでください。

## 画面

- 左パネル：4レイヤー（地形・背景画像・3D建物・河川）のON/OFF、航空写真と標準地図の切替、河川の凡例、初期視点へ戻るボタン、各レイヤーの読込状態
- 河川をクリックすると、河川名、区間種別、河川コード、水系域コード、原典資料種別コード、流下方向をポップアップ表示する
- 右下：全データの出典を常時表示する
- 右上：ホーム（初期視点）、操作ヘルプ、ズームイン（＋）とズームアウト（－）。右下に全画面ボタン
- ズームボタンは、画面中央の地点までの距離を1回で半分または2倍にする。向きと画面中央の地点は変えない。近づける下限は50 m、カメラ高度の上限は300 km
- 操作：左ドラッグで移動、ホイールまたは右ドラッグでズーム、中ドラッグまたはCtrl+ドラッグでチルト・回転

河川の色はW05の区間種別（`W05_003`）で分けます。湖沼区間を兼ねる流路（5〜8）は太線です。印旛沼本体は「印旛水路」の1級指定区間（湖沼区間を兼ねる、6）として収録されています。名称不明の流路は細い灰色線です。

地形をOFFにすると地表が楕円体面（高さ0 m）になるため、楕円体高で配置された3D建物は約40 m浮いて見えます。

## 設定

`config.js`の先頭にまとめています。

| キー | 内容 | 既定値 |
|---|---|---|
| `area.centerLatitude` / `centerLongitude` | 画面中央に来る注視点 | 35.77 / 140.20 |
| `area.cameraHeightMeters` | カメラの楕円体高 | 8000 |
| `area.headingDegrees` / `pitchDegrees` | 向きと俯角 | 0（北） / -45 |
| `terrain.url` | PLATEAU-TerrainのURL | 上表 |
| `imagery.layers.*.url` | 地理院タイルのURLテンプレート | 上表 |
| `imagery.boundsDegrees` | 地理院タイルを要求する範囲 | 日本周辺 |
| `buildings[]` | PLATEAU 3D TilesのURLと表示名 | 八千代市 |
| `rivers.url` | 河川GeoJSONのパス | `./data/w05-inba.geojson` |

カメラは注視点から南へ下がった位置に置き、注視点が画面中央に来るようにしています。注視点の真上にカメラを置くと、俯角-45°では画面中央が約8 km北へずれて、新川と花見川が画面外に出るためです。

## 出典

- 地形：[PLATEAU-Terrain](https://docs.plateauview.mlit.go.jp/datasets/terrain/)（PLATEAU | Mapterhorn | 国土地理院）
- 背景：[地理院タイル](https://maps.gsi.go.jp/development/ichiran.html)（国土地理院）
- 3D建物：[Project PLATEAU](https://www.mlit.go.jp/plateau/) 3D都市モデル（PDL1.0、CC BY 4.0互換）
- 河川：[国土数値情報（河川データ）](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-W05.html)（国土交通省）を加工して作成

CesiumJS 1.145.0はjsDelivrからSRI付きで読み込みます。バージョンを上げる場合は、`index.html`の`integrity`も更新してください。
