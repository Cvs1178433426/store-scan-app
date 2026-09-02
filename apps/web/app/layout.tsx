import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "./brand.css";
import { RegisterServiceWorker } from "./register-sw";
import { AuthProvider } from "../lib/auth-context";
import { ToastProvider } from "../lib/toast-context";
import { ThemeProvider } from "../lib/theme-context";
import { LocaleProvider } from "../lib/i18n/locale-context";
import { BottomNav } from "../components/BottomNav";
import { OfflineBanner } from "../components/OfflineBanner";
import { RetailScannerAssist } from "../components/RetailScannerAssist";
import { BRAND_NAME, BRAND_TAGLINE } from "../lib/brand";

const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("continuixai_theme");if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t);}}catch(e){}})();`;

const APPLE_STARTUP_IMAGES = [
  { href: "/launch/continuixai-launch-1320x2868.png", media: "(device-width: 440px) and (device-height: 956px) and (-webkit-device-pixel-ratio: 3)" },
  { href: "/launch/continuixai-launch-1206x2622.png", media: "(device-width: 402px) and (device-height: 874px) and (-webkit-device-pixel-ratio: 3)" },
  { href: "/launch/continuixai-launch-1290x2796.png", media: "(device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3)" },
  { href: "/launch/continuixai-launch-1179x2556.png", media: "(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3)" },
  { href: "/launch/continuixai-launch-1242x2688.png", media: "(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 3)" },
  { href: "/launch/continuixai-launch-828x1792.png", media: "(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 2)" },
  { href: "/launch/continuixai-launch-1125x2436.png", media: "(device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3)" },
  { href: "/launch/continuixai-launch-750x1334.png", media: "(device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2)" },
] as const;

export const metadata: Metadata = {
  title: {
    default: BRAND_NAME,
    template: `%s · ${BRAND_NAME}`,
  },
  description: `${BRAND_TAGLINE} Mobile-first operations, barcode scanning, store counting, inventory, distribution, and team work management.`,
  applicationName: BRAND_NAME,
  appleWebApp: {
    capable: true,
    title: BRAND_NAME,
    statusBarStyle: "black-translucent",
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
    { media: "(prefers-color-scheme: light)", color: "#16235A" },
    { media: "(prefers-color-scheme: dark)", color: "#0E1733" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {APPLE_STARTUP_IMAGES.map((startupImage) => (
          <link key={startupImage.href} rel="apple-touch-startup-image" href={startupImage.href} media={startupImage.media} />
        ))}
      </head>
      <body>
        <RegisterServiceWorker />
        <RetailScannerAssist />
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
