import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { describe, expect, it, vi } from "vitest";

const previousTableName = process.env.TABLE_NAME;
const previousGsiName = process.env.GSI_NAME;
const previousAppBaseUrl = process.env.APP_BASE_URL;
process.env.TABLE_NAME = "module-load-test-table";
delete process.env.GSI_NAME;
process.env.APP_BASE_URL = "https://module-load.example.test/app";
const viewsHandlerModule = await import("../../lambda/views-handler.ts");
restoreEnvironmentVariable("TABLE_NAME", previousTableName);
restoreEnvironmentVariable("GSI_NAME", previousGsiName);
restoreEnvironmentVariable("APP_BASE_URL", previousAppBaseUrl);

const { createViewsHandler, loadViewsHandlerConfiguration } = viewsHandlerModule;

const TABLE_NAME = "test-views";
const GSI_NAME = "OwnerCreatedAt";
const APP_BASE_URL = "https://app.example.test/map";
const OWNER_SUB = "owner-sub-123";
const OTHER_OWNER_SUB = "other-owner-sub-456";
const VIEW_ID = "123e4567-e89b-42d3-a456-426614174000";
const CREATED_AT = "2026-09-24T12:34:56.789Z";

type ViewsEvent =
  | APIGatewayProxyEventV2
  | APIGatewayProxyEventV2WithJWTAuthorizer;

interface EventOptions {
  body?: string;
  isBase64Encoded?: boolean;
  jwtSub?: string;
  pathParameters?: Record<string, string>;
  queryStringParameters?: Record<string, string>;
}

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function createEvent(routeKey: string, options: EventOptions = {}): ViewsEvent {
  const requestContextBase = {
    accountId: "123456789012",
    apiId: "api-id",
    domainName: "api.example.test",
    domainPrefix: "api",
    http: {
      method: routeKey.split(" ")[0] ?? "GET",
      path: "/views",
      protocol: "HTTP/1.1",
      sourceIp: "192.0.2.1",
      userAgent: "vitest",
    },
    requestId: "request-123",
    routeKey,
    stage: "$default",
    time: "24/Sep/2026:12:34:56 +0000",
    timeEpoch: 1_798_076_096_789,
  };
  const requestContext =
    options.jwtSub === undefined
      ? requestContextBase
      : {
          ...requestContextBase,
          authorizer: {
            integrationLatency: 1,
            principalId: options.jwtSub,
            jwt: {
              claims: { sub: options.jwtSub },
              scopes: [],
            },
          },
        };

  return {
    version: "2.0",
    routeKey,
    rawPath: "/views",
    rawQueryString: "",
    headers: {},
    requestContext,
    isBase64Encoded: options.isBase64Encoded ?? false,
    ...(options.body === undefined ? {} : { body: options.body }),
    ...(options.pathParameters === undefined
      ? {}
      : { pathParameters: options.pathParameters }),
    ...(options.queryStringParameters === undefined
      ? {}
      : { queryStringParameters: options.queryStringParameters }),
  } as ViewsEvent;
}

function validFilterState() {
  return {
    categoryExclusions: {
      usage: ["office", 101, true, "office"],
      districtsAndZones: [],
    },
    colorMode: "floodDepth",
    numeric: {
      height: { min: 0.8, max: 209.5 },
      storeysAboveGround: { min: 1, max: 44 },
      roofArea: { min: 1.54, max: 22_322.6 },
      floodDepth: { min: 0.5, max: 3.42 },
    },
  };
}

function validCameraState() {
  return {
    destination: {
      longitudeDegrees: 139.75,
      latitudeDegrees: 35.69,
      height: 1_000,
    },
    orientation: { heading: 0, pitch: -0.5, roll: 0 },
  };
}

function validPostBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: "  Chiyoda flood view  ",
    filterState: validFilterState(),
    cameraState: validCameraState(),
    ...overrides,
  });
}

function postBodyWithStates(
  filterState: unknown,
  cameraState: unknown = validCameraState(),
): string {
  return validPostBody({ filterState, cameraState });
}

function parseResponseBody(response: APIGatewayProxyStructuredResultV2): unknown {
  if (response.body === undefined) {
    throw new Error("Expected a JSON response body");
  }
  return JSON.parse(response.body) as unknown;
}

function createFixture() {
  const send = vi.fn();
  const loggerError = vi.fn();
  const handler = createViewsHandler({
    tableName: TABLE_NAME,
    gsiName: GSI_NAME,
    appBaseUrl: APP_BASE_URL,
    documentClient: {
      send: send as unknown as DynamoDBDocumentClient["send"],
    },
    now: () => new Date(CREATED_AT),
    generateViewId: () => VIEW_ID,
    logger: { error: loggerError },
  });
  return { handler, loggerError, send };
}

function expectJsonContentType(response: APIGatewayProxyStructuredResultV2): void {
  expect(response.headers).toMatchObject({
    "content-type": "application/json; charset=utf-8",
  });
  expect(response.headers).not.toHaveProperty("access-control-allow-origin");
}

describe("views Lambda configuration", () => {
  it("uses GSI1 when GSI_NAME is not configured", () => {
    expect(
      loadViewsHandlerConfiguration({
        TABLE_NAME: " views-table ",
        APP_BASE_URL: "https://app.example.test/map",
      }),
    ).toEqual({
      tableName: "views-table",
      gsiName: "GSI1",
      appBaseUrl: "https://app.example.test/map",
    });
  });

  it("fails clearly without including configured values in startup errors", () => {
    expect(() => loadViewsHandlerConfiguration({ APP_BASE_URL: "https://app.example.test" })).toThrow(
      "Missing required environment variable: TABLE_NAME",
    );
    expect(() =>
      loadViewsHandlerConfiguration({
        TABLE_NAME: "views-table",
        APP_BASE_URL: "not-a-url-with-secret-value",
      }),
    ).toThrow("APP_BASE_URL must be an absolute HTTP(S) URL without credentials");

    try {
      loadViewsHandlerConfiguration({
        TABLE_NAME: "views-table",
        APP_BASE_URL: "not-a-url-with-secret-value",
      });
    } catch (error) {
      expect(String(error)).not.toContain("secret-value");
    }
  });
});

describe("POST /views", () => {
  it("stores a validated view owned by the JWT subject and returns a capability URL", async () => {
    const { handler, send } = createFixture();
    send.mockResolvedValueOnce({});

    const response = await handler(
      createEvent("POST /views", {
        jwtSub: OWNER_SUB,
        body: validPostBody(),
      }),
    );

    expect(response.statusCode).toBe(201);
    expectJsonContentType(response);
    expect(parseResponseBody(response)).toEqual({
      viewId: VIEW_ID,
      shareUrl: `${APP_BASE_URL}?viewId=${VIEW_ID}`,
    });
    expect(send).toHaveBeenCalledTimes(1);

    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(PutCommand);
    if (!(command instanceof PutCommand)) {
      throw new Error("Expected PutCommand");
    }
    expect(command.input).toMatchObject({
      TableName: TABLE_NAME,
      Item: {
        viewId: VIEW_ID,
        ownerSub: OWNER_SUB,
        title: "Chiyoda flood view",
        filterState: {
          categoryExclusions: {
            usage: ["office", 101, true, "office"],
            districtsAndZones: [],
          },
          colorMode: "floodDepth",
          numeric: {
            height: { min: 0.8, max: 209.5 },
            storeysAboveGround: { min: 1, max: 44 },
            roofArea: { min: 1.54, max: 22_322.6 },
            floodDepth: { min: 0.5, max: 3.42 },
          },
        },
        cameraState: {
          destination: {
            longitudeDegrees: 139.75,
            latitudeDegrees: 35.69,
            height: 1_000,
          },
          orientation: { heading: 0, pitch: -0.5, roll: 0 },
        },
        createdAt: CREATED_AT,
      },
      ConditionExpression: "attribute_not_exists(#viewId)",
    });
    expect(command.input.Item).not.toHaveProperty("ownerName");
  });

  it.each([
    ["malformed JSON", "{not-json"],
    [
      "an empty title",
      JSON.stringify({ title: "   ", filterState: {}, cameraState: {} }),
    ],
    [
      "a title longer than 50 characters",
      JSON.stringify({ title: "あ".repeat(51), filterState: {}, cameraState: {} }),
    ],
    [
      "a non-object filterState",
      JSON.stringify({ title: "View", filterState: [], cameraState: {} }),
    ],
    [
      "a non-object cameraState",
      JSON.stringify({ title: "View", filterState: {}, cameraState: null }),
    ],
    ["a non-JSON number", '{"title":"View","filterState":{"value":NaN},"cameraState":{}}'],
    [
      "a client-supplied ownerSub",
      validPostBody({ ownerSub: OTHER_OWNER_SUB }),
    ],
    [
      "a prototype pollution key",
      '{"title":"View","filterState":{"__proto__":{"polluted":true}},"cameraState":{}}',
    ],
  ])("returns 400 for %s", async (_description, body) => {
    const { handler, send } = createFixture();

    const response = await handler(
      createEvent("POST /views", { jwtSub: OWNER_SUB, body }),
    );

    expect(response.statusCode).toBe(400);
    expect(parseResponseBody(response)).toEqual({ message: "Invalid request" });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty filterState", postBodyWithStates({})],
    ["an empty cameraState", postBodyWithStates(validFilterState(), {})],
    [
      "an unknown filterState key",
      postBodyWithStates({ ...validFilterState(), unexpected: true }),
    ],
    [
      "an unknown categoryExclusions key",
      postBodyWithStates({
        ...validFilterState(),
        categoryExclusions: {
          ...validFilterState().categoryExclusions,
          unexpected: [],
        },
      }),
    ],
    [
      "an unknown numeric key",
      postBodyWithStates({
        ...validFilterState(),
        numeric: { ...validFilterState().numeric, unexpected: { min: 0, max: 1 } },
      }),
    ],
    [
      "an unknown numeric range key",
      postBodyWithStates({
        ...validFilterState(),
        numeric: {
          ...validFilterState().numeric,
          height: { ...validFilterState().numeric.height, unexpected: 1 },
        },
      }),
    ],
    [
      "an unknown cameraState key",
      postBodyWithStates(validFilterState(), {
        ...validCameraState(),
        unexpected: true,
      }),
    ],
    [
      "an unknown camera destination key",
      postBodyWithStates(validFilterState(), {
        ...validCameraState(),
        destination: { ...validCameraState().destination, unexpected: 1 },
      }),
    ],
    [
      "an unknown camera orientation key",
      postBodyWithStates(validFilterState(), {
        ...validCameraState(),
        orientation: { ...validCameraState().orientation, unexpected: 1 },
      }),
    ],
    [
      "an unsupported colorMode",
      postBodyWithStates({ ...validFilterState(), colorMode: "temperature" }),
    ],
    [
      "height below its range",
      postBodyWithStates({
        ...validFilterState(),
        numeric: {
          ...validFilterState().numeric,
          height: { min: 0.79, max: 209.5 },
        },
      }),
    ],
    [
      "storeysAboveGround above its range",
      postBodyWithStates({
        ...validFilterState(),
        numeric: {
          ...validFilterState().numeric,
          storeysAboveGround: { min: 1, max: 45 },
        },
      }),
    ],
    [
      "roofArea above its range",
      postBodyWithStates({
        ...validFilterState(),
        numeric: {
          ...validFilterState().numeric,
          roofArea: { min: 1.54, max: 22_322.61 },
        },
      }),
    ],
    [
      "floodDepth below its range",
      postBodyWithStates({
        ...validFilterState(),
        numeric: {
          ...validFilterState().numeric,
          floodDepth: { min: 0.09, max: 3.42 },
        },
      }),
    ],
    [
      "a numeric minimum above its maximum",
      postBodyWithStates({
        ...validFilterState(),
        numeric: {
          ...validFilterState().numeric,
          floodDepth: { min: 2, max: 1 },
        },
      }),
    ],
    [
      "a number that parses to Infinity",
      postBodyWithStates(validFilterState()).replace('"min":0.8', '"min":1e309'),
    ],
    [
      "a non-array category exclusion",
      postBodyWithStates({
        ...validFilterState(),
        categoryExclusions: {
          ...validFilterState().categoryExclusions,
          usage: "office",
        },
      }),
    ],
    [
      "too many category exclusions",
      postBodyWithStates({
        ...validFilterState(),
        categoryExclusions: {
          ...validFilterState().categoryExclusions,
          usage: Array.from({ length: 257 }, (_, index) => index),
        },
      }),
    ],
    [
      "an unsupported category exclusion value",
      postBodyWithStates({
        ...validFilterState(),
        categoryExclusions: {
          ...validFilterState().categoryExclusions,
          usage: [{ value: "office" }],
        },
      }),
    ],
    [
      "an empty category exclusion string",
      postBodyWithStates({
        ...validFilterState(),
        categoryExclusions: {
          ...validFilterState().categoryExclusions,
          usage: ["   "],
        },
      }),
    ],
    [
      "an overlong category exclusion string",
      postBodyWithStates({
        ...validFilterState(),
        categoryExclusions: {
          ...validFilterState().categoryExclusions,
          usage: ["x".repeat(257)],
        },
      }),
    ],
    [
      "a category exclusion string containing a backslash",
      postBodyWithStates({
        ...validFilterState(),
        categoryExclusions: {
          ...validFilterState().categoryExclusions,
          usage: ["office\\school"],
        },
      }),
    ],
    [
      "a category exclusion string containing a control character",
      postBodyWithStates({
        ...validFilterState(),
        categoryExclusions: {
          ...validFilterState().categoryExclusions,
          usage: ["office\u0001"],
        },
      }),
    ],
    [
      "longitude outside its range",
      postBodyWithStates(validFilterState(), {
        ...validCameraState(),
        destination: { ...validCameraState().destination, longitudeDegrees: 180.01 },
      }),
    ],
    [
      "latitude outside its range",
      postBodyWithStates(validFilterState(), {
        ...validCameraState(),
        destination: { ...validCameraState().destination, latitudeDegrees: -90.01 },
      }),
    ],
    [
      "camera height outside its range",
      postBodyWithStates(validFilterState(), {
        ...validCameraState(),
        destination: { ...validCameraState().destination, height: 10_000_001 },
      }),
    ],
    [
      "orientation outside its range",
      postBodyWithStates(validFilterState(), {
        ...validCameraState(),
        orientation: { ...validCameraState().orientation, heading: Math.PI * 8 + 0.01 },
      }),
    ],
  ])("rejects %s", async (_description, body) => {
    const { handler, send } = createFixture();

    const response = await handler(
      createEvent("POST /views", { jwtSub: OWNER_SUB, body }),
    );

    expect(response.statusCode).toBe(400);
    expect(parseResponseBody(response)).toEqual({ message: "Invalid request" });
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects excessively deep JSON", async () => {
    const { handler, send } = createFixture();
    let nested: Record<string, unknown> = {};
    for (let depth = 0; depth < 14; depth += 1) {
      nested = { child: nested };
    }

    const response = await handler(
      createEvent("POST /views", {
        jwtSub: OWNER_SUB,
        body: JSON.stringify({ title: "View", filterState: nested, cameraState: {} }),
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects an oversized request body", async () => {
    const { handler, send } = createFixture();
    const response = await handler(
      createEvent("POST /views", {
        jwtSub: OWNER_SUB,
        body: JSON.stringify({
          title: "View",
          filterState: { value: "x".repeat(70_000) },
          cameraState: {},
        }),
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("authentication", () => {
  it.each([
    {
      routeKey: "POST /views",
      options: { body: validPostBody() },
    },
    {
      routeKey: "GET /views",
      options: {},
    },
    {
      routeKey: "DELETE /views/{viewId}",
      options: { pathParameters: { viewId: VIEW_ID } },
    },
  ])("returns 401 before DynamoDB access for $routeKey", async ({ routeKey, options }) => {
    const { handler, send } = createFixture();

    const response = await handler(createEvent(routeKey, options));

    expect(response.statusCode).toBe(401);
    expect(parseResponseBody(response)).toEqual({ message: "Unauthorized" });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("GET /views", () => {
  it("queries the GSI by JWT subject in descending order and returns projected fields", async () => {
    const { handler, send } = createFixture();
    send.mockResolvedValueOnce({
      Items: [
        {
          viewId: VIEW_ID,
          title: "Newest view",
          createdAt: CREATED_AT,
          ownerSub: OWNER_SUB,
          ownerName: "must not be returned",
        },
      ],
    });

    const response = await handler(
      createEvent("GET /views", {
        jwtSub: OWNER_SUB,
        queryStringParameters: {
          owner: OTHER_OWNER_SUB,
          ownerSub: OTHER_OWNER_SUB,
        },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(parseResponseBody(response)).toEqual({
      items: [{ viewId: VIEW_ID, title: "Newest view", createdAt: CREATED_AT }],
    });
    expect(send).toHaveBeenCalledTimes(1);

    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(QueryCommand);
    if (!(command instanceof QueryCommand)) {
      throw new Error("Expected QueryCommand");
    }
    expect(command.input).toMatchObject({
      TableName: TABLE_NAME,
      IndexName: GSI_NAME,
      KeyConditionExpression: "#ownerSub = :ownerSub",
      ExpressionAttributeValues: { ":ownerSub": OWNER_SUB },
      ProjectionExpression: "#viewId, #title, #createdAt",
      ScanIndexForward: false,
      Limit: 100,
    });
    expect(command.input.ExpressionAttributeValues?.[":ownerSub"]).toBe(OWNER_SUB);
  });
});

describe("GET /views/{viewId}", () => {
  it("returns a public view without owner data and disables caching", async () => {
    const { handler, send } = createFixture();
    send.mockResolvedValueOnce({
      Item: {
        viewId: VIEW_ID,
        title: "Shared view",
        filterState: { usage: ["office"] },
        cameraState: { destination: { longitude: 139.75 } },
        createdAt: CREATED_AT,
        ownerSub: OWNER_SUB,
        ownerName: "Private display name",
        email: "private@example.test",
      },
    });

    const response = await handler(
      createEvent("GET /views/{viewId}", {
        pathParameters: { viewId: VIEW_ID },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    expect(parseResponseBody(response)).toEqual({
      viewId: VIEW_ID,
      title: "Shared view",
      filterState: { usage: ["office"] },
      cameraState: { destination: { longitude: 139.75 } },
      createdAt: CREATED_AT,
    });
  });

  it("returns 400 for a non-v4 UUID without reading DynamoDB", async () => {
    const { handler, send } = createFixture();

    const response = await handler(
      createEvent("GET /views/{viewId}", {
        pathParameters: { viewId: "123e4567-e89b-12d3-a456-426614174000" },
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.headers).toMatchObject({ "cache-control": "no-store" });
    expect(send).not.toHaveBeenCalled();
  });

  it("returns 404 when the view does not exist", async () => {
    const { handler, send } = createFixture();
    send.mockResolvedValueOnce({});

    const response = await handler(
      createEvent("GET /views/{viewId}", {
        pathParameters: { viewId: VIEW_ID },
      }),
    );

    expect(response.statusCode).toBe(404);
    expect(response.headers).toMatchObject({ "cache-control": "no-store" });
    expect(parseResponseBody(response)).toEqual({ message: "Not found" });
  });
});

describe("DELETE /views/{viewId}", () => {
  it("checks ownership and deletes with an owner condition", async () => {
    const { handler, send } = createFixture();
    send.mockResolvedValueOnce({ Item: { ownerSub: OWNER_SUB } }).mockResolvedValueOnce({});

    const response = await handler(
      createEvent("DELETE /views/{viewId}", {
        jwtSub: OWNER_SUB,
        pathParameters: { viewId: VIEW_ID },
      }),
    );

    expect(response).toEqual({ statusCode: 204 });
    expect(send).toHaveBeenCalledTimes(2);
    const getCommand = send.mock.calls[0]?.[0];
    const deleteCommand = send.mock.calls[1]?.[0];
    expect(getCommand).toBeInstanceOf(GetCommand);
    expect(deleteCommand).toBeInstanceOf(DeleteCommand);
    if (!(deleteCommand instanceof DeleteCommand)) {
      throw new Error("Expected DeleteCommand");
    }
    expect(deleteCommand.input).toMatchObject({
      TableName: TABLE_NAME,
      Key: { viewId: VIEW_ID },
      ConditionExpression: "#ownerSub = :ownerSub",
      ExpressionAttributeNames: { "#ownerSub": "ownerSub" },
      ExpressionAttributeValues: { ":ownerSub": OWNER_SUB },
    });
  });

  it("returns 403 and does not delete another owner's view", async () => {
    const { handler, send } = createFixture();
    send.mockResolvedValueOnce({ Item: { ownerSub: OTHER_OWNER_SUB } });

    const response = await handler(
      createEvent("DELETE /views/{viewId}", {
        jwtSub: OWNER_SUB,
        pathParameters: { viewId: VIEW_ID },
      }),
    );

    expect(response.statusCode).toBe(403);
    expect(parseResponseBody(response)).toEqual({ message: "Forbidden" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetCommand);
  });

  it("returns 404 when the view does not exist", async () => {
    const { handler, send } = createFixture();
    send.mockResolvedValueOnce({});

    const response = await handler(
      createEvent("DELETE /views/{viewId}", {
        jwtSub: OWNER_SUB,
        pathParameters: { viewId: VIEW_ID },
      }),
    );

    expect(response.statusCode).toBe(404);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not report success when the conditional delete loses a race", async () => {
    const { handler, loggerError, send } = createFixture();
    send
      .mockResolvedValueOnce({ Item: { ownerSub: OWNER_SUB } })
      .mockRejectedValueOnce({ name: "ConditionalCheckFailedException" });

    const response = await handler(
      createEvent("DELETE /views/{viewId}", {
        jwtSub: OWNER_SUB,
        pathParameters: { viewId: VIEW_ID },
      }),
    );

    expect(response.statusCode).toBe(404);
    expect(loggerError).not.toHaveBeenCalled();
  });
});

describe("routing and unexpected errors", () => {
  it.each(["PATCH /views/{viewId}", "OPTIONS /views"])(
    "returns 404 without handling the unknown route %s",
    async (routeKey) => {
      const { handler, send } = createFixture();

      const response = await handler(createEvent(routeKey));

      expect(response.statusCode).toBe(404);
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("returns a generic 500 and logs no body, JWT, or error details", async () => {
    const { handler, loggerError, send } = createFixture();
    send.mockRejectedValueOnce(
      new Error("sensitive-body jwt-token-value private-person@example.test"),
    );

    const response = await handler(
      createEvent("GET /views", {
        jwtSub: OWNER_SUB,
        queryStringParameters: { owner: OTHER_OWNER_SUB },
      }),
    );

    expect(response.statusCode).toBe(500);
    expect(parseResponseBody(response)).toEqual({ message: "Internal server error" });
    expectJsonContentType(response);
    expect(loggerError).toHaveBeenCalledWith("Unhandled views handler error", {
      requestId: "request-123",
    });
    const serializedLog = JSON.stringify(loggerError.mock.calls);
    expect(serializedLog).not.toContain("sensitive-body");
    expect(serializedLog).not.toContain(OWNER_SUB);
    expect(serializedLog).not.toContain(OTHER_OWNER_SUB);
    expect(serializedLog).not.toContain("private-person@example.test");
  });
});
