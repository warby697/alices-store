import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Alice’s Store POS",
  description: "Friendly, accessible checkout and stock control for Alice’s Store.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg", apple: "/favicon.svg" },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Alice’s Store",
  },
  other: { "mobile-web-app-capable": "yes", "apple-mobile-web-app-capable": "yes" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
