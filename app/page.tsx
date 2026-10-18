"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AdminPanel } from "./AdminPanel";
import { CloseShopForm, OpenShopPrompt, ShopDays, cashSalesOn, type TillDay } from "./ShopDay";
import { StaffByDay } from "./StaffByDay";
import { DailyChecks } from "./DailyChecks";
import { PriorityBackfill } from "./PriorityBackfill";
import { StockStepper } from "./StockStepper";
import { YodeymaOrders, type YodeymaOrder } from "./YodeymaOrders";
import { adjustStockNow, completeLiveSale, deleteProductNow, loadLiveState, readCachedCatalogue, refundSaleNow, saveLiveState, saveProductNow, writeCachedCatalogue } from "./live-store";
import { isLowStock } from "./stock-levels";

type Product = {
  id: string;
  name: string;
  price: number;
  cost: number;
  stock: number;
  category: string;
  full?: number;
  lowStockLevel?: number;
  barcode?: string;
  caseBarcode?: string;
  caseQuantity?: number;
  colour: string;
  quick?: boolean;
  supplier?: string;
  size?: string;
  notes?: string;
  keyProduct?: boolean;
  stockConfirmed?: boolean;
  backfillSkipped?: boolean;
  tillSetupConfirmed?: boolean; discontinued?: boolean;
  // Set by the server when the till sells something the screen said was out of
  // stock - the shelf clearly needs counting. Cleared by any deliberate stock
  // change (restock steppers, edit modal, priority backfill).
  recount?: boolean;
  // Loose items (bananas, served coffee, cakes): sold and reported as normal,
  // but stock is never counted - no number, no low-stock or recount warnings.
  noStockCount?: boolean;
  // The same shelf item bought from different shops can carry different
  // barcodes (Lidl bleach vs Home Bargains bleach). Extra codes collect here
  // and all ring up / restock the one product.
  altBarcodes?: string[];
};
type CartLine = { product: Product; quantity: number; price?: number };
// What this line actually sells for: the override if one was typed in at the
// till, otherwise the shelf price.
const linePrice = (line: CartLine) => (typeof line.price === "number" ? line.price : line.product.price);
const dayKeyOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const checkDaysFrom = (raw: unknown): string[] =>
  Array.isArray(raw) ? (raw as { date?: unknown }[]).map((c) => c?.date).filter((d): d is string => typeof d === "string") : [];
type PaymentMethod = "Cash" | "Card" | "Split";
type TransactionMethod = PaymentMethod | "Owner's Perk" | "Waste";
type Sale = {
  id: string;
  at: string;
  staff: string;
  method: TransactionMethod;
  total: number;
  cashAmount?: number;
  cardAmount?: number;
  cardFee?: number;
  items: { id: string; name: string; quantity: number; price: number }[];
  refunded?: boolean;
  stockOnly?: boolean;
};
type Staff = {
  name: string;
  initials: string;
  accessible?: boolean;
  admin?: boolean;
};

const money = (value: number) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(
    value,
  );
const todayKey = () => { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
// Minimum sensible sale price for a cost, honouring the target margin set in
// Admin > Controls (rounded up to the nearest 5p).
const recommendedPrice = (cost: number, marginPercent: number) => Math.ceil(cost * (1 + marginPercent / 100) * 20) / 20;

// Does this barcode belong to this product - its main barcode or any of the
// extra codes it has collected from other shops' versions of the same item?
const ownsBarcode = (product: { barcode?: string; altBarcodes?: string[] }, code: string) =>
  product.barcode === code || (product.altBarcodes || []).includes(code);
const baseSuppliers = ["Lidl", "Iceland", "Home Bargains", "Heron"];

// Supplier picker: a dropdown of known suppliers plus "Add new supplier..."
// which reveals a text box. Whatever is chosen or typed is saved on the
// product; a brand-new name is registered as a supplier by the admin panel the
// moment it sees a product using it, so it then shows up here and in Shopping.
function SupplierField({ value, options, onChange }: { value: string; options: string[]; onChange: (value: string) => void }) {
  const known = options.includes(value);
  const [adding, setAdding] = useState(Boolean(value) && !known);
  return (
    <label>
      Usual supplier
      <select
        value={adding ? "__new" : known ? value : ""}
        onChange={(e) => {
          if (e.target.value === "__new") { setAdding(true); onChange(""); }
          else { setAdding(false); onChange(e.target.value); }
        }}
      >
        <option value="">No supplier</option>
        {options.map((name) => <option key={name} value={name}>{name}</option>)}
        <option value="__new">Add new supplier...</option>
      </select>
      {adding && <input autoFocus value={value} placeholder="New supplier name" onChange={(e) => onChange(e.target.value)} />}
    </label>
  );
}

const greetingFor = (date: Date) => {
  const hour = date.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
};

export default function Home() {
  const [staff, setStaff] = useState<Staff | null>(null);
  const [pin, setPin] = useState("");
  // The till often sits on the sign-in screen untouched for hours, so the
  // greeting is re-checked on a timer rather than only when something renders.
  const [greeting, setGreeting] = useState(() => greetingFor(new Date()));
  useEffect(() => {
    const timer = setInterval(() => setGreeting(greetingFor(new Date())), 60_000);
    return () => clearInterval(timer);
  }, []);
  const [loginError, setLoginError] = useState("");
  const [view, setView] = useState<
    "checkout" | "cash" | "checks" | "orders" | "backfill" | "products" | "reports" | "admin"
  >("checkout");
  const [products, setProducts] = useState<Product[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [yodeymaOrders, setYodeymaOrders] = useState<YodeymaOrder[]>([]);
  // Days that have a fridge check (or are marked closed), so the till can
  // insist on today's check from the moment someone signs in.
  const [checkedDays, setCheckedDays] = useState<string[] | null>(null);
  const [checkPromptOpen, setCheckPromptOpen] = useState(false);
  // Opening (£50 float) and closing (takings counted) the shop each day.
  const [tillDays, setTillDays] = useState<TillDay[] | null>(null);
  const [floatPromptOpen, setFloatPromptOpen] = useState(false);
  const [signOutStep, setSignOutStep] = useState<null | "ask" | "close">(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [category, setCategory] = useState("Most popular");
  const [search, setSearch] = useState("");
  const [scanValue, setScanValue] = useState("");
  const [notice, setNotice] = useState("");
  const [payment, setPayment] = useState<"Choose" | TransactionMethod | null>(null);
  const [splitCash, setSplitCash] = useState("");
  const [cashReceived, setCashReceived] = useState("");
  const [editingPrice, setEditingPrice] = useState<string | null>(null);
  const [priceDraft, setPriceDraft] = useState("");
  const cashReceivedRef = useRef<HTMLInputElement>(null);
  const productSearchRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<Product | null>(null);
  // Deleting asks for a second tap inside the till itself. The browser's own
  // "are you sure?" pop-up can be switched off on a device ("prevent this page
  // from creating dialogs"), and then it silently answers no - which made
  // Delete look broken in the shop.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  useEffect(() => { setConfirmDeleteId(null); }, [editing?.id]);
  const [hydrated, setHydrated] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);
  const scannerBuffer = useRef("");
  const scannerTime = useRef(0);
  const scannerIdle = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The stock number showing when the product editor was opened. Saving sends
  // the DIFFERENCE from this, so "I added 4" stays "add 4" even if the shelf
  // count moved (a sale on another till) while the editor was open.
  const editingBaseStock = useRef(0);
  // Quick restock on the Stock page: the product last scanned, the running
  // "added this scan" tally shown to staff, and the taps not yet saved. Taps
  // are batched for half a second so five quick +1s become one server call.
  const [restockId, setRestockId] = useState<string | null>(null);
  const [restockAdded, setRestockAdded] = useState(0);
  const [restockPendingView, setRestockPendingView] = useState(0);
  const [restockNotice, setRestockNotice] = useState("");
  const restockPending = useRef(0);
  const restockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Every scan on the Stock page is logged as "checked" - including scans
  // where the count needs no change, and barcodes the system doesn't know.
  // Scans queue on the device (so a rapid burst, a dropped signal or a page
  // closed mid-send can't lose one), go to the server in batches, and leave
  // the queue only once the server has confirmed them.
  const scanQueue = useRef<string[]>([]);
  const scanTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scanSending = useRef(false);
  const SCAN_QUEUE_KEY = "alices-store.scan-checks.v1";
  const saveScanQueue = () => {
    try { localStorage.setItem(SCAN_QUEUE_KEY, JSON.stringify(scanQueue.current)); } catch { /* storage full or blocked */ }
  };
  const flushScans = async () => {
    if (scanSending.current || !scanQueue.current.length) return;
    scanSending.current = true;
    const batch = scanQueue.current.slice(0, 150);
    try {
      await adjustStockNow(batch.map((id) => ({ id, delta: 0 })), { keepRecount: true, reason: "check" });
      scanQueue.current = scanQueue.current.slice(batch.length);
      saveScanQueue();
    } catch {
      // No signal or a busy server: keep them and try again shortly.
      if (scanTimer.current) clearTimeout(scanTimer.current);
      scanTimer.current = setTimeout(() => void flushScans(), 5000);
    } finally {
      scanSending.current = false;
    }
    if (scanQueue.current.length) {
      if (scanTimer.current) clearTimeout(scanTimer.current);
      scanTimer.current = setTimeout(() => void flushScans(), 1200);
    }
  };
  const logScan = (id: string) => {
    scanQueue.current.push(id);
    saveScanQueue();
    if (scanTimer.current) clearTimeout(scanTimer.current);
    scanTimer.current = setTimeout(() => void flushScans(), 1200);
  };
  // Anything left on the device from last time (closed tab, lost signal) goes now.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SCAN_QUEUE_KEY) || "[]");
      if (Array.isArray(saved) && saved.length) {
        scanQueue.current = saved.filter((x: unknown): x is string => typeof x === "string");
        scanTimer.current = setTimeout(() => void flushScans(), 2000);
      }
    } catch { /* nothing saved */ }
    return () => { if (scanTimer.current) clearTimeout(scanTimer.current); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // An unknown barcode on the Stock page: hold it while staff choose between
  // "new product" and "another barcode for something we already sell".
  const [unknownCode, setUnknownCode] = useState<string | null>(null);
  const [aliasSearch, setAliasSearch] = useState("");
  // Quick "how many when full?" entry on the restock card for products
  // without a full-shelf target - fills the shopping list's biggest gap.
  const [fullDraft, setFullDraft] = useState("");
  // Which stretch the reports "Top selling products" list covers.
  const [topPeriod, setTopPeriod] = useState<"today" | "fortnight">("today");
  // Refund tools on the Reports page.
  const [refundingId, setRefundingId] = useState("");
  const [refundNotice, setRefundNotice] = useState("");
  // Target margin % from Admin > Controls - drives the minimum-price hint.
  const [targetMargin, setTargetMargin] = useState(30);
  // Saving in the background is what makes the till feel instant, but it opens a
  // window where a closed tab would lose a transaction. Count what is in flight
  // and make the browser ask before it lets that happen.
  const pendingWrites = useRef(0);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (pendingWrites.current > 0) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  useEffect(() => {
    if (!staff) return;
    // Paint the last known catalogue first so the till is usable straight away,
    // then let the server's copy overwrite it a moment later.
    const cached = readCachedCatalogue();
    if (cached) {
      setProducts(cached.products as Product[]);
    }
    void (async () => {
      const live = await loadLiveState();
      setProducts(Array.isArray(live.products) ? live.products as Product[] : []);
      setSales(Array.isArray(live.sales) ? live.sales as Sale[] : []);
      setYodeymaOrders(Array.isArray(live.yodeyma_orders) ? live.yodeyma_orders as YodeymaOrder[] : []);
      setCheckedDays(checkDaysFrom(live.daily_checks));
      setCheckPromptOpen(true);
      setTillDays(Array.isArray(live.till_days) ? live.till_days as TillDay[] : []);
      setFloatPromptOpen(true);
      const savedMargin = (live.settings as { targetMargin?: number } | undefined)?.targetMargin;
      if (typeof savedMargin === "number" && savedMargin >= 0) setTargetMargin(savedMargin);
      setHydrated(true);
      writeCachedCatalogue(live.products);
    })();
  }, [staff]);
  // Leaving the Daily checks page: re-read the checks at once, so the notice
  // disappears the moment today's check is saved rather than a minute later.
  useEffect(() => {
    if (!staff || view === "checks") return;
    let cancelled = false;
    void (async () => {
      const live = await loadLiveState();
      if (!cancelled && live.daily_checks !== undefined) setCheckedDays(checkDaysFrom(live.daily_checks));
    })();
    return () => { cancelled = true; };
  }, [view, staff]);
  const checkToday = todayKey();
  const isSunday = new Date().getDay() === 0;
  // Earlier days in the last fortnight with nothing recorded (Sundays are
  // closed days and never count), but never before the first check existed.
  const missedEarlier = (() => {
    if (!checkedDays || !checkedDays.length) return 0;
    const earliest = checkedDays.reduce((a, b) => (a < b ? a : b));
    let n = 0;
    for (let back = 1; back <= 14; back += 1) {
      const d = new Date(Date.now() - back * 86400000);
      const k = dayKeyOf(d);
      if (k < earliest) break;
      if (d.getDay() !== 0 && !checkedDays.includes(k)) n += 1;
    }
    return n;
  })();
  const checkDueToday = checkedDays !== null && !isSunday && !checkedDays.includes(checkToday);
  const todayTill = tillDays?.find((d) => d.date === checkToday);
  // The first person in each day confirms the £50 float before anything else.
  const floatDue = tillDays !== null && !isSunday && !todayTill?.openedAt;
  const cashToday = cashSalesOn(sales, checkToday);
  const signOutNow = () => {
    void fetch("/api/session", { method: "DELETE" });
    setSignOutStep(null);
    setStaff(null);
    setCart([]);
  };
  // Signing out while the shop is open for the day asks whether this is the
  // closing sign-out; if it is, the cash is counted and balanced first.
  const requestSignOut = () => {
    const openToday = !todayTill?.closedAt && (Boolean(todayTill?.openedAt) || sales.some((x) => x.at && dayKeyOf(new Date(x.at)) === checkToday));
    if (openToday && !isSunday) setSignOutStep("ask");
    else signOutNow();
  };
  // Keep the head start current as stock moves through the day.
  useEffect(() => {
    if (hydrated) writeCachedCatalogue(products);
  }, [hydrated, products]);
  useEffect(() => { if (hydrated) saveLiveState({ yodeyma_orders: yodeymaOrders }); }, [yodeymaOrders, hydrated]);
  // Keep every till showing the same numbers: quietly re-fetch the live state
  // every minute and whenever the tab comes back into view, so a tablet that
  // has been signed in since morning is never hours out of date. Skipped while
  // a save is in flight or the product editor is open, so a refresh can never
  // overwrite what someone is in the middle of doing.
  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    const refresh = async () => {
      if (pendingWrites.current > 0 || editing) return;
      const live = await loadLiveState();
      if (cancelled || pendingWrites.current > 0) return;
      if (Array.isArray(live.products)) setProducts(live.products as Product[]);
      if (Array.isArray(live.sales)) setSales(live.sales as Sale[]);
      setCheckedDays(checkDaysFrom(live.daily_checks));
      if (Array.isArray(live.till_days)) setTillDays(live.till_days as TillDay[]);
      const savedMargin = (live.settings as { targetMargin?: number } | undefined)?.targetMargin;
      if (typeof savedMargin === "number" && savedMargin >= 0) setTargetMargin(savedMargin);
    };
    const timer = window.setInterval(() => void refresh(), 60000);
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { cancelled = true; window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [hydrated, editing]);
  useEffect(() => {
    const desktopScanner = window.matchMedia(
      "(min-width: 821px) and (pointer: fine)",
    ).matches;
    if (staff && view === "checkout" && desktopScanner)
      scanRef.current?.focus();
  }, [staff, view]);

  const categories = useMemo(
    () => ["Most popular", "All products", ...Array.from(new Set(products.map((p) => p.category)))],
    [products],
  );
  const supplierOptions = useMemo(() => {
    const inUse = Array.from(new Set(products.map((p) => p.supplier?.trim()).filter((name): name is string => Boolean(name))))
      .filter((name) => !baseSuppliers.some((base) => base.toLowerCase() === name.toLowerCase()))
      .sort((a, b) => a.localeCompare(b));
    return [...baseSuppliers, ...inUse];
  }, [products]);
  const unitsSold = useMemo(() => {
    const totals = new Map<string, number>();
    sales.filter((sale) => !sale.refunded && !sale.stockOnly).forEach((sale) => {
      sale.items.forEach((item) => totals.set(item.id, (totals.get(item.id) || 0) + item.quantity));
    });
    return totals;
  }, [sales]);
  const searchTerms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matchesSearch = (product: Product) => {
    if (!searchTerms.length) return true;
    const searchable = [product.name, product.size, product.category, product.supplier, product.barcode]
      .filter(Boolean).join(" ").toLowerCase();
    return searchTerms.every((term) => searchable.includes(term));
  };
  // A discontinued product keeps its history and stays on the Stock page,
  // but leaves the till entirely - no button, no search hit, no mis-rings
  // against a retired catch-all like the old generic "Can".
  const visibleProducts = products
    .filter((p) =>
      !p.discontinued &&
      matchesSearch(p) &&
      (searchTerms.length > 0 || category === "All products" || (category === "Most popular" ? Boolean(p.quick) : p.category === category)),
    )
    .sort((a, b) => category === "Most popular"
      ? (unitsSold.get(b.id) || 0) - (unitsSold.get(a.id) || 0) || a.name.localeCompare(b.name)
      : a.name.localeCompare(b.name));
  const total = cart.reduce(
    (sum, line) => sum + linePrice(line) * line.quantity,
    0,
  );
  const itemCount = cart.reduce((sum, line) => sum + line.quantity, 0);
  const todaySales = sales.filter((s) => s.at.slice(0, 10) === todayKey());
  const todayPaidSales = todaySales.filter((s) => !s.stockOnly && !s.refunded);
  const ownersPerkValue = (sale: Sale) => sale.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  // Refund a sale from the Reports page: the server marks its own copy
  // refunded and restores the stock, so a stale screen or double tap is safe.
  const refundSale = async (sale: Sale) => {
    if (sale.refunded || refundingId) return;
    setRefundingId(sale.id);
    try {
      const saved = await refundSaleNow(sale.id);
      setSales(saved.sales as unknown as Sale[]);
      setProducts(saved.products as unknown as Product[]);
      setRefundNotice("");
    } catch (error) {
      setRefundNotice(error instanceof Error ? `REFUND NOT SAVED: ${error.message}` : "REFUND NOT SAVED - please try again");
    } finally {
      setRefundingId("");
    }
  };
  const todayTotal = todayPaidSales.reduce((sum, s) => sum + s.total, 0);
  const todayCardTakings = todayPaidSales.reduce(
    (sum, s) =>
      sum +
      (s.cardAmount ??
        (s.method === "Card"
          ? s.total
          : s.method === "Split"
            ? Math.max(0, s.total - (s.cashAmount || 0))
            : 0)),
    0,
  );
  const todayCashTakings = todayPaidSales.reduce(
    (sum, s) =>
      sum +
      (s.cashAmount ??
        (s.method === "Cash"
          ? s.total
          : s.method === "Split"
            ? Math.max(0, s.total - (s.cardAmount || 0))
            : 0)),
    0,
  );
  // The reports page looks back a fortnight for top sellers and Owner's Perks.
  const fortnightStart = new Date();
  fortnightStart.setDate(fortnightStart.getDate() - 13);
  fortnightStart.setHours(0, 0, 0, 0);
  const fortnightSales = sales.filter((s) => new Date(s.at) >= fortnightStart);
  const topSellerSource = (topPeriod === "today" ? todayPaidSales : fortnightSales.filter((s) => !s.stockOnly && !s.refunded));
  const topSellerTally = new Map<string, { name: string; units: number; takings: number }>();
  for (const sale of topSellerSource) {
    for (const item of sale.items) {
      if (item.id === "yodeyma-order") continue;
      const row = topSellerTally.get(item.id) || { name: item.name, units: 0, takings: 0 };
      row.units += item.quantity;
      row.takings += item.price * item.quantity;
      row.name = item.name;
      topSellerTally.set(item.id, row);
    }
  }
  const topSellers = [...topSellerTally.values()]
    .sort((a, b) => b.units - a.units || a.name.localeCompare(b.name))
    .slice(0, 10);
  const fortnightPerks = fortnightSales.filter((s) => s.method === "Owner's Perk" && !s.refunded);
  const perksByStaff = [...fortnightPerks.reduce((map, sale) => {
    const row = map.get(sale.staff) || { staff: sale.staff, count: 0, value: 0 };
    row.count += 1;
    row.value += sale.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    return map.set(sale.staff, row);
  }, new Map<string, { staff: string; count: number; value: number }>()).values()]
    .sort((a, b) => b.value - a.value || b.count - a.count);
  const perksByDay = [...fortnightPerks.reduce((map, sale) => {
    const day = sale.at.slice(0, 10);
    return map.set(day, [...(map.get(day) || []), sale]);
  }, new Map<string, Sale[]>()).entries()].sort((a, b) => b[0].localeCompare(a[0]));

  const speak = (text: string) => {
    if (!staff?.accessible || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  };

  const chooseCashPayment = () => {
    setCashReceived("");
    flushSync(() => setPayment("Cash"));
    cashReceivedRef.current?.focus();
  };

  const openProductLibrary = () => {
    flushSync(() => setView("products"));
    productSearchRef.current?.focus();
  };


  const addProduct = (product: Product) => {
    if (document.activeElement instanceof HTMLInputElement)
      document.activeElement.blur();
    if (product.price <= 0) {
      setNotice(`${product.name} needs a selling price before it can be sold`);
      speak(`${product.name}, selling price needed`);
      return;
    }
    // The item being scanned is more real than the number on the screen, so a
    // "0 in stock" product still sells - the sale flags it for a shelf recount
    // instead of blocking the customer.
    const inCart = cart.find((line) => line.product.id === product.id)?.quantity || 0;
    const beyondStock = !product.noStockCount && inCart + 1 > product.stock;
    setCart((current) => {
      const exists = current.find((line) => line.product.id === product.id);
      if (exists) {
        return current.map((line) =>
          line.product.id === product.id
            ? { ...line, quantity: line.quantity + 1 }
            : line,
        );
      }
      return [...current, { product, quantity: 1 }];
    });
    if (beyondStock) {
      setNotice(`${product.name} added - stock showed ${Math.max(0, product.stock)}, so the shelf will be flagged for a recount`);
      speak(`${product.name}, ${money(product.price)}. Stock count needs checking.`);
    } else {
      setNotice(`${product.name} added`);
      speak(`${product.name}, ${money(product.price)}`);
    }
  };

  const changeQuantity = (id: string, delta: number) =>
    setCart((current) => current
      .map((line) => {
        if (line.product.id !== id) return line;
        const quantity = line.quantity + delta;
        if (delta > 0 && !line.product.noStockCount && quantity > line.product.stock)
          setNotice(`Stock showed ${Math.max(0, line.product.stock)} ${line.product.name} - selling anyway, shelf will be flagged for a recount`);
        return { ...line, quantity };
      })
      .filter((line) => line.quantity > 0));
  const handleScan = () => {
    const code = scanValue.trim();
    if (!code) return;
    const product = products.find((p) => ownsBarcode(p, code));
    if (product) addProduct(product);
    else {
      setNotice(`Unknown barcode ${code}`);
      setEditing({
        id: crypto.randomUUID(),
        name: "",
        price: 0,
        cost: 0,
        stock: 0,
        category: "Groceries",
        barcode: code,
        colour: "#c7d9c0",
      });
    }
    setScanValue("");
  };

  // What to do with a finished barcode on the till. Kept in a ref so the
  // window listener below can stay registered while stock numbers change
  // underneath it - re-registering the listener mid-scan wipes the half-read
  // barcode (the refresh every minute made that a real problem).
  const checkoutScan = (code: string) => {
    const product = products.find((item) => ownsBarcode(item, code));
    if (product) addProduct(product);
    else {
      setNotice(`Barcode ${code} is not in the catalogue — add it in Add products`);
      speak(`Unknown barcode`);
    }
    setSearch("");
    setScanValue("");
  };
  const checkoutScanRef = useRef(checkoutScan);
  useEffect(() => { checkoutScanRef.current = checkoutScan; });

  useEffect(() => {
    if (!staff || view !== "checkout" || payment || editing) return;
    const finishScannerCode = () => {
      const code = scannerBuffer.current;
      scannerBuffer.current = "";
      if (scannerIdle.current) clearTimeout(scannerIdle.current);
      scannerIdle.current = null;
      if (code.length < 6) return;
      checkoutScanRef.current(code);
    };
    const onScannerKey = (event: KeyboardEvent) => {
      const now = Date.now();
      if (now - scannerTime.current > 2000) scannerBuffer.current = "";
      scannerTime.current = now;
      if (/^[0-9]$/.test(event.key)) {
        scannerBuffer.current += event.key;
        if (scannerIdle.current) clearTimeout(scannerIdle.current);
        scannerIdle.current = setTimeout(finishScannerCode, 1200);
        return;
      }
      if (event.key !== "Enter" && event.key !== "Tab") return;
      if (scannerBuffer.current.length < 6) return;
      event.preventDefault();
      event.stopPropagation();
      finishScannerCode();
    };
    window.addEventListener("keydown", onScannerKey, true);
    return () => {
      window.removeEventListener("keydown", onScannerKey, true);
      if (scannerIdle.current) clearTimeout(scannerIdle.current);
      scannerIdle.current = null;
      scannerBuffer.current = "";
    };
  }, [staff, view, payment, editing]);

  // ---- Quick restock (Stock page) ----
  // Send the batched-up taps for one product to the server as a single "add
  // N" instruction. On failure the taps are put back, so tapping + or - again
  // retries them rather than losing the count.
  const flushRestock = async (id: string) => {
    const delta = restockPending.current;
    restockPending.current = 0;
    if (!delta) return;
    pendingWrites.current += 1;
    try {
      const saved = await adjustStockNow([{ id, delta }], { reason: "restock" });
      setProducts(saved.products as unknown as Product[]);
      setRestockPendingView(0);
    } catch (error) {
      restockPending.current += delta;
      setRestockNotice(error instanceof Error ? `NOT SAVED: ${error.message}` : "NOT SAVED - tap + or - to try again");
    } finally {
      pendingWrites.current -= 1;
    }
  };
  const adjustRestock = (id: string, delta: number) => {
    const product = products.find((candidate) => candidate.id === id);
    const shown = (product?.stock || 0) + restockPending.current;
    if (delta < 0 && shown <= 0) return;
    restockPending.current += delta;
    setRestockPendingView((current) => current + delta);
    setRestockAdded((current) => current + delta);
    setRestockNotice("");
    if (restockTimer.current) clearTimeout(restockTimer.current);
    restockTimer.current = setTimeout(() => void flushRestock(id), 500);
  };
  // A barcode arriving on the Stock page: show the product with big + / -
  // controls, and NOTHING more. A scan never changes stock by itself - an
  // accidental double-scan or a "did that take?" re-scan used to add phantom
  // stock (turned off 18 Sep at the owner's request). Only the + / - and
  // "+ case" buttons move the count. An unknown barcode opens the add-product
  // form with the code already filled in.
  const restockScan = (code: string) => {
    const product = products.find((candidate) => ownsBarcode(candidate, code) || (candidate.caseBarcode && candidate.caseBarcode === code));
    if (!product) {
      logScan(`unknown:${code}`);
      // Not in the catalogue: could be a genuinely new product, or the same
      // shelf item bought from a different shop with a different barcode
      // (bleach is bleach). Staff choose on the card.
      setUnknownCode(code);
      setAliasSearch("");
      setNotice("");
      return;
    }
    setUnknownCode(null);
    // Every scan on the Stock page is written to the movement log as "checked",
    // even when the count needs no change - otherwise "scanned and right" and
    // "never scanned" look identical, and a stock check can't tell what was
    // missed. It moves no stock and leaves any recount flag alone.
    logScan(product.id);
    if (restockId !== product.id) {
      // Different product: save anything still pending on the old one first.
      if (restockId && restockTimer.current) {
        clearTimeout(restockTimer.current);
        void flushRestock(restockId);
      }
      restockPending.current = 0;
      setRestockPendingView(0);
      setRestockAdded(0);
      setRestockNotice("");
      setFullDraft("");
      setRestockId(product.id);
    }
    setSearch("");
    speak(product.name);
  };
  // The unknown-barcode chooser's two exits: start a brand-new product with
  // the code filled in, or attach the code to an existing product so both
  // barcodes ring up and restock the same item from now on.
  const startNewFromCode = (code: string) => {
    setUnknownCode(null);
    editingBaseStock.current = 0;
    setEditing({ id: crypto.randomUUID(), name: "", price: 0, cost: 0, stock: 0, category: "Groceries", barcode: code, colour: "#c7d9c0" });
  };
  const addAliasTo = async (product: Product, code: string) => {
    setUnknownCode(null);
    try {
      const saved = await saveProductNow({ ...product, altBarcodes: [...(product.altBarcodes || []), code] } as unknown as Record<string, unknown>);
      setProducts(saved as unknown as Product[]);
      restockPending.current = 0;
      setRestockPendingView(0);
      setRestockAdded(0);
      setRestockNotice("");
      setFullDraft("");
      setRestockId(product.id);
      setNotice(`${code} added as another barcode for ${product.name}`);
    } catch (error) {
      setNotice(error instanceof Error ? `NOT SAVED: ${error.message}` : "NOT SAVED - please try again");
    }
  };
  const saveFullTarget = async (product: Product) => {
    const full = Math.floor(Number(fullDraft));
    if (!(full > 0)) return;
    try {
      const saved = await saveProductNow({ ...product, full } as unknown as Record<string, unknown>);
      setProducts(saved as unknown as Product[]);
      setFullDraft("");
      setNotice(`${product.name}: full shelf is ${full}`);
    } catch (error) {
      setNotice(error instanceof Error ? `NOT SAVED: ${error.message}` : "NOT SAVED - please try again");
    }
  };
  // The same silent scanner-listening trick as the till: a fast burst of
  // digits ending in Enter (or a pause) is a scanner, wherever focus is - so
  // on a phone with a pocket scanner nothing needs tapping first. The handler
  // lives in a ref for the same reason as the till's: the listener must stay
  // put while stock numbers change mid-scan.
  const restockScanRef = useRef(restockScan);
  useEffect(() => { restockScanRef.current = restockScan; });
  useEffect(() => {
    if (!staff || view !== "products" || editing) return;
    const finishScannerCode = () => {
      const code = scannerBuffer.current;
      scannerBuffer.current = "";
      if (scannerIdle.current) clearTimeout(scannerIdle.current);
      scannerIdle.current = null;
      if (code.length < 6) return;
      restockScanRef.current(code);
    };
    const onScannerKey = (event: KeyboardEvent) => {
      const now = Date.now();
      if (now - scannerTime.current > 2000) scannerBuffer.current = "";
      scannerTime.current = now;
      if (/^[0-9]$/.test(event.key)) {
        scannerBuffer.current += event.key;
        if (scannerIdle.current) clearTimeout(scannerIdle.current);
        scannerIdle.current = setTimeout(finishScannerCode, 1200);
        return;
      }
      if (event.key !== "Enter" && event.key !== "Tab") return;
      if (scannerBuffer.current.length < 6) return;
      event.preventDefault();
      event.stopPropagation();
      finishScannerCode();
    };
    window.addEventListener("keydown", onScannerKey, true);
    return () => {
      window.removeEventListener("keydown", onScannerKey, true);
      if (scannerIdle.current) clearTimeout(scannerIdle.current);
      scannerIdle.current = null;
      scannerBuffer.current = "";
    };
  }, [staff, view, editing]);
  // Leaving the Stock page saves any taps still waiting on the timer.
  useEffect(() => {
    if (view === "products" || !restockId) return;
    if (restockTimer.current) clearTimeout(restockTimer.current);
    void flushRestock(restockId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // Put the transaction on screen immediately and save it in the background.
  // A till should never hold up the next customer while it waits for a server
  // to wake up, so the stock change is applied locally first and reconciled
  // against the server's answer when it lands. A failure undoes just this
  // transaction rather than restoring an old snapshot, so a sale finishing on
  // another tablet in the meantime is not clobbered.
  const commitTransaction = (
    transaction: Sale,
    finished: { notice: string; spoken: string },
  ) => {
    const sold = new Map(transaction.items.map((item) => [item.id, item.quantity]));
    const applyStock = (direction: 1 | -1) =>
      setProducts((current) =>
        current.map((product) =>
          sold.has(product.id) && !product.noStockCount
            ? { ...product, stock: product.stock - direction * (sold.get(product.id) as number) }
            : product,
        ),
      );

    applyStock(1);
    setSales((current) => [transaction, ...current]);
    setCart([]);
    setSearch("");
    setPayment(null);
    setSplitCash("");
    setCashReceived("");
    setNotice(finished.notice);
    speak(finished.spoken);

    pendingWrites.current += 1;
    void (async () => {
      try {
        const saved = await completeLiveSale({
          sale: transaction as unknown as Record<string, unknown>,
          items: transaction.items.map((item) => ({ id: item.id, quantity: item.quantity })),
        });
        if (Array.isArray(saved.products)) setProducts(saved.products as Product[]);
        if (Array.isArray(saved.sales)) setSales(saved.sales as Sale[]);
      } catch (error) {
        applyStock(-1);
        setSales((current) => current.filter((entry) => entry.id !== transaction.id));
        setNotice(
          error instanceof Error
            ? `NOT SAVED: ${error.message}`
            : "NOT SAVED — that transaction did not go through, please put it through again",
        );
      } finally {
        pendingWrites.current -= 1;
      }
    })();
  };

  const completeSale = async (method: PaymentMethod) => {
    if (!staff || !cart.length) return;
    const enteredCash = Math.round(Number(splitCash) * 100) / 100;
    if (
      method === "Split" &&
      (!enteredCash || enteredCash <= 0 || enteredCash >= total)
    )
      return;
    const cardAmount =
      method === "Card"
        ? total
        : method === "Split"
          ? Math.round((total - enteredCash) * 100) / 100
          : 0;
    const cashAmount = Math.round((total - cardAmount) * 100) / 100;
    const sale: Sale = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      staff: staff.name,
      method,
      total,
      cashAmount,
      cardAmount,
      items: cart.map((l) => ({
        id: l.product.id,
        name: l.product.name,
        quantity: l.quantity,
        price: linePrice(l),
      })),
    };
    commitTransaction(sale, {
      notice: `${method} sale completed — ${money(total)}`,
      spoken: `Sale complete, ${money(total)}`,
    });
  };

  // One path for both stock-only exits: an owner perk, or something binned.
  const completeStockOnly = async (method: "Owner's Perk" | "Waste") => {
    if (!staff || !cart.length) return;
    const wasted = method === "Waste";
    const transaction: Sale = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      staff: staff.name,
      method,
      total,
      cashAmount: 0,
      cardAmount: 0,
      stockOnly: true,
      items: cart.map((line) => ({
        id: line.product.id,
        name: line.product.name,
        quantity: line.quantity,
        price: linePrice(line),
      })),
    };
    commitTransaction(transaction, {
      notice: wasted ? "Waste recorded — stock removed" : "Owner's Perk recorded — no payment taken",
      spoken: wasted ? "Waste recorded" : "Owner's Perk recorded",
    });
  };

  // Gone-off stock gets written off right where the scanning happens: scan
  // the item on the Stock page, tap once per unit binned. It goes through the
  // same locked sale route as the till's write-off, so Reports and the stock
  // movement log both see it - unlogged waste was a proven cause of counts
  // reading higher than the shelf.
  const writeOffFromShelf = (product: Product) => {
    if (!staff) return;
    const transaction: Sale = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      staff: staff.name,
      method: "Waste",
      total: product.price,
      cashAmount: 0,
      cardAmount: 0,
      stockOnly: true,
      items: [{ id: product.id, name: product.name, quantity: 1, price: product.price }],
    };
    setSales((current) => [transaction, ...current]);
    const counted = !product.noStockCount;
    if (counted) setProducts((current) => current.map((p) => (p.id === product.id ? { ...p, stock: p.stock - 1 } : p)));
    setRestockNotice(`1 written off - tap again for each one binned`);
    pendingWrites.current += 1;
    void (async () => {
      try {
        const saved = await completeLiveSale({ sale: transaction as unknown as Record<string, unknown>, items: [{ id: product.id, quantity: 1 }] });
        if (Array.isArray(saved.products)) setProducts(saved.products as Product[]);
        if (Array.isArray(saved.sales)) setSales(saved.sales as Sale[]);
      } catch (error) {
        setSales((current) => current.filter((entry) => entry.id !== transaction.id));
        if (counted) setProducts((current) => current.map((p) => (p.id === product.id ? { ...p, stock: p.stock + 1 } : p)));
        setRestockNotice(error instanceof Error ? `NOT SAVED: ${error.message}` : "NOT SAVED - please tap again");
      } finally {
        pendingWrites.current -= 1;
      }
    })();
  };

  // A Yodeyma collection payment is a sale with no shelf product behind it, so
  // it goes through the same locked sale route as everything else (the server
  // records sale lines that are not catalogue products without touching stock).
  // Before this it only ever lived in the screen's memory and vanished on
  // sign-out, so these payments never reached the reports.
  const recordYodeymaPayment = (method: "Cash" | "Card", amount: number, customer: string) => {
    if (!staff || amount <= 0) return;
    const transaction: Sale = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      staff: staff.name,
      method,
      total: amount,
      cashAmount: method === "Cash" ? amount : undefined,
      cardAmount: method === "Card" ? amount : undefined,
      items: [{ id: "yodeyma-order", name: `Yodeyma payment - ${customer}`, quantity: 1, price: amount }],
    };
    setSales((current) => [transaction, ...current]);
    pendingWrites.current += 1;
    void (async () => {
      try {
        const saved = await completeLiveSale({
          sale: transaction as unknown as Record<string, unknown>,
          items: transaction.items.map((item) => ({ id: item.id, quantity: item.quantity })),
        });
        if (Array.isArray(saved.sales)) setSales(saved.sales as Sale[]);
      } catch (error) {
        setSales((current) => current.filter((entry) => entry.id !== transaction.id));
        setNotice(error instanceof Error ? `PAYMENT NOT SAVED: ${error.message}` : "PAYMENT NOT SAVED - please record it again");
      } finally {
        pendingWrites.current -= 1;
      }
    })();
  };

  const saveProduct = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editing?.name || editing.price <= 0) return;
    // Guard against re-creating the duplicate-barcode mess: refuse to save a
    // barcode that is already on a different product.
    const enteredBarcode = editing.barcode?.trim();
    if (enteredBarcode) {
      const clash = products.find((p) => p.id !== editing.id && (p.barcode?.trim() === enteredBarcode || (p.altBarcodes || []).includes(enteredBarcode)));
      if (clash) {
        setNotice(`That barcode is already on "${clash.name}". Two products cannot share a barcode.`);
        return;
      }
    }
    const savedProduct = {...editing, name: editing.name.trim(), price: Math.round(editing.price * 100) / 100, stockConfirmed: true, tillSetupConfirmed: true, ...(editing.noStockCount ? { stock: 0, full: undefined, recount: undefined } : {})};
    // Show the edit straight away, save behind it. Same reasoning as a sale:
    // the server round trip should not be something staff sit and watch.
    const wasNew = !products.some((product) => product.id === savedProduct.id);
    setProducts((current) =>
      wasNew
        ? [...current, savedProduct as Product]
        : current.map((product) => (product.id === savedProduct.id ? savedProduct as Product : product)),
    );
    setEditing(null);
    setNotice("Product saved");

    pendingWrites.current += 1;
    try {
      // The server keeps its own live stock for an existing product, so send
      // the stock ADJUSTMENT made in the editor rather than the number itself.
      const stockChange = editing.stock - editingBaseStock.current;
      const savedList = await saveProductNow(
        savedProduct as unknown as Record<string, unknown>,
        !wasNew && stockChange !== 0 && !savedProduct.noStockCount ? { delta: stockChange } : undefined,
        "edit",
      );
      setProducts(savedList as unknown as Product[]);
      // A product just created on the Stock page (usually from an unknown
      // barcode) lands straight in the restock card, ready for + taps.
      if (wasNew && view === "products") {
        restockPending.current = 0;
        setRestockPendingView(0);
        setRestockAdded(0);
        setRestockNotice("");
        setRestockId(savedProduct.id);
      }
    } catch (error) {
      setProducts((current) =>
        wasNew
          ? current.filter((product) => product.id !== savedProduct.id)
          : current.map((product) => (product.id === savedProduct.id ? editing : product)),
      );
      setNotice(
        error instanceof Error
          ? `NOT SAVED: ${error.message}`
          : "NOT SAVED — that product change did not go through, please try again",
      );
    } finally {
      pendingWrites.current -= 1;
    }
  };

  const deleteProduct = async () => {
    if (!editing || !products.some((product) => product.id === editing.id)) return;
    if (confirmDeleteId !== editing.id) {
      setConfirmDeleteId(editing.id);
      return;
    }
    setConfirmDeleteId(null);
    setNotice("Deleting product...");
    try {
      const savedList = await deleteProductNow(editing.id);
      setProducts(savedList as unknown as Product[]);
      setCart((current) => current.filter((line) => line.product.id !== editing.id));
      setEditing(null);
      setNotice(`${editing.name} deleted — previous sales kept`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Product not deleted - please try again");
    }
  };

  const loginWithPin = async (enteredPin: string) => {
    const response = await fetch("/api/session", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({pin:enteredPin})});
    const result = await response.json() as {staff?:Staff};
    if (!response.ok || !result.staff) {
      setLoginError("That PIN was not recognised");
      setPin("");
      return;
    }
    setStaff(result.staff);
    setPin("");
    setLoginError("");
  };

  const addPinDigit = (digit: string) => {
    if (pin.length >= 4) return;
    const nextPin = `${pin}${digit}`;
    setPin(nextPin);
    setLoginError("");
    if (nextPin.length === 4) void loginWithPin(nextPin);
  };

  if (!staff)
    return (
      <main className="login-shell">
        <section className="login-brand">
          <h1 className="visually-hidden">Alice’s Store</h1>
          <p className="eyebrow">Ryfields retirement village</p>
          <img
            className="login-logo"
            src="/alices-logo.png"
            alt="Alice’s Store"
            width={760}
            height={1077}
            fetchPriority="high"
          />
          <p className="login-intro">A friendlier way to serve the village.</p>
        </section>
        <section className="pin-panel">
          <div>
            <p className="eyebrow">Staff sign in</p>
            <h2>{greeting}</h2>
            <p>Enter your four-digit PIN to open the till.</p>
          </div>
          <div
            className="pin-dots"
            aria-label={`${pin.length} of 4 digits entered`}
          >
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className={pin.length > i ? "filled" : ""} />
            ))}
          </div>
          {loginError && (
            <p className="error-note" role="alert">
              {loginError}
            </p>
          )}
          <div className="keypad">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
              <button key={n} onClick={() => addPinDigit(String(n))}>
                {n}
              </button>
            ))}
            <button className="key-action" onClick={() => setPin("")}>
              Clear
            </button>
            <button onClick={() => addPinDigit("0")}>0</button>
            <button
              className="key-action"
              aria-label="Delete last digit"
              onClick={() => setPin((current) => current.slice(0, -1))}
            >
              Delete
            </button>
          </div>
        </section>
      </main>
    );

  return (
    <main className={`app-shell ${staff.accessible ? "accessible" : ""}`}>
      <aside className="sidebar">
        <div className="side-brand">
          <img className="brand-mark" src="/mark-96.png" alt="" width={96} height={96} />
          <div>
            <strong>Alice’s Store</strong>
            <span>Village shop</span>
          </div>
        </div>
        <nav aria-label="Main navigation">
          <button
            className={view === "checkout" ? "active" : ""}
            onClick={() => setView("checkout")}
          >
            <span>⌂</span> Checkout
          </button>
          <button
            className={view === "cash" ? "active" : ""}
            onClick={() => setView("cash")}
          >
            <span>£</span> Cash drawer
          </button>
          <button className={view === "checks" ? "active" : ""} onClick={() => setView("checks")}>
            <span>✓</span> Daily checks
          </button>
          <button className={view === "orders" ? "active" : ""} onClick={() => setView("orders")}>
            <span>◇</span> Yodeyma orders {yodeymaOrders.filter(o=>o.status==="Needs ordering").length ? `(${yodeymaOrders.filter(o=>o.status==="Needs ordering").length})` : ""}
          </button>
          <button
            className={view === "products" ? "active" : ""}
            onClick={openProductLibrary}
          >
            <span>□</span> Stock
          </button>
          {staff.admin && (
            <button
              className={view === "reports" ? "active" : ""}
              onClick={() => setView("reports")}
            >
              <span>↗</span> Reports
            </button>
          )}
          {staff.admin && (
            <button
              className={view === "admin" ? "active" : ""}
              onClick={() => setView("admin")}
            >
              <span>⚙</span> Admin
            </button>
          )}
          <button
            className="mobile-logout"
            aria-label={`Sign out ${staff.name}`}
            onClick={requestSignOut}
          >
            Sign out
          </button>
        </nav>
        <div className="shift-card">
          <span>Today’s sales</span>
          <strong>{money(todayTotal)}</strong>
          <small>{todaySales.length} completed sales</small>
        </div>
        <button
          className="staff-card"
          onClick={requestSignOut}
        >
          <span className="avatar">{staff.initials}</span>
          <span>
            <strong>{staff.name}</strong>
            <small>
              {staff.accessible ? "Spoken mode on" : "Staff member"}
            </small>
          </span>
          <b>↪</b>
        </button>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">
              {new Date().toLocaleDateString("en-GB", {
                weekday: "long",
                day: "numeric",
                month: "long",
              })}
            </p>
            <h1>
              {view === "checkout"
                ? "New sale"
                : view === "cash"
                  ? "Cash drawer"
                  : view === "checks"
                    ? "Daily checks"
                  : view === "orders"
                    ? "Yodeyma orders"
                  : view === "backfill"
                    ? "Priority backfill"
                    : view === "products"
                      ? "Stock"
                      : view === "reports"
                        ? "Shop report"
                        : "Administration"}
            </h1>
          </div>
          {(view === "checkout" || view === "products") && (
            <div className="scanner-state">
              <i /> Scanner ready
            </div>
          )}
        </header>
        {checkDueToday && view !== "checks" && (
          <button type="button" className="check-due-banner" onClick={() => setView("checks")}>
            <strong>⚠ Today&apos;s fridge check hasn&apos;t been done</strong>
            <span>Tap here to do it now{missedEarlier ? ` - and ${missedEarlier === 1 ? "1 earlier day is" : `${missedEarlier} earlier days are`} missing` : ""}</span>
          </button>
        )}
        {floatDue && floatPromptOpen && (
          <OpenShopPrompt
            onOpened={(days) => { setTillDays(days); setFloatPromptOpen(false); }}
            onLater={() => setFloatPromptOpen(false)}
          />
        )}
        {signOutStep === "ask" && (
          <div className="modal-backdrop check-due-backdrop">
            <div className="check-due-modal shop-day-modal" role="alertdialog" aria-labelledby="closing-title">
              <p className="eyebrow">Signing out</p>
              <h2 id="closing-title">Are you closing the shop for today?</h2>
              <p>If you are, you&apos;ll count the takings and leave the £50 float before signing out.</p>
              <button type="button" className="pay-button" onClick={() => setSignOutStep("close")}>Yes - close up for today</button>
              <button type="button" className="cash-shortcut" onClick={signOutNow}>No - just signing out</button>
              <button type="button" className="cash-shortcut" onClick={() => setSignOutStep(null)}>Stay signed in</button>
            </div>
          </div>
        )}
        {signOutStep === "close" && (
          <div className="modal-backdrop check-due-backdrop">
            <div className="check-due-modal shop-day-modal">
              <CloseShopForm cashSales={cashToday} finishLabel="Sign out" onClosed={(days) => { setTillDays(days); signOutNow(); }} onCancel={() => setSignOutStep("ask")} />
            </div>
          </div>
        )}
        {checkDueToday && checkPromptOpen && !(floatDue && floatPromptOpen) && view !== "checks" && (
          <div className="modal-backdrop check-due-backdrop">
            <div className="check-due-modal" role="alertdialog" aria-labelledby="check-due-title">
              <p className="eyebrow">Food safety</p>
              <h2 id="check-due-title">Today&apos;s fridge check hasn&apos;t been done</h2>
              <p>Please do it straight away - fridge and freezer temperatures, and the date check.{missedEarlier ? ` ${missedEarlier === 1 ? "1 earlier day is" : `${missedEarlier} earlier days are`} also missing.` : ""}</p>
              <button type="button" className="pay-button" onClick={() => { setCheckPromptOpen(false); setView("checks"); }}>Do the fridge check now</button>
              <button type="button" className="cash-shortcut" onClick={() => setCheckPromptOpen(false)}>Serving a customer - I&apos;ll do it next</button>
            </div>
          </div>
        )}
        {notice && (
          <div className="notice" role="status">
            {notice}
            <button onClick={() => setNotice("")}>×</button>
          </div>
        )}

        {view === "checkout" && (
          <div className="checkout-layout">
            <section className="catalogue">
              <div className="search-row">
                <label className="search-box">
                  <span>⌕</span>
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search products"
                  />
                  {search && <button type="button" aria-label="Clear product search" onClick={() => setSearch("")}>×</button>}
                </label>
                <button
                  className="scan-button"
                  onClick={() => scanRef.current?.focus()}
                >
                  ▣ Scan item
                </button>
              </div>
              <form
                className="scan-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  handleScan();
                }}
              >
                <input
                  ref={scanRef}
                  value={scanValue}
                  onChange={(e) => setScanValue(e.target.value)}
                  aria-label="Barcode scanner input"
                  placeholder="Scanner input"
                />
                <button>Find barcode</button>
              </form>
              <div className="category-tabs">
                {categories.map((c) => (
                  <button
                    key={c}
                    className={category === c ? "active" : ""}
                    onClick={() => setCategory(c)}
                  >
                    {c}
                  </button>
                ))}
              </div>
              <div className="section-title">
                <h2>{searchTerms.length ? "Search results" : category}</h2>
                <span>{visibleProducts.length} items</span>
              </div>
              <div className="product-grid">
                {visibleProducts.map((product) => (
                  <button
                    type="button"
                    className={`product-card ${!product.noStockCount && product.stock <= 0 ? "out-of-stock" : ""}`}
                    key={product.id}
                    onClick={() => addProduct(product)}
                  >
                    <div className="product-info">
                      <strong>{product.name}</strong>
                      {product.size && <small>{product.size}</small>}
                      {!product.noStockCount && <span>{Math.max(0, product.stock)} in stock</span>}
                      {!product.noStockCount && (product.stock <= 0 ? <b>Shows 0 - still sells</b> : isLowStock(product) && <b>Low stock</b>)}
                    </div>
                    <em>{money(product.price)}</em>
                  </button>
                ))}
              </div>
            </section>
            <aside className="basket-panel">
              <div className="basket-heading">
                <div>
                  <p className="eyebrow">Current basket</p>
                  <h2>
                    {itemCount
                      ? `${itemCount} ${itemCount === 1 ? "item" : "items"}`
                      : "Ready to scan"}
                  </h2>
                </div>
                {cart.length > 0 && (
                  <button onClick={() => setCart([])}>Clear</button>
                )}
              </div>
              <div className="basket-lines">
                {!cart.length ? (
                  <div className="empty-basket">
                    <span>⌁</span>
                    <h3>Your basket is empty</h3>
                    <p>Scan a barcode or tap a product to begin.</p>
                  </div>
                ) : (
                  cart.map((line) => (
                    <div className="basket-line" key={line.product.id}>
                      <div
                        className="mini-art"
                        style={{ background: line.product.colour }}
                      >
                        {line.product.name[0]}
                      </div>
                      <div>
                        <strong>{line.product.name}</strong>
                        {editingPrice === line.product.id ? (
                          <span className="price-edit">
                            £<input
                              autoFocus
                              type="number"
                              min="0"
                              step="0.01"
                              inputMode="decimal"
                              value={priceDraft}
                              aria-label={`Price for ${line.product.name}`}
                              onChange={(event) => setPriceDraft(event.target.value)}
                              onKeyDown={(event) => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); }}
                              onBlur={() => {
                                const typed = Math.round(Number(priceDraft) * 100) / 100;
                                setCart((current) => current.map((row) =>
                                  row.product.id === line.product.id
                                    ? { ...row, price: priceDraft === "" || !(typed >= 0) ? undefined : typed }
                                    : row));
                                setEditingPrice(null);
                              }}
                            />
                          </span>
                        ) : (
                          <button
                            type="button"
                            className={`line-price${typeof line.price === "number" ? " reduced" : ""}`}
                            onClick={() => { setPriceDraft(String(linePrice(line))); setEditingPrice(line.product.id); }}
                          >
                            {money(linePrice(line))} each
                            {typeof line.price === "number" && <em>was {money(line.product.price)}</em>}
                            <i className="price-tag">{typeof line.price === "number" ? "reduced" : "change price"}</i>
                          </button>
                        )}
                      </div>
                      <div className="quantity">
                        <button
                          onClick={() => changeQuantity(line.product.id, -1)}
                        >
                          −
                        </button>
                        <b>{line.quantity}</b>
                        <button
                          onClick={() => changeQuantity(line.product.id, 1)}
                        >
                          +
                        </button>
                      </div>
                      <em>{money(linePrice(line) * line.quantity)}</em>
                    </div>
                  ))
                )}
              </div>
              <div className="basket-footer">
                <div className="total-row">
                  <span>Total</span>
                  <strong>{money(total)}</strong>
                </div>
                <button
                  className="pay-button"
                  disabled={!cart.length}
                  onClick={() => {
                    setPayment("Choose");
                    speak(`Total ${money(total)}`);
                  }}
                >
                  Take payment <span>→</span>
                </button>
                {staff.admin && (
                  <button
                    className="cash-shortcut"
                    disabled={!cart.length}
                    onClick={() => setPayment("Owner's Perk")}
                  >
                    Owner&apos;s Perk — remove from stock
                  </button>
                )}
                <button
                  className="cash-shortcut waste-shortcut"
                  disabled={!cart.length}
                  onClick={() => setPayment("Waste")}
                >
                  Gone off — write it off
                </button>
              </div>
            </aside>
          </div>
        )}
        {view === "cash" && <ShopDays days={tillDays || []} sales={sales} onChange={setTillDays} />}
        {view === "checks" && <DailyChecks staff={staff.name} />}
        {view === "orders" && <YodeymaOrders orders={yodeymaOrders} setOrders={setYodeymaOrders} staff={staff.name} onPayment={recordYodeymaPayment} />}
        {view === "backfill" && (
          <PriorityBackfill products={products} setProducts={setProducts} onExit={() => setView("products")} />
        )}

        {view === "products" && (
          <section className="management-page">
            {(() => {
              if (unknownCode) {
                const matches = products
                  .filter((p) => !aliasSearch.trim() || p.name.toLowerCase().includes(aliasSearch.trim().toLowerCase()))
                  .slice(0, 6);
                return (
                  <div className="restock-card alias-chooser">
                    <div className="restock-info">
                      <strong>{unknownCode} isn&apos;t in the catalogue</strong>
                      <small>Is it a brand-new product, or a different shop&apos;s barcode for something we already sell?</small>
                    </div>
                    <div className="alias-options">
                      <button type="button" className="primary-small" onClick={() => startNewFromCode(unknownCode)}>+ New product</button>
                      <button type="button" onClick={() => setUnknownCode(null)}>Cancel</button>
                    </div>
                    <div className="alias-pick">
                      <input
                        value={aliasSearch}
                        onChange={(e) => setAliasSearch(e.target.value)}
                        placeholder="Or type a name to add this barcode to an existing product..."
                      />
                      {aliasSearch.trim() && matches.map((p) => (
                        <button type="button" key={p.id} onClick={() => void addAliasTo(p, unknownCode)}>
                          <strong>{p.name}</strong>
                          <small>{money(p.price)}{p.noStockCount ? "" : ` · ${Math.max(0, p.stock)} in stock`}</small>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              }
              const scanned = restockId ? products.find((p) => p.id === restockId) : null;
              return (
                <div className={`restock-card${scanned ? "" : " waiting"}`}>
                  {scanned ? (
                    <>
                      <div className="restock-info">
                        <strong>{scanned.name}</strong>
                        <small>
                          {money(scanned.price)}
                          {scanned.size ? ` · ${scanned.size}` : ""}
                          {isLowStock(scanned) ? " · LOW STOCK" : ""}
                        </small>
                        {restockNotice && <em className="restock-error">{restockNotice}</em>}
                      </div>
                      {scanned.noStockCount ? (
                        <div className="restock-uncounted">Stock isn&apos;t counted for this item - nothing to add or adjust.</div>
                      ) : (
                        <div className="restock-controls">
                          <button type="button" aria-label="One fewer in stock" onClick={() => adjustRestock(scanned.id, -1)}>−</button>
                          <div className="restock-count">
                            <b>{scanned.stock + restockPendingView}</b>
                            <small>in stock{restockAdded ? ` · ${restockAdded > 0 ? "+" : ""}${restockAdded} just now` : ""}</small>
                            {scanned.stock + restockPendingView < 0 && (
                              <small className="restock-minus">Sold before it was entered - add the delivery and it comes right</small>
                            )}
                          </div>
                          <button type="button" aria-label="One more in stock" onClick={() => adjustRestock(scanned.id, 1)}>+</button>
                        </div>
                      )}
                      <div className="restock-side">
                        {!scanned.noStockCount && (scanned.caseQuantity || 0) > 1 && (
                          <button type="button" onClick={() => adjustRestock(scanned.id, scanned.caseQuantity || 1)}>+ case of {scanned.caseQuantity}</button>
                        )}
                        <button type="button" onClick={() => { editingBaseStock.current = scanned.stock; setEditing(scanned); }}>Full details</button>
                        <button type="button" className="restock-waste" onClick={() => writeOffFromShelf(scanned)}>Gone off - write off 1</button>
                      </div>
                      {!scanned.noStockCount && !(scanned.full && scanned.full > 0) && (
                        <div className="restock-full-prompt">
                          <span>How many when the shelf is full? Sets it up for the shopping list.</span>
                          <input
                            type="number"
                            min="1"
                            inputMode="numeric"
                            placeholder="e.g. 6"
                            value={fullDraft}
                            onChange={(e) => setFullDraft(e.target.value)}
                          />
                          <button type="button" disabled={!(Number(fullDraft) > 0)} onClick={() => void saveFullTarget(scanned)}>Set</button>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="restock-info">
                      <strong>Scan a barcode to restock</strong>
                      <small>Nothing to tap first - the scan brings the product up. Then use the + and - buttons to change the count; scanning alone never changes stock. A new barcode opens the add-product form.</small>
                    </div>
                  )}
                </div>
              );
            })()}
            {(() => {
              // Shelves the till flagged: something sold while the screen said
              // 0, so the number is wrong somewhere. Any stock change clears
              // the flag - or "count is right" confirms it without changing.
              const flagged = products.filter((p) => p.recount && !p.discontinued && !p.noStockCount);
              if (!flagged.length) return null;
              const openOnCard = (p: Product) => {
                if (restockId && restockTimer.current) { clearTimeout(restockTimer.current); void flushRestock(restockId); }
                restockPending.current = 0;
                setRestockPendingView(0);
                setRestockAdded(0);
                setRestockNotice("");
                setFullDraft("");
                setRestockId(p.id);
              };
              const confirmRight = async (p: Product) => {
                try {
                  const confirmed = Math.max(0, p.stock);
                  const saved = await adjustStockNow([{ id: p.id, set: confirmed }], { reason: "count" });
                  setProducts(saved.products as unknown as Product[]);
                  setNotice(`${p.name}: count confirmed at ${confirmed}`);
                } catch (error) {
                  setNotice(error instanceof Error ? `NOT SAVED: ${error.message}` : "NOT SAVED - please try again");
                }
              };
              return (
                <div className="recount-banner">
                  <strong>⚠ {flagged.length === 1 ? "1 shelf needs a recount" : `${flagged.length} shelves need a recount`}</strong>
                  <small>The till sold these while the screen said 0. Count the shelf, tap the name and put the real number in - or tick if the number showing is already right.</small>
                  {flagged.map((p) => (
                    <div className="recount-row" key={p.id}>
                      <button type="button" onClick={() => openOnCard(p)}><strong>{p.name}</strong><small>shows {Math.max(0, p.stock)} in stock</small></button>
                      <button type="button" className="recount-ok" onClick={() => void confirmRight(p)}>✓ {Math.max(0, p.stock)} is right</button>
                    </div>
                  ))}
                </div>
              );
            })()}
            <div className="management-actions">
              <div className="search-box">
                <span>⌕</span>
                <input
                  ref={productSearchRef}
                  inputMode="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search stock"
                />
                {search && <button type="button" aria-label="Clear stock search" onClick={() => setSearch("")}>×</button>}
              </div>
              <div className="management-buttons">
                <button className="primary-small" onClick={() => setView("backfill")}>Priority backfill</button>
                <button className="primary-small" onClick={() => { editingBaseStock.current = 0; setEditing({id:crypto.randomUUID(),name:"",price:0,cost:0,stock:0,category:"Groceries",colour:"#c7d9c0"}); }}>+ Add product</button>
              </div>
            </div>
            <div className="product-table">
              <div className="table-head">
                <span>Product</span>
                <span>Category</span>
                <span>Stock</span>
                <span>Price</span>
                <span>Margin</span>
                <span />
              </div>
              {products
                .filter((p) =>
                  matchesSearch(p),
                )
                .map((p) => (
                  <div className="table-row" key={p.id}>
                    <span className="table-product">
                      <i style={{ background: p.colour }}>{p.name[0]}</i>
                      <span>
                        <strong>{p.name}</strong>
                        <small>{p.barcode || "Quick button"}</small>
                      </span>
                    </span>
                    <span>{p.category}</span>
                    <span className={isLowStock(p) ? "low" : ""}>
                      {isLowStock(p) ? "● " : ""}
                      {p.noStockCount ? "Not counted" : p.stock}
                    </span>
                    <strong>{money(p.price)}</strong>
                    <span>
                      {p.cost
                        ? `${Math.round(((p.price - p.cost) / p.price) * 100)}%`
                        : "—"}
                    </span>
                    <button onClick={() => { editingBaseStock.current = p.stock; setEditing(p); }}>Edit</button>
                  </div>
                ))}
            </div>
          </section>
        )}

        {view === "reports" && staff.admin && (
          <section className="reports-page">
            <StaffByDay />
            <div className="metric-grid">
              <article>
                <span>Today’s sales</span>
                <strong>{money(todayTotal)}</strong>
                <small>{todayPaidSales.length} paid transactions</small>
              </article>
              <article>
                <span>Average basket</span>
                <strong>
                  {money(
                    todayPaidSales.length ? todayTotal / todayPaidSales.length : 0,
                  )}
                </strong>
                <small>Across all payments</small>
              </article>
              <article>
                <span>Card takings</span>
                <strong>{money(todayCardTakings)}</strong>
                <small>Taken on the card reader</small>
              </article>
              <article>
                <span>Cash takings</span>
                <strong>{money(todayCashTakings)}</strong>
                <small>Into the drawer</small>
              </article>
              <article>
                <span>Estimated net margin</span>
                <strong>
                  {money(
                    todayPaidSales.reduce(
                      (sum, s) =>
                        sum +
                        s.items.reduce((n, i) => {
                          const p = products.find((x) => x.id === i.id);
                          return n + (i.price - (p?.cost || 0)) * i.quantity;
                        }, 0),
                      0,
                    ),
                  )}
                </strong>
                <small>After known costs</small>
              </article>
            </div>
            <div className="report-columns">
              <article className="report-card">
                <div className="section-title">
                  <h2>Top selling products</h2>
                  <div className="period-toggle">
                    <button type="button" className={topPeriod === "today" ? "active" : ""} onClick={() => setTopPeriod("today")}>Today</button>
                    <button type="button" className={topPeriod === "fortnight" ? "active" : ""} onClick={() => setTopPeriod("fortnight")}>Last 14 days</button>
                  </div>
                </div>
                {topSellers.length ? (
                  topSellers.map((row, index) => (
                    <div className="sale-row" key={row.name + index}>
                      <span className="sale-icon">{index + 1}</span>
                      <span>
                        <strong>{row.name}</strong>
                        <small>{row.units} sold</small>
                      </span>
                      <strong>{money(row.takings)}</strong>
                    </div>
                  ))
                ) : (
                  <div className="empty-report">
                    No sales {topPeriod === "today" ? "yet today" : "in the last 14 days"}.
                  </div>
                )}
              </article>
              <article className="report-card">
                <div className="section-title">
                  <h2>Owner&apos;s Perks</h2>
                  <span>Last 14 days · {fortnightPerks.length} taken</span>
                </div>
                {perksByStaff.length > 0 && (
                  <div className="perk-ranking">
                    {perksByStaff.map((row) => (
                      <span key={row.staff}><strong>{row.staff}</strong> {money(row.value)} ({row.count})</span>
                    ))}
                  </div>
                )}
                {perksByDay.length ? (
                  perksByDay.map(([day, entries]) => (
                    <div className="perk-day" key={day}>
                      <h3>
                        {new Date(`${day}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}
                        <span>{money(entries.reduce((sum, s) => sum + ownersPerkValue(s), 0))}</span>
                      </h3>
                      {entries.map((s) => (
                        <div className="sale-row" key={s.id}>
                          <span className="sale-icon">OP</span>
                          <span>
                            <strong>{s.items.map((item) => `${item.quantity} x ${item.name}`).join(", ")}</strong>
                            <small>{new Date(s.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} - {s.staff}</small>
                          </span>
                          <strong>{money(ownersPerkValue(s))}</strong>
                        </div>
                      ))}
                    </div>
                  ))
                ) : (
                  <div className="empty-report">No Owner&apos;s Perks in the last 14 days.</div>
                )}
              </article>
            </div>
            <article className="report-card">
              <div className="section-title"><h2>Recent sales</h2><span>Refund tools</span></div>
              {refundNotice && <p className="cash-instruction">{refundNotice}</p>}
              {sales.slice(0, 20).map((s) => (
                <div className="admin-sale" key={s.id}>
                  <span>
                    <strong>{money(s.method === "Owner's Perk" ? ownersPerkValue(s) : s.total)} · {s.method}</strong>
                    <small>{s.staff} · {new Date(s.at).toLocaleString("en-GB")}</small>
                  </span>
                  <button disabled={s.refunded || Boolean(refundingId)} onClick={() => void refundSale(s)}>
                    {s.refunded ? "Refunded" : refundingId === s.id ? "Refunding..." : "Refund"}
                  </button>
                </div>
              ))}
              {!sales.length && <div className="empty-report">No sales yet.</div>}
            </article>
          </section>
        )}
        {view === "admin" && staff.admin && (
          <AdminPanel
            products={products}
            setProducts={setProducts}
            currentStaff={staff.name}
            openNewProduct={startNewFromCode}
          />
        )}
      </section>

      {payment && (
        <div className="modal-backdrop">
          <section
            className={payment === "Cash" ? "payment-modal cash-payment-modal" : "payment-modal"}
            role="dialog"
            aria-modal="true"
            aria-label="Complete payment"
          >
            <button className="modal-close" onClick={() => setPayment(null)}>
              ×
            </button>
            <div className="payment-icon">
              {payment === "Card" ? "◇" : payment === "Split" ? "½" : payment === "Waste" ? "⊘" : "£"}
            </div>
            <p className="eyebrow">
              {payment === "Choose"
                ? "Choose payment type"
                : payment === "Waste"
                  ? "Writing off waste"
                  : payment === "Owner's Perk"
                    ? "Owner's Perk"
                    : `${payment} payment`}
            </p>
            <h2>{money(total)}</h2>
            {payment === "Choose" ? (
              <div className="payment-choices">
                <button onClick={() => setPayment("Card")}>
                  <b>◇</b>
                  <span>Record card</span>
                </button>
                <button onClick={chooseCashPayment}>
                  <b>£</b>
                  <span>Record cash</span>
                </button>
                <button
                  onClick={() => {
                    setSplitCash("");
                    setPayment("Split");
                  }}
                >
                  <b>½</b>
                  <span>Split payment</span>
                </button>
              </div>
            ) : payment === "Owner's Perk" || payment === "Waste" ? (
              <>
                <p>
                  {payment === "Waste"
                    ? "Write these items off because they have gone off or been damaged. Stock comes down, no money is taken, and it is logged as waste rather than a sale."
                    : "Remove these items from shop stock without taking payment. This is logged separately from sales."}
                </p>
                <div className="payment-summary">
                  <span>{itemCount} items</span>
                  <span>Retail value: {money(total)}</span>
                  <span>Staff: {staff.name}</span>
                </div>
                <button
                  className={payment === "Waste" ? "danger-button" : "pay-button"}
                  onClick={() => completeStockOnly(payment === "Waste" ? "Waste" : "Owner's Perk")}
                >
                  {payment === "Waste" ? "Confirm write-off" : "Confirm Owner's Perk"}
                </button>
              </>
            ) : (
              <>
                {payment === "Split" ? (
                  <div className="split-payment">
                    <label>
                      Cash received
                      <span className="money-input">
                        £
                        <input
                          autoFocus
                          inputMode="decimal"
                          type="number"
                          min="0.01"
                          max={Math.max(0.01, total - 0.01)}
                          step="0.01"
                          value={splitCash}
                          onChange={(event) => setSplitCash(event.target.value)}
                        />
                      </span>
                    </label>
                    <div>
                      <span>Remaining on card</span>
                      <strong>
                        {money(Math.max(0, total - (Number(splitCash) || 0)))}
                      </strong>
                    </div>
                  </div>
                ) : (
                  <p>
                    {payment === "Card"
                      ? "Take the full card payment, then confirm below."
                      : "Take the cash, then confirm the sale below."}
                  </p>
                )}
                <div className="payment-summary">
                  <span>{itemCount} items</span>
                  <span>Staff: {staff.name}</span>
                </div>
                <button
                  className="pay-button"
                  disabled={
                    (payment === "Split" &&
                    (!Number(splitCash) ||
                      Number(splitCash) <= 0 ||
                      Number(splitCash) >= total))
                  }
                  onClick={() => completeSale(payment as PaymentMethod)}
                >
                  {`Confirm ${payment.toLowerCase()} sale`}
                </button>
              </>
            )}
            <button
              className="cash-shortcut"
              onClick={() =>
                payment === "Choose" ? setPayment(null) : setPayment("Choose")
              }
            >
              Go back
            </button>
          </section>
        </div>
      )}

      {editing && (
        <div className="modal-backdrop">
          <form
            className="edit-modal"
            onSubmit={saveProduct}
            onKeyDown={(e) => {
              // A scanner finishes its burst with Enter, which used to submit
              // the half-filled form and close it. Enter in a field does
              // nothing now - only the Save button saves.
              const target = e.target as HTMLElement;
              if (e.key === "Enter" && target.tagName === "INPUT") e.preventDefault();
            }}
          >
            <button
              type="button"
              className="modal-close"
              onClick={() => setEditing(null)}
            >
              ×
            </button>
            <p className="eyebrow">Product details</p>
            <h2>
              {products.some((p) => p.id === editing.id)
                ? "Edit product"
                : "Add new product"}
            </h2>
            <div className="form-grid">
              <label className={`wide barcode-field${editing.barcode?.trim() ? " filled" : ""}`}>
                Barcode
                <input
                  inputMode="numeric"
                  value={editing.barcode || ""}
                  onChange={(e) =>
                    setEditing({ ...editing, barcode: e.target.value, quick: e.target.value.trim() ? false : editing.quick })
                  }
                  placeholder="Scan or type - leave empty for till-button items"
                />
                {(editing.altBarcodes || []).length > 0 && (
                  <span className="alias-chips">
                    {(editing.altBarcodes || []).map((code) => (
                      <em key={code}>
                        {code}
                        <button type="button" aria-label={`Remove barcode ${code}`} onClick={() => setEditing({ ...editing, altBarcodes: (editing.altBarcodes || []).filter((c) => c !== code) })}>×</button>
                      </em>
                    ))}
                  </span>
                )}
              </label>
              <label className="wide">
                Product name
                <input
                  required
                  value={editing.name}
                  onChange={(e) =>
                    setEditing({ ...editing, name: e.target.value })
                  }
                  placeholder="Newgate Strawberry Trifle or similar"
                />
              </label>
              <label>
                Sale price
                <input
                  required
                  type="number"
                  inputMode="decimal"
                  min="0.01"
                  step="0.01"
                  value={editing.price || ""}
                  onChange={(e) =>
                    setEditing({ ...editing, price: Number(e.target.value) })
                  }
                  placeholder="£"
                />
              </label>
              <label>
                Cost price
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  value={editing.cost || ""}
                  onChange={(e) =>
                    setEditing({ ...editing, cost: Number(e.target.value) })
                  }
                  placeholder="£"
                />
              </label>
              {editing.cost > 0 && <div className="pricing-advice wide">
                <span>Min {money(recommendedPrice(editing.cost, targetMargin))}</span>
                <span>Profit {money(editing.price - editing.cost)}</span>
                <span>Markup {Math.round(((editing.price - editing.cost) / editing.cost) * 100)}%</span>
                {editing.price > 0 && editing.price < editing.cost * (1 + targetMargin / 100) && <em>Below the {targetMargin}% minimum</em>}
              </div>}
              <label className="toggle-row wide">
                <input
                  type="checkbox"
                  checked={Boolean(editing.noStockCount)}
                  onChange={(e) => setEditing({ ...editing, noStockCount: e.target.checked || undefined })}
                />
                Don&apos;t count stock for this item (loose things like bananas, served coffee, cakes)
              </label>
              {!editing.noStockCount && (
                <>
                  <StockStepper
                    label="Quantity in shop"
                    value={editing.stock}
                    onChange={(stock) => setEditing({ ...editing, stock })}
                  />
                  <label>
                    Full shelf quantity <small>How many when fully stocked</small>
                    <input
                      type="number"
                      min="0"
                      inputMode="numeric"
                      value={editing.full ?? ""}
                      onChange={(e) => setEditing({ ...editing, full: e.target.value === "" ? undefined : Math.max(0, Number(e.target.value)) })}
                      placeholder="e.g. 3"
                    />
                  </label>
                </>
              )}
              <SupplierField value={editing.supplier || ""} options={supplierOptions} onChange={(supplier) => setEditing({ ...editing, supplier })} />
              <label>Category<select value={categories.includes(editing.category) ? editing.category : "__new"} onChange={(e) => setEditing({...editing, category:e.target.value === "__new" ? "" : e.target.value})}>{categories.filter(item=>item!=="Most popular"&&item!=="All products").map(item=><option key={item} value={item}>{item}</option>)}<option value="__new">Add new category...</option></select>{!categories.includes(editing.category)&&<input autoFocus value={editing.category} onChange={e=>setEditing({...editing,category:e.target.value})} placeholder="New category name"/>}</label>
              <label>
                Size / variant
                <input value={editing.size || ""} onChange={(e) => setEditing({ ...editing, size: e.target.value })} placeholder="e.g. 330ml, Large, Whole" />
              </label>
              <label className="toggle-row wide">
                <input
                  type="checkbox"
                  checked={Boolean(editing.quick)}
                  onChange={(e) =>
                    setEditing({ ...editing, quick: e.target.checked })
                  }
                />
                Show as a till button
              </label>
              <label className="wide">
                Notes
                <input value={editing.notes || ""} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} placeholder="Anything useful when buying or counting" />
              </label>
              {products.some((p) => p.id === editing.id) && (
                <details className="wide more-options">
                  <summary>More options</summary>
                  <div className="form-grid">
                    <label className="toggle-row wide"><input type="checkbox" checked={Boolean(editing.keyProduct)} onChange={e=>setEditing({...editing,keyProduct:e.target.checked})}/>Key product — buy only from its usual supplier</label>
                    <label>
                      Case / multipack barcode
                      <input
                        inputMode="numeric"
                        value={editing.caseBarcode || ""}
                        onChange={(e) =>
                          setEditing({ ...editing, caseBarcode: e.target.value })
                        }
                        placeholder="Scan the outer pack"
                      />
                    </label>
                    <label>
                      Sale units in case
                      <input
                        type="number"
                        min="1"
                        value={editing.caseQuantity || ""}
                        onChange={(e) =>
                          setEditing({
                            ...editing,
                            caseQuantity: Number(e.target.value) || undefined,
                          })
                        }
                        placeholder="e.g. 24"
                        disabled={!editing.caseBarcode?.trim()}
                      />
                    </label>
                    {editing.caseBarcode?.trim()&&!editing.caseQuantity&&<p className="wide field-help">Enter the number of sale units in this case. Until then, a case scan would add one unit.</p>}
                  </div>
                </details>
              )}
            </div>
            <div className="product-edit-actions">
              {products.some((product) => product.id === editing.id) && (confirmDeleteId === editing.id ? (
                <>
                  <button type="button" className="danger-button delete-confirm" onClick={deleteProduct}>Tap again to delete {editing.name}</button>
                  <button type="button" className="cash-shortcut" onClick={() => setConfirmDeleteId(null)}>Keep it</button>
                </>
              ) : (
                <button type="button" className="danger-button" onClick={deleteProduct}>Delete product</button>
              ))}
              <button className="pay-button">Save product</button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}
