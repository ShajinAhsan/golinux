import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, JetBrains_Mono } from "next/font/google";
import { SITE } from "@/lib/site";
import "./globals.css";

const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-bricolage",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jetbrains-mono",
});

export const viewport: Viewport = {
  themeColor: "#ffffff",
  colorScheme: "light",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: {
    default: SITE.title,
    template: "%s — GoLinux",
  },
  description: SITE.description,
  applicationName: SITE.name,
  keywords: [
    "Linux in browser",
    "Alpine Linux",
    "WebAssembly Linux",
    "v86",
    "xterm.js",
    "online Linux terminal",
    "TinyCC",
    "BusyBox",
    "offline Linux VM",
    "browser terminal",
    "OPFS",
    "GoLinux",
  ],
  authors: [{ name: "GoLinux", url: SITE.githubUrl }],
  creator: "GoLinux",
  publisher: "GoLinux",
  category: "Developer Tools",
  alternates: {
    canonical: "/",
  },
  icons: {
    icon: [
      { url: "/icons/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: SITE.url,
    siteName: SITE.name,
    title: SITE.title,
    description: SITE.description,
  },
  twitter: {
    card: "summary_large_image",
    title: SITE.title,
    description: SITE.description,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-snippet": -1,
      "max-image-preview": "large",
      "max-video-preview": -1,
    },
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${bricolage.variable} ${jetbrainsMono.variable}`}
    >
      <body className="min-h-screen bg-canvas font-sans text-ink antialiased selection:bg-ink selection:text-canvas">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-full focus:bg-ink focus:px-4 focus:py-2 focus:text-sm focus:font-bold focus:text-canvas focus:shadow-lg focus:ring-2 focus:ring-ink focus:ring-offset-2 focus:ring-offset-canvas focus:outline-none"
        >
          Skip to main content
        </a>

        <div className="relative z-10 flex min-h-screen flex-col">
          {children}
        </div>
      </body>
    </html>
  );
}
