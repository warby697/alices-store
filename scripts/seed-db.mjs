// One-time seeding of the production database from the local data file.
//
// Usage:
//   NETLIFY_DATABASE_URL="postgres://..." npm run seed
//   NETLIFY_DATABASE_URL="postgres://..." npm run seed -- --overwrite
//
// By default existing keys in the database are left untouched (safe to run
// against a database that already has data). Pass --overwrite to replace them
// with the contents of .local/store-state.json.
import { getDatabase } from "@netlify/database";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const overwrite = process.argv.includes("--overwrite");
const connectionString =
  process.env.NETLIFY_DATABASE_URL ||
  process.argv.find((arg) => arg.startsWith("postgres://") || arg.startsWith("postgresql://"));

if (!connectionString) {
  console.error(
    "No database connection string. Set NETLIFY_DATABASE_URL (or pass the URL as an argument).",
  );
  process.exit(1);
}

const dataFile = join(process.cwd(), ".local", "store-state.json");
let state;
try {
  state = JSON.parse(await readFile(dataFile, "utf8"));
} catch (error) {
  console.error(`Could not read ${dataFile}:`, error.message);
  process.exit(1);
}

const entries = Object.entries(state);
if (!entries.length) {
  console.error("No data to seed - .local/store-state.json is empty.");
  process.exit(1);
}

const team = Array.isArray(state.team) ? state.team : [];
const activeAdmin = team.some((m) => m && m.active !== false && m.role === "Admin");
if (!activeAdmin) {
  console.error(
    "Refusing to seed: no active Admin in the team. Add an admin (e.g. in the app) before seeding, or nobody will be able to sign in.",
  );
  process.exit(1);
}

const { pool } = getDatabase({ connectionString });
const client = await pool.connect();
try {
  await client.query(`CREATE TABLE IF NOT EXISTS store_state (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  const conflict = overwrite
    ? "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()"
    : "ON CONFLICT (key) DO NOTHING";

  let written = 0;
  for (const [key, value] of entries) {
    const result = await client.query(
      `INSERT INTO store_state (key, value, updated_at) VALUES ($1, $2::jsonb, NOW()) ${conflict}`,
      [key, JSON.stringify(value)],
    );
    const changed = result.rowCount > 0;
    if (changed) written += 1;
    const count = Array.isArray(value) ? ` (${value.length} items)` : "";
    console.log(`${changed ? "wrote" : "kept "} ${key}${count}`);
  }
  console.log(
    `\nDone. ${written} of ${entries.length} keys written${overwrite ? "" : " (existing keys were kept - use --overwrite to replace them)"}.`,
  );
} catch (error) {
  console.error("Seeding failed:", error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
