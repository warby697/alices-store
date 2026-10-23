"use client";

import { useEffect, useState } from "react";
import { SESSION_RESTORED_EVENT, loadLiveState, saveLiveStateNow } from "./live-store";

// Daily food-safety checks, for every staff member. Built to satisfy an
// Environmental Health inspection following FSA "Safer Food, Better Business"
// guidance: the ACTUAL temperature is written down (a number, not just a
// tick), out-of-range readings must record the action taken, and each saved
// check records who did it and when. The app marks each reading in or out of
// the safe range automatically, so staff still just type one number per unit.
//
// A missed day can be filled in afterwards: the record keeps BOTH the day it
// covers and the real moment it was entered, so a late entry is honest, not
// hidden. A day the shop was closed can be marked as such, keeping the log
// gap-free. Records are kept for 12 months (FSA due-diligence guidance); the
// log shows the last 3 days plus any missing days, with a full 3-month view
// for inspections.

const UNITS = [
  { key: "main-fridge", name: "Main Fridge", freezer: false, min: -1, max: 6, ideal: "0–5°C" },
  // Holds no food, so it is allowed up to 8°C (owner's decision, 14 Oct 2026).
  // The Temp and Staff fridges hold nothing for customers: their readings are
  // optional and never flagged red (owner's decision, 16 Oct 2026).
  { key: "temp-fridge", name: "Temp Fridge", freezer: false, min: -1, max: 8, ideal: "up to 8°C", note: "No food stored", noFlag: true },
  { key: "cake-fridge", name: "Cake Fridge", freezer: false, min: -1, max: 6, ideal: "0–5°C" },
  { key: "staff-fridge", name: "Staff Fridge", freezer: false, min: -1, max: 6, ideal: "0–5°C", note: "Staff use only - no food for customers", noFlag: true },
  { key: "main-freezer", name: "Main Freezer", freezer: true, min: -99, max: -17, ideal: "−18°C or colder" },
  { key: "ice-cream-freezer", name: "Ice Cream Freezer", freezer: true, min: -99, max: -17, ideal: "−18°C or colder" },
] as const;

type UnitReading = { name: string; temp: number; ok: boolean; action?: string; note?: string };
const noteFor = (name: string): string | undefined => {
  const unit = UNITS.find((u) => u.name === name) as { note?: string } | undefined;
  return unit?.note;
};
const neverFlags = (name: string) => Boolean((UNITS.find((u) => u.name === name) as { noFlag?: boolean } | undefined)?.noFlag);
// A reading is shown as a problem only if its unit can matter and it was out
// of range - so old Temp/Staff fridge readings saved as "out" no longer show red.
const isFlagged = (u: UnitReading) => !u.ok && !neverFlags(u.name);
type DailyCheck = {
  id: string;
  date: string; // the day this check covers (YYYY-MM-DD)
  at: string; // when it was actually entered
  staff: string;
  units: UnitReading[];
  datesChecked: boolean; // bread, cakes and chilled items date-checked
  closed?: boolean; // shop closed that day - no readings expected
};

const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_MS = 366 * DAY_MS; // keep 12 months of records
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dayLabel = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

export function DailyChecks({ staff }: { staff: string }) {
  const [checks, setChecks] = useState<DailyCheck[]>([]);
  const [ready, setReady] = useState(false);
  const [loadedAt] = useState(() => Date.now());
  const [temps, setTemps] = useState<Record<string, string>>({});
  const [actions, setActions] = useState<Record<string, string>>({});
  const [datesChecked, setDatesChecked] = useState(false);
  const [forDate, setForDate] = useState(() => dayKey(new Date(Date.now())));
  const [fullLog, setFullLog] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [addingAnother, setAddingAnother] = useState(false);

  const today = dayKey(new Date(loadedAt));

  useEffect(() => {
    const load = async () => {
      const live = await loadLiveState();
      if (!Object.keys(live).length) return;
      setChecks(Array.isArray(live.daily_checks) ? (live.daily_checks as DailyCheck[]) : []);
      setReady(true);
    };
    void load();
    // Signed back in after the 12 hours ran out: fetch what was refused.
    const reload = () => void load();
    window.addEventListener(SESSION_RESTORED_EVENT, reload);
    return () => window.removeEventListener(SESSION_RESTORED_EVENT, reload);
  }, []);

  // A freezer reading is typed WITHOUT the minus sign (the box shows a fixed
  // minus), because phone number keyboards often have no minus key.
  const readingFor = (unit: (typeof UNITS)[number]): number | null => {
    const raw = (temps[unit.key] || "").trim();
    if (!raw) return null;
    const value = Number(raw);
    if (!Number.isFinite(value)) return null;
    return unit.freezer ? -Math.abs(value) : value;
  };

  const rows = UNITS.map((unit) => {
    const value = readingFor(unit);
    const noFlag = "noFlag" in unit && unit.noFlag;
    return { unit, value, noFlag, ok: value === null ? null : noFlag ? true : value >= unit.min && value <= unit.max };
  });
  const missingTemps = rows.filter((row) => row.value === null && !row.noFlag);
  const failures = rows.filter((row) => row.ok === false);
  const missingActions = failures.filter((row) => !(actions[row.unit.key] || "").trim());
  const canSave = ready && !saving && !missingTemps.length && !missingActions.length && datesChecked;

  const checkedDays = new Set(checks.map((check) => check.date));
  // Days with no record at all, from yesterday back a fortnight - but never
  // before the very first record, so the log doesn't nag about the time
  // before this page existed.
  const earliest = checks.length ? checks.reduce((min, check) => (check.date < min ? check.date : min), checks[0].date) : today;
  const missingDays: string[] = [];
  for (let back = 1; back <= 14; back += 1) {
    const date = new Date(loadedAt - back * DAY_MS);
    const day = dayKey(date);
    if (day < earliest) break;
    // The shop is closed on Sundays - no check is expected, so never flag one.
    if (date.getDay() === 0) continue;
    if (!checkedDays.has(day)) missingDays.push(day);
  }

  const persist = async (record: DailyCheck) => {
    // Build on the latest saved list, never on what this screen loaded - if
    // that load was refused (signed out) or is hours old, writing it back
    // would wipe other people's checks.
    const live = await loadLiveState();
    if (!Object.keys(live).length) throw new Error("Couldn't reach the shop records - enter your PIN if asked, then press save again");
    const latest = Array.isArray(live.daily_checks) ? (live.daily_checks as DailyCheck[]) : [];
    const next = [record, ...latest.filter((c) => c.id !== record.id)]
      .filter((check) => loadedAt - new Date(check.at).getTime() < KEEP_MS)
      .sort((a, b) => b.date.localeCompare(a.date) || b.at.localeCompare(a.at));
    await saveLiveStateNow({ daily_checks: next });
    setChecks(next);
  };

  const saveCheck = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await persist({
        id: crypto.randomUUID(),
        date: forDate,
        at: new Date().toISOString(),
        staff,
        units: rows.filter((row) => row.value !== null).map((row) => ({
          name: row.unit.name,
          temp: row.value as number,
          ok: Boolean(row.ok),
          action: row.ok === false ? (actions[row.unit.key] || "").trim() : undefined,
          note: "note" in row.unit ? row.unit.note : undefined,
        })),
        datesChecked: true,
      });
      setTemps({});
      setActions({});
      setDatesChecked(false);
      setNotice(`Saved for ${forDate === today ? "today" : dayLabel(forDate)} - checked by ${staff}`);
      setAddingAnother(false);
      setForDate(today);
    } catch (error) {
      setNotice(error instanceof Error ? `NOT SAVED: ${error.message}` : "NOT SAVED - please try again");
    } finally {
      setSaving(false);
    }
  };

  const markClosed = async (date: string) => {
    if (saving) return;
    setSaving(true);
    try {
      await persist({ id: crypto.randomUUID(), date, at: new Date().toISOString(), staff, units: [], datesChecked: false, closed: true });
      setNotice(`${dayLabel(date)} marked as shop closed`);
    } catch (error) {
      setNotice(error instanceof Error ? `NOT SAVED: ${error.message}` : "NOT SAVED - please try again");
    } finally {
      setSaving(false);
    }
  };

  const shownDays = fullLog ? 92 : 3;
  const shown = checks.filter((check) => loadedAt - new Date(`${check.date}T00:00:00`).getTime() < shownDays * DAY_MS);
  const todaysChecks = checks.filter((check) => check.date === today && !check.closed);
  const latestToday = todaysChecks.slice().sort((a, b) => b.at.localeCompare(a.at))[0];
  const showResults = Boolean(latestToday) && !addingAnother && forDate === today;

  return (
    <section className="daily-checks">
      <article className="report-card admin-form dc-entry">
        <div className="section-title">
          <h2>{forDate === today ? "Today's check" : `Check for ${dayLabel(forDate)}`}</h2>
          <span>{todaysChecks.length ? `Done ${todaysChecks.length}× today` : "Not done yet today"}</span>
        </div>
        {missingDays.length > 0 && (
          <button
            type="button"
            className="dc-missing-banner"
            onClick={() => document.querySelector(".dc-log")?.scrollIntoView({ behavior: "smooth" })}
          >
            ⚠ {missingDays.length === 1 ? `${dayLabel(missingDays[0])} has no check recorded` : `${missingDays.length} days have no check recorded`} - tap to sort it out below
          </button>
        )}
        {missingDays.length > 0 && (
          <label className="dc-fordate">
            Recording for
            <select value={forDate} onChange={(e) => setForDate(e.target.value)}>
              <option value={today}>Today</option>
              {missingDays.map((day) => (
                <option key={day} value={day}>{dayLabel(day)} (missed)</option>
              ))}
            </select>
          </label>
        )}
        {notice && <p className="cash-instruction">{notice}</p>}
        {showResults && latestToday && (
          <div className={`dc-results${latestToday.units.some(isFlagged) || !latestToday.datesChecked ? " has-issue" : ""}`}>
            <p className="dc-results-head">
              <strong>{latestToday.units.some(isFlagged) ? "⚠ Done - something needs attention" : "✓ Done - all in range"}</strong>
              <span>{new Date(latestToday.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} by {latestToday.staff}</span>
            </p>
            {latestToday.units.map((u) => (
              <div className={`dc-result-row${isFlagged(u) ? " out" : ""}`} key={u.name}>
                <span>{u.name}{(u.note || noteFor(u.name)) && <em className="dc-unit-note">{u.note || noteFor(u.name)}</em>}</span>
                <b>{u.temp}°C {neverFlags(u.name) ? "" : u.ok ? "✓" : "✗"}</b>
                {isFlagged(u) && u.action && <small>Action: {u.action}</small>}
              </div>
            ))}
            <div className={`dc-result-row${latestToday.datesChecked ? "" : " out"}`}>
              <span>Bread, cakes and chilled date check</span>
              <b>{latestToday.datesChecked ? "✓" : "✗"}</b>
            </div>
            <button type="button" className="primary-small" onClick={() => { setAddingAnother(true); setNotice(""); }}>Record another check</button>
          </div>
        )}
        {!showResults && rows.map(({ unit, ok }) => (
          <div className={`dc-unit${ok === false ? " out" : ok === true ? " in" : ""}`} key={unit.key}>
            <div className="dc-unit-name">
              <strong>{unit.name}</strong>
              <small>{unit.ideal}</small>
              {"note" in unit && <em className="dc-unit-note">{unit.note}</em>}
            </div>
            <label className="dc-temp">
              {unit.freezer && <b>−</b>}
              <input
                type="number"
                inputMode="decimal"
                step="0.5"
                placeholder="°C"
                aria-label={`${unit.name} temperature in degrees C${unit.freezer ? " (minus is filled in for you)" : ""}`}
                value={temps[unit.key] || ""}
                onChange={(e) => setTemps({ ...temps, [unit.key]: e.target.value })}
              />
            </label>
            <b className="dc-verdict" aria-label={ok === null ? "no reading yet" : ok ? "within safe range" : "outside safe range"}>
              {ok === null ? "" : ok ? "✓" : "✗"}
            </b>
            {ok === false && !("noFlag" in unit && unit.noFlag) && (
              <input
                className="dc-action"
                value={actions[unit.key] || ""}
                onChange={(e) => setActions({ ...actions, [unit.key]: e.target.value })}
                placeholder="Out of range - what did you do? e.g. moved stock, adjusted dial, called for repair"
              />
            )}
          </div>
        ))}
        {!showResults && <>
        <label className="toggle-row dc-dates">
          <input type="checkbox" checked={datesChecked} onChange={(e) => setDatesChecked(e.target.checked)} />
          All bread, cakes and chilled items date checked - anything out of date removed
        </label>
        <button className="pay-button" disabled={!canSave} onClick={() => void saveCheck()}>
          {saving ? "Saving..." : forDate === today ? `Save today's check as ${staff}` : `Save check for ${dayLabel(forDate)} as ${staff}`}
        </button>
        {!canSave && !saving && (
          <p className="dc-hint">
            {missingTemps.length
              ? "Enter a temperature for every unit."
              : missingActions.length
                ? "Say what was done about the out-of-range reading."
                : !datesChecked
                  ? "Tick the date-check box to confirm it has been done."
                  : ""}
          </p>
        )}
        </>}
      </article>
      <article className="report-card dc-log">
        <div className="section-title">
          <h2>Check log</h2>
          <button className="primary-small" onClick={() => setFullLog(!fullLog)}>{fullLog ? "Show last 3 days" : "Show 3 months"}</button>
        </div>
        {missingDays.map((day) => (
          <div className="dc-missing" key={day}>
            <strong>{dayLabel(day)} - no check recorded</strong>
            <span>
              <button type="button" onClick={() => { setForDate(day); setNotice(""); }}>Record it</button>
              <button type="button" onClick={() => void markClosed(day)}>Shop was closed</button>
            </span>
          </div>
        ))}
        {shown.length ? (
          shown.map((check) => (
            <div className={`dc-record${!check.closed && check.units.some(isFlagged) ? " has-issue" : ""}`} key={check.id}>
              <div className="dc-record-head">
                <strong>
                  {dayLabel(check.date)}
                  {check.closed
                    ? " · Shop closed"
                    : ` · ${new Date(check.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`}
                  {!check.closed && check.date !== check.at.slice(0, 10) && (
                    <em className="dc-late"> (entered {dayLabel(check.at.slice(0, 10))})</em>
                  )}
                </strong>
                <span>{check.staff}</span>
              </div>
              {!check.closed && (
                <div className="dc-record-units">
                  {check.units.map((u) => (
                    <span key={u.name} className={isFlagged(u) ? "out" : ""}>
                      {u.name} {u.temp}° {neverFlags(u.name) ? "" : u.ok ? "✓" : "✗"}
                      {(u.note || noteFor(u.name)) && <em className="dc-unit-note">({u.note || noteFor(u.name)})</em>}
                    </span>
                  ))}
                  <span className={check.datesChecked ? "" : "out"}>Dates {check.datesChecked ? "✓" : "✗"}</span>
                </div>
              )}
              {!check.closed && check.units.filter((u) => isFlagged(u) && u.action).map((u) => (
                <p className="dc-record-action" key={u.name}>
                  {u.name}: {u.action}
                </p>
              ))}
            </div>
          ))
        ) : (
          <div className="empty-report">No checks recorded yet. Today&apos;s will be the first.</div>
        )}
        {fullLog && <button className="primary-small dc-print-bottom" onClick={() => window.print()}>Print for inspection</button>}
      </article>
    </section>
  );
}
