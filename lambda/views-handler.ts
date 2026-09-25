import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import {
  CATEGORY_FILTER_KEYS,
  NUMERIC_FILTER_KEYS,
  TILESET_RANGES,
} from "../web/src/cesium/attributes.ts";
import type {
  CameraState,
  CategoryValue,
  ColorMode,
  FilterState,
} from "../web/src/view-state.ts";

const DEFAULT_GSI_NAME = "GSI1";
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 12;
const MAX_JSON_NODES = 5_000;
const MAX_ARRAY_LENGTH = 1_000;
const MAX_OBJECT_PROPERTIES = 256;
const MAX_JSON_STRING_BYTES = 8 * 1024;
const MAX_JSON_KEY_BYTES = 512;
const MAX_TITLE_CHARACTERS = 50;
const LIST_LIMIT = 100;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
} as const;
const NO_STORE_HEADERS = {
  ...JSON_HEADERS,
  "cache-control": "no-store",
} as const;
const PROTOTYPE_POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const POST_BODY_KEYS = new Set(["title", "filterState", "cameraState"]);
const FILTER_STATE_KEYS = new Set(["categoryExclusions", "colorMode", "numeric"]);
const CATEGORY_EXCLUSIONS_KEYS = new Set(CATEGORY_FILTER_KEYS);
const NUMERIC_KEYS = new Set(NUMERIC_FILTER_KEYS);
const NUMERIC_RANGE_KEYS = new Set(["min", "max"]);
const CAMERA_STATE_KEYS = new Set(["destination", "orientation"]);
const CAMERA_DESTINATION_KEYS = new Set([
  "longitudeDegrees",
  "latitudeDegrees",
  "height",
]);
const CAMERA_ORIENTATION_KEYS = new Set(["heading", "pitch", "roll"]);
const COLOR_MODES = new Set<ColorMode>(["none", "usage", "height", "floodDepth"]);
const MAX_CATEGORY_VALUES = 256;
const MAX_CATEGORY_STRING_LENGTH = 256;
const MAX_CAMERA_ORIENTATION = Math.PI * 8;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type ViewsApiEvent =
  | APIGatewayProxyEventV2
  | APIGatewayProxyEventV2WithJWTAuthorizer;
type JsonObject = Record<string, unknown>;

interface ViewsHandlerLogger {
  error(message: string, context: { requestId: string }): void;
}

export interface ViewsHandlerConfiguration {
  tableName: string;
  gsiName: string;
  appBaseUrl: string;
}

export interface ViewsHandlerOptions extends ViewsHandlerConfiguration {
  documentClient: Pick<DynamoDBDocumentClient, "send">;
  now?: () => Date;
  generateViewId?: () => string;
  logger?: ViewsHandlerLogger;
}

export type ViewsHandler = (
  event: ViewsApiEvent,
) => Promise<APIGatewayProxyStructuredResultV2>;

interface ValidatedPostBody {
  title: string;
  filterState: FilterState;
  cameraState: CameraState;
}

interface ValidationBudget {
  nodes: number;
}

interface ParseResult<T> {
  ok: boolean;
  value?: T;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainObject(value: unknown): value is JsonObject {
  if (!isRecord(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: JsonObject, expectedKeys: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expectedKeys.size && keys.every((key) => expectedKeys.has(key));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSupportedCategoryValue(value: unknown): value is CategoryValue {
  if (typeof value === "string") {
    return (
      value.trim().length > 0 &&
      value.length <= MAX_CATEGORY_STRING_LENGTH &&
      !/[\\\u0000-\u001f]/u.test(value)
    );
  }
  return typeof value === "boolean" || isFiniteNumber(value);
}

function parseCategoryExclusions(
  value: unknown,
): FilterState["categoryExclusions"] | null {
  if (!isPlainObject(value) || !hasExactKeys(value, CATEGORY_EXCLUSIONS_KEYS)) {
    return null;
  }

  const categoryExclusions = {} as FilterState["categoryExclusions"];
  for (const key of CATEGORY_FILTER_KEYS) {
    const candidate = value[key];
    if (!Array.isArray(candidate) || candidate.length > MAX_CATEGORY_VALUES) {
      return null;
    }

    const values: CategoryValue[] = [];
    for (const item of candidate) {
      if (!isSupportedCategoryValue(item)) {
        return null;
      }
      values.push(item);
    }
    categoryExclusions[key] = values;
  }
  return categoryExclusions;
}

function parseNumericRanges(value: unknown): FilterState["numeric"] | null {
  if (!isPlainObject(value) || !hasExactKeys(value, NUMERIC_KEYS)) {
    return null;
  }

  const numeric = {} as FilterState["numeric"];
  for (const key of NUMERIC_FILTER_KEYS) {
    const candidate = value[key];
    if (!isPlainObject(candidate) || !hasExactKeys(candidate, NUMERIC_RANGE_KEYS)) {
      return null;
    }

    const min = candidate.min;
    const max = candidate.max;
    const limits = TILESET_RANGES[key];
    if (
      !isFiniteNumber(min) ||
      !isFiniteNumber(max) ||
      min > max ||
      min < limits.min ||
      max > limits.max
    ) {
      return null;
    }
    numeric[key] = { min, max };
  }
  return numeric;
}

function parseFilterState(value: unknown): FilterState | null {
  if (!isPlainObject(value) || !hasExactKeys(value, FILTER_STATE_KEYS)) {
    return null;
  }

  const colorMode = value.colorMode;
  if (typeof colorMode !== "string" || !COLOR_MODES.has(colorMode as ColorMode)) {
    return null;
  }

  const categoryExclusions = parseCategoryExclusions(value.categoryExclusions);
  const numeric = parseNumericRanges(value.numeric);
  if (categoryExclusions === null || numeric === null) {
    return null;
  }

  return {
    categoryExclusions,
    colorMode: colorMode as ColorMode,
    numeric,
  };
}

function parseCameraState(value: unknown): CameraState | null {
  if (!isPlainObject(value) || !hasExactKeys(value, CAMERA_STATE_KEYS)) {
    return null;
  }
  const destination = value.destination;
  const orientation = value.orientation;
  if (
    !isPlainObject(destination) ||
    !hasExactKeys(destination, CAMERA_DESTINATION_KEYS) ||
    !isPlainObject(orientation) ||
    !hasExactKeys(orientation, CAMERA_ORIENTATION_KEYS)
  ) {
    return null;
  }

  const { longitudeDegrees, latitudeDegrees, height } = destination;
  const { heading, pitch, roll } = orientation;
  if (
    !isFiniteNumber(longitudeDegrees) ||
    longitudeDegrees < -180 ||
    longitudeDegrees > 180 ||
    !isFiniteNumber(latitudeDegrees) ||
    latitudeDegrees < -90 ||
    latitudeDegrees > 90 ||
    !isFiniteNumber(height) ||
    height < -1_000 ||
    height > 10_000_000 ||
    !isFiniteNumber(heading) ||
    Math.abs(heading) > MAX_CAMERA_ORIENTATION ||
    !isFiniteNumber(pitch) ||
    Math.abs(pitch) > MAX_CAMERA_ORIENTATION ||
    !isFiniteNumber(roll) ||
    Math.abs(roll) > MAX_CAMERA_ORIENTATION
  ) {
    return null;
  }

  return {
    destination: { longitudeDegrees, latitudeDegrees, height },
    orientation: { heading, pitch, roll },
  };
}

function isSafeJsonValue(
  value: unknown,
  depth: number,
  budget: ValidationBudget,
): boolean {
  budget.nodes += 1;
  if (budget.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    return false;
  }

  if (value === null || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value === "string") {
    return Buffer.byteLength(value, "utf8") <= MAX_JSON_STRING_BYTES;
  }
  if (Array.isArray(value)) {
    return (
      value.length <= MAX_ARRAY_LENGTH &&
      value.every((item) => isSafeJsonValue(item, depth + 1, budget))
    );
  }
  if (!isPlainObject(value)) {
    return false;
  }

  const entries = Object.entries(value);
  if (entries.length > MAX_OBJECT_PROPERTIES) {
    return false;
  }
  for (const [key, child] of entries) {
    if (
      PROTOTYPE_POLLUTION_KEYS.has(key) ||
      Buffer.byteLength(key, "utf8") > MAX_JSON_KEY_BYTES ||
      !isSafeJsonValue(child, depth + 1, budget)
    ) {
      return false;
    }
  }
  return true;
}

function decodeBody(event: ViewsApiEvent): string | null {
  if (event.body === undefined || event.body.length === 0) {
    return null;
  }

  if (!event.isBase64Encoded) {
    return Buffer.byteLength(event.body, "utf8") <= MAX_REQUEST_BODY_BYTES
      ? event.body
      : null;
  }

  const maxEncodedLength = Math.ceil(MAX_REQUEST_BODY_BYTES / 3) * 4 + 4;
  if (
    event.body.length > maxEncodedLength ||
    event.body.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      event.body,
    )
  ) {
    return null;
  }

  try {
    const decoded = Buffer.from(event.body, "base64");
    if (decoded.byteLength > MAX_REQUEST_BODY_BYTES) {
      return null;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    return null;
  }
}

function parsePostBody(event: ViewsApiEvent): ParseResult<ValidatedPostBody> {
  const bodyText = decodeBody(event);
  if (bodyText === null) {
    return { ok: false };
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText) as unknown;
  } catch {
    return { ok: false };
  }
  if (!isPlainObject(body)) {
    return { ok: false };
  }

  const keys = Object.keys(body);
  if (keys.length !== POST_BODY_KEYS.size || keys.some((key) => !POST_BODY_KEYS.has(key))) {
    return { ok: false };
  }

  if (
    typeof body.title !== "string" ||
    !isPlainObject(body.filterState) ||
    !isPlainObject(body.cameraState)
  ) {
    return { ok: false };
  }

  const title = body.title.trim();
  const titleLength = Array.from(title).length;
  if (
    titleLength < 1 ||
    titleLength > MAX_TITLE_CHARACTERS ||
    /[\u0000-\u001f\u007f]/u.test(title)
  ) {
    return { ok: false };
  }

  const validationBudget: ValidationBudget = { nodes: 0 };
  if (
    !isSafeJsonValue(body.filterState, 0, validationBudget) ||
    !isSafeJsonValue(body.cameraState, 0, validationBudget)
  ) {
    return { ok: false };
  }

  const filterState = parseFilterState(body.filterState);
  const cameraState = parseCameraState(body.cameraState);
  if (filterState === null || cameraState === null) {
    return { ok: false };
  }

  return {
    ok: true,
    value: {
      title,
      filterState,
      cameraState,
    },
  };
}

function getJwtSubject(event: ViewsApiEvent): string | null {
  const requestContext = event.requestContext as unknown;
  if (!isRecord(requestContext) || !isRecord(requestContext.authorizer)) {
    return null;
  }
  const jwt = requestContext.authorizer.jwt;
  if (!isRecord(jwt) || !isRecord(jwt.claims)) {
    return null;
  }

  const subject = jwt.claims.sub;
  return typeof subject === "string" && subject.trim().length > 0 ? subject : null;
}

function jsonResponse(
  statusCode: number,
  body: JsonObject,
  noStore = false,
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: noStore ? NO_STORE_HEADERS : JSON_HEADERS,
    body: JSON.stringify(body),
  };
}

function unauthorizedResponse(): APIGatewayProxyStructuredResultV2 {
  return jsonResponse(401, { message: "Unauthorized" });
}

function invalidRequestResponse(noStore = false): APIGatewayProxyStructuredResultV2 {
  return jsonResponse(400, { message: "Invalid request" }, noStore);
}

function notFoundResponse(noStore = false): APIGatewayProxyStructuredResultV2 {
  return jsonResponse(404, { message: "Not found" }, noStore);
}

function validateNonEmptyConfigurationValue(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${name} must be configured with a non-empty value`);
  }
  return normalized;
}

function validateAppBaseUrl(value: string): string {
  const normalized = validateNonEmptyConfigurationValue(value, "APP_BASE_URL");
  try {
    const url = new URL(normalized);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      throw new Error("unsupported URL");
    }
    return url.toString();
  } catch {
    throw new Error("APP_BASE_URL must be an absolute HTTP(S) URL without credentials");
  }
}

export function loadViewsHandlerConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): ViewsHandlerConfiguration {
  const tableName = environment.TABLE_NAME;
  const appBaseUrl = environment.APP_BASE_URL;
  if (tableName === undefined || tableName.trim().length === 0) {
    throw new Error("Missing required environment variable: TABLE_NAME");
  }
  if (appBaseUrl === undefined || appBaseUrl.trim().length === 0) {
    throw new Error("Missing required environment variable: APP_BASE_URL");
  }

  const gsiName = environment.GSI_NAME ?? DEFAULT_GSI_NAME;
  return {
    tableName: validateNonEmptyConfigurationValue(tableName, "TABLE_NAME"),
    gsiName: validateNonEmptyConfigurationValue(gsiName, "GSI_NAME"),
    appBaseUrl: validateAppBaseUrl(appBaseUrl),
  };
}

function buildShareUrl(appBaseUrl: string, viewId: string): string {
  const shareUrl = new URL(appBaseUrl);
  shareUrl.searchParams.set("viewId", viewId);
  return shareUrl.toString();
}

function getValidatedViewId(event: ViewsApiEvent): string | null {
  const viewId = event.pathParameters?.viewId;
  return typeof viewId === "string" && UUID_V4_PATTERN.test(viewId) ? viewId : null;
}

function readPublicView(item: JsonObject): JsonObject | null {
  if (
    typeof item.viewId !== "string" ||
    typeof item.title !== "string" ||
    typeof item.createdAt !== "string" ||
    !isPlainObject(item.filterState) ||
    !isPlainObject(item.cameraState)
  ) {
    return null;
  }

  const validationBudget: ValidationBudget = { nodes: 0 };
  if (
    !isSafeJsonValue(item.filterState, 0, validationBudget) ||
    !isSafeJsonValue(item.cameraState, 0, validationBudget)
  ) {
    return null;
  }

  return {
    viewId: item.viewId,
    title: item.title,
    filterState: item.filterState,
    cameraState: item.cameraState,
    createdAt: item.createdAt,
  };
}

function readListItems(items: JsonObject[] | undefined): JsonObject[] {
  if (!items) {
    return [];
  }

  const result: JsonObject[] = [];
  for (const item of items.slice(0, LIST_LIMIT)) {
    if (
      typeof item.viewId === "string" &&
      typeof item.title === "string" &&
      typeof item.createdAt === "string"
    ) {
      result.push({
        viewId: item.viewId,
        title: item.title,
        createdAt: item.createdAt,
      });
    }
  }
  return result;
}

function isConditionalCheckFailure(error: unknown): boolean {
  return isRecord(error) && error.name === "ConditionalCheckFailedException";
}

export function createViewsHandler(options: ViewsHandlerOptions): ViewsHandler {
  const tableName = validateNonEmptyConfigurationValue(options.tableName, "TABLE_NAME");
  const gsiName = validateNonEmptyConfigurationValue(options.gsiName, "GSI_NAME");
  const appBaseUrl = validateAppBaseUrl(options.appBaseUrl);
  const now = options.now ?? (() => new Date());
  const generateViewId = options.generateViewId ?? randomUUID;
  const logger = options.logger ?? console;

  return async (event: ViewsApiEvent): Promise<APIGatewayProxyStructuredResultV2> => {
    try {
      switch (event.routeKey) {
        case "POST /views": {
          const ownerSub = getJwtSubject(event);
          if (ownerSub === null) {
            return unauthorizedResponse();
          }

          const parsedBody = parsePostBody(event);
          if (!parsedBody.ok || parsedBody.value === undefined) {
            return invalidRequestResponse();
          }

          const viewId = generateViewId();
          if (!UUID_V4_PATTERN.test(viewId)) {
            throw new Error("The configured UUID generator did not return a UUID v4");
          }
          const createdAt = now().toISOString();
          await options.documentClient.send(
            new PutCommand({
              TableName: tableName,
              Item: {
                viewId,
                ownerSub,
                title: parsedBody.value.title,
                filterState: parsedBody.value.filterState,
                cameraState: parsedBody.value.cameraState,
                createdAt,
              },
              ConditionExpression: "attribute_not_exists(#viewId)",
              ExpressionAttributeNames: {
                "#viewId": "viewId",
              },
            }),
          );

          return jsonResponse(201, {
            viewId,
            shareUrl: buildShareUrl(appBaseUrl, viewId),
          });
        }

        case "GET /views": {
          const ownerSub = getJwtSubject(event);
          if (ownerSub === null) {
            return unauthorizedResponse();
          }

          const result = await options.documentClient.send(
            new QueryCommand({
              TableName: tableName,
              IndexName: gsiName,
              KeyConditionExpression: "#ownerSub = :ownerSub",
              ExpressionAttributeNames: {
                "#ownerSub": "ownerSub",
                "#viewId": "viewId",
                "#title": "title",
                "#createdAt": "createdAt",
              },
              ExpressionAttributeValues: {
                ":ownerSub": ownerSub,
              },
              ProjectionExpression: "#viewId, #title, #createdAt",
              ScanIndexForward: false,
              Limit: LIST_LIMIT,
            }),
          );

          return jsonResponse(200, {
            items: readListItems(result.Items),
          });
        }

        case "GET /views/{viewId}": {
          const viewId = getValidatedViewId(event);
          if (viewId === null) {
            return invalidRequestResponse(true);
          }

          const result = await options.documentClient.send(
            new GetCommand({
              TableName: tableName,
              Key: { viewId },
            }),
          );
          if (result.Item === undefined) {
            return notFoundResponse(true);
          }

          const publicView = readPublicView(result.Item);
          if (publicView === null) {
            throw new Error("Stored view data is invalid");
          }
          return jsonResponse(200, publicView, true);
        }

        case "DELETE /views/{viewId}": {
          const ownerSub = getJwtSubject(event);
          if (ownerSub === null) {
            return unauthorizedResponse();
          }

          const viewId = getValidatedViewId(event);
          if (viewId === null) {
            return invalidRequestResponse();
          }

          const result = await options.documentClient.send(
            new GetCommand({
              TableName: tableName,
              Key: { viewId },
              ProjectionExpression: "#ownerSub",
              ExpressionAttributeNames: {
                "#ownerSub": "ownerSub",
              },
            }),
          );
          if (result.Item === undefined) {
            return notFoundResponse();
          }
          if (result.Item.ownerSub !== ownerSub) {
            return jsonResponse(403, { message: "Forbidden" });
          }

          try {
            await options.documentClient.send(
              new DeleteCommand({
                TableName: tableName,
                Key: { viewId },
                ConditionExpression: "#ownerSub = :ownerSub",
                ExpressionAttributeNames: {
                  "#ownerSub": "ownerSub",
                },
                ExpressionAttributeValues: {
                  ":ownerSub": ownerSub,
                },
              }),
            );
          } catch (error) {
            if (isConditionalCheckFailure(error)) {
              return notFoundResponse();
            }
            throw error;
          }

          return { statusCode: 204 };
        }

        default:
          return notFoundResponse();
      }
    } catch {
      logger.error("Unhandled views handler error", {
        requestId: event.requestContext.requestId,
      });
      return jsonResponse(
        500,
        { message: "Internal server error" },
        event.routeKey === "GET /views/{viewId}",
      );
    }
  };
}

const defaultConfiguration = loadViewsHandlerConfiguration();
const defaultDocumentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const handler = createViewsHandler({
  ...defaultConfiguration,
  documentClient: defaultDocumentClient,
});
