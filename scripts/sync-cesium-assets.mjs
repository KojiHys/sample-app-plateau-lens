import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = path.join(projectRoot, "node_modules", "cesium", "Build", "Cesium");
const destinationRoot = path.join(projectRoot, "web", "public", "cesium");
const assetDirectories = ["Assets", "ThirdParty", "Widgets", "Workers"];

await rm(destinationRoot, { force: true, recursive: true });
await mkdir(destinationRoot, { recursive: true });
await Promise.all(
  assetDirectories.map((directory) =>
    cp(path.join(sourceRoot, directory), path.join(destinationRoot, directory), {
      recursive: true,
    }),
  ),
);

process.stdout.write("Cesium runtime assets synchronized.\n");
