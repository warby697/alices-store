// Reassembles a live catalogue pull from the browser tool-result chunks and
// merges it into the development copy, keeping the shop map.
//
// How the pull works (the production database URL is injected by Netlify at
// runtime and is not available on this machine, so the only way in is the live
// app while signed in):
//   1. Open the live site, YOU sign in (never type the PIN for the user).
//   2. In the page: fetch /api/state, keep the slim payload on window.__slim.
//   3. Read it back in ~60k slices; oversized results get written to
//      .claude/.../tool-results/*.txt, which this script stitches together.
//
// Usage: node scripts/pull-live.mjs <chunk1.txt> <chunk2.txt> ...
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("Pass the tool-result chunk files in order.");
  process.exit(1);
}

let joined = "";
for (const path of files) {
  const parts = JSON.parse(readFileSync(path, "utf8"));
  let text = parts.map((part) => part.text).join("");
  // The browser tool appends a provenance note and JSON-quotes the value.
  const note = text.indexOf("\n\n(captured at origin");
  if (note >= 0) text = text.slice(0, note);
  text = text.trim();
  if (text.startsWith("\"")) text = JSON.parse(text);
  joined += text;
}

const live = JSON.parse(joined);
if (!Array.isArray(live.products) || !live.products.length) {
  console.error("No products in the reassembled payload — aborting.");
  process.exit(1);
}

const file = join(process.cwd(), ".local", "store-state.json");
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
copyFileSync(file, join(process.cwd(), ".local", `store-state.backup-${stamp}.json`));

const state = JSON.parse(readFileSync(file, "utf8"));
const before = state.products.length;
state.products = live.products;
if (live.suppliers) state.suppliers = live.suppliers;
if (live.settings) state.settings = live.settings;
if (live.team) state.team = live.team;
// Placements live on the product records, so a pull wipes them. The trolley
// belongs to a shopping trip, not to the catalogue.
delete state.walk_picked;
writeFileSync(file, JSON.stringify(state, null, 2));

const gaps = (test) => live.products.filter(test).length;
console.log(`backup: store-state.backup-${stamp}.json`);
console.log(`products ${before} -> ${state.products.length}`);
console.log(`shop map kept: ${state.shop_layout?.fixtures?.length || 0} bays`);
console.log("");
console.log("catalogue gaps on live:");
console.log(`  no cost price   ${gaps((p) => !(p.cost > 0))}`);
console.log(`  no supplier     ${gaps((p) => !(p.supplier || "").trim())}`);
console.log(`  no full target  ${gaps((p) => !(p.full > 0))}`);
console.log(`  no sale price   ${gaps((p) => !(p.price > 0))}`);
const by = {};
live.products.forEach((p) => { const c = (p.barcode || "").trim(); if (c) (by[c] = by[c] || []).push(p.name); });
console.log(`  shared barcodes ${Object.values(by).filter((a) => a.length > 1).length}`);
console.log("");
console.log("Now re-run: node scripts/fill-bay.mjs \"Bakery & biscuits\" --apply");
