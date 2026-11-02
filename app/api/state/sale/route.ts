import { verifyStaffSession } from "../../session/auth";
import { getStore } from "../../store";
import { mutateLocalState } from "../local-store";
import { appendMovements, movement, type Movement } from "../movements";
import { addMovements, bumpRev, insertSale, lockProducts, readProducts, readSales, writeProduct } from "../../shop-db";

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
      // The count is allowed to go below zero: something sold before its
      // delivery was entered shows as -1, so adding the full delivery later
      // lands on the true shelf number instead of one too many.
      const next: Product = { ...product, stock: product.stock - quantity };
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
        // Only this sale's own products are locked and rewritten. The sale
        // itself is the duplicate check: a sale id that is already recorded
        // changes nothing, so a retry can never sell twice.
        const fresh = await insertSale(client, body.sale);
        if (fresh) {
          const ids = body.items.map((item) => item.id).filter((id) => typeof id === "string");
          const locked = await lockProducts(client, ids) as Product[];
          const updated = applySale(locked, [], body.sale, body.items);
          for (let i = 0; i < locked.length; i += 1) {
            if (updated.products[i] !== locked[i]) await writeProduct(client, updated.products[i]);
          }
          await addMovements(client, updated.movements);
          await bumpRev(client);
        }
        const products = await readProducts(client);
        const sales = await readSales(client);
        await client.query("COMMIT");
        return Response.json({ data: { products, sales } });
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
