import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  async headers() {
    return [
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
