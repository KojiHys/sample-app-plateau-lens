import { describe, expect, it } from "vitest";
import {
  ATTRIBUTE_PANEL_FIELDS,
  ATTRIBUTES,
} from "../../web/src/cesium/attributes.ts";
import {
  UNDEFINED_ATTRIBUTE_LABEL,
  buildFeatureDetails,
  formatAttributeValue,
} from "../../web/src/cesium/feature-details.ts";

describe("selected-building details", () => {
  it("defines every section 3.5 attribute", () => {
    expect(ATTRIBUTE_PANEL_FIELDS).toHaveLength(10);
    expect(ATTRIBUTE_PANEL_FIELDS.map(({ attribute }) => attribute)).toEqual([
      ATTRIBUTES.buildingClass,
      ATTRIBUTES.address,
      ATTRIBUTES.storeysBelowGround,
      ATTRIBUTES.buildingId,
      ATTRIBUTES.buildingCoverageRate,
      ATTRIBUTES.floorAreaRate,
      ATTRIBUTES.fireproofStructure,
      ATTRIBUTES.sumidaFloodDepth,
      ATTRIBUTES.stormSurgeFloodDepth,
      ATTRIBUTES.landslideRisk,
    ]);
  });

  it("formats missing and structured values explicitly", () => {
    expect(formatAttributeValue(undefined)).toBe(UNDEFINED_ATTRIBUTE_LABEL);
    expect(formatAttributeValue("  ")).toBe(UNDEFINED_ATTRIBUTE_LABEL);
    expect(formatAttributeValue(Number.NaN)).toBe(UNDEFINED_ATTRIBUTE_LABEL);
    expect(formatAttributeValue({ ward: "千代田区" })).toBe('{"ward":"千代田区"}');
    expect(formatAttributeValue(70, "%")).toBe("70 %");
  });

  it("reads panel values without allowing one broken property to abort the panel", () => {
    const details = buildFeatureDetails({
      getProperty: (name: string): unknown => {
        if (name === ATTRIBUTES.address) {
          return "東京都千代田区";
        }
        if (name === ATTRIBUTES.buildingId) {
          throw new Error("metadata unavailable");
        }
        return undefined;
      },
    });

    expect(details.find(({ label }) => label === "住所")?.value).toBe("東京都千代田区");
    expect(details.find(({ label }) => label === "建物ID")?.value).toBe(
      UNDEFINED_ATTRIBUTE_LABEL,
    );
  });
});
