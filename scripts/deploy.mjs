import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BUDGET_AMOUNT = "10";
const MAX_BUDGET_AMOUNT = 1_000_000;
const EMAIL_ADDRESS_PATTERN =
  /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/iu;
const USD_AMOUNT_PATTERN = /^\d+(?:\.\d{1,2})?$/u;
const RESERVED_EMAIL_DOMAINS = [
  "example.com",
  "example.net",
  "example.org",
  "example.test",
];
const RESERVED_TOP_LEVEL_DOMAINS = new Set([
  "example",
  "invalid",
  "localhost",
  "test",
]);

function invalidEmail() {
  throw new Error(
    "BUDGET_EMAIL must be a non-placeholder valid email address",
  );
}

function validateBudgetEmail(value) {
  if (typeof value !== "string") {
    invalidEmail();
  }
  const email = value.trim();
  const atIndex = email.lastIndexOf("@");
  const domain = email.slice(atIndex + 1).toLowerCase();
  const topLevelDomain = domain.split(".").at(-1);
  if (
    email.length === 0 ||
    email.length > 254 ||
    atIndex < 1 ||
    atIndex > 64 ||
    email.startsWith(".") ||
    email.slice(0, atIndex).endsWith(".") ||
    email.includes("..") ||
    !EMAIL_ADDRESS_PATTERN.test(email) ||
    RESERVED_EMAIL_DOMAINS.some(
      (reserved) => domain === reserved || domain.endsWith(`.${reserved}`),
    ) ||
    topLevelDomain === undefined ||
    RESERVED_TOP_LEVEL_DOMAINS.has(topLevelDomain)
  ) {
    invalidEmail();
  }
  return email;
}

function validateBudgetAmount(value) {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(
      "BUDGET_AMOUNT must be a positive USD amount with at most two decimal places",
    );
  }
  const budgetAmount = value === undefined ? DEFAULT_BUDGET_AMOUNT : value.trim();
  const amount = Number(budgetAmount);
  if (
    !USD_AMOUNT_PATTERN.test(budgetAmount) ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > MAX_BUDGET_AMOUNT
  ) {
    throw new Error(
      "BUDGET_AMOUNT must be a positive USD amount with at most two decimal places",
    );
  }
  return budgetAmount;
}

function validateFallbackEnabled(value) {
  const fallbackEnabled = value ?? "false";
  if (fallbackEnabled !== "true" && fallbackEnabled !== "false") {
    throw new Error("FALLBACK_ENABLED must be true or false");
  }
  return fallbackEnabled;
}

function validateDevOrigin(value) {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  try {
    const url = new URL(value.trim());
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.pathname !== "/" ||
      url.search.length > 0 ||
      url.hash.length > 0 ||
      url.origin === "null"
    ) {
      throw new Error("invalid origin");
    }
    return url.origin;
  } catch {
    throw new Error("DEV_ORIGIN must be an HTTP(S) origin without a path");
  }
}

export function validateDeployEnvironment(environment) {
  const budgetEmail = validateBudgetEmail(environment.BUDGET_EMAIL);
  const budgetAmount = validateBudgetAmount(environment.BUDGET_AMOUNT);
  const fallbackEnabled = validateFallbackEnabled(environment.FALLBACK_ENABLED);
  const devOrigin = validateDevOrigin(environment.DEV_ORIGIN);
  return {
    budgetAmount,
    budgetEmail,
    fallbackEnabled,
    ...(devOrigin === undefined ? {} : { devOrigin }),
  };
}

export function buildCdkDeployArguments(config, userArguments = []) {
  return [
    "cdk",
    "deploy",
    ...userArguments,
    "-c",
    `budgetEmail=${config.budgetEmail}`,
    "-c",
    `budgetAmount=${config.budgetAmount}`,
    "-c",
    `fallbackEnabled=${config.fallbackEnabled}`,
    ...(config.devOrigin === undefined
      ? []
      : ["-c", `devOrigin=${config.devOrigin}`]),
  ];
}

function commandExitCode(result, commandName) {
  if (result.error !== undefined) {
    process.stderr.write(`${commandName} could not be started.\n`);
    return 1;
  }
  return result.status ?? 1;
}

export function runDeploy(
  environment = process.env,
  userArguments = process.argv.slice(2),
  spawnCommand = spawnSync,
) {
  let config;
  try {
    config = validateDeployEnvironment(environment);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid deployment environment";
    process.stderr.write(`${message}\n`);
    return 1;
  }

  const buildResult = spawnCommand("npm", ["run", "build"], {
    shell: false,
    stdio: "inherit",
  });
  const buildExitCode = commandExitCode(buildResult, "npm run build");
  if (buildExitCode !== 0) {
    return buildExitCode;
  }

  const deployResult = spawnCommand(
    "npx",
    buildCdkDeployArguments(config, userArguments),
    {
      shell: false,
      stdio: "inherit",
    },
  );
  return commandExitCode(deployResult, "npx cdk deploy");
}

const isMainModule =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMainModule) {
  process.exitCode = runDeploy();
}
