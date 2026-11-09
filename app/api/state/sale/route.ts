import { verifyStaffSession } from "../../session/auth";
import { getStore } from "../../store";
import { mutateLocalState } from "../local-store";
import { bumpRev, insertSale, readSales } from "../../shop-db";

export const dynamic = "force-dynamic";

// Records a sale. Stock is no longer counted (Nov 2026), so a sale is just the
// money: who, when, what was rung up and how it was paid. The sale id is the
// duplicate check - a sale id that is already recorded changes nothing, so a
// retry from a tablet can never record a sale twice.

type Sale = { id: string; [key: string]: unknown };
type Item = { id: string; quantity: number };

function checkItems(items: Item[]) {
  for (const item of items) {
    if (!item.id || !Number.isInteger(item.quantity) || item.quantity <= 0) throw new Error("Invalid sale item");
  }
}

function localSale(sale: Sale) {
  return mutateLocalState((state) => {
    const sales = Array.isArray(state.sales) ? state.sales as Sale[] : [];
    const next = sales.some((existing) => existing.id === sale.id) ? sales : [sale, ...sales];
    return { state: { ...state, sales: next }, result: { sales: next } };
  });
}

export async function POST(request: Request) {
  if (!(await verifyStaffSession(request))) return Response.json({ error: "Unauthorised" }, { status: 401 });
  try {
    const body = await request.json() as { sale?: Sale; items?: Item[] };
    if (!body.sale?.id || !Array.isArray(body.items) || !body.items.length) {
      return Response.json({ error: "Invalid sale" }, { status: 400 });
    }
    checkItems(body.items);
    try {
      const { db, ready } = getStore();
      await ready;
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        if (await insertSale(client, body.sale)) await bumpRev(client);
        const sales = await readSales(client);
        await client.query("COMMIT");
        return Response.json({ data: { sales } });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      if (process.env.NODE_ENV !== "development") throw error;
      return Response.json({ data: await localSale(body.sale), local: true });
    }
  } catch (error) {
    console.error("Sale failed", error);
    return Response.json({ error: error instanceof Error ? error.message : "Unable to complete sale" }, { status: 409 });
  }
}
