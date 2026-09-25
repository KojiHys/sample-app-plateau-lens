import { describe, expect, it } from "vitest";
import { ATTRIBUTES } from "../../web/src/cesium/attributes.ts";
import {
  collectCategoryValues,
  forEachTileFeature,
  mergeCategoryValues,
} from "../../web/src/cesium/tile-content.ts";

function feature(properties: Record<string, unknown>) {
  return {
    getProperty: (name: string): unknown => properties[name],
  };
}

function leaf(features: ReturnType<typeof feature>[]) {
  return {
    featuresLength: features.length,
    getFeature: (index: number): ReturnType<typeof feature> | undefined => features[index],
  };
}

describe("3D Tiles content traversal", () => {
  it("recursively visits feature-bearing leaves under nested innerContents", () => {
    const first = feature({ [ATTRIBUTES.usage]: "住宅" });
    const second = feature({ [ATTRIBUTES.usage]: "業務" });
    const content = {
      featuresLength: 0,
      getFeature: () => {
        throw new Error("wrapper features must not be read");
      },
      innerContents: [leaf([first]), { innerContents: [leaf([second]), null] }],
    };
    const visited: unknown[] = [];

    forEachTileFeature(content, (candidate) => visited.push(candidate));

    expect(visited).toEqual([first, second]);
  });

  it("tolerates malformed children, feature errors, and cyclic wrappers", () => {
    const validFeature = feature({ [ATTRIBUTES.usage]: "庁舎" });
    const brokenLeaf = {
      featuresLength: 2,
      getFeature: (index: number): unknown => {
        if (index === 0) {
          throw new Error("broken feature");
        }
        return validFeature;
      },
    };
    const cyclic: { innerContents: unknown[] } = { innerContents: [] };
    cyclic.innerContents = [cyclic, brokenLeaf, { featuresLength: -1 }];
    const visited: unknown[] = [];

    forEachTileFeature(cyclic, (candidate) => visited.push(candidate));

    const throwingGetters = Object.defineProperties({}, {
      featuresLength: {
        get: () => {
          throw new Error("broken length getter");
        },
      },
      getFeature: {
        get: () => {
          throw new Error("broken feature getter");
        },
      },
    });
    expect(() => forEachTileFeature(throwingGetters, () => undefined)).not.toThrow();
    expect(() =>
      forEachTileFeature(
        { featuresLength: 1_000_001, getFeature: () => validFeature },
        () => undefined,
      ),
    ).not.toThrow();

    expect(visited).toEqual([validFeature]);
  });

  it("collects typed classifications dynamically and ignores unusable values", () => {
    const content = leaf([
      feature({
        [ATTRIBUTES.usage]: "住宅",
        [ATTRIBUTES.districtsAndZones]: 8,
      }),
      feature({
        [ATTRIBUTES.usage]: "住宅",
        [ATTRIBUTES.districtsAndZones]: "商業地域",
      }),
      feature({
        [ATTRIBUTES.usage]: { unexpected: true },
        [ATTRIBUTES.districtsAndZones]: Number.NaN,
      }),
    ]);

    expect(collectCategoryValues(content)).toEqual({
      districtsAndZones: [8, "商業地域"],
      usage: ["住宅"],
    });
  });

  it("merges values discovered by later tile loads without duplicates", () => {
    expect(
      mergeCategoryValues(
        { districtsAndZones: [1], usage: ["住宅"] },
        { districtsAndZones: [1, 2], usage: ["業務", "住宅"] },
      ),
    ).toEqual({
      districtsAndZones: [1, 2],
      usage: ["住宅", "業務"],
    });
  });
});
