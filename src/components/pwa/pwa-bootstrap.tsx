"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { safeNextPath } from "@/lib/auth/next-path";
import { useDataChange } from "@/lib/live";

/**
 * Le branchement de l'application installée — quatre fils, aucun pixel.
 *
 * Ce composant ne dessine rien, et c'est voulu : il ne fait qu'attacher au
 * document ce qu'aucun écran ne pouvait porter tout seul.
 *
 * 1. **Il enregistre le service worker.** Sans lui, pas de poussée du tout :
 *    c'est le worker qui reçoit et qui affiche. La portée « / » est celle du
 *    fichier servi depuis `public/` — voir l'en-tête de `public/sw.js`.
 * 2. **Il re-synchronise l'abonnement.** Un navigateur fait tourner ses clés
 *    sans rien demander à personne. Le worker s'en occupe quand il assiste à
 *    la rotation (`pushsubscriptionchange`), mais il n'y assiste pas toujours :
 *    l'événement se perd si l'application dort, et le `fetch` qu'il déclenche
 *    peut partir hors réseau. Le résultat est la panne la plus vicieuse de tout
 *    ce chantier : la ligne en base pointe vers un endpoint mort, le service de
 *    push répond 410, la ligne est purgée, et le téléphoniste ne reçoit plus
 *    rien — pendant que l'écran des réglages continue d'afficher « abonné ».
 *    Le seul remède est de RE-DÉCLARER l'abonnement courant à chaque réveil.
 * 3. **Il conduit le geste.** Un appui sur une notification, quand une fenêtre
 *    existe déjà, arrive ici sous forme de message : c'est nous qui naviguons,
 *    sans recharger — donc sans remonter la session JsSIP ni perdre un
 *    brouillon de texto.
 * 4. **Il tient la pastille de l'icône à jour.** Elle vit HORS de la page :
 *    rien dans l'application ne la corrige quand on lit ses notifications
 *    ailleurs, et un « 3 » qui ne descend jamais apprend à ignorer l'icône.
 *
 * Deux règles de conduite gouvernent le fichier entier :
 *
 * · **Il ne demande JAMAIS la permission de notifier.** La demander au montage
 *   est le geste qui coûte l'autorisation pour de bon : refusée une fois, elle
 *   ne se redemande plus depuis la page. C'est l'écran des réglages, où l'on a
 *   dit pourquoi, qui pose la question.
 * · **Il ne lève jamais et n'affiche jamais d'erreur.** Un navigateur sans
 *   service worker, une session expirée, un téléphone hors réseau : tout cela
 *   est normal et doit rester silencieux. Ce composant est monté par la
 *   coquille, donc présent sur CHAQUE écran — une exception ici tomberait sur
 *   des fiches clients.
 */

const SW_URL = "/sw.js";
/** Le compteur le moins cher de l'application : il rend aussi la clé VAPID. */
const UNREAD_URL = "/api/notifications/unread";
const SUBSCRIBE_URL = "/api/push/subscribe";

/**
 * Deux cadences, parce que les deux moitiés ne coûtent pas la même chose.
 * Relire un compteur est une requête ; re-déclarer un abonnement est une
 * écriture en base, et le retour au premier plan se produit dix fois par heure
 * sur un téléphone qu'on sort de sa poche.
 */
const UNREAD_MIN_INTERVAL_MS = 10_000;
const SUBSCRIPTION_MIN_INTERVAL_MS = 5 * 60_000;

/** Ce que le typage standard n'a pas : la pastille, et le plein écran d'iOS. */
type PwaNavigator = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
  /** Safari, depuis toujours : son seul aveu d'« application installée ». */
  standalone?: boolean;
};

type UnreadResponse = { unread?: number; vapidPublicKey?: string | null };

/** L'application tourne-t-elle depuis l'écran d'accueil, ou dans un onglet ? */
function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.matchMedia("(display-mode: standalone)").matches) return true;
  } catch {
    // Un `matchMedia` qui refuse une requête inconnue ne décide pas tout seul.
  }
  return (navigator as PwaNavigator).standalone === true;
}

/**
 * base64url → octets. La clé publique VAPID voyage en texte (c'est la seule
 * forme qui traverse du JSON) et `pushManager.subscribe` en veut les octets.
 */
function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  // La vue est construite sur un `ArrayBuffer` EXPLICITE, et le type le dit.
  // `new Uint8Array(n)` produit un `Uint8Array<ArrayBufferLike>`, que
  // `pushManager.subscribe` refuse depuis que TypeScript distingue un tampon
  // partageable d'un tampon ordinaire — l'abonnement ne compilait plus.
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Le chemin inverse — pour COMPARER la clé scellée dans un abonnement. */
function bytesToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** L'enregistrement en cours, ou rien — sans jamais attendre indéfiniment. */
async function currentRegistration(): Promise<ServiceWorkerRegistration | null> {
  // `navigator.serviceWorker.ready` serait plus court, mais il ne se résout
  // JAMAIS si l'enregistrement a échoué : la promesse resterait suspendue à
  // chaque réveil, une de plus par réveil.
  try {
    return (await navigator.serviceWorker.getRegistration()) ?? null;
  } catch {
    return null;
  }
}

/**
 * La pastille sur l'icône de l'application.
 *
 * Gardée deux fois : `setAppBadge` n'existe pas dans Chrome pour Android (et
 * n'existe sur iPhone que depuis 16.4), et là où elle existe elle peut refuser
 * — une pastille est un ornement, jamais une donnée.
 */
async function applyBadge(unread: number): Promise<void> {
  const nav = navigator as PwaNavigator;
  if (typeof nav.setAppBadge !== "function") return;
  try {
    if (unread > 0) await nav.setAppBadge(unread);
    else if (typeof nav.clearAppBadge === "function") await nav.clearAppBadge();
  } catch {
    // Refusée : l'application reste parfaitement utilisable sans.
  }
}

/** Déclare l'abonnement courant au serveur. `previous` = l'endpoint remplacé. */
async function postSubscription(
  subscription: PushSubscription,
  previousEndpoint: string | null,
): Promise<void> {
  await fetch(SUBSCRIBE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({
      subscription: subscription.toJSON(),
      previousEndpoint,
      // D'où vient l'abonnement se garde en base : un abonnement « browser »
      // sur iPhone ne recevra jamais rien, et c'est un fait qu'on veut LIRE
      // dans la table plutôt que déduire d'un agent utilisateur.
      display: isStandalone() ? "standalone" : "browser",
    }),
  });
}

/** Un abonnement neuf pour la clé du serveur, ou rien. Ne lève pas. */
async function subscribeWith(
  registration: ServiceWorkerRegistration,
  serverKey: string,
): Promise<PushSubscription | null> {
  try {
    return await registration.pushManager.subscribe({
      // Obligatoire, et pas seulement par politesse : un abonnement silencieux
      // est refusé par tous les navigateurs, et WebKit RÉVOQUE celui dont le
      // worker n'affiche rien.
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(serverKey),
    });
  } catch {
    return null;
  }
}

/**
 * Re-déclarer ce téléphone. Trois cas, dans cet ordre :
 *
 * · la clé publique du serveur a changé — l'abonnement scellé sur l'ancienne
 *   est injoignable pour de bon, il faut le refaire (c'est la panne que
 *   l'en-tête de `/api/notifications/unread` décrit : une clé figée à la
 *   compilation qui ne correspond plus à celle qui signe les envois) ;
 * · le navigateur a jeté l'abonnement — iOS le fait en déchargeant une
 *   application peu utilisée — alors que la permission, elle, tient toujours ;
 * · tout va bien : on rafraîchit quand même la ligne de temps en temps, parce
 *   qu'un endpoint a pu tourner sans que personne ne l'ait vu.
 *
 * Rend l'instant de la dernière déclaration au serveur — inchangé si rien n'a
 * été écrit, pour que l'appelant tienne sa cadence.
 */
async function refreshSubscription(
  serverKey: string | null,
  at: number,
  lastPostedAt: number,
): Promise<number> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return lastPostedAt;
  // Jamais de demande de permission ici : seulement la suite d'un « oui » déjà
  // donné ailleurs.
  if (typeof Notification === "undefined" || Notification.permission !== "granted") {
    return lastPostedAt;
  }

  const registration = await currentRegistration();
  if (!registration) return lastPostedAt;

  let subscription: PushSubscription | null = null;
  try {
    subscription = await registration.pushManager.getSubscription();
  } catch {
    return lastPostedAt;
  }

  if (subscription && serverKey) {
    const sealed = subscription.options.applicationServerKey;
    if (sealed && bytesToBase64Url(sealed) !== serverKey) {
      const previousEndpoint = subscription.endpoint;
      try {
        await subscription.unsubscribe();
      } catch {
        // Un désabonnement refusé n'empêche pas d'en créer un neuf.
      }
      const fresh = await subscribeWith(registration, serverKey);
      if (!fresh) return lastPostedAt;
      await postSubscription(fresh, previousEndpoint);
      return at;
    }
  }

  if (!subscription) {
    if (!serverKey) return lastPostedAt;
    const fresh = await subscribeWith(registration, serverKey);
    if (!fresh) return lastPostedAt;
    await postSubscription(fresh, null);
    return at;
  }

  if (at - lastPostedAt < SUBSCRIPTION_MIN_INTERVAL_MS) return lastPostedAt;
  await postSubscription(subscription, null);
  return at;
}

export function PwaBootstrap() {
  const router = useRouter();
  const unreadAtRef = useRef(0);
  const subscriptionAtRef = useRef(0);
  const runningRef = useRef(false);

  /**
   * Le réveil : relire le compteur, repeindre la pastille, re-déclarer
   * l'abonnement. `force` ne saute que le garde-fou du compteur — celui de
   * l'abonnement tient bon, sauf si l'abonnement a réellement changé.
   */
  const sync = useCallback(async (force: boolean) => {
    if (typeof window === "undefined") return;
    // Deux réveils simultanés (retour au premier plan ET retour du réseau)
    // écriraient deux fois la même ligne.
    if (runningRef.current) return;

    const now = Date.now();
    if (!force && now - unreadAtRef.current < UNREAD_MIN_INTERVAL_MS) return;
    runningRef.current = true;
    unreadAtRef.current = now;

    try {
      const response = await fetch(UNREAD_URL, { credentials: "same-origin", cache: "no-store" });
      // 401 : la session a expiré pendant la nuit. Ce n'est pas une panne, et
      // ce n'est pas ici qu'on la traite — la prochaine navigation passera par
      // le proxy, qui garde la destination dans `?next=`.
      if (!response.ok) return;
      const data = (await response.json()) as UnreadResponse;

      await applyBadge(typeof data.unread === "number" ? data.unread : 0);
      subscriptionAtRef.current = await refreshSubscription(
        data.vapidPublicKey ?? null,
        now,
        subscriptionAtRef.current,
      );
    } catch {
      // Hors réseau : le prochain retour au premier plan, ou l'événement
      // `online`, réessaiera. Rien à dire à l'utilisateur.
    } finally {
      runningRef.current = false;
    }
  }, []);

  // ── 1. Le worker ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    // Un service worker exige un contexte sûr. En développement sur l'IP du
    // portable — le seul moyen d'essayer depuis un vrai téléphone — il n'y en a
    // pas : on s'abstient plutôt que de peindre une erreur dans la console de
    // chaque écran.
    const { protocol, hostname } = window.location;
    if (protocol !== "https:" && hostname !== "localhost" && hostname !== "127.0.0.1") return;

    let cancelled = false;

    navigator.serviceWorker
      .register(SW_URL, {
        scope: "/",
        // Le script du worker ne doit JAMAIS venir du cache HTTP : c'est par
        // lui qu'un correctif se déploie, et un worker figé continuerait de
        // servir l'ancienne coquille hors-ligne pendant des jours.
        updateViaCache: "none",
      })
      .then((registration) => {
        if (cancelled) return;

        // Un worker neuf qui reste « en attente » laisse l'ancien répondre
        // jusqu'à ce que tous les onglets soient fermés — c'est-à-dire, sur un
        // téléphone, jamais. `public/sw.js` écoute ce message ; le lui envoyer
        // est ce qui rend un déploiement visible le jour même.
        const takeOver = () => {
          const waiting = registration.waiting;
          if (waiting) waiting.postMessage({ type: "nexus:skip-waiting" });
        };
        takeOver();
        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (installing.state === "installed") takeOver();
          });
        });

        void sync(true);
      })
      .catch(() => {
        // Enregistrement refusé (navigation privée, réglage d'entreprise,
        // script redirigé) : l'application reste entière, sans notifications.
      });

    return () => {
      cancelled = true;
    };
  }, [sync]);

  // ── 2. Le geste : un appui sur la notification ─────────────────────────────

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; url?: string } | null;
      if (!data || data.type !== "nexus:navigate" || typeof data.url !== "string") return;

      let path: string | null = null;
      try {
        const target = new URL(data.url, window.location.origin);
        // Le message vient de NOTRE worker, mais une navigation pilotée par un
        // message reste une navigation pilotée du dehors : on la valide avec la
        // même liste blanche de forme que le `?next=` de la connexion.
        if (target.origin !== window.location.origin) return;
        path = safeNextPath(`${target.pathname}${target.search}`);
      } catch {
        return;
      }
      if (!path) return;

      router.push(path);
    };

    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [router]);

  // ── 3. Les réveils ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Le retour de l'écran verrouillé. C'est LE moment de ce composant : une
    // application réveillée par une notification reprend sur l'état où elle
    // s'est endormie — un compteur d'hier, une pastille qui ne correspond plus,
    // et parfois un abonnement que le système a jeté entre-temps.
    const onVisible = () => {
      if (document.visibilityState === "visible") void sync(false);
    };
    // Le réseau qui revient : on ne discute pas la cadence, c'est le seul
    // instant où une re-déclaration ratée peut enfin partir.
    const onOnline = () => void sync(true);
    // iOS restaure une page depuis son cache de retour arrière sans rejouer le
    // moindre montage : sans `pageshow`, le geste « précédent » ramène un écran
    // que plus rien ne rafraîchit.
    const onPageShow = () => void sync(false);

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    window.addEventListener("pageshow", onPageShow);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [sync]);

  // Les notifications lues DANS cet onglet : la pastille de l'icône doit
  // descendre en même temps que celle de la cloche, sinon le téléphone annonce
  // du non-lu qu'on vient justement de lire.
  useDataChange(["notifications"], () => {
    void sync(true);
  });

  return null;
}
