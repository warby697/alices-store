import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { verifyStaffSession } from "../session/auth";
import { getStore } from "../store";

export const dynamic = "force-dynamic";

const localStateFile = join(process.cwd(), ".local", "store-state.json");

async function readLocalState(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(localStateFile, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writeLocalState(update: Record<string, unknown>) {
  const current = await readLocalState();
  await mkdir(dirname(localStateFile), { recursive: true });
  await writeFile(localStateFile, `${JSON.stringify({ ...current, ...update }, null, 2)}\n`, "utf8");
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
    const { db, ready } = getStore();
    await ready;
    for (const [key, value] of entries) {
      if (!/^[a-z][a-z0-9_-]{1,40}$/.test(key)) return Response.json({ error: "Invalid state key" }, { status: 400 });
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
