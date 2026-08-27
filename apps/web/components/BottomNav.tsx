"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "../lib/auth-context";

type NavItem = {
  href: string;
  label: string;
  symbol: string;
  primary?: boolean;
  adminOnly?: boolean;
};

const NAV_ITEMS: NavItem[] = [
  { href: "/store-count", label: "Count", symbol: "▦", primary: true },
  { href: "/store-scan", label: "Add", symbol: "⌁" },
  { href: "/store-products", label: "Products", symbol: "□" },
  { href: "/store-locations", label: "Locations", symbol: "⌖" },
  { href: "/settings", label: "Settings", symbol: "⚙", adminOnly: true },
];

export function BottomNav() {
  const pathname = usePathname();
  const { isAdmin } = useAuth();

  if (pathname === "/login" || pathname.startsWith("/i/")) return null;

  const visibleItems = NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin);

  return (
    <nav className="bottom-nav" aria-label="Store Scan navigation">
      <div className="bottom-nav-inner">
        {visibleItems.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`${item.primary ? "scan-tab" : ""} ${active ? "active" : ""}`.trim()}
              aria-current={active ? "page" : undefined}
            >
              <span className={item.primary ? "icon-wrap" : undefined}>
                <span className="icon" aria-hidden>{item.symbol}</span>
              </span>
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
