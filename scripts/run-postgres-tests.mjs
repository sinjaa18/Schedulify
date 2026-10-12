import { spawnSync } from "node:child_process";

if (!process.env.TEST_DATABASE_URL) {
  console.error("TEST_DATABASE_URL is required. Copy .env.test.example to .env.test and configure a disposable *_test database.");
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, ["--test", "tests/postgres.integration.test.mjs"], { stdio: "inherit", env: process.env });
  process.exitCode = result.status ?? 1;
}
