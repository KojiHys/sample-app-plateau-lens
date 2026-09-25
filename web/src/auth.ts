import type { RuntimeConfig } from "./config.ts";

const AUTH_STORAGE_PREFIX = "plateau-lens.auth.";
const ID_TOKEN_STORAGE_KEY = `${AUTH_STORAGE_PREFIX}id-token`;
const OAUTH_STATE_STORAGE_KEY = `${AUTH_STORAGE_PREFIX}oauth-state`;
const PKCE_VERIFIER_STORAGE_KEY = `${AUTH_STORAGE_PREFIX}pkce-verifier`;
const RETURN_TO_STORAGE_KEY = `${AUTH_STORAGE_PREFIX}return-to`;
const OAUTH_PARAMETER_NAMES = [
  "code",
  "state",
  "error",
  "error_description",
  "error_uri",
] as const;
const JWT_MAX_LENGTH = 64_000;
const JWT_PAYLOAD_MAX_LENGTH = 16_000;
const PKCE_RANDOM_BYTE_LENGTH = 32;
const TOKEN_EXCHANGE_TIMEOUT_MILLISECONDS = 10_000;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

type AuthConfig = Pick<
  RuntimeConfig,
  "cognitoDomain" | "redirectUri" | "userPoolClientId"
>;

export interface SessionStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

export interface AuthDependencies {
  crypto: Pick<Crypto, "getRandomValues" | "subtle">;
  fetch: typeof fetch;
  getCurrentUrl: () => string;
  now: () => number;
  replaceUrl: (relativeUrl: string) => void;
  storage: SessionStorage;
}

export interface IdTokenClaims {
  exp: number;
  sub: string;
}

export interface AuthSession extends IdTokenClaims {
  idToken: string;
}

export type AuthCallbackResult =
  | { handled: false }
  | {
      expiresAtEpochSeconds: number;
      handled: true;
      returnTo: string;
      subject: string;
    };

export type AuthErrorCode =
  | "callback_error"
  | "configuration_unavailable"
  | "invalid_callback"
  | "invalid_return_to"
  | "invalid_state"
  | "invalid_token_response"
  | "oauth_error"
  | "platform_unavailable"
  | "storage_unavailable"
  | "token_exchange_failed";

export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

export interface AuthClient {
  readonly available: boolean;
  createAuthorizeUrl(returnTo?: string): Promise<string | null>;
  getIdToken(): string | null;
  getSession(): AuthSession | null;
  handleCallback(callbackUrl?: string): Promise<AuthCallbackResult>;
  logout(): string | null;
}

interface NormalizedAuthConfig {
  clientId: string;
  cognitoOrigin: string;
  redirectUri: string;
  redirectUrl: URL;
}

interface OAuthTransaction {
  returnTo: string;
  state: string;
  verifier: string;
}

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

function normalizeAuthConfig(config: AuthConfig): NormalizedAuthConfig | null {
  if (
    config.cognitoDomain.length === 0 ||
    config.cognitoDomain !== config.cognitoDomain.trim() ||
    config.redirectUri.length === 0 ||
    config.redirectUri !== config.redirectUri.trim() ||
    config.userPoolClientId.length === 0 ||
    config.userPoolClientId !== config.userPoolClientId.trim() ||
    /[\s\u0000-\u001f\u007f]/u.test(config.userPoolClientId)
  ) {
    return null;
  }

  try {
    const cognitoUrl = new URL(config.cognitoDomain);
    const redirectUrl = new URL(config.redirectUri);
    const cognitoPathIsRoot =
      cognitoUrl.pathname === "" || cognitoUrl.pathname === "/";
    const redirectProtocolIsAllowed =
      redirectUrl.protocol === "https:" ||
      (redirectUrl.protocol === "http:" && isLoopbackHost(redirectUrl.hostname));

    if (
      cognitoUrl.protocol !== "https:" ||
      cognitoUrl.username.length > 0 ||
      cognitoUrl.password.length > 0 ||
      cognitoUrl.search.length > 0 ||
      cognitoUrl.hash.length > 0 ||
      !cognitoPathIsRoot ||
      !redirectProtocolIsAllowed ||
      redirectUrl.username.length > 0 ||
      redirectUrl.password.length > 0 ||
      redirectUrl.hash.length > 0
    ) {
      return null;
    }

    return {
      clientId: config.userPoolClientId,
      cognitoOrigin: cognitoUrl.origin,
      redirectUri: config.redirectUri,
      redirectUrl,
    };
  } catch {
    return null;
  }
}

export function isAuthConfigured(config: AuthConfig): boolean {
  return normalizeAuthConfig(config) !== null;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (
    value.length === 0 ||
    value.length % 4 === 1 ||
    !BASE64URL_PATTERN.test(value)
  ) {
    return null;
  }

  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      "=",
    );
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return bytesToBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function createRandomValue(cryptoProvider: Pick<Crypto, "getRandomValues">): string {
  const bytes = new Uint8Array(PKCE_RANDOM_BYTE_LENGTH);
  cryptoProvider.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function createPkceChallenge(
  verifier: string,
  cryptoProvider: Pick<Crypto, "subtle"> = globalThis.crypto,
): Promise<string> {
  if (!PKCE_VERIFIER_PATTERN.test(verifier)) {
    throw new AuthError("invalid_callback", "The PKCE verifier is invalid.");
  }
  const digest = await cryptoProvider.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return bytesToBase64Url(new Uint8Array(digest));
}

// This decodes an untrusted JWT payload only to manage UI session expiry. It does
// not verify a signature or grant access. API Gateway's JWT authorizer is the
// authorization boundary for protected API routes.
export function decodeIdTokenPayload(idToken: string): IdTokenClaims | null {
  if (
    idToken.length === 0 ||
    idToken.length > JWT_MAX_LENGTH ||
    idToken.trim() !== idToken
  ) {
    return null;
  }

  const segments = idToken.split(".");
  const header = segments[0];
  const payload = segments[1];
  const signature = segments[2];
  if (
    segments.length !== 3 ||
    header === undefined ||
    payload === undefined ||
    signature === undefined ||
    !BASE64URL_PATTERN.test(header) ||
    !BASE64URL_PATTERN.test(signature) ||
    payload.length > JWT_PAYLOAD_MAX_LENGTH
  ) {
    return null;
  }

  const payloadBytes = base64UrlToBytes(payload);
  if (!payloadBytes) {
    return null;
  }

  try {
    const decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes),
    ) as unknown;
    if (!isRecord(decoded)) {
      return null;
    }

    const { exp, sub } = decoded;
    if (
      typeof exp !== "number" ||
      !Number.isSafeInteger(exp) ||
      exp <= 0 ||
      typeof sub !== "string" ||
      sub.length === 0 ||
      sub.length > 256 ||
      sub.trim() !== sub ||
      /[\u0000-\u001f\u007f]/u.test(sub)
    ) {
      return null;
    }
    return { exp, sub };
  } catch {
    return null;
  }
}

export function readIdTokenSession(
  idToken: string,
  nowMilliseconds: number = Date.now(),
): AuthSession | null {
  const claims = decodeIdTokenPayload(idToken);
  if (
    !claims ||
    !Number.isFinite(nowMilliseconds) ||
    claims.exp <= Math.floor(nowMilliseconds / 1_000)
  ) {
    return null;
  }
  return { ...claims, idToken };
}

function browserStorage(): SessionStorage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function safeRemove(storage: SessionStorage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // A blocked storage API is treated as an unavailable local session.
  }
}

function clearOAuthTransaction(storage: SessionStorage): void {
  safeRemove(storage, OAUTH_STATE_STORAGE_KEY);
  safeRemove(storage, PKCE_VERIFIER_STORAGE_KEY);
  safeRemove(storage, RETURN_TO_STORAGE_KEY);
}

export function clearAuthSession(storage: SessionStorage | null = browserStorage()): void {
  if (storage) {
    safeRemove(storage, ID_TOKEN_STORAGE_KEY);
  }
}

export function getStoredAuthSession(
  storage: SessionStorage | null = browserStorage(),
  nowMilliseconds: number = Date.now(),
): AuthSession | null {
  if (!storage) {
    return null;
  }

  let idToken: string | null;
  try {
    idToken = storage.getItem(ID_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
  if (idToken === null) {
    return null;
  }

  const session = readIdTokenSession(idToken, nowMilliseconds);
  if (!session) {
    safeRemove(storage, ID_TOKEN_STORAGE_KEY);
  }
  return session;
}

export function toSameOriginPath(candidate: string, expectedOrigin: string): string | null {
  try {
    const originUrl = new URL(expectedOrigin);
    const candidateUrl = new URL(candidate, originUrl);
    if (
      candidateUrl.origin !== originUrl.origin ||
      candidateUrl.username.length > 0 ||
      candidateUrl.password.length > 0
    ) {
      return null;
    }
    return `${candidateUrl.pathname}${candidateUrl.search}${candidateUrl.hash}`;
  } catch {
    return null;
  }
}

export function removeOAuthParameters(urlValue: string): string | null {
  try {
    const url = new URL(urlValue);
    for (const name of OAUTH_PARAMETER_NAMES) {
      url.searchParams.delete(name);
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function defaultCurrentUrl(): string {
  if (typeof window === "undefined") {
    throw new AuthError("platform_unavailable", "The browser URL is unavailable.");
  }
  return window.location.href;
}

function defaultReplaceUrl(relativeUrl: string): void {
  if (typeof window === "undefined") {
    throw new AuthError("platform_unavailable", "Browser history is unavailable.");
  }
  window.history.replaceState(window.history.state, "", relativeUrl);
}

function resolveStorage(dependencies: Partial<AuthDependencies>): SessionStorage {
  const storage = dependencies.storage ?? browserStorage();
  if (!storage) {
    throw new AuthError("storage_unavailable", "Session storage is unavailable.");
  }
  return storage;
}

function resolveCrypto(
  dependencies: Partial<AuthDependencies>,
): Pick<Crypto, "getRandomValues" | "subtle"> {
  const cryptoProvider = dependencies.crypto ?? globalThis.crypto;
  if (!cryptoProvider?.subtle) {
    throw new AuthError("platform_unavailable", "Web Crypto is unavailable.");
  }
  return cryptoProvider;
}

function resolveFetch(dependencies: Partial<AuthDependencies>): typeof fetch {
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  if (!fetchImplementation) {
    throw new AuthError("platform_unavailable", "Fetch is unavailable.");
  }
  return fetchImplementation;
}

function consumeOAuthTransaction(storage: SessionStorage): OAuthTransaction | null {
  try {
    const transaction = {
      returnTo: storage.getItem(RETURN_TO_STORAGE_KEY),
      state: storage.getItem(OAUTH_STATE_STORAGE_KEY),
      verifier: storage.getItem(PKCE_VERIFIER_STORAGE_KEY),
    };
    clearOAuthTransaction(storage);
    if (
      transaction.returnTo === null ||
      transaction.state === null ||
      transaction.verifier === null
    ) {
      return null;
    }
    return {
      returnTo: transaction.returnTo,
      state: transaction.state,
      verifier: transaction.verifier,
    };
  } catch {
    clearOAuthTransaction(storage);
    return null;
  }
}

function storeOAuthTransaction(
  storage: SessionStorage,
  transaction: OAuthTransaction,
): void {
  clearOAuthTransaction(storage);
  try {
    storage.setItem(OAUTH_STATE_STORAGE_KEY, transaction.state);
    storage.setItem(PKCE_VERIFIER_STORAGE_KEY, transaction.verifier);
    storage.setItem(RETURN_TO_STORAGE_KEY, transaction.returnTo);
  } catch {
    clearOAuthTransaction(storage);
    throw new AuthError("storage_unavailable", "Session storage is unavailable.");
  }
}

function replaceUrlBestEffort(
  dependencies: Partial<AuthDependencies>,
  relativeUrl: string,
): void {
  try {
    (dependencies.replaceUrl ?? defaultReplaceUrl)(relativeUrl);
  } catch {
    // Preserve the primary callback error instead of exposing platform details.
  }
}

function callbackFailure(
  dependencies: Partial<AuthDependencies>,
  cleanupPath: string,
  code: AuthErrorCode,
  message: string,
): never {
  replaceUrlBestEffort(dependencies, cleanupPath);
  throw new AuthError(code, message);
}

function readTokenResponse(
  value: unknown,
  nowMilliseconds: number,
): AuthSession | null {
  if (!isRecord(value)) {
    return null;
  }

  const { access_token: accessToken, expires_in: expiresIn, id_token: idToken } =
    value;
  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0 ||
    typeof idToken !== "string" ||
    typeof value.token_type !== "string" ||
    value.token_type.toLowerCase() !== "bearer"
  ) {
    return null;
  }
  return readIdTokenSession(idToken, nowMilliseconds);
}

export function createAuth(
  config: AuthConfig,
  dependencies: Partial<AuthDependencies> = {},
): AuthClient {
  const normalizedConfig = normalizeAuthConfig(config);
  const now = dependencies.now ?? Date.now;

  return {
    available: normalizedConfig !== null,

    async createAuthorizeUrl(returnTo?: string): Promise<string | null> {
      if (!normalizedConfig) {
        return null;
      }

      const cryptoProvider = resolveCrypto(dependencies);
      const storage = resolveStorage(dependencies);
      const currentUrl =
        returnTo ?? (dependencies.getCurrentUrl ?? defaultCurrentUrl)();
      const fallbackReturnTo = `${normalizedConfig.redirectUrl.pathname}${normalizedConfig.redirectUrl.search}`;
      const safeReturnTo =
        toSameOriginPath(currentUrl, normalizedConfig.redirectUrl.origin) ??
        fallbackReturnTo;
      const verifier = createRandomValue(cryptoProvider);
      const state = createRandomValue(cryptoProvider);
      const challenge = await createPkceChallenge(verifier, cryptoProvider);

      storeOAuthTransaction(storage, {
        returnTo: safeReturnTo,
        state,
        verifier,
      });

      const authorizeUrl = new URL(
        "/oauth2/authorize",
        normalizedConfig.cognitoOrigin,
      );
      authorizeUrl.searchParams.set("client_id", normalizedConfig.clientId);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("redirect_uri", normalizedConfig.redirectUri);
      authorizeUrl.searchParams.set("scope", "openid email profile");
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("code_challenge", challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      return authorizeUrl.toString();
    },

    getIdToken(): string | null {
      return getStoredAuthSession(
        dependencies.storage ?? browserStorage(),
        now(),
      )?.idToken ?? null;
    },

    getSession(): AuthSession | null {
      return getStoredAuthSession(
        dependencies.storage ?? browserStorage(),
        now(),
      );
    },

    async handleCallback(callbackUrl?: string): Promise<AuthCallbackResult> {
      const currentUrl =
        callbackUrl ?? (dependencies.getCurrentUrl ?? defaultCurrentUrl)();
      let parsedCallback: URL;
      try {
        parsedCallback = new URL(currentUrl);
      } catch {
        throw new AuthError("invalid_callback", "The authentication callback URL is invalid.");
      }

      const hasCode = parsedCallback.searchParams.has("code");
      const hasError = parsedCallback.searchParams.has("error");
      if (!hasCode && !hasError) {
        return { handled: false };
      }
      if (!normalizedConfig) {
        throw new AuthError(
          "configuration_unavailable",
          "Authentication is not configured.",
        );
      }

      const cleanCallbackPath = removeOAuthParameters(parsedCallback.toString()) ?? "/";
      if (parsedCallback.origin !== normalizedConfig.redirectUrl.origin) {
        throw new AuthError("invalid_callback", "The authentication callback origin is invalid.");
      }

      const storage = resolveStorage(dependencies);
      const transaction = consumeOAuthTransaction(storage);
      const states = parsedCallback.searchParams.getAll("state");
      const codes = parsedCallback.searchParams.getAll("code");
      const errors = parsedCallback.searchParams.getAll("error");
      if (
        transaction === null ||
        states.length !== 1 ||
        states[0] === undefined ||
        states[0].length === 0 ||
        (hasCode === hasError) ||
        codes.length > 1 ||
        errors.length > 1 ||
        !PKCE_VERIFIER_PATTERN.test(transaction.verifier)
      ) {
        callbackFailure(
          dependencies,
          cleanCallbackPath,
          "invalid_callback",
          "The authentication callback is incomplete or invalid.",
        );
      }

      const returnTo = toSameOriginPath(
        transaction.returnTo,
        normalizedConfig.redirectUrl.origin,
      );
      if (!returnTo) {
        callbackFailure(
          dependencies,
          cleanCallbackPath,
          "invalid_return_to",
          "The saved return location is invalid.",
        );
      }
      if (states[0] !== transaction.state) {
        callbackFailure(
          dependencies,
          cleanCallbackPath,
          "invalid_state",
          "The authentication state did not match.",
        );
      }
      if (hasError) {
        replaceUrlBestEffort(dependencies, returnTo);
        throw new AuthError("oauth_error", "Authentication was not completed.");
      }

      const code = codes[0];
      if (
        code === undefined ||
        code.length === 0 ||
        code.length > 4_096 ||
        /[\u0000-\u001f\u007f]/u.test(code)
      ) {
        callbackFailure(
          dependencies,
          returnTo,
          "invalid_callback",
          "The authorization code is invalid.",
        );
      }

      const tokenUrl = new URL("/oauth2/token", normalizedConfig.cognitoOrigin);
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: normalizedConfig.clientId,
        code,
        redirect_uri: normalizedConfig.redirectUri,
        code_verifier: transaction.verifier,
      });
      const requestInit: RequestInit = {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      };
      if (
        dependencies.fetch === undefined &&
        typeof AbortSignal !== "undefined" &&
        typeof AbortSignal.timeout === "function"
      ) {
        requestInit.signal = AbortSignal.timeout(
          TOKEN_EXCHANGE_TIMEOUT_MILLISECONDS,
        );
      }

      let response: Response;
      try {
        response = await resolveFetch(dependencies)(tokenUrl, requestInit);
      } catch {
        callbackFailure(
          dependencies,
          returnTo,
          "token_exchange_failed",
          "The authorization code exchange failed.",
        );
      }
      if (!response.ok) {
        callbackFailure(
          dependencies,
          returnTo,
          "token_exchange_failed",
          "The authorization code exchange failed.",
        );
      }

      let tokenValue: unknown;
      try {
        tokenValue = (await response.json()) as unknown;
      } catch {
        callbackFailure(
          dependencies,
          returnTo,
          "invalid_token_response",
          "The token endpoint returned an invalid response.",
        );
      }
      const session = readTokenResponse(tokenValue, now());
      if (!session) {
        callbackFailure(
          dependencies,
          returnTo,
          "invalid_token_response",
          "The token endpoint returned an invalid response.",
        );
      }

      try {
        storage.setItem(ID_TOKEN_STORAGE_KEY, session.idToken);
      } catch {
        safeRemove(storage, ID_TOKEN_STORAGE_KEY);
        callbackFailure(
          dependencies,
          returnTo,
          "storage_unavailable",
          "Session storage is unavailable.",
        );
      }

      try {
        (dependencies.replaceUrl ?? defaultReplaceUrl)(returnTo);
      } catch {
        safeRemove(storage, ID_TOKEN_STORAGE_KEY);
        callbackFailure(
          dependencies,
          returnTo,
          "callback_error",
          "The authentication callback could not be completed.",
        );
      }

      return {
        expiresAtEpochSeconds: session.exp,
        handled: true,
        returnTo,
        subject: session.sub,
      };
    },

    logout(): string | null {
      const storage = dependencies.storage ?? browserStorage();
      clearAuthSession(storage);
      if (storage) {
        clearOAuthTransaction(storage);
      }
      if (!normalizedConfig) {
        return null;
      }

      const logoutUrl = new URL("/logout", normalizedConfig.cognitoOrigin);
      logoutUrl.searchParams.set("client_id", normalizedConfig.clientId);
      logoutUrl.searchParams.set("logout_uri", normalizedConfig.redirectUri);
      return logoutUrl.toString();
    },
  };
}
