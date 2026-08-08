import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";
import { Toaster } from "sonner";
import "./globals.css";

// La variable s'appelle --font-sans (et non --font-geist-sans) : globals.css
// (gelé) référence var(--font-sans) dans son @theme — sans cette définition,
// toute l'app retombait sur la police serif par défaut du navigateur.
const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Groupe Nexus",
    template: "%s · Groupe Nexus",
  },
  description: "CRM immobilier — Groupe Nexus",
  applicationName: "Groupe Nexus",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#1e3a5f",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  return (
    // Variables de police sur <html> : le preflight Tailwind applique
    // font-family: var(--font-sans) à html — définies plus bas (body), la
    // variable ne s'y résolvait pas et tout héritait du serif du navigateur.
    <html lang={locale} className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="antialiased">
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
