import { getDatabase } from "@netlify/database";

// Shared access to the Netlify (Neon) database used by every API route.
// The table is created on first use so a fresh production database works
// without a manual migration step.
const CREATE_STORE = `CREATE TABLE IF NOT EXISTS store_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

let schemaReady: Promise<void> | undefined;

// Returns the database connection together with a promise that resolves once
// the store_state table is guaranteed to exist. The schema check runs once per
// warm server instance. Throws (like getDatabase) when no database is
// configured, so callers keep their development file fallback.
export function getStore() {
  const db = getDatabase();
  if (!schemaReady) {
    schemaReady = (async () => {
      const client = await db.pool.connect();
      try {
        await client.query(CREATE_STORE);
      } finally {
        client.release();
      }
    })().catch((error) => {
      schemaReady = undefined;
      throw error;
    });
  }
  return { db, ready: schemaReady };
}
