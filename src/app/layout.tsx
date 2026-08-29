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
  manifest: "/manifest.webmanifest",
  // iOS ne lit PAS le tableau `icons` du manifeste pour l'écran d'accueil : il
  // prend `apple-touch-icon`, et s'il le trouve il ignore le manifeste. Les
  // deux déclarations sont donc nécessaires, pas redondantes.
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    title: "Nexus",
    // La barre d'état se fond dans l'en-tête au lieu de rester une bande
    // blanche posée au-dessus — c'est ce qui distingue une application
    // installée d'un site en plein écran.
    statusBarStyle: "black-translucent",
  },
  // Les numéros de téléphone d'une fiche sont déjà des liens `tel:` explicites.
  // La détection automatique de Safari en fabriquait d'autres, mal découpés,
  // au milieu des notes et des adresses.
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // `viewport-fit=cover` n'est pas un détail esthétique : SANS lui, toutes les
  // valeurs `env(safe-area-inset-*)` valent zéro. La barre de navigation basse,
  // le socle du webphone et la barre d'action de la réservation reposent déjà
  // sur ces marges (`.pb-safe`, `.h-bottom-nav` dans globals.css, gelé) — elles
  // étaient donc, jusqu'ici, du code mort qui ne se voyait pas parce que la
  // barre d'adresse du navigateur cachait la faute. Installée, l'application
  // pose sinon ses boutons sous la barre de geste de l'iPhone.
  viewportFit: "cover",
  // Le clavier logiciel ne doit plus recouvrir le bas d'une boîte de dialogue :
  // le téléphoniste tape sa note d'après-appel et le bouton « Enregistrer »
  // était derrière le clavier.
  interactiveWidget: "resizes-content",
  // `maximumScale: 1` a été retiré. Bloquer le zoom est déjà un échec WCAG
  // 1.4.4 dans un onglet ; dans une application en plein écran, sans barre de
  // navigateur où se rabattre, c'est la seule façon d'agrandir un numéro de
  // téléphone lu d'une main dans une voiture.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#102034" },
    { media: "(prefers-color-scheme: dark)", color: "#102034" },
  ],
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
      {/*
        `overscroll-y-contain` coupe le CHAÎNAGE du défilement vers le geste de
        rechargement d'Android. globals.css est gelé, donc la règle voyage en
        classe utilitaire. Installée, l'application n'a plus de barre d'adresse :
        un pouce qui tire vers le bas en haut d'une liste rechargeait toute la
        page — perdant la note d'après-appel en cours de frappe, le brouillon de
        texto, et remontant la session JsSIP au milieu d'un appel.
      */}
      <body className="overscroll-y-contain antialiased">
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
