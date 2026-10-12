import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../server/index.mjs";

test("production server serves the built React app and API from one origin", async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const server = createApiServer({ poolProvider: () => { throw new Error("liveness must not query PostgreSQL"); } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  try {
    const home = await fetch(origin + "/");
    assert.equal(home.status, 200);
    assert.match(home.headers.get("content-type") || "", /text\/html/);
    const html = await home.text();
    const script = html.match(/src="([^"]+\.js)"/);
    assert.ok(script, "built HTML should reference a JavaScript bundle");
    const asset = await fetch(new URL(script[1], origin));
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type") || "", /javascript/);
    const cssPath = html.match(/href="([^"]+\.css)"/);
    assert.ok(cssPath, "built HTML should reference a CSS bundle");
    const css = await fetch(new URL(cssPath[1], origin));
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") || "", /text\/css/);
    const deepLink = await fetch(origin + "/admin");
    assert.equal(deepLink.status, 200);
    assert.match(deepLink.headers.get("content-type") || "", /text\/html/);
    const live = await fetch(origin + "/api/health/live");
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { ok: true });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});
