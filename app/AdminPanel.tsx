"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { adjustStockNow, loadLiveState, saveLiveState, saveProductNow } from "./live-store";

// Slimmed 2026-09-08 at the owner's request: the Overview metrics (now on
// Reports), Stock & orders, Compare a buy and the Suppliers tab are gone.
// What remains: Refunds, Shopping, Fridge temps, Staff, Controls & audit.

type Product = { id:string; name:string; price:number; cost:number; stock:number; category:string; full?:number; lowStockLevel?:number; barcode?:string; caseBarcode?:string; caseQuantity?:number; colour:string; quick?:boolean; supplier?:string; size?:string; notes?:string; keyProduct?:boolean; stockConfirmed?:boolean; discontinued?:boolean; backfillSkipped?:boolean; altBarcodes?:string[]; noStockCount?:boolean };
const ownsCode=(p:Product,code:string)=>p.barcode===code||(p.altBarcodes||[]).includes(code);
// Trip-list lines for barcodes nobody recognises yet are parked under this
// prefix until someone names the product or attaches the code to one.
const UNKNOWN_PREFIX="unknown:";
// The phone keeps its own copy of the trip list at all times, so a lost
// signal in a shop or an accidental refresh never loses the trolley.
const TRIP_BACKUP="alices-store.trip.v1";
// Stock deltas the trolley has queued but the server hasn't confirmed yet -
// kept on the phone so a dead spot in an aisle can't lose a count.
const DELTA_BACKUP="alices-store.trip-deltas.v1";
type BasketLine = { id:string; qty:number };
type Member = { id:string; name:string; pin:string; role:"Admin"|"Staff"; accessible:boolean; active:boolean; dailyWage?:number };
type Movement = { id:string; at:string; staff:string; productId:string; product:string; from:number; to:number; reason:string };
// Plain-English labels for the movement log's reasons.
const MOVE_LABELS:Record<string,string>={sale:"Sold at the till",waste:"Written off (gone off)",perk:"Owner's perk",refund:"Refund - put back",restock:"Restock on the Stock page",trip:"Shopping trip trolley",count:"Count confirmed",edit:"Edited in product details",new:"New product added",adjust:"Adjusted"};
type Supplier = { id:string; name:string; contact:string; notes:string; spend:number; preferred?:boolean };
type Audit = { id:string; at:string; action:string; detail:string; staff:string };
const money=(n:number)=>new Intl.NumberFormat("en-GB",{style:"currency",currency:"GBP"}).format(n);
const confirmedSupplierNames=["Bates","Heron","Home Bargains","Iceland","Lidl","Tesco","Tomlins","Yodeyma"];
const preferredSupplierNames=["Heron","Home Bargains","Iceland"];
const supplierRecord=(name:string):Supplier=>({id:crypto.randomUUID(),name,contact:"",notes:"",spend:0,preferred:preferredSupplierNames.includes(name)});
const AUDIT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export function AdminPanel({products,setProducts,currentStaff,openNewProduct}:{products:Product[];setProducts:React.Dispatch<React.SetStateAction<Product[]>>;currentStaff:string;openNewProduct:(code:string)=>void}){
 const [tab,setTab]=useState<"shopping"|"staff"|"controls">("shopping");
 const [team,setTeam]=useState<Member[]>([]),[suppliers,setSuppliers]=useState<Supplier[]>([]),[audits,setAudits]=useState<Audit[]>([]),[ready,setReady]=useState(false);
 const [member,setMember]=useState<Member|null>(null);
 const [stockLog,setStockLog]=useState<Movement[]>([]),[logSearch,setLogSearch]=useState("");
 const [tripShops,setTripShops]=useState<string[]>([]),[basket,setBasket]=useState<BasketLine[]>([]),[shopNotice,setShopNotice]=useState("");
 const [settings,setSettings]=useState({shopName:"Alice’s Store Ltd",lowStock:4,targetMargin:30,reconcile:true,spoken:true});
 useEffect(()=>{void(async()=>{const live=await loadLiveState();setTeam(Array.isArray(live.team)?live.team as Member[]:[]);const saved=Array.isArray(live.suppliers)?live.suppliers as Supplier[]:[];const normalised=saved.map(supplier=>({...supplier,preferred:preferredSupplierNames.includes(supplier.name)||Boolean(supplier.preferred)}));const missing=confirmedSupplierNames.filter(name=>!normalised.some(supplier=>supplier.name.toLowerCase()===name.toLowerCase()));setSuppliers([...normalised,...missing.map(supplierRecord)]);setAudits(Array.isArray(live.audit)?live.audit as Audit[]:[]);setStockLog(Array.isArray(live.stock_log)?live.stock_log as Movement[]:[]);setBasket(Array.isArray(live.shoppingBasket)?live.shoppingBasket as BasketLine[]:[]);if(live.settings)setSettings(live.settings as typeof settings);setReady(true)})()},[]);
 useEffect(()=>{if(ready)saveLiveState({team})},[team,ready]);useEffect(()=>{if(ready)saveLiveState({suppliers})},[suppliers,ready]);useEffect(()=>{if(ready)saveLiveState({audit:audits})},[audits,ready]);useEffect(()=>{if(ready)saveLiveState({settings})},[settings,ready]);useEffect(()=>{if(ready)saveLiveState({shoppingBasket:basket})},[basket,ready]);
 // Shops that actually have something needing a restock float to the front;
 // preferred ones first within that.
 const needFor=(p:Product)=>Math.max(0,(p.full||0)-p.stock);
 const shopSupplierNames=useMemo(()=>{const map=new Map<string,boolean>();suppliers.forEach(s=>map.set(s.name,Boolean(s.preferred)||Boolean(map.get(s.name))));products.forEach(p=>{const n=p.supplier?.trim();if(n&&!map.has(n))map.set(n,false)});const needCount=(name:string)=>products.filter(p=>!p.discontinued&&(p.full||0)>0&&needFor(p)>0&&(p.supplier||"").trim().toLowerCase()===name.toLowerCase()).length;return [...map.entries()].map(([name,preferred])=>({name,preferred,need:needCount(name)})).sort((a,b)=>b.need-a.need||Number(b.preferred)-Number(a.preferred)||a.name.localeCompare(b.name))},[suppliers,products]);
 useEffect(()=>{if(!ready)return;const names=[...new Set(products.map(product=>product.supplier?.trim()).filter((name):name is string=>Boolean(name)))];setSuppliers(current=>{const missing=names.filter(name=>!current.some(supplier=>supplier.name.toLowerCase()===name.toLowerCase()));return missing.length?[...current,...missing.map(supplierRecord)]:current})},[products,ready]);
 // The audit trail keeps a full, accurate 7 days rather than a fixed number
 // of entries - a busy week can no longer push events out early.
 const log=(action:string,detail:string)=>setAudits(a=>[{id:crypto.randomUUID(),at:new Date().toISOString(),action,detail,staff:currentStaff},...a].filter(entry=>Date.now()-new Date(entry.at).getTime()<AUDIT_KEEP_MS));
 const recentAudits=audits.filter(entry=>Date.now()-new Date(entry.at).getTime()<AUDIT_KEEP_MS);
 const toggleShop=(name:string)=>setTripShops(current=>current.includes(name)?current.filter(x=>x!==name):[...current,name]);
 // The movement log re-loads each time the Controls tab opens, so it shows
 // this minute's changes, not the ones from when the page was first opened.
 useEffect(()=>{if(tab!=="controls"||!ready)return;void(async()=>{const live=await loadLiveState();setStockLog(Array.isArray(live.stock_log)?live.stock_log as Movement[]:[])})()},[tab,ready]);
 // Sorting out an unknown barcode from the aisle: FIRST ask whether it's a
 // different shop's wrapper for something we already sell (attach the code -
 // no duplicate product) or genuinely new (open the add form).
 const [resolvingCode,setResolvingCode]=useState<string|null>(null),[resolveSearch,setResolveSearch]=useState("");
 // ---- Trolley = stock. The moment something goes in the trolley it counts
 // as shop stock: it's on the way within the hour, and it can't be mis-sold
 // off a shelf it isn't on. Every quantity change queues a stock delta; the
 // queue flushes moments later, survives on the phone until the server
 // confirms it, and retries when the signal comes back. Unknown-barcode lines
 // queue nothing until they become a real product.
 const pendingDeltas=useRef(new Map<string,number>());
 const deltaTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const flushingDeltas=useRef(false);
 const persistDeltas=()=>{try{localStorage.setItem(DELTA_BACKUP,JSON.stringify([...pendingDeltas.current]))}catch{/* no local copy */}};
 const flushDeltas=async()=>{
  if(flushingDeltas.current)return;
  const entries=[...pendingDeltas.current.entries()].filter(([,delta])=>delta!==0);
  if(!entries.length)return;
  flushingDeltas.current=true;
  try{
   // keepRecount: putting things in a trolley is not counting a shelf, so any
   // "needs a recount" flags stay put.
   const saved=await adjustStockNow(entries.map(([id,delta])=>({id,delta})),{keepRecount:true,reason:"trip"});
   for(const [id,delta] of entries){
    const left=(pendingDeltas.current.get(id)||0)-delta;
    if(left)pendingDeltas.current.set(id,left);else pendingDeltas.current.delete(id);
   }
   persistDeltas();
   setProducts(saved.products as unknown as Product[]);
  }catch{
   // No signal in the aisle: the deltas stay queued and go with the next
   // change, the next flush, or the next time the page loads.
   setShopNotice("No signal just now - trolley stock changes are queued on the phone and will send automatically.");
  }finally{flushingDeltas.current=false}
 };
 const scheduleFlush=()=>{if(deltaTimer.current)clearTimeout(deltaTimer.current);deltaTimer.current=setTimeout(()=>{deltaTimer.current=null;void flushDeltas()},600)};
 const queueDelta=(id:string,delta:number)=>{if(!delta||id.startsWith(UNKNOWN_PREFIX))return;pendingDeltas.current.set(id,(pendingDeltas.current.get(id)||0)+delta);persistDeltas();scheduleFlush()};
 // Anything still queued from a lost signal last time goes through on load.
 const deltasLoaded=useRef(false);
 useEffect(()=>{
  if(deltasLoaded.current)return;
  deltasLoaded.current=true;
  try{
   const raw=localStorage.getItem(DELTA_BACKUP);
   if(raw){const saved=JSON.parse(raw) as [string,number][];if(Array.isArray(saved))for(const [id,delta] of saved){if(typeof id==="string"&&Number.isFinite(delta)&&delta)pendingDeltas.current.set(id,(pendingDeltas.current.get(id)||0)+delta)}}
  }catch{/* nothing queued */}
  if(pendingDeltas.current.size)scheduleFlush();
 },[]); // eslint-disable-line react-hooks/exhaustive-deps
 // Leaving the page mid-countdown: send whatever is queued straight away.
 useEffect(()=>()=>{if(deltaTimer.current){clearTimeout(deltaTimer.current);deltaTimer.current=null;void flushDeltas()}},[]); // eslint-disable-line react-hooks/exhaustive-deps
 const attachCodeTo=async(product:Product,code:string)=>{try{const saved=await saveProductNow({...product,altBarcodes:[...(product.altBarcodes||[]),code]} as unknown as Record<string,unknown>) as unknown as Product[];setProducts(saved);setResolvingCode(null);setResolveSearch("");setShopNotice(`${code} is now another barcode for ${product.name}`)}catch(err){setShopNotice(err instanceof Error?err.message:"Could not save - try again")}};
 // ---- Scanner Mode: while the Shopping tab is open, scans land on the TRIP
 // LIST (the trolley), never on stock. A case barcode adds the whole case; an
 // unrecognised code is parked as an unknown line to sort out later.
 const scannerBuffer=useRef(""),scannerTime=useRef(0),scannerIdle=useRef<ReturnType<typeof setTimeout>|null>(null);
 const tripScan=(code:string)=>{
  const product=products.find(p=>ownsCode(p,code)||(p.caseBarcode&&p.caseBarcode===code));
  if(product){
   const viaCase=product.caseBarcode===code&&product.barcode!==code;
   const qty=viaCase?Math.max(1,product.caseQuantity||1):1;
   changeQty(product.id,inBasket(product.id)+qty);
   setShopNotice(`${product.name} +${qty} in the trolley - counted into stock`);
  }else{
   const key=UNKNOWN_PREFIX+code;
   setBasket(b=>b.some(x=>x.id===key)?b.map(x=>x.id===key?{...x,qty:x.qty+1}:x):[...b,{id:key,qty:1}]);
   setShopNotice(`Barcode ${code} isn't in the catalogue - parked on the list. Name it now or sort it at the shop.`);
  }
 };
 const tripScanRef=useRef(tripScan);
 useEffect(()=>{tripScanRef.current=tripScan;});
 useEffect(()=>{
  if(tab!=="shopping"||member)return;
  const finish=()=>{const code=scannerBuffer.current;scannerBuffer.current="";if(scannerIdle.current)clearTimeout(scannerIdle.current);scannerIdle.current=null;if(code.length<6)return;tripScanRef.current(code);};
  const onKey=(event:KeyboardEvent)=>{
   const now=Date.now();
   if(now-scannerTime.current>2000)scannerBuffer.current="";
   scannerTime.current=now;
   if(/^[0-9]$/.test(event.key)){scannerBuffer.current+=event.key;if(scannerIdle.current)clearTimeout(scannerIdle.current);scannerIdle.current=setTimeout(finish,1200);return;}
   if(event.key!=="Enter"&&event.key!=="Tab")return;
   if(scannerBuffer.current.length<6)return;
   event.preventDefault();event.stopPropagation();finish();
  };
  window.addEventListener("keydown",onKey,true);
  return()=>{window.removeEventListener("keydown",onKey,true);if(scannerIdle.current)clearTimeout(scannerIdle.current);scannerIdle.current=null;scannerBuffer.current="";};
 },[tab,member]);
 // A parked unknown converts itself the moment any product claims its barcode
 // (named via the modal, or attached as an alias on the Stock page).
 useEffect(()=>{
  if(!basket.some(line=>line.id.startsWith(UNKNOWN_PREFIX)))return;
  const map=new Map<string,number>();
  const converted=new Map<string,number>();
  let changed=false;
  for(const line of basket){
   let id=line.id;
   if(id.startsWith(UNKNOWN_PREFIX)){
    const owner=products.find(p=>ownsCode(p,line.id.slice(UNKNOWN_PREFIX.length)));
    if(owner){id=owner.id;changed=true;converted.set(owner.id,(converted.get(owner.id)||0)+line.qty)}
   }
   map.set(id,(map.get(id)||0)+line.qty);
  }
  if(!changed)return;
  setBasket([...map.entries()].map(([id,qty])=>({id,qty})));
  // A parked quantity never counted while the barcode was a mystery - it
  // counts into stock the moment the line becomes a real product.
  for(const [id,qty] of converted)queueDelta(id,qty);
  // Re-runs when the basket itself changes too (it loads a beat after the
  // page opens); the early returns stop loops.
 },[products,basket]); // eslint-disable-line react-hooks/exhaustive-deps
 // Local safety net: merge the phone's saved copy in once after loading, then
 // mirror every change back to the phone.
 const backupMerged=useRef(false);
 useEffect(()=>{
  if(!ready||backupMerged.current)return;
  backupMerged.current=true;
  try{
   const raw=localStorage.getItem(TRIP_BACKUP);
   if(!raw)return;
   const saved=JSON.parse(raw) as BasketLine[];
   if(!Array.isArray(saved)||!saved.length)return;
   setBasket(current=>{
    const map=new Map(current.map(line=>[line.id,line.qty]));
    for(const line of saved){
     if(typeof line?.id==="string"&&Number.isFinite(line.qty)&&line.qty>0)map.set(line.id,Math.max(map.get(line.id)||0,line.qty));
    }
    return [...map.entries()].map(([id,qty])=>({id,qty}));
   });
  }catch{/* no backup available */}
 },[ready]);
 useEffect(()=>{try{localStorage.setItem(TRIP_BACKUP,JSON.stringify(basket));}catch{/* full or blocked store */}},[basket]);
 const inBasket=(id:string)=>basket.find(b=>b.id===id)?.qty||0;
 // Stock now counts up as the trolley fills, so the server number includes
 // the trolley. What's physically ON the shelf is that number minus the part
 // of this trip already flushed - which keeps "need" steady while shopping,
 // instead of shrinking as things are added.
 const shelfStock=(p:Product)=>p.stock-Math.max(0,inBasket(p.id)-(pendingDeltas.current.get(p.id)||0));
 const tripNeed=(p:Product)=>Math.max(0,(p.full||0)-shelfStock(p));
 // Rows stay visible once something is in the trolley, so the steppers don't
 // vanish the moment the need is met.
 const needing=useMemo(()=>products.filter(p=>!p.discontinued&&!p.noStockCount&&(p.full||0)>0&&(tripNeed(p)>0||inBasket(p.id)>0)),[products,basket]); // eslint-disable-line react-hooks/exhaustive-deps
 const inTrip=(p:Product)=>tripShops.some(shop=>(p.supplier||"").trim().toLowerCase()===shop.toLowerCase());
 // One section per shop on this trip, then everything else that is low -
 // bleach is bleach, so anything needed can be grabbed from whichever shop
 // has it, and products with no supplier stop being invisible.
 const tripSections=useMemo(()=>tripShops.map(shop=>({shop,items:needing.filter(p=>(p.supplier||"").trim().toLowerCase()===shop.toLowerCase()).sort((a,b)=>a.name.localeCompare(b.name))})),[tripShops,needing]);
 const elsewhere=useMemo(()=>needing.filter(p=>!inTrip(p)).sort((a,b)=>a.name.localeCompare(b.name)),[needing,tripShops]); // eslint-disable-line react-hooks/exhaustive-deps
 const noTarget=useMemo(()=>products.filter(p=>!p.discontinued&&!p.noStockCount&&!(p.full||0)&&inTrip(p)).sort((a,b)=>a.name.localeCompare(b.name)),[products,tripShops]); // eslint-disable-line react-hooks/exhaustive-deps
 // ONE way to change a trolley quantity, wherever the tap happens: it updates
 // the list AND queues the matching stock delta (for real products - unknown
 // lines count later, when they're named).
 const changeQty=(id:string,nextQty:number)=>{
  const current=inBasket(id);
  const qty=Math.max(0,Math.floor(nextQty));
  if(qty===current)return;
  setBasket(b=>qty===0?b.filter(x=>x.id!==id):b.some(x=>x.id===id)?b.map(x=>x.id===id?{...x,qty}:x):[...b,{id,qty}]);
  queueDelta(id,qty-current);
 };
 const setFull=async(p:Product,full:number)=>{try{const saved=await saveProductNow({...p,full:full>0?full:undefined} as unknown as Record<string,unknown>) as unknown as Product[];setProducts(saved)}catch(err){setShopNotice(err instanceof Error?err.message:"Could not save full quantity")}};
 const basketLines=basket.map(b=>({...b,product:products.find(p=>p.id===b.id)})).filter((x):x is BasketLine&{product:Product}=>Boolean(x.product));
 basketLines.sort((a,b)=>a.product.name.localeCompare(b.product.name));
 const unknownLines=basket.filter(b=>b.id.startsWith(UNKNOWN_PREFIX));
 const basketUnits=basketLines.reduce((n,x)=>n+x.qty,0)+unknownLines.reduce((n,x)=>n+x.qty,0);
 // The trolley already counted into stock as it filled, so finishing a trip
 // just clears the list. NOTHING must be scanned in when unpacking - that
 // would count everything twice. Unknown-barcode lines are the one exception:
 // they never counted, so they DO need scanning in (or naming first).
 const [finishing,setFinishing]=useState(false);
 const finishTrip=async()=>{
  if((!basketLines.length&&!unknownLines.length)||finishing)return;
  const unknownNote=unknownLines.length?`\n\n${unknownLines.length===1?"1 unnamed barcode line was":`${unknownLines.length} unnamed barcode lines were`} NEVER counted into stock - scan ${unknownLines.length===1?"that one":"those"} onto the shelves at the Stock page when unpacking (or name them first).`:"";
  if(!window.confirm(`Finish the trip and clear the list?\n\nEverything on the list is already counted into shop stock. Do NOT scan this shopping in when unpacking - that would count it twice.${unknownNote}`))return;
  setFinishing(true);
  try{await flushDeltas()}finally{setFinishing(false)}
  log("Shopping trip finished",`${basketUnits} item${basketUnits===1?"":"s"}${tripShops.length?` from ${tripShops.join(", ")}`:""} - stock counted as the trolley filled`);
  setBasket([]);
  setShopNotice(`Trip finished. Stock is already counted - don't scan this shopping in.${unknownLines.length?" The unknown-barcode items are the exception: scan those in at the Stock page.":""}`);
 };
 return <section className="admin-page">
  <div className="admin-tabs">{[["shopping",`Shopping${basket.length?` (${basket.length})`:""}`],["staff","Staff"],["controls","Controls & audit"]].map(([id,label])=><button key={id} className={tab===id?"active":""} onClick={()=>setTab(id as typeof tab)}>{label}</button>)}</div>
  {tab==="shopping"&&<div className="admin-grid">
   <article className="report-card admin-form">
    <div className="section-title"><h2>This trip covers</h2><span>Tap the shops</span></div>
    <div className="trip-shops">{shopSupplierNames.map(({name,preferred,need})=><button type="button" key={name} className={tripShops.includes(name)?"active":""} onClick={()=>toggleShop(name)}>{name}{need?` (${need})`:""}{preferred&&!need?" ·":""}</button>)}</div>
    {shopNotice&&<p className="cash-instruction">{shopNotice}</p>}
    {!tripShops.length&&<div className="empty-report">Tap one or more shops to build the trip list. The number shows how many products each shop is short of.</div>}
    {tripSections.map(({shop,items})=><div key={shop}>
     <div className="section-title"><h2>{shop}</h2><span>{items.length} item{items.length===1?"":"s"}</span></div>
     {items.length?items.map(p=>{const need=tripNeed(p);const added=inBasket(p.id);return <div className="stock-row" key={p.id}><i style={{background:p.colour}}>{(p.name[0]||"?").toUpperCase()}</i><span><strong>{p.name}</strong><small>{p.size?`${p.size} · `:""}{shelfStock(p)} on shelf · full {p.full}</small></span><div className="shop-actions">{added>=need?<b className="need-badge done">✓ {added} in</b>:<b className="need-badge">need {need}</b>}<div className="qty-steppers"><button type="button" aria-label={`One fewer ${p.name}`} onClick={()=>changeQty(p.id,added-1)}>-</button><b>{added}</b><button type="button" aria-label={`One more ${p.name}`} onClick={()=>changeQty(p.id,added+1)}>+</button></div></div></div>}):<div className="empty-report">Nothing needed from {shop} - shelves are full.</div>}
    </div>)}
    {tripShops.length>0&&elsewhere.length>0&&<>
     <div className="section-title"><h2>Also low - grab anywhere</h2><span>{elsewhere.length}</span></div>
     <p className="cash-instruction">Usually bought elsewhere (or no usual shop), but bleach is bleach - add them if you spot them.</p>
     {elsewhere.map(p=>{const need=tripNeed(p);const added=inBasket(p.id);return <div className="stock-row" key={p.id}><i style={{background:p.colour}}>{(p.name[0]||"?").toUpperCase()}</i><span><strong>{p.name}</strong><small>{p.supplier||"No usual shop"} · {shelfStock(p)} on shelf · full {p.full}</small></span><div className="shop-actions">{added>=need?<b className="need-badge done">✓ {added} in</b>:<b className="need-badge">need {need}</b>}<div className="qty-steppers"><button type="button" aria-label={`One fewer ${p.name}`} onClick={()=>changeQty(p.id,added-1)}>-</button><b>{added}</b><button type="button" aria-label={`One more ${p.name}`} onClick={()=>changeQty(p.id,added+1)}>+</button></div></div></div>})}
    </>}
    {noTarget.length>0&&<><div className="section-title"><h2>No full target yet</h2><span>{noTarget.length}</span></div><p className="cash-instruction">Set how many make a full shelf so these appear in the shopping list.</p>{noTarget.map(p=><div className="stock-row" key={p.id}><i style={{background:p.colour}}>{(p.name[0]||"?").toUpperCase()}</i><span><strong>{p.name}</strong><small>{p.stock} on shelf</small></span><label className="inline-full">Full<input type="number" min="0" inputMode="numeric" defaultValue={p.full||""} onBlur={e=>{const v=Number(e.target.value);if(v>0)void setFull(p,v)}} onKeyDown={e=>{if(e.key==="Enter")(e.target as HTMLInputElement).blur()}}/></label></div>)}</>}
   </article>
   <article className="report-card shopping-basket">
    <div className="section-title"><h2>Trip list</h2><span>{basketUnits} item{basketUnits===1?"":"s"} · scans land here</span></div>
    {(basketLines.length||unknownLines.length)?<>
     {unknownLines.map(line=>{const code=line.id.slice(UNKNOWN_PREFIX.length);const resolving=resolvingCode===code;const matches=resolving&&resolveSearch.trim()?products.filter(p=>p.name.toLowerCase().includes(resolveSearch.trim().toLowerCase())).slice(0,5):[];return <div className="stock-row unknown-line" key={line.id}><i>?</i><span><strong>Unknown barcode {code}</strong><small>Sort it now, or scan one at the Stock page later - the line sorts itself out.</small></span><div className="qty-steppers"><button type="button" onClick={()=>changeQty(line.id,line.qty-1)}>-</button><b>{line.qty}</b><button type="button" onClick={()=>changeQty(line.id,line.qty+1)}>+</button></div><button type="button" className="primary-small" onClick={()=>{setResolvingCode(resolving?null:code);setResolveSearch("")}}>{resolving?"Cancel":"Sort it"}</button>{resolving&&<div className="unknown-resolve"><p>Different wrapper for something we already sell, or brand new?</p><input autoFocus value={resolveSearch} onChange={e=>setResolveSearch(e.target.value)} placeholder="Type a name to add this barcode to it - e.g. bleach"/>{matches.map(p=><button type="button" key={p.id} onClick={()=>void attachCodeTo(p,code)}><strong>{p.name}</strong><small>{money(p.price)} · {p.stock} in stock</small></button>)}<button type="button" className="unknown-new" onClick={()=>{setResolvingCode(null);openNewProduct(code)}}>+ It&apos;s brand new - add it as a product</button></div>}</div>})}
     {basketLines.map(({product,qty})=><div className="stock-row" key={product.id}><i style={{background:product.colour}}>{(product.name[0]||"?").toUpperCase()}</i><span><strong>{product.name}</strong><small>{product.supplier||"No usual shop"}{product.full?` · full ${product.full}`:""} · counted into stock</small></span><div className="qty-steppers"><button type="button" onClick={()=>changeQty(product.id,qty-1)}>-</button><b>{qty}</b><button type="button" onClick={()=>changeQty(product.id,qty+1)}>+</button></div></div>)}
     <button className="pay-button" disabled={finishing} onClick={()=>void finishTrip()}>{finishing?"Finishing...":"Trip finished - clear the list"}</button>
     <p className="cash-instruction">Stock counts up the moment things go in the trolley, so finishing just clears the list. NEVER scan trip shopping in at the Stock page - it&apos;s already counted. While this tab is open, scans land on this list.</p>
    </>:<div className="empty-report">Nothing on the trip list yet. Add items from the shops on the left, or scan things as they go in the trolley - stock counts up as you add.</div>}
   </article>
  </div>}
  {tab==="staff"&&<article className="report-card"><div className="section-title"><h2>Staff accounts</h2><button className="primary-small" onClick={()=>setMember({id:crypto.randomUUID(),name:"",pin:"",role:"Staff",accessible:false,active:true,dailyWage:0})}>+ Add staff member</button></div>{team.map(m=><div className="member-row" key={m.id}><span className="avatar">{m.name.slice(0,2).toUpperCase()}</span><span><strong>{m.name}</strong><small>{m.role} - Daily cash wage {money(m.dailyWage||0)}</small></span><b className={m.active?"status-on":"status-off"}>{m.active?"Active":"Inactive"}</b><button onClick={()=>setMember(m)}>Edit</button></div>)}</article>}
  {tab==="controls"&&<div className="admin-grid"><article className="report-card admin-form"><div className="section-title"><h2>Shop controls</h2><span>Saved automatically</span></div><label>Shop name<input value={settings.shopName} onChange={e=>setSettings({...settings,shopName:e.target.value})}/></label><div className="form-pair"><label>Target margin %<input type="number" min="0" value={settings.targetMargin} onChange={e=>setSettings({...settings,targetMargin:Math.max(0,Number(e.target.value)||0)})}/></label></div><p className="cash-instruction">The target margin drives the minimum-price hint when adding or editing a product. Low-stock warnings flag every product at 1 or fewer on the shelf.</p></article><article className="report-card"><div className="section-title"><h2>Audit trail</h2><span>Last 7 days · {recentAudits.length} changes</span></div>{recentAudits.map(a=><div className="audit-row" key={a.id}><i>✓</i><span><strong>{a.action}</strong><small>{a.detail} · {a.staff}</small></span><time>{new Date(a.at).toLocaleString("en-GB",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"})}</time></div>)}{!recentAudits.length&&<div className="empty-report">Changes and refunds will appear here.</div>}</article>
  <article className="report-card stock-log-card">
   <div className="section-title"><h2>Stock movement log</h2><span>{stockLog.length} changes · 4 months kept</span></div>
   <p className="cash-instruction">Every change to every count - who, when and why. Type a product or a name to follow one thread.</p>
   <div className="search-box"><span>⌕</span><input value={logSearch} onChange={e=>setLogSearch(e.target.value)} placeholder="Search product or staff member"/>{logSearch&&<button type="button" aria-label="Clear log search" onClick={()=>setLogSearch("")}>×</button>}</div>
   {(()=>{const q=logSearch.trim().toLowerCase();const rows=(q?stockLog.filter(m=>(m.product||"").toLowerCase().includes(q)||(m.staff||"").toLowerCase().includes(q)):stockLog).slice(0,120);return rows.length?rows.map(m=><div className="move-row" key={m.id}><i className={m.to>m.from?"up":m.to<m.from?"down":"same"}>{m.to>m.from?`+${m.to-m.from}`:m.to<m.from?String(m.to-m.from):"="}</i><span><strong>{m.product||"(deleted product)"}</strong><small>{MOVE_LABELS[m.reason]||m.reason} · {m.from} → {m.to} · {m.staff}</small></span><time>{new Date(m.at).toLocaleString("en-GB",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"})}</time></div>):<div className="empty-report">{stockLog.length?"Nothing matches that search.":"No movements yet - the log starts recording from this update."}</div>})()}
  </article></div>}
  {member&&<div className="modal-backdrop"><form className="edit-modal" onSubmit={e=>{e.preventDefault();setTeam(t=>t.some(x=>x.id===member.id)?t.map(x=>x.id===member.id?member:x):[...t,member]);log("Staff account saved",member.name);setMember(null)}}><button type="button" className="modal-close" onClick={()=>setMember(null)}>x</button><p className="eyebrow">Staff access</p><h2>Staff member</h2><div className="form-grid"><label className="wide">Name<input required value={member.name} onChange={e=>setMember({...member,name:e.target.value})}/></label><label>Four-digit PIN<input required pattern="[0-9]{4}" maxLength={4} value={member.pin} onChange={e=>setMember({...member,pin:e.target.value.replace(/\D/g,"")})}/></label><label>Role<select value={member.role} onChange={e=>setMember({...member,role:e.target.value as "Admin"|"Staff"})}><option>Staff</option><option>Admin</option></select></label><label className="wide">Daily cash wage<span className="money-input">£<input required type="number" min="0" step="1" value={member.dailyWage||""} onFocus={e=>e.currentTarget.select()} onChange={e=>setMember({...member,dailyWage:Math.max(0,Number(e.target.value)||0)})}/></span></label><label className="toggle-row wide"><input type="checkbox" checked={member.accessible} onChange={e=>setMember({...member,accessible:e.target.checked})}/> Spoken high-contrast mode</label><label className="toggle-row wide"><input type="checkbox" checked={member.active} onChange={e=>setMember({...member,active:e.target.checked})}/> Account active</label></div><button className="pay-button">Save staff member</button></form></div>}
 </section>
}
