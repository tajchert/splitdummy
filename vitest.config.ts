import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

const alias = { "@shared": new URL("./src/shared", import.meta.url).pathname };
const migrations = await readD1Migrations(new URL("./migrations", import.meta.url).pathname);

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
            miniflare: {
              // vitest-pool-workers bundles an older workerd (max 2026-08-22)
              compatibilityDate: "2026-08-22",
              bindings: {
                ENVIRONMENT: "test",
                APP_ORIGIN: "http://localhost",
                // Cloudflare's documented always-pass Turnstile test keys.
                TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
                TURNSTILE_SECRET: "1x0000000000000000000000000000000AA",
                TEST_MIGRATIONS: migrations,
              },
            },
          }),
        ],
        test: {
          name: "worker",
          include: ["test/**/*.test.ts", "worker/**/*.test.ts"],
          setupFiles: ["./test/edge/setup/apply-migrations.ts"],
        },
      },
    ],
  },
});
