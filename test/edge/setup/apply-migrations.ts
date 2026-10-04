import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Setup files run before each test file; applyD1Migrations skips already-applied migrations.
const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };
await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
