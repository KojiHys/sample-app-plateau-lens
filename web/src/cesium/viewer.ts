import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Cesium3DTileColorBlendMode,
  Cesium3DTileset,
  Math as CesiumMath,
  Color,
  EllipsoidTerrainProvider,
  HeadingPitchRange,
  ImageryLayer,
  Ion,
  JulianDate,
  Rectangle,
  SceneMode,
  UrlTemplateImageryProvider,
  Viewer,
  type TerrainProvider,
} from "cesium";

// Start over the Kanda/Marunouchi area rather than loading all of Chiyoda at once.
export const INITIAL_VIEW_BOUNDS = Rectangle.fromDegrees(139.759, 35.696, 139.765, 35.701);

// PLATEAU-Ortho covers the 23 wards at zoom 10–19. Limiting the rectangle keeps
// requests inside the published area and the minimum-level tile count small.
const ORTHO_IMAGERY_BOUNDS = Rectangle.fromDegrees(139.55, 35.5, 139.95, 35.85);
const ORTHO_MINIMUM_LEVEL = 10;
// Zoom 19 is missing in parts of Chiyoda (404), while zoom 18 is complete.
const ORTHO_MAXIMUM_LEVEL = 18;
const CAMERA_RESET_SECONDS = 0.8;

/** 10:00 JST on the current date, so sunlight and shadows look like daytime. */
function daytimeInTokyo(now = new Date()): JulianDate {
  return JulianDate.fromDate(
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 1, 0, 0)),
  );
}

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
    // 2D mode requires scene3DOnly to be false.
    scene3DOnly: false,
    sceneModePicker: false,
    selectionIndicator: false,
    skyBox: false,
    terrainProvider: new EllipsoidTerrainProvider(),
    timeline: false,
  });
  viewer.scene.backgroundColor = Color.fromCssColorString("#07111f");
  viewer.scene.globe.baseColor = Color.fromCssColorString("#122338");
  viewer.clock.shouldAnimate = false;
  viewer.clock.currentTime = daytimeInTokyo();
  viewObliquely(viewer, Rectangle.center(INITIAL_VIEW_BOUNDS), INITIAL_OBLIQUE_RANGE_METERS, 0);
  return viewer;
}

/**
 * Initial 3D view: looking north over Kanda/Marunouchi with a 30° depression
 * angle (pitch −30°). The range keeps roughly the same area in view as the
 * former top-down view of INITIAL_VIEW_BOUNDS.
 */
export const INITIAL_OBLIQUE_PITCH = CesiumMath.toRadians(-30);
const INITIAL_OBLIQUE_RANGE_METERS = 1_400;
// Approximate ground ellipsoidal height around Kanda (elevation + geoid height).
const FOCUS_HEIGHT_METERS = 42;

function viewObliquely(
  viewer: Viewer,
  focus: Cartographic,
  rangeMeters: number,
  durationSeconds: number,
): void {
  const target = Cartesian3.fromRadians(focus.longitude, focus.latitude, FOCUS_HEIGHT_METERS);
  viewer.camera.flyToBoundingSphere(new BoundingSphere(target, 1), {
    duration: durationSeconds,
    offset: new HeadingPitchRange(0, INITIAL_OBLIQUE_PITCH, rangeMeters),
  });
}

const MIN_VIEW_HEIGHT_METERS = 300;
const MAX_VIEW_HEIGHT_METERS = 20_000;

/**
 * Switches between 3D and 2D while keeping the area under the screen centre.
 * CesiumJS morphs reset the camera to the whole globe, so the view is restored
 * when the morph completes.
 */
export function morphSceneMode(viewer: Viewer, mode: "2d" | "3d", onComplete: () => void): void {
  const { camera, scene } = viewer;
  const target = mode === "2d" ? SceneMode.SCENE2D : SceneMode.SCENE3D;
  if (scene.mode === target) {
    onComplete();
    return;
  }

  const center = new Cartesian2(scene.canvas.clientWidth / 2, scene.canvas.clientHeight / 2);
  const ground = camera.pickEllipsoid(center, scene.globe.ellipsoid);
  const focus = ground
    ? Cartographic.fromCartesian(ground)
    : Rectangle.center(INITIAL_VIEW_BOUNDS);
  const height = CesiumMath.clamp(
    camera.positionCartographic.height,
    MIN_VIEW_HEIGHT_METERS,
    MAX_VIEW_HEIGHT_METERS,
  );

  const removeListener = scene.morphComplete.addEventListener(() => {
    removeListener();
    if (mode === "3d") {
      // Return to the same oblique angle as the initial view.
      viewObliquely(viewer, focus, height * 1.5, 0);
    } else {
      camera.setView({
        destination: Cartesian3.fromRadians(focus.longitude, focus.latitude, height),
        orientation: { heading: 0, pitch: -CesiumMath.PI_OVER_TWO, roll: 0 },
      });
    }
    onComplete();
  });
  if (mode === "2d") {
    scene.morphTo2D(0);
  } else {
    scene.morphTo3D(0);
  }
}

/** Moves the camera back to the initial view. Filters and display settings are untouched. */
export function resetCameraView(viewer: Viewer): void {
  viewer.camera.cancelFlight();
  if (viewer.scene.mode === SceneMode.SCENE2D) {
    viewer.camera.flyTo({ destination: INITIAL_VIEW_BOUNDS, duration: CAMERA_RESET_SECONDS });
    return;
  }
  viewObliquely(
    viewer,
    Rectangle.center(INITIAL_VIEW_BOUNDS),
    INITIAL_OBLIQUE_RANGE_METERS,
    CAMERA_RESET_SECONDS,
  );
}

export function createOrthoImageryLayer(urlTemplate: string): ImageryLayer {
  return new ImageryLayer(
    new UrlTemplateImageryProvider({
      credit: "航空写真：PLATEAU-Ortho",
      maximumLevel: ORTHO_MAXIMUM_LEVEL,
      minimumLevel: ORTHO_MINIMUM_LEVEL,
      rectangle: ORTHO_IMAGERY_BOUNDS,
      url: urlTemplate,
    }),
  );
}

export interface SceneAppearance {
  lighting: boolean;
  orthoLayer: ImageryLayer | null;
  orthoVisible: boolean;
  terrainProvider: TerrainProvider;
  terrainEnabled: boolean;
}

export function applySceneAppearance(viewer: Viewer, appearance: SceneAppearance): void {
  const { scene } = viewer;
  if (appearance.orthoLayer) {
    appearance.orthoLayer.show = appearance.orthoVisible;
  }
  if (scene.globe.terrainProvider !== appearance.terrainProvider) {
    scene.globe.terrainProvider = appearance.terrainProvider;
  }
  // Hide buildings' underground parts only when real terrain is present.
  scene.globe.depthTestAgainstTerrain = appearance.terrainEnabled;

  viewer.shadows = appearance.lighting;
  scene.globe.enableLighting = appearance.lighting;
  scene.globe.showGroundAtmosphere = appearance.lighting;
  if (scene.skyAtmosphere) {
    scene.skyAtmosphere.show = appearance.lighting;
  }
  scene.requestRender();
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

/** REPLACE paints attribute colours; HIGHLIGHT with white keeps textures visible. */
export function applyTilesetBlendMode(tileset: Cesium3DTileset, showTextures: boolean): void {
  tileset.colorBlendMode = showTextures
    ? Cesium3DTileColorBlendMode.HIGHLIGHT
    : Cesium3DTileColorBlendMode.REPLACE;
}
