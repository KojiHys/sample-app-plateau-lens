import { createHash } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TILESET_URL =
  "https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/13101-bldg-lod2-notexture-latest/tileset.json";
const MAX_FILES = 2_000;
const MAX_SINGLE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const DOWNLOAD_CONCURRENCY = 12;

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const cacheRoot = path.join(projectRoot, ".cache", "fallback-tiles");
const tilesRoot = path.join(cacheRoot, "tiles");
const sourceUrl = process.env.PLATEAU_TILESET_URL ?? DEFAULT_TILESET_URL;
const downloaded = new Map();
const tilesets = new Map();
const downloadBudget = { totalBytes: 0 };
let fileCount = 0;

function validatedHttpsUrl(value, base) {
  const url = new URL(value, base);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`Only credential-free HTTPS tile resources are supported: ${url.origin}`);
  }
  return url;
}

function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function safeExtension(url) {
  const extension = path.posix.extname(url.pathname).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/u.test(extension) ? extension : ".bin";
}

function localResourcePath(url, isTileset) {
  return isTileset
    ? path.posix.join("tilesets", `${shortHash(url.href)}.json`)
    : path.posix.join("assets", `${shortHash(url.href)}${safeExtension(url)}`);
}

async function cancelReader(reader) {
  try {
    await reader.cancel();
  } catch {
    // Preserve the size-limit error if the stream also fails during cancellation.
  }
}

export async function readResponseBytes(
  response,
  url,
  budget,
  {
    maxSingleFileBytes = MAX_SINGLE_FILE_BYTES,
    maxTotalBytes = MAX_TOTAL_BYTES,
  } = {},
) {
  if (response.body === null) {
    throw new Error(`Tile resource returned an empty body: ${url.origin}${url.pathname}`);
  }

  const reader = response.body.getReader();
  const declaredLengthHeader = response.headers.get("content-length");
  const declaredLength =
    declaredLengthHeader !== null && /^\d+$/u.test(declaredLengthHeader)
      ? Number(declaredLengthHeader)
      : undefined;
  if (
    declaredLength !== undefined &&
    (declaredLength > maxSingleFileBytes ||
      budget.totalBytes + declaredLength > maxTotalBytes)
  ) {
    await cancelReader(reader);
    if (declaredLength > maxSingleFileBytes) {
      throw new Error(`Tile resource exceeds the single-file limit: ${url.origin}${url.pathname}`);
    }
    throw new Error("Fallback tile download exceeds the total-size limit");
  }

  const chunks = [];
  let fileBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!(value instanceof Uint8Array)) {
        await cancelReader(reader);
        throw new Error(`Tile resource returned invalid bytes: ${url.origin}${url.pathname}`);
      }
      if (fileBytes + value.byteLength > maxSingleFileBytes) {
        await cancelReader(reader);
        throw new Error(`Tile resource exceeds the single-file limit: ${url.origin}${url.pathname}`);
      }
      if (budget.totalBytes + value.byteLength > maxTotalBytes) {
        await cancelReader(reader);
        throw new Error("Fallback tile download exceeds the total-size limit");
      }
      fileBytes += value.byteLength;
      budget.totalBytes += value.byteLength;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(fileBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchBytes(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "sample-app-plateau-lens-fallback-fetcher/1.0" },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`Tile resource returned HTTP ${response.status}: ${url.origin}${url.pathname}`);
  }
  validatedHttpsUrl(response.url);
  return readResponseBytes(response, url, downloadBudget);
}

async function writeResource(relativePath, bytes) {
  fileCount += 1;
  if (fileCount > MAX_FILES) {
    throw new Error("Fallback tile download exceeds the file-count limit");
  }
  const destination = path.join(tilesRoot, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
}

function collectContentReferences(tile, references) {
  if (!tile || typeof tile !== "object" || Array.isArray(tile)) {
    return;
  }
  const addReference = (content) => {
    if (!content || typeof content !== "object" || Array.isArray(content)) {
      return;
    }
    if (typeof content.uri === "string") {
      references.push({ holder: content, key: "uri", value: content.uri });
    } else if (typeof content.url === "string") {
      references.push({ holder: content, key: "url", value: content.url });
    }
  };
  addReference(tile.content);
  if (Array.isArray(tile.contents)) {
    tile.contents.forEach(addReference);
  }
  if (Array.isArray(tile.children)) {
    tile.children.forEach((child) => collectContentReferences(child, references));
  }
}

async function mapWithConcurrency(values, worker) {
  let nextIndex = 0;
  const runners = Array.from(
    { length: Math.min(DOWNLOAD_CONCURRENCY, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        await worker(values[currentIndex], currentIndex);
      }
    },
  );
  await Promise.all(runners);
}

async function downloadBinary(url, relativePath) {
  const existing = downloaded.get(url.href);
  if (existing) {
    await existing;
    return;
  }
  const operation = (async () => {
    const bytes = await fetchBytes(url);
    await writeResource(relativePath, bytes);
  })();
  downloaded.set(url.href, operation);
  await operation;
}

async function downloadTileset(url, relativePath) {
  const existing = tilesets.get(url.href);
  if (existing) {
    await existing;
    return;
  }

  const operation = (async () => {
    const bytes = await fetchBytes(url);
    let document;
    try {
      document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new Error(`Tileset JSON is invalid: ${url.origin}${url.pathname}`);
    }
    if (!document || typeof document !== "object" || Array.isArray(document) || !document.root) {
      throw new Error(`Tileset JSON has no root tile: ${url.origin}${url.pathname}`);
    }

    const references = [];
    collectContentReferences(document.root, references);
    await mapWithConcurrency(references, async (reference) => {
      const resourceUrl = validatedHttpsUrl(reference.value, url);
      const isTileset = resourceUrl.pathname.toLowerCase().endsWith(".json");
      const targetPath = localResourcePath(resourceUrl, isTileset);
      let rewritten = path.posix.relative(path.posix.dirname(relativePath), targetPath);
      if (!rewritten.startsWith(".")) {
        rewritten = `./${rewritten}`;
      }
      reference.holder[reference.key] = rewritten;
      if (isTileset) {
        await downloadTileset(resourceUrl, targetPath);
      } else {
        await downloadBinary(resourceUrl, targetPath);
      }
    });

    await writeResource(
      relativePath,
      new TextEncoder().encode(`${JSON.stringify(document)}\n`),
    );
  })();
  tilesets.set(url.href, operation);
  await operation;
}

async function main() {
  const rootUrl = validatedHttpsUrl(sourceUrl);
  await rm(cacheRoot, { force: true, recursive: true });
  await mkdir(tilesRoot, { recursive: true });
  await downloadTileset(rootUrl, "tileset.json");

  const rootStats = await stat(path.join(tilesRoot, "tileset.json"));
  if (rootStats.size === 0) {
    throw new Error("Generated fallback tileset is empty");
  }

  const manifest = {
    sourceUrl: rootUrl.href,
    fetchedAt: new Date().toISOString(),
    fileCount,
    totalBytes: downloadBudget.totalBytes,
  };
  await writeFile(
    path.join(cacheRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  process.stdout.write(
    `Fallback tiles prepared at ${path.relative(projectRoot, cacheRoot)} (${fileCount} files, ${(downloadBudget.totalBytes / 1024 / 1024).toFixed(1)} MiB).\n`,
  );
}

const isMainModule =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMainModule) {
  await main();
}
