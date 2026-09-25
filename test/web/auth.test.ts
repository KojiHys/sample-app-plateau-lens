import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AuthError,
  createAuth,
  createPkceChallenge,
  decodeIdTokenPayload,
  getStoredAuthSession,
  isAuthConfigured,
  type SessionStorage,
} from "../../web/src/auth.ts";

const NOW_MILLISECONDS = 1_700_000_000_000;
const FUTURE_EXPIRY = Math.floor(NOW_MILLISECONDS / 1_000) + 600;
const authConfig = {
  cognitoDomain: "https://auth.example.test/",
  redirectUri: "https://app.example.test/callback",
  userPoolClientId: "client123",
};

class MemoryStorage implements SessionStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function createIdToken(
  payload: Record<string, unknown> = {
    exp: FUTURE_EXPIRY,
    sub: "11111111-2222-4333-8444-555555555555",
  },
): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString(
    "base64url",
  );
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${encodedPayload}.signature`;
}

function successfulTokenResponse(idToken = createIdToken()): Response {
  return new Response(
    JSON.stringify({
      access_token: "access-token-is-not-persisted",
      expires_in: 3_600,
      id_token: idToken,
      refresh_token: "refresh-token-is-not-persisted",
      token_type: "Bearer",
    }),
    { status: 200 },
  );
}

function createFetchMock(response: Response = successfulTokenResponse()) {
  return vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
      response,
  );
}

function cryptoProvider(): Pick<Crypto, "getRandomValues" | "subtle"> {
  return webcrypto as unknown as Pick<Crypto, "getRandomValues" | "subtle">;
}

async function beginLogin(
  storage: MemoryStorage,
  fetchMock = createFetchMock(),
  returnTo = "https://app.example.test/map?state=tier-one#camera",
) {
  const replacements: string[] = [];
  const auth = createAuth(authConfig, {
    crypto: cryptoProvider(),
    fetch: fetchMock as unknown as typeof fetch,
    getCurrentUrl: () => returnTo,
    now: () => NOW_MILLISECONDS,
    replaceUrl: (url) => replacements.push(url),
    storage,
  });
  const authorizeUrlValue = await auth.createAuthorizeUrl();
  if (authorizeUrlValue === null) {
    throw new Error("expected configured auth");
  }
  return {
    auth,
    authorizeUrl: new URL(authorizeUrlValue),
    fetchMock,
    replacements,
  };
}

describe("Cognito PKCE authentication", () => {
  it("produces the RFC 7636 S256 challenge for the known verifier", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

    await expect(createPkceChallenge(verifier, cryptoProvider())).resolves.toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("builds the managed-login authorize URL with a random state and PKCE", async () => {
    const storage = new MemoryStorage();
    const { authorizeUrl } = await beginLogin(storage);

    expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe(
      "https://auth.example.test/oauth2/authorize",
    );
    expect(Object.fromEntries(authorizeUrl.searchParams)).toMatchObject({
      client_id: "client123",
      code_challenge_method: "S256",
      redirect_uri: authConfig.redirectUri,
      response_type: "code",
      scope: "openid email profile",
    });
    expect(authorizeUrl.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(authorizeUrl.searchParams.get("code_challenge")).toMatch(
      /^[A-Za-z0-9_-]{43}$/u,
    );
    expect([...storage.values.values()]).toContain(
      "/map?state=tier-one#camera",
    );
    expect(storage.values.size).toBe(3);
  });

  it("matches state, exchanges the code, stores only the ID token, and restores the same-origin path", async () => {
    const storage = new MemoryStorage();
    const idToken = createIdToken();
    const fetchMock = createFetchMock(successfulTokenResponse(idToken));
    const { auth, authorizeUrl, replacements } = await beginLogin(
      storage,
      fetchMock,
    );
    const state = authorizeUrl.searchParams.get("state");

    const result = await auth.handleCallback(
      `https://app.example.test/callback?code=authorization-code&state=${state ?? ""}`,
    );

    expect(result).toEqual({
      expiresAtEpochSeconds: FUTURE_EXPIRY,
      handled: true,
      returnTo: "/map?state=tier-one#camera",
      subject: "11111111-2222-4333-8444-555555555555",
    });
    expect(replacements).toEqual(["/map?state=tier-one#camera"]);
    expect([...storage.values.values()]).toEqual([idToken]);
    expect(auth.getIdToken()).toBe(idToken);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [requestUrl, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(requestUrl?.toString()).toBe("https://auth.example.test/oauth2/token");
    expect(requestInit?.method).toBe("POST");
    expect(requestInit?.headers).toEqual({
      "Content-Type": "application/x-www-form-urlencoded",
    });
    const tokenBody = new URLSearchParams(String(requestInit?.body));
    expect(Object.fromEntries(tokenBody)).toEqual({
      client_id: "client123",
      code: "authorization-code",
      code_verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      grant_type: "authorization_code",
      redirect_uri: authConfig.redirectUri,
    });
    expect(JSON.stringify(requestInit)).not.toContain(idToken);
    expect(JSON.stringify(requestInit)).not.toContain("refresh-token");
  });

  it("rejects a mismatched state, consumes the transaction, and removes OAuth callback parameters", async () => {
    const storage = new MemoryStorage();
    const fetchMock = createFetchMock();
    const { auth, replacements } = await beginLogin(storage, fetchMock);

    await expect(
      auth.handleCallback(
        "https://app.example.test/callback?keep=1&code=authorization-code&state=wrong",
      ),
    ).rejects.toMatchObject({ code: "invalid_state" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(storage.values.size).toBe(0);
    expect(replacements).toEqual(["/callback?keep=1"]);
  });

  it("rejects an invalid saved return path, consumes the transaction, and cleans the callback", async () => {
    const storage = new MemoryStorage();
    const fetchMock = createFetchMock();
    const { auth, authorizeUrl, replacements } = await beginLogin(
      storage,
      fetchMock,
    );
    storage.setItem(
      "plateau-lens.auth.return-to",
      "https://attacker.example/collect",
    );
    const state = authorizeUrl.searchParams.get("state");

    await expect(
      auth.handleCallback(
        `https://app.example.test/callback?keep=1&code=authorization-code&state=${state ?? ""}`,
      ),
    ).rejects.toMatchObject({ code: "invalid_return_to" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(storage.values.size).toBe(0);
    expect(replacements).toEqual(["/callback?keep=1"]);
  });

  it("rejects a callback when its saved transaction values are missing", async () => {
    const storage = new MemoryStorage();
    const fetchMock = createFetchMock();
    const replacements: string[] = [];
    const auth = createAuth(authConfig, {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => NOW_MILLISECONDS,
      replaceUrl: (url) => replacements.push(url),
      storage,
    });

    await expect(
      auth.handleCallback(
        "https://app.example.test/callback?code=authorization-code&state=state",
      ),
    ).rejects.toMatchObject({ code: "invalid_callback" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(replacements).toEqual(["/callback"]);
  });

  it("never saves or restores an external return URL", async () => {
    const storage = new MemoryStorage();
    const { auth, authorizeUrl, replacements } = await beginLogin(
      storage,
      createFetchMock(),
      "https://attacker.example/collect",
    );
    const state = authorizeUrl.searchParams.get("state");

    await auth.handleCallback(
      `https://app.example.test/callback?code=authorization-code&state=${state ?? ""}`,
    );

    expect(replacements).toEqual(["/callback"]);
    expect(JSON.stringify([...storage.values.entries()])).not.toContain(
      "attacker.example",
    );
  });

  it("handles an OAuth error without exposing the provider description", async () => {
    const storage = new MemoryStorage();
    const { auth, authorizeUrl, replacements } = await beginLogin(storage);
    const state = authorizeUrl.searchParams.get("state");

    const callback = auth.handleCallback(
      `https://app.example.test/callback?error=access_denied&error_description=${encodeURIComponent(
        "<img src=x onerror=alert(1)>",
      )}&state=${state ?? ""}`,
    );

    await expect(callback).rejects.toMatchObject({
      code: "oauth_error",
      message: "Authentication was not completed.",
    });
    expect(storage.values.size).toBe(0);
    expect(replacements).toEqual(["/map?state=tier-one#camera"]);
  });

  it("cleans to the verified return path when the authorization code is invalid", async () => {
    const storage = new MemoryStorage();
    const fetchMock = createFetchMock();
    const { auth, authorizeUrl, replacements } = await beginLogin(
      storage,
      fetchMock,
    );
    const state = authorizeUrl.searchParams.get("state");

    await expect(
      auth.handleCallback(
        `https://app.example.test/callback?keep=1&code=&state=${state ?? ""}`,
      ),
    ).rejects.toMatchObject({ code: "invalid_callback" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(storage.values.size).toBe(0);
    expect(replacements).toEqual(["/map?state=tier-one#camera"]);
  });

  it.each([
    {
      expectedCode: "token_exchange_failed",
      expectedMessage: "The authorization code exchange failed.",
      failure: "network failure",
      fetchMock: vi.fn(async (): Promise<Response> => {
        throw new Error("network details must not escape");
      }),
    },
    {
      expectedCode: "token_exchange_failed",
      expectedMessage: "The authorization code exchange failed.",
      failure: "non-success token response",
      fetchMock: createFetchMock(new Response("provider details", { status: 503 })),
    },
    {
      expectedCode: "invalid_token_response",
      expectedMessage: "The token endpoint returned an invalid response.",
      failure: "invalid token JSON",
      fetchMock: createFetchMock(new Response("not-json", { status: 200 })),
    },
    {
      expectedCode: "invalid_token_response",
      expectedMessage: "The token endpoint returned an invalid response.",
      failure: "invalid token payload",
      fetchMock: createFetchMock(
        new Response(
          JSON.stringify({
            access_token: "sensitive-access-token",
            expires_in: 3_600,
            id_token: "not-a-jwt",
            token_type: "Bearer",
          }),
          { status: 200 },
        ),
      ),
    },
  ])(
    "cleans the callback and consumes the transaction after $failure",
    async ({ expectedCode, expectedMessage, fetchMock }) => {
      const storage = new MemoryStorage();
      const { auth, authorizeUrl, replacements } = await beginLogin(
        storage,
        fetchMock,
      );
      const state = authorizeUrl.searchParams.get("state");

      const callback = auth.handleCallback(
        `https://app.example.test/callback?keep=1&code=authorization-code&state=${state ?? ""}&error_description=provider-secret`,
      );

      await expect(callback).rejects.toMatchObject({
        code: expectedCode,
        message: expectedMessage,
      });
      expect(storage.values.size).toBe(0);
      expect(replacements).toEqual(["/map?state=tier-one#camera"]);
    },
  );

  it("cleans the callback and transaction when ID-token storage fails", async () => {
    class FailingIdTokenStorage extends MemoryStorage {
      override setItem(key: string, value: string): void {
        if (key === "plateau-lens.auth.id-token") {
          throw new Error("storage details must not escape");
        }
        super.setItem(key, value);
      }
    }

    const storage = new FailingIdTokenStorage();
    const { auth, authorizeUrl, replacements } = await beginLogin(storage);
    const state = authorizeUrl.searchParams.get("state");

    await expect(
      auth.handleCallback(
        `https://app.example.test/callback?code=authorization-code&state=${state ?? ""}`,
      ),
    ).rejects.toMatchObject({
      code: "storage_unavailable",
      message: "Session storage is unavailable.",
    });
    expect(storage.values.size).toBe(0);
    expect(replacements).toEqual(["/map?state=tier-one#camera"]);
  });

  it("retries best-effort callback cleanup and removes the token when URL replacement fails", async () => {
    const storage = new MemoryStorage();
    const replacementAttempts: string[] = [];
    const auth = createAuth(authConfig, {
      crypto: cryptoProvider(),
      fetch: createFetchMock() as unknown as typeof fetch,
      getCurrentUrl: () => "https://app.example.test/map?state=tier-one#camera",
      now: () => NOW_MILLISECONDS,
      replaceUrl: (url) => {
        replacementAttempts.push(url);
        if (replacementAttempts.length === 1) {
          throw new Error("history details must not escape");
        }
      },
      storage,
    });
    const authorizeUrl = new URL((await auth.createAuthorizeUrl()) ?? "https://invalid.example");
    const state = authorizeUrl.searchParams.get("state");

    await expect(
      auth.handleCallback(
        `https://app.example.test/callback?code=authorization-code&state=${state ?? ""}`,
      ),
    ).rejects.toMatchObject({
      code: "callback_error",
      message: "The authentication callback could not be completed.",
    });
    expect(storage.values.size).toBe(0);
    expect(replacementAttempts).toEqual([
      "/map?state=tier-one#camera",
      "/map?state=tier-one#camera",
    ]);
  });

  it("rejects malformed token responses and never persists their tokens", async () => {
    const storage = new MemoryStorage();
    const invalidResponse = new Response(
      JSON.stringify({
        access_token: "access-token",
        expires_in: 3_600,
        id_token: "not-a-jwt",
        token_type: "Bearer",
      }),
      { status: 200 },
    );
    const { auth, authorizeUrl, replacements } = await beginLogin(
      storage,
      createFetchMock(invalidResponse),
    );
    const state = authorizeUrl.searchParams.get("state");

    await expect(
      auth.handleCallback(
        `https://app.example.test/callback?code=authorization-code&state=${state ?? ""}`,
      ),
    ).rejects.toMatchObject({ code: "invalid_token_response" });
    expect(storage.values.size).toBe(0);
    expect(replacements).toEqual(["/map?state=tier-one#camera"]);
  });
});

describe("ID-token session", () => {
  it("strictly decodes exp and sub without treating the payload as authorization", () => {
    const token = createIdToken({ exp: FUTURE_EXPIRY, sub: "subject-1" });

    expect(decodeIdTokenPayload(token)).toEqual({
      exp: FUTURE_EXPIRY,
      sub: "subject-1",
    });
    expect(decodeIdTokenPayload(createIdToken({ exp: "later", sub: "subject-1" }))).toBeNull();
    expect(decodeIdTokenPayload(createIdToken({ exp: FUTURE_EXPIRY, sub: "" }))).toBeNull();
    expect(decodeIdTokenPayload(`${token}.extra`)).toBeNull();
  });

  it("returns a valid stored token, then removes it at expiration", async () => {
    const storage = new MemoryStorage();
    let now = NOW_MILLISECONDS;
    const auth = createAuth(authConfig, {
      crypto: cryptoProvider(),
      fetch: createFetchMock() as unknown as typeof fetch,
      getCurrentUrl: () => "https://app.example.test/",
      now: () => now,
      replaceUrl: () => undefined,
      storage,
    });
    const authorizeUrlValue = await auth.createAuthorizeUrl();
    const authorizeUrl = new URL(authorizeUrlValue ?? "https://invalid.example");
    await auth.handleCallback(
      `https://app.example.test/callback?code=authorization-code&state=${authorizeUrl.searchParams.get("state") ?? ""}`,
    );

    expect(getStoredAuthSession(storage, now)?.idToken).toBe(createIdToken());
    now = FUTURE_EXPIRY * 1_000;
    expect(auth.getSession()).toBeNull();
    expect(storage.values.size).toBe(0);
  });

  it("removes a broken stored token", () => {
    const storage = new MemoryStorage();
    storage.setItem("plateau-lens.auth.id-token", "broken");

    expect(getStoredAuthSession(storage, NOW_MILLISECONDS)).toBeNull();
    expect(storage.values.size).toBe(0);
  });
});

describe("logout and availability", () => {
  it("clears the local token before returning the Cognito logout URL", async () => {
    const storage = new MemoryStorage();
    const { auth, authorizeUrl } = await beginLogin(storage);
    await auth.handleCallback(
      `https://app.example.test/callback?code=authorization-code&state=${authorizeUrl.searchParams.get("state") ?? ""}`,
    );

    const logoutUrlValue = auth.logout();
    const logoutUrl = new URL(logoutUrlValue ?? "https://invalid.example");

    expect(auth.getIdToken()).toBeNull();
    expect(storage.values.size).toBe(0);
    expect(`${logoutUrl.origin}${logoutUrl.pathname}`).toBe(
      "https://auth.example.test/logout",
    );
    expect(Object.fromEntries(logoutUrl.searchParams)).toEqual({
      client_id: "client123",
      logout_uri: authConfig.redirectUri,
    });
  });

  it("reports incomplete configuration as unavailable without throwing", async () => {
    const incompleteConfig = {
      cognitoDomain: "",
      redirectUri: "https://app.example.test/callback",
      userPoolClientId: "",
    };
    const auth = createAuth(incompleteConfig);

    expect(isAuthConfigured(incompleteConfig)).toBe(false);
    expect(auth.available).toBe(false);
    await expect(auth.createAuthorizeUrl()).resolves.toBeNull();
    expect(auth.logout()).toBeNull();
  });
});
