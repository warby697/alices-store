import { verifyStaffSession } from "../../session/auth";
import { getStore } from "../../store";
import { mutateLocalState } from "../local-store";
import { appendMovements, movement, type Movement } from "../movements";

export const dynamic = "force-dynamic";

type Product = { id: string; stock: number; name?: string; [key: string]: unknown };
type Sale = { id: string; [key: string]: unknown };
type Item = { id: string; quantity: number };

function applySale(products: Product[], sales: Sale[], sale: Sale, items: Item[]) {
  if (sales.some((existing) => existing.id === sale.id)) return { products, sales, movements: [] as Movement[] };
  const requested = new Map<string, number>();
  for (const item of items) {
    if (!item.id || !Number.isInteger(item.quantity) || item.quantity <= 0) throw new Error("Invalid sale item");
    const product = products.find((candidate) => candidate.id === item.id);
    // A line with no catalogue product behind it (a Yodeyma payment, or a
    // product deleted moments ago) is still recorded as takings - there is
    // simply no stock to move for it.
    if (!product) continue;
    // Loose items (bananas, served coffee, cakes) are sold but never counted:
    // the sale is recorded as takings and stock is left alone - no count to
    // go wrong, no recount flag, nothing in the movement log.
    if (product.noStockCount) continue;
    requested.set(item.id, (requested.get(item.id) || 0) + item.quantity);
  }
  const staff = typeof sale.staff === "string" ? sale.staff : "";
  const reason = sale.method === "Waste" ? "waste" : sale.method === "Owner's Perk" ? "perk" : "sale";
  const movements: Movement[] = [];
  return {
    // The item in the customer's hand is more real than the number on the
    // screen, so a sale is NEVER refused for "insufficient stock". The count
    // stops at zero and the product is flagged for a shelf recount instead.
    products: products.map((product) => {
      const quantity = requested.get(product.id);
      if (!quantity) return product;
      const short = product.stock < quantity;
      const next: Product = { ...product, stock: Math.max(0, product.stock - quantity) };
      if (short) next.recount = true;
      movements.push(movement(staff, reason, product, product.stock, next.stock));
      return next;
    }),
    sales: [sale, ...sales],
    movements,
  };
}

function localSale(sale: Sale, items: Item[]) {
  return mutateLocalState((state) => {
    const updated = applySale(
      Array.isArray(state.products) ? state.products as Product[] : [],
      Array.isArray(state.sales) ? state.sales as Sale[] : [],
      sale,
      items,
    );
    const next = { ...state, products: updated.products, sales: updated.sales, stock_log: appendMovements(state.stock_log, updated.movements) };
    return { state: next, result: next };
  });
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
        const locked = await client.query("SELECT key, value FROM store_state WHERE key IN ('products', 'sales', 'stock_log') FOR UPDATE");
        const state = Object.fromEntries(locked.rows.map((row: { key: unknown; value: unknown }) => [String(row.key), row.value]));
        const updated = applySale(
          Array.isArray(state.products) ? state.products as Product[] : [],
          Array.isArray(state.sales) ? state.sales as Sale[] : [],
          body.sale,
          body.items,
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
      return Response.json({ data: await localSale(body.sale, body.items), local: true });
    }
  } catch (error) {
    console.error("Sale failed", error);
    return Response.json({ error: error instanceof Error ? error.message : "Unable to complete sale" }, { status: 409 });
  }
}
