// ─────────────────────────────────────────────────────────────────────────────
// Groupe Nexus — Passerelle vocale : relais API voip.ms
//
// Pourquoi : l'API REST de voip.ms exige que l'adresse IP appelante soit sur
// une liste blanche. Vercel n'a pas d'IP fixe ; ce petit serveur, hébergé sur
// le VPS (IP fixe), relaie donc les appels API du CRM vers voip.ms.
//
// Contrat (voir src/lib/voipms.ts côté CRM) :
//   GET /?method=...&api_username=...&api_password=...   (toute la requête
//   voip.ms passe dans la chaîne de requête, identifiants compris)
//   En-tête requis : x-proxy-token = PROXY_TOKEN (variable d'environnement).
//   -> relayé tel quel vers https://voip.ms/api/v1/rest.php, JSON retransmis.
//   Tout le reste -> 404 (pas d'indice pour les balayeurs).
//   Exception : GET /healthz -> 200 « ok » sans jeton (sonde de vie).
//
// Aucune dépendance npm : uniquement les modules natifs de Node 22.
// Écoute sur 0.0.0.0:8080 dans le conteneur, publié en 127.0.0.1:8080 sur
// l'hôte ; Caddy expose https://DOMAINE/voipms-api par-dessus.
// ─────────────────────────────────────────────────────────────────────────────

import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHash, timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.PORT ?? 8080);
const UPSTREAM_HOST = "voip.ms";
const UPSTREAM_PATH = "/api/v1/rest.php";
const MAX_QUERY_LENGTH = 8192;

const token = process.env.PROXY_TOKEN ?? "";
if (!token) {
  console.error("[api-proxy] PROXY_TOKEN manquant : arrêt.");
  process.exit(1);
}

/** Comparaison à temps constant (les deux valeurs sont d'abord hachées). */
function tokenMatches(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

function notFound(res) {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not Found");
}

const server = createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    notFound(res);
    return;
  }

  // Sonde de vie (sans jeton) — utile pour les tests et la supervision.
  if (req.method === "GET" && url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }

  // Chemins acceptés : « / » (après retrait du préfixe par Caddy) ou
  // « /voipms-api » (si le relais amont ne retire pas le préfixe).
  const pathOk = url.pathname === "/" || url.pathname === "/voipms-api";
  const qs = url.search; // inclut le « ? »

  if (
    req.method !== "GET" ||
    !pathOk ||
    qs.length < 2 ||
    qs.length > MAX_QUERY_LENGTH ||
    !tokenMatches(req.headers["x-proxy-token"])
  ) {
    notFound(res);
    return;
  }

  // Relais vers voip.ms — la chaîne de requête passe telle quelle.
  const upstream = httpsRequest(
    {
      host: UPSTREAM_HOST,
      path: UPSTREAM_PATH + qs,
      method: "GET",
      timeout: 30_000,
      headers: { accept: "application/json" },
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, {
        "content-type": up.headers["content-type"] ?? "application/json",
        "cache-control": "no-store",
      });
      up.pipe(res);
    },
  );

  upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
  upstream.on("error", (err) => {
    console.error("[api-proxy] erreur amont voip.ms:", err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
    }
    res.end(JSON.stringify({ status: "proxy_upstream_error" }));
  });
  upstream.end();
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[api-proxy] à l'écoute sur :${PORT} (relais -> https://voip.ms${UPSTREAM_PATH})`);
});
