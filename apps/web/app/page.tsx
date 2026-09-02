"use client";

import Link from "next/link";
import Image from "next/image";
import { BrandLockup } from "../components/BrandLockup";
import { HomeGlyph, type HomeGlyphName } from "../components/HomeGlyph";
import { useAuth } from "../lib/auth-context";
import styles from "./home.module.css";

const primaryLauncher = {
  href: "/store-count",
  title: "Start or resume Count",
  description: "Scan items and record an accurate inventory count.",
  glyph: "count",
} as const;

const secondaryLaunchers: ReadonlyArray<{
  href: string;
  title: string;
  description: string;
  glyph: HomeGlyphName;
}> = [
  { href: "/my-work", title: "My Work", description: "Review today's assigned work.", glyph: "work" },
  { href: "/store-products", title: "Products", description: "Find and manage the product catalog.", glyph: "products" },
  { href: "/store-locations", title: "Locations", description: "View stores, zones, aisles, and bins.", glyph: "locations" },
];

function daypart(hour: number) {
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

export default function HomePage() {
  const { user, loading, logout } = useAuth();

  if (loading) {
    return (
      <main className={styles.launchScreen}>
        <section className={styles.launchPanel} aria-live="polite" aria-busy="true">
          <div className={styles.launchMarkWrap}>
            <Image className={styles.launchMark} src="/brand/continuixai-mark.svg" alt="" width={70} height={70} priority />
          </div>
          <p className={styles.launchName}>ContinuiXAi</p>
          <p className={styles.launchTagline}>Start simple. Stay in control. Grow with confidence.</p>
          <div className={styles.loadingRule} aria-hidden="true"><span /></div>
          <p className={styles.loadingStatus}>Preparing your workspace</p>
        </section>
      </main>
    );
  }

  if (!user) {
    return (
      <main className={styles.welcomeScreen}>
        <section className={styles.welcomeCard}>
          <div className={styles.welcomeBrand}><BrandLockup /></div>
          <div className={styles.welcomeEyebrow}>Retail operations, simplified</div>
          <h1>Inventory confidence starts here.</h1>
          <p className={styles.welcomeDescription}>Inventory, counting, and team operations—organized in one place.</p>
          <Link href="/login" className={styles.signInAction}>
            <span>Sign In</span>
            <span aria-hidden="true">→</span>
          </Link>
          <p className={styles.welcomeAssurance}>Secure access for authorized team members</p>
        </section>
      </main>
    );
  }

  const firstName = user.name.trim().split(/\s+/)[0] || "there";
  const greeting = `Good ${daypart(new Date().getHours())}, ${firstName}`;

  return (
    <main className={styles.homeShell}>
      <header className={styles.homeHeader}>
        <BrandLockup compact />
        <button type="button" className={styles.signOut} onClick={() => void logout()}>Sign Out</button>
      </header>

      <section className={styles.hero}>
        <p className={styles.heroEyebrow}>Your operations workspace</p>
        <h1>{greeting}</h1>
        <p>Everything you need to keep work moving and inventory accurate.</p>
      </section>

      <section className={styles.actionSection} aria-labelledby="start-work-heading">
        <h2 id="start-work-heading">Start working</h2>
        <Link href={primaryLauncher.href} className={styles.primaryAction}>
          <span className={styles.primaryGlyph}><HomeGlyph name={primaryLauncher.glyph} /></span>
          <span className={styles.actionCopy}>
            <strong>{primaryLauncher.title}</strong>
            <span>{primaryLauncher.description}</span>
          </span>
          <span className={styles.actionArrow} aria-hidden="true">→</span>
        </Link>
      </section>

      <section className={styles.actionSection} aria-labelledby="workspace-heading">
        <h2 id="workspace-heading">Your workspace</h2>
        <div className={styles.secondaryGrid}>
          {secondaryLaunchers.map((launcher) => (
            <Link key={launcher.href} href={launcher.href} className={styles.secondaryAction}>
              <span className={styles.secondaryGlyph}><HomeGlyph name={launcher.glyph} /></span>
              <span className={styles.actionCopy}>
                <strong>{launcher.title}</strong>
                <span>{launcher.description}</span>
              </span>
              <span className={styles.cardArrow} aria-hidden="true">→</span>
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
