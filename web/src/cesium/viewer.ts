import {
  Cesium3DTileColorBlendMode,
  Cesium3DTileset,
  Color,
  EllipsoidTerrainProvider,
  Ion,
  Rectangle,
  Viewer,
} from "cesium";

// Start over the Kanda/Marunouchi area rather than loading all of Chiyoda at once.
const INITIAL_VIEW_BOUNDS = Rectangle.fromDegrees(139.759, 35.696, 139.765, 35.701);

export function createIonIndependentViewer(container: HTMLElement): Viewer {
  // An empty token makes accidental Cesium ion use fail visibly instead of
  // relying on CesiumJS's shared development token.
  Ion.defaultAccessToken = "";

  const viewer = new Viewer(container, {
    animation: false,
    baseLayer: false,
    baseLayerPicker: false,
    fullscreenButton: false,
    geocoder: false,
    homeButton: false,
    infoBox: false,
    navigationHelpButton: false,
    scene3DOnly: true,
    sceneModePicker: false,
    selectionIndicator: false,
    skyAtmosphere: false,
    skyBox: false,
    terrainProvider: new EllipsoidTerrainProvider(),
    timeline: false,
  });

  viewer.scene.backgroundColor = Color.fromCssColorString("#07111f");
  viewer.scene.globe.baseColor = Color.fromCssColorString("#122338");
  viewer.camera.setView({ destination: INITIAL_VIEW_BOUNDS });
  return viewer;
}

export async function createPlateauTileset(
  tilesetUrl: string,
): Promise<Cesium3DTileset> {
  const tileset = await Cesium3DTileset.fromUrl(tilesetUrl, {
    dynamicScreenSpaceError: true,
    maximumScreenSpaceError: 32,
  });
  tileset.colorBlendMode = Cesium3DTileColorBlendMode.REPLACE;
  return tileset;
}
