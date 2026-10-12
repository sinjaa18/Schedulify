import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../server/index.mjs";

async function withServer(poolProvider, run) {
  const server = createApiServer({ poolProvider });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test("liveness is independent of PostgreSQL and exposes no provider configuration", async () => {
  let queries = 0;
  await withServer(() => ({ query: async () => { queries += 1; throw new Error("database offline"); } }), async (origin) => {
    const response = await fetch(`${origin}/api/health/live`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(queries, 0);
  });
});

test("readiness checks PostgreSQL without exposing internal failure details", async () => {
  await withServer(() => ({ query: async () => { throw Object.assign(new Error("private connection details"), { code: "ECONNREFUSED" }); } }), async (origin) => {
    const response = await fetch(`${origin}/api/health/ready`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, checks: { postgres: "unavailable" } });
  });
  await withServer(() => ({ query: async () => ({ rowCount: 1 }) }), async (origin) => {
    const response = await fetch(`${origin}/api/health/ready`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, checks: { postgres: "available" } });
  });
});
