// Files catalogue products into the named sections of one bay, matching on
// product NAME (the catalogue's categories are not reliable).
// Usage: node scripts/fill-bay.mjs "Bakery & biscuits"          (dry run)
//        node scripts/fill-bay.mjs "Bakery & biscuits" --apply
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const plans = {
  "Bakery & biscuits": {
    "Multipack crisps": [
      "Golden Wonder Beef & Onion", "Golden Wonder Cheese and Onion", "Golden Wonder Spring Onion",
      "Seabrook multi pack prawn cocktail", "Seabrook multi pack ready salted",
      "Seabrook multipack cream cheese&chives", "Salt & Vinegar Skips 6pk",
    ],
    "Warburtons bread": [
      "Warburtons Medium 400", "Warburtons medium 800", "Warburtons toastie 400 g", "Warburtons toastie 800 g",
      "Warburtons Small Toastie", "Warburtons Wholemeal", "Warburtons danish loaf", "Warburtons large barms x4",
      "Warburtons Crumpets 9 pk", "Warburtons crumpets thins", "Warburtons teacakes",
    ],
    "Cakes (as priced)": [
      "Mr Kipling Angel Slices", "Mr Kipling Bakewell Slices", "Mr Kipling Lemon Slices",
      "Mr Kipling Mini Battenbergs", "Mr Kipling Cherry bakewell",
      "Rowan Hill Angel Slices", "Rowan Hill Bakewell Slice", "Rowan Hill Cherry Bakewells",
      "Soreen Original Malt Loaf",
    ],
    "Croissants": ["Chocolate Croissants"],
    "Tea cakes": [
      "Tunnock's Dark Chocolate Tea Cakes", "Tunnocks tea cakes dark", "Tunnocks tea cakes milk", "Fruity tea cakes",
    ],
    "Pies": ["Mr Kipling Apple Pies", "Mr Kipling Viennese whirls"],
    "Snowballs": ["Tunnock's Snowballs"],
    "Biscuit bars": [
      "Tasties bourbon creams", "Tasties custard creams",
      "Fox's Favourites Classic Chocolate Cream", "Fox's Favourites Triple Milk Chocolate",
      "Nestlé Blue Riband Milk Chocolate", "Nestlé Blue Riband Hazelnut",
    ],
    "Snickers / KitKat": ["Snickers", "KitKat 4 Finger"],
    "Ginger nuts": ["McVitie's Ginger Nut biscuits"],
    "Jaffa cakes": ["McVitie's Jaffa Cakes", "Jaffa cakes"],
    "Digestives": ["McVitie's Digestives", "McVitie's Chocolate Digestives", "Digestives original", "Chocolate digestives"],
    "Rich Tea": ["Rich tea biscuits"],
  },
};

const bayName = process.argv[2];
const apply = process.argv.includes("--apply");
const plan = plans[bayName];
if (!plan) {
  console.error(`No plan for "${bayName}". Known: ${Object.keys(plans).join(", ")}`);
  process.exit(1);
}

const file = join(process.cwd(), ".local", "store-state.json");
const state = JSON.parse(readFileSync(file, "utf8"));
const bay = state.shop_layout.fixtures.find((f) => f.name === bayName);
if (!bay) { console.error(`Bay "${bayName}" is not on the map`); process.exit(1); }

const sections = bay.columns.flatMap((c) => c.sections);
const byName = new Map(state.products.map((p) => [p.name, p]));
const missing = [];
let placed = 0;

for (const [sectionName, names] of Object.entries(plan)) {
  const section = sections.find((s) => s.name === sectionName);
  if (!section) { console.error(`  ! no section called "${sectionName}"`); continue; }
  const found = [];
  for (const name of names) {
    const product = byName.get(name);
    if (!product) { missing.push(name); continue; }
    product.fixtureId = bay.id;
    product.sectionId = section.id;
    found.push(product);
    placed++;
  }
  const stock = found.reduce((n, p) => n + (Number(p.stock) || 0), 0);
  console.log(`${sectionName.padEnd(22)} ${String(found.length).padStart(2)} lines, ${String(stock).padStart(3)} on the shelf`);
  found.forEach((p) => console.log(`    ${p.name} — ${p.stock} on shelf, full ${p.full ?? "not set"}`));
}

if (missing.length) console.log(`\nNot found in the catalogue: ${missing.join(", ")}`);
console.log(`\n${placed} products filed into ${bayName}.`);

if (apply) {
  writeFileSync(file, JSON.stringify(state, null, 2));
  console.log("Saved.");
} else {
  console.log("Dry run — pass --apply to save.");
}
