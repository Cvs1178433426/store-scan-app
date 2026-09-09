"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiJson } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import { useToast } from "../../lib/toast-context";
import { useLocale } from "../../lib/i18n/locale-context";
import type { User } from "../../lib/types";
import { PhoneRecoveryAdmin } from "../../components/PhoneRecoveryAdmin";

export default function UsersPage() {
  const router = useRouter();
  const { user, loading, isAdmin } = useAuth();
  const { show } = useToast();
  const { t } = useLocale();
  const [users, setUsers] = useState<User[]>([]);

  useEffect(() => {
    if (!loading && !user) router.push("/login");
    else if (!loading && user && !isAdmin) router.push("/");
  }, [loading, user, isAdmin, router]);

  async function refresh() {
    setUsers(await apiJson<User[]>("/api/auth/users"));
  }

  useEffect(() => {
    if (isAdmin) refresh();
  }, [isAdmin]);

  async function handleDelete(id: string) {
    if (!confirm(t("confirmDeleteAccount"))) return;
    try {
      await apiJson(`/api/auth/users/${id}`, { method: "DELETE" });
      await refresh();
    } catch (err: any) {
      show(err.message, "error");
    }
  }

  if (loading || !user || !isAdmin) return null;

  return (
    <main className="container">
      <h1>{t("usersTitle")}</h1>
      <section className="card" style={{ marginBottom: 16 }}>
        <p>{t("userSelfRegistrationHelp")}</p>
      </section>

      {users.map((u) => (
        <div key={u.id} className="tree-row">
          <div>
            {u.name} ({u.email}) <span className="badge badge-muted">{u.role === "ADMIN" ? t("roleAdmin") : t("roleGeneral")}</span>
          </div>
          {u.id !== user.id && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="secondary" onClick={() => void handleDelete(u.id)}>
                {t("delete")}
              </button>
              {u.phoneVerified && <PhoneRecoveryAdmin userId={u.id} userName={u.name} />}
            </div>
          )}
        </div>
      ))}
    </main>
  );
}
