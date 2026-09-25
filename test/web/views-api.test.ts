import { describe, expect, it, vi } from "vitest";
import {
  createViewsApi,
  ViewsApiError,
  type CreateViewInput,
} from "../../web/src/views-api.ts";
import {
  createDefaultFilterState,
  type CameraState,
} from "../../web/src/view-state.ts";

const VIEW_ID = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_VIEW_ID = "223e4567-e89b-42d3-a456-426614174001";
const CREATED_AT = "2026-09-24T01:02:03.000Z";
const apiConfig = { apiBaseUrl: "https://api.example.test///" };
const cameraState: CameraState = {
  destination: {
    height: 1_250.5,
    latitudeDegrees: 35.681,
    longitudeDegrees: 139.767,
  },
  orientation: {
    heading: 1.2,
    pitch: -0.7,
    roll: 0,
  },
};

function createIdToken(payload: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString(
    "base64url",
  );
  const encodedPayload = Buffer.from(
    JSON.stringify({
      exp: 4_102_444_800,
      sub: "11111111-2222-4333-8444-555555555555",
      ...payload,
    }),
  ).toString("base64url");
  return `${header}.${encodedPayload}.signature`;
}

const idToken = createIdToken();

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function fetchMockReturning(response: Response) {
  return vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
      response,
  );
}

function validCreateInput(): CreateViewInput {
  const filterState = createDefaultFilterState();
  filterState.colorMode = "height";
  return {
    cameraState: structuredClone(cameraState),
    filterState,
    title: "千代田ビュー",
  };
}

function validSavedView(viewId = VIEW_ID): Record<string, unknown> {
  return {
    cameraState: structuredClone(cameraState),
    createdAt: CREATED_AT,
    filterState: createDefaultFilterState(),
    title: "千代田ビュー",
    viewId,
  };
}

describe("views API requests", () => {
  it("creates a view with a valid ID token and exactly three POST body keys", async () => {
    const fetchMock = fetchMockReturning(
      jsonResponse(
        {
          shareUrl: `https://app.example.test/?viewId=${VIEW_ID}`,
          viewId: VIEW_ID,
        },
        201,
      ),
    );
    const api = createViewsApi(
      apiConfig,
      fetchMock as unknown as typeof fetch,
      () => idToken,
    );
    const input = {
      ...validCreateInput(),
      ownerSub: "must-not-be-sent",
    } as CreateViewInput;

    await expect(api.create(input)).resolves.toEqual({
      shareUrl: `https://app.example.test/?viewId=${VIEW_ID}`,
      viewId: VIEW_ID,
    });

    const [requestUrl, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(requestUrl?.toString()).toBe("https://api.example.test/views");
    expect(requestInit?.method).toBe("POST");
    const headers = new Headers(requestInit?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${idToken}`);
    expect(headers.get("content-type")).toBe("application/json");
    const body = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["title", "filterState", "cameraState"]);
    expect(body).toEqual(validCreateInput());
    expect(JSON.stringify(body)).not.toContain("ownerSub");
  });

  it("adds Authorization to list and delete but not to the public get route", async () => {
    const tokenProvider = vi.fn(() => idToken);
    const listFetch = fetchMockReturning(jsonResponse({ items: [] }));
    const listApi = createViewsApi(
      apiConfig,
      listFetch as unknown as typeof fetch,
      tokenProvider,
    );
    await listApi.list();

    const deleteResponse = {
      json: vi.fn(() => {
        throw new Error("DELETE 204 must not be parsed");
      }),
      ok: true,
      status: 204,
    } as unknown as Response;
    const deleteFetch = fetchMockReturning(deleteResponse);
    const deleteApi = createViewsApi(
      apiConfig,
      deleteFetch as unknown as typeof fetch,
      tokenProvider,
    );
    await deleteApi.delete(VIEW_ID);

    const publicTokenProvider = vi.fn(() => idToken);
    const getFetch = fetchMockReturning(jsonResponse(validSavedView()));
    const getApi = createViewsApi(
      apiConfig,
      getFetch as unknown as typeof fetch,
      publicTokenProvider,
    );
    await getApi.get(VIEW_ID);

    const listHeaders = new Headers(listFetch.mock.calls[0]?.[1]?.headers);
    const deleteHeaders = new Headers(deleteFetch.mock.calls[0]?.[1]?.headers);
    const getHeaders = new Headers(getFetch.mock.calls[0]?.[1]?.headers);
    expect(listHeaders.get("authorization")).toBe(`Bearer ${idToken}`);
    expect(deleteHeaders.get("authorization")).toBe(`Bearer ${idToken}`);
    expect(getHeaders.has("authorization")).toBe(false);
    expect(publicTokenProvider).not.toHaveBeenCalled();
    expect(deleteResponse.json).not.toHaveBeenCalled();
  });

  it("rejects protected requests locally when no valid ID token is available", async () => {
    const fetchMock = fetchMockReturning(jsonResponse({ items: [] }));
    const api = createViewsApi(
      apiConfig,
      fetchMock as unknown as typeof fetch,
      () => null,
    );

    await expect(api.list()).rejects.toMatchObject({
      kind: "unauthenticated",
      status: 401,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed and expired token-provider values", async () => {
    const fetchMock = fetchMockReturning(jsonResponse({ items: [] }));
    const malformedApi = createViewsApi(
      apiConfig,
      fetchMock as unknown as typeof fetch,
      () => "not-a-jwt",
    );
    const expiredApi = createViewsApi(
      apiConfig,
      fetchMock as unknown as typeof fetch,
      () => createIdToken({ exp: 1 }),
    );

    await expect(malformedApi.list()).rejects.toMatchObject({ status: 401 });
    await expect(expiredApi.list()).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates UUID v4 before making item requests", async () => {
    const fetchMock = fetchMockReturning(jsonResponse(validSavedView()));
    const api = createViewsApi(
      apiConfig,
      fetchMock as unknown as typeof fetch,
      () => idToken,
    );

    await expect(api.get("../not-a-uuid")).rejects.toMatchObject({
      kind: "invalid_request",
      status: 400,
    });
    await expect(api.delete("123e4567-e89b-12d3-a456-426614174000")).rejects.toMatchObject({
      status: 400,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("views API response validation", () => {
  it("validates and projects list summaries without owner data", async () => {
    const fetchMock = fetchMockReturning(
      jsonResponse({
        items: [
          {
            createdAt: CREATED_AT,
            ownerSub: "private-owner",
            title: "最初のビュー",
            viewId: VIEW_ID,
          },
          {
            createdAt: "2026-09-23T01:02:03.000Z",
            title: "次のビュー",
            viewId: OTHER_VIEW_ID,
          },
        ],
        ownerEmail: "must-not-be-retained@example.test",
      }),
    );
    const api = createViewsApi(
      apiConfig,
      fetchMock as unknown as typeof fetch,
      () => idToken,
    );

    await expect(api.list()).resolves.toEqual([
      {
        createdAt: CREATED_AT,
        title: "最初のビュー",
        viewId: VIEW_ID,
      },
      {
        createdAt: "2026-09-23T01:02:03.000Z",
        title: "次のビュー",
        viewId: OTHER_VIEW_ID,
      },
    ]);
  });

  it("validates a public detail and projects only its Web schema", async () => {
    const response = {
      ...validSavedView(),
      cameraState: { ...cameraState, serverOnly: "ignored" },
      filterState: {
        ...createDefaultFilterState(),
        serverOnly: "ignored",
      },
      ownerSub: "private-owner",
    };
    const fetchMock = fetchMockReturning(jsonResponse(response));
    const api = createViewsApi(
      apiConfig,
      fetchMock as unknown as typeof fetch,
      () => idToken,
    );

    const savedView = await api.get(VIEW_ID);

    expect(savedView).toEqual(validSavedView());
    expect(savedView).not.toHaveProperty("ownerSub");
    expect(savedView.filterState).not.toHaveProperty("serverOnly");
    expect(savedView.cameraState).not.toHaveProperty("serverOnly");
    expect(fetchMock.mock.calls[0]?.[0].toString()).toBe(
      `https://api.example.test/views/${VIEW_ID}`,
    );
  });

  it.each([
    {
      label: "out-of-range filter",
      mutate: (view: Record<string, unknown>) => {
        const filter = createDefaultFilterState();
        filter.numeric.height.min = -1;
        view.filterState = filter;
      },
    },
    {
      label: "unknown color mode",
      mutate: (view: Record<string, unknown>) => {
        view.filterState = {
          ...createDefaultFilterState(),
          colorMode: "server-defined-mode",
        };
      },
    },
    {
      label: "invalid camera",
      mutate: (view: Record<string, unknown>) => {
        view.cameraState = {
          ...cameraState,
          destination: {
            ...cameraState.destination,
            latitudeDegrees: 100,
          },
        };
      },
    },
  ])("rejects a detail with $label", async ({ mutate }) => {
    const view = validSavedView();
    mutate(view);
    const fetchMock = fetchMockReturning(jsonResponse(view));
    const api = createViewsApi(
      apiConfig,
      fetchMock as unknown as typeof fetch,
      () => idToken,
    );

    await expect(api.get(VIEW_ID)).rejects.toMatchObject({
      kind: "invalid_response",
      status: 200,
    });
  });

  it("rejects malformed create and list success responses", async () => {
    const createFetch = fetchMockReturning(
      jsonResponse(
        {
          shareUrl: "javascript:alert(1)",
          viewId: VIEW_ID,
        },
        201,
      ),
    );
    const createApi = createViewsApi(
      apiConfig,
      createFetch as unknown as typeof fetch,
      () => idToken,
    );
    await expect(createApi.create(validCreateInput())).rejects.toMatchObject({
      kind: "invalid_response",
      status: 201,
    });

    const listFetch = fetchMockReturning(
      jsonResponse({
        items: [{ createdAt: "not-a-date", title: "view", viewId: VIEW_ID }],
      }),
    );
    const listApi = createViewsApi(
      apiConfig,
      listFetch as unknown as typeof fetch,
      () => idToken,
    );
    await expect(listApi.list()).rejects.toMatchObject({
      kind: "invalid_response",
      status: 200,
    });
  });
});

describe("views API errors", () => {
  it.each([400, 401, 403, 404, 500])(
    "preserves HTTP status %i without exposing the server body",
    async (status) => {
      const response = new Response("<script>untrustedServerText()</script>", {
        status,
      });
      const fetchMock = fetchMockReturning(response);
      const api = createViewsApi(
        apiConfig,
        fetchMock as unknown as typeof fetch,
        () => idToken,
      );

      let caught: unknown;
      try {
        await api.get(VIEW_ID);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ViewsApiError);
      expect(caught).toMatchObject({ kind: "http", status });
      expect((caught as Error).message).not.toContain("script");
      expect((caught as Error).message).not.toContain("untrustedServerText");
    },
  );
});
