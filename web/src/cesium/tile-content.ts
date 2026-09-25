import { ATTRIBUTES } from "./attributes.ts";
import {
  categoryValueKey,
  isSupportedCategoryValue,
  type CategoryValue,
} from "../view-state.ts";

export interface CategoryValues {
  districtsAndZones: CategoryValue[];
  usage: CategoryValue[];
}

interface FeatureReader {
  getProperty(propertyName: string): unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFeatureReader(value: unknown): value is FeatureReader {
  return isRecord(value) && typeof value.getProperty === "function";
}

function readInnerContents(content: Record<string, unknown>): unknown[] {
  try {
    return Array.isArray(content.innerContents) ? content.innerContents : [];
  } catch {
    return [];
  }
}

export function forEachTileFeature(
  content: unknown,
  visit: (feature: FeatureReader) => void,
): void {
  const visited = new Set<object>();

  function traverse(candidate: unknown): void {
    if (!isRecord(candidate) || visited.has(candidate)) {
      return;
    }
    visited.add(candidate);

    const innerContents = readInnerContents(candidate);
    if (innerContents.length > 0) {
      for (const innerContent of innerContents) {
        traverse(innerContent);
      }
      return;
    }

    let featuresLength: unknown;
    let getFeature: unknown;
    try {
      featuresLength = candidate.featuresLength;
      getFeature = candidate.getFeature;
    } catch {
      return;
    }
    if (
      typeof featuresLength !== "number" ||
      !Number.isSafeInteger(featuresLength) ||
      featuresLength < 0 ||
      featuresLength > 1_000_000 ||
      typeof getFeature !== "function"
    ) {
      return;
    }

    for (let index = 0; index < featuresLength; index += 1) {
      try {
        const feature = getFeature.call(candidate, index) as unknown;
        if (isFeatureReader(feature)) {
          visit(feature);
        }
      } catch {
        // A malformed feature should not prevent discovery in the rest of a tile.
      }
    }
  }

  traverse(content);
}

export function normalizeCategoryValue(value: unknown): CategoryValue | null {
  return isSupportedCategoryValue(value) ? value : null;
}

function readProperty(feature: FeatureReader, propertyName: string): unknown {
  try {
    return feature.getProperty(propertyName);
  } catch {
    return undefined;
  }
}

function sortedUnique(values: readonly CategoryValue[]): CategoryValue[] {
  const unique = new Map<string, CategoryValue>();
  for (const value of values) {
    unique.set(categoryValueKey(value), value);
  }
  return [...unique.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, value]) => value);
}

export function collectCategoryValues(content: unknown): CategoryValues {
  const districtsAndZones: CategoryValue[] = [];
  const usage: CategoryValue[] = [];

  forEachTileFeature(content, (feature) => {
    const usageValue = normalizeCategoryValue(readProperty(feature, ATTRIBUTES.usage));
    const districtValue = normalizeCategoryValue(
      readProperty(feature, ATTRIBUTES.districtsAndZones),
    );
    if (usageValue !== null) {
      usage.push(usageValue);
    }
    if (districtValue !== null) {
      districtsAndZones.push(districtValue);
    }
  });

  return {
    districtsAndZones: sortedUnique(districtsAndZones),
    usage: sortedUnique(usage),
  };
}

export function mergeCategoryValues(
  current: CategoryValues,
  discovered: CategoryValues,
): CategoryValues {
  return {
    districtsAndZones: sortedUnique([
      ...current.districtsAndZones,
      ...discovered.districtsAndZones,
    ]),
    usage: sortedUnique([...current.usage, ...discovered.usage]),
  };
}
