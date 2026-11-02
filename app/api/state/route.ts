import { verifyStaffSession } from "../session/auth";
import { bumpRev, readMovements, readProducts, readRev, readSales, readSmallState, SALES_WINDOW_DAYS } from "../shop-db";
import { getStore } from "../store";
import { mutateLocalState, readLocalState } from "./local-store";

export const dynamic = "force-dynamic";

function writeLocalState(update: Record<string, unknown>) {
  return mutateLocalState((state) => ({ state: { ...state, ...update }, result: undefined }));
}

// ?keys=a,b,c asks for just those parts of the shop (products, sales,
// stock_log, or any small value such as daily_checks). With no keys you get
// everything a till normally needs; the stock log and sign-in history are
// big and only sent when asked for by name. ?salesDays=N widens the sales
// window (the default is the last 45 days); salesDays=all sends every sale.
// The reply carries "rev", read BEFORE the data, so a till that remembers it
// can never miss a change made in between.
export async function GET(request: Request) {
  if (!(await verifyStaffSession(request))) return Response.json({ error: "Unauthorised" }, { status: 401 });
  const params = new URL(request.url).searchParams;
  const keys = params.get("keys")?.split(",").map((key) => key.trim()).filter(Boolean);
  const daysParam = params.get("salesDays");
  const salesDays = daysParam === "all" ? null : Math.min(Math.max(Number(daysParam) || SALES_WINDOW_DAYS, 1), 3650);
  if (process.env.NODE_ENV === "development") {
    const all = await readLocalState();
    const data = keys ? Object.fromEntries(keys.filter((key) => key in all).map((key) => [key, all[key]])) : all;
    return Response.json({ data, rev: null, local: true });
  }
  try {
    const { db, ready } = getStore();
    await ready;
    const rev = await readRev(db.pool);
    const want = (key: string) => (keys ? keys.includes(key) : key === "products" || key === "sales");
    const data: Record<string, unknown> = {};
    const small = keys ? keys.filter((key) => !["products", "sales", "stock_log"].includes(key)) : undefined;
    if (!keys || small?.length) Object.assign(data, await readSmallState(db.pool, small));
    if (want("products")) data.products = await readProducts(db.pool);
    if (want("sales")) data.sales = await readSales(db.pool, salesDays);
    if (want("stock_log")) data.stock_log = await readMovements(db.pool);
    return Response.json({ data, rev });
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
      if (key === "products" || key === "sales" || key === "stock_log" || key === "till_days" || key === "sign_ins" || key.startsWith("sys_")) {
        return Response.json({ error: `"${key}" cannot be saved wholesale - it only changes through its own locked routes` }, { status: 400 });
      }
    }
    const { db, ready } = getStore();
    await ready;
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      for (const [key, value] of entries) {
        await client.query("INSERT INTO store_state (key, value, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()", [key, JSON.stringify(value)]);
      }
      await bumpRev(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
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
