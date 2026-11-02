import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

// En-têtes de sécurité sur TOUTES les réponses. Vercel posait HSTS de lui-même ;
// derrière Cloudflare (Tayoo Ops) personne ne le fait — l'app les déclare donc,
// identiques sur les deux hébergements. Pas de CSP de scripts (Twilio, JsSIP,
// Google et les scripts en ligne de Next la rendraient fragile) : seulement
// `frame-ancestors`, qui interdit d'encadrer l'app (détournement de clic).
// Le micro reste permis à l'app elle-même : c'est le téléphone web.
const SECURITY_HEADERS = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), payment=(), usb=(), microphone=(self)" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      {
        // Le service worker est servi depuis `public/sw.js` — donc à la racine,
        // donc avec la portée « / » nativement. Le paquet officiel de Next le
        // fait passer par le bundler, ce qui l'aurait posé sous
        // /_next/static/chunks/ : un worker n'y contrôle que son propre dossier
        // à moins d'un en-tête `Service-Worker-Allowed`, et les en-têtes des
        // ressources hachées de Next ne sont pas modifiables.
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          // Sans cela le navigateur peut servir un worker de la veille pendant
          // 24 h : une notification cliquée ouvrirait alors l'ancien code, et
          // corriger un bogue de notification deviendrait impossible à déployer.
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [
          { key: "Content-Type", value: "application/manifest+json; charset=utf-8" },
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
