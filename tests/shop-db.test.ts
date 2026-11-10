/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import test, { before } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createStaffSession } from "../app/api/session/auth";
import * as stateRoute from "../app/api/state/route";
import * as revisionRoute from "../app/api/state/revision/route";
import * as saleRoute from "../app/api/state/sale/route";
import * as refundRoute from "../app/api/state/refund/route";
import * as stockRoute from "../app/api/state/stock/route";
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
const stockOf = async (id: string) => (await json(await stateRoute.GET(req("GET", "/api/state?keys=products")))).data.products.find((p: any) => p.id === id).stock;
const getProducts = async () => (await json(await stateRoute.GET(req("GET", "/api/state?keys=products")))).data.products as any[];
const revNow = async () => (await json(await revisionRoute.GET(req("GET", "/api/state/revision")))).rev as number;

// catchUpFrom: the sales-since date for the one-time stock catch-up. Off (null)
// for ordinary tests so they start from the stock numbers they set up.
async function freshShop(extraSales: Record<string, unknown>[] = [], catchUpFrom: string | null = null) {
  (globalThis as { __aliceStockOffFrom?: string | null }).__aliceStockOffFrom = catchUpFrom;
  pg = new PGlite();
  await pg.exec(`CREATE TABLE store_state (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  const legacy = {
    products: products(),
    sales: [
      { id: "old-1", at: hoursAgo(24 * 60), items: [{ id: "p1", quantity: 1 }], total: 1, method: "Card" },
      { id: "old-2", at: hoursAgo(5), items: [{ id: "p1", quantity: 2 }], total: 2, method: "Cash" },
      ...extraSales,
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
  assert.equal(first.data.stock_log.length, 1);
  assert.equal(first.data.daily_checks.length, 1);
  // The old rows are still there, and a second start-up does not copy again.
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

test("a sale moves stock, logs it, and a retry changes nothing", async () => {
  await freshShop();
  const before = await revNow();
  const body = sale("s1", [{ id: "p1", quantity: 3 }, { id: "p3", quantity: 4 }]);
  const first = await json(await saleRoute.POST(req("POST", "/api/state/sale", body)));
  assert.equal(first.data.products.find((p: any) => p.id === "p1").stock, 7);
  assert.equal(first.data.products.find((p: any) => p.id === "p3").stock, 0, "uncounted items never move");
  assert.equal(first.data.sales[0].id, "s1");
  assert.equal(await revNow(), before + 1);
  const retry = await saleRoute.POST(req("POST", "/api/state/sale", body));
  assert.equal(retry.status, 200);
  assert.equal(await stockOf("p1"), 7, "same sale id sent twice sells once");
  assert.equal(await revNow(), before + 1, "a no-op retry does not signal a change");
  const log = (await json(await stateRoute.GET(req("GET", "/api/state?keys=stock_log")))).data.stock_log;
  assert.equal(log.filter((m: any) => m.reason === "sale").length, 2, "old entry + exactly one new one");
});

test("selling past zero never refuses, goes negative and flags a recount", async () => {
  await freshShop();
  const result = await json(await saleRoute.POST(req("POST", "/api/state/sale", sale("s2", [{ id: "p2", quantity: 5 }]))));
  const coffee = result.data.products.find((p: any) => p.id === "p2");
  assert.equal(coffee.stock, -3);
  assert.equal(coffee.recount, true);
});

test("twenty simultaneous sales, and five copies of one sale, stay exact", async () => {
  await freshShop();
  await stockRoute.POST(req("POST", "/api/state/stock", { changes: [{ id: "p1", set: 100 }], reason: "count" }));
  const many = await Promise.all(Array.from({ length: 20 }, (_, i) => saleRoute.POST(req("POST", "/api/state/sale", sale(`par-${i}`, [{ id: "p1", quantity: 1 }])))));
  assert.ok(many.every((r) => r.status === 200));
  assert.equal(await stockOf("p1"), 80);
  const same = sale("dup", [{ id: "p1", quantity: 1 }]);
  await Promise.all(Array.from({ length: 5 }, () => saleRoute.POST(req("POST", "/api/state/sale", same))));
  assert.equal(await stockOf("p1"), 79);
});

test("a refund restocks once, even when tapped twice", async () => {
  await freshShop();
  await saleRoute.POST(req("POST", "/api/state/sale", sale("r1", [{ id: "p1", quantity: 4 }])));
  assert.equal(await stockOf("p1"), 6);
  const first = await json(await refundRoute.POST(req("POST", "/api/state/refund", { saleId: "r1" })));
  assert.equal(first.data.sales.find((s: any) => s.id === "r1").refunded, true);
  assert.equal(await stockOf("p1"), 10);
  await refundRoute.POST(req("POST", "/api/state/refund", { saleId: "r1" }));
  assert.equal(await stockOf("p1"), 10);
  const missing = await refundRoute.POST(req("POST", "/api/state/refund", { saleId: "nope" }));
  assert.equal(missing.status, 409);
});

test("stock changes use the server's own number, not a stale screen", async () => {
  await freshShop();
  await saleRoute.POST(req("POST", "/api/state/sale", sale("k1", [{ id: "p1", quantity: 3 }])));
  const added = await json(await stockRoute.POST(req("POST", "/api/state/stock", { changes: [{ id: "p1", delta: 5 }, { id: "ghost", delta: 1 }], reason: "restock" })));
  assert.equal(added.data.products.find((p: any) => p.id === "p1").stock, 12);
  assert.deepEqual(added.data.missing, ["ghost"]);
  const counted = await json(await stockRoute.POST(req("POST", "/api/state/stock", { changes: [{ id: "p2", set: 6 }] })));
  assert.equal(counted.data.products.find((p: any) => p.id === "p2").stock, 6);
  const bad = await stockRoute.POST(req("POST", "/api/state/stock", { changes: [{ id: "p1" }] }));
  assert.equal(bad.status, 400);
});

test("products: add, edit ignores a stale stock number, delete is logged", async () => {
  await freshShop();
  const created = await json(await productRoute.POST(req("POST", "/api/state/product", { product: { id: "p9", name: "Milk", stock: 4, price: 1 } })));
  assert.deepEqual(created.data.products.map((p: any) => p.id), ["p1", "p2", "p3", "p9"], "new products go on the end");
  await saleRoute.POST(req("POST", "/api/state/sale", sale("e1", [{ id: "p9", quantity: 1 }])));
  const edited = await json(await productRoute.POST(req("POST", "/api/state/product", { product: { id: "p9", name: "Oat milk", stock: 4, price: 2 } })));
  const milk = edited.data.products.find((p: any) => p.id === "p9");
  assert.equal(milk.name, "Oat milk");
  assert.equal(milk.stock, 3, "the stale 4 is ignored");
  const gone = await json(await productRoute.DELETE(req("DELETE", "/api/state/product", { id: "p9" })));
  assert.equal(gone.data.products.some((p: any) => p.id === "p9"), false);
  const log = (await json(await stateRoute.GET(req("GET", "/api/state?keys=stock_log")))).data.stock_log;
  assert.ok(log.some((m: any) => m.reason === "delete" && m.productId === "p9"));
});

test("the change counter moves on every kind of write, and only then", async () => {
  await freshShop();
  const a = await revNow();
  assert.equal(await revNow(), a);
  await stateRoute.PUT(req("PUT", "/api/state", { data: { settings: { targetMargin: 30 } } }));
  const b = await revNow();
  assert.ok(b > a);
  await stockRoute.POST(req("POST", "/api/state/stock", { changes: [{ id: "p1", delta: 1 }] }));
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
});

test("catch-up: sales made while stock was off come off the counts once, and only once", async () => {
  await freshShop([
    { id: "gap-1", at: hoursAgo(4), staff: "Sam", items: [{ id: "p1", quantity: 3 }, { id: "p3", quantity: 2 }], total: 3, method: "Cash" },
    { id: "gap-2", at: hoursAgo(3), staff: "Sam", items: [{ id: "p2", quantity: 5 }], total: 10, method: "Card" },
    { id: "gap-3", at: hoursAgo(2), staff: "Sam", items: [{ id: "p1", quantity: 1 }], total: 1, method: "Cash", refunded: true },
    { id: "gap-4", at: hoursAgo(1), staff: "Sam", items: [{ id: "p1", quantity: 1 }], total: 1, method: "Waste", stockOnly: true },
    { id: "gap-5", at: hoursAgo(1), staff: "Sam", items: [{ id: "yodeyma-order", quantity: 1 }], total: 9, method: "Cash" },
  ], hoursAgo(5.5));
  const stock = async () => Object.fromEntries((await getProducts()).map((p: any) => [p.id, [p.stock, p.recount ?? false]]));
  // old-1 (60 days ago) is before the window; old-2 (5h ago) and gap-1..5 are inside it, refunded gap-3 skipped.
  assert.deepEqual(await stock(), { p1: [10 - 2 - 3 - 1, false], p2: [2 - 5, true], p3: [0, false] });
  const log = (await json(await stateRoute.GET(req("GET", "/api/state?keys=stock_log")))).data.stock_log;
  assert.ok(log.some((m: any) => m.reason === "waste" && m.productId === "p1" && m.staff === "Sam"));
  assert.ok(log.some((m: any) => m.reason === "sale" && m.productId === "p2" && m.from === 2 && m.to === -3));
  // A second start-up (a new server instance) must not take it off again.
  resetStoreForTests();
  await stateRoute.GET(req("GET", "/api/state?keys=products"));
  assert.deepEqual(await stock(), { p1: [4, false], p2: [-3, true], p3: [0, false] });
  // And an ordinary sale afterwards behaves normally.
  await saleRoute.POST(req("POST", "/api/state/sale", sale("after", [{ id: "p1", quantity: 1 }])));
  assert.equal((await stock()).p1[0], 3);
});

test("catch-up does nothing when there is nothing to catch up", async () => {
  await freshShop([], hoursAgo(1));
  assert.deepEqual((await getProducts()).map((p: any) => p.stock), [10, 2, 0]);
});
