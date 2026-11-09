import { verifyStaffSession } from "../../session/auth";
import { getStore } from "../../store";
import { mutateLocalState } from "../local-store";
import { bumpRev, lockSale, readSales, writeSale } from "../../shop-db";

export const dynamic = "force-dynamic";

// Refunds a sale entirely on the server: it marks the server's own copy of
// the sale as refunded. The tablet only sends the sale id. Stock is no longer
// counted (Nov 2026), so there is nothing to put back on a shelf count.

type Sale = { id: string; refunded?: boolean; [key: string]: unknown };

function localRefund(saleId: string) {
  return mutateLocalState((state) => {
    const sales = Array.isArray(state.sales) ? state.sales as Sale[] : [];
    if (!sales.some((entry) => entry.id === saleId)) throw new Error("That sale could not be found");
    const next = sales.map((entry) => (entry.id === saleId ? { ...entry, refunded: true } : entry));
    return { state: { ...state, sales: next }, result: { sales: next } };
  });
}

export async function POST(request: Request) {
  if (!(await verifyStaffSession(request))) return Response.json({ error: "Unauthorised" }, { status: 401 });
  try {
    const body = await request.json() as { saleId?: string };
    if (!body.saleId || typeof body.saleId !== "string") {
      return Response.json({ error: "Invalid refund" }, { status: 400 });
    }
    try {
      const { db, ready } = getStore();
      await ready;
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        // Two tills refunding the same sale queue on the sale row; the second
        // sees it already refunded and changes nothing.
        const sale = await lockSale(client, body.saleId) as Sale | null;
        if (!sale) throw new Error("That sale could not be found");
        if (!sale.refunded) {
          await writeSale(client, { ...sale, refunded: true });
          await bumpRev(client);
        }
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
      if (error instanceof Error && error.message === "That sale could not be found") throw error;
      return Response.json({ data: await localRefund(body.saleId), local: true });
    }
  } catch (error) {
    console.error("Refund failed", error);
    return Response.json({ error: error instanceof Error ? error.message : "Unable to refund" }, { status: 409 });
  }
}
