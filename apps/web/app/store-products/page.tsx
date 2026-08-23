"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiJson } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import { useToast } from "../../lib/toast-context";

type Category = { id: string; name: string; isActive?: boolean };
type Barcode = { value: string; isPrimary?: boolean };
type Item = {
  id: string;
  name: string;
  manufacturer?: string | null;
  description?: string | null;
  packageSize?: string | null;
  photoUrl?: string | null;
  categoryId?: string | null;
  category?: Category | null;
  isActive?: boolean;
  barcodes?: Barcode[];
};

type NewProduct = {
  name: string;
  manufacturer: string;
  description: string;
  packageSize: string;
  photoUrl: string;
  categoryId: string;
  barcodeValue: string;
};

const emptyProduct: NewProduct = {
  name: "",
  manufacturer: "",
  description: "",
  packageSize: "",
  photoUrl: "",
  categoryId: "",
  barcodeValue: "",
};

export default function StoreProductsPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const { show } = useToast();
  const [items, setItems] = useState<Item[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [query, setQuery] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newProduct, setNewProduct] = useState<NewProduct>(emptyProduct);
  const [savingNew, setSavingNew] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [loading, user, router]);

  async function load() {
    const [products, categoryRows] = await Promise.all([
      apiJson<Item[] | { items: Item[] }>("/api/items"),
      apiJson<Category[]>("/api/categories"),
    ]);
    setItems(Array.isArray(products) ? products : products.items);
    setCategories(categoryRows.filter((category) => category.isActive !== false));
  }

  useEffect(() => {
    if (user) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => {
      if (!showInactive && item.isActive === false) return false;
      if (!needle) return true;
      const barcode = item.barcodes?.map((row) => row.value).join(" ") ?? "";
      return [item.name, item.manufacturer ?? "", item.description ?? "", barcode]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [items, query, showInactive]);

  async function setActive(item: Item, active: boolean) {
    setBusyId(item.id);
    try {
      await apiJson(`/api/items/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: active }),
      });
      setItems((rows) => rows.map((row) => (row.id === item.id ? { ...row, isActive: active } : row)));
      show(`${item.name} ${active ? "activated" : "made inactive"}`, "success");
    } catch (error) {
      show(error instanceof Error ? error.message : "Could not update product.", "error");
    } finally {
      setBusyId(null);
    }
  }

  async function addProduct(event: FormEvent) {
    event.preventDefault();
    if (!newProduct.name.trim()) return;
    setSavingNew(true);
    try {
      await apiJson("/api/items", {
        method: "POST",
        body: JSON.stringify({
          name: newProduct.name.trim(),
          manufacturer: newProduct.manufacturer.trim() || null,
          description: newProduct.description.trim() || null,
          packageSize: newProduct.packageSize.trim() || null,
          photoUrl: newProduct.photoUrl.trim() || null,
          categoryId: newProduct.categoryId || null,
          barcodeValue: newProduct.barcodeValue.trim() || undefined,
          quantity: 1,
          itemType: "CONSUMABLE",
          isActive: true,
        }),
      });
      show(`${newProduct.name.trim()} added`, "success");
      setNewProduct(emptyProduct);
      setAdding(false);
      await load();
    } catch (error) {
      show(error instanceof Error ? error.message : "Could not add product.", "error");
    } finally {
      setSavingNew(false);
    }
  }

  if (loading || !user) return null;

  return (
    <main className="container" style={{ maxWidth: 760, paddingBottom: 40 }}>
      <header style={{ display: "flex", alignItems: "end", justifyContent: "space-between", gap: 12, marginBottom: 16 }}>
        <div>
          <p style={{ margin: 0, opacity: 0.65, fontSize: 13, fontWeight: 700, letterSpacing: ".08em" }}>STORE SURVEY</p>
          <h1 style={{ margin: "3px 0 0" }}>Products</h1>
        </div>
        <button type="button" onClick={() => setAdding((value) => !value)}>{adding ? "Close" : "Add manually"}</button>
      </header>

      {adding && (
        <form onSubmit={addProduct} className="card" style={{ padding: 16, marginBottom: 16, display: "grid", gap: 10 }}>
          <strong>Manual product entry</strong>
          <input placeholder="Product name *" value={newProduct.name} onChange={(event) => setNewProduct({ ...newProduct, name: event.target.value })} />
          <input placeholder="Manufacturer / Brand" value={newProduct.manufacturer} onChange={(event) => setNewProduct({ ...newProduct, manufacturer: event.target.value })} />
          <textarea rows={2} placeholder="Description" value={newProduct.description} onChange={(event) => setNewProduct({ ...newProduct, description: event.target.value })} />
          <input placeholder="Size / Pack" value={newProduct.packageSize} onChange={(event) => setNewProduct({ ...newProduct, packageSize: event.target.value })} />
          <input inputMode="numeric" placeholder="UPC (optional)" value={newProduct.barcodeValue} onChange={(event) => setNewProduct({ ...newProduct, barcodeValue: event.target.value })} />
          <input placeholder="Product image URL (optional)" value={newProduct.photoUrl} onChange={(event) => setNewProduct({ ...newProduct, photoUrl: event.target.value })} />
          <select value={newProduct.categoryId} onChange={(event) => setNewProduct({ ...newProduct, categoryId: event.target.value })}>
            <option value="">Category (optional)</option>
            {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
          </select>
          <button type="submit" disabled={savingNew || !newProduct.name.trim()}>{savingNew ? "Saving…" : "Save product"}</button>
        </form>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, brand, or UPC" style={{ flex: 1 }} />
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, fontSize: 14 }}>
        <input type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} style={{ width: 18, height: 18 }} />
        Show inactive products
      </label>

      <div style={{ display: "grid", gap: 9 }}>
        {visible.map((item) => {
          const active = item.isActive !== false;
          const primaryBarcode = item.barcodes?.find((barcode) => barcode.isPrimary) ?? item.barcodes?.[0];
          return (
            <article key={item.id} className="card" style={{ padding: 14, display: "grid", gridTemplateColumns: item.photoUrl ? "72px 1fr auto" : "1fr auto", gap: 12, alignItems: "center", opacity: active ? 1 : 0.6 }}>
              {item.photoUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.photoUrl} alt="" style={{ width: 72, height: 72, objectFit: "contain", background: "white", borderRadius: 10 }} />
              )}
              <div style={{ minWidth: 0 }}>
                <strong>{item.name}</strong>
                <div style={{ fontSize: 13, opacity: 0.7, marginTop: 3 }}>
                  {[item.manufacturer, item.packageSize, item.category?.name].filter(Boolean).join(" · ") || "No additional details"}
                </div>
                <div style={{ fontSize: 12, opacity: 0.58, marginTop: 3 }}>
                  {primaryBarcode?.value ? `UPC ${primaryBarcode.value}` : "No UPC"} · {active ? "Active" : "Inactive"}
                </div>
              </div>
              <button type="button" className="secondary" disabled={busyId === item.id} onClick={() => void setActive(item, !active)}>
                {active ? "Inactive" : "Activate"}
              </button>
            </article>
          );
        })}
      </div>
    </main>
  );
}
