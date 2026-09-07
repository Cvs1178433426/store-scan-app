import type { ReactNode } from "react";

export type HomeGlyphName = "count" | "work" | "products" | "locations";

const paths: Record<HomeGlyphName, ReactNode> = {
  count: <><path d="M4 4h4v4H4zM16 4h4v4h-4zM4 16h4v4H4z" /><path d="M11 4v2M13 4v2M11 9v6M13 9v6M16 11h4M16 13h4M11 18v2M13 18v2M17 17h3v3h-3z" /></>,
  work: <><path d="M8 7V5.5A1.5 1.5 0 0 1 9.5 4h5A1.5 1.5 0 0 1 16 5.5V7" /><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M3 12h18M9.5 12v2h5v-2" /></>,
  products: <><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z" /><path d="m4 7.5 8 4.5 8-4.5M12 12v9M8 5.25l8 4.5" /></>,
  locations: <><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.5" /></>,
};

export function HomeGlyph({ name }: { name: HomeGlyphName }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  );
}
