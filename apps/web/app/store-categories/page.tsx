"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiJson } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import { useToast } from "../../lib/toast-context";

type Category = {
  id: string;
  name: string;
  parentId: string | null;
  isActive?: boolean;
  _count?: { items: number };
};

export default function StoreCategoriesPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const { show } = useToast();
  const [categories, setCategories] = useState<Category[]>([]);
  const [name, setName] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [loading, user, router]);

  async function load() {
    const rows = await apiJson<Category[]>("/api/categories");
    setCategories(rows);
  }

  useEffect(() => {
    if (user) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const visible = useMemo(
    () => categories.filter((category) => showInactive || category.isActive !== false),
    [categories, showInactive],
  );

  async function addCategory(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const duplicate = categories.find((category) => category.name.toLowerCase() === trimmed.toLowerCase());
    if (duplicate) {
      if (duplicate.isActive === false) {
        await setActive(duplicate, true);
        setName("");
        return;
      }
      show("That category already exists.", "error");
      return;
    }

    try {
      await apiJson("/api/categories", {
        method: "POST",
        body: JSON.stringify({ name: trimmed, parentId: null, isActive: true }),
      });
      setName("");
      await load();
      show(`${trimmed} added`, "success");
    } catch (error) {
      show(error instanceof Error ? error.message : "Could not add category.", "error");
    }
  }

  async function setActive(category: Category, active: boolean) {
    setBusyId(category.id);
    try {
      await apiJson(`/api/categories/${category.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: active }),
      });
      setCategories((rows) => rows.map((row) => (row.id === category.id ? { ...row, isActive: active } : row)));
      show(`${category.name} ${active ? "activated" : "made inactive"}`, "success");
    } catch (error) {
      show(error instanceof Error ? error.message : "Could not update category.", "error");
    } finally {
      setBusyId(null);
    }
  }

  if (loading || !user) return null;

  return (
    <main className="container" style={{ maxWidth: 680, paddingBottom: 40 }}>
      <header style={{ marginBottom: 18 }}>
        <p style={{ margin: 0, opacity: 0.65, fontSize: 13, fontWeight: 700, letterSpacing: ".08em" }}>STORE SURVEY</p>
        <h1 style={{ margin: "3px 0 6px" }}>Categories</h1>
        <p style={{ margin: 0, opacity: 0.72 }}>Keep the list short and useful. Inactive categories stay in the database but are hidden from scanning.</p>
      </header>

      <form onSubmit={addCategory} style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Add category" style={{ flex: 1 }} />
        <button type="submit" disabled={!name.trim()}>Add</button>
      </form>

      <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, fontSize: 14 }}>
        <input type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} style={{ width: 18, height: 18 }} />
        Show inactive categories
      </label>

      <div style={{ display: "grid", gap: 8 }}>
        {visible.map((category) => {
          const active = category.isActive !== false;
          return (
            <div key={category.id} className="card" style={{ padding: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div>
                <strong>{category.name}</strong>
                <div style={{ fontSize: 12, opacity: 0.65, marginTop: 3 }}>
                  {category._count?.items ?? 0} products · {active ? "Active" : "Inactive"}
                </div>
              </div>
              <button
                type="button"
                className="secondary"
                disabled={busyId === category.id}
                onClick={() => void setActive(category, !active)}
              >
                {active ? "Make inactive" : "Activate"}
              </button>
            </div>
          );
        })}
      </div>
    </main>
  );
}
