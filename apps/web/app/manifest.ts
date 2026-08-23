import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Store Scan",
    short_name: "Store Scan",
    description: "Mobile-first barcode scanning, product identification, store counting, and inventory organization.",
    start_url: "/store-scan",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#1d5fa8",
    orientation: "portrait",
    categories: ["business", "productivity", "utilities"],
    icons: [
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      {
        name: "Scan Product",
        short_name: "Scan",
        description: "Open the product scanner.",
        url: "/store-scan",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
      {
        name: "Products",
        short_name: "Products",
        description: "Search and manage products.",
        url: "/store-products",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
      {
        name: "Categories",
        short_name: "Categories",
        description: "Manage product categories.",
        url: "/store-categories",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
    ],
  };
}
