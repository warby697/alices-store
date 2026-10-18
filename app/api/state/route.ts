import { verifyStaffSession } from "../session/auth";
import { getStore } from "../store";
import { mutateLocalState, readLocalState } from "./local-store";

export const dynamic = "force-dynamic";

function writeLocalState(update: Record<string, unknown>) {
  return mutateLocalState((state) => ({ state: { ...state, ...update }, result: undefined }));
}

export async function GET(request: Request) {
  if (!(await verifyStaffSession(request))) return Response.json({ error: "Unauthorised" }, { status: 401 });
  if (process.env.NODE_ENV === "development") {
    return Response.json({ data: await readLocalState(), local: true });
  }
  try {
    const { db, ready } = getStore();
    await ready;
    const result = await db.sql`SELECT key, value FROM store_state`;
    return Response.json({ data: Object.fromEntries(result.map((row) => [String(row.key), row.value])) });
  } catch (error) {
    console.error("Database read failed", error);
    return Response.json({ data: {}, offline: true }, { status: 503 });
  }
}

export async function PUT(request: Request) {
  if (!(await verifyStaffSession(request))) return Response.json({ error: "Unauthorised" }, { status: 401 });
  let update: Record<string, unknown> = {};
  try {
    const body = await request.json() as { data?: Record<string, unknown> };
    update = body.data || {};
    const entries = Object.entries(update);
    if (!entries.length || entries.length > 20) return Response.json({ error: "Invalid state update" }, { status: 400 });
    // Validate every key BEFORE touching any store, so a bad request can never
    // fall through to the development file fallback either. Products and sales
    // must NEVER be overwritten wholesale: a screen that has been open for
    // hours would resurrect stock that has since been sold. They only change
    // through the sale/stock/refund/product routes, which apply one deliberate
    // change at a time to the server's own copy.
    for (const [key] of entries) {
      // Allows camelCase: the app has always saved the basket as "shoppingBasket",
      // which the old lowercase-only rule quietly rejected in production.
      if (!/^[a-z][a-zA-Z0-9_-]{1,40}$/.test(key)) return Response.json({ error: "Invalid state key" }, { status: 400 });
      if (key === "products" || key === "sales" || key === "stock_log" || key === "till_days" || key === "sign_ins") {
        return Response.json({ error: `"${key}" cannot be saved wholesale - it only changes through its own locked routes` }, { status: 400 });
      }
    }
    const { db, ready } = getStore();
    await ready;
    for (const [key, value] of entries) {
      await db.sql`INSERT INTO store_state (key, value, updated_at) VALUES (${key}, ${JSON.stringify(value)}::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`;
    }
    return Response.json({ ok: true });
  } catch (error) {
    console.error("Database write failed", error);
    if (process.env.NODE_ENV === "development" && Object.keys(update).length) {
      await writeLocalState(update);
      return Response.json({ ok: true, local: true });
    }
    return Response.json({ error: "Unable to save" }, { status: 503 });
  }
}
