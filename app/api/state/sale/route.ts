import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { verifyStaffSession } from "../../session/auth";
import { getStore } from "../../store";

export const dynamic = "force-dynamic";

type Product = { id: string; stock: number; name?: string; [key: string]: unknown };
type Sale = { id: string; [key: string]: unknown };
type Item = { id: string; quantity: number };

const localStateFile = join(process.cwd(), ".local", "store-state.json");
let localWrite = Promise.resolve();

function applySale(products: Product[], sales: Sale[], sale: Sale, items: Item[]) {
  if (sales.some((existing) => existing.id === sale.id)) return { products, sales };
  const requested = new Map(items.map((item) => [item.id, item.quantity]));
  for (const item of items) {
    if (!item.id || !Number.isInteger(item.quantity) || item.quantity <= 0) throw new Error("Invalid sale item");
    const product = products.find((candidate) => candidate.id === item.id);
    if (!product) throw new Error("A product in this sale no longer exists");
    if (product.stock < item.quantity) throw new Error(`${product.name || "Product"} has insufficient stock`);
  }
  return {
    products: products.map((product) => requested.has(product.id)
      ? { ...product, stock: product.stock - (requested.get(product.id) || 0) }
      : product),
    sales: [sale, ...sales],
  };
}

async function localSale(sale: Sale, items: Item[]) {
  let result: Record<string, unknown> = {};
  localWrite = localWrite.then(async () => {
    let state: Record<string, unknown> = {};
    try { state = JSON.parse(await readFile(localStateFile, "utf8")); } catch {}
    const updated = applySale(
      Array.isArray(state.products) ? state.products as Product[] : [],
      Array.isArray(state.sales) ? state.sales as Sale[] : [],
      sale,
      items,
    );
    state = { ...state, ...updated };
    await mkdir(dirname(localStateFile), { recursive: true });
    await writeFile(localStateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    result = state;
  });
  await localWrite;
  return result;
}

export async function POST(request: Request) {
  if (!(await verifyStaffSession(request))) return Response.json({ error: "Unauthorised" }, { status: 401 });
  try {
    const body = await request.json() as { sale?: Sale; items?: Item[] };
    if (!body.sale?.id || !Array.isArray(body.items) || !body.items.length) {
      return Response.json({ error: "Invalid sale" }, { status: 400 });
    }
    try {
      const { db, ready } = getStore();
      await ready;
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        const locked = await client.query("SELECT key, value FROM store_state WHERE key IN ('products', 'sales') FOR UPDATE");
        const state = Object.fromEntries(locked.rows.map((row: { key: unknown; value: unknown }) => [String(row.key), row.value]));
        const updated = applySale(
          Array.isArray(state.products) ? state.products as Product[] : [],
          Array.isArray(state.sales) ? state.sales as Sale[] : [],
          body.sale,
          body.items,
        );
        await client.query("INSERT INTO store_state (key, value, updated_at) VALUES ('products', $1::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()", [JSON.stringify(updated.products)]);
        await client.query("INSERT INTO store_state (key, value, updated_at) VALUES ('sales', $1::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()", [JSON.stringify(updated.sales)]);
        await client.query("COMMIT");
        return Response.json({ data: updated });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      if (process.env.NODE_ENV !== "development") throw error;
      return Response.json({ data: await localSale(body.sale, body.items), local: true });
    }
  } catch (error) {
    console.error("Sale failed", error);
    return Response.json({ error: error instanceof Error ? error.message : "Unable to complete sale" }, { status: 409 });
  }
}
