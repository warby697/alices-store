// Sign-ins last 12 hours. A tablet left on longer still shows the till, but
// the server refuses every save - so any refusal tells the screen to ask for
// a PIN again (over the top of whatever is open, so nothing typed is lost),
// and the message says what to do instead of "Unauthorised".
export const SESSION_EXPIRED_EVENT = "alices-store:signed-out";
export const SESSION_RESTORED_EVENT = "alices-store:signed-in";
async function apiFetch(input: string, init?: RequestInit) {
  const response = await fetch(input, init);
  if (response.status !== 401) return response;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  return new Response(JSON.stringify({ error: "Your sign-in has run out - enter your PIN, then press save again" }), { status: 401, headers: { "content-type": "application/json" } });
}

// Reads the shop from the server. Ask for just the parts you need by name
// (e.g. ["daily_checks"]); with no keys you get what the till screen uses
// (products, the last 45 days of sales, and the small settings values).
// {} means the server could not be reached; a reachable server with nothing
// stored yet answers { _loaded: true } so the two can be told apart.
// `rev` is the shop's change counter as it was just BEFORE this read.
export async function loadLive(keys?: string[], opts?: { salesDays?: number | "all" }): Promise<{ data: Record<string, unknown>; rev: number | null }> {
  try {
    const params = new URLSearchParams();
    if (keys?.length) params.set("keys", keys.join(","));
    if (opts?.salesDays !== undefined) params.set("salesDays", String(opts.salesDays));
    const query = params.toString();
    const response = await apiFetch(`/api/state${query ? `?${query}` : ""}`, { cache: "no-store" });
    if (!response.ok) return { data: {}, rev: null };
    const body = await response.json() as { data?: Record<string, unknown>; rev?: number | null };
    const data = body.data || {};
    return { data: Object.keys(data).length ? data : { _loaded: true }, rev: typeof body.rev === "number" ? body.rev : null };
  } catch { return { data: {}, rev: null }; }
}

export async function loadLiveState(keys?: string[], opts?: { salesDays?: number | "all" }): Promise<Record<string, unknown>> {
  return (await loadLive(keys, opts)).data;
}

// Has anything changed since the last read? A few bytes instead of the whole
// shop. ok:false means unreachable; rev:null means the server keeps no counter
// (development), so the caller should just read everything.
export async function fetchRevision(): Promise<{ ok: boolean; rev: number | null }> {
  try {
    const response = await apiFetch("/api/state/revision", { cache: "no-store" });
    if (!response.ok) return { ok: false, rev: null };
    const body = await response.json() as { rev?: number | null };
    return { ok: true, rev: typeof body.rev === "number" ? body.rev : null };
  } catch { return { ok: false, rev: null }; }
}

export type SaleMutation = {
  sale: Record<string, unknown>;
  items: { id: string; quantity: number }[];
};

// A sale must never be lost. Every sale is written to this tablet's own
// storage BEFORE it is sent, and only removed once the server has it. If the
// send fails for any reason (signed out, no signal, server down) the sale
// stays here and is sent again automatically - every few seconds, and the
// moment someone signs back in. The server ignores a sale it already has (same
// id), so sending one twice can never double it.
const UNSENT_SALES = "alices-store.unsent-sales.v1";
export const UNSENT_SALES_EVENT = "alices-store:unsent-sales";

export function readUnsentSales(): SaleMutation[] {
  try {
    const saved = JSON.parse(localStorage.getItem(UNSENT_SALES) || "[]");
    return Array.isArray(saved) ? saved as SaleMutation[] : [];
  } catch { return []; }
}
function writeUnsentSales(list: SaleMutation[]) {
  try { localStorage.setItem(UNSENT_SALES, JSON.stringify(list)); } catch { /* storage blocked */ }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(UNSENT_SALES_EVENT));
}
const saleId = (m: SaleMutation) => String(m.sale.id);

async function sendSale(mutation: SaleMutation) {
  const response = await apiFetch("/api/state/sale", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(mutation),
  });
  const body = await response.json().catch(() => ({})) as { data?: Record<string, unknown>; error?: string };
  return { status: response.status, ok: response.ok && Boolean(body.data), data: body.data, error: body.error };
}

// Returns the server's fresh lists when it was saved straight away, or {} when
// it is waiting on this tablet to be sent (the screen keeps showing it).
export async function completeLiveSale(mutation: SaleMutation) {
  writeUnsentSales([...readUnsentSales().filter((m) => saleId(m) !== saleId(mutation)), mutation]);
  let result: Awaited<ReturnType<typeof sendSale>>;
  try { result = await sendSale(mutation); } catch { return {} as Record<string, unknown>; }
  if (result.ok) {
    writeUnsentSales(readUnsentSales().filter((m) => saleId(m) !== saleId(mutation)));
    return result.data as Record<string, unknown>;
  }
  // Only a malformed sale (400) is given up on; everything else waits and retries.
  if (result.status === 400) {
    writeUnsentSales(readUnsentSales().filter((m) => saleId(m) !== saleId(mutation)));
    throw new Error(result.error || "The sale could not be saved");
  }
  return {} as Record<string, unknown>;
}

let flushing = false;
// Send every sale waiting on this tablet, oldest first. Stops at the first
// failure (still signed out, still offline) and tries again next time.
export async function flushUnsentSales() {
  if (flushing) return null;
  flushing = true;
  let latest: Record<string, unknown> | null = null;
  try {
    for (const mutation of readUnsentSales()) {
      let result: Awaited<ReturnType<typeof sendSale>>;
      try { result = await sendSale(mutation); } catch { break; }
      if (result.ok || result.status === 400) {
        writeUnsentSales(readUnsentSales().filter((m) => saleId(m) !== saleId(mutation)));
        if (result.ok) latest = result.data as Record<string, unknown>;
        continue;
      }
      // Signed out or server down: the rest will fail too, wait for next time.
      if (result.status === 401 || result.status >= 500) break;
    }
  } finally {
    flushing = false;
  }
  return latest;
}

// Save a single product safely. Its row is written on its own, so editing one
// product never touches another. Returns the up-to-date product list.
export async function saveProductNow(product: Record<string, unknown>) {
  const response = await apiFetch("/api/state/product", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ product }),
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
  const response = await apiFetch("/api/state/product", {
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

// Refund a sale on the server: it marks its own copy of the sale as refunded.
// Returns the fresh sales list.
export async function refundSaleNow(saleId: string) {
  const response = await apiFetch("/api/state/refund", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ saleId }),
  });
  const body = await response.json().catch(() => ({})) as {
    data?: { sales?: Record<string, unknown>[] };
    error?: string;
  };
  if (!response.ok || !body.data?.sales) {
    throw new Error(body.error || "The refund could not be saved");
  }
  return body.data as { sales: Record<string, unknown>[] };
}

// Opening ("open": £50 float confirmed) or closing ("close": takings counted,
// float left) today's shop. The server works out the day's cash sales itself
// and returns the updated list of shop days.
export async function tillDayNow(action: "open" | "close", details: { takingsCounted?: number; floatLeft?: boolean; note?: string } = {}) {
  const response = await apiFetch("/api/state/till-day", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...details }),
  });
  const body = await response.json().catch(() => ({})) as { data?: { day?: Record<string, unknown>; days?: Record<string, unknown>[] }; error?: string };
  if (!response.ok || !body.data?.days) throw new Error(body.error || "Could not save - please try again");
  return body.data as { day: Record<string, unknown>; days: Record<string, unknown>[] };
}

export async function saveLiveStateNow(data: Record<string, unknown>) {
  const response = await apiFetch("/api/state", {
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
    try {
      const response = await apiFetch("/api/state", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: payload }) });
      // Signed out: keep it, and it goes with the next save after the PIN.
      if (response.status === 401) pending = { ...payload, ...pending };
    } catch { pending = { ...payload, ...pending }; }
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
