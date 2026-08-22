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
export async function saveProductNow(product: Record<string, unknown>) {
  const response = await fetch("/api/state/product", {
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

export function readCachedCatalogue(): { products: unknown[]; shop_layout: unknown } | null {
  try {
    const raw = localStorage.getItem(CATALOGUE_CACHE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { products?: unknown[]; shop_layout?: unknown };
    if (!Array.isArray(parsed.products) || !parsed.products.length) return null;
    return { products: parsed.products, shop_layout: parsed.shop_layout };
  } catch {
    return null;
  }
}

export function writeCachedCatalogue(products: unknown, shopLayout: unknown) {
  if (!Array.isArray(products) || !products.length) return;
  try {
    localStorage.setItem(CATALOGUE_CACHE, JSON.stringify({ products, shop_layout: shopLayout }));
  } catch {
    // A full or disabled store just means no head start next time.
  }
}
