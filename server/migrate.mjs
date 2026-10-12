import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { getPool, closePool } from "./database.mjs";

const directory = fileURLToPath(new URL("./migrations/", import.meta.url));
export async function runMigrations(pool) {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  for (const name of (await readdir(directory)).filter((item) => item.endsWith(".sql")).sort()) {
    const { rowCount } = await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [name]);
    if (rowCount) continue;
    const sql = await readFile(new URL(`./migrations/${name}`, import.meta.url), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [name]);
      await client.query("COMMIT");
      console.log(`Applied ${name}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = getPool();
  try { await runMigrations(pool); }
  catch (error) { console.error(`Database migration failed: ${error.message}`); process.exitCode = 1; }
  finally { await closePool(); }
}
