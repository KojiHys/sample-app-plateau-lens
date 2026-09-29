// 開発用の静的サーバー設定。inba-viewer/ はビルド不要の静的HTML+JSなので、
// 任意の静的サーバー（例: python3 -m http.server -d inba-viewer 5174）でも動く。
// リポジトリ直下のvite.config.ts（PLATEAU Lens用）を読み込まないよう、専用に分けている。
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export default {
  root: dirname(fileURLToPath(import.meta.url)),
  server: { host: "127.0.0.1", port: 5174, strictPort: true },
};
