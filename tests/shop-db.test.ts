/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import test, { before } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createStaffSession } from "../app/api/session/auth";
import * as stateRoute from "../app/api/state/route";
import * as revisionRoute from "../app/api/state/revision/route";
import * as saleRoute from "../app/api/state/sale/route";
import * as refundRoute from "../app/api/state/refund/route";
import * as productRoute from "../app/api/state/product/route";
import * as tillRoute from "../app/api/state/till-day/route";
import { resetStoreForTests } from "../app/api/store";

// Runs the real route handlers against a real (in-memory) Postgres. One
// connection means two "transactions" would interleave, so connect() hands the
// connection out one holder at a time - this proves the logic and the SQL, not
// Postgres row-lock behaviour under true parallelism.

let pg: PGlite;
let cookie = "";
let gate: Promise<void> = Promise.resolve();

function install(db: PGlite) {
  const pool = {
    query: (sql: string, params?: unknown[]) => db.query(sql, params as never[]),
    connect: async () => {
      let release!: () => void;
      const mine = new Promise<void>((resolve) => { release = resolve; });
      const wait = gate;
      gate = gate.then(() => mine);
      await wait;
      return { query: (sql: string, params?: unknown[]) => db.query(sql, params as never[]), release };
    },
  };
  (globalThis as { __aliceTestDb?: unknown }).__aliceTestDb = { pool };
  resetStoreForTests();
}

const req = (method: string, url: string, body?: unknown) =>
  new Request(`http://localhost${url}`, { method, headers: { cookie: `alice-staff-session=${cookie}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (response: Response) => response.json() as Promise<any>;
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

const products = () => [
  { id: "p1", name: "Tea", stock: 10, price: 1 },
  { id: "p2", name: "Coffee", stock: 2, price: 2 },
  { id: "p3", name: "Bananas", stock: 0, price: 1, noStockCount: true },
];
const sale = (id: string, items: { id: string; quantity: number }[], extra: Record<string, unknown> = {}) => ({
  sale: { id, at: new Date().toISOString(), staff: "Test", method: "Cash", total: 3, items, ...extra },
  items,
});
const getProducts = async () => (await json(await stateRoute.GET(req("GET", "/api/state?keys=products")))).data.products as any[];
const getSales = async (days = "all") => (await json(await stateRoute.GET(req("GET", `/api/state?keys=sales&salesDays=${days}`)))).data.sales as any[];
const revNow = async () => (await json(await revisionRoute.GET(req("GET", "/api/state/revision")))).rev as number;

async function freshShop() {
  pg = new PGlite();
  await pg.exec(`CREATE TABLE store_state (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  const legacy = {
    products: products(),
    sales: [
      { id: "old-1", at: hoursAgo(24 * 60), items: [{ id: "p1", quantity: 1 }], total: 1, method: "Card" },
      { id: "old-2", at: hoursAgo(5), items: [{ id: "p1", quantity: 2 }], total: 2, method: "Cash" },
    ],
    stock_log: [{ id: "m1", at: hoursAgo(5), staff: "A", productId: "p1", product: "Tea", from: 12, to: 10, reason: "sale" }],
    daily_checks: [{ id: "c1", at: hoursAgo(3) }],
  };
  for (const [key, value] of Object.entries(legacy)) await pg.query("INSERT INTO store_state (key, value) VALUES ($1, $2::jsonb)", [key, JSON.stringify(value)]);
  install(pg);
}

before(async () => { cookie = await createStaffSession("Test"); });

test("migration copies the old lists once and keeps the backup", async () => {
  await freshShop();
  const first = await json(await stateRoute.GET(req("GET", "/api/state?keys=products,sales,stock_log,daily_checks&salesDays=all")));
  assert.deepEqual(first.data.products.map((p: any) => p.id), ["p1", "p2", "p3"]);
  assert.deepEqual(first.data.sales.map((s: any) => s.id), ["old-2", "old-1"]);
  assert.equal(first.data.stock_log.length, 1, "the old stock log is kept, just not shown");
  assert.equal(first.data.daily_checks.length, 1);
  resetStoreForTests();
  await stateRoute.GET(req("GET", "/api/state?keys=products"));
  const counts = await pg.query("SELECT (SELECT count(*) FROM shop_products)::int AS p, (SELECT count(*) FROM shop_sales)::int AS s, (SELECT count(*) FROM store_state WHERE key = 'products')::int AS legacy");
  assert.deepEqual(counts.rows[0], { p: 3, s: 2, legacy: 1 });
});

test("the sales window hides old sales unless asked", async () => {
  await freshShop();
  const recent = await json(await stateRoute.GET(req("GET", "/api/state?keys=sales")));
  assert.deepEqual(recent.data.sales.map((s: any) => s.id), ["old-2"]);
});

test("a sale is recorded without touching any product, and a retry changes nothing", async () => {
  await freshShop();
  const before = await revNow();
  const body = sale("s1", [{ id: "p1", quantity: 3 }, { id: "p3", quantity: 4 }]);
  const first = await json(await saleRoute.POST(req("POST", "/api/state/sale", body)));
  assert.equal(first.data.sales[0].id, "s1");
  assert.deepEqual(await getProducts(), products(), "products are exactly as they were");
  assert.equal(await revNow(), before + 1);
  const retry = await saleRoute.POST(req("POST", "/api/state/sale", body));
  assert.equal(retry.status, 200);
  assert.equal((await getSales()).filter((s) => s.id === "s1").length, 1, "same sale id sent twice records once");
  assert.equal(await revNow(), before + 1, "a no-op retry does not signal a change");
});

test("a sale for a product that no longer exists, or a payment line, still records", async () => {
  await freshShop();
  const r = await saleRoute.POST(req("POST", "/api/state/sale", sale("y1", [{ id: "yodeyma-order", quantity: 1 }, { id: "deleted-product", quantity: 2 }])));
  assert.equal(r.status, 200);
  assert.ok((await getSales()).some((s) => s.id === "y1"));
  const bad = await saleRoute.POST(req("POST", "/api/state/sale", { sale: { id: "bad", at: new Date().toISOString() }, items: [{ id: "p1", quantity: 0 }] }));
  assert.equal(bad.status, 409);
  const empty = await saleRoute.POST(req("POST", "/api/state/sale", { sale: { id: "empty" }, items: [] }));
  assert.equal(empty.status, 400);
});

test("twenty simultaneous sales, and five copies of one sale, stay exact", async () => {
  await freshShop();
  const many = await Promise.all(Array.from({ length: 20 }, (_, i) => saleRoute.POST(req("POST", "/api/state/sale", sale(`par-${i}`, [{ id: "p1", quantity: 1 }])))));
  assert.ok(many.every((r) => r.status === 200));
  const same = sale("dup", [{ id: "p1", quantity: 1 }]);
  await Promise.all(Array.from({ length: 5 }, () => saleRoute.POST(req("POST", "/api/state/sale", same))));
  const all = await getSales();
  assert.equal(all.filter((s) => s.id.startsWith("par-")).length, 20);
  assert.equal(all.filter((s) => s.id === "dup").length, 1);
});

test("a refund marks the sale once, even when tapped twice, and moves nothing else", async () => {
  await freshShop();
  await saleRoute.POST(req("POST", "/api/state/sale", sale("r1", [{ id: "p1", quantity: 4 }])));
  const first = await json(await refundRoute.POST(req("POST", "/api/state/refund", { saleId: "r1" })));
  assert.equal(first.data.sales.find((s: any) => s.id === "r1").refunded, true);
  const revAfterFirst = await revNow();
  await refundRoute.POST(req("POST", "/api/state/refund", { saleId: "r1" }));
  assert.equal(await revNow(), revAfterFirst, "second tap changes nothing");
  assert.deepEqual(await getProducts(), products());
  const missing = await refundRoute.POST(req("POST", "/api/state/refund", { saleId: "nope" }));
  assert.equal(missing.status, 409);
});

test("products: add goes on the end, edit saves what was sent, delete removes only that one", async () => {
  await freshShop();
  const created = await json(await productRoute.POST(req("POST", "/api/state/product", { product: { id: "p9", name: "Milk", price: 1 } })));
  assert.deepEqual(created.data.products.map((p: any) => p.id), ["p1", "p2", "p3", "p9"]);
  const edited = await json(await productRoute.POST(req("POST", "/api/state/product", { product: { id: "p9", name: "Oat milk", price: 2.5, barcode: "123456" } })));
  const milk = edited.data.products.find((p: any) => p.id === "p9");
  assert.deepEqual([milk.name, milk.price, milk.barcode], ["Oat milk", 2.5, "123456"]);
  assert.equal(edited.data.products.find((p: any) => p.id === "p1").price, 1, "other products untouched");
  const bad = await productRoute.POST(req("POST", "/api/state/product", { product: { id: "x" } }));
  assert.equal(bad.status, 400);
  const gone = await json(await productRoute.DELETE(req("DELETE", "/api/state/product", { id: "p9" })));
  assert.deepEqual(gone.data.products.map((p: any) => p.id), ["p1", "p2", "p3"]);
});

test("the change counter moves on every kind of write, and only then", async () => {
  await freshShop();
  const a = await revNow();
  assert.equal(await revNow(), a);
  await stateRoute.PUT(req("PUT", "/api/state", { data: { settings: { targetMargin: 30 } } }));
  const b = await revNow();
  assert.ok(b > a);
  await productRoute.POST(req("POST", "/api/state/product", { product: { id: "p1", name: "Tea", price: 1.2 } }));
  assert.ok((await revNow()) > b);
  const refused = await stateRoute.PUT(req("PUT", "/api/state", { data: { products: [] } }));
  assert.equal(refused.status, 400);
  const sys = await stateRoute.PUT(req("PUT", "/api/state", { data: { sys_migrated_rows_v1: 1 } }));
  assert.equal(sys.status, 400);
});

test("asking for one key sends only that key, with the counter read first", async () => {
  await freshShop();
  const result = await json(await stateRoute.GET(req("GET", "/api/state?keys=daily_checks")));
  assert.deepEqual(Object.keys(result.data), ["daily_checks"]);
  assert.equal(typeof result.rev, "number");
  const none = await json(await stateRoute.GET(req("GET", "/api/state?keys=till_days")));
  assert.deepEqual(none.data, {});
  const def = await json(await stateRoute.GET(req("GET", "/api/state")));
  assert.ok(def.data.products && def.data.sales && def.data.daily_checks);
  assert.equal(def.data.stock_log, undefined);
  assert.equal(def.data.sys_migrated_rows_v1, undefined);
});

test("shop day: cash is worked out from the server's own sales", async () => {
  await freshShop();
  await revNow(); // starts the shop up (creates the tables)
  await pg.query("DELETE FROM shop_sales");
  await saleRoute.POST(req("POST", "/api/state/sale", sale("c1", [{ id: "p1", quantity: 1 }], { method: "Cash", total: 4.5 })));
  await saleRoute.POST(req("POST", "/api/state/sale", sale("c2", [{ id: "p1", quantity: 1 }], { method: "Card", total: 9 })));
  const opened = await json(await tillRoute.POST(req("POST", "/api/state/till-day", { action: "open" })));
  assert.equal(opened.data.day.floatConfirmed, true);
  const closed = await json(await tillRoute.POST(req("POST", "/api/state/till-day", { action: "close", takingsCounted: 4.5, floatLeft: true })));
  assert.equal(closed.data.day.cashSales, 4.5);
  assert.equal(closed.data.day.difference, 0);
});

test("signed-out requests are refused everywhere", async () => {
  await freshShop();
  const bare = (method: string, url: string) => new Request(`http://localhost${url}`, { method });
  assert.equal((await stateRoute.GET(bare("GET", "/api/state"))).status, 401);
  assert.equal((await revisionRoute.GET(bare("GET", "/api/state/revision"))).status, 401);
  assert.equal((await saleRoute.POST(bare("POST", "/api/state/sale"))).status, 401);
  assert.equal((await refundRoute.POST(bare("POST", "/api/state/refund"))).status, 401);
  assert.equal((await productRoute.POST(bare("POST", "/api/state/product"))).status, 401);
});
