import { verifyStaffSession } from "../../session/auth";
import { getStore } from "../../store";
import { mutateLocalState } from "../local-store";
import { bumpRev, readProducts, removeProduct, writeProduct } from "../../shop-db";

export const dynamic = "force-dynamic";

// Saves or deletes ONE product: its row is written on its own, so editing a
// price on one tablet never touches any other product. Stock is no longer
// counted (Nov 2026); a product is its name, price, barcode and details.

type Product = { id: string; name?: string; [key: string]: unknown };

function localSave(product: Product) {
  return mutateLocalState((state) => {
    const products = Array.isArray(state.products) ? (state.products as Product[]) : [];
    const next = products.some((candidate) => candidate.id === product.id)
      ? products.map((candidate) => (candidate.id === product.id ? product : candidate))
      : [...products, product];
    return { state: { ...state, products: next }, result: next };
  });
}

function localDelete(id: string) {
  return mutateLocalState((state) => {
    const products = Array.isArray(state.products) ? (state.products as Product[]) : [];
    const next = products.filter((product) => product.id !== id);
    return { state: { ...state, products: next }, result: next };
  });
}

export async function POST(request: Request) {
  if (!(await verifyStaffSession(request))) return Response.json({ error: "Unauthorised" }, { status: 401 });
  try {
    const body = await request.json() as { product?: Product };
    const product = body.product;
    if (!product?.id || typeof product.id !== "string" || !product.name || typeof product.name !== "string") {
      return Response.json({ error: "Invalid product" }, { status: 400 });
    }
    try {
      const { db, ready } = getStore();
      await ready;
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        await writeProduct(client, product);
        await bumpRev(client);
        const products = await readProducts(client);
        await client.query("COMMIT");
        return Response.json({ data: { products } });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      if (process.env.NODE_ENV !== "development") throw error;
      return Response.json({ data: { products: await localSave(product) }, local: true });
    }
  } catch (error) {
    console.error("Product save failed", error);
    return Response.json({ error: error instanceof Error ? error.message : "Unable to save product" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  if (!(await verifyStaffSession(request))) return Response.json({ error: "Unauthorised" }, { status: 401 });
  try {
    const body = await request.json() as { id?: string };
    if (!body.id || typeof body.id !== "string") return Response.json({ error: "Invalid product" }, { status: 400 });
    try {
      const { db, ready } = getStore();
      await ready;
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        await removeProduct(client, body.id);
        await bumpRev(client);
        const products = await readProducts(client);
        await client.query("COMMIT");
        return Response.json({ data: { products } });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      if (process.env.NODE_ENV !== "development") throw error;
      return Response.json({ data: { products: await localDelete(body.id) }, local: true });
    }
  } catch (error) {
    console.error("Product delete failed", error);
    return Response.json({ error: error instanceof Error ? error.message : "Unable to delete product" }, { status: 500 });
  }
}
