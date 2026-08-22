"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { saveProductNow } from "./live-store";
import { ShopElevation } from "./ShopElevation";

export type Product = {
  id: string; name: string; price: number; cost: number; stock: number; category: string;
  full?: number; lowStockLevel?: number; barcode?: string; caseBarcode?: string; caseQuantity?: number;
  colour: string; quick?: boolean; supplier?: string; size?: string; notes?: string;
  keyProduct?: boolean; stockConfirmed?: boolean; backfillSkipped?: boolean; tillSetupConfirmed?: boolean; discontinued?: boolean;
  fixtureId?: string; sectionId?: string;
};

export type FixtureKind = "shelving" | "fridge" | "freezer" | "counter" | "display" | "basket" | "other";
// A named cell on the face of a unit: "Crisps", "Milk", "Jaffa cakes".
export type Section = { id: string; name?: string; weight?: number };
// A vertical slice of a unit, cut into stacked sections by horizontal lines.
export type Column = { id: string; weight?: number; sections: Section[] };
export type Fixture = {
  id: string; name: string; kind: FixtureKind;
  x: number; y: number; w: number; h: number; // footprint on the floor plan, in grid cells
  tall?: number;                              // height of the face on the walk-round view
  // "rows" means the face is cut into shelves first, then each shelf into named
  // segments across; "columns" cuts it into vertical bays first.
  grain?: "columns" | "rows";
  columns: Column[];
};
export type ShopLayout = { cols: number; rows: number; fixtures: Fixture[] };

export const emptyShopLayout: ShopLayout = { cols: 24, rows: 16, fixtures: [] };

const newId = () => crypto.randomUUID();
export const newSection = (name = ""): Section => ({ id: newId(), name });
export const newColumn = (sections = 1): Column => ({
  id: newId(),
  sections: Array.from({ length: Math.max(1, sections) }, () => newSection()),
});

// A saved layout may predate a field, so normalise whatever comes back from the
// database into something the views can always render.
export function readShopLayout(value: unknown): ShopLayout {
  const raw = (value || {}) as { cols?: number; rows?: number; fixtures?: (Partial<Fixture> & { shelves?: number; columns?: Partial<Column>[] })[] };
  const groupWord = (grain?: string) => (grain === "rows" ? "Shelf" : "Column");
  void groupWord;
  const fixtures = Array.isArray(raw.fixtures) ? raw.fixtures : [];
  return {
    cols: Number(raw.cols) > 0 ? Number(raw.cols) : emptyShopLayout.cols,
    rows: Number(raw.rows) > 0 ? Number(raw.rows) : emptyShopLayout.rows,
    fixtures: fixtures.map((f: Partial<Fixture> & { shelves?: number; columns?: Partial<Column>[] }) => {
      const saved = Array.isArray(f.columns) ? f.columns : [];
      const columns: Column[] = saved.length
        ? saved.map((column) => {
            const sections: Partial<Section>[] = Array.isArray(column.sections) && column.sections.length ? column.sections : [{}];
            return {
              id: String(column.id || newId()),
              weight: Number(column.weight) > 0 ? Number(column.weight) : undefined,
              sections: sections.map((section) => ({
                id: String(section.id || newId()),
                name: section.name ? String(section.name) : "",
                weight: Number(section.weight) > 0 ? Number(section.weight) : undefined,
              })),
            };
          })
        // Layouts written before sections existed stored a plain shelf count.
        : [newColumn(Math.max(1, Number(f.shelves) || 4))];
      return {
        id: String(f.id),
        name: String(f.name || "Unit"),
        kind: (f.kind || "shelving") as FixtureKind,
        x: Number(f.x) || 0, y: Number(f.y) || 0,
        w: Math.max(1, Number(f.w) || 3), h: Math.max(1, Number(f.h) || 2),
        tall: Math.min(14, Math.max(2, Number(f.tall) || 6)),
        grain: f.grain === "rows" ? "rows" : "columns",
        columns,
      };
    }),
  };
}

const kinds: [FixtureKind, string][] = [
  ["shelving", "Shelving"], ["fridge", "Fridge"], ["freezer", "Freezer"],
  ["counter", "Counter"], ["display", "Display stand"], ["basket", "Basket / crate"], ["other", "Other"],
];
const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n));
const txt = (s?: string) => (s == null ? "" : String(s)).trim();
// How many to buy to fill the shelf back up. No target set means nothing to say.
const needOf = (p: Product) =>
  p.discontinued || !(typeof p.full === "number" && p.full > 0)
    ? 0
    : Math.max(0, p.full - (Number(p.stock) || 0));
const allSections = (bay: Fixture) => bay.columns.flatMap((column) => column.sections);
// Capturing can throw if the pointer has already been released; a failed
// capture only means the drag ends early, never a broken handler.
const capture = (event: React.PointerEvent) => {
  try { (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); } catch { /* pointer already gone */ }
};

export function ShopMap({
  products, setProducts, layout, setLayout, canEdit, picked, setPicked, onExit,
}: {
  products: Product[];
  setProducts: React.Dispatch<React.SetStateAction<Product[]>>;
  layout: ShopLayout;
  setLayout: React.Dispatch<React.SetStateAction<ShopLayout>>;
  canEdit: boolean;
  picked: Record<string, boolean>;
  setPicked: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  onExit: () => void;
}) {
  const [mode, setMode] = useState<"shop" | "plan" | "walk">("shop");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sectionId, setSectionId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  // Product tray that lives under the canvas
  const [trayOpen, setTrayOpen] = useState(true);
  const [traySearch, setTraySearch] = useState("");
  const [trayOnlyUnplaced, setTrayOnlyUnplaced] = useState(true);
  const [trayCategory, setTrayCategory] = useState("");

  // Shopping walk
  const [walkShop, setWalkShop] = useState("");
  const [hidePicked, setHidePicked] = useState(false);
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [targetFixture, setTargetFixture] = useState("");
  const [targetSection, setTargetSection] = useState("");

  // Scan-onto-section session
  const [scanTarget, setScanTarget] = useState<{ fixtureId: string; sectionId: string } | null>(null);
  const [scanValue, setScanValue] = useState("");
  const [scanCounts, setScanCounts] = useState<Record<string, number>>({});
  const scanRef = useRef<HTMLInputElement>(null);

  const fixtures = layout.fixtures;
  const selected = fixtures.find((f) => f.id === selectedId) || null;

  // Which bay each section belongs to, so a product can be traced back to a unit.
  const sectionHome = useMemo(() => {
    const map: Record<string, { bay: Fixture; section: Section }> = {};
    fixtures.forEach((bay) => allSections(bay).forEach((section) => { map[section.id] = { bay, section }; }));
    return map;
  }, [fixtures]);

  const bySection = useMemo(() => {
    const map: Record<string, Product[]> = {};
    products.forEach((p) => { if (p.sectionId) (map[p.sectionId] = map[p.sectionId] || []).push(p); });
    Object.values(map).forEach((list) => list.sort((a, b) => a.name.localeCompare(b.name)));
    return map;
  }, [products]);
  const sectionItems = (id: string) => bySection[id] || [];

  const placedIds = useMemo(
    () => new Set(products.filter((p) => p.sectionId && sectionHome[p.sectionId]).map((p) => p.id)),
    [products, sectionHome],
  );
  const unplacedCount = products.length - placedIds.size;
  const bayItems = (bay: Fixture) => allSections(bay).flatMap((section) => sectionItems(section.id));

  const categories = useMemo(
    () => Array.from(new Set(products.map((p) => txt(p.category)).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [products],
  );
  const sectionLabel = (bay: Fixture, section: Section) => {
    if (txt(section.name)) return txt(section.name);
    const index = allSections(bay).findIndex((s) => s.id === section.id);
    return `Section ${index + 1}`;
  };

  // ---------- layout editing ----------
  const patchFixture = (id: string, patch: Partial<Fixture>) =>
    setLayout((cur) => ({ ...cur, fixtures: cur.fixtures.map((f) => (f.id === id ? { ...f, ...patch } : f)) }));

  const addFixture = () => {
    // Drop the new unit in the first patch of cells that is still clear.
    const taken = new Set<string>();
    fixtures.forEach((f) => { for (let x = f.x; x < f.x + f.w; x++) for (let y = f.y; y < f.y + f.h; y++) taken.add(`${x},${y}`); });
    let spot = { x: 0, y: 0 };
    outer: for (let y = 0; y <= layout.rows - 2; y++) for (let x = 0; x <= layout.cols - 3; x++) {
      let clear = true;
      for (let dx = 0; dx < 3 && clear; dx++) for (let dy = 0; dy < 2; dy++) if (taken.has(`${x + dx},${y + dy}`)) { clear = false; break; }
      if (clear) { spot = { x, y }; break outer; }
    }
    const id = newId();
    setLayout((cur) => ({
      ...cur,
      fixtures: [...cur.fixtures, {
        id, name: `Unit ${cur.fixtures.length + 1}`, kind: "shelving",
        x: spot.x, y: spot.y, w: 3, h: 2, tall: 6, columns: [newColumn(4)],
      }],
    }));
    setSelectedId(id);
  };

  const addColumn = (bay: Fixture) => patchFixture(bay.id, { columns: [...bay.columns, newColumn(1)] });
  const addSection = (bay: Fixture, columnIndex: number) => patchFixture(bay.id, {
    columns: bay.columns.map((column, ci) => ci === columnIndex ? { ...column, sections: [...column.sections, newSection()] } : column),
  });

  // Emptying a section first, so its products go back to the tray rather than
  // pointing at something that no longer exists.
  const dropSection = async (bay: Fixture, columnIndex: number, section: Section) => {
    const items = sectionItems(section.id);
    if (items.length && !window.confirm(
      `Remove "${sectionLabel(bay, section)}"?\n\n${items.length} product${items.length === 1 ? "" : "s"} will go back to the tray. Nothing is deleted from the catalogue.`,
    )) return;
    setBusy(true);
    try {
      if (items.length) await commitAll(items, () => ({ fixtureId: undefined, sectionId: undefined }));
      const columns = bay.columns
        .map((column, ci) => ci !== columnIndex ? column : { ...column, sections: column.sections.filter((s) => s.id !== section.id) })
        .filter((column) => column.sections.length);
      patchFixture(bay.id, { columns: columns.length ? columns : [newColumn(1)] });
      if (sectionId === section.id) setSectionId(null);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not remove that section");
    } finally { setBusy(false); }
  };

  const removeFixture = async (f: Fixture) => {
    const items = bayItems(f);
    if (!window.confirm(
      `Delete "${f.name}"?` + (items.length ? `\n\n${items.length} product${items.length === 1 ? "" : "s"} go back to the tray. Nothing is deleted from the catalogue.` : ""),
    )) return;
    setBusy(true);
    try {
      await commitAll(items, () => ({ fixtureId: undefined, sectionId: undefined }));
      setLayout((cur) => ({ ...cur, fixtures: cur.fixtures.filter((x) => x.id !== f.id) }));
      setSelectedId(null);
      setSectionId(null);
      setNotice(`${f.name} removed`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not clear that unit");
    } finally { setBusy(false); }
  };

  // ---------- dragging units around the floor plan ----------
  const wrapRef = useRef<HTMLDivElement>(null);
  const [cell, setCell] = useState(34);
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const measure = () => setCell(Math.max(26, Math.floor((wrap.clientWidth - 2) / layout.cols)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [layout.cols, mode, trayOpen]);

  const dragRef = useRef<
    { id: string; kind: "move" | "resize"; pointerId: number; px: number; py: number; ox: number; oy: number; ow: number; oh: number; moved: boolean } | null
  >(null);
  const [ghost, setGhost] = useState<{ id: string; x: number; y: number; w: number; h: number } | null>(null);

  const startDrag = (event: React.PointerEvent, f: Fixture, kind: "move" | "resize") => {
    if (!canEdit) { setSelectedId(f.id); return; }
    event.preventDefault();
    capture(event);
    dragRef.current = { id: f.id, kind, pointerId: event.pointerId, px: event.clientX, py: event.clientY, ox: f.x, oy: f.y, ow: f.w, oh: f.h, moved: false };
    setGhost({ id: f.id, x: f.x, y: f.y, w: f.w, h: f.h });
  };
  // Where the unit lands for a pointer at (clientX, clientY), snapped to cells
  // and kept inside the plan.
  const shapeFor = (drag: NonNullable<typeof dragRef.current>, clientX: number, clientY: number) => {
    const dx = Math.round((clientX - drag.px) / cell);
    const dy = Math.round((clientY - drag.py) / cell);
    if (dx || dy) drag.moved = true;
    return drag.kind === "move"
      ? { id: drag.id, w: drag.ow, h: drag.oh, x: clamp(drag.ox + dx, 0, layout.cols - drag.ow), y: clamp(drag.oy + dy, 0, layout.rows - drag.oh) }
      : { id: drag.id, x: drag.ox, y: drag.oy, w: clamp(drag.ow + dx, 1, layout.cols - drag.ox), h: clamp(drag.oh + dy, 1, layout.rows - drag.oy) };
  };
  const cancelDrag = () => { dragRef.current = null; setGhost(null); };
  const moveDrag = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    // A drag released off-screen leaves no pointerup behind. Without this the
    // stale drag would follow the next plain hover and resize the unit.
    if (event.pointerType === "mouse" && event.buttons === 0) { cancelDrag(); return; }
    setGhost(shapeFor(drag, event.clientX, event.clientY));
  };
  // The release point decides where it lands, not the last move event.
  const endDrag = (event: React.PointerEvent, f: Fixture) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setGhost(null);
    if (!drag || drag.pointerId !== event.pointerId) return;
    const shape = shapeFor(drag, event.clientX, event.clientY);
    // A tap that never moved is a select, not a drag.
    if (drag.moved) patchFixture(f.id, { x: shape.x, y: shape.y, w: shape.w, h: shape.h });
    setSelectedId(f.id);
  };

  // ---------- saving ----------
  // Every save runs through one queue, and each job reads the freshest
  // catalogue, so two quick edits to the same row cannot overwrite each other.
  const productsRef = useRef(products);
  useEffect(() => { productsRef.current = products; }, [products]);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const queued = <T,>(job: () => Promise<T>) => {
    const next = chain.current.then(job, job);
    chain.current = next.catch(() => undefined);
    return next;
  };
  const commitAll = async (rows: Product[], patch: (p: Product) => Partial<Product>) => {
    let saved = productsRef.current;
    for (const row of rows) {
      const latest = saved.find((x) => x.id === row.id) || row;
      saved = await saveProductNow({ ...latest, ...patch(latest) } as unknown as Record<string, unknown>) as unknown as Product[];
      productsRef.current = saved;
    }
    setProducts(saved);
    return saved;
  };

  const place = (items: Product[], fixtureId: string, section: string) => queued(async () => {
    if (!items.length) return;
    setBusy(true);
    try {
      await commitAll(items, () => ({ fixtureId, sectionId: section }));
      const home = sectionHome[section];
      const where = home ? `${home.bay.name} · ${sectionLabel(home.bay, home.section)}` : "the shelf";
      setNotice(items.length === 1 ? `${items[0].name} → ${where}` : `${items.length} products → ${where}`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not save the placement");
    } finally { setBusy(false); }
  });

  const unplace = (p: Product) => queued(async () => {
    setBusy(true);
    try {
      await commitAll([p], () => ({ fixtureId: undefined, sectionId: undefined }));
      setNotice(`${p.name} taken off the map`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not save");
    } finally { setBusy(false); }
  });

  const saveNumber = (p: Product, patch: Partial<Product>) => queued(async () => {
    setBusy(true);
    try {
      await commitAll([p], () => patch);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not save");
    } finally { setBusy(false); }
  });

  // ---------- dragging a product onto a section ----------
  // Drop zones tag themselves with data-unit and data-section, so a drop is
  // resolved by looking at whatever is under the finger.
  const productDrag = useRef<
    { product: Product; startX: number; startY: number; pointerId: number; grip: HTMLElement; active: boolean } | null
  >(null);
  const [floating, setFloating] = useState<{ name: string; x: number; y: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<{ unit: string; section: string } | null>(null);

  const hitTest = (x: number, y: number) => {
    const under = document.elementFromPoint(x, y) as HTMLElement | null;
    const zone = under?.closest("[data-section]") as HTMLElement | null;
    const unit = zone?.getAttribute("data-unit");
    const section = zone?.getAttribute("data-section");
    return unit && section ? { unit, section } : null;
  };

  const grabProduct = (event: React.PointerEvent, product: Product) => {
    productDrag.current = {
      product, startX: event.clientX, startY: event.clientY,
      pointerId: event.pointerId, grip: event.currentTarget as HTMLElement, active: false,
    };
  };
  const dragProduct = (event: React.PointerEvent) => {
    const drag = productDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.pointerType === "mouse" && event.buttons === 0) { cancelProductDrag(); return; }
    if (!drag.active) {
      // Let short taps through so tick boxes and buttons still work.
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
      drag.active = true;
      try { drag.grip.setPointerCapture(drag.pointerId); } catch { /* pointer already gone */ }
    }
    setFloating({ name: drag.product.name, x: event.clientX, y: event.clientY });
    setDropTarget(hitTest(event.clientX, event.clientY));
  };
  const dropProduct = (event: React.PointerEvent) => {
    const drag = productDrag.current;
    const target = dropTarget;
    if (drag && drag.pointerId !== event.pointerId) return;
    productDrag.current = null;
    setFloating(null);
    setDropTarget(null);
    if (!drag || !drag.active) return;
    event.preventDefault();
    // The release point decides where it lands, not the last move event.
    const landed = hitTest(event.clientX, event.clientY) || target;
    if (!landed) return;
    void place([drag.product], landed.unit, landed.section);
  };
  const cancelProductDrag = () => { productDrag.current = null; setFloating(null); setDropTarget(null); };
  const isDropTarget = (unitId: string, section: string) =>
    Boolean(dropTarget && dropTarget.unit === unitId && dropTarget.section === section);

  // ---------- scan onto a section ----------
  const openScan = (fixtureId: string, section: string) => {
    setScanTarget({ fixtureId, sectionId: section });
    setScanCounts({});
    setScanValue("");
    setTimeout(() => scanRef.current?.focus(), 50);
  };
  const handleScan = async () => {
    const code = txt(scanValue);
    setScanValue("");
    if (!code || !scanTarget) return;
    const found = products.find((p) => txt(p.barcode) === code || txt(p.caseBarcode) === code)
      || products.find((p) => p.name.toLowerCase() === code.toLowerCase());
    if (!found) { setNotice(`Nothing in the catalogue matches "${code}"`); return; }
    setScanCounts((cur) => ({ ...cur, [found.id]: (cur[found.id] || 0) + 1 }));
    if (found.sectionId !== scanTarget.sectionId) await place([found], scanTarget.fixtureId, scanTarget.sectionId);
    scanRef.current?.focus();
  };
  // Turn the tally from a shelf walk into either the live stock count or the
  // full-shelf target, whichever the walk was for.
  const applyScanCounts = (field: "stock" | "full") => queued(async () => {
    const entries = Object.entries(scanCounts);
    if (!entries.length) return;
    setBusy(true);
    try {
      const rows = entries.map(([id]) => productsRef.current.find((x) => x.id === id)).filter((x): x is Product => Boolean(x));
      await commitAll(rows, (row) => ({ [field]: scanCounts[row.id] }));
      setNotice(field === "stock" ? `Stock updated for ${entries.length} product${entries.length === 1 ? "" : "s"}` : `Full-shelf target set for ${entries.length} product${entries.length === 1 ? "" : "s"}`);
      setScanCounts({});
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not save the counts");
    } finally { setBusy(false); }
  });

  // The walk-round strip and the shopping list both follow the floor plan, so
  // there is only ever one running order to keep straight.
  const walkOrder = useMemo(() => [...fixtures].sort((a, b) => a.y - b.y || a.x - b.x), [fixtures]);
  const walkTotal = useMemo(
    () => products.filter((p) => placedIds.has(p.id)).reduce((sum, p) => sum + needOf(p), 0),
    [products, placedIds],
  );

  // Every line that needs buying, in walking order, tagged with its shop.
  const shortList = useMemo(() => {
    const rows: { product: Product; bay: Fixture; section: Section; shop: string }[] = [];
    walkOrder.forEach((bay) => allSections(bay).forEach((section) => {
      (bySection[section.id] || []).forEach((product) => {
        if (needOf(product) > 0) rows.push({ product, bay, section, shop: txt(product.supplier) || "No shop set" });
      });
    }));
    return rows;
  }, [walkOrder, bySection]);

  const shops = useMemo(() => {
    const counts: Record<string, number> = {};
    shortList.forEach((row) => { counts[row.shop] = (counts[row.shop] || 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [shortList]);

  const walkRows = shortList.filter((row) => (!walkShop || row.shop === walkShop) && (!hidePicked || !picked[row.product.id]));
  const pickedCount = shortList.filter((row) => picked[row.product.id]).length;

  const trayRows = useMemo(() => {
    const q = traySearch.trim().toLowerCase();
    return products
      .filter((p) => {
        if (trayOnlyUnplaced && placedIds.has(p.id)) return false;
        if (trayCategory && txt(p.category) !== trayCategory) return false;
        if (q && ![p.name, p.category, p.supplier, p.barcode, p.size].some((v) => txt(v).toLowerCase().includes(q))) return false;
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [products, traySearch, trayOnlyUnplaced, trayCategory, placedIds]);

  const tickedItems = products.filter((p) => ticked[p.id]);
  const targetBay = fixtures.find((f) => f.id === targetFixture) || null;

  const placeTicked = async () => {
    if (!targetBay || !targetSection || !tickedItems.length) return;
    await place(tickedItems, targetBay.id, targetSection);
    setTicked({});
  };

  const tray = (
    <div className={`sm-tray${trayOpen ? "" : " closed"}`}>
      <div className="sm-tray-head">
        <button className="sm-tray-toggle" onClick={() => setTrayOpen((v) => !v)}>
          {trayOpen ? "▾" : "▸"} Products <b>{unplacedCount}</b> still to place
        </button>
        {trayOpen && (
          <>
            <div className="sm-search">
              <span>⌕</span>
              <input value={traySearch} onChange={(event) => setTraySearch(event.target.value)} placeholder="Search products" />
              {traySearch && <button type="button" aria-label="Clear search" onClick={() => setTraySearch("")}>×</button>}
            </div>
            <label className="sm-check">
              <input type="checkbox" checked={trayOnlyUnplaced} onChange={(event) => setTrayOnlyUnplaced(event.target.checked)} />
              Not placed only
            </label>
            <select value={trayCategory} onChange={(event) => setTrayCategory(event.target.value)} aria-label="Category">
              <option value="">All categories</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </>
        )}
      </div>

      {trayOpen && (
        <>
          <div className="sm-tray-bulk">
            <span>Drag a row onto a section. Or tick several and send them together:</span>
            <select
              value={targetFixture}
              onChange={(event) => {
                setTargetFixture(event.target.value);
                const bay = fixtures.find((f) => f.id === event.target.value);
                setTargetSection(bay ? allSections(bay)[0]?.id || "" : "");
              }}
              aria-label="Unit"
            >
              <option value="">Choose a unit</option>
              {walkOrder.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            <select value={targetSection} onChange={(event) => setTargetSection(event.target.value)} disabled={!targetBay} aria-label="Section">
              {targetBay
                ? allSections(targetBay).map((s) => <option key={s.id} value={s.id}>{sectionLabel(targetBay, s)}</option>)
                : <option value="">Section</option>}
            </select>
            <button className="sm-mini" disabled={busy || !targetSection || !tickedItems.length} onClick={() => void placeTicked()}>
              Place {tickedItems.length || ""} ticked
            </button>
            {Boolean(tickedItems.length) && <button className="sm-mini ghost" onClick={() => setTicked({})}>Clear</button>}
          </div>

          <div className="sm-tray-list">
            {trayRows.length ? trayRows.slice(0, 400).map((p) => {
              const home = p.sectionId ? sectionHome[p.sectionId] : undefined;
              return (
                <div className="sm-tray-row" key={p.id}>
                  <span
                    className="sm-grip"
                    aria-label={`Drag ${p.name} onto the shop`}
                    onPointerDown={(event) => grabProduct(event, p)}
                    onPointerMove={dragProduct}
                    onPointerUp={dropProduct}
                    onPointerCancel={cancelProductDrag}
                  >⠿</span>
                  <input
                    type="checkbox" checked={Boolean(ticked[p.id])} aria-label={`Tick ${p.name}`}
                    onChange={(event) => setTicked((cur) => ({ ...cur, [p.id]: event.target.checked }))}
                  />
                  <span className="sm-tray-name">
                    <strong>{p.name}</strong>
                    <small>{p.category}{p.size ? ` · ${p.size}` : ""}{p.supplier ? ` · ${p.supplier}` : ""}</small>
                  </span>
                  <em>{home ? `${home.bay.name} · ${sectionLabel(home.bay, home.section)}` : "Not placed"}</em>
                </div>
              );
            }) : <p className="sm-shelf-empty">No products match that search.</p>}
            {trayRows.length > 400 && <p className="sm-shelf-empty">Showing the first 400 of {trayRows.length}. Search to narrow it down.</p>}
          </div>
        </>
      )}
    </div>
  );

  const openSection = selected && sectionId ? allSections(selected).find((s) => s.id === sectionId) || null : null;

  const panel = (
    <aside className="sm-panel">
      {!selected ? (
        <div className="sm-empty">
          <p>Tap a unit to edit its sections.</p>
          <p>Drag a product from the tray onto any named section.</p>
        </div>
      ) : (
        <>
          <div className="sm-panel-head">
            <input
              className="sm-name-input"
              value={selected.name}
              disabled={!canEdit}
              onChange={(event) => patchFixture(selected.id, { name: event.target.value })}
              onBlur={(event) => { if (!txt(event.target.value)) patchFixture(selected.id, { name: "Unit" }); }}
              aria-label="Unit name"
            />
            <button className="sm-close" onClick={() => { setSelectedId(null); setSectionId(null); }} aria-label="Close unit">×</button>
          </div>
          <div className="sm-panel-controls">
            <label>
              Type
              <select value={selected.kind} disabled={!canEdit} onChange={(event) => patchFixture(selected.id, { kind: event.target.value as FixtureKind })}>
                {kinds.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
            </label>
            <label>
              Height
              <input
                type="number" min={2} max={14} value={selected.tall || 6} disabled={!canEdit}
                onChange={(event) => patchFixture(selected.id, { tall: clamp(Number(event.target.value) || 6, 2, 14) })}
              />
            </label>
          </div>

          <div className="sm-sections">
            {selected.columns.map((column, ci) => (
              <div className="sm-column" key={column.id}>
                <div className="sm-column-head">
                  <strong>{selected.grain === "rows" ? "Shelf" : "Column"} {ci + 1}</strong>
                  {canEdit && <button className="sm-mini" onClick={() => addSection(selected, ci)}>+ section</button>}
                </div>
                {column.sections.map((section) => {
                  const items = sectionItems(section.id);
                  const short = items.reduce((sum, p) => sum + needOf(p), 0);
                  return (
                    <div
                      className={`sm-section-row${sectionId === section.id ? " selected" : ""}`}
                      key={section.id}
                      data-unit={selected.id}
                      data-section={section.id}
                      onClick={() => setSectionId(section.id)}
                    >
                      <input
                        className="sm-section-name"
                        value={section.name || ""}
                        placeholder={sectionLabel(selected, section)}
                        disabled={!canEdit}
                        aria-label="Section name"
                        onChange={(event) => patchFixture(selected.id, {
                          columns: selected.columns.map((c, index) => index !== ci ? c : {
                            ...c, sections: c.sections.map((s) => s.id === section.id ? { ...s, name: event.target.value } : s),
                          }),
                        })}
                      />
                      <span className="sm-section-count">{items.length}</span>
                      {short > 0 && <b className="sm-need">buy {short}</b>}
                      <button className="sm-mini" onClick={(event) => { event.stopPropagation(); openScan(selected.id, section.id); }}>Scan</button>
                      {canEdit && (
                        <button className="sm-mini ghost" aria-label="Remove section" onClick={(event) => { event.stopPropagation(); void dropSection(selected, ci, section); }}>×</button>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
            {canEdit && (
              <button className="sm-mini" onClick={() => addColumn(selected)}>
                + Add {selected.grain === "rows" ? "shelf" : "column"}
              </button>
            )}
          </div>

          {openSection && (
            <div className="sm-shelf">
              <div className="sm-shelf-head">
                <strong>{sectionLabel(selected, openSection)}</strong>
                <span>{sectionItems(openSection.id).length} item{sectionItems(openSection.id).length === 1 ? "" : "s"}</span>
              </div>
              {sectionItems(openSection.id).length ? sectionItems(openSection.id).map((p) => (
                <div className="sm-item" key={p.id}>
                  <span
                    className="sm-grip"
                    aria-label={`Move ${p.name}`}
                    onPointerDown={(event) => grabProduct(event, p)}
                    onPointerMove={dragProduct}
                    onPointerUp={dropProduct}
                    onPointerCancel={cancelProductDrag}
                  >⠿</span>
                  <span className="sm-item-name">{p.name}{p.size ? <small>{p.size}</small> : null}</span>
                  <label className="sm-num">
                    <small>On shelf</small>
                    <input
                      type="number" min={0} defaultValue={p.stock}
                      onBlur={(event) => { const v = Math.max(0, Number(event.target.value) || 0); if (v !== p.stock) void saveNumber(p, { stock: v }); }}
                    />
                  </label>
                  <label className="sm-num">
                    <small>When full</small>
                    <input
                      type="number" min={0} defaultValue={p.full ?? ""}
                      onBlur={(event) => { const raw = event.target.value; const v = raw === "" ? undefined : Math.max(0, Number(raw) || 0); if (v !== p.full) void saveNumber(p, { full: v }); }}
                    />
                  </label>
                  <b className={needOf(p) ? "sm-need" : "sm-ok"}>{needOf(p) ? `buy ${needOf(p)}` : "ok"}</b>
                  <button className="sm-mini ghost" onClick={() => void unplace(p)} aria-label={`Remove ${p.name}`}>×</button>
                </div>
              )) : <p className="sm-shelf-empty">Empty — drag products here</p>}
            </div>
          )}

          {canEdit && (
            <button className="danger-button sm-delete" disabled={busy} onClick={() => void removeFixture(selected)}>
              Delete this unit
            </button>
          )}
        </>
      )}
    </aside>
  );

  return (
    <section className="shop-map">
      <div className="sm-header">
        <div>
          <h2>Shop map</h2>
          <p>
            {fixtures.length} unit{fixtures.length === 1 ? "" : "s"} · {placedIds.size} of {products.length} products placed
            {walkTotal ? ` · ${walkTotal} to buy` : ""}
          </p>
        </div>
        <div className="sm-header-actions">
          <div className="sm-modes">
            <button className={mode === "shop" ? "active" : ""} onClick={() => setMode("shop")}>Shop view</button>
            <button className={mode === "plan" ? "active" : ""} onClick={() => setMode("plan")}>Floor plan</button>
            <button className={mode === "walk" ? "active" : ""} onClick={() => setMode("walk")}>Shopping walk</button>
          </div>
          <button className="primary-small" onClick={onExit}>Done</button>
        </div>
      </div>

      {notice && (
        <div className="sm-flash" role="status">
          {notice}
          <button onClick={() => setNotice("")}>×</button>
        </div>
      )}

      {(mode === "shop" || mode === "plan") && (
        <div className="sm-plan">
          <div className="sm-canvas-side">
            {mode === "shop" ? (
              <ShopElevation
                bays={walkOrder}
                products={products}
                selectedBayId={selectedId}
                selectedSectionId={sectionId}
                onSelectBay={setSelectedId}
                onSelectSection={setSectionId}
                canEdit={canEdit}
                patchFixture={patchFixture}
                grabProduct={grabProduct}
                dragProduct={dragProduct}
                dropProduct={dropProduct}
                cancelProductDrag={cancelProductDrag}
                isDropTarget={isDropTarget}
                needOf={needOf}
                sectionItems={sectionItems}
              />
            ) : (
              <>
                {canEdit && (
                  <div className="sm-plan-tools">
                    <button className="primary-small" onClick={addFixture}>+ Add unit</button>
                    <span>Where things sit in the room. This order is the order you walk the shop.</span>
                  </div>
                )}
                <div className="sm-canvas-wrap" ref={wrapRef}>
                  <div
                    className="sm-canvas"
                    style={{ width: layout.cols * cell, height: layout.rows * cell, backgroundSize: `${cell}px ${cell}px` }}
                    onPointerDown={(event) => { if (event.target === event.currentTarget) setSelectedId(null); }}
                  >
                    {fixtures.map((f) => {
                      const shape = ghost && ghost.id === f.id ? ghost : f;
                      const items = bayItems(f);
                      const need = items.reduce((sum, p) => sum + needOf(p), 0);
                      return (
                        <div
                          key={f.id}
                          className={`sm-fixture kind-${f.kind}${selectedId === f.id ? " selected" : ""}${ghost && ghost.id === f.id ? " dragging" : ""}`}
                          style={{ left: shape.x * cell, top: shape.y * cell, width: shape.w * cell, height: shape.h * cell }}
                          onPointerDown={(event) => startDrag(event, f, "move")}
                          onPointerMove={moveDrag}
                          onPointerUp={(event) => endDrag(event, f)}
                          onPointerCancel={cancelDrag}
                          onLostPointerCapture={cancelDrag}
                        >
                          <strong>{f.name}</strong>
                          <small>{items.length} item{items.length === 1 ? "" : "s"} · {allSections(f).length} sections</small>
                          {need > 0 && <em className="sm-need-dot">{need}</em>}
                          {canEdit && (
                            <span
                              className="sm-resize"
                              onPointerDown={(event) => { event.stopPropagation(); startDrag(event, f, "resize"); }}
                              onPointerMove={(event) => { event.stopPropagation(); moveDrag(event); }}
                              onPointerUp={(event) => { event.stopPropagation(); endDrag(event, f); }}
                              onPointerCancel={cancelDrag}
                            />
                          )}
                        </div>
                      );
                    })}
                    {!fixtures.length && (
                      <p className="sm-canvas-empty">
                        {canEdit ? "Add your first unit, then drag it into place to start mapping the shop." : "The shop map has not been drawn yet."}
                      </p>
                    )}
                  </div>
                </div>
              </>
            )}

            {tray}
          </div>
          {panel}
        </div>
      )}

      {mode === "walk" && (
        <div className="sw">
          <div className="sw-top">
            <div className="sw-tally">
              <strong>{walkRows.filter((row) => !picked[row.product.id]).length}</strong>
              <span>left to pick{pickedCount ? ` · ${pickedCount} in the trolley` : ""}</span>
            </div>
            <div className="sw-top-actions">
              <label className="sm-check">
                <input type="checkbox" checked={hidePicked} onChange={(event) => setHidePicked(event.target.checked)} />
                Hide picked
              </label>
              {pickedCount > 0 && (
                <button className="sm-mini" onClick={() => { if (window.confirm("Empty the trolley and untick everything?")) setPicked({}); }}>
                  Clear trolley
                </button>
              )}
              <button className="sm-mini" onClick={() => window.print()}>Print</button>
            </div>
          </div>

          <div className="sw-shops">
            <button className={walkShop === "" ? "active" : ""} onClick={() => setWalkShop("")}>
              All shops <b>{shortList.length}</b>
            </button>
            {shops.map(([shop, count]) => (
              <button key={shop} className={walkShop === shop ? "active" : ""} onClick={() => setWalkShop(shop)}>
                {shop} <b>{count}</b>
              </button>
            ))}
          </div>

          <div className="sw-list">
            {walkRows.map(({ product, bay, section }) => {
              const done = Boolean(picked[product.id]);
              return (
                <label className={`sw-row${done ? " done" : ""}`} key={product.id}>
                  <input
                    type="checkbox"
                    checked={done}
                    onChange={(event) => setPicked((cur) => {
                      const next = { ...cur };
                      if (event.target.checked) next[product.id] = true; else delete next[product.id];
                      return next;
                    })}
                  />
                  <span className="sw-main">
                    <strong>{product.name}</strong>
                    <small>{bay.name} · {sectionLabel(bay, section)} · {product.stock} of {product.full} on the shelf</small>
                  </span>
                  <b className="sw-buy">{needOf(product)}</b>
                </label>
              );
            })}
            {!walkRows.length && (
              <p className="sm-shelf-empty">
                {shortList.length ? "Everything on this list is in the trolley." : "Nothing needs buying. Set a \"when full\" number on products to build this list."}
              </p>
            )}
          </div>

          {unplacedCount > 0 && (
            <p className="sm-walk-note">{unplacedCount} products are not on the map yet, so they never appear on this list.</p>
          )}
        </div>
      )}

      {floating && <div className="sm-floating" style={{ left: floating.x, top: floating.y }}>{floating.name}</div>}

      {scanTarget && (
        <div className="modal-backdrop">
          <section className="sm-scan" role="dialog" aria-modal="true" aria-label="Scan products onto a section">
            <button className="modal-close" onClick={() => setScanTarget(null)}>×</button>
            <p className="eyebrow">
              {sectionHome[scanTarget.sectionId]
                ? `${sectionHome[scanTarget.sectionId].bay.name} · ${sectionLabel(sectionHome[scanTarget.sectionId].bay, sectionHome[scanTarget.sectionId].section)}`
                : "Section"}
            </p>
            <h2>Scan onto this section</h2>
            <p>Scan every item there. Each one is filed here, and repeat scans count how many are on the shelf.</p>
            <div className="sm-scan-input">
              <input
                ref={scanRef}
                value={scanValue}
                onChange={(event) => setScanValue(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void handleScan(); } }}
                placeholder="Scanner input"
                aria-label="Barcode scanner input"
              />
              <button className="sm-mini" onClick={() => void handleScan()}>Add</button>
            </div>
            <div className="sm-scan-list">
              {Object.entries(scanCounts).length ? Object.entries(scanCounts).map(([id, count]) => {
                const p = products.find((x) => x.id === id);
                return (
                  <div className="sm-item" key={id}>
                    <span className="sm-item-name">{p?.name || "Unknown"}</span>
                    <b>{count}</b>
                  </div>
                );
              }) : <p className="sm-shelf-empty">Nothing scanned yet.</p>}
            </div>
            <div className="sm-scan-actions">
              <button className="pay-button" disabled={busy || !Object.keys(scanCounts).length} onClick={() => void applyScanCounts("stock")}>
                Save counts as stock
              </button>
              <button className="primary-small" disabled={busy || !Object.keys(scanCounts).length} onClick={() => void applyScanCounts("full")}>
                Save counts as full shelf
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
