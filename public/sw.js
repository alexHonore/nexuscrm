/* eslint-disable no-undef */
/**
 * Le service worker de Groupe Nexus.
 *
 * Écrit à la main, en JavaScript nu, servi tel quel depuis `public/`. Ce n'est
 * pas de la nostalgie : `package.json` est gelé (règle 7) donc ni Workbox ni
 * Serwist n'existent ici, et le patron officiel de Next fait passer le worker
 * par le bundler — ce qui le dépose sous /_next/static/chunks/, où sa PORTÉE se
 * limite à son propre dossier. À la racine, la portée « / » est native.
 *
 * Trois règles gouvernent tout ce fichier :
 *
 * 1. **Toujours afficher quelque chose.** WebKit RÉVOQUE l'abonnement d'une
 *    application dont le gestionnaire `push` ne montre pas de notification.
 *    Il n'existe pas de poussée silencieuse sur iOS : la branche d'erreur doit
 *    donc afficher, elle aussi, sous peine de faire taire le téléphone pour de
 *    bon — et sans le moindre message d'erreur nulle part.
 * 2. **Ne jamais mettre en cache une réponse authentifiée.** Le mode de cache
 *    est délibérément minuscule : la coquille hors-ligne, et rien d'autre.
 *    /api/telephony/config renvoie un mot de passe SIP déchiffré ; le mettre en
 *    cache le déposerait en clair sur l'appareil.
 * 3. **Rendre la main à l'application.** Un clic ne doit pas ouvrir un
 *    onglet de plus quand l'application est déjà là : on la retrouve, on la
 *    met au premier plan, on la fait naviguer.
 */

const VERSION = "nexus-v1";
const SHELL_CACHE = `${VERSION}-shell`;
const OFFLINE_URL = "/offline";

// Ce que l'on garde : de quoi dessiner un écran quand le réseau est absent.
// Pas les pages de l'application — elles contiennent des données de clients et
// changent à chaque déploiement.
const SHELL_ASSETS = [OFFLINE_URL, "/icons/icon-192.png", "/icons/badge-96.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      // Un actif manquant ne doit pas empêcher l'installation : sans worker,
      // il n'y a plus de notifications du tout — c'est bien pire qu'un écran
      // hors-ligne moins joli.
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => !name.startsWith(VERSION)).map((name) => caches.delete(name))),
      )
      .then(() => self.clients.claim()),
  );
});

// ── Réception d'une poussée ──────────────────────────────────────────────────

self.addEventListener("push", (event) => {
  event.waitUntil(showFromPush(event.data));
});

async function showFromPush(data) {
  let payload = null;
  try {
    payload = data ? data.json() : null;
  } catch {
    payload = null;
  }

  // Le repli n'est pas décoratif : afficher UNE notification, quoi qu'il
  // arrive, est ce qui garde l'abonnement en vie sur iOS.
  const title = (payload && payload.title) || "Groupe Nexus";
  const body = (payload && payload.body) || "Vous avez une nouvelle notification.";
  const url = (payload && payload.url) || "/notifications";
  const tag = (payload && payload.tag) || "nexus";

  const options = {
    body,
    icon: "/icons/icon-192.png",
    // Android peint cette silhouette monochrome dans la barre d'état ; iOS
    // l'ignore. Sans elle, Android affiche un carré gris générique.
    badge: "/icons/badge-96.png",
    // L'étiquette FUSIONNE : cinq textos d'un même client laissent une ligne.
    tag,
    // …mais la fusion ne doit pas être silencieuse, sinon le deuxième texto
    // remplace le premier sans que rien ne bouge. `renotify` EXIGE `tag` —
    // sans lui, le navigateur lève.
    renotify: true,
    // Android seulement ; absent sur iOS, où l'appel est simplement ignoré.
    vibrate: [80, 40, 80],
    data: { url, tag, type: (payload && payload.type) || null },
    // Pas d'`actions` : iOS ne rend qu'une action par défaut et les ignore.
    // Une interface à deux boutons ne marcherait sur aucune des deux
    // plateformes de la même façon — le geste est donc UN appui, et tout le
    // reste se passe dans l'application.
  };

  await self.registration.showNotification(title, options);

  // La pastille sur l'icône. Sur iPhone elle marche depuis iOS 16.4 ; sur
  // Chrome pour Android, `setAppBadge` n'existe pas — l'appel est donc gardé.
  if (payload && typeof payload.badge === "number" && self.navigator.setAppBadge) {
    try {
      if (payload.badge > 0) await self.navigator.setAppBadge(payload.badge);
      else await self.navigator.clearAppBadge();
    } catch {
      // Une pastille refusée ne doit rien casser.
    }
  }
}

// ── Le geste : un appui, une fiche ───────────────────────────────────────────

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/notifications";
  event.waitUntil(openTarget(url));
});

async function openTarget(path) {
  const target = new URL(path, self.location.origin);
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

  // L'application est déjà ouverte quelque part : on la reprend plutôt que
  // d'en empiler une deuxième. Sur iOS, une seconde fenêtre serait un onglet
  // Safari — hors de l'application installée, donc hors de sa session.
  for (const client of windows) {
    if (new URL(client.url).origin !== target.origin) continue;
    await client.focus();
    // `navigate()` n'existe pas partout ; le message permet à l'application de
    // faire la navigation elle-même, sans rechargement.
    if ("navigate" in client) {
      try {
        await client.navigate(target.href);
        return;
      } catch {
        // On retombe sur le message.
      }
    }
    client.postMessage({ type: "nexus:navigate", url: target.href });
    return;
  }

  await self.clients.openWindow(target.href);
}

// ── L'abonnement qui change sous nos pieds ───────────────────────────────────

/**
 * Le navigateur peut faire tourner ses clés sans rien demander à personne.
 * Sans cette reprise, l'abonnement enregistré côté serveur devient un endpoint
 * mort : les envois répondent 410, la ligne est purgée, et le téléphoniste
 * cesse de recevoir quoi que ce soit — en croyant être abonné, puisque
 * l'écran des réglages, lui, ne voit rien.
 */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(resubscribe(event));
});

async function resubscribe(event) {
  try {
    const applicationServerKey =
      (event.oldSubscription && event.oldSubscription.options && event.oldSubscription.options.applicationServerKey) ||
      null;
    if (!applicationServerKey) return;
    const fresh = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        subscription: fresh.toJSON(),
        previousEndpoint: event.oldSubscription ? event.oldSubscription.endpoint : null,
      }),
    });
  } catch {
    // Rien à faire de plus ici : la page re-synchronisera au prochain
    // démarrage (voir src/components/pwa/pwa-bootstrap.tsx).
  }
}

// ── Réseau : une coquille hors-ligne, et rien de plus ────────────────────────

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  // On ne touche QUE les navigations. Tout le reste — les routes d'API, les
  // données RSC, la configuration de téléphonie et son mot de passe SIP —
  // traverse le worker sans être vu ni gardé.
  if (request.mode !== "navigate") return;

  event.respondWith(
    fetch(request).catch(async () => {
      const cached = await caches.match(OFFLINE_URL);
      return (
        cached ??
        new Response("Hors ligne", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        })
      );
    }),
  );
});

// L'application demande au worker de prendre la main tout de suite après un
// déploiement, plutôt que d'attendre la fermeture de tous les onglets.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "nexus:skip-waiting") self.skipWaiting();
});
