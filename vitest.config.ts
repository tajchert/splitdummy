import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

const alias = { "@shared": new URL("./src/shared", import.meta.url).pathname };

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: { name: "shared", include: ["src/shared/**/*.test.ts"], environment: "node" },
      },
      {
        resolve: { alias },
        test: { name: "web", include: ["src/web/**/*.test.{ts,tsx}"], environment: "jsdom" },
      },
      {
        resolve: { alias },
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: { bindings: { ENVIRONMENT: "test", APP_ORIGIN: "http://localhost" } },
          }),
        ],
        test: { name: "worker", include: ["test/**/*.test.ts", "worker/**/*.test.ts"] },
      },
    ],
  },
});
