import { defineConfig } from "vite";

const cesiumBaseUrl = "/cesium";

export default defineConfig({
  root: "web",
  define: {
    CESIUM_BASE_URL: JSON.stringify(cesiumBaseUrl),
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
