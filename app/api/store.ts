import { getDatabase } from "@netlify/database";
import { ensureShopSchema } from "./shop-db";

// Shared access to the Netlify (Neon) database used by every API route.
// The tables are created on first use so a fresh production database works
// without a manual migration step, and the old whole-list values are copied
// into the row-per-item tables exactly once (see shop-db.ts).

let schemaReady: Promise<void> | undefined;

// Tests swap in an in-memory Postgres here.
const override = () => (globalThis as { __aliceTestDb?: ReturnType<typeof getDatabase> }).__aliceTestDb;

// Returns the database connection together with a promise that resolves once
// the schema is guaranteed to exist. The check runs once per warm server
// instance. Throws (like getDatabase) when no database is configured, so
// callers keep their development file fallback.
export function getStore() {
  const db = override() ?? getDatabase();
  if (!schemaReady) {
    schemaReady = (async () => {
      const client = await db.pool.connect();
      try {
        await ensureShopSchema(client);
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

export function resetStoreForTests() {
  schemaReady = undefined;
}
