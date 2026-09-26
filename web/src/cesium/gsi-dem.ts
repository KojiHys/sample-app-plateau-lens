/**
 * Pure helpers that turn GSI elevation PNG tiles (地理院タイル 標高タイル) into
 * ellipsoidal heightmaps for Cesium. GSI tiles use Web Mercator and orthometric
 * heights, while PLATEAU 3D Tiles use ellipsoidal heights, so every sample is
 * shifted by the local geoid height.
 */

export const GSI_TILE_SIZE = 256;

/** GSI encodes "no data" as RGB (128, 0, 0), which is 2^23. */
const NO_DATA_VALUE = 2 ** 23;

/**
 * Geoid height across Chiyoda ward is 36.76–36.99 m (GSI geoid model,
 * 日本のジオイド2011). A single constant keeps the geoid error near 0.15 m
 * inside TERRAIN_BOUNDS, which is smaller than the 5 m DEM grid error.
 */
export const CHIYODA_GEOID_HEIGHT_METERS = 36.9;

/**
 * Terrain is fetched only around Chiyoda, where the constant geoid height is
 * valid. Outside this rectangle the ground stays flat at the geoid height.
 */
export const TERRAIN_BOUNDS = {
  west: 139.68,
  south: 35.64,
  east: 139.84,
  north: 35.74,
} as const;

/** dem5a_png (5 m laser DEM) is published up to zoom 15. */
export const FINE_DEM_MAX_ZOOM = 15;
/** dem_png (10 m DEM) is published up to zoom 14 and fills gaps in dem5a. */
export const COARSE_DEM_MAX_ZOOM = 14;
/** Below this zoom, the heightmap is too coarse to matter for buildings. */
export const MIN_DEM_ZOOM = 11;

export interface DegreeRectangle {
  east: number;
  north: number;
  south: number;
  west: number;
}

export type DemSource = "fine" | "coarse";

export interface DemTileKey {
  source: DemSource;
  x: number;
  y: number;
  z: number;
}

/** Decoded elevations in metres, row-major from the north-west pixel. NaN means no data. */
export type ElevationTile = Float32Array;

export type ElevationTileLoader = (key: DemTileKey) => Promise<ElevationTile | null>;

export function decodeGsiElevation(red: number, green: number, blue: number): number | null {
  const value = red * 65_536 + green * 256 + blue;
  if (value === NO_DATA_VALUE) {
    return null;
  }
  return value < NO_DATA_VALUE ? value * 0.01 : (value - 2 ** 24) * 0.01;
}

/** Converts RGBA pixel data from a 256×256 GSI PNG into metres. */
export function decodeElevationPixels(rgba: ArrayLike<number>): ElevationTile {
  const pixelCount = GSI_TILE_SIZE * GSI_TILE_SIZE;
  if (rgba.length !== pixelCount * 4) {
    throw new RangeError("GSI elevation tiles must be 256×256 RGBA images");
  }
  const elevations = new Float32Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 4;
    const elevation = decodeGsiElevation(
      rgba[offset] ?? 0,
      rgba[offset + 1] ?? 0,
      rgba[offset + 2] ?? 0,
    );
    elevations[index] = elevation ?? Number.NaN;
  }
  return elevations;
}

export interface WebMercatorPixel {
  pixelX: number;
  pixelY: number;
  tileX: number;
  tileY: number;
}

export function lonLatToWebMercatorPixel(
  longitudeDegrees: number,
  latitudeDegrees: number,
  zoom: number,
): WebMercatorPixel {
  const worldSize = GSI_TILE_SIZE * 2 ** zoom;
  const latitudeRadians = (latitudeDegrees * Math.PI) / 180;
  const globalX = ((longitudeDegrees + 180) / 360) * worldSize;
  const globalY =
    ((1 - Math.log(Math.tan(latitudeRadians) + 1 / Math.cos(latitudeRadians)) / Math.PI) / 2) *
    worldSize;
  const maxPixel = worldSize - 1;
  const clampedX = Math.min(Math.max(Math.floor(globalX), 0), maxPixel);
  const clampedY = Math.min(Math.max(Math.floor(globalY), 0), maxPixel);
  return {
    pixelX: clampedX % GSI_TILE_SIZE,
    pixelY: clampedY % GSI_TILE_SIZE,
    tileX: Math.floor(clampedX / GSI_TILE_SIZE),
    tileY: Math.floor(clampedY / GSI_TILE_SIZE),
  };
}

/**
 * A heightmap sample spacing at geographic level L matches the GSI pixel
 * spacing at Web Mercator zoom L - 2 when the heightmap is 64 samples wide.
 * Using the same rule for 33 samples slightly oversamples, which is harmless.
 */
export function demZoomForTerrainLevel(level: number): number {
  return Math.min(level - 2, FINE_DEM_MAX_ZOOM);
}

export function intersectsTerrainBounds(rectangle: DegreeRectangle): boolean {
  return (
    rectangle.west < TERRAIN_BOUNDS.east &&
    rectangle.east > TERRAIN_BOUNDS.west &&
    rectangle.south < TERRAIN_BOUNDS.north &&
    rectangle.north > TERRAIN_BOUNDS.south
  );
}

function isInsideTerrainBounds(longitude: number, latitude: number): boolean {
  return (
    longitude >= TERRAIN_BOUNDS.west &&
    longitude <= TERRAIN_BOUNDS.east &&
    latitude >= TERRAIN_BOUNDS.south &&
    latitude <= TERRAIN_BOUNDS.north
  );
}

export function flatHeightmap(width: number, height: number): Float32Array {
  return new Float32Array(width * height).fill(CHIYODA_GEOID_HEIGHT_METERS);
}

function tileKeyId(key: DemTileKey): string {
  return `${key.source}/${key.z}/${key.x}/${key.y}`;
}

interface SamplePoint {
  coarse: WebMercatorPixel;
  coarseKey: DemTileKey;
  fine: WebMercatorPixel;
  fineKey: DemTileKey;
}

/**
 * Builds a Cesium heightmap (row-major from the north-west corner, inclusive
 * edges) of ellipsoidal heights for a geographic tile rectangle.
 *
 * Missing dem5a pixels fall back to dem_png; pixels missing in both, such as
 * open water, fall back to 0 m orthometric height. Failed tile downloads are
 * treated as missing so terrain degrades to the geoid surface.
 */
export async function buildEllipsoidalHeightmap(
  rectangle: DegreeRectangle,
  width: number,
  height: number,
  level: number,
  loadTile: ElevationTileLoader,
): Promise<Float32Array> {
  const zoom = demZoomForTerrainLevel(level);
  if (zoom < MIN_DEM_ZOOM || !intersectsTerrainBounds(rectangle)) {
    return flatHeightmap(width, height);
  }

  const coarseZoom = Math.min(zoom, COARSE_DEM_MAX_ZOOM);
  const points: Array<SamplePoint | null> = [];
  const requiredKeys = new Map<string, DemTileKey>();
  for (let row = 0; row < height; row += 1) {
    const latitude =
      rectangle.north - ((rectangle.north - rectangle.south) * row) / Math.max(height - 1, 1);
    for (let column = 0; column < width; column += 1) {
      const longitude =
        rectangle.west + ((rectangle.east - rectangle.west) * column) / Math.max(width - 1, 1);
      if (!isInsideTerrainBounds(longitude, latitude)) {
        points.push(null);
        continue;
      }
      const fine = lonLatToWebMercatorPixel(longitude, latitude, zoom);
      const coarse = lonLatToWebMercatorPixel(longitude, latitude, coarseZoom);
      const fineKey: DemTileKey = { source: "fine", x: fine.tileX, y: fine.tileY, z: zoom };
      const coarseKey: DemTileKey = {
        source: "coarse",
        x: coarse.tileX,
        y: coarse.tileY,
        z: coarseZoom,
      };
      requiredKeys.set(tileKeyId(fineKey), fineKey);
      points.push({ coarse, coarseKey, fine, fineKey });
    }
  }

  const tiles = new Map<string, ElevationTile | null>();
  const load = async (key: DemTileKey): Promise<void> => {
    const id = tileKeyId(key);
    if (tiles.has(id)) {
      return;
    }
    tiles.set(id, null);
    try {
      tiles.set(id, await loadTile(key));
    } catch {
      tiles.set(id, null);
    }
  };
  await Promise.all([...requiredKeys.values()].map(load));

  const readPixel = (key: DemTileKey, pixel: WebMercatorPixel): number => {
    const tile = tiles.get(tileKeyId(key));
    if (!tile) {
      return Number.NaN;
    }
    return tile[pixel.pixelY * GSI_TILE_SIZE + pixel.pixelX] ?? Number.NaN;
  };

  // Load coarse tiles only where the fine DEM has gaps.
  const coarseKeys = new Map<string, DemTileKey>();
  for (const point of points) {
    if (point && Number.isNaN(readPixel(point.fineKey, point.fine))) {
      coarseKeys.set(tileKeyId(point.coarseKey), point.coarseKey);
    }
  }
  await Promise.all([...coarseKeys.values()].map(load));

  const heights = new Float32Array(width * height);
  points.forEach((point, index) => {
    if (!point) {
      heights[index] = CHIYODA_GEOID_HEIGHT_METERS;
      return;
    }
    let elevation = readPixel(point.fineKey, point.fine);
    if (Number.isNaN(elevation)) {
      elevation = readPixel(point.coarseKey, point.coarse);
    }
    heights[index] = (Number.isNaN(elevation) ? 0 : elevation) + CHIYODA_GEOID_HEIGHT_METERS;
  });
  return heights;
}

/** Expands a `{z}/{x}/{y}` URL template. Only integer coordinates are accepted. */
export function expandTileUrlTemplate(template: string, key: Pick<DemTileKey, "x" | "y" | "z">): string {
  for (const value of [key.x, key.y, key.z]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError("Tile coordinates must be non-negative integers");
    }
  }
  return template
    .replaceAll("{z}", String(key.z))
    .replaceAll("{x}", String(key.x))
    .replaceAll("{y}", String(key.y));
}
