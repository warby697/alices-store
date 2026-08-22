"use client";
import { useEffect, useRef, useState } from "react";
import type { Column, Fixture, Product, Section } from "./ShopMap";

const BASE_CELL = 46;

// Columns and sections are sized by weight, so a divider drag only has to move
// weight from one side to the other and everything else stays put.
const weightOf = (item: { weight?: number }) => (item.weight && item.weight > 0 ? item.weight : 1);
const totalWeight = (items: { weight?: number }[]) => items.reduce((n, i) => n + weightOf(i), 0);

export function ShopElevation({
  bays, products, selectedBayId, selectedSectionId, onSelectBay, onSelectSection,
  canEdit, patchFixture, grabProduct, dragProduct, dropProduct, cancelProductDrag,
  isDropTarget, needOf, sectionItems,
}: {
  bays: Fixture[];
  products: Product[];
  selectedBayId: string | null;
  selectedSectionId: string | null;
  onSelectBay: (id: string | null) => void;
  onSelectSection: (id: string | null) => void;
  canEdit: boolean;
  patchFixture: (id: string, patch: Partial<Fixture>) => void;
  grabProduct: (event: React.PointerEvent, product: Product) => void;
  dragProduct: (event: React.PointerEvent) => void;
  dropProduct: (event: React.PointerEvent) => void;
  cancelProductDrag: () => void;
  isDropTarget: (bayId: string, sectionId: string) => boolean;
  needOf: (p: Product) => number;
  sectionItems: (sectionId: string) => Product[];
}) {
  const [zoom, setZoom] = useState(1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const cell = BASE_CELL * zoom;
  const tallest = bays.reduce((n, b) => Math.max(n, b.tall || 6), 6);

  // ---------- grab the background to pan ----------
  const pan = useRef<{ x: number; y: number; left: number; top: number; pointerId: number } | null>(null);
  const startPan = (event: React.PointerEvent) => {
    const wrap = wrapRef.current;
    if (!wrap || event.target !== event.currentTarget) return;
    pan.current = { x: event.clientX, y: event.clientY, left: wrap.scrollLeft, top: wrap.scrollTop, pointerId: event.pointerId };
    try { (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); } catch { /* pointer already gone */ }
    onSelectBay(null);
  };
  const movePan = (event: React.PointerEvent) => {
    const grip = pan.current;
    const wrap = wrapRef.current;
    if (!grip || !wrap || grip.pointerId !== event.pointerId) return;
    wrap.scrollLeft = grip.left - (event.clientX - grip.x);
    wrap.scrollTop = grip.top - (event.clientY - grip.y);
  };
  const endPan = () => { pan.current = null; };

  // ---------- drag a divider ----------
  // `axis` is which way the divider splits: a column divider is vertical and
  // moves left/right, a section divider is horizontal and moves up/down.
  const divider = useRef<
    { bay: Fixture; columnIndex: number; sectionIndex: number | null; axis: "x" | "y"; pointerId: number; size: number; sumWeight: number; a: number; b: number; start: number } | null
  >(null);

  const grabDivider = (
    event: React.PointerEvent, bay: Fixture, columnIndex: number, sectionIndex: number | null, axis: "x" | "y",
  ) => {
    if (!canEdit) return;
    event.preventDefault();
    event.stopPropagation();
    const box = (event.currentTarget as HTMLElement).parentElement?.getBoundingClientRect();
    if (!box) return;
    const columns = bay.columns || [];
    const list: { weight?: number }[] = sectionIndex === null ? columns : columns[columnIndex].sections;
    const index = sectionIndex === null ? columnIndex : sectionIndex;
    try { (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); } catch { /* pointer already gone */ }
    divider.current = {
      bay, columnIndex, sectionIndex, axis, pointerId: event.pointerId,
      size: axis === "x" ? box.width : box.height,
      sumWeight: totalWeight(list),
      a: weightOf(list[index]), b: weightOf(list[index + 1]),
      start: axis === "x" ? event.clientX : event.clientY,
    };
  };
  const moveDivider = (event: React.PointerEvent) => {
    const drag = divider.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.pointerType === "mouse" && event.buttons === 0) { divider.current = null; return; }
    const moved = (drag.axis === "x" ? event.clientX : event.clientY) - drag.start;
    const shift = (moved / drag.size) * drag.sumWeight;
    const pair = drag.a + drag.b;
    const next = Math.min(pair - 0.25, Math.max(0.25, drag.a + shift));
    const sectionIndex = drag.sectionIndex;
    const columns = (drag.bay.columns || []).map((column, ci) => {
      if (sectionIndex === null) {
        if (ci === drag.columnIndex) return { ...column, weight: next };
        if (ci === drag.columnIndex + 1) return { ...column, weight: pair - next };
        return column;
      }
      if (ci !== drag.columnIndex) return column;
      return {
        ...column,
        sections: column.sections.map((section, si) => {
          if (si === sectionIndex) return { ...section, weight: next };
          if (si === sectionIndex + 1) return { ...section, weight: pair - next };
          return section;
        }),
      };
    });
    patchFixture(drag.bay.id, { columns });
  };
  const endDivider = () => { divider.current = null; };

  useEffect(() => {
    if (!selectedBayId) return;
    wrapRef.current?.querySelector(`[data-bay="${selectedBayId}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedBayId]);

  const renameSection = (bay: Fixture, columnIndex: number, sectionIndex: number, name: string) => {
    const columns = (bay.columns || []).map((column, ci) => ci !== columnIndex ? column : {
      ...column,
      sections: column.sections.map((section, si) => si === sectionIndex ? { ...section, name } : section),
    });
    patchFixture(bay.id, { columns });
  };

  return (
    <div className="se">
      <div className="se-tools">
        <span className="se-hint">
          {canEdit
            ? "Drag the lines to resize a section. Name each one. Drag products in from the tray below."
            : "Drag the background to pan around the shop."}
        </span>
        <div className="se-zoom">
          <button onClick={() => setZoom((z) => Math.max(0.4, Math.round((z - 0.2) * 10) / 10))} aria-label="Zoom out">−</button>
          <b>{Math.round(zoom * 100)}%</b>
          <button onClick={() => setZoom((z) => Math.min(2.4, Math.round((z + 0.2) * 10) / 10))} aria-label="Zoom in">+</button>
          <button className="se-fit" onClick={() => setZoom(1)}>Reset</button>
        </div>
      </div>

      <div
        className="se-wrap"
        ref={wrapRef}
        onPointerDown={startPan}
        onPointerMove={movePan}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        {!bays.length ? (
          <p className="se-empty">No units yet. Add them on the Floor plan tab and they appear here in walking order.</p>
        ) : (
          <div className="se-strip" style={{ minHeight: tallest * cell + 52 }}>
            {bays.map((bay) => {
              const tall = bay.tall || 6;
              const rows = bay.grain === "rows";
              const columns: Column[] = bay.columns || [];
              const bayItems = products.filter((p) => p.fixtureId === bay.id);
              const need = bayItems.reduce((sum, p) => sum + needOf(p), 0);
              return (
                <div
                  className={`se-bay${selectedBayId === bay.id ? " selected" : ""}`}
                  key={bay.id}
                  data-bay={bay.id}
                  style={{ width: Math.max(2, bay.w) * cell, marginTop: (tallest - tall) * cell }}
                >
                  <button className="se-bay-name" onClick={() => onSelectBay(bay.id)}>
                    {bay.name}
                    {need > 0 && <em>{need}</em>}
                  </button>
                  <div className={`se-bay-body kind-${bay.kind}${rows ? " rows" : ""}`} style={{ height: tall * cell }}>
                    {columns.map((column, ci) => (
                      <div className="se-col" key={column.id} style={{ flexGrow: weightOf(column) }}>
                        {column.sections.map((section: Section, si) => {
                          const items = sectionItems(section.id);
                          const shortfall = items.reduce((sum, p) => sum + needOf(p), 0);
                          const onShelf = items.reduce((sum, p) => sum + (Number(p.stock) || 0), 0);
                          return (
                            <div
                              key={section.id}
                              className={`se-section${isDropTarget(bay.id, section.id) ? " drop-target" : ""}${selectedSectionId === section.id ? " selected" : ""}`}
                              data-unit={bay.id}
                              data-section={section.id}
                              style={{ flexGrow: weightOf(section) }}
                              onClick={() => { onSelectBay(bay.id); onSelectSection(section.id); }}
                            >
                              <span className="se-section-name">
                                {canEdit ? (
                                  <input
                                    value={section.name || ""}
                                    placeholder="Name…"
                                    aria-label={`Name of section in ${bay.name}`}
                                    onPointerDown={(event) => event.stopPropagation()}
                                    onChange={(event) => renameSection(bay, ci, si, event.target.value)}
                                  />
                                ) : (section.name || "")}
                                {items.length > 0 && <i className="se-count">{onShelf}</i>}
                                {shortfall > 0 && <b>buy {shortfall}</b>}
                              </span>
                              <span className="se-shelf-run">
                                {items.map((p) => {
                                  // Each product owns a slot as wide as its share of the
                                  // shelf, filled up to what is actually there. The empty
                                  // part of the slot is the gap you can see on the shelf.
                                  const room = Math.max(1, Number(p.full) || 1);
                                  const on = Math.max(0, Number(p.stock) || 0);
                                  const filled = Math.min(100, Math.round((on / room) * 100));
                                  return (
                                    <span
                                      key={p.id}
                                      className={`se-slot${needOf(p) ? " short" : ""}${on === 0 ? " empty" : ""}`}
                                      style={{ flexGrow: room }}
                                      title={`${p.name} — ${on} on the shelf${p.full ? ` of ${p.full}` : ""}${needOf(p) ? `, buy ${needOf(p)}` : ""}`}
                                      onPointerDown={(event) => { event.stopPropagation(); grabProduct(event, p); }}
                                      onPointerMove={dragProduct}
                                      onPointerUp={dropProduct}
                                      onPointerCancel={cancelProductDrag}
                                    >
                                      <span className="se-fill" style={{ width: `${filled}%` }} />
                                      <span className="se-slot-text">
                                        <b>{p.name}</b>
                                        <i>{on}{p.full ? `/${p.full}` : ""}</i>
                                      </span>
                                    </span>
                                  );
                                })}
                              </span>
                              {si < column.sections.length - 1 && (
                                <span
                                  className={`se-divider ${rows ? "down" : "across"}${canEdit ? " editable" : ""}`}
                                  aria-label="Move this line"
                                  onPointerDown={(event) => grabDivider(event, bay, ci, si, rows ? "x" : "y")}
                                  onPointerMove={moveDivider}
                                  onPointerUp={endDivider}
                                  onPointerCancel={endDivider}
                                />
                              )}
                            </div>
                          );
                        })}
                        {ci < columns.length - 1 && (
                          <span
                            className={`se-divider ${rows ? "across" : "down"}${canEdit ? " editable" : ""}`}
                            aria-label="Move this line"
                            onPointerDown={(event) => grabDivider(event, bay, ci, null, rows ? "y" : "x")}
                            onPointerMove={moveDivider}
                            onPointerUp={endDivider}
                            onPointerCancel={endDivider}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="se-bay-foot">
                    <span>{bayItems.length} item{bayItems.length === 1 ? "" : "s"}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
