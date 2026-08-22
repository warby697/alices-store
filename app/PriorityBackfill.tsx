"use client";
import { useMemo, useRef, useState } from "react";
import { deleteProductNow, saveProductNow } from "./live-store";

type Product = {
  id: string; name: string; price: number; cost: number; stock: number; category: string;
  full?: number; lowStockLevel?: number; barcode?: string; caseBarcode?: string; caseQuantity?: number;
  colour: string; quick?: boolean; supplier?: string; size?: string; notes?: string;
  keyProduct?: boolean; stockConfirmed?: boolean; backfillSkipped?: boolean; tillSetupConfirmed?: boolean; discontinued?: boolean;
};

const baseSuppliers = ["Lidl", "Iceland", "Home Bargains", "Heron", "Bates", "Tesco", "Tomlins", "Yodeyma", "Costco"];
const money = (n: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(n);
const txt = (s?: string) => (s == null ? "" : String(s)).trim();

// The four completeness checks the backfill is chasing.
const gaps = (p: Product) => ({
  price: !(p.price > 0),
  cost: !(p.cost > 0),
  supplier: !txt(p.supplier),
  full: !(typeof p.full === "number" && p.full > 0),
});
const isComplete = (p: Product) => { if (p.discontinued) return true; const g = gaps(p); return !g.price && !g.cost && !g.supplier && !g.full; };
// A product with neither a barcode nor a till button can never reach the till.
const unsellable = (p: Product) => !txt(p.barcode) && !p.quick;

type FilterKey = "todo" | "all" | "price" | "cost" | "supplier" | "full" | "unsellable" | "done" | "dropped";

export function PriorityBackfill({
  products, setProducts, onExit,
}: {
  products: Product[];
  setProducts: React.Dispatch<React.SetStateAction<Product[]>>;
  onExit: () => void;
}) {
  const [filter, setFilter] = useState<FilterKey>("todo");
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, Partial<Product>>>({});
  const [showDupes, setShowDupes] = useState(true);
  const [addingSupplier, setAddingSupplier] = useState<string | null>(null);
  // Bulk supplier assignment: tick a batch, set them all in one go.
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [bulkSupplier, setBulkSupplier] = useState("");

  const supplierList = useMemo(() => {
    const used = products.map((p) => txt(p.supplier)).filter(Boolean);
    return Array.from(new Set([...baseSuppliers, ...used])).sort((a, b) => a.localeCompare(b));
  }, [products]);

  // Duplicate-barcode groups (same barcode on 2+ products).
  const dupeGroups = useMemo(() => {
    const by: Record<string, Product[]> = {};
    products.forEach((p) => { const b = txt(p.barcode); if (b) (by[b] = by[b] || []).push(p); });
    return Object.entries(by).filter(([, a]) => a.length > 1)
      .map(([barcode, items]) => ({ barcode, items }))
      .sort((a, b) => a.items[0].name.localeCompare(b.items[0].name));
  }, [products]);

  const counts = useMemo(() => {
    const c = { todo: 0, price: 0, cost: 0, supplier: 0, full: 0, unsellable: 0, done: 0, dropped: 0 };
    products.forEach((p) => {
      if (p.discontinued) { c.dropped++; c.done++; return; }
      const g = gaps(p);
      if (g.price) c.price++; if (g.cost) c.cost++; if (g.supplier) c.supplier++; if (g.full) c.full++;
      if (unsellable(p)) c.unsellable++;
      if (isComplete(p)) c.done++; else c.todo++;
    });
    return c;
  }, [products]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products
      .filter((p) => {
        if (q && ![p.name, p.category, p.supplier, p.barcode, p.size].some((v) => txt(v).toLowerCase().includes(q))) return false;
        const g = gaps(p);
        switch (filter) {
          case "all": return true;
          case "todo": return !isComplete(p) && !p.discontinued;
          case "price": return g.price;
          case "cost": return g.cost;
          case "supplier": return g.supplier;
          case "full": return g.full;
          case "unsellable": return unsellable(p);
          case "done": return isComplete(p);
          case "dropped": return Boolean(p.discontinued);
        }
      })
      .sort((a, b) => Number(isComplete(a)) - Number(isComplete(b)) || a.name.localeCompare(b.name));
  }, [products, filter, search]);

  const valOf = (p: Product, k: keyof Product) => (k in (pending[p.id] || {}) ? (pending[p.id] as Product)[k] : p[k]);
  const edit = (id: string, patch: Partial<Product>) => setPending((cur) => ({ ...cur, [id]: { ...cur[id], ...patch } }));

  const clearPending = (id: string) => setPending((cur) => { const c = { ...cur }; delete c[id]; return c; });

  // Refs kept current every render so the debounced stock save reads the latest
  // catalogue and buffered edits instead of a stale closure.
  const productsRef = useRef(products); productsRef.current = products;
  const pendingRef = useRef(pending); pendingRef.current = pending;
  const stockTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Current shown stock for a row (buffered value if mid-edit, else saved).
  const shownStock = (p: Product) => Number((pendingRef.current[p.id]?.stock ?? p.stock)) || 0;

  // Persist a stock change quietly (no row-dim), folding in any other buffered
  // edits for the row. Debounced so a burst of +/- taps becomes one save.
  const saveStock = (id: string) => {
    const p = productsRef.current.find((x) => x.id === id);
    const patch = pendingRef.current[id];
    if (!p || !patch || patch.stock === undefined || patch.stock === p.stock) { clearPending(id); return; }
    persist({ ...p, ...patch } as Product)
      .then(() => clearPending(id))
      .catch((err) => setNotice(err instanceof Error ? err.message : "Could not save stock"));
  };
  const scheduleStock = (id: string) => {
    clearTimeout(stockTimers.current[id]);
    stockTimers.current[id] = setTimeout(() => saveStock(id), 600);
  };
  const flushStock = (id: string) => { clearTimeout(stockTimers.current[id]); saveStock(id); };
  const adjustStock = (p: Product, delta: number) => {
    // Functional updater so rapid consecutive taps compound off each other
    // rather than all reading the same pre-render base value.
    setPending((cur) => {
      const base = Number(cur[p.id]?.stock ?? p.stock) || 0;
      return { ...cur, [p.id]: { ...cur[p.id], stock: Math.max(0, base + delta) } };
    });
    scheduleStock(p.id);
  };

  // Save a full product record and refresh the shared catalogue.
  const persist = async (next: Product, flash?: string) => {
    const saved = await saveProductNow({ ...next, name: (next.name || "").trim() } as unknown as Record<string, unknown>) as unknown as Product[];
    setProducts(saved);
    if (flash) setNotice(flash);
    return saved;
  };

  // Commit the buffered edits for a row (used by the text/number inputs on blur).
  const commit = async (p: Product) => {
    const patch = pending[p.id];
    if (!patch || !Object.keys(patch).length) return;
    // A blank name would be rejected by the server and orphan the row - keep the
    // original name and warn instead of wiping it.
    if ("name" in patch && !(patch.name || "").trim()) {
      clearPending(p.id);
      setNotice("A product needs a name - rename left unchanged.");
      return;
    }
    const next = { ...p, ...patch } as Product;
    if ((["name", "price", "cost", "supplier", "full", "stock"] as (keyof Product)[]).every((k) => next[k] === p[k])) {
      clearPending(p.id);
      return;
    }
    setBusy(p.id);
    try { await persist(next, `${next.name || "Product"} saved`); clearPending(p.id); }
    catch (err) { setNotice(err instanceof Error ? err.message : "Could not save"); }
    finally { setBusy(null); }
  };

  // Save a single field immediately (used by the supplier dropdown).
  const saveField = async (p: Product, patch: Partial<Product>) => {
    setBusy(p.id);
    try { await persist({ ...p, ...patch }, `${p.name || "Product"} saved`); clearPending(p.id); }
    catch (err) { setNotice(err instanceof Error ? err.message : "Could not save"); }
    finally { setBusy(null); }
  };

  // Resolve a duplicate group in one click: keep one record, fold every other
  // copy's stock into it, then delete the copies. Stock is never lost.
  const mergeGroup = async (items: Product[], keepId: string) => {
    const keep = items.find((p) => p.id === keepId)!;
    const others = items.filter((p) => p.id !== keepId);
    const totalStock = items.reduce((s, p) => s + (Number(p.stock) || 0), 0);
    if (!window.confirm(
      `Keep "${keep.name}" and delete ${others.length} duplicate${others.length === 1 ? "" : "s"}?\n\n` +
      `Their stock is added in, so "${keep.name}" becomes stock ${totalStock}.\n\nThis cannot be undone.`,
    )) return;
    setBusy(keepId);
    try {
      let saved = await persist({ ...keep, stock: totalStock });
      for (const o of others) saved = await deleteProductNow(o.id) as unknown as Product[];
      setProducts(saved);
      setNotice(`Merged into "${keep.name}" (stock ${totalStock})`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not merge");
    } finally { setBusy(null); }
  };

  const remove = async (p: Product, reason: string) => {
    if (!window.confirm(`Delete "${p.name || "Unnamed"}"? ${reason}\n\nThis cannot be undone.`)) return;
    setBusy(p.id);
    try {
      const saved = await deleteProductNow(p.id) as unknown as Product[];
      setProducts(saved);
      setNotice(`${p.name || "Product"} deleted`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not delete");
    } finally { setBusy(null); }
  };

  const tickedRows = rows.filter((p) => ticked[p.id]);
  const toggleAll = () => setTicked((cur) => {
    const all = rows.length > 0 && rows.every((p) => cur[p.id]);
    const next = { ...cur };
    rows.forEach((p) => { if (all) delete next[p.id]; else next[p.id] = true; });
    return next;
  });
  // One save per product through the same merge endpoint the rest of the page
  // uses, so another tablet's edits are never overwritten.
  const applyBulkSupplier = async () => {
    const name = txt(bulkSupplier);
    if (!name || !tickedRows.length) return;
    if (!window.confirm("Set the supplier to \"" + name + "\" on " + tickedRows.length + " product" + (tickedRows.length === 1 ? "" : "s") + "?")) return;
    setBusy("bulk");
    let saved = products;
    try {
      for (const row of tickedRows) {
        const latest = saved.find((x) => x.id === row.id) || row;
        saved = await saveProductNow({ ...latest, supplier: name } as unknown as Record<string, unknown>) as unknown as Product[];
      }
      setProducts(saved);
      setTicked({});
      setNotice(tickedRows.length + " products set to " + name);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not set the supplier");
    } finally { setBusy(null); }
  };

  const applyBulkDropped = async () => {
    if (!tickedRows.length) return;
    if (!window.confirm("Mark " + tickedRows.length + " product" + (tickedRows.length === 1 ? "" : "s") + " as no longer stocked?\n\nThey stay in the catalogue and stay sellable until the stock runs out, but they drop off the shopping list.")) return;
    setBusy("bulk");
    let saved = products;
    try {
      for (const row of tickedRows) {
        const latest = saved.find((x) => x.id === row.id) || row;
        saved = await saveProductNow({ ...latest, discontinued: true } as unknown as Record<string, unknown>) as unknown as Product[];
      }
      setProducts(saved);
      setTicked({});
      setNotice(tickedRows.length + " products marked as no longer stocked");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not update those products");
    } finally { setBusy(null); }
  };

  const chips: [FilterKey, string, number][] = [
    ["todo", "Still to do", counts.todo],
    ["cost", "No cost price", counts.cost],
    ["supplier", "No supplier", counts.supplier],
    ["full", "No full number", counts.full],
    ["price", "No sale price", counts.price],
    ["unsellable", "No barcode or button", counts.unsellable],
    ["done", "Complete", counts.done],
    ["dropped", "No longer stocked", counts.dropped],
    ["all", "Everything", products.length],
  ];

  const sellBadge = (p: Product) =>
    txt(p.barcode) ? <span className="pb-badge ok" title={p.barcode}>▣ Barcode</span>
      : p.quick ? <span className="pb-badge ok">⬛ Button</span>
        : <span className="pb-badge warn">⚠ No till route</span>;

  return (
    <section className="priority-backfill">
      <header className="pb-header">
        <div>
          <p className="eyebrow">Catalogue tidy-up</p>
          <h2>Priority backfill</h2>
          <p>{counts.todo} of {products.length} products still need one of: sale price, cost price, supplier or full number.</p>
        </div>
        <div className="pb-header-actions">
          <label className="pb-search"><span>⌕</span>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search products" />
            {search && <button type="button" aria-label="Clear" onClick={() => setSearch("")}>×</button>}
          </label>
          <button type="button" className="primary-small" onClick={onExit}>Back to product library</button>
        </div>
      </header>

      {notice && <div className="pb-flash">✓ {notice}<button onClick={() => setNotice("")}>×</button></div>}

      <div className="pb-bulk">
        <label className="pb-bulk-all">
          <input type="checkbox" checked={rows.length > 0 && rows.every((p) => ticked[p.id])} onChange={toggleAll} aria-label="Tick everything shown" />
          Tick all {rows.length} shown
        </label>
        <strong>{tickedRows.length} ticked</strong>
        <select value={bulkSupplier} onChange={(e) => setBulkSupplier(e.target.value)} aria-label="Supplier for the ticked products">
          <option value="">Set supplier to…</option>
          {supplierList.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
        <button className="pb-keep" disabled={busy === "bulk" || !bulkSupplier || !tickedRows.length} onClick={() => void applyBulkSupplier()}>
          {busy === "bulk" ? "Saving…" : "Apply to ticked"}
        </button>
        <button className="pb-stop" disabled={busy === "bulk" || !tickedRows.length} onClick={() => void applyBulkDropped()}>
          Mark no longer stocked
        </button>
        {Boolean(tickedRows.length) && <button className="pb-del" onClick={() => setTicked({})}>Clear</button>}
      </div>

      <div className="pb-chips">
        {chips.map(([key, label, n]) => (
          <button key={key} className={filter === key ? "active" : ""} onClick={() => setFilter(key)}>
            {label} <b>{n}</b>
          </button>
        ))}
      </div>

      {dupeGroups.length > 0 && (
        <div className="pb-dupes">
          <button type="button" className="pb-dupes-toggle" onClick={() => setShowDupes((s) => !s)}>
            {showDupes ? "▾" : "▸"} Duplicate barcodes — {dupeGroups.length} barcode{dupeGroups.length === 1 ? "" : "s"} shared by 2+ products
          </button>
          {showDupes && (
            <div className="pb-dupe-list">
              <p className="pb-dupe-hint">Same item entered twice? Hit <strong>Keep</strong> on the record you want — the others are deleted and their stock is folded in. Two genuinely different products sharing one barcode? Don’t merge — fix the wrong barcode on the item’s row below instead.</p>
              {dupeGroups.map((g) => (
                <div className="pb-dupe-group" key={g.barcode}>
                  <span className="pb-dupe-code">{g.barcode}</span>
                  <div className="pb-dupe-items">
                    {g.items.map((p) => (
                      <div className="pb-dupe-item" key={p.id}>
                        <span className="pb-dupe-main">
                          <input className="pb-name-input" aria-label="Product name" placeholder="Product name"
                            value={(valOf(p, "name") as string) ?? ""}
                            onChange={(e) => edit(p.id, { name: e.target.value })}
                            onBlur={() => commit(p)} />
                          <small>{[p.size, `${money(p.price)}`, `stock ${p.stock}`].filter(Boolean).join(" · ")}</small>
                        </span>
                        <span className="pb-dupe-actions">
                          <button className="pb-keep" disabled={busy === p.id} onClick={() => mergeGroup(g.items, p.id)} title="Keep this one, delete the others and add their stock in">Keep</button>
                          <button className="pb-del" disabled={busy === p.id} onClick={() => remove(p, "Removing a duplicate barcode entry.")}>Delete</button>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="pb-table">
        <div className="pb-row pb-head">
          <span className="pb-tick" /><span>Product</span><span>Sale £</span><span>Cost £</span><span>Supplier</span><span>Stock</span><span>Full</span><span>Till route</span><span />
        </div>
        <div className="pb-body">
          {rows.length === 0 && <div className="pb-empty">Nothing here. ✓</div>}
          {rows.map((p) => {
            const g = gaps(p);
            return (
              <div className={`pb-row ${isComplete(p) ? "is-done" : ""} ${busy === p.id ? "is-busy" : ""} ${p.discontinued ? "is-dropped" : ""}`} key={p.id}>
                <span className="pb-tick">
                  <input type="checkbox" checked={Boolean(ticked[p.id])} aria-label={"Tick " + p.name}
                    onChange={(e) => setTicked((cur) => { const next = { ...cur }; if (e.target.checked) next[p.id] = true; else delete next[p.id]; return next; })} />
                </span>
                <span className="pb-name">
                  <i style={{ background: p.colour }}>{(p.name[0] || "?").toUpperCase()}</i>
                  <span className="pb-name-edit">
                    <input className="pb-name-input" aria-label="Product name" placeholder="Product name"
                      value={(valOf(p, "name") as string) ?? ""}
                      onChange={(e) => edit(p.id, { name: e.target.value })}
                      onBlur={() => commit(p)} />
                    <small>{[p.size, p.category].filter(Boolean).join(" · ") || "—"}</small>
                  </span>
                </span>
                <span className={`pb-cell ${g.price ? "missing" : ""}`}>
                  <input type="number" min="0" step="0.01" inputMode="decimal" placeholder="—"
                    value={(valOf(p, "price") as number) || ""}
                    onChange={(e) => edit(p.id, { price: Number(e.target.value) })}
                    onBlur={() => commit(p)} />
                </span>
                <span className={`pb-cell ${g.cost ? "missing" : ""}`}>
                  <input type="number" min="0" step="0.01" inputMode="decimal" placeholder="—"
                    value={(valOf(p, "cost") as number) || ""}
                    onChange={(e) => edit(p.id, { cost: Number(e.target.value) })}
                    onBlur={() => commit(p)} />
                </span>
                <span className={`pb-cell pb-supplier ${g.supplier ? "missing" : ""}`}>
                  {addingSupplier === p.id ? (
                    <input autoFocus placeholder="New supplier"
                      value={(valOf(p, "supplier") as string) || ""}
                      onChange={(e) => edit(p.id, { supplier: e.target.value })}
                      onBlur={() => { setAddingSupplier(null); commit(p); }} />
                  ) : (
                    <select value={(valOf(p, "supplier") as string) || ""}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === "__new") { edit(p.id, { supplier: "" }); setAddingSupplier(p.id); return; }
                        void saveField(p, { supplier: v });
                      }}>
                      <option value="">—</option>
                      {supplierList.map((s) => <option key={s} value={s}>{s}</option>)}
                      <option value="__new">+ Add new supplier…</option>
                    </select>
                  )}
                </span>
                <span className="pb-cell pb-stock">
                  <span className="pb-stepper">
                    <button type="button" aria-label="Reduce stock by one" onClick={() => adjustStock(p, -1)}>−</button>
                    <input type="number" min="0" inputMode="numeric" aria-label="Stock in shop"
                      value={shownStock(p) === 0 ? "" : shownStock(p)} placeholder="0"
                      onFocus={(e) => e.currentTarget.select()}
                      onChange={(e) => { edit(p.id, { stock: e.target.value === "" ? 0 : Math.max(0, Math.floor(Number(e.target.value))) }); scheduleStock(p.id); }}
                      onBlur={() => flushStock(p.id)} />
                    <button type="button" aria-label="Increase stock by one" onClick={() => adjustStock(p, 1)}>+</button>
                  </span>
                </span>
                <span className={`pb-cell ${g.full ? "missing" : ""}`}>
                  <input type="number" min="0" inputMode="numeric" placeholder="—"
                    value={(valOf(p, "full") as number) ?? ""}
                    onChange={(e) => edit(p.id, { full: e.target.value === "" ? undefined : Math.max(0, Number(e.target.value)) })}
                    onBlur={() => commit(p)} />
                </span>
                <span className="pb-route">{sellBadge(p)}</span>
                <span className="pb-actions">
                  <button
                    className={p.discontinued ? "pb-keep" : "pb-stop"}
                    disabled={busy === p.id}
                    title={p.discontinued ? "Start stocking this again" : "No longer stocked - keeps the record but drops it off the shopping list"}
                    onClick={() => void saveField(p, { discontinued: !p.discontinued })}
                  >{p.discontinued ? "Restock" : "Drop"}</button>
                  <button className="pb-del" disabled={busy === p.id} onClick={() => remove(p, "Use for duplicates or expired/discontinued products.")}>Delete</button>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
