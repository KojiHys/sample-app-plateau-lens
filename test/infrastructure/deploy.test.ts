import { describe, expect, it, vi } from "vitest";

interface DeployConfig {
  readonly budgetAmount: string;
  readonly budgetEmail: string;
  readonly devOrigin?: string;
  readonly fallbackEnabled: string;
}

const deployScript = (await import(
  new URL("../../scripts/deploy.mjs", import.meta.url).href
)) as {
  buildCdkDeployArguments: (
    config: DeployConfig,
    userArguments?: string[],
  ) => string[];
  runDeploy: (
    environment: Record<string, string | undefined>,
    userArguments: string[],
    spawnCommand: (
      command: string,
      arguments_: string[],
      options: { shell: boolean; stdio: string },
    ) => { error?: Error; status: number | null },
  ) => number;
  validateDeployEnvironment: (
    environment: Record<string, string | undefined>,
  ) => DeployConfig;
};
const {
  buildCdkDeployArguments,
  runDeploy,
  validateDeployEnvironment,
} = deployScript;

describe("deploy environment validation", () => {
  it("applies safe defaults and normalizes optional values", () => {
    expect(
      validateDeployEnvironment({
        BUDGET_EMAIL: "  alerts@company.co.jp  ",
        DEV_ORIGIN: "http://localhost:5173/",
      }),
    ).toEqual({
      budgetAmount: "10",
      budgetEmail: "alerts@company.co.jp",
      devOrigin: "http://localhost:5173",
      fallbackEnabled: "false",
    });
  });

  it.each([
    {},
    { BUDGET_EMAIL: "" },
    { BUDGET_EMAIL: "not-an-email" },
    { BUDGET_EMAIL: "alerts@example.com" },
    { BUDGET_EMAIL: "alerts@sub.example.test" },
    { BUDGET_EMAIL: "alerts@domain.invalid" },
  ])("rejects a missing, invalid, or placeholder BUDGET_EMAIL", (environment) => {
    expect(() => validateDeployEnvironment(environment)).toThrowError(
      "BUDGET_EMAIL must be a non-placeholder valid email address",
    );
  });

  it.each([
    { BUDGET_EMAIL: "alerts@company.co.jp", BUDGET_AMOUNT: "" },
    { BUDGET_EMAIL: "alerts@company.co.jp", BUDGET_AMOUNT: "0" },
    { BUDGET_EMAIL: "alerts@company.co.jp", BUDGET_AMOUNT: "10.001" },
    { BUDGET_EMAIL: "alerts@company.co.jp", BUDGET_AMOUNT: "1000001" },
  ])("rejects invalid BUDGET_AMOUNT values", (environment) => {
    expect(() => validateDeployEnvironment(environment)).toThrowError(
      "BUDGET_AMOUNT must be a positive USD amount with at most two decimal places",
    );
  });

  it.each(["TRUE", " false ", "1", ""])(
    "rejects invalid FALLBACK_ENABLED value %s",
    (fallbackEnabled) => {
      expect(() =>
        validateDeployEnvironment({
          BUDGET_EMAIL: "alerts@company.co.jp",
          FALLBACK_ENABLED: fallbackEnabled,
        }),
      ).toThrowError("FALLBACK_ENABLED must be true or false");
    },
  );

  it.each([
    "*",
    "ftp://localhost",
    "https://example.net/path",
    "https://user@example.net",
  ])("rejects invalid DEV_ORIGIN value %s", (devOrigin) => {
    expect(() =>
      validateDeployEnvironment({
        BUDGET_EMAIL: "alerts@company.co.jp",
        DEV_ORIGIN: devOrigin,
      }),
    ).toThrowError("DEV_ORIGIN must be an HTTP(S) origin without a path");
  });

  it("places validated context after user arguments", () => {
    const config = validateDeployEnvironment({
      BUDGET_EMAIL: "alerts@company.co.jp",
      BUDGET_AMOUNT: "25.50",
      FALLBACK_ENABLED: "true",
      DEV_ORIGIN: "https://dev.company.co.jp",
    });

    expect(buildCdkDeployArguments(config, ["--profile", "sandbox"])).toEqual([
      "cdk",
      "deploy",
      "--profile",
      "sandbox",
      "-c",
      "budgetEmail=alerts@company.co.jp",
      "-c",
      "budgetAmount=25.50",
      "-c",
      "fallbackEnabled=true",
      "-c",
      "devOrigin=https://dev.company.co.jp",
    ]);
  });

  it("returns the build failure code without starting CDK", () => {
    const spawnCommand = vi.fn(() => ({ status: 7 }));

    expect(
      runDeploy(
        {
          BUDGET_EMAIL: "alerts@company.co.jp",
          FALLBACK_ENABLED: "false",
        },
        [],
        spawnCommand,
      ),
    ).toBe(7);
    expect(spawnCommand).toHaveBeenCalledOnce();
    expect(spawnCommand).toHaveBeenCalledWith(
      "npm",
      ["run", "build"],
      { shell: false, stdio: "inherit" },
    );
  });

  it("returns the CDK failure code after a successful build", () => {
    const spawnCommand = vi
      .fn()
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 9 });

    expect(
      runDeploy(
        {
          BUDGET_EMAIL: "alerts@company.co.jp",
          FALLBACK_ENABLED: "true",
        },
        ["--profile", "sandbox"],
        spawnCommand,
      ),
    ).toBe(9);
    expect(spawnCommand).toHaveBeenCalledTimes(2);
    expect(spawnCommand.mock.calls[1]?.[0]).toBe("npx");
    expect(spawnCommand.mock.calls[1]?.[2]).toEqual({
      shell: false,
      stdio: "inherit",
    });
  });
});
