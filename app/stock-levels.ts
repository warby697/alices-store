// Single source of truth for the "low stock" warning threshold.
//
// For now every product flags when it drops to 1 or fewer on the shelf. The
// per-product `lowStockLevel` override already works, so individual items can
// be given their own threshold later (e.g. a percentage of their `full` shelf
// target) without touching every screen - only this file needs to change.

export const DEFAULT_LOW_STOCK_LEVEL = 1;

type StockLike = { stock: number; full?: number; lowStockLevel?: number };

// The stock count at or below which a product counts as low.
export function lowStockLevelFor(product: StockLike): number {
  return typeof product.lowStockLevel === "number"
    ? product.lowStockLevel
    : DEFAULT_LOW_STOCK_LEVEL;
}

export function isLowStock(product: StockLike): boolean {
  return product.stock <= lowStockLevelFor(product);
}
