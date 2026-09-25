import {
  getStoredAuthSession,
  readIdTokenSession,
} from "./auth.ts";
import type { RuntimeConfig } from "./config.ts";
import {
  isValidCameraState,
  parseFilterState,
  type CameraState,
  type FilterState,
} from "./view-state.ts";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_LIST_ITEMS = 100;
const MAX_TITLE_CHARACTERS = 50;

type ViewsApiConfig = Pick<RuntimeConfig, "apiBaseUrl">;

export interface CreateViewInput {
  cameraState: CameraState;
  filterState: FilterState;
  title: string;
}

export interface SavedViewSummary {
  createdAt: string;
  title: string;
  viewId: string;
}

export interface SavedView extends SavedViewSummary {
  cameraState: CameraState;
  filterState: FilterState;
}

export interface CreateViewResult {
  shareUrl: string;
  viewId: string;
}

export interface ViewsApi {
  create(input: CreateViewInput): Promise<CreateViewResult>;
  delete(viewId: string): Promise<void>;
  get(viewId: string): Promise<SavedView>;
  list(): Promise<SavedViewSummary[]>;
}

export type ViewsApiErrorKind =
  | "configuration"
  | "http"
  | "invalid_request"
  | "invalid_response"
  | "network"
  | "unauthenticated";

export class ViewsApiError extends Error {
  readonly kind: ViewsApiErrorKind;
  readonly status: number;

  constructor(status: number, kind: ViewsApiErrorKind, message: string) {
    super(message);
    this.name = "ViewsApiError";
    this.status = status;
    this.kind = kind;
  }
}

export type IdTokenProvider = () => string | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

function normalizeApiBaseUrl(value: string): URL | null {
  if (value.length === 0 || value !== value.trim()) {
    return null;
  }

  try {
    const url = new URL(value);
    const protocolIsAllowed =
      url.protocol === "https:" ||
      (url.protocol === "http:" && isLoopbackHost(url.hostname));
    if (
      !protocolIsAllowed ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      return null;
    }
    url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`;
    return url;
  } catch {
    return null;
  }
}

export function isUuidV4(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

function parseTitle(value: unknown): string | null {
  if (typeof value !== "string" || value !== value.trim()) {
    return null;
  }
  const length = Array.from(value).length;
  return length >= 1 &&
    length <= MAX_TITLE_CHARACTERS &&
    !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function parseCameraState(value: unknown): CameraState | null {
  if (!isValidCameraState(value)) {
    return null;
  }
  return {
    destination: { ...value.destination },
    orientation: { ...value.orientation },
  };
}

function parseSummary(value: unknown): SavedViewSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  const title = parseTitle(value.title);
  if (!isUuidV4(value.viewId) || !title || !isIsoTimestamp(value.createdAt)) {
    return null;
  }
  return {
    createdAt: value.createdAt,
    title,
    viewId: value.viewId,
  };
}

function parseSavedView(value: unknown): SavedView | null {
  const summary = parseSummary(value);
  if (!summary || !isRecord(value)) {
    return null;
  }
  const filterState = parseFilterState(value.filterState);
  const cameraState = parseCameraState(value.cameraState);
  if (!filterState || !cameraState) {
    return null;
  }
  return {
    ...summary,
    cameraState,
    filterState,
  };
}

function parseCreateResult(value: unknown): CreateViewResult | null {
  if (!isRecord(value) || !isUuidV4(value.viewId) || typeof value.shareUrl !== "string") {
    return null;
  }

  try {
    const shareUrl = new URL(value.shareUrl);
    if (
      (shareUrl.protocol !== "https:" &&
        !(shareUrl.protocol === "http:" && isLoopbackHost(shareUrl.hostname))) ||
      shareUrl.username.length > 0 ||
      shareUrl.password.length > 0 ||
      shareUrl.searchParams.get("viewId") !== value.viewId
    ) {
      return null;
    }
    return { shareUrl: value.shareUrl, viewId: value.viewId };
  } catch {
    return null;
  }
}

function safeHttpError(status: number): ViewsApiError {
  const messages: Partial<Record<number, string>> = {
    400: "The views API rejected the request.",
    401: "Authentication is required.",
    403: "The requested operation is forbidden.",
    404: "The saved view was not found.",
    500: "The views API encountered an internal error.",
  };
  return new ViewsApiError(
    status,
    "http",
    messages[status] ?? `The views API request failed with status ${status}.`,
  );
}

async function parseResponseJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new ViewsApiError(
      response.status,
      "invalid_response",
      "The views API returned an invalid response.",
    );
  }
}

function defaultIdTokenProvider(): string | null {
  return getStoredAuthSession()?.idToken ?? null;
}

export function createViewsApi(
  config: ViewsApiConfig,
  fetchImplementation: typeof fetch,
  getIdToken: IdTokenProvider = defaultIdTokenProvider,
): ViewsApi {
  const apiBaseUrl = normalizeApiBaseUrl(config.apiBaseUrl);
  if (!apiBaseUrl) {
    throw new ViewsApiError(
      0,
      "configuration",
      "The views API is not configured with a valid base URL.",
    );
  }

  const collectionUrl = new URL("views", apiBaseUrl);

  const itemUrl = (viewId: string): URL => {
    if (!isUuidV4(viewId)) {
      throw new ViewsApiError(
        400,
        "invalid_request",
        "The saved view ID must be a UUID v4.",
      );
    }
    return new URL(`views/${encodeURIComponent(viewId)}`, apiBaseUrl);
  };

  const authorizationHeader = (): Record<"Authorization", string> => {
    let idToken: string | null;
    try {
      idToken = getIdToken();
    } catch {
      idToken = null;
    }
    if (!idToken || !readIdTokenSession(idToken)) {
      throw new ViewsApiError(
        401,
        "unauthenticated",
        "A valid ID-token session is required.",
      );
    }
    return { Authorization: `Bearer ${idToken}` };
  };

  const request = async (url: URL, init: RequestInit): Promise<Response> => {
    let response: Response;
    try {
      response = await fetchImplementation(url, init);
    } catch {
      throw new ViewsApiError(
        0,
        "network",
        "The views API could not be reached.",
      );
    }
    if (!response.ok) {
      // Do not expose the server response body as a displayable error string.
      throw safeHttpError(response.status);
    }
    return response;
  };

  return {
    async create(input: CreateViewInput): Promise<CreateViewResult> {
      const title = parseTitle(input.title);
      const filterState = parseFilterState(input.filterState);
      const cameraState = parseCameraState(input.cameraState);
      if (!title || !filterState || !cameraState) {
        throw new ViewsApiError(
          400,
          "invalid_request",
          "The saved view input is invalid.",
        );
      }

      const response = await request(collectionUrl, {
        method: "POST",
        headers: {
          ...authorizationHeader(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title, filterState, cameraState }),
      });
      if (response.status !== 201) {
        throw new ViewsApiError(
          response.status,
          "invalid_response",
          "The views API returned an unexpected success status.",
        );
      }

      const result = parseCreateResult(await parseResponseJson(response));
      if (!result) {
        throw new ViewsApiError(
          response.status,
          "invalid_response",
          "The views API returned an invalid create result.",
        );
      }
      return result;
    },

    async delete(viewId: string): Promise<void> {
      const response = await request(itemUrl(viewId), {
        method: "DELETE",
        headers: authorizationHeader(),
      });
      if (response.status !== 204) {
        throw new ViewsApiError(
          response.status,
          "invalid_response",
          "The views API returned an unexpected success status.",
        );
      }
    },

    async get(viewId: string): Promise<SavedView> {
      const response = await request(itemUrl(viewId), { method: "GET" });
      if (response.status !== 200) {
        throw new ViewsApiError(
          response.status,
          "invalid_response",
          "The views API returned an unexpected success status.",
        );
      }

      const savedView = parseSavedView(await parseResponseJson(response));
      if (!savedView || savedView.viewId.toLowerCase() !== viewId.toLowerCase()) {
        throw new ViewsApiError(
          response.status,
          "invalid_response",
          "The views API returned an invalid saved view.",
        );
      }
      return savedView;
    },

    async list(): Promise<SavedViewSummary[]> {
      const response = await request(collectionUrl, {
        method: "GET",
        headers: authorizationHeader(),
      });
      if (response.status !== 200) {
        throw new ViewsApiError(
          response.status,
          "invalid_response",
          "The views API returned an unexpected success status.",
        );
      }

      const value = await parseResponseJson(response);
      if (
        !isRecord(value) ||
        !Array.isArray(value.items) ||
        value.items.length > MAX_LIST_ITEMS
      ) {
        throw new ViewsApiError(
          response.status,
          "invalid_response",
          "The views API returned an invalid saved-view list.",
        );
      }
      const items = value.items.map(parseSummary);
      if (items.some((item) => item === null)) {
        throw new ViewsApiError(
          response.status,
          "invalid_response",
          "The views API returned an invalid saved-view list.",
        );
      }
      return items as SavedViewSummary[];
    },
  };
}
