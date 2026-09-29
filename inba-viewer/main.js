import { CONFIG } from "./config.js";

const Cesium = window.Cesium;
if (!Cesium) {
  throw new Error("CesiumJSを読み込めませんでした。ネットワーク接続を確認してください。");
}

// 国土数値情報W05「区間種別（W05_003）」の列挙値。lake=true は湖沼区間を兼ねる流路。
const SECTION_TYPES = {
  1: { label: "1級直轄区間", color: "#ff453a", lake: false },
  2: { label: "1級指定区間", color: "#ffd60a", lake: false },
  3: { label: "2級河川区間", color: "#32d74b", lake: false },
  4: { label: "指定区間外", color: "#64d2ff", lake: false },
  5: { label: "1級直轄区間（湖沼区間を兼ねる）", color: "#ff453a", lake: true },
  6: { label: "1級指定区間（湖沼区間を兼ねる）", color: "#ffd60a", lake: true },
  7: { label: "2級河川区間（湖沼区間を兼ねる）", color: "#32d74b", lake: true },
  8: { label: "指定区間外（湖沼区間を兼ねる）", color: "#64d2ff", lake: true },
  0: { label: "不明", color: "#c7c7cc", lake: false },
};
const LEGEND_CODES = [1, 2, 3, 4, 0];
const SELECTED_COLOR = Cesium.Color.fromCssColorString("#ff2dd4");

// ---- DOM -------------------------------------------------------------------

function element(id) {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`#${id} が見つかりません`);
  }
  return found;
}

const statusList = element("layer-status");
const statusItems = new Map();

function setStatus(key, state, text) {
  let item = statusItems.get(key);
  if (!item) {
    item = document.createElement("li");
    statusItems.set(key, item);
    statusList.append(item);
  }
  item.dataset.state = state;
  item.textContent = text;
}

function renderAttribution() {
  const entries = [
    { text: CONFIG.terrain.credit, href: "https://docs.plateauview.mlit.go.jp/datasets/terrain/" },
    {
      text: `${CONFIG.imagery.layers.photo.credit}、${CONFIG.imagery.layers.std.credit.replace("背景：", "")}`,
      href: "https://maps.gsi.go.jp/development/ichiran.html",
    },
    { text: CONFIG.buildingCredit, href: "https://www.mlit.go.jp/plateau/" },
    { text: CONFIG.rivers.credit, href: "https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-W05.html" },
  ];
  const list = element("attribution-list");
  for (const entry of entries) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = entry.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = entry.text;
    item.append(link);
    list.append(item);
  }
}

function renderRiverLegend() {
  const list = element("river-legend");
  for (const code of LEGEND_CODES) {
    const type = SECTION_TYPES[code];
    const item = document.createElement("li");
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = type.color;
    item.append(swatch, document.createTextNode(`${type.label}（${code}）`));
    list.append(item);
  }
}

// ---- Viewer ----------------------------------------------------------------

// Cesium ionは使わない。空トークンにして、誤ってionを参照したら失敗が見えるようにする。
Cesium.Ion.defaultAccessToken = "";

const ellipsoidTerrain = new Cesium.EllipsoidTerrainProvider();
const viewer = new Cesium.Viewer("cesiumContainer", {
  animation: false,
  baseLayer: false,
  baseLayerPicker: false,
  fullscreenButton: true,
  geocoder: false,
  homeButton: true,
  infoBox: false,
  navigationHelpButton: true,
  navigationInstructionsInitiallyVisible: false,
  sceneModePicker: false,
  selectionIndicator: false,
  terrainProvider: ellipsoidTerrain,
  timeline: false,
});
viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#1d2b38");
viewer.scene.globe.depthTestAgainstTerrain = true;

function flyHome(duration = 1.2) {
  const { area } = CONFIG;
  const pitch = Cesium.Math.toRadians(area.pitchDegrees);
  const target = Cesium.Cartesian3.fromDegrees(area.centerLongitude, area.centerLatitude, 0);
  // カメラ高度 = 距離 × sin(俯角)。注視点が画面中央に来るよう距離を逆算する。
  const range = area.cameraHeightMeters / Math.sin(Math.abs(pitch));
  viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(target, 0), {
    duration,
    offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(area.headingDegrees), pitch, range),
  });
}

flyHome(0);
viewer.homeButton.viewModel.command.beforeExecute.addEventListener((event) => {
  event.cancel = true;
  flyHome();
});
element("reset-view").addEventListener("click", () => flyHome());

// ---- 1. 地形 ---------------------------------------------------------------

const terrainToggle = element("toggle-terrain");
let plateauTerrain = null;

function applyTerrain() {
  const provider = terrainToggle.checked && plateauTerrain ? plateauTerrain : ellipsoidTerrain;
  if (viewer.terrainProvider !== provider) {
    viewer.terrainProvider = provider;
  }
  viewer.scene.globe.depthTestAgainstTerrain = provider !== ellipsoidTerrain;
}

async function loadTerrain() {
  setStatus("terrain", "loading", "地形：読込中");
  try {
    plateauTerrain = await Cesium.CesiumTerrainProvider.fromUrl(CONFIG.terrain.url, {
      requestVertexNormals: true,
    });
    applyTerrain();
    setStatus("terrain", "ok", "地形：PLATEAU-Terrain");
  } catch (error) {
    console.error("PLATEAU-Terrain failed to load", error);
    terrainToggle.disabled = true;
    setStatus("terrain", "error", "地形：読み込めませんでした（平面で表示）");
  }
}
terrainToggle.addEventListener("change", applyTerrain);

// ---- 2. 背景画像 -------------------------------------------------------------

const imageryToggle = element("toggle-imagery");
const imageryRadios = [...document.querySelectorAll('input[name="imagery"]')];
const imageryLayers = {};
// 地理院タイルは日本周辺だけを配信する。範囲外を要求して404を出さないよう制限する。
const [west, south, east, north] = CONFIG.imagery.boundsDegrees;
const imageryRectangle = Cesium.Rectangle.fromDegrees(west, south, east, north);
for (const [key, layer] of Object.entries(CONFIG.imagery.layers)) {
  imageryLayers[key] = viewer.imageryLayers.addImageryProvider(
    new Cesium.UrlTemplateImageryProvider({
      url: layer.url,
      minimumLevel: layer.minimumLevel,
      maximumLevel: layer.maximumLevel,
      rectangle: imageryRectangle,
      credit: layer.credit,
    }),
  );
}
let selectedImagery = CONFIG.imagery.initial in imageryLayers ? CONFIG.imagery.initial : "photo";

function applyImagery() {
  for (const [key, layer] of Object.entries(imageryLayers)) {
    layer.show = imageryToggle.checked && key === selectedImagery;
  }
  for (const radio of imageryRadios) {
    radio.checked = radio.value === selectedImagery;
    radio.disabled = !imageryToggle.checked;
  }
  const label = CONFIG.imagery.layers[selectedImagery].label;
  setStatus("imagery", "ok", imageryToggle.checked ? `背景：地理院タイル（${label}）` : "背景：非表示");
}
imageryToggle.addEventListener("change", applyImagery);
for (const radio of imageryRadios) {
  radio.addEventListener("change", () => {
    if (radio.checked && radio.value in imageryLayers) {
      selectedImagery = radio.value;
      applyImagery();
    }
  });
}

// ---- 3. 3D建物 -------------------------------------------------------------

const buildingsToggle = element("toggle-buildings");
const buildingTilesets = [];

async function loadBuildings() {
  if (CONFIG.buildings.length === 0) {
    setStatus("buildings", "ok", "3D建物：設定なし");
    return;
  }
  setStatus("buildings", "loading", "3D建物：読込中");
  const results = await Promise.allSettled(
    CONFIG.buildings.map((source) =>
      Cesium.Cesium3DTileset.fromUrl(source.url, { maximumScreenSpaceError: 16 }),
    ),
  );
  const failed = [];
  results.forEach((result, index) => {
    const source = CONFIG.buildings[index];
    if (result.status === "fulfilled") {
      const tileset = result.value;
      tileset.style = new Cesium.Cesium3DTileStyle({ color: "color('#f4f1ea')" });
      tileset.show = buildingsToggle.checked;
      viewer.scene.primitives.add(tileset);
      buildingTilesets.push(tileset);
    } else {
      console.error(`PLATEAU 3D Tiles failed to load: ${source.name}`, result.reason);
      failed.push(source.name);
    }
  });
  const loadedNames = CONFIG.buildings
    .filter((_, index) => results[index].status === "fulfilled")
    .map((source) => source.name);
  if (failed.length === 0) {
    setStatus("buildings", "ok", `3D建物：${loadedNames.join("、")}`);
  } else {
    buildingsToggle.disabled = buildingTilesets.length === 0;
    setStatus("buildings", "error", `3D建物：読込失敗（${failed.join("、")}）`);
  }
}
buildingsToggle.addEventListener("change", () => {
  for (const tileset of buildingTilesets) {
    tileset.show = buildingsToggle.checked;
  }
});

// ---- 4. 河川ベクタ -----------------------------------------------------------

const riversToggle = element("toggle-rivers");
let riversSource = null;
let selectedRiver = null;

function sectionTypeOf(entity) {
  const code = Number(entity.properties?.W05_003?.getValue());
  return SECTION_TYPES[code] ?? SECTION_TYPES[0];
}

function riverColor(entity) {
  return Cesium.Color.fromCssColorString(sectionTypeOf(entity).color);
}

function styleRiver(entity, selected = false) {
  if (!entity.polyline) {
    return;
  }
  const type = sectionTypeOf(entity);
  const unnamed = entity.properties?.W05_004?.getValue() === "名称不明";
  entity.polyline.material = new Cesium.ColorMaterialProperty(
    selected ? SELECTED_COLOR : riverColor(entity),
  );
  entity.polyline.width = selected ? 7 : type.lake ? 6 : unnamed ? 2 : 3;
}

async function loadRivers() {
  setStatus("rivers", "loading", "河川：読込中");
  try {
    riversSource = await Cesium.GeoJsonDataSource.load(CONFIG.rivers.url, {
      clampToGround: true,
    });
  } catch (error) {
    console.error("River GeoJSON failed to load", error);
    riversToggle.disabled = true;
    setStatus(
      "rivers",
      "error",
      `河川：${CONFIG.rivers.url} がありません。node inba-viewer/scripts/convert-w05.mjs を実行してください`,
    );
    return;
  }
  for (const entity of riversSource.entities.values) {
    styleRiver(entity);
  }
  riversSource.show = riversToggle.checked;
  await viewer.dataSources.add(riversSource);
  setStatus("rivers", "ok", `河川：国土数値情報W05（${riversSource.entities.values.length}流路）`);
}
riversToggle.addEventListener("change", () => {
  if (riversSource) {
    riversSource.show = riversToggle.checked;
  }
  if (!riversToggle.checked) {
    hidePopup();
  }
});

// ---- 河川属性ポップアップ ---------------------------------------------------------

const popup = element("river-popup");
const popupTitle = element("river-popup-title");
const popupBody = element("river-popup-body");

function propertyValue(entity, key) {
  const value = entity.properties?.[key]?.getValue();
  return value === undefined || value === null || String(value).trim() === "" ? "—" : String(value);
}

function riverDetails(entity) {
  const code = propertyValue(entity, "W05_003");
  const direction = propertyValue(entity, "W05_006");
  return [
    ["河川名", propertyValue(entity, "W05_004")],
    ["区間種別", `${sectionTypeOf(entity).label}（${code}）`],
    ["河川コード", propertyValue(entity, "W05_002")],
    ["水系域コード", propertyValue(entity, "W05_001")],
    ["原典資料種別コード", propertyValue(entity, "W05_005")],
    ["流下方向", direction === "1" || direction === "true" ? "判明" : direction === "—" ? "—" : "不明"],
  ];
}

function hidePopup() {
  popup.hidden = true;
  if (selectedRiver) {
    styleRiver(selectedRiver);
    selectedRiver = null;
  }
}

function showPopup(entity, screenPosition) {
  if (selectedRiver && selectedRiver !== entity) {
    styleRiver(selectedRiver);
  }
  selectedRiver = entity;
  styleRiver(entity, true);

  popupTitle.textContent = propertyValue(entity, "W05_004");
  const fragment = document.createDocumentFragment();
  for (const [label, value] of riverDetails(entity)) {
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = value;
    fragment.append(term, description);
  }
  popupBody.replaceChildren(fragment);
  popup.hidden = false;

  const margin = 12;
  const { clientWidth, clientHeight } = document.documentElement;
  const left = Math.min(screenPosition.x + margin, clientWidth - popup.offsetWidth - margin);
  const top = Math.min(screenPosition.y + margin, clientHeight - popup.offsetHeight - margin);
  popup.style.left = `${Math.max(margin, left)}px`;
  popup.style.top = `${Math.max(margin, top)}px`;
}

element("river-popup-close").addEventListener("click", hidePopup);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    hidePopup();
  }
});

viewer.screenSpaceEventHandler.setInputAction((movement) => {
  const picked = viewer.scene.pick(movement.position);
  const entity = picked?.id;
  if (
    riversSource?.show &&
    entity instanceof Cesium.Entity &&
    riversSource.entities.contains(entity)
  ) {
    showPopup(entity, movement.position);
  } else {
    hidePopup();
  }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

// ---- 起動 ------------------------------------------------------------------

renderAttribution();
renderRiverLegend();
applyImagery();
await Promise.all([loadTerrain(), loadBuildings(), loadRivers()]);

// 検証用: ブラウザの開発者ツールやE2Eから状態を確認できるようにする
window.inbaViewer = { viewer, flyHome };
