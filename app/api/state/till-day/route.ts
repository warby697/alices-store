import { staffFromSession, verifyStaffSession } from "../../session/auth";
import { getStore } from "../../store";
import { mutateLocalState } from "../local-store";

export const dynamic = "force-dynamic";

// Opening and closing the shop each day. Volunteers only (no wages), so the
// cash must balance exactly: a £50 float in the morning, and at closing the
// takings taken out must equal the day's cash sales, with £50 left behind.
//
// The server works out the day's cash sales from its own copy of the sales,
// so a screen that has been open for hours can't mis-state them, and every
// change happens in one locked transaction so two tills can't overwrite each
// other.

type Sale = { at: string; method?: string; total?: number; cashAmount?: number; refunded?: boolean; stockOnly?: boolean };
type TillDay = {
  date: string;
  openedAt?: string;
  openedBy?: string;
  floatConfirmed?: boolean;
  closedAt?: string;
  closedBy?: string;
  cashSales?: number;
  takingsCounted?: number;
  difference?: number;
  floatLeft?: boolean;
  note?: string;
};

const ukDay = (iso: string | Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const round2 = (n: number) => Math.round(n * 100) / 100;

function cashSalesFor(sales: Sale[], date: string) {
  return round2(sales
    .filter((s) => !s.refunded && !s.stockOnly && ukDay(s.at) === date)
    .reduce((n, s) => n + (typeof s.cashAmount === "number" ? s.cashAmount : s.method === "Cash" ? Number(s.total) || 0 : 0), 0));
}

type Body = { action?: unknown; takingsCounted?: unknown; floatLeft?: unknown; note?: unknown };

function apply(days: TillDay[], sales: Sale[], body: Body, staff: string): { days: TillDay[]; day: TillDay } {
  const date = ukDay(new Date());
  const now = new Date().toISOString();
  const existing = days.find((d) => d.date === date);
  if (body.action === "open") {
    if (existing?.openedAt) return { days, day: existing };
    const day: TillDay = { ...(existing || { date }), openedAt: now, openedBy: staff, floatConfirmed: true };
    return { days: [day, ...days.filter((d) => d.date !== date)], day };
  }
  if (body.action === "close") {
    const counted = Number(body.takingsCounted);
    if (!Number.isFinite(counted) || counted < 0) throw new Error("Enter the cash taken out");
    if (body.floatLeft !== true) throw new Error("Confirm the £50 float is left in the drawer");
    // Someone else already closed today: nothing to change, hand it back.
    if (existing?.closedAt) return { days, day: existing };
    const cashSales = cashSalesFor(sales, date);
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
    const day: TillDay = {
      ...(existing || { date }),
      closedAt: now,
      closedBy: staff,
      cashSales,
      takingsCounted: round2(counted),
      difference: round2(counted - cashSales),
      floatLeft: true,
      ...(note ? { note } : {}),
    };
    return { days: [day, ...days.filter((d) => d.date !== date)], day };
  }
  throw new Error("Unknown action");
}

const KEEP_DAYS = 400;
const trim = (days: TillDay[]) => days.sort((a, b) => b.date.localeCompare(a.date)).slice(0, KEEP_DAYS);

export async function POST(request: Request) {
  if (!(await verifyStaffSession(request))) return Response.json({ error: "Unauthorised" }, { status: 401 });
  const staff = await staffFromSession(request);
  try {
    const body = await request.json() as Body;
    try {
      const { db, ready } = getStore();
      await ready;
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        const locked = await client.query("SELECT key, value FROM store_state WHERE key IN ('till_days', 'sales') FOR UPDATE");
        const state = Object.fromEntries(locked.rows.map((row: { key: unknown; value: unknown }) => [String(row.key), row.value]));
        const result = apply(Array.isArray(state.till_days) ? state.till_days as TillDay[] : [], Array.isArray(state.sales) ? state.sales as Sale[] : [], body, staff);
        await client.query(
          "INSERT INTO store_state (key, value, updated_at) VALUES ('till_days', $1::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
          [JSON.stringify(trim(result.days))],
        );
        await client.query("COMMIT");
        return Response.json({ data: { day: result.day, days: trim(result.days) } });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      if (process.env.NODE_ENV !== "development") throw error;
      if (error instanceof Error && !/connection|configured|database/i.test(error.message)) throw error;
      const result = await mutateLocalState((state) => {
        const r = apply(Array.isArray(state.till_days) ? state.till_days as TillDay[] : [], Array.isArray(state.sales) ? state.sales as Sale[] : [], body, staff);
        return { state: { ...state, till_days: trim(r.days) }, result: r };
      });
      return Response.json({ data: { day: result.day, days: trim(result.days) }, local: true });
    }
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not save" }, { status: 400 });
  }
}
