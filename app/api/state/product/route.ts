import { staffFromSession, verifyStaffSession } from "../../session/auth";
import { getStore } from "../../store";
import { mutateLocalState } from "../local-store";
import { appendMovements, movement, type Movement } from "../movements";

export const dynamic = "force-dynamic";

type Product = { id: string; name?: string; stock?: number; [key: string]: unknown };
type StockChange = { delta?: number; set?: number };

// Merge a single product into the catalogue by id, leaving every other product
// (and its live stock) untouched. This is what keeps concurrent backfilling on
// several tablets safe: each save only ever changes the one product it owns.
//
// The stock NUMBER inside the sent product is ignored for an existing record:
// the server's live count wins, because the sender's screen may be hours old.
// A deliberate stock change arrives separately as { delta } or { set } and is
// applied to the server's own current figure.
function mergeProduct(products: Product[], product: Product, stock: StockChange | undefined, staff: string, reason: string) {
  const existing = products.find((candidate) => candidate.id === product.id);
  const applyStock = (current: number) => {
    if (typeof stock?.set === "number") return Math.max(0, Math.floor(stock.set));
    if (typeof stock?.delta === "number") return Math.max(0, current + Math.floor(stock.delta));
    return current;
  };
  const movements: Movement[] = [];
  if (!existing) {
    const opening = product.noStockCount ? 0 : applyStock(Number(product.stock) || 0);
    // A brand-new product's opening count is a stock movement like any other.
    if (opening > 0) movements.push(movement(staff, "new", product, 0, opening));
    return { products: [...products, { ...product, stock: opening }], movements };
  }
  const from = Number(existing.stock) || 0;
  // "Don't count stock" (loose items): the count is parked at zero, with no
  // recount flag and no full-shelf target, so nothing about this product can
  // show as wrong or land on the shopping list.
  if (product.noStockCount) {
    const parked: Product = { ...product, stock: 0 };
    delete parked.recount;
    delete parked.full;
    if (from !== 0) movements.push(movement(staff, "edit", existing, from, 0));
    return { products: products.map((candidate) => (candidate.id === product.id ? parked : candidate)), movements };
  }
  const merged: Product = { ...product, stock: applyStock(from) };
  // The recount flag lives on the SERVER copy (a sale at zero sets it); the
  // sender's stale copy neither sets nor keeps it. A deliberate stock change
  // in this save is the recount happening, so the flag comes off.
  if (typeof stock?.set === "number" || typeof stock?.delta === "number") {
    delete merged.recount;
    movements.push(movement(staff, reason, existing, from, merged.stock as number));
  } else if (existing.recount) merged.recount = existing.recount;
  else delete merged.recount;
  return { products: products.map((candidate) => (candidate.id === product.id ? merged : candidate)), movements };
}

function localSave(product: Product, stock: StockChange | undefined, staff: string, reason: string) {
  return mutateLocalState((state) => {
    const products = Array.isArray(state.products) ? (state.products as Product[]) : [];
    const next = mergeProduct(products, product, stock, staff, reason);
    return {
      state: { ...state, products: next.products, stock_log: appendMovements(state.stock_log, next.movements) },
      result: next.products,
    };
  });
}

function localDelete(id: string) {
  return mutateLocalState((state) => {
    const products = Array.isArray(state.products) ? (state.products as Product[]) : [];
    const next = products.filter((product) => product.id !== id);
    return { state: { ...state, products: next }, result: next };
  });
}

export async function POST(request: Request) {
  if (!(await verifyStaffSession(request))) return Response.json({ error: "Unauthorised" }, { status: 401 });
  try {
    const body = await request.json() as { product?: Product; stock?: StockChange; reason?: unknown };
    const product = body.product;
    if (!product?.id || typeof product.id !== "string" || !product.name || typeof product.name !== "string") {
      return Response.json({ error: "Invalid product" }, { status: 400 });
    }
    const stock = body.stock && (typeof body.stock.delta === "number" || typeof body.stock.set === "number")
      ? body.stock
      : undefined;
    const reason = typeof body.reason === "string" && /^[a-z-]{1,20}$/.test(body.reason) ? body.reason : "edit";
    const staff = await staffFromSession(request);
    try {
      const { db, ready } = getStore();
      await ready;
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        const locked = await client.query("SELECT key, value FROM store_state WHERE key IN ('products', 'stock_log') FOR UPDATE");
        const state = Object.fromEntries(locked.rows.map((row: { key: unknown; value: unknown }) => [String(row.key), row.value]));
        const current = Array.isArray(state.products) ? state.products as Product[] : [];
        const next = mergeProduct(current, product, stock, staff, reason);
        await client.query(
          "INSERT INTO store_state (key, value, updated_at) VALUES ('products', $1::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
          [JSON.stringify(next.products)],
        );
        await client.query(
          "INSERT INTO store_state (key, value, updated_at) VALUES ('stock_log', $1::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
          [JSON.stringify(appendMovements(state.stock_log, next.movements))],
        );
        await client.query("COMMIT");
        return Response.json({ data: { products: next.products } });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      if (process.env.NODE_ENV !== "development") throw error;
      return Response.json({ data: { products: await localSave(product, stock, staff, reason) }, local: true });
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
