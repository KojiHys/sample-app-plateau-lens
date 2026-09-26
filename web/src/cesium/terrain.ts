import {
  CustomHeightmapTerrainProvider,
  GeographicTilingScheme,
  Math as CesiumMath,
} from "cesium";
import {
  buildEllipsoidalHeightmap,
  decodeElevationPixels,
  expandTileUrlTemplate,
  flatHeightmap,
  GSI_TILE_SIZE,
  intersectsTerrainBounds,
  type DemTileKey,
  type ElevationTile,
  type ElevationTileLoader,
} from "./gsi-dem.ts";

const HEIGHTMAP_SIZE = 33;
const MAX_CACHED_TILES = 256;
const TILE_TIMEOUT_MS = 10_000;

export interface GsiTerrainOptions {
  coarseUrlTemplate: string;
  fineUrlTemplate: string;
  onTileFailure?: () => void;
}

async function readPngPixels(blob: Blob): Promise<Uint8ClampedArray> {
  const bitmap = await createImageBitmap(blob, {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });
  try {
    const canvas = new OffscreenCanvas(GSI_TILE_SIZE, GSI_TILE_SIZE);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      throw new Error("A 2D canvas is unavailable");
    }
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, GSI_TILE_SIZE, GSI_TILE_SIZE).data;
  } finally {
    bitmap.close();
  }
}

/**
 * Loads GSI elevation tiles with an in-memory LRU cache. A 404 is normal
 * outside dem5a coverage and resolves to null; other failures also resolve
 * to null so a missing tile never blocks rendering.
 */
function createElevationTileLoader(options: GsiTerrainOptions): ElevationTileLoader {
  const cache = new Map<string, Promise<ElevationTile | null>>();

  return (key: DemTileKey) => {
    const template = key.source === "fine" ? options.fineUrlTemplate : options.coarseUrlTemplate;
    if (template.length === 0) {
      return Promise.resolve(null);
    }
    const url = expandTileUrlTemplate(template, key);
    const cached = cache.get(url);
    if (cached) {
      cache.delete(url);
      cache.set(url, cached);
      return cached;
    }

    const pending = (async (): Promise<ElevationTile | null> => {
      try {
        const response = await fetch(url, {
          credentials: "omit",
          signal: AbortSignal.timeout(TILE_TIMEOUT_MS),
        });
        if (response.status === 404) {
          return null;
        }
        if (!response.ok) {
          throw new Error(`GSI elevation tile returned ${response.status}`);
        }
        return decodeElevationPixels(await readPngPixels(await response.blob()));
      } catch (error: unknown) {
        cache.delete(url);
        options.onTileFailure?.();
        console.warn("GSI elevation tile failed to load", error);
        return null;
      }
    })();

    cache.set(url, pending);
    while (cache.size > MAX_CACHED_TILES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      cache.delete(oldest);
    }
    return pending;
  };
}

/**
 * Terrain from GSI elevation tiles, shifted to ellipsoidal heights so that
 * PLATEAU buildings sit on the ground. Does not use Cesium ion.
 */
export function createGsiTerrainProvider(
  options: GsiTerrainOptions,
): CustomHeightmapTerrainProvider {
  const tilingScheme = new GeographicTilingScheme();
  const loadTile = createElevationTileLoader(options);

  return new CustomHeightmapTerrainProvider({
    callback: (x, y, level) => {
      const radians = tilingScheme.tileXYToRectangle(x, y, level);
      const rectangle = {
        east: CesiumMath.toDegrees(radians.east),
        north: CesiumMath.toDegrees(radians.north),
        south: CesiumMath.toDegrees(radians.south),
        west: CesiumMath.toDegrees(radians.west),
      };
      if (!intersectsTerrainBounds(rectangle)) {
        return flatHeightmap(HEIGHTMAP_SIZE, HEIGHTMAP_SIZE);
      }
      return buildEllipsoidalHeightmap(
        rectangle,
        HEIGHTMAP_SIZE,
        HEIGHTMAP_SIZE,
        level,
        loadTile,
      );
    },
    credit: "標高：国土地理院",
    height: HEIGHTMAP_SIZE,
    tilingScheme,
    width: HEIGHTMAP_SIZE,
  });
}
