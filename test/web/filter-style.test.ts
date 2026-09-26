import type { Cesium3DTileFeature } from "cesium";
import { describe, expect, it } from "vitest";
import { ATTRIBUTES } from "../../web/src/cesium/attributes.ts";
import {
  STYLE_COLORS,
  buildColorExpression,
  buildShowExpression,
  colorForCategory,
  createTilesetStyle,
  literalExpression,
  propertyExpression,
} from "../../web/src/cesium/style-expression.ts";
import { createDefaultFilterState } from "../../web/src/view-state.ts";

function feature(properties: Record<string, unknown>): Cesium3DTileFeature {
  return {
    getPropertyInherited: (name: string): unknown => properties[name],
  } as unknown as Cesium3DTileFeature;
}

describe("combined Cesium style", () => {
  it("leaves features with missing optional attributes visible at full ranges", () => {
    const state = createDefaultFilterState();
    const style = createTilesetStyle(state, []);

    expect(buildShowExpression(state)).toBe("true");
    expect(style.show?.evaluate(feature({}))).toBe(true);
  });

  it("combines both ends of numeric ranges and category exclusions", () => {
    const state = createDefaultFilterState();
    state.numeric.height = { min: 10, max: 20 };
    state.categoryExclusions.usage = ["危険\"用途", 7];
    const expression = buildShowExpression(state);
    const style = createTilesetStyle(state, []);

    expect(expression).toContain(`${propertyExpression(ATTRIBUTES.height)} >= 10`);
    expect(expression).toContain(`${propertyExpression(ATTRIBUTES.height)} <= 20`);
    expect(expression).toContain(literalExpression("危険\"用途"));
    expect(style.show?.evaluate(feature({ [ATTRIBUTES.height]: 15, [ATTRIBUTES.usage]: "住宅" }))).toBe(true);
    expect(style.show?.evaluate(feature({ [ATTRIBUTES.height]: 21, [ATTRIBUTES.usage]: "住宅" }))).toBe(false);
    expect(style.show?.evaluate(feature({ [ATTRIBUTES.height]: 15, [ATTRIBUTES.usage]: 7 }))).toBe(false);
    expect(style.show?.evaluate(feature({ [ATTRIBUTES.usage]: "住宅" }))).toBe(false);
  });

  it("quotes remote string literals without allowing expression injection", () => {
    const value = `業務' || true || \"施設`;
    const literal = literalExpression(value);
    const state = createDefaultFilterState();
    state.categoryExclusions.usage = [value];

    expect(literal).toContain(` + "'" + `);
    expect(() => createTilesetStyle(state, [value])).not.toThrow();
    const style = createTilesetStyle(state, [value]);
    expect(style.show?.evaluate(feature({ [ATTRIBUTES.usage]: value }))).toBe(false);
    expect(style.show?.evaluate(feature({ [ATTRIBUTES.usage]: "住宅" }))).toBe(true);
    expect(() => literalExpression(Number.NaN)).toThrow(TypeError);
    expect(() => literalExpression("unsupported\\value")).toThrow(TypeError);
  });

  it("builds continuous gradients with a gray no-data fallback", () => {
    const state = createDefaultFilterState();
    state.colorMode = "floodDepth";
    const color = buildColorExpression(state, []);

    expect(color).not.toBeTypeOf("string");
    if (typeof color !== "string") {
      expect(color.conditions[0]?.[1]).toContain(STYLE_COLORS.floodDepth.low);
      expect(color.conditions[0]?.[1]).toContain(STYLE_COLORS.floodDepth.high);
      expect(color.conditions.at(-1)).toEqual([
        "true",
        expect.stringContaining(STYLE_COLORS.missing),
      ]);
    }
  });

  it("keeps building colours opaque so imagery does not show through", () => {
    const state = createDefaultFilterState();
    expect(buildColorExpression(state, [])).toBe(
      `color(${JSON.stringify(STYLE_COLORS.neutral)}, 1)`,
    );
  });

  it("uses white for textured tiles only when no attribute colour mode is active", () => {
    const state = createDefaultFilterState();
    expect(buildColorExpression(state, [], { showTextures: true })).toBe(
      `color("#ffffff", 1)`,
    );

    state.colorMode = "height";
    const color = buildColorExpression(state, [], { showTextures: true });
    expect(color).not.toBeTypeOf("string");
    if (typeof color !== "string") {
      expect(color.conditions[0]?.[1]).toContain(STYLE_COLORS.height.low);
    }
  });

  it("uses stable colors and a safe fallback for dynamically discovered usage values", () => {
    expect(colorForCategory("住宅")).toBe(colorForCategory("住宅"));
    const state = createDefaultFilterState();
    state.colorMode = "usage";
    const color = buildColorExpression(state, ["住宅", `業務\"施設`, "住宅"]);

    expect(color).not.toBeTypeOf("string");
    if (typeof color !== "string") {
      expect(color.conditions).toHaveLength(3);
      expect(color.conditions.some(([condition]) => condition.includes(literalExpression(`業務\"施設`)))).toBe(true);
      expect(color.conditions.at(-1)?.[1]).toContain(STYLE_COLORS.missing);
    }
  });
});
