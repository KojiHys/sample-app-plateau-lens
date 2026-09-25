import { describe, expect, it } from "vitest";
import { ATTRIBUTES } from "../../web/src/cesium/attributes.ts";
import {
  createFloodPreflightShowExpression,
  createFloodPreflightStyle,
  evaluateFloodPreflight,
  propertyExpression,
} from "../../web/src/cesium/style-expression.ts";

describe("Cesium style expression", () => {
  it("uses the feature bracket form for Japanese property names", () => {
    expect(propertyExpression(ATTRIBUTES.floodDepth)).toBe(
      `\${feature[${JSON.stringify(ATTRIBUTES.floodDepth)}]}`,
    );
  });

  it("evaluates the Japanese flood-depth property at the threshold", () => {
    expect(evaluateFloodPreflight(0.5)).toBe(true);
    expect(evaluateFloodPreflight(3.42)).toBe(true);
    expect(evaluateFloodPreflight(0.49)).toBe(false);
  });

  it("builds a style that does not require a tile-visible workaround", () => {
    const style = createFloodPreflightStyle();
    expect(createFloodPreflightShowExpression()).toContain(ATTRIBUTES.floodDepth);
    expect(style.show).toBeDefined();
    expect(style.color).toBeDefined();
  });
});
