// Proposes a supplier for products that have none, by matching brand words
// learned from the products that ARE already tagged.
// Usage: node scripts/guess-suppliers.mjs            (dry run + review list)
//        node scripts/guess-suppliers.mjs --apply     (writes to .local only)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Every token here was taken from a product the shop has already filed under
// that supplier, so these are learned rather than invented.
const rules = [
  ["Iceland", ["iceland"]],
  ["Heron", ["bisto", "kershaws"]],
  ["Bates", ["semi-skimmed milk", "whole milk", "skimmed milk"]],
  ["Yodeyma", ["yodeyma"]],
  ["Tomlins", ["meat and potato pie"]],
  ["Lidl", [
    "rowan hill", "batts", "freshona", "newgate", "maribel", "milbona", "floralys",
    "birchwood", "valley spire", "w5 ", "purio", "daily manor", "dairy manor",
    "simply toilet", "chorley cake", "bubble chocolate", "butter mentos", "mint imperial",
    "crownfield", "cien", "dentalux", "combino", "alesto", "bellarom", "solevita",
    "mcennedy", "vitasia", "duc de coeur", "favorina", "sondey",
  ]],
  ["Home Bargains", [
    "heinz", "kellogg", "pot noodle", "mccain", "robinsons", "vimto", "ambrosia",
    "kitkat", "kit kat", "nestl", "cadbury", "fry's", "galaxy", "werther", "buffalo",
    "steradent", "persil", "ariel", "astonish", "radox", "original source",
    "imperial leather", "sureness", "batchelors", "fruit aqua", "aero", "toffee crisp",
    "munchies", "fanta", "bannisters", "rolo", "milkybar", "smarties", "quality street",
    "colgate", "wisdom", "fixadent", "palmolive", "right guard", "sure quantum", "simple kind",
    "cif", "mr muscle", "cillit", "domestos", "harpic", "flash ",
  ]],
];

// Words that would otherwise drag a product to the wrong place.
const ambiguous = ["fairy"];

const file = join(process.cwd(), ".local", "store-state.json");
const state = JSON.parse(readFileSync(file, "utf8"));
const blanks = state.products.filter((p) => !(p.supplier || "").trim());

const proposals = [];
const conflicts = [];
const unmatched = [];

for (const product of blanks) {
  const name = (product.name || "").toLowerCase();
  if (ambiguous.some((word) => name.includes(word))) { conflicts.push({ product, why: "brand sold in more than one place" }); continue; }
  const hits = rules.filter(([, tokens]) => tokens.some((token) => name.includes(token)));
  if (!hits.length) { unmatched.push(product); continue; }
  if (hits.length > 1) { conflicts.push({ product, why: `matches ${hits.map((h) => h[0]).join(" and ")}` }); continue; }
  const token = hits[0][1].find((t) => name.includes(t));
  proposals.push({ product, supplier: hits[0][0], token });
}

const grouped = {};
proposals.forEach((row) => { (grouped[row.supplier] = grouped[row.supplier] || []).push(row); });

let review = `Supplier proposals — ${proposals.length} of ${blanks.length} products with no supplier\n`;
review += `Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")}\n\n`;
for (const [supplier, rows] of Object.entries(grouped).sort((a, b) => b[1].length - a[1].length)) {
  review += `${supplier} — ${rows.length} products\n`;
  rows.sort((a, b) => a.product.name.localeCompare(b.product.name))
    .forEach((r) => { review += `    ${r.product.name}   [matched "${r.token}"]\n`; });
  review += "\n";
}
review += `NOT GUESSED — ${unmatched.length} products, no brand word matched\n`;
unmatched.sort((a, b) => a.name.localeCompare(b.name)).forEach((p) => { review += `    ${p.name}\n`; });
review += `\nSKIPPED AS UNCLEAR — ${conflicts.length}\n`;
conflicts.forEach((c) => { review += `    ${c.product.name}  (${c.why})\n`; });

writeFileSync(join(process.cwd(), "supplier-proposals.txt"), review);

console.log(`${blanks.length} products have no supplier.`);
Object.entries(grouped).sort((a, b) => b[1].length - a[1].length)
  .forEach(([supplier, rows]) => console.log(`  ${supplier.padEnd(15)} ${rows.length}`));
console.log(`  ${"unclear".padEnd(15)} ${conflicts.length}`);
console.log(`  ${"no guess".padEnd(15)} ${unmatched.length}`);
console.log(`\nFull list written to supplier-proposals.txt`);

if (process.argv.includes("--apply")) {
  proposals.forEach(({ product, supplier }) => { product.supplier = supplier; });
  writeFileSync(file, JSON.stringify(state, null, 2));
  console.log(`\nApplied ${proposals.length} suppliers to the LOCAL preview only. Live is untouched.`);
} else {
  console.log("\nDry run — nothing changed. Pass --apply to write to the local preview.");
}
