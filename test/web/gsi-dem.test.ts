import { describe, expect, it, vi } from "vitest";
import {
  buildEllipsoidalHeightmap,
  CHIYODA_GEOID_HEIGHT_METERS,
  decodeElevationPixels,
  decodeGsiElevation,
  demZoomForTerrainLevel,
  expandTileUrlTemplate,
  GSI_TILE_SIZE,
  intersectsTerrainBounds,
  lonLatToWebMercatorPixel,
  type DemTileKey,
  type ElevationTile,
} from "../../web/src/cesium/gsi-dem.ts";

function uniformTile(elevation: number): ElevationTile {
  return new Float32Array(GSI_TILE_SIZE * GSI_TILE_SIZE).fill(elevation);
}

// About 150 m square around Tokyo Station, inside the terrain bounds.
const TOKYO_STATION = { west: 139.766, south: 35.68, east: 139.7675, north: 35.6815 };

describe("GSI elevation decoding", () => {
  it("decodes positive, negative, and no-data pixels", () => {
    expect(decodeGsiElevation(0, 1, 104)).toBeCloseTo(3.6, 5);
    expect(decodeGsiElevation(0, 0, 0)).toBe(0);
    // 2^24 - 100 encodes -1.00 m.
    expect(decodeGsiElevation(255, 255, 156)).toBeCloseTo(-1, 5);
    expect(decodeGsiElevation(128, 0, 0)).toBeNull();
  });

  it("decodes a full RGBA tile and marks no-data as NaN", () => {
    const rgba = new Uint8ClampedArray(GSI_TILE_SIZE * GSI_TILE_SIZE * 4);
    rgba.set([0, 11, 194, 255], 0);
    rgba.set([128, 0, 0, 255], 4);
    const elevations = decodeElevationPixels(rgba);

    expect(elevations[0]).toBeCloseTo(30.1, 4);
    expect(elevations[1]).toBeNaN();
    expect(() => decodeElevationPixels(new Uint8ClampedArray(16))).toThrow(RangeError);
  });
});

describe("Web Mercator tile math", () => {
  it("finds the zoom-17 tile that contains Tokyo Station", () => {
    // x = (139.7671 + 180) / 360 * 2^17 = 116423.4
    const pixel = lonLatToWebMercatorPixel(139.7671, 35.6812, 17);
    expect([pixel.tileX, pixel.tileY]).toEqual([116423, 51613]);
    expect(pixel.pixelX).toBeGreaterThanOrEqual(0);
    expect(pixel.pixelX).toBeLessThan(GSI_TILE_SIZE);
  });

  it("maps geographic terrain levels to capped GSI zoom levels", () => {
    expect(demZoomForTerrainLevel(14)).toBe(12);
    expect(demZoomForTerrainLevel(17)).toBe(15);
    expect(demZoomForTerrainLevel(22)).toBe(15);
  });

  it("detects rectangles that overlap the Chiyoda terrain bounds", () => {
    expect(intersectsTerrainBounds(TOKYO_STATION)).toBe(true);
    expect(
      intersectsTerrainBounds({ west: 135.49, south: 34.69, east: 135.51, north: 34.71 }),
    ).toBe(false);
  });

  it("expands only integer coordinates into URL templates", () => {
    expect(
      expandTileUrlTemplate("https://example.test/{z}/{x}/{y}.png", { x: 1, y: 2, z: 3 }),
    ).toBe("https://example.test/3/1/2.png");
    expect(() =>
      expandTileUrlTemplate("https://example.test/{z}/{x}/{y}.png", { x: 1.5, y: 2, z: 3 }),
    ).toThrow(RangeError);
  });
});

describe("ellipsoidal heightmap", () => {
  it("adds the geoid height to 5 m DEM elevations", async () => {
    const loadTile = vi.fn(async (key: DemTileKey) =>
      key.source === "fine" ? uniformTile(3.6) : uniformTile(99),
    );
    const heights = await buildEllipsoidalHeightmap(TOKYO_STATION, 4, 4, 17, loadTile);

    expect(heights).toHaveLength(16);
    for (const height of heights) {
      expect(height).toBeCloseTo(3.6 + CHIYODA_GEOID_HEIGHT_METERS, 4);
    }
    expect(loadTile.mock.calls.every(([key]) => key.source === "fine" && key.z === 15)).toBe(true);
  });

  it("fills 5 m DEM gaps from the 10 m DEM, then from sea level", async () => {
    const coarseOnly = await buildEllipsoidalHeightmap(TOKYO_STATION, 2, 2, 17, async (key) =>
      key.source === "fine" ? uniformTile(Number.NaN) : uniformTile(5),
    );
    for (const height of coarseOnly) {
      expect(height).toBeCloseTo(5 + CHIYODA_GEOID_HEIGHT_METERS, 4);
    }

    const missing = await buildEllipsoidalHeightmap(TOKYO_STATION, 2, 2, 17, async () => null);
    for (const height of missing) {
      expect(height).toBeCloseTo(CHIYODA_GEOID_HEIGHT_METERS, 4);
    }
  });

  it("treats loader failures as missing tiles", async () => {
    const heights = await buildEllipsoidalHeightmap(TOKYO_STATION, 2, 2, 17, async () => {
      throw new Error("network");
    });
    for (const height of heights) {
      expect(height).toBeCloseTo(CHIYODA_GEOID_HEIGHT_METERS, 4);
    }
  });

  it("returns a flat geoid surface without requests for coarse levels or distant areas", async () => {
    const loadTile = vi.fn(async () => uniformTile(10));
    const coarseLevel = await buildEllipsoidalHeightmap(TOKYO_STATION, 3, 3, 8, loadTile);
    const osaka = await buildEllipsoidalHeightmap(
      { west: 135.49, south: 34.69, east: 135.51, north: 34.71 },
      3,
      3,
      17,
      loadTile,
    );

    expect(loadTile).not.toHaveBeenCalled();
    for (const height of [...coarseLevel, ...osaka]) {
      expect(height).toBeCloseTo(CHIYODA_GEOID_HEIGHT_METERS, 4);
    }
  });
});
