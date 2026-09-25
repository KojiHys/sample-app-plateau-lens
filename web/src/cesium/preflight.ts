import {
  createFloodPreflightShowExpression,
  evaluateFloodPreflight,
} from "./style-expression.ts";

export interface PreflightReport {
  expression: string;
  ionRequests: string[];
  japaneseAttributeExpressionPassed: boolean;
}

function isIonHost(resourceName: string): boolean {
  try {
    const hostname = new URL(resourceName, window.location.href).hostname;
    return hostname === "cesium.com" || hostname.endsWith(".cesium.com");
  } catch {
    return false;
  }
}

export function findCesiumIonRequests(): string[] {
  return performance
    .getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter(isIonHost);
}

export function runPreflight(): PreflightReport {
  return {
    expression: createFloodPreflightShowExpression(),
    ionRequests: findCesiumIonRequests(),
    japaneseAttributeExpressionPassed:
      evaluateFloodPreflight(0.5) && !evaluateFloodPreflight(0.49),
  };
}
