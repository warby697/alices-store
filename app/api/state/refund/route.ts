import { staffFromSession, verifyStaffSession } from "../../session/auth";
import { getStore } from "../../store";
import { mutateLocalState } from "../local-store";
import { appendMovements, movement, type Movement } from "../movements";

export const dynamic = "force-dynamic";

// Refunds a sale entirely on the server: mark the server's own copy of the
// sale as refunded and put its items back into the server's own stock counts,
// all in one locked transaction. The tablet only sends the sale id, so a
// stale screen cannot mis-report what was in the sale or what stock was.

type Product = { id: string; stock: number; [key: string]: unknown };
type Sale = { id: string; refunded?: boolean; stockOnly?: boolean; items?: { id: string; quantity: number }[]; [key: string]: unknown };

function applyRefund(products: Product[], sales: Sale[], saleId: string, staff: string) {
  const sale = sales.find((entry) => entry.id === saleId);
  if (!sale) throw new Error("That sale could not be found");
  // Already refunded (perhaps from another tablet a moment ago): change
  // nothing, so a double tap cannot put the stock back twice.
  if (sale.refunded) return { products, sales, movements: [] as Movement[] };
  const restock = new Map<string, number>();
  for (const item of sale.items || []) {
    if (item?.id && Number.isFinite(item.quantity)) restock.set(item.id, (restock.get(item.id) || 0) + Math.max(0, Math.floor(item.quantity)));
  }
  const movements: Movement[] = [];
  return {
    products: products.map((product) => {
      if (!restock.has(product.id)) return product;
      const from = Number(product.stock) || 0;
      const to = from + (restock.get(product.id) || 0);
      movements.push(movement(staff, "refund", product, from, to));
      return { ...product, stock: to };
    }),
    sales: sales.map((entry) => (entry.id === saleId ? { ...entry, refunded: true } : entry)),
    movements,
  };
}

function localRefund(saleId: string, staff: string) {
  return mutateLocalState((state) => {
    const result = applyRefund(
      Array.isArray(state.products) ? state.products as Product[] : [],
      Array.isArray(state.sales) ? state.sales as Sale[] : [],
      saleId,
      staff,
    );
    return {
      state: { ...state, products: result.products, sales: result.sales, stock_log: appendMovements(state.stock_log, result.movements) },
      result: { products: result.products, sales: result.sales },
    };
  });
}

export async function POST(request: Request) {
  if (!(await verifyStaffSession(request))) return Response.json({ error: "Unauthorised" }, { status: 401 });
  try {
    const body = await request.json() as { saleId?: string };
    if (!body.saleId || typeof body.saleId !== "string") {
      return Response.json({ error: "Invalid refund" }, { status: 400 });
    }
    const staff = await staffFromSession(request);
    try {
      const { db, ready } = getStore();
      await ready;
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        const locked = await client.query("SELECT key, value FROM store_state WHERE key IN ('products', 'sales', 'stock_log') FOR UPDATE");
        const state = Object.fromEntries(locked.rows.map((row: { key: unknown; value: unknown }) => [String(row.key), row.value]));
        const updated = applyRefund(
          Array.isArray(state.products) ? state.products as Product[] : [],
          Array.isArray(state.sales) ? state.sales as Sale[] : [],
          body.saleId,
          staff,
        );
        await client.query("INSERT INTO store_state (key, value, updated_at) VALUES ('products', $1::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()", [JSON.stringify(updated.products)]);
        await client.query("INSERT INTO store_state (key, value, updated_at) VALUES ('sales', $1::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()", [JSON.stringify(updated.sales)]);
        await client.query("INSERT INTO store_state (key, value, updated_at) VALUES ('stock_log', $1::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()", [JSON.stringify(appendMovements(state.stock_log, updated.movements))]);
        await client.query("COMMIT");
        return Response.json({ data: { products: updated.products, sales: updated.sales } });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      if (process.env.NODE_ENV !== "development") throw error;
      return Response.json({ data: await localRefund(body.saleId, staff), local: true });
    }
  } catch (error) {
    console.error("Refund failed", error);
    return Response.json({ error: error instanceof Error ? error.message : "Unable to refund" }, { status: 409 });
  }
}
