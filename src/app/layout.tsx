import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { SessionProvider } from "@/components/streaming/SessionProvider";
import { ScrollTop } from "@/components/streaming/ScrollTop";
import { PWARegister } from "@/components/streaming/PWARegister";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "StreamVerse — Streaming Universal: Filme, Seriale, Anime, Muzică, Sport",
  description:
    "Platforma de streaming supremă: filme, seriale, anime, desene animate, muzică, documentare, telenovele, sport, gaming și știri — din 6 continente și 196 de țări.",
  keywords: ["streaming", "filme", "seriale", "anime", "muzică", "sport", "disney", "marvel", "cartoon network"],
  applicationName: "StreamVerse",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "StreamVerse",
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0f",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ro" className="dark" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-[#0a0a0f] text-zinc-100 min-h-screen`}
      >
        <SessionProvider>
          {children}
          <ScrollTop />
        </SessionProvider>
        <PWARegister />
        <Toaster />
      </body>
    </html>
  );
}
