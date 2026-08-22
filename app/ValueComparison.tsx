"use client";

import { useMemo, useState } from "react";

type Product = {
  id: string;
  name: string;
  cost: number;
  price: number;
  size?: string;
  supplier?: string;
};

const money = (value: number) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(value);

const packWeight = (size?: string) => {
  const match = size?.match(/([0-9]+(?:\.[0-9]+)?)\s*(kg|g)\b/i);
  if (!match) return 0;
  return Number(match[1]) * (match[2].toLowerCase() === "kg" ? 1000 : 1);
};

const recommended = (cost: number) => Math.ceil(cost * 1.3 * 20) / 20;

export function ValueComparison({ products }: { products: Product[] }) {
  const [productId, setProductId] = useState(products[0]?.id || "");
  const [usualWeight, setUsualWeight] = useState(0);
  const [usualCost, setUsualCost] = useState(0);
  const [alternativeWeight, setAlternativeWeight] = useState(0);
  const [alternativeCost, setAlternativeCost] = useState(0);
  const [alternativeName, setAlternativeName] = useState("");
  const [shop, setShop] = useState("");
  const product = products.find((item) => item.id === productId);

  const selectProduct = (id: string) => {
    const next = products.find((item) => item.id === id);
    setProductId(id);
    setUsualWeight(packWeight(next?.size));
    setUsualCost(next?.cost || 0);
  };

  const result = useMemo(() => {
    const usualPer100 = usualWeight > 0 ? (usualCost / usualWeight) * 100 : 0;
    const alternativePer100 = alternativeWeight > 0 ? (alternativeCost / alternativeWeight) * 100 : 0;
    return { usualPer100, alternativePer100, difference: usualPer100 - alternativePer100 };
  }, [usualWeight, usualCost, alternativeWeight, alternativeCost]);

  const ready = result.usualPer100 > 0 && result.alternativePer100 > 0;

  return (
    <div className="admin-grid">
      <article className="report-card admin-form">
        <div className="section-title"><h2>Compare a substitute</h2><span>Enquiry only</span></div>
        <label>Usual product
          <select value={productId} onChange={(event) => selectProduct(event.target.value)}>
            <option value="">Choose a product</option>
            {products.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <div className="form-pair">
          <label>Usual pack weight (g)<input type="number" min="1" value={usualWeight || ""} onChange={(event) => setUsualWeight(Number(event.target.value))} /></label>
          <label>Usual buying price<input type="number" min="0" step=".01" value={usualCost || ""} onChange={(event) => setUsualCost(Number(event.target.value))} /></label>
        </div>
        <p className="cash-instruction">{product?.supplier ? `Normally bought from ${product.supplier}.` : "This product does not have a usual supplier yet."}</p>
        <label>Alternative product<input value={alternativeName} onChange={(event) => setAlternativeName(event.target.value)} placeholder="Product or brand name" /></label>
        <label>Shop<input value={shop} onChange={(event) => setShop(event.target.value)} placeholder="Where you found it" /></label>
        <div className="form-pair">
          <label>Alternative pack weight (g)<input type="number" min="1" value={alternativeWeight || ""} onChange={(event) => setAlternativeWeight(Number(event.target.value))} /></label>
          <label>Alternative buying price<input type="number" min="0" step=".01" value={alternativeCost || ""} onChange={(event) => setAlternativeCost(Number(event.target.value))} /></label>
        </div>
      </article>
      <article className="report-card">
        <div className="section-title"><h2>Value check</h2><span>No stock changed</span></div>
        {ready ? (
          <div className="comparison-result">
            <p><span>Usual cost per 100g</span><strong>{money(result.usualPer100)}</strong></p>
            <p><span>Alternative cost per 100g</span><strong>{money(result.alternativePer100)}</strong></p>
            <h3>{result.difference > 0 ? "The alternative is better value" : result.difference < 0 ? "The usual product is better value" : "They cost the same by weight"}</h3>
            {result.difference !== 0 && <p>{money(Math.abs(result.difference))} {result.difference > 0 ? "less" : "more"} per 100g.</p>}
            <p><span>Alternative minimum selling price</span><strong>{money(recommended(alternativeCost))}</strong></p>
            <p><span>Profit at current selling price</span><strong>{money((product?.price || 0) - alternativeCost)}</strong></p>
            <small>{alternativeName || "Alternative"}{shop ? ` from ${shop}` : ""} is only being compared. Nothing has been saved to stock.</small>
          </div>
        ) : <div className="empty-report">Enter both pack weights and buying prices to compare them fairly.</div>}
      </article>
    </div>
  );
}
