import { App } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUDGET_AMOUNT_USD,
  loadInfrastructureContext,
} from "../../infrastructure/config.ts";

function loadContext(context: Record<string, unknown> = {}) {
  const app = new App({ context });
  return loadInfrastructureContext(app);
}

describe("infrastructure CDK context", () => {
  it("uses a USD 10 budget default and leaves optional values absent", () => {
    expect(loadContext()).toEqual({
      budgetAmount: DEFAULT_BUDGET_AMOUNT_USD,
      fallbackEnabled: false,
    });
  });

  it("accepts and normalizes valid context values", () => {
    expect(
      loadContext({
        budgetEmail: "  alerts@example.com  ",
        budgetAmount: "12.50",
        devOrigin: "http://localhost:5173/",
        fallbackEnabled: "true",
      }),
    ).toEqual({
      budgetEmail: "alerts@example.com",
      budgetAmount: 12.5,
      devOrigin: "http://localhost:5173",
      fallbackEnabled: true,
    });
  });

  it.each([
    { fallbackEnabled: true, expected: true },
    { fallbackEnabled: false, expected: false },
    { fallbackEnabled: "true", expected: true },
    { fallbackEnabled: "false", expected: false },
  ])("accepts strict fallbackEnabled value $fallbackEnabled", ({
    expected,
    fallbackEnabled,
  }) => {
    expect(loadContext({ fallbackEnabled }).fallbackEnabled).toBe(expected);
  });

  it.each([
    { fallbackEnabled: 1 },
    { fallbackEnabled: "TRUE" },
    { fallbackEnabled: " false " },
    { fallbackEnabled: "" },
    { fallbackEnabled: null },
  ])("rejects an invalid fallbackEnabled", (context) => {
    expect(() => loadContext(context)).toThrowError(
      "CDK context fallbackEnabled must be true or false",
    );
  });

  it.each([
    { budgetEmail: true },
    { budgetEmail: "" },
    { budgetEmail: "not-an-email" },
    { budgetEmail: "user@example" },
  ])("rejects an invalid budgetEmail", (context) => {
    expect(() => loadContext(context)).toThrowError(
      "CDK context budgetEmail must be a valid email address",
    );
  });

  it.each([
    { budgetAmount: false },
    { budgetAmount: "" },
    { budgetAmount: "10.001" },
    { budgetAmount: 0 },
    { budgetAmount: Number.POSITIVE_INFINITY },
  ])("rejects an invalid budgetAmount", (context) => {
    expect(() => loadContext(context)).toThrowError(
      "CDK context budgetAmount must be a positive USD amount",
    );
  });

  it.each([
    { devOrigin: true },
    { devOrigin: "*" },
    { devOrigin: "ftp://localhost" },
    { devOrigin: "https://example.com/path" },
    { devOrigin: "https://user@example.com" },
  ])("rejects an invalid devOrigin", (context) => {
    expect(() => loadContext(context)).toThrowError(
      "CDK context devOrigin must be an HTTP(S) origin without a path",
    );
  });
});
