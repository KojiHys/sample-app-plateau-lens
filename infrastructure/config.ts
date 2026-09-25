import type { Construct } from "constructs";

export const APPLICATION_NAME = "sample-app-plateau-lens";
export const APPLICATION_REGION = "ap-northeast-1";
export const DEFAULT_BUDGET_AMOUNT_USD = 10;
export const DEFAULT_TILESET_URL =
  "https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/13101-bldg-lod2-notexture-latest/tileset.json";

const MAX_BUDGET_AMOUNT_USD = 1_000_000;
const EMAIL_ADDRESS_PATTERN =
  /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/iu;
const USD_AMOUNT_PATTERN = /^\d+(?:\.\d{1,2})?$/u;

export interface InfrastructureContext {
  readonly budgetAmount: number;
  readonly budgetEmail?: string;
  readonly devOrigin?: string;
  readonly fallbackEnabled: boolean;
}

function parseStrictBoolean(value: unknown): boolean {
  if (value === undefined) {
    return false;
  }
  if (value === true || value === "true") {
    return true;
  }
  if (value === false || value === "false") {
    return false;
  }
  throw new Error(
    "CDK context fallbackEnabled must be true or false",
  );
}

function parseBudgetEmail(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("CDK context budgetEmail must be a valid email address");
  }

  const email = value.trim();
  const atIndex = email.lastIndexOf("@");
  if (
    email.length > 254 ||
    atIndex < 1 ||
    atIndex > 64 ||
    email.startsWith(".") ||
    email.slice(0, atIndex).endsWith(".") ||
    email.includes("..") ||
    !EMAIL_ADDRESS_PATTERN.test(email)
  ) {
    throw new Error("CDK context budgetEmail must be a valid email address");
  }
  return email;
}

function parseBudgetAmount(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_BUDGET_AMOUNT_USD;
  }

  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && !USD_AMOUNT_PATTERN.test(value.trim()))
  ) {
    throw new Error("CDK context budgetAmount must be a positive USD amount");
  }

  const amount = typeof value === "number" ? value : Number(value.trim());
  const roundedCents = Math.round(amount * 100);
  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > MAX_BUDGET_AMOUNT_USD ||
    Math.abs(amount * 100 - roundedCents) > Number.EPSILON * 100
  ) {
    throw new Error("CDK context budgetAmount must be a positive USD amount");
  }
  return amount;
}

function parseOrigin(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("CDK context devOrigin must be an HTTP(S) origin without a path");
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
    throw new Error("CDK context devOrigin must be an HTTP(S) origin without a path");
  }
}

export function loadInfrastructureContext(scope: Construct): InfrastructureContext {
  const budgetEmail = parseBudgetEmail(
    scope.node.tryGetContext("budgetEmail") as unknown,
  );
  const budgetAmount = parseBudgetAmount(
    scope.node.tryGetContext("budgetAmount") as unknown,
  );
  const devOrigin = parseOrigin(scope.node.tryGetContext("devOrigin") as unknown);
  const fallbackEnabled = parseStrictBoolean(
    scope.node.tryGetContext("fallbackEnabled") as unknown,
  );

  return {
    budgetAmount,
    fallbackEnabled,
    ...(budgetEmail === undefined ? {} : { budgetEmail }),
    ...(devOrigin === undefined ? {} : { devOrigin }),
  };
}
