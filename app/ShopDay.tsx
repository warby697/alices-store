"use client";

import { useState } from "react";
import { tillDayNow } from "./live-store";

// Opening and closing the shop. Volunteers only - no wages come out of the
// till - so the cash balances exactly: £50 float in the morning, and at
// closing the takings taken out equal the day's cash sales, with £50 left.

export const FLOAT = 50;

export type TillDay = {
  date: string;
  openedAt?: string;
  openedBy?: string;
  floatConfirmed?: boolean;
  closedAt?: string;
  closedBy?: string;
  cashSales?: number;
  takingsCounted?: number;
  difference?: number;
  floatLeft?: boolean;
  note?: string;
};

type SaleLike = { at: string; method?: string; total?: number; cashAmount?: number; refunded?: boolean; stockOnly?: boolean };

const money = (n: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(n);
const time = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "");
export const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dayLabel = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

export function cashSalesOn(sales: SaleLike[], date: string) {
  const n = sales
    .filter((s) => !s.refunded && !s.stockOnly && dayKey(new Date(s.at)) === date)
    .reduce((sum, s) => sum + (typeof s.cashAmount === "number" ? s.cashAmount : s.method === "Cash" ? Number(s.total) || 0 : 0), 0);
  return Math.round(n * 100) / 100;
}

export function balanceText(day: TillDay) {
  if (typeof day.difference !== "number") return "";
  if (Math.abs(day.difference) < 0.005) return "Balanced";
  return day.difference < 0 ? `${money(-day.difference)} short` : `${money(day.difference)} over`;
}

// The morning prompt: confirm the £50 float before trading.
export function OpenShopPrompt({ onOpened, onLater }: { onOpened: (days: TillDay[]) => void; onLater: () => void }) {
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const confirm = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await tillDayNow("open");
      onOpened(result.days as unknown as TillDay[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save - please try again");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop check-due-backdrop">
      <div className="check-due-modal shop-day-modal" role="alertdialog" aria-labelledby="open-shop-title">
        <p className="eyebrow">Opening the shop</p>
        <h2 id="open-shop-title">Is the £50 cash float in the drawer?</h2>
        <p>Count the float before serving anyone. It should be exactly £50.</p>
        <label className="toggle-row shop-day-tick">
          <input type="checkbox" checked={ticked} onChange={(e) => setTicked(e.target.checked)} />
          Yes - £50 counted and in the drawer
        </label>
        {error && <p className="restock-error">{error}</p>}
        <button type="button" className="pay-button" disabled={!ticked || busy} onClick={() => void confirm()}>{busy ? "Saving..." : "Confirm float and open"}</button>
        <button type="button" className="cash-shortcut" onClick={onLater}>Not opening the shop right now</button>
      </div>
    </div>
  );
}

// Closing up: take out the takings, leave £50, record what was counted.
export function CloseShopForm({ cashSales, onClosed, onCancel, finishLabel = "Done" }: { cashSales: number; onClosed: (days: TillDay[]) => void; onCancel: () => void; finishLabel?: string }) {
  const [counted, setCounted] = useState("");
  const [floatLeft, setFloatLeft] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ day: TillDay; days: TillDay[] } | null>(null);
  const countedValue = counted === "" ? NaN : Number(counted);
  const mismatch = Number.isFinite(countedValue) && Math.abs(countedValue - cashSales) >= 0.005;
  const canSave = Number.isFinite(countedValue) && countedValue >= 0 && floatLeft && (!mismatch || note.trim().length > 0) && !busy;
  // Say exactly what is still needed, so a greyed-out button is never a mystery.
  const missing = !Number.isFinite(countedValue) || countedValue < 0 ? "Enter the takings counted above"
    : !floatLeft ? "Tick the £50 float box"
    : mismatch && !note.trim() ? "Say what happened (it doesn't balance)"
    : "";

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError("");
    try {
      const r = await tillDayNow("close", { takingsCounted: countedValue, floatLeft: true, note: note.trim() || undefined });
      setResult({ day: r.day as unknown as TillDay, days: r.days as unknown as TillDay[] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save - please try again");
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    const balanced = typeof result.day.difference === "number" && Math.abs(result.day.difference) < 0.005;
    return (
      <div className={`close-shop-result${balanced ? "" : " has-issue"}`}>
        <h2>{balanced ? "✓ Cash balances" : `⚠ ${balanceText(result.day)}`}</h2>
        <p>Cash sales today {money(result.day.cashSales || 0)} · takings counted {money(result.day.takingsCounted || 0)} · £50 float left in the drawer.</p>
        <p>Closed by {result.day.closedBy} at {time(result.day.closedAt)}.</p>
        <button type="button" className="pay-button" onClick={() => onClosed(result.days)}>{finishLabel}</button>
      </div>
    );
  }

  return (
    <div className="close-shop-form">
      <p className="eyebrow">Closing the shop</p>
      <h2>Cash sales today: {money(cashSales)}</h2>
      <ol className="close-shop-steps">
        <li>Take today&apos;s takings out of the drawer, <strong>leaving exactly £50</strong> for tomorrow.</li>
        <li>Count the takings you took out and enter it below. It should be {money(cashSales)}.</li>
      </ol>
      <label className="close-shop-count">
        Takings counted
        <span className="money-input">£<input type="number" inputMode="decimal" min="0" step="0.01" value={counted} onChange={(e) => setCounted(e.target.value)} placeholder="Type the amount" /></span>
      </label>
      <button type="button" className="close-shop-exact" onClick={() => setCounted(cashSales.toFixed(2))}>✓ I counted exactly {money(cashSales)}</button>
      {Number.isFinite(countedValue) && (
        <p className={`close-shop-check${mismatch ? " out" : ""}`}>
          {mismatch ? (countedValue < cashSales ? `${money(cashSales - countedValue)} short` : `${money(countedValue - cashSales)} over`) : "✓ Matches today's cash sales"}
        </p>
      )}
      <label className="toggle-row shop-day-tick">
        <input type="checkbox" checked={floatLeft} onChange={(e) => setFloatLeft(e.target.checked)} />
        £50 float left in the drawer for tomorrow
      </label>
      {mismatch && (
        <label className="close-shop-note">
          It doesn&apos;t balance - what happened?
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. paid for milk from the till, customer short-changed" />
        </label>
      )}
      {error && <p className="restock-error">{error}</p>}
      <button type="button" className="pay-button" disabled={!canSave} onClick={() => void save()}>{busy ? "Saving..." : missing || "Confirm and close the shop"}</button>
      <button type="button" className="cash-shortcut" onClick={onCancel}>Go back</button>
    </div>
  );
}

// The Cash page: today's opening and closing, and the last 30 days.
export function ShopDays({ days, sales, onChange }: { days: TillDay[]; sales: SaleLike[]; onChange: (days: TillDay[]) => void }) {
  const [closing, setClosing] = useState(false);
  const [opening, setOpening] = useState(false);
  const today = dayKey(new Date());
  const todayDay = days.find((d) => d.date === today);
  const cashToday = cashSalesOn(sales, today);
  const history: string[] = [];
  for (let back = 0; back < 30; back += 1) {
    const d = new Date(Date.now() - back * 86400000);
    const k = dayKey(d);
    const hasSales = sales.some((s) => dayKey(new Date(s.at)) === k);
    if (d.getDay() === 0 && !hasSales && !days.some((x) => x.date === k)) continue;
    history.push(k);
  }
  return (
    <section className="shop-days">
      <article className="report-card shop-today">
        <div className="section-title"><h2>Today</h2><span>{dayLabel(today)}</span></div>
        <div className="shop-today-rows">
          <p><strong>Opened:</strong> {todayDay?.openedAt ? `${time(todayDay.openedAt)} by ${todayDay.openedBy} - £50 float confirmed` : "Not yet - float not confirmed"}</p>
          <p><strong>Cash sales so far:</strong> {money(cashToday)}</p>
          <p><strong>Closed:</strong> {todayDay?.closedAt ? `${time(todayDay.closedAt)} by ${todayDay.closedBy} - counted ${money(todayDay.takingsCounted || 0)} (${balanceText(todayDay)})` : "Not yet"}</p>
        </div>
        {!todayDay?.openedAt && !opening && <button type="button" className="primary-small" onClick={() => setOpening(true)}>Confirm the £50 float</button>}
        {!todayDay?.closedAt && !closing && <button type="button" className="danger-button" onClick={() => setClosing(true)}>Close the shop for today</button>}
        {closing && <CloseShopForm cashSales={cashToday} onClosed={(next) => { onChange(next); setClosing(false); }} onCancel={() => setClosing(false)} />}
      </article>
      {opening && <OpenShopPrompt onOpened={(next) => { onChange(next); setOpening(false); }} onLater={() => setOpening(false)} />}
      <article className="report-card shop-history">
        <div className="section-title"><h2>Last 30 days</h2><span>Cash must balance exactly</span></div>
        {history.map((k) => {
          const d = days.find((x) => x.date === k);
          const cash = cashSalesOn(sales, k);
          const balanced = d && typeof d.difference === "number" && Math.abs(d.difference) < 0.005;
          const problem = k !== today && (!d?.openedAt || !d?.closedAt || !balanced);
          return (
            <div className={`shop-history-row${problem ? " has-issue" : ""}`} key={k}>
              <strong>{dayLabel(k)}</strong>
              <span>{d?.openedAt ? `Opened ${time(d.openedAt)} by ${d.openedBy}` : "Float not confirmed"}</span>
              <span>{d?.closedAt ? `Closed ${time(d.closedAt)} by ${d.closedBy}` : k === today ? "Open" : "Not closed"}</span>
              <span>Cash sales {money(d?.cashSales ?? cash)}</span>
              <b>{d?.closedAt ? `${money(d.takingsCounted || 0)} counted - ${balanceText(d)}` : "-"}</b>
              {d?.note && <small>{d.note}</small>}
            </div>
          );
        })}
      </article>
    </section>
  );
}
