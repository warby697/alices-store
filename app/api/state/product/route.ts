import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { verifyStaffSession } from "../../session/auth";
import { getStore } from "../../store";

export const dynamic = "force-dynamic";

type Product = { id: string; name?: string; [key: string]: unknown };

const localStateFile = join(process.cwd(), ".local", "store-state.json");
let localWrite = Promise.resolve();

// Merge a single product into the catalogue by id, leaving every other product
// (and its live stock) untouched. This is what keeps concurrent backfilling on
// several tablets safe: each save only ever changes the one product it owns.
function mergeProduct(products: Product[], product: Product) {
  const exists = products.some((candidate) => candidate.id === product.id);
  return exists
    ? products.map((candidate) => (candidate.id === product.id ? product : candidate))
    : [...products, product];
}

async function localSave(product: Product) {
  let result: Product[] = [];
  localWrite = localWrite.then(async () => {
    let state: Record<string, unknown> = {};
    try { state = JSON.parse(await readFile(localStateFile, "utf8")); } catch {}
    const products = Array.isArray(state.products) ? (state.products as Product[]) : [];
    const next = mergeProduct(products, product);
    state = { ...state, products: next };
    await mkdir(dirname(localStateFile), { recursive: true });
    await writeFile(localStateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    result = next;
  });
  await localWrite;
  return result;
}

async function localDelete(id: string) {
  let result: Product[] = [];
  localWrite = localWrite.then(async () => {
    let state: Record<string, unknown> = {};
    try { state = JSON.parse(await readFile(localStateFile, "utf8")); } catch {}
    const products = Array.isArray(state.products) ? (state.products as Product[]) : [];
    result = products.filter((product) => product.id !== id);
    state = { ...state, products: result };
    await mkdir(dirname(localStateFile), { recursive: true });
    await writeFile(localStateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  });
  await localWrite;
  return result;
}

export async function POST(request: Request) {
  if (!(await verifyStaffSession(request))) return Response.json({ error: "Unauthorised" }, { status: 401 });
  try {
    const body = await request.json() as { product?: Product };
    const product = body.product;
    if (!product?.id || typeof product.id !== "string" || !product.name || typeof product.name !== "string") {
      return Response.json({ error: "Invalid product" }, { status: 400 });
    }
    try {
      const { db, ready } = getStore();
      await ready;
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        const locked = await client.query("SELECT value FROM store_state WHERE key = 'products' FOR UPDATE");
        const current = Array.isArray(locked.rows[0]?.value) ? locked.rows[0].value as Product[] : [];
        const next = mergeProduct(current, product);
        await client.query(
          "INSERT INTO store_state (key, value, updated_at) VALUES ('products', $1::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
          [JSON.stringify(next)],
        );
        await client.query("COMMIT");
        return Response.json({ data: { products: next } });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      if (process.env.NODE_ENV !== "development") throw error;
      return Response.json({ data: { products: await localSave(product) }, local: true });
    }
  } catch (error) {
    console.error("Product save failed", error);
    return Response.json({ error: error instanceof Error ? error.message : "Unable to save product" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  if (!(await verifyStaffSession(request))) return Response.json({ error: "Unauthorised" }, { status: 401 });
  try {
    const body = await request.json() as { id?: string };
    if (!body.id || typeof body.id !== "string") return Response.json({ error: "Invalid product" }, { status: 400 });
    try {
      const { db, ready } = getStore();
      await ready;
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        const locked = await client.query("SELECT value FROM store_state WHERE key = 'products' FOR UPDATE");
        const current = Array.isArray(locked.rows[0]?.value) ? locked.rows[0].value as Product[] : [];
        const next = current.filter((product) => product.id !== body.id);
        await client.query(
          "INSERT INTO store_state (key, value, updated_at) VALUES ('products', $1::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
          [JSON.stringify(next)],
        );
        await client.query("COMMIT");
        return Response.json({ data: { products: next } });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      if (process.env.NODE_ENV !== "development") throw error;
      return Response.json({ data: { products: await localDelete(body.id) }, local: true });
    }
  } catch (error) {
    console.error("Product delete failed", error);
    return Response.json({ error: error instanceof Error ? error.message : "Unable to delete product" }, { status: 500 });
  }
}
