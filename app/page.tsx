"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AdminPanel } from "./AdminPanel";
import { CashDrawer } from "./CashDrawer";
import { PriorityBackfill } from "./PriorityBackfill";
import { ShopMap, emptyShopLayout, readShopLayout, type ShopLayout } from "./ShopMap";
import { StockStepper } from "./StockStepper";
import { YodeymaOrders, type YodeymaOrder } from "./YodeymaOrders";
import { completeLiveSale, deleteProductNow, loadLiveState, saveLiveState, saveLiveStateNow, saveProductNow } from "./live-store";
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
  fixtureId?: string;
  shelf?: number;
};
type CartLine = { product: Product; quantity: number; price?: number };
// What this line actually sells for: the override if one was typed in at the
// till, otherwise the shelf price.
const linePrice = (line: CartLine) => (typeof line.price === "number" ? line.price : line.product.price);
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
  dailyWage?: number;
};

const money = (value: number) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(
    value,
  );
const todayKey = () => { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
const recommendedPrice = (cost: number) => Math.ceil(cost * 1.3 * 20) / 20;
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

export default function Home() {
  const [staff, setStaff] = useState<Staff | null>(null);
  const [pin, setPin] = useState("");
  const [loginError, setLoginError] = useState("");
  const [view, setView] = useState<
    "checkout" | "cash" | "orders" | "backfill" | "map" | "products" | "reports" | "admin"
  >("checkout");
  const [products, setProducts] = useState<Product[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [yodeymaOrders, setYodeymaOrders] = useState<YodeymaOrder[]>([]);
  const [shopLayout, setShopLayout] = useState<ShopLayout>(emptyShopLayout);
  // What has already been picked up on the current shopping trip.
  const [walkPicked, setWalkPicked] = useState<Record<string, boolean>>({});
  const [cart, setCart] = useState<CartLine[]>([]);
  const [category, setCategory] = useState("Most popular");
  const [search, setSearch] = useState("");
  const [scanValue, setScanValue] = useState("");
  const [notice, setNotice] = useState("");
  const [savingTransaction, setSavingTransaction] = useState(false);
  const [payment, setPayment] = useState<"Choose" | TransactionMethod | null>(null);
  const [splitCash, setSplitCash] = useState("");
  const [cashReceived, setCashReceived] = useState("");
  const [editingPrice, setEditingPrice] = useState<string | null>(null);
  const [priceDraft, setPriceDraft] = useState("");
  const cashReceivedRef = useRef<HTMLInputElement>(null);
  const productSearchRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<Product | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);
  const scannerBuffer = useRef("");
  const scannerTime = useRef(0);
  const scannerIdle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const priceMigrationDone = useRef(false);

  useEffect(() => {
    if (!staff) return;
    void (async () => {
      const live = await loadLiveState();
      setProducts(Array.isArray(live.products) ? live.products as Product[] : []);
      setSales(Array.isArray(live.sales) ? live.sales as Sale[] : []);
      setYodeymaOrders(Array.isArray(live.yodeyma_orders) ? live.yodeyma_orders as YodeymaOrder[] : []);
      setShopLayout(readShopLayout(live.shop_layout));
      setWalkPicked(live.walk_picked && typeof live.walk_picked === "object" ? live.walk_picked as Record<string, boolean> : {});
      setHydrated(true);
    })();
  }, [staff]);
  useEffect(() => { if (hydrated) saveLiveState({ yodeyma_orders: yodeymaOrders }); }, [yodeymaOrders, hydrated]);
  useEffect(() => { if (hydrated) saveLiveState({ shop_layout: shopLayout }); }, [shopLayout, hydrated]);
  useEffect(() => { if (hydrated) saveLiveState({ walk_picked: walkPicked }); }, [walkPicked, hydrated]);
  useEffect(() => {
    if (!hydrated || priceMigrationDone.current) return;
    priceMigrationDone.current = true;
    const rounded = products.map(product => ({...product, price: product.price > 0 ? Math.round(product.price * 100) / 100 : 0}));
    if (rounded.some((product,index) => product.price !== products[index].price)) {
      setProducts(rounded);
      void saveLiveStateNow({products: rounded});
    }
  }, [hydrated, products]);
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
  const visibleProducts = products
    .filter((p) =>
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
  const todayOwnersPerks = todaySales.filter((s) => s.method === "Owner's Perk" && !s.refunded);
  const ownersPerkValue = (sale: Sale) => sale.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
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

  const addCashDigit = (digit: string) => {
    setCashReceived((current) => {
      if (digit === ".") return current.includes(".") ? current : `${current || "0"}.`;
      const decimals = current.split(".")[1];
      if (decimals?.length >= 2) return current;
      return current === "0" ? digit : `${current}${digit}`;
    });
  };

  const addProduct = (product: Product) => {
    if (document.activeElement instanceof HTMLInputElement)
      document.activeElement.blur();
    if (product.price <= 0) {
      setNotice(`${product.name} needs a selling price before it can be sold`);
      speak(`${product.name}, selling price needed`);
      return;
    }
    if (product.stock <= 0) {
      setNotice(`${product.name} is out of stock`);
      speak(`${product.name}, out of stock`);
      return;
    }
    setCart((current) => {
      const exists = current.find((line) => line.product.id === product.id);
      if (exists) {
        if (exists.quantity >= product.stock) {
          setNotice(`Only ${product.stock} ${product.name} in stock`);
          speak(`Only ${product.stock} in stock`);
          return current;
        }
        return current.map((line) =>
          line.product.id === product.id
            ? { ...line, quantity: line.quantity + 1 }
            : line,
        );
      }
      return [...current, { product, quantity: 1 }];
    });
    setNotice(`${product.name} added`);
    speak(`${product.name}, ${money(product.price)}`);
  };

  const changeQuantity = (id: string, delta: number) =>
    setCart((current) => current
      .map((line) => {
        if (line.product.id !== id) return line;
        const quantity = Math.min(line.product.stock, line.quantity + delta);
        if (delta > 0 && quantity === line.quantity)
          setNotice(`Only ${line.product.stock} ${line.product.name} in stock`);
        return { ...line, quantity };
      })
      .filter((line) => line.quantity > 0));
  const handleScan = () => {
    const code = scanValue.trim();
    if (!code) return;
    const product = products.find((p) => p.barcode === code);
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

  useEffect(() => {
    if (!staff || view !== "checkout" || payment || editing) return;
    const finishScannerCode = () => {
      const code = scannerBuffer.current;
      scannerBuffer.current = "";
      if (scannerIdle.current) clearTimeout(scannerIdle.current);
      scannerIdle.current = null;
      if (code.length < 6) return;
      const product = products.find((item) => item.barcode === code);
      if (product) addProduct(product);
      else {
        setNotice(`Barcode ${code} is not in the catalogue — add it in Add products`);
        speak(`Unknown barcode`);
      }
      setSearch("");
      setScanValue("");
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
  }, [staff, view, payment, editing, products]);

  const completeSale = async (method: PaymentMethod) => {
    if (!staff || !cart.length || savingTransaction) return;
    const enteredCash = Math.round(Number(splitCash) * 100) / 100;
    const cashTendered = Math.round(Number(cashReceived) * 100) / 100;
    if (method === "Cash" && cashTendered < total) return;
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
    setSavingTransaction(true);
    setNotice("Saving sale…");
    try {
      const saved = await completeLiveSale({
        sale: sale as unknown as Record<string, unknown>,
        items: cart.map((line) => ({ id: line.product.id, quantity: line.quantity })),
      });
      setProducts(Array.isArray(saved.products) ? saved.products as Product[] : products);
      setSales(Array.isArray(saved.sales) ? saved.sales as Sale[] : sales);
      setCart([]);
      setSearch("");
      setPayment(null);
      setSplitCash("");
      setCashReceived("");
    setNotice(`${method} sale completed — ${money(total)}`);
      speak(`Sale complete, ${money(total)}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Sale not saved — please try again");
    } finally {
      setSavingTransaction(false);
    }
  };

  // One path for both stock-only exits: an owner perk, or something binned.
  const completeStockOnly = async (method: "Owner's Perk" | "Waste") => {
    if (!staff || !cart.length || savingTransaction) return;
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
    setSavingTransaction(true);
    setNotice(wasted ? "Recording waste…" : "Saving Owner's Perk…");
    try {
      const saved = await completeLiveSale({
        sale: transaction as unknown as Record<string, unknown>,
        items: cart.map((line) => ({ id: line.product.id, quantity: line.quantity })),
      });
      setProducts(Array.isArray(saved.products) ? saved.products as Product[] : products);
      setSales(Array.isArray(saved.sales) ? saved.sales as Sale[] : sales);
      setCart([]);
      setSearch("");
      setPayment(null);
      setNotice(wasted ? "Waste recorded — stock removed" : "Owner's Perk recorded — no payment taken");
      speak(wasted ? "Waste recorded" : "Owner's Perk recorded");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Not saved — please try again");
    } finally {
      setSavingTransaction(false);
    }
  };

  const saveProduct = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editing?.name || editing.price <= 0) return;
    // Guard against re-creating the duplicate-barcode mess: refuse to save a
    // barcode that is already on a different product.
    const enteredBarcode = editing.barcode?.trim();
    if (enteredBarcode) {
      const clash = products.find((p) => p.id !== editing.id && p.barcode?.trim() === enteredBarcode);
      if (clash) {
        setNotice(`That barcode is already on "${clash.name}". Two products cannot share a barcode.`);
        return;
      }
    }
    const savedProduct = {...editing, name: editing.name.trim(), price: Math.round(editing.price * 100) / 100, stockConfirmed: true, tillSetupConfirmed: true};
    setNotice("Saving product...");
    try {
      const savedList = await saveProductNow(savedProduct as unknown as Record<string, unknown>);
      setProducts(savedList as unknown as Product[]);
      setEditing(null);
      setNotice("Product saved");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Product not saved - please try again");
    }
  };

  const deleteProduct = async () => {
    if (!editing || !products.some((product) => product.id === editing.id)) return;
    if (!window.confirm(`Delete ${editing.name} from the product catalogue?\n\nPrevious sales will stay in the sales history.`)) return;
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
          <div className="brand-stamp">A</div>
          <p className="eyebrow">Ryfields retirement village</p>
          <h1>Alice’s Store</h1>
          <p className="login-intro">A friendlier way to serve the village.</p>
          <div className="store-scene" aria-hidden="true">
            <span>Fresh</span>
            <span>Local</span>
            <span>Everyday</span>
          </div>
        </section>
        <section className="pin-panel">
          <div>
            <p className="eyebrow">Staff sign in</p>
            <h2>Good morning</h2>
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
          <div className="brand-stamp small">A</div>
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
          <button className={view === "map" ? "active" : ""} onClick={() => setView("map")}>
            <span>▦</span> Shop map
          </button>
          <button className={view === "orders" ? "active" : ""} onClick={() => setView("orders")}>
            <span>◇</span> Yodeyma orders {yodeymaOrders.filter(o=>o.status==="Needs ordering").length ? `(${yodeymaOrders.filter(o=>o.status==="Needs ordering").length})` : ""}
          </button>
          {staff.admin && (
            <button
              className={view === "products" ? "active" : ""}
              onClick={openProductLibrary}
            >
              <span>□</span> Product library
            </button>
          )}
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
            onClick={() => {
              void fetch("/api/session", {method:"DELETE"});
              setStaff(null);
              setCart([]);
            }}
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
          onClick={() => {
            void fetch("/api/session", {method:"DELETE"});
            setStaff(null);
            setCart([]);
          }}
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
                  : view === "orders"
                    ? "Yodeyma orders"
                  : view === "map"
                    ? "Shop map"
                  : view === "backfill"
                    ? "Priority backfill"
                    : view === "products"
                      ? "Product library"
                      : view === "reports"
                        ? "Shop report"
                        : "Administration"}
            </h1>
          </div>
          <div className="scanner-state">
            <i /> Scanner ready
          </div>
        </header>
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
                    className={`product-card ${product.stock <= 0 ? "out-of-stock" : ""}`}
                    key={product.id}
                    onClick={() => addProduct(product)}
                    disabled={product.stock <= 0}
                  >
                    <div className="product-info">
                      <strong>{product.name}</strong>
                      {product.size && <small>{product.size}</small>}
                      <span>{product.stock} in stock</span>
                      {product.stock <= 0 ? <b>Out of stock</b> : isLowStock(product) && <b>Low stock</b>}
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
                <button
                  className="cash-shortcut"
                  disabled={!cart.length}
                  onClick={() => setPayment("Owner's Perk")}
                >
                  Owner&apos;s Perk — remove from stock
                </button>
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
        {view === "cash" && <CashDrawer sales={sales} staff={staff.name} dailyWage={staff.dailyWage || 0} />}
        {view === "orders" && <YodeymaOrders orders={yodeymaOrders} setOrders={setYodeymaOrders} staff={staff.name} onPayment={(method,amount,customer)=>setSales(current=>[{id:crypto.randomUUID(),at:new Date().toISOString(),staff:staff.name,method,total:amount,cashAmount:method==="Cash"?amount:undefined,cardAmount:method==="Card"?amount:undefined,items:[{id:"yodeyma-order",name:`Yodeyma payment - ${customer}`,quantity:1,price:amount}]},...current])} />}
        {view === "map" && (
          <ShopMap
            products={products}
            setProducts={setProducts}
            layout={shopLayout}
            setLayout={setShopLayout}
            canEdit={Boolean(staff.admin)}
            picked={walkPicked}
            setPicked={setWalkPicked}
            onExit={() => setView("checkout")}
          />
        )}
        {view === "backfill" && staff.admin && (
          <PriorityBackfill products={products} setProducts={setProducts} onExit={() => setView("products")} />
        )}

        {view === "products" && (
          <section className="management-page">
            <div className="management-actions">
              <div className="management-intro"><p className="eyebrow">Existing catalogue</p><p>Find a product to inspect, edit or delete it.</p></div>
              <div className="search-box">
                <span>⌕</span>
                <input
                  ref={productSearchRef}
                  autoFocus
                  inputMode="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search product library"
                />
                {search && <button type="button" aria-label="Clear product library search" onClick={() => setSearch("")}>×</button>}
              </div>
              <div className="management-buttons">
                <button className="primary-small" onClick={() => setView("backfill")}>Priority backfill</button>
                <button className="primary-small" onClick={() => setEditing({id:crypto.randomUUID(),name:"",price:0,cost:0,stock:0,category:"Groceries",colour:"#c7d9c0"})}>+ Add product</button>
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
                      {p.stock}
                    </span>
                    <strong>{money(p.price)}</strong>
                    <span>
                      {p.cost
                        ? `${Math.round(((p.price - p.cost) / p.price) * 100)}%`
                        : "—"}
                    </span>
                    <button onClick={() => setEditing(p)}>Edit</button>
                  </div>
                ))}
            </div>
          </section>
        )}

        {view === "reports" && (
          <section className="reports-page">
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
                  <h2>Recent sales</h2>
                  <span>Today</span>
                </div>
                {todayPaidSales.length ? (
                  todayPaidSales.map((s) => (
                    <div className="sale-row" key={s.id}>
                      <span className="sale-icon">
                        {s.method === "Card"
                          ? "◇"
                          : s.method === "Split"
                            ? "½"
                            : "£"}
                      </span>
                      <span>
                        <strong>{s.method} sale</strong>
                        <small>
                          {new Date(s.at).toLocaleTimeString("en-GB", {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}{" "}
                          · {s.staff} ·{" "}
                          {s.items.reduce((n, i) => n + i.quantity, 0)} items
                        </small>
                      </span>
                      <strong>{money(s.total)}</strong>
                    </div>
                  ))
                ) : (
                  <div className="empty-report">
                    No sales recorded yet. Complete a basket to see it here.
                  </div>
                )}
              </article>
              <article className="report-card">
                <div className="section-title">
                  <h2>Stock attention</h2>
                  <span>Live</span>
                </div>
                {products
                  .filter(isLowStock)
                  .map((p) => (
                    <div className="stock-row" key={p.id}>
                      <i style={{ background: p.colour }}>{p.name[0]}</i>
                      <span>
                        <strong>{p.name}</strong>
                        <small>{p.category}</small>
                      </span>
                      <b>{p.stock} left</b>
                    </div>
                  ))}
              </article>
            </div>
            <article className="report-card owners-perks-log">
              <div className="section-title"><h2>Owner&apos;s Perks</h2><span>{todayOwnersPerks.length} today</span></div>
              {todayOwnersPerks.length ? todayOwnersPerks.map((s)=><div className="sale-row" key={s.id}><span className="sale-icon">OP</span><span><strong>{s.items.map(item=>`${item.quantity} x ${item.name}`).join(", ")}</strong><small>{new Date(s.at).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})} - {s.staff} - stock removed, no charge</small></span><strong>{money(ownersPerkValue(s))} value</strong></div>):<div className="empty-report">No Owner&apos;s Perks recorded today.</div>}
            </article>
          </section>
        )}
        {view === "admin" && staff.admin && (
          <AdminPanel
            products={products}
            setProducts={setProducts}
            sales={sales}
            setSales={setSales}
            currentStaff={staff.name}
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
                  disabled={savingTransaction}
                  onClick={() => completeStockOnly(payment === "Waste" ? "Waste" : "Owner's Perk")}
                >
                  {savingTransaction ? "Saving…" : payment === "Waste" ? "Confirm write-off" : "Confirm Owner's Perk"}
                </button>
              </>
            ) : (
              <>
                {payment === "Cash" ? (
                  <div className="split-payment cash-change">
                    <label>
                      Cash received
                      <span className="money-input">£<input ref={cashReceivedRef} autoFocus inputMode="decimal" type="number" min={total} step="0.01" value={cashReceived} onChange={(event) => setCashReceived(event.target.value)} /></span>
                    </label>
                    <div className="cash-keypad" aria-label="Cash amount keypad">
                      {["1","2","3","4","5","6","7","8","9",".","0"].map((digit) => (
                        <button type="button" key={digit} onClick={() => addCashDigit(digit)}>{digit}</button>
                      ))}
                      <button type="button" aria-label="Delete last cash digit" onClick={() => setCashReceived((current) => current.slice(0,-1))}>⌫</button>
                      <button type="button" className="cash-keypad-exact" onClick={() => setCashReceived(total.toFixed(2))}>Exact amount</button>
                    </div>
                    <div><span>Change to give</span><strong>{money(Math.max(0, (Number(cashReceived) || 0) - total))}</strong></div>
                  </div>
                ) : payment === "Split" ? (
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
                    savingTransaction ||
                    (payment === "Cash" && Number(cashReceived) < total) ||
                    (payment === "Split" &&
                    (!Number(splitCash) ||
                      Number(splitCash) <= 0 ||
                      Number(splitCash) >= total))
                  }
                  onClick={() => completeSale(payment as PaymentMethod)}
                >
                  {savingTransaction ? "Saving…" : `Confirm ${payment.toLowerCase()} sale`}
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
          <form className="edit-modal" onSubmit={saveProduct}>
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
              <label className="wide">
                Product name
                <input
                  required
                  value={editing.name}
                  onChange={(e) =>
                    setEditing({ ...editing, name: e.target.value })
                  }
                />
              </label>
              <label>
                Sale price
                <input
                  required
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={editing.price || ""}
                  onChange={(e) =>
                    setEditing({ ...editing, price: Number(e.target.value) })
                  }
                />
              </label>
              <label>
                Unit cost
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={editing.cost || ""}
                  onChange={(e) =>
                    setEditing({ ...editing, cost: Number(e.target.value) })
                  }
                />
              </label>
              {editing.cost > 0 && <div className="pricing-advice wide">
                <span>Recommended minimum <strong>{money(recommendedPrice(editing.cost))}</strong></span>
                <button type="button" onClick={() => setEditing({ ...editing, price: recommendedPrice(editing.cost) })}>Use recommended price</button>
                <span>Profit per unit <strong>{money(editing.price - editing.cost)}</strong></span>
                <span>Markup <strong>{(((editing.price - editing.cost) / editing.cost) * 100).toFixed(1)}%</strong></span>
                {editing.price < editing.cost * 1.3 && <em>Below the 30% recommendation</em>}
              </div>}
              <StockStepper
                label="Stock quantity"
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
              <label>Category<select value={categories.includes(editing.category) ? editing.category : "__new"} onChange={(e) => setEditing({...editing, category:e.target.value === "__new" ? "" : e.target.value})}>{categories.filter(item=>item!=="Most popular"&&item!=="All products").map(item=><option key={item} value={item}>{item}</option>)}<option value="__new">Add new category...</option></select>{!categories.includes(editing.category)&&<input autoFocus value={editing.category} onChange={e=>setEditing({...editing,category:e.target.value})} placeholder="New category name"/>}</label>
              <label>
                Size / variant
                <input value={editing.size || ""} onChange={(e) => setEditing({ ...editing, size: e.target.value })} placeholder="e.g. 330ml, Large, Whole" />
              </label>
              <SupplierField value={editing.supplier || ""} options={supplierOptions} onChange={(supplier) => setEditing({ ...editing, supplier })} />

              <label className="wide">
                Barcode
                <input
                  value={editing.barcode || ""}
                  onChange={(e) =>
                    setEditing({ ...editing, barcode: e.target.value, quick: e.target.value.trim() ? false : editing.quick })
                  }
                  placeholder="Scan or type barcode"
                />
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
              <label className="toggle-row wide"><input type="checkbox" checked={Boolean(editing.keyProduct)} onChange={e=>setEditing({...editing,keyProduct:e.target.checked})}/>Key product — buy only from its usual supplier</label>
              <label>
                Case / multipack barcode
                <input
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
              <label className="wide">
                Notes
                <input value={editing.notes || ""} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} placeholder="Anything useful when buying or counting" />
              </label>
            </div>
            <div className="product-edit-actions">
              {products.some((product) => product.id === editing.id) && <button type="button" className="danger-button" onClick={deleteProduct}>Delete product</button>}
              <button className="pay-button">Save product</button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}
