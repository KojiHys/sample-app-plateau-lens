import {
  CATEGORY_FILTER_KEYS,
  NUMERIC_FILTER_KEYS,
  TILESET_RANGES,
  type CategoryFilterKey,
  type NumericFilterKey,
} from "./cesium/attributes.ts";

export const VIEW_STATE_VERSION = 1;
const MAX_ENCODED_STATE_LENGTH = 32_000;
const MAX_CATEGORY_VALUES = 256;
const MAX_CATEGORY_STRING_LENGTH = 256;

export type CategoryValue = string | number | boolean;
export type ColorMode = "none" | "usage" | "height" | "floodDepth";

export interface NumericRange {
  max: number;
  min: number;
}

export interface FilterState {
  categoryExclusions: Record<CategoryFilterKey, CategoryValue[]>;
  colorMode: ColorMode;
  numeric: Record<NumericFilterKey, NumericRange>;
}

export interface CameraState {
  destination: {
    height: number;
    latitudeDegrees: number;
    longitudeDegrees: number;
  };
  orientation: {
    heading: number;
    pitch: number;
    roll: number;
  };
}

export interface ViewStateSnapshot {
  camera: CameraState | null;
  filter: FilterState;
}

export function createDefaultFilterState(): FilterState {
  return {
    categoryExclusions: {
      districtsAndZones: [],
      usage: [],
    },
    colorMode: "none",
    numeric: {
      floodDepth: {
        min: TILESET_RANGES.floodDepth.min,
        max: TILESET_RANGES.floodDepth.max,
      },
      height: { min: TILESET_RANGES.height.min, max: TILESET_RANGES.height.max },
      roofArea: {
        min: TILESET_RANGES.roofArea.min,
        max: TILESET_RANGES.roofArea.max,
      },
      storeysAboveGround: {
        min: TILESET_RANGES.storeysAboveGround.min,
        max: TILESET_RANGES.storeysAboveGround.max,
      },
    },
  };
}

export function cloneFilterState(state: FilterState): FilterState {
  return {
    categoryExclusions: {
      districtsAndZones: [...state.categoryExclusions.districtsAndZones],
      usage: [...state.categoryExclusions.usage],
    },
    colorMode: state.colorMode,
    numeric: {
      floodDepth: { ...state.numeric.floodDepth },
      height: { ...state.numeric.height },
      roofArea: { ...state.numeric.roofArea },
      storeysAboveGround: { ...state.numeric.storeysAboveGround },
    },
  };
}

export function applyVerticalEvacuationPreset(state: FilterState): FilterState {
  const next = cloneFilterState(state);
  next.numeric.floodDepth = { min: 0.5, max: TILESET_RANGES.floodDepth.max };
  next.numeric.storeysAboveGround = {
    min: 4,
    max: TILESET_RANGES.storeysAboveGround.max,
  };
  next.numeric.roofArea = { min: 1_000, max: TILESET_RANGES.roofArea.max };
  next.colorMode = "floodDepth";
  return next;
}

export function categoryValueKey(value: CategoryValue): string {
  return `${typeof value}:${JSON.stringify(value)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isColorMode(value: unknown): value is ColorMode {
  return (
    value === "none" ||
    value === "usage" ||
    value === "height" ||
    value === "floodDepth"
  );
}

export function isSupportedCategoryValue(value: unknown): value is CategoryValue {
  if (typeof value === "string") {
    return (
      value.trim().length > 0 &&
      value.length <= MAX_CATEGORY_STRING_LENGTH &&
      !/[\\\u0000-\u001f]/u.test(value)
    );
  }
  return typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

function readCategoryValues(value: unknown): CategoryValue[] | null {
  if (!Array.isArray(value) || value.length > MAX_CATEGORY_VALUES) {
    return null;
  }

  const values = new Map<string, CategoryValue>();
  for (const candidate of value) {
    if (!isSupportedCategoryValue(candidate)) {
      return null;
    }
    values.set(categoryValueKey(candidate), candidate);
  }
  return [...values.values()];
}

function readNumericRanges(value: unknown): FilterState["numeric"] | null {
  if (!isRecord(value)) {
    return null;
  }

  const ranges = {} as Record<NumericFilterKey, NumericRange>;
  for (const key of NUMERIC_FILTER_KEYS) {
    const candidate = value[key];
    const limits = TILESET_RANGES[key];
    if (!isRecord(candidate)) {
      return null;
    }

    const min = candidate.min;
    const max = candidate.max;
    if (
      typeof min !== "number" ||
      typeof max !== "number" ||
      !Number.isFinite(min) ||
      !Number.isFinite(max) ||
      min < limits.min ||
      max > limits.max ||
      min > max
    ) {
      return null;
    }
    ranges[key] = { min, max };
  }
  return ranges;
}

export function parseFilterState(value: unknown): FilterState | null {
  if (!isRecord(value) || !isColorMode(value.colorMode)) {
    return null;
  }

  const numeric = readNumericRanges(value.numeric);
  const exclusions = value.categoryExclusions;
  if (!numeric || !isRecord(exclusions)) {
    return null;
  }

  const categoryExclusions = {} as Record<CategoryFilterKey, CategoryValue[]>;
  for (const key of CATEGORY_FILTER_KEYS) {
    const values = readCategoryValues(exclusions[key]);
    if (!values) {
      return null;
    }
    categoryExclusions[key] = values;
  }

  return {
    categoryExclusions,
    colorMode: value.colorMode,
    numeric,
  };
}

export function isValidCameraState(value: unknown): value is CameraState {
  if (!isRecord(value) || !isRecord(value.destination) || !isRecord(value.orientation)) {
    return false;
  }

  const { longitudeDegrees, latitudeDegrees, height } = value.destination;
  const { heading, pitch, roll } = value.orientation;
  const values = [longitudeDegrees, latitudeDegrees, height, heading, pitch, roll];
  return (
    values.every((candidate) => typeof candidate === "number" && Number.isFinite(candidate)) &&
    (longitudeDegrees as number) >= -180 &&
    (longitudeDegrees as number) <= 180 &&
    (latitudeDegrees as number) >= -90 &&
    (latitudeDegrees as number) <= 90 &&
    (height as number) >= -1_000 &&
    (height as number) <= 10_000_000 &&
    Math.abs(heading as number) <= Math.PI * 8 &&
    Math.abs(pitch as number) <= Math.PI * 8 &&
    Math.abs(roll as number) <= Math.PI * 8
  );
}

function readCameraState(value: unknown): CameraState | null {
  if (!isValidCameraState(value)) {
    return null;
  }
  return {
    destination: { ...value.destination },
    orientation: { ...value.orientation },
  };
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(encoded: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded) || encoded.length % 4 === 1) {
    return null;
  }

  const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

export function encodeViewState(snapshot: ViewStateSnapshot): string {
  const payload = {
    v: VIEW_STATE_VERSION,
    camera:
      snapshot.camera && isValidCameraState(snapshot.camera) ? snapshot.camera : null,
    filter: snapshot.filter,
  };
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

export function decodeViewState(encoded: string): ViewStateSnapshot | null {
  if (encoded.length === 0 || encoded.length > MAX_ENCODED_STATE_LENGTH) {
    return null;
  }

  const bytes = base64UrlToBytes(encoded);
  if (!bytes) {
    return null;
  }

  try {
    const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (!isRecord(payload) || payload.v !== VIEW_STATE_VERSION) {
      return null;
    }

    const filter = parseFilterState(payload.filter);
    if (!filter) {
      return null;
    }

    if (payload.camera === null || payload.camera === undefined) {
      return { camera: null, filter };
    }

    const camera = readCameraState(payload.camera);
    return camera ? { camera, filter } : null;
  } catch {
    return null;
  }
}
