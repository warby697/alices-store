import { verifyStaffSession } from "../../session/auth";
import { readRev } from "../../shop-db";
import { getStore } from "../../store";

export const dynamic = "force-dynamic";

// A few bytes: just the shop's change counter, so a till can check "has
// anything changed?" without downloading the shop. In development (the file
// store) there is no counter, so rev is null and the till always re-reads.
export async function GET(request: Request) {
  if (!(await verifyStaffSession(request))) return Response.json({ error: "Unauthorised" }, { status: 401 });
  if (process.env.NODE_ENV === "development") return Response.json({ rev: null });
  try {
    const { db, ready } = getStore();
    await ready;
    return Response.json({ rev: await readRev(db.pool) });
  } catch (error) {
    console.error("Revision read failed", error);
    return Response.json({ rev: null }, { status: 503 });
  }
}
