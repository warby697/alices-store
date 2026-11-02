import type { Movement } from "./state/movements";

// Row-per-item storage for the three lists that grow: products, sales and the
// stock movement log. They used to be three giant JSON values in store_state,
// so every sale read and rewrote the whole history. Now each product, sale and
// movement is its own row and a sale touches only the rows it changes.
//
// Everything here takes a database client that is already inside a
// transaction (or a plain pool for reads), so the routes stay in charge of
// BEGIN / COMMIT and the locking order.

export type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

// The till only ever shows recent sales (today, the last fortnight, the last
// 30 days of shop days), so by default it is sent this many days of them
// rather than the whole history.
export const SALES_WINDOW_DAYS = 45;
const KEEP_MOVEMENT_DAYS = 120;
const KEEP_MOVEMENT_MAX = 6000;
const MIGRATED = "sys_migrated_rows_v1";

type Row = Record<string, unknown> & { id?: string };

const validTime = (value: unknown) => {
  const t = Date.parse(String(value ?? ""));
  return Number.isNaN(t) ? new Date().toISOString() : new Date(t).toISOString();
};

async function insertChunks(client: Q, table: "shop_sales" | "shop_stock_log", rows: { id: string; at: string; data: Row }[]) {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await client.query(
      `INSERT INTO ${table} (id, at, data) SELECT id, at::timestamptz, data::jsonb FROM unnest($1::text[], $2::text[], $3::text[]) AS t(id, at, data) ON CONFLICT (id) DO NOTHING`,
      [chunk.map((r) => r.id), chunk.map((r) => r.at), chunk.map((r) => JSON.stringify(r.data))],
    );
  }
}

// Creates the tables and, exactly once, copies the old whole-list values into
// them. The old store_state rows are left where they are as a backup. Runs
// inside one transaction under an advisory lock, so two server instances
// starting together cannot both migrate.
export async function ensureShopSchema(client: Q) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(7001)");
    await client.query(`CREATE TABLE IF NOT EXISTS store_state (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS shop_products (seq BIGSERIAL, id TEXT PRIMARY KEY, data JSONB NOT NULL)`);
    await client.query(`CREATE TABLE IF NOT EXISTS shop_sales (id TEXT PRIMARY KEY, at TIMESTAMPTZ NOT NULL, data JSONB NOT NULL)`);
    await client.query(`CREATE INDEX IF NOT EXISTS shop_sales_at ON shop_sales (at DESC)`);
    await client.query(`CREATE TABLE IF NOT EXISTS shop_stock_log (id TEXT PRIMARY KEY, at TIMESTAMPTZ NOT NULL, data JSONB NOT NULL)`);
    await client.query(`CREATE INDEX IF NOT EXISTS shop_stock_log_at ON shop_stock_log (at DESC)`);
    await client.query(`CREATE TABLE IF NOT EXISTS store_rev (id INT PRIMARY KEY, rev BIGINT NOT NULL)`);
    await client.query(`INSERT INTO store_rev (id, rev) VALUES (1, 1) ON CONFLICT (id) DO NOTHING`);
    const done = await client.query("SELECT 1 FROM store_state WHERE key = $1", [MIGRATED]);
    if (!done.rows.length) {
      const legacy = await client.query("SELECT key, value FROM store_state WHERE key IN ('products', 'sales', 'stock_log')");
      const old = Object.fromEntries(legacy.rows.map((r) => [String(r.key), r.value]));
      const products = (Array.isArray(old.products) ? old.products : []) as Row[];
      for (let i = 0; i < products.length; i += 500) {
        const chunk = products.slice(i, i + 500);
        await client.query(
          "INSERT INTO shop_products (id, data) SELECT id, data::jsonb FROM unnest($1::text[], $2::text[]) AS t(id, data) ON CONFLICT (id) DO NOTHING",
          [chunk.map((p, n) => String(p.id ?? `legacy-product-${i + n}`)), chunk.map((p) => JSON.stringify(p))],
        );
      }
      const sales = (Array.isArray(old.sales) ? old.sales : []) as Row[];
      await insertChunks(client, "shop_sales", sales.map((s, n) => ({ id: String(s.id ?? `legacy-sale-${n}`), at: validTime(s.at), data: s })));
      const log = (Array.isArray(old.stock_log) ? old.stock_log : []) as Row[];
      await insertChunks(client, "shop_stock_log", log.map((m, n) => ({ id: String(m.id ?? `legacy-move-${n}`), at: validTime(m.at), data: m })));
      await client.query("INSERT INTO store_state (key, value) VALUES ($1, $2::jsonb)", [MIGRATED, JSON.stringify({ at: new Date().toISOString(), products: products.length, sales: sales.length, stock_log: log.length })]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

// Every write bumps this one tiny counter. A till asks "has it changed?" by
// reading just this number instead of downloading the shop.
export const bumpRev = (client: Q) => client.query("UPDATE store_rev SET rev = rev + 1 WHERE id = 1");
export async function readRev(client: Q) {
  const result = await client.query("SELECT rev FROM store_rev WHERE id = 1");
  return result.rows.length ? Number(result.rows[0].rev) : null;
}

export async function readProducts(client: Q) {
  const result = await client.query("SELECT data FROM shop_products ORDER BY seq");
  return result.rows.map((r) => r.data as Row);
}

// Locks just these products (in id order, so two sales can never deadlock)
// and returns them in the order asked for.
export async function lockProducts(client: Q, ids: string[]) {
  const unique = [...new Set(ids)].sort();
  if (!unique.length) return [] as Row[];
  const result = await client.query("SELECT id, data FROM shop_products WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE", [unique]);
  return result.rows.map((r) => r.data as Row);
}

export async function writeProduct(client: Q, product: Row) {
  await client.query("INSERT INTO shop_products (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data", [String(product.id), JSON.stringify(product)]);
}

export async function removeProduct(client: Q, id: string) {
  await client.query("DELETE FROM shop_products WHERE id = $1", [id]);
}

// Newest first, like the old list.
export async function readSales(client: Q, days: number | null = SALES_WINDOW_DAYS) {
  const result = days === null
    ? await client.query("SELECT data FROM shop_sales ORDER BY at DESC, id")
    : await client.query("SELECT data FROM shop_sales WHERE at >= NOW() - ($1::int * INTERVAL '1 day') ORDER BY at DESC, id", [Math.ceil(days)]);
  return result.rows.map((r) => r.data as Row);
}

// false when a sale with this id is already recorded: a retry can never
// record a sale twice.
export async function insertSale(client: Q, sale: Row) {
  const result = await client.query("INSERT INTO shop_sales (id, at, data) VALUES ($1, $2::timestamptz, $3::jsonb) ON CONFLICT (id) DO NOTHING RETURNING id", [String(sale.id), validTime(sale.at), JSON.stringify(sale)]);
  return result.rows.length > 0;
}

export async function lockSale(client: Q, id: string) {
  const result = await client.query("SELECT data FROM shop_sales WHERE id = $1 FOR UPDATE", [id]);
  return result.rows.length ? (result.rows[0].data as Row) : null;
}

export async function writeSale(client: Q, sale: Row) {
  await client.query("UPDATE shop_sales SET data = $2::jsonb WHERE id = $1", [String(sale.id), JSON.stringify(sale)]);
}

export async function addMovements(client: Q, movements: Movement[]) {
  if (!movements.length) return;
  await insertChunks(client, "shop_stock_log", movements.map((m) => ({ id: m.id, at: validTime(m.at), data: m as unknown as Row })));
  await client.query("DELETE FROM shop_stock_log WHERE at < NOW() - ($1::int * INTERVAL '1 day')", [KEEP_MOVEMENT_DAYS]);
}

export async function readMovements(client: Q) {
  const result = await client.query("SELECT data FROM shop_stock_log ORDER BY at DESC, id LIMIT $1", [KEEP_MOVEMENT_MAX]);
  return result.rows.map((r) => r.data as Movement);
}

// Everything else (daily checks, shop days, settings, team...) stays in
// store_state: small values that change rarely.
export async function readSmallState(client: Q, keys?: string[]) {
  const result = keys
    ? await client.query("SELECT key, value FROM store_state WHERE key = ANY($1::text[])", [keys])
    : await client.query("SELECT key, value FROM store_state WHERE key NOT LIKE 'sys\\_%' AND key NOT IN ('products', 'sales', 'stock_log', 'sign_ins')");
  return Object.fromEntries(result.rows.map((r) => [String(r.key), r.value]));
}
