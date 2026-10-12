// The stock movement log: every change to any product's count, recorded with
// who, when, what and why, so "is it staff error or system error?" has a
// factual answer instead of a guess. Built 22 Sep 2026 at the owner's request.
//
// One entry per product per change. "from" and "to" are the server's own
// numbers either side of the change - never a screen's memory of them.

export type Movement = {
  id: string;
  at: string;
  staff: string;
  productId: string;
  product: string;
  from: number;
  to: number;
  // sale | waste | perk | refund | restock | trip | count | edit | new
  reason: string;
};

// Keep four months, capped so the row can never grow without bound. At the
// shop's real volume (roughly 40 sales a day) this holds comfortably more
// than the window.
const KEEP_MS = 120 * 24 * 60 * 60 * 1000;
const KEEP_MAX = 6000;

export function appendMovements(existing: unknown, additions: Movement[]): Movement[] {
  const list = Array.isArray(existing) ? (existing as Movement[]) : [];
  const cutoff = Date.now() - KEEP_MS;
  return [...additions, ...list]
    .filter((entry) => new Date(entry.at).getTime() > cutoff)
    .slice(0, KEEP_MAX);
}

export function movement(
  staff: string,
  reason: string,
  product: { id: string; name?: unknown },
  from: number,
  to: number,
): Movement {
  return {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    staff: staff || "Unknown",
    productId: product.id,
    product: typeof product.name === "string" ? product.name : "",
    from,
    to,
    reason,
  };
}
