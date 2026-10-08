import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const core = fileURLToPath(new URL("../core/src/", import.meta.url));

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "src/live/transport.integration.test.ts"]
  },
  resolve: {
    alias: [
      { find: /^@slidepix\/core\/assets$/, replacement: `${core}assets.ts` },
      { find: /^@slidepix\/core$/, replacement: `${core}index.ts` }
    ]
  }
});
