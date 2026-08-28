import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { RegisterServiceWorker } from "./register-sw";
import { AuthProvider } from "../lib/auth-context";
import { ToastProvider } from "../lib/toast-context";
import { ThemeProvider } from "../lib/theme-context";
import { LocaleProvider } from "../lib/i18n/locale-context";
import { BottomNav } from "../components/BottomNav";
import { OfflineBanner } from "../components/OfflineBanner";

const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("stash_theme");if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t);}}catch(e){}})();`;

export const metadata: Metadata = {
  title: {
    default: "Store Scan",
    template: "%s · Store Scan",
  },
  description: "Mobile-first barcode scanning, product identification, store counting, and inventory organization.",
  applicationName: "Store Scan",
  appleWebApp: {
    capable: true,
    title: "Store Scan",
    statusBarStyle: "default",
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    icon: "/icons/icon.svg",
    apple: "/icons/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#1d5fa8" },
    { media: "(prefers-color-scheme: dark)", color: "#121212" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <RegisterServiceWorker />
        <LocaleProvider>
          <ThemeProvider>
            <ToastProvider>
              <AuthProvider>
                <OfflineBanner />
                {children}
                <BottomNav />
              </AuthProvider>
            </ToastProvider>
          </ThemeProvider>
        </LocaleProvider>
      </body>
    </html>
  );
}
