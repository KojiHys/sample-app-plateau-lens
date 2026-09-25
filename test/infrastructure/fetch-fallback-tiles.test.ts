import { describe, expect, it, vi } from "vitest";

interface ByteBudget {
  totalBytes: number;
}

interface ResponseLike {
  readonly body: {
    getReader: () => {
      cancel: () => Promise<void>;
      read: () => Promise<
        | { done: true; value?: undefined }
        | { done: false; value: Uint8Array }
      >;
      releaseLock: () => void;
    };
  } | null;
  readonly headers: Headers;
}

const fetchScript = (await import(
  new URL("../../scripts/fetch-fallback-tiles.mjs", import.meta.url).href
)) as {
  readResponseBytes: (
    response: ResponseLike,
    url: URL,
    budget: ByteBudget,
    limits?: {
      maxSingleFileBytes?: number;
      maxTotalBytes?: number;
    },
  ) => Promise<Uint8Array>;
};
const { readResponseBytes } = fetchScript;
const RESOURCE_URL = new URL("https://tiles.company.co.jp/data.bin");

function createResponse(chunks: number[][], contentLength?: string) {
  let nextChunk = 0;
  const cancel = vi.fn(async () => undefined);
  const read = vi.fn(async () => {
    const chunk = chunks[nextChunk];
    nextChunk += 1;
    return chunk === undefined
      ? { done: true as const }
      : { done: false as const, value: Uint8Array.from(chunk) };
  });
  const releaseLock = vi.fn();
  const headers = new Headers();
  if (contentLength !== undefined) {
    headers.set("content-length", contentLength);
  }
  return {
    cancel,
    read,
    releaseLock,
    response: {
      body: { getReader: () => ({ cancel, read, releaseLock }) },
      headers,
    } satisfies ResponseLike,
  };
}

describe("fallback tile response streaming", () => {
  it("combines successful chunks and accounts for each chunk", async () => {
    const { cancel, response } = createResponse([[1, 2], [3, 4, 5]], "5");
    const budget = { totalBytes: 7 };

    await expect(
      readResponseBytes(response, RESOURCE_URL, budget, {
        maxSingleFileBytes: 5,
        maxTotalBytes: 12,
      }),
    ).resolves.toEqual(Uint8Array.from([1, 2, 3, 4, 5]));
    expect(budget.totalBytes).toBe(12);
    expect(cancel).not.toHaveBeenCalled();
  });

  it.each([undefined, "2"])(
    "cancels an oversized body when Content-Length is %s",
    async (contentLength) => {
      const { cancel, read, response } = createResponse(
        [[1, 2, 3, 4], [5, 6, 7, 8]],
        contentLength,
      );
      const budget = { totalBytes: 0 };

      await expect(
        readResponseBytes(response, RESOURCE_URL, budget, {
          maxSingleFileBytes: 7,
          maxTotalBytes: 20,
        }),
      ).rejects.toThrowError("Tile resource exceeds the single-file limit");
      expect(cancel).toHaveBeenCalledOnce();
      expect(read).toHaveBeenCalledTimes(2);
      expect(budget.totalBytes).toBe(4);
    },
  );

  it("cancels before reading when declared Content-Length exceeds the limit", async () => {
    const { cancel, read, response } = createResponse([[1]], "8");

    await expect(
      readResponseBytes(response, RESOURCE_URL, { totalBytes: 0 }, {
        maxSingleFileBytes: 7,
        maxTotalBytes: 20,
      }),
    ).rejects.toThrowError("Tile resource exceeds the single-file limit");
    expect(cancel).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
  });

  it("cancels on the chunk that would exceed the aggregate limit", async () => {
    const { cancel, read, response } = createResponse([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
    const budget = { totalBytes: 5 };

    await expect(
      readResponseBytes(response, RESOURCE_URL, budget, {
        maxSingleFileBytes: 20,
        maxTotalBytes: 10,
      }),
    ).rejects.toThrowError("Fallback tile download exceeds the total-size limit");
    expect(cancel).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledTimes(2);
    expect(budget.totalBytes).toBe(9);
  });

  it("rejects a null response body without producing bytes", async () => {
    await expect(
      readResponseBytes(
        { body: null, headers: new Headers() },
        RESOURCE_URL,
        { totalBytes: 0 },
      ),
    ).rejects.toThrowError("Tile resource returned an empty body");
  });
});
