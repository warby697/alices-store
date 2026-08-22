import { getDatabase } from "@netlify/database";

const connectionString = process.env.NETLIFY_DB_URL;
if (!connectionString) throw new Error("Production database connection is unavailable");
const apply = process.argv.includes("--apply");
const db = getDatabase({ connectionString });

const tidy = (value = "") => String(value)
  .toLowerCase()
  .replace(/&/g, " and ")
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

const exactGroups = [
  ["20319342", "Freshona Fruit Cocktail"],
  ["4060800103307", "Pepsi Max 2L"],
  ["4060800166531", "Pepsi Max Cherry 2L"],
  ["5000193900861", "Schweppes Classic Lemonade"],
  ["5000137415970", "Jacob’s Cream Crackers"],
  ["5000127062092", "Kellogg’s Bran Flakes"],
  ["5011962065186", "Fabulosa Spring Blossom Room Spray"],
  ["8700216003773", "Fairy Pomegranate & Grapefruit Washing-Up Liquid"],
  ["5011451102996", "Simple Kind to Hair Gentle Care Shampoo"],
  ["8718951424180", "Palmolive Love in Bloom Shower Gel"],
  ["5010052114209", "Golden Wonder Ringos Salt & Vinegar"],
  ["7622202817007", "Maynards Wine Gums"],
  ["5000237206690", "McCoy’s Cheddar & Onion Ridge-Cut Crisps"],
  ["5000168006260", "McVitie’s Chocolate Digestives"],
  ["5000168006024", "McVitie’s Digestives"],
  ["5000168006338", "McVitie’s Ginger Nuts"],
  ["5000168006062", "McVitie’s Jaffa Cakes"],
  ["7622210785114", "Oreo Choco Cake"],
  ["5000147030149", "Robinsons Apple & Blackcurrant 1L"],
  ["5000147030125", "Robinsons Orange 1L"],
  ["5000147030699", "Robinsons Fruit & Barley Peach 1L"],
  ["5010102346437", "Robinsons Summer Fruits 750ml"],
  ["5010102240841", "Robinsons Apple & Blackcurrant 3L", 4],
  ["8004260264006", "Nicky Elite Toilet Tissue"],
  ["8004260428293", "Nicky Elite Toilet Tissue — Smaller Pack"],
  ["5010265000801", "Ryvita Original Crackerbread"],
  ["5010353318733", "Minky Sure Grip Laundry Pegs"],
];

const barcodeLessGroups = [
  ["5010102003804", "Tango Orange Bottle", "Tango Orange bottle"],
  ["5010975088243", "Tunnock’s Dark Chocolate Tea Cakes", "Tunnock's Dark Chocolate Tea Cakes"],
  ["40099361", "Wrigley’s Extra Peppermint Chewing Gum", "Wrigley's Extra Peppermint Chewing Gum"],
  ["3057640316098", "Volvic Touch of Fruit Lemon & Lime Sugar Free", "Volvic Touch of Fruit Lemon & Lime Sugar Free"],
  ["3057640569043", "Volvic Touch of Fruit Peach & Raspberry Sugar Free", "Volvic Touch of Fruit Peach & Raspberry Sugar Free"],
  ["3057640308338", "Volvic Touch of Fruit Strawberry Sugar Free", "Volvic Touch of Fruit Strawberry Sugar Free"],
  ["3057640600128", "Volvic Touch of Fruit Cherry Sugar Free", "Volvic Touch of Fruit Cherry Sugar Free"],
];

const client = await db.pool.connect();
try {
  await client.query("BEGIN");
  const locked = await client.query("SELECT value FROM store_state WHERE key = 'products' FOR UPDATE");
  const original = Array.isArray(locked.rows[0]?.value) ? locked.rows[0].value : [];
  let products = original.map((product) => ({ ...product }));
  const actions = [];

  const enrich = (keeper, source) => {
    if (!source) return keeper;
    const next = { ...keeper };
    for (const field of ["size", "supplier", "cost", "caseBarcode", "caseQuantity", "notes", "keyProduct"]) {
      if ((next[field] == null || next[field] === "" || next[field] === 0) && source[field] != null && source[field] !== "") next[field] = source[field];
    }
    return next;
  };

  for (const [barcode, canonicalName, price] of exactGroups) {
    const group = products.filter((product) => String(product.barcode || "").trim() === barcode);
    if (!group.length) continue;
    const keeper = group[0];
    const bestNamed = group.find((product) => tidy(product.name) === tidy(canonicalName)) || group.find((product) => String(product.name || "").length > String(keeper.name || "").length);
    const updated = { ...enrich(keeper, bestNamed), name: canonicalName, ...(price == null ? {} : { price }) };
    const removeIds = new Set(group.slice(1).map((product) => product.id));
    products = products.map((product) => product.id === keeper.id ? updated : product).filter((product) => !removeIds.has(product.id));
    actions.push({ canonicalName, barcode, removed: removeIds.size, stockKept: keeper.stock, price: updated.price });
  }

  // Keep the £3 Pick & Mix line separate; merge only the two £1 Maynards lines.
  {
    const barcode = "7622202815225";
    const group = products.filter((product) => String(product.barcode || "").trim() === barcode);
    const keeper = group.find((product) => Number(product.price) === 1 && /maynards/i.test(product.name || "")) || group.find((product) => Number(product.price) === 1);
    if (keeper) {
      const removeIds = new Set(group.filter((product) => product.id !== keeper.id && Number(product.price) === 1).map((product) => product.id));
      products = products.map((product) => product.id === keeper.id ? { ...product, name: "Maynards Liquorice Allsorts" } : product).filter((product) => !removeIds.has(product.id));
      actions.push({ canonicalName: "Maynards Liquorice Allsorts", barcode, removed: removeIds.size, stockKept: keeper.stock, price: keeper.price });
    }
  }

  for (const [barcode, canonicalName, oldName] of barcodeLessGroups) {
    const keeper = products.find((product) => String(product.barcode || "").trim() === barcode);
    if (!keeper) continue;
    const duplicate = products.find((product) => product.id !== keeper.id && !String(product.barcode || "").trim() && tidy(product.name) === tidy(oldName));
    const updated = { ...enrich(keeper, duplicate), name: canonicalName };
    products = products.map((product) => product.id === keeper.id ? updated : product).filter((product) => product.id !== duplicate?.id);
    actions.push({ canonicalName, barcode, removed: duplicate ? 1 : 0, stockKept: keeper.stock, price: updated.price });
  }

  const backupKey = `catalogue_backup_2026_07_30_pre_merge`;
  if (apply) {
    await client.query(
      "INSERT INTO store_state (key, value, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
      [backupKey, JSON.stringify(original)],
    );
    await client.query(
      "UPDATE store_state SET value = $1::jsonb, updated_at = NOW() WHERE key = 'products'",
      [JSON.stringify(products)],
    );
    await client.query("COMMIT");
  } else {
    await client.query("ROLLBACK");
  }
  console.log(JSON.stringify({ mode: apply ? "applied" : "dry-run", before: original.length, after: products.length, backupKey, actions }, null, 2));
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await db.pool.end();
}
