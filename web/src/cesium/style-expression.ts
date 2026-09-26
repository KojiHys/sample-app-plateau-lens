import { Cesium3DTileStyle, type Cesium3DTileFeature } from "cesium";
import {
  ATTRIBUTES,
  NUMERIC_FILTER_KEYS,
  NUMERIC_FILTERS,
  TILESET_RANGES,
} from "./attributes.ts";
import {
  categoryValueKey,
  type CategoryValue,
  type FilterState,
} from "../view-state.ts";

export const STYLE_COLORS = {
  missing: "#667085",
  neutral: "#d7dde5",
  height: { low: "#f2cf63", high: "#9b3f74" },
  floodDepth: { low: "#73d2c6", high: "#273c75" },
} as const;

export const USAGE_COLOR_PALETTE = [
  "#4e79a7",
  "#f28e2b",
  "#e15759",
  "#76b7b2",
  "#59a14f",
  "#edc949",
  "#af7aa1",
  "#ff9da7",
  "#9c755f",
  "#bab0ab",
] as const;

type ColorConditions = {
  conditions: [string, string][];
};

/**
 * Cesium style expressions require the `feature[...]` member form for names
 * containing colons, Japanese text, or punctuation.
 */
export function propertyExpression(propertyName: string): string {
  return `\${feature[${JSON.stringify(propertyName)}]}`;
}

export function literalExpression(value: CategoryValue): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Cesium style literals must be finite numbers");
    }
    return String(value);
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  if (/[\\\u0000-\u001f]/u.test(value)) {
    throw new TypeError("Cesium style string literals cannot contain backslashes or controls");
  }

  // Cesium removes backslashes before parsing style expressions. Splitting on
  // apostrophes avoids escape sequences and keeps remote operators inside
  // quoted tokens, even when the value contains both kinds of quote.
  return value
    .split("'")
    .map((part) => `'${part}'`)
    .join(` + "'" + `);
}

function numberExpression(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError("Cesium style numbers must be finite");
  }
  return String(value);
}

export function buildShowExpression(state: FilterState): string {
  const conditions: string[] = [];

  for (const key of NUMERIC_FILTER_KEYS) {
    const selected = state.numeric[key];
    const fullRange = TILESET_RANGES[key];
    if (selected.min === fullRange.min && selected.max === fullRange.max) {
      continue;
    }

    const property = propertyExpression(NUMERIC_FILTERS[key].attribute);
    conditions.push(
      `(${property} !== undefined && ${property} !== null && ${property} >= ${numberExpression(selected.min)} && ${property} <= ${numberExpression(selected.max)})`,
    );
  }

  const categoryProperties = {
    districtsAndZones: ATTRIBUTES.districtsAndZones,
    usage: ATTRIBUTES.usage,
  } as const;
  for (const category of ["usage", "districtsAndZones"] as const) {
    const property = propertyExpression(categoryProperties[category]);
    for (const excluded of state.categoryExclusions[category]) {
      conditions.push(`(${property} !== ${literalExpression(excluded)})`);
    }
  }

  return conditions.length > 0 ? conditions.join(" && ") : "true";
}

export function colorForCategory(value: CategoryValue): string {
  const key = categoryValueKey(value);
  let hash = 2_166_136_261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return USAGE_COLOR_PALETTE[(hash >>> 0) % USAGE_COLOR_PALETTE.length] ?? STYLE_COLORS.neutral;
}

// Opaque colours: with aerial imagery and terrain behind the buildings, any
// translucency makes stacked buildings look like ghosts.
function colorExpression(color: string, alpha = 1): string {
  return `color(${JSON.stringify(color)}, ${alpha})`;
}

function continuousColorExpression(
  propertyName: string,
  min: number,
  max: number,
  colors: { readonly high: string; readonly low: string },
): ColorConditions {
  const property = propertyExpression(propertyName);
  const minExpression = numberExpression(min);
  const spanExpression = numberExpression(max - min);
  const hasNumericValue = `(${property} !== undefined && ${property} !== null)`;
  const position = `clamp((${property} - ${minExpression}) / ${spanExpression}, 0.0, 1.0)`;

  return {
    conditions: [
      [
        hasNumericValue,
        `mix(${colorExpression(colors.low)}, ${colorExpression(colors.high)}, ${position})`,
      ],
      ["true", colorExpression(STYLE_COLORS.missing)],
    ],
  };
}

export interface TilesetStyleOptions {
  /** Keep the tileset texture visible. Used only with colorMode "none". */
  showTextures?: boolean;
}

export function buildColorExpression(
  state: FilterState,
  usageValues: readonly CategoryValue[],
  options: TilesetStyleOptions = {},
): string | ColorConditions {
  if (state.colorMode === "none") {
    // White with HIGHLIGHT blending multiplies by 1 and leaves textures intact.
    return options.showTextures === true
      ? colorExpression("#ffffff")
      : colorExpression(STYLE_COLORS.neutral);
  }
  if (state.colorMode === "height") {
    return continuousColorExpression(
      ATTRIBUTES.height,
      TILESET_RANGES.height.min,
      TILESET_RANGES.height.max,
      STYLE_COLORS.height,
    );
  }
  if (state.colorMode === "floodDepth") {
    return continuousColorExpression(
      ATTRIBUTES.floodDepth,
      TILESET_RANGES.floodDepth.min,
      TILESET_RANGES.floodDepth.max,
      STYLE_COLORS.floodDepth,
    );
  }

  const uniqueValues = new Map<string, CategoryValue>();
  for (const value of usageValues) {
    uniqueValues.set(categoryValueKey(value), value);
  }
  const conditions: [string, string][] = [...uniqueValues.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, value]) => [
      `${propertyExpression(ATTRIBUTES.usage)} === ${literalExpression(value)}`,
      colorExpression(colorForCategory(value)),
    ]);
  conditions.push(["true", colorExpression(STYLE_COLORS.missing)]);
  return { conditions };
}

export function createTilesetStyle(
  state: FilterState,
  usageValues: readonly CategoryValue[],
  options: TilesetStyleOptions = {},
): Cesium3DTileStyle {
  return new Cesium3DTileStyle({
    show: buildShowExpression(state),
    color: buildColorExpression(state, usageValues, options),
  });
}

export function createFloodPreflightShowExpression(): string {
  return `${propertyExpression(ATTRIBUTES.floodDepth)} >= 0.5`;
}

export function createFloodPreflightStyle(): Cesium3DTileStyle {
  return new Cesium3DTileStyle({
    show: createFloodPreflightShowExpression(),
    color: "color('#ef4444', 0.9)",
  });
}

export function evaluateFloodPreflight(value: number): boolean {
  const feature = {
    getPropertyInherited: (propertyName: string): unknown =>
      propertyName === ATTRIBUTES.floodDepth ? value : undefined,
  } as unknown as Cesium3DTileFeature;

  return createFloodPreflightStyle().show?.evaluate(feature) === true;
}
