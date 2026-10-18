"use client";

import { useEffect, useState } from "react";
import { loadLiveState } from "./live-store";
import { balanceText, dayKey, type TillDay } from "./ShopDay";

// Owners' day-by-day view: for each open day, how the shop was opened and
// closed (float, cash balance, fridge check), and for each person who was in,
// when they signed in, what they did, and what they took. Anything that needs
// a second look is red.

type Sale = { at: string; staff: string; method: string; total: number; cashAmount?: number; cardAmount?: number; refunded?: boolean; stockOnly?: boolean };
type Move = { at: string; staff: string; reason: string };
type SignIn = { at: string; staff: string };
type Check = { date: string; at: string; staff: string; closed?: boolean };

const money = (n: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(n);
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const dayLabel = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

type Person = {
  name: string; firstSignIn?: string; first?: string; last?: string;
  sales: number; cash: number; card: number; perks: number; perkValue: number; waste: number; wasteValue: number; stockChanges: number; scans: number;
};

export function StaffByDay() {
  const [data, setData] = useState<{ sales: Sale[]; moves: Move[]; signIns: SignIn[]; days: TillDay[]; checks: Check[] } | null>(null);
  const [span, setSpan] = useState(14);
  useEffect(() => {
    void (async () => {
      const live = await loadLiveState();
      setData({
        sales: Array.isArray(live.sales) ? live.sales as Sale[] : [],
        moves: Array.isArray(live.stock_log) ? live.stock_log as Move[] : [],
        signIns: Array.isArray(live.sign_ins) ? live.sign_ins as SignIn[] : [],
        days: Array.isArray(live.till_days) ? live.till_days as TillDay[] : [],
        checks: Array.isArray(live.daily_checks) ? live.daily_checks as Check[] : [],
      });
    })();
  }, []);
  if (!data) return <article className="report-card staff-by-day"><div className="section-title"><h2>Staff by day</h2></div><div className="empty-report">Loading...</div></article>;

  const today = dayKey(new Date());
  const firstSignInRecord = data.signIns.reduce<string | null>((m, s) => (!m || s.at < m ? s.at : m), null);
  const rows: { date: string; people: Person[]; till?: TillDay; fridge?: Check; noTill: boolean; sunday: boolean }[] = [];
  for (let back = 0; back < span; back += 1) {
    const d = new Date(Date.now() - back * 86400000);
    const k = dayKey(d);
    const sunday = d.getDay() === 0;
    const people = new Map<string, Person>();
    const person = (name: string) => {
      if (!people.has(name)) people.set(name, { name, sales: 0, cash: 0, card: 0, perks: 0, perkValue: 0, waste: 0, wasteValue: 0, stockChanges: 0, scans: 0 });
      return people.get(name) as Person;
    };
    const touch = (p: Person, at: string) => { if (!p.first || at < p.first) p.first = at; if (!p.last || at > p.last) p.last = at; };
    for (const s of data.signIns) if (dayKey(new Date(s.at)) === k) { const p = person(s.staff); if (!p.firstSignIn || s.at < p.firstSignIn) p.firstSignIn = s.at; touch(p, s.at); }
    let salesToday = 0;
    for (const s of data.sales) {
      if (dayKey(new Date(s.at)) !== k) continue;
      salesToday += 1;
      const p = person(s.staff); touch(p, s.at);
      if (s.refunded) continue;
      if (s.method === "Owner's Perk") { p.perks += 1; p.perkValue += s.total; continue; }
      if (s.method === "Waste") { p.waste += 1; p.wasteValue += s.total; continue; }
      if (s.stockOnly) continue;
      p.sales += 1;
      const cash = typeof s.cashAmount === "number" ? s.cashAmount : s.method === "Cash" ? s.total : 0;
      p.cash += cash;
      p.card += typeof s.cardAmount === "number" ? s.cardAmount : s.method === "Card" ? s.total : Math.max(0, s.total - cash);
    }
    for (const m of data.moves) {
      if (dayKey(new Date(m.at)) !== k || ["sale", "waste", "perk"].includes(m.reason)) continue;
      const p = person(m.staff); touch(p, m.at);
      if (m.reason === "check") p.scans += 1; else p.stockChanges += 1;
    }
    const fridge = data.checks.filter((c) => c.date === k && !c.closed).sort((a, b) => a.at.localeCompare(b.at))[0];
    if (fridge && dayKey(new Date(fridge.at)) === k) touch(person(fridge.staff), fridge.at);
    rows.push({ date: k, people: [...people.values()].sort((a, b) => (a.first || "").localeCompare(b.first || "")), till: data.days.find((t) => t.date === k), fridge, noTill: salesToday === 0, sunday });
  }

  return (
    <article className="report-card staff-by-day">
      <div className="section-title">
        <h2>Staff by day</h2>
        <button type="button" className="primary-small" onClick={() => setSpan(span === 14 ? 60 : 14)}>{span === 14 ? "Show 60 days" : "Show 14 days"}</button>
      </div>
      <p className="cash-instruction">Red means it needs a look: no till use on an open day, float not confirmed, shop not closed, cash not balancing, or no fridge check.{firstSignInRecord ? ` Sign-in times are recorded from ${dayLabel(dayKey(new Date(firstSignInRecord)))}.` : " Sign-in times are recorded from today."}</p>
      {rows.map((r) => {
        if (r.sunday && r.noTill && !r.till && !r.people.length) return null;
        const past = r.date !== today;
        const balanced = r.till && typeof r.till.difference === "number" && Math.abs(r.till.difference) < 0.005;
        const flags = {
          noTill: past && r.noTill && !r.sunday,
          float: !r.till?.openedAt,
          notClosed: past && !r.till?.closedAt,
          cash: Boolean(r.till?.closedAt) && !balanced,
          fridge: !r.fridge && !r.sunday,
        };
        return (
          <div className={`sbd-day${flags.noTill || flags.cash ? " has-issue" : ""}`} key={r.date}>
            <div className="sbd-head">
              <strong>{dayLabel(r.date)}</strong>
              {flags.noTill && <span className="sbd-flag">No till use recorded</span>}
            </div>
            <div className="sbd-shop">
              <span className={flags.float ? "out" : ""}>{r.till?.openedAt ? `Opened ${time(r.till.openedAt)} by ${r.till.openedBy}, £50 float ✓` : "£50 float not confirmed"}</span>
              <span className={flags.notClosed ? "out" : ""}>{r.till?.closedAt ? `Closed ${time(r.till.closedAt)} by ${r.till.closedBy}` : past ? "Not closed" : "Still open"}</span>
              <span className={flags.cash ? "out" : ""}>{r.till?.closedAt ? `Cash ${money(r.till.cashSales || 0)}, counted ${money(r.till.takingsCounted || 0)}: ${balanceText(r.till)}` : ""}</span>
              <span className={flags.fridge ? "out" : ""}>{r.fridge ? `Fridge check ${time(r.fridge.at)} by ${r.fridge.staff}${dayKey(new Date(r.fridge.at)) !== r.date ? " (entered late)" : ""}` : "No fridge check"}</span>
              {r.till?.note && <small>Closing note: {r.till.note}</small>}
            </div>
            {r.people.length > 0 && (
              <div className="sbd-table">
                <div className="sbd-row sbd-row-head"><b>Staff</b><b>Signed in</b><b>Last active</b><b>Sales</b><b>Cash</b><b>Card</b><b>Perks</b><b>Write-offs</b><b>Stock</b></div>
                {r.people.map((p) => (
                  <div className="sbd-row" key={p.name}>
                    <strong>{p.name}</strong>
                    <span>{p.firstSignIn ? time(p.firstSignIn) : "-"}</span>
                    <span>{p.last ? time(p.last) : "-"}</span>
                    <span>{p.sales}</span>
                    <span>{money(p.cash)}</span>
                    <span>{money(p.card)}</span>
                    <span className={p.perks ? "warn" : ""}>{p.perks ? `${p.perks} (${money(p.perkValue)})` : "-"}</span>
                    <span>{p.waste ? `${p.waste} (${money(p.wasteValue)})` : "-"}</span>
                    <span>{p.stockChanges || p.scans ? `${p.stockChanges} changes${p.scans ? `, ${p.scans} scans` : ""}` : "-"}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </article>
  );
}
