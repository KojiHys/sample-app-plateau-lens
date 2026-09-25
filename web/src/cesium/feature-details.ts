import { ATTRIBUTE_PANEL_FIELDS } from "./attributes.ts";

export interface AttributeDetail {
  label: string;
  value: string;
}

export interface FeaturePropertyReader {
  getProperty(propertyName: string): unknown;
}

export const UNDEFINED_ATTRIBUTE_LABEL = "未定義";

function formatStructuredValue(value: object): string | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized && serialized !== "{}" && serialized !== "[]" ? serialized : null;
  } catch {
    return null;
  }
}

export function formatAttributeValue(value: unknown, unit?: string): string {
  let formatted: string | null = null;

  if (typeof value === "string") {
    formatted = value.trim().length > 0 ? value : null;
  } else if (typeof value === "number") {
    formatted = Number.isFinite(value) ? String(value) : null;
  } else if (typeof value === "boolean") {
    formatted = value ? "true" : "false";
  } else if (typeof value === "object" && value !== null) {
    formatted = formatStructuredValue(value);
  }

  if (formatted === null) {
    return UNDEFINED_ATTRIBUTE_LABEL;
  }
  return unit ? `${formatted} ${unit}` : formatted;
}

export function buildFeatureDetails(feature: FeaturePropertyReader): AttributeDetail[] {
  return ATTRIBUTE_PANEL_FIELDS.map((field) => {
    let value: unknown;
    try {
      value = feature.getProperty(field.attribute);
    } catch {
      value = undefined;
    }

    return {
      label: field.label,
      value: formatAttributeValue(value, "unit" in field ? field.unit : undefined),
    };
  });
}
