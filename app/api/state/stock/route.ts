import { staffFromSession, verifyStaffSession } from "../../session/auth";
import { getStore } from "../../store";
import { mutateLocalState } from "../local-store";
import { appendMovements, movement, type Movement } from "../movements";

export const dynamic = "force-dynamic";

// Changes stock levels for one or more products inside a single locked
// transaction. This is the ONLY route (besides a sale and a refund) that moves
// stock: every screen sends "add N" / "remove N" / "counted N" instructions
// here, and the server applies them to its own current figures. A screen that
// has been open all day can therefore never drag another product's count - or
// even this product's count - back to what it remembered.

type Product = { id: string; stock: number; name?: string; [key: string]: unknown };
// keepRecount: true leaves a "needs a shelf recount" flag alone - used by the
// shopping trip, whose automatic trolley deltas aren't anyone counting the
// shelf. Every other stock change is a person correcting the number, which is
// exactly what the flag was asking for, so it clears.
type Change = { id: string; delta?: number; set?: number; keepRecount?: boolean };

function applyChanges(products: Product[], changes: Change[], staff: string, reason: string) {
  const byId = new Map(products.map((product) => [product.id, product]));
  const missing: string[] = [];
  const movements: Movement[] = [];
  for (const change of changes) {
    const product = byId.get(change.id);
    // A product deleted since the screen loaded: nothing to update. Report it
    // back rather than failing the whole batch (a daily count should still
    // save its other seven lines).
    if (!product) { missing.push(change.id); continue; }
    // Stock is not counted for this product - nothing to change or log.
    if (product.noStockCount) continue;
    const current = Number(product.stock) || 0;
    const next = typeof change.set === "number"
      ? Math.max(0, Math.floor(change.set))
      : Math.max(0, current + Math.floor(change.delta || 0));
    const updated: Product = { ...product, stock: next };
    if (!change.keepRecount) delete updated.recount;
    byId.set(change.id, updated);
    // Every change makes the log, even a "count is right" confirmation that
    // moves nothing - proof someone checked is worth a line.
    movements.push(movement(staff, reason, product, current, next));
  }
  return { products: products.map((product) => byId.get(product.id) as Product), missing, movements };
}

function validChanges(raw: unknown): Change[] | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > 200) return null;
  const changes: Change[] = [];
  for (const entry of raw as Change[]) {
    if (!entry || typeof entry.id !== "string" || !entry.id) return null;
    const hasDelta = typeof entry.delta === "number" && Number.isFinite(entry.delta);
    const hasSet = typeof entry.set === "number" && Number.isFinite(entry.set);
    if (!hasDelta && !hasSet) return null;
    changes.push({ id: entry.id, delta: hasDelta ? entry.delta : undefined, set: hasSet ? entry.set : undefined, keepRecount: entry.keepRecount === true });
  }
  return changes;
}

function localAdjust(changes: Change[], staff: string, reason: string) {
  return mutateLocalState((state) => {
    const products = Array.isArray(state.products) ? (state.products as Product[]) : [];
    const result = applyChanges(products, changes, staff, reason);
    return {
      state: { ...state, products: result.products, stock_log: appendMovements(state.stock_log, result.movements) },
      result: { products: result.products, missing: result.missing },
    };
  });
}

export async function POST(request: Request) {
  if (!(await verifyStaffSession(request))) return Response.json({ error: "Unauthorised" }, { status: 401 });
  try {
    const body = await request.json() as { changes?: unknown; reason?: unknown };
    const changes = validChanges(body.changes);
    if (!changes) return Response.json({ error: "Invalid stock change" }, { status: 400 });
    const reason = typeof body.reason === "string" && /^[a-z-]{1,20}$/.test(body.reason) ? body.reason : "adjust";
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
        const updated = applyChanges(current, changes, staff, reason);
        await client.query(
          "INSERT INTO store_state (key, value, updated_at) VALUES ('products', $1::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
          [JSON.stringify(updated.products)],
        );
        await client.query(
          "INSERT INTO store_state (key, value, updated_at) VALUES ('stock_log', $1::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
          [JSON.stringify(appendMovements(state.stock_log, updated.movements))],
        );
        await client.query("COMMIT");
        return Response.json({ data: { products: updated.products, missing: updated.missing } });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      if (process.env.NODE_ENV !== "development") throw error;
      return Response.json({ data: await localAdjust(changes, staff, reason), local: true });
    }
  } catch (error) {
    console.error("Stock change failed", error);
    return Response.json({ error: error instanceof Error ? error.message : "Unable to change stock" }, { status: 500 });
  }
}
