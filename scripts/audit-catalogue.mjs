const secret = process.env.ALICE_STORE_ACCESS_CODE;
if (!secret) throw new Error("The Alice's Store access setting is unavailable");
const payload = `Catalogue audit:${Date.now() + 10 * 60 * 1000}`;
const key = await crypto.subtle.importKey(
  "raw",
  new TextEncoder().encode(secret),
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign"],
);
const signature = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))).toString("hex");
const cookie = `alice-staff-session=${encodeURIComponent(payload)}.${signature}`;
const { request } = await import("node:https");
const body = await new Promise((resolve, reject) => {
  const req = request({
    hostname: "the-ryfields-shop.netlify.app",
    path: "/api/state",
    method: "GET",
    headers: { Cookie: cookie },
  }, (res) => {
    let data = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => { data += chunk; });
    res.on("end", () => {
      if (res.statusCode !== 200) reject(new Error(`Catalogue read failed (${res.statusCode})`));
      else resolve(JSON.parse(data));
    });
  });
  req.on("error", reject);
  req.end();
});
const products = Array.isArray(body.data?.products) ? body.data.products : [];

const normalise = (value = "") => String(value)
  .toLowerCase()
  .replace(/&/g, " and ")
  .replace(/[^a-z0-9]+/g, " ")
  .trim()
  .split(/\s+/)
  .filter(Boolean)
  .map((word) => word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word);

const set = (values) => new Set(values);
const shared = (left, right) => [...left].filter((word) => right.has(word));
const compact = (product) => ({
  id: product.id,
  name: product.name || "",
  size: product.size || "",
  barcode: product.barcode || "",
  stock: Number(product.stock) || 0,
  price: Number(product.price) || 0,
  category: product.category || "",
  supplier: product.supplier || "",
});

const withBarcode = products.filter((product) => String(product.barcode || "").trim());
const withoutBarcode = products.filter((product) => !String(product.barcode || "").trim());
const candidates = [];

for (const newer of withBarcode) {
  const newerWords = set(normalise(`${newer.name || ""} ${newer.size || ""}`));
  for (const older of withoutBarcode) {
    const olderWords = set(normalise(`${older.name || ""} ${older.size || ""}`));
    if (!newerWords.size || !olderWords.size) continue;
    const common = shared(newerWords, olderWords);
    const coverage = common.length / Math.min(newerWords.size, olderWords.size);
    const union = new Set([...newerWords, ...olderWords]).size;
    const jaccard = union ? common.length / union : 0;
    const sameSize = Boolean(newer.size && older.size && normalise(newer.size).join(" ") === normalise(older.size).join(" "));
    const samePrice = Math.abs((Number(newer.price) || 0) - (Number(older.price) || 0)) < 0.01;
    const exactName = normalise(newer.name).join(" ") === normalise(older.name).join(" ");
    const score = coverage * 0.55 + jaccard * 0.25 + (sameSize ? 0.1 : 0) + (samePrice ? 0.05 : 0) + (exactName ? 0.15 : 0);
    if (exactName || (common.length >= 2 && coverage >= 0.66) || (common.length === 1 && coverage === 1 && sameSize)) {
      candidates.push({
        confidence: score >= 0.78 ? "very likely" : score >= 0.62 ? "possible" : "weak",
        score: Number(score.toFixed(3)),
        sharedWords: common,
        keep: compact(newer),
        reviewOrRemove: compact(older),
      });
    }
  }
}

const exactBarcodeGroups = Object.entries(Object.groupBy(withBarcode, (product) => String(product.barcode).trim()))
  .filter(([, group]) => group.length > 1)
  .map(([barcode, group]) => ({ barcode, products: group.map(compact) }));

candidates.sort((a, b) => b.score - a.score || a.keep.name.localeCompare(b.keep.name));
console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  productCount: products.length,
  withBarcode: withBarcode.length,
  withoutBarcode: withoutBarcode.length,
  exactBarcodeGroups,
  candidates,
}, null, 2));
