/**
 * 印旛沼周辺3Dビューアの設定。対象エリアやデータURLはここだけを変更する。
 * すべて公的機関の配信サービスを直接参照し、自前のデータホスティングは行わない。
 */
export const CONFIG = Object.freeze({
  // ---- 対象エリアと初期カメラ ----------------------------------------------
  area: {
    name: "印旛沼周辺（千葉県印西市・佐倉市・成田市ほか）",
    // 視点の注視点（画面中央に来る地点）。カメラはここから南へ下がった位置に置く。
    centerLatitude: 35.77,
    centerLongitude: 140.2,
    // カメラの楕円体高（m）
    cameraHeightMeters: 8000,
    headingDegrees: 0, // 北向き
    pitchDegrees: -45, // 斜め俯瞰
  },

  // ---- 地形: PLATEAU-Terrain（Cesium ion不要、楕円体高に変換済み） ----------
  // https://docs.plateauview.mlit.go.jp/datasets/terrain/
  // 楕円体高で配信されるため、ジオイド高の補正コードは書かない。
  terrain: {
    url: "https://tile.plateauview.mlit.go.jp/terrain",
    credit: "地形：PLATEAU | Mapterhorn | 国土地理院",
  },

  // ---- 背景画像: 地理院タイル ------------------------------------------------
  // https://maps.gsi.go.jp/development/ichiran.html
  imagery: {
    initial: "photo", // "photo" | "std"
    // タイルを要求する範囲 [west, south, east, north]（度）。日本の陸域を含む。
    boundsDegrees: [122, 20, 154, 46],
    layers: {
      photo: {
        label: "航空写真",
        url: "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg",
        minimumLevel: 2,
        maximumLevel: 18,
        credit: "背景：地理院タイル（全国最新写真（シームレス））",
      },
      std: {
        label: "標準地図",
        url: "https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png",
        minimumLevel: 5,
        maximumLevel: 18,
        credit: "背景：地理院タイル（標準地図）",
      },
    },
  },

  // ---- 3D建物: PLATEAU-3DTiles ---------------------------------------------
  // 2026-09時点のPLATEAUデータカタログでは、印西市（12231）・佐倉市（12212）・
  // 成田市（12211）の建築物モデルは未提供。周辺で提供済みの八千代市だけを読み込む。
  // 提供が始まったら、データカタログAPI（https://api.plateauview.mlit.go.jp/datacatalog/graphql）
  // で得たtileset.jsonのURLをこの配列へ追加する。
  // 注意: api.plateauview.mlit.go.jp/datacatalog/3dtiles/{市区町村コード}-bldg-...-latest/tileset.json
  // は、未提供の市でも中身が空のtilesetを200で返すため、読込エラーにならない。
  buildings: [
    {
      name: "八千代市（LOD2・テクスチャなし）",
      url: "https://assets.cms.plateau.reearth.io/assets/bf/68cbee-2c76-439d-8373-88d71d411cd5/12221_yachiyo-shi_city_2022_citygml_4_op_bldg_3dtiles_lod2_no_texture/tileset.json",
    },
  ],
  buildingCredit: "3D建物：国土交通省 Project PLATEAU 3D都市モデル（PDL1.0、CC BY 4.0互換）",

  // ---- 河川: 国土数値情報 河川データ（W05） ----------------------------------
  // 配布はShapefile/GMLのzipのみ。事前に次のスクリプトでGeoJSONへ変換する。
  //   node inba-viewer/scripts/convert-w05.mjs
  // 使用許諾条件は「非商用」。生成したGeoJSONは再配布しない（.gitignore済み）。
  rivers: {
    url: "./data/w05-inba.geojson",
    credit:
      "河川：国土数値情報（河川データ）国土交通省 を加工して作成（2008年度・関東地方、非商用）",
  },
});
