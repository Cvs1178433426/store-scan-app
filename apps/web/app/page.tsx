"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { BrandLockup } from "../components/BrandLockup";
import { useAuth } from "../lib/auth-context";

const launchers = [
  { href: "/store-count", title: "Count", description: "Start or resume inventory counting" },
  { href: "/my-work", title: "My Work", description: "See today's assigned work" },
  { href: "/store-products", title: "Products", description: "Find and manage products" },
  { href: "/store-locations", title: "Locations", description: "View store locations and zones" },
] as const;

function daypart(hour: number) {
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

export default function HomePage() {
  const router = useRouter();
  const { user, loading, logout } = useAuth();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, router, user]);

  if (loading || !user) {
    return (
      <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
        <section style={{ textAlign: "center" }}>
          <BrandLockup />
          <p style={{ color: "var(--color-text-muted)", marginTop: 18 }}>Connecting securely...</p>
        </section>
      </main>
    );
  }

  const firstName = user.name.trim().split(/\s+/)[0] || "there";
  const greeting = `Good ${daypart(new Date().getHours())}, ${firstName} — ready to start working?`;

  return (
    <main style={{ maxWidth: 820, margin: "0 auto", padding: "32px 18px 110px" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 34 }}>
        <BrandLockup />
        <button type="button" className="secondary" onClick={() => void logout()} style={{ width: "auto", minHeight: 42, padding: "8px 14px" }}>Sign Out</button>
      </header>
      <section style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: "clamp(26px, 5vw, 38px)", lineHeight: 1.15, letterSpacing: "-0.025em", margin: "0 0 10px" }}>{greeting}</h1>
        <p style={{ color: "var(--color-text-secondary)", fontSize: 16, margin: 0 }}>Choose where you want to work.</p>
      </section>
      <section aria-label="ContinuiXai applications" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
        {launchers.map((launcher) => (
          <Link key={launcher.href} href={launcher.href} style={{ minHeight: 150, display: "flex", flexDirection: "column", justifyContent: "center", padding: 24, border: "1px solid var(--color-border)", borderRadius: 20, background: "var(--color-surface)", boxShadow: "0 8px 24px rgba(0,0,0,0.06)", textDecoration: "none" }}>
            <strong style={{ fontSize: 25, lineHeight: 1.2, color: "var(--color-text)" }}>{launcher.title}</strong>
            <span style={{ marginTop: 9, fontSize: 15, lineHeight: 1.4, color: "var(--color-text-secondary)" }}>{launcher.description}</span>
          </Link>
        ))}
      </section>
    </main>
  );
}
