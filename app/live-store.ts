export async function loadLiveState(): Promise<Record<string, unknown>> {
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) return {};
    const body = await response.json() as { data?: Record<string, unknown> };
    return body.data || {};
  } catch { return {}; }
}

export type SaleMutation = {
  sale: Record<string, unknown>;
  items: { id: string; quantity: number }[];
};

export async function completeLiveSale(mutation: SaleMutation) {
  const response = await fetch("/api/state/sale", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(mutation),
  });
  const body = await response.json() as {
    data?: Record<string, unknown>;
    error?: string;
  };
  if (!response.ok || !body.data) {
    throw new Error(body.error || "The sale could not be saved");
  }
  return body.data;
}

// Save a single product safely. The server merges it into the current
// catalogue inside a locked transaction, so simultaneous edits from other
// tablets are never overwritten. Returns the up-to-date product list.
//
// The server deliberately IGNORES the stock number sent inside `product` for
// a product that already exists - the shop floor's live count must never be
// replaced by whatever an old screen remembered. To change stock on purpose,
// pass the second argument: { delta: +3 } adds three, { set: 6 } records a
// counted six. Both are applied to the server's own current number.
export type StockChange = { delta?: number; set?: number };

// `reason` names the stock change in the movement log ("edit", "count"...);
// it only matters when a stock change is sent alongside the product.
export async function saveProductNow(product: Record<string, unknown>, stock?: StockChange, reason?: string) {
  const response = await fetch("/api/state/product", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ product, stock, reason }),
  });
  const body = await response.json().catch(() => ({})) as {
    data?: { products?: Record<string, unknown>[] };
    error?: string;
  };
  if (!response.ok || !body.data?.products) {
    throw new Error(body.error || "The product could not be saved");
  }
  return body.data.products;
}

export async function deleteProductNow(id: string) {
  const response = await fetch("/api/state/product", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
  const body = await response.json().catch(() => ({})) as {
    data?: { products?: Record<string, unknown>[] };
    error?: string;
  };
  if (!response.ok || !body.data?.products) {
    throw new Error(body.error || "The product could not be deleted");
  }
  return body.data.products;
}

// Change stock levels for one or more products in a single locked transaction.
// Each change is either { delta } (add or remove that many) or { set } (a
// counted number). The server applies them to its own current figures, so a
// stale screen can never drag the numbers backwards. Returns the fresh product
// list, plus the ids of any products that no longer exist.
// opts.keepRecount: leave any "needs a shelf recount" flags in place - only
// the shopping trip's automatic trolley deltas use it, because nobody counted
// a shelf. Everything else clears the flag: adjusting stock IS the recount.
// opts.reason names the change in the stock movement log ("restock", "trip",
// "count"...); the server records who and when from the session itself.
export async function adjustStockNow(changes: { id: string; delta?: number; set?: number }[], opts?: { keepRecount?: boolean; reason?: string }) {
  const response = await fetch("/api/state/stock", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      changes: opts?.keepRecount ? changes.map((change) => ({ ...change, keepRecount: true })) : changes,
      reason: opts?.reason,
    }),
  });
  const body = await response.json().catch(() => ({})) as {
    data?: { products?: Record<string, unknown>[]; missing?: string[] };
    error?: string;
  };
  if (!response.ok || !body.data?.products) {
    throw new Error(body.error || "The stock change could not be saved");
  }
  return body.data as { products: Record<string, unknown>[]; missing: string[] };
}

// Refund a sale on the server: it marks its own copy of the sale as refunded
// and puts the items back into its own stock count, all in one locked
// transaction. Returns the fresh product and sales lists.
export async function refundSaleNow(saleId: string) {
  const response = await fetch("/api/state/refund", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ saleId }),
  });
  const body = await response.json().catch(() => ({})) as {
    data?: { products?: Record<string, unknown>[]; sales?: Record<string, unknown>[] };
    error?: string;
  };
  if (!response.ok || !body.data?.products || !body.data.sales) {
    throw new Error(body.error || "The refund could not be saved");
  }
  return body.data as { products: Record<string, unknown>[]; sales: Record<string, unknown>[] };
}

// Opening ("open": £50 float confirmed) or closing ("close": takings counted,
// float left) today's shop. The server works out the day's cash sales itself
// and returns the updated list of shop days.
export async function tillDayNow(action: "open" | "close", details: { takingsCounted?: number; floatLeft?: boolean; note?: string } = {}) {
  const response = await fetch("/api/state/till-day", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...details }),
  });
  const body = await response.json().catch(() => ({})) as { data?: { day?: Record<string, unknown>; days?: Record<string, unknown>[] }; error?: string };
  if (!response.ok || !body.data?.days) throw new Error(body.error || "Could not save - please try again");
  return body.data as { day: Record<string, unknown>; days: Record<string, unknown>[] };
}

export async function saveLiveStateNow(data: Record<string, unknown>) {
  const response = await fetch("/api/state", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data }),
  });
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) {
    throw new Error(body.error || "The change could not be saved");
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
let pending: Record<string, unknown> = {};

export function saveLiveState(data: Record<string, unknown>) {
  pending = { ...pending, ...data };
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const payload = pending; pending = {};
    try { await fetch("/api/state", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: payload }) }); } catch { pending = { ...payload, ...pending }; }
  }, 500);
}

// The catalogue is the big, slow-moving part of the payload and it is what the
// screen is empty without. Keeping the last copy on the device lets the till
// open showing stock immediately, then quietly correct itself once the server
// answers. Deliberately NOT cached: sales and cash, which are transaction
// records and have no business sitting in a browser store after sign-out.
const CATALOGUE_CACHE = "alices-store.catalogue.v1";

export function readCachedCatalogue(): { products: unknown[] } | null {
  try {
    const raw = localStorage.getItem(CATALOGUE_CACHE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { products?: unknown[] };
    if (!Array.isArray(parsed.products) || !parsed.products.length) return null;
    return { products: parsed.products };
  } catch {
    return null;
  }
}

export function writeCachedCatalogue(products: unknown) {
  if (!Array.isArray(products) || !products.length) return;
  try {
    localStorage.setItem(CATALOGUE_CACHE, JSON.stringify({ products }));
  } catch {
    // A full or disabled store just means no head start next time.
  }
}
