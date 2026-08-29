/**
 * Transport Web Push — le POST vers le service de push (RFC 8030).
 *
 * Ce module ne connaît ni la base ni Next.js : on lui donne un abonnement et un
 * texte, il rend un VERDICT. C'est l'appelant qui décide quoi en faire, et un
 * verdict en particulier n'est pas une erreur mais un ORDRE : `gone` (404/410)
 * signifie que le navigateur a révoqué l'abonnement — la ligne doit être
 * supprimée, sinon la même notification repartira à chaque tour de cron vers un
 * point de terminaison mort, pour toujours.
 *
 * Deux garde-fous tiennent tout le reste :
 *
 * - CHAQUE requête porte un délai maximal. Un point de terminaison APNs qui
 *   pend ne doit jamais retenir le webhook qui l'a déclenché : la notification
 *   est un effet de bord de la requête d'un téléphoniste, jamais son sujet.
 * - Le lot ne LÈVE JAMAIS. Un abonnement mort, une URL bancale, un service de
 *   push en panne : chacun rend son verdict et les autres partent quand même.
 *   Un seul appareil cassé ne prive pas l'équipe de ses notifications.
 */
import { MAX_PAYLOAD_BYTES, encryptPayload } from "./encrypt";
import { loadVapidKeys, type VapidKeys } from "./keys";
import { vapidAuthorization } from "./vapid";

/** Ce que le navigateur sérialise dans `PushSubscription.toJSON()`. */
export type PushSubscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

/**
 * Urgences de la RFC 8030 §5.3. Un téléphone en économie d'énergie garde les
 * `very-low` pour plus tard : un rappel de suivi peut attendre, un lead qui
 * vient d'entrer, non.
 */
export type PushUrgency = "very-low" | "low" | "normal" | "high";

/**
 * Le verdict. `ok` sépare le succès de l'échec ; les échecs se distinguent par
 * la présence de leur champ (`"gone" in result`) parce que chacun appelle un
 * geste différent : supprimer, réessayer plus tard, raccourcir, journaliser.
 */
export type PushResult =
  | { ok: true }
  | { ok: false; gone: true }
  | { ok: false; retryAfterMs: number }
  | { ok: false; tooLarge: true }
  | { ok: false; error: string };

/** L'abonnement est révoqué : l'appelant DOIT supprimer la ligne. */
export function isGone(result: PushResult): result is { ok: false; gone: true } {
  return !result.ok && "gone" in result;
}

/**
 * Délai maximal d'UN envoi. Huit secondes : plus qu'il n'en faut à un service
 * de push en bonne santé (quelques centaines de ms), assez peu pour qu'un lot
 * de six en parallèle reste sous la limite d'une fonction Vercel même si tous
 * les points de terminaison se taisent.
 */
export const PUSH_TIMEOUT_MS = 8_000;

/**
 * Durée de rétention par défaut si l'appareil est hors ligne. Quatre heures :
 * une notification de ce CRM annonce quelque chose à FAIRE maintenant
 * (un lead entrant, un rappel dû). Livrée le lendemain, elle ne renseigne plus,
 * elle dérange — et l'écran des notifications, lui, n'oublie rien.
 */
export const DEFAULT_TTL_SECONDS = 4 * 60 * 60;

/** Temporisation retenue quand le service de push répond 429 sans le dire. */
const DEFAULT_RETRY_AFTER_MS = 60_000;

/** RFC 8030 §5.4 : un `Topic` fait au plus 32 caractères base64url. */
const TOPIC_RE = /^[A-Za-z0-9_-]{1,32}$/;

export type SendPushInput = {
  subscription: PushSubscription;
  /** Charge utile en clair — le JSON que le service worker lira. */
  payload: string | Uint8Array;
  ttl?: number;
  urgency?: PushUrgency;
  /** Remplace la notification non encore livrée qui porte le même sujet. */
  topic?: string;
  signal?: AbortSignal;
  /** Clés injectables (lot, tests) ; l'environnement par défaut. */
  keys?: VapidKeys;
  fetchFn?: typeof fetch;
  nowMs?: number;
};

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function byteLengthOf(payload: string | Uint8Array): number {
  return typeof payload === "string" ? Buffer.byteLength(payload, "utf8") : payload.byteLength;
}

/**
 * `Retry-After` en millisecondes — secondes ou date HTTP, les deux formes
 * existent. Une valeur illisible vaut « rien dit », donc la temporisation par
 * défaut : jamais zéro, qui relancerait la rafale qui a déclenché le 429.
 */
function retryAfterMs(headers: Headers, nowMs: number): number {
  const raw = headers.get("retry-after");
  if (!raw) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return DEFAULT_RETRY_AFTER_MS;
  return Math.max(0, at - nowMs);
}

/**
 * Le signal de la requête : le plafond de temps TOUJOURS, combiné à celui de
 * l'appelant quand il en fournit un. L'ordre importe peu — le premier qui parle
 * coupe la requête — mais l'omission, elle, se paierait en fonctions bloquées.
 */
function requestSignal(external: AbortSignal | undefined): AbortSignal {
  const deadline = AbortSignal.timeout(PUSH_TIMEOUT_MS);
  return external ? AbortSignal.any([external, deadline]) : deadline;
}

/**
 * Signature VAPID mémorisée PAR ORIGINE : `aud` ne contient que l'origine du
 * point de terminaison (voir `vapid.ts`), donc cinquante téléphones Android
 * partagent un seul jeton. Sans ce cache, un lot signerait une courbe elliptique
 * par abonné pour produire cinquante fois le même en-tête.
 */
function createAuthorizer(keys: VapidKeys, nowMs: number | undefined) {
  const cache = new Map<string, Promise<string>>();
  return (endpoint: string): Promise<string> => {
    const origin = new URL(endpoint).origin;
    const known = cache.get(origin);
    if (known) return known;
    const signing = vapidAuthorization({ endpoint, keys, ...(nowMs === undefined ? {} : { nowMs }) });
    cache.set(origin, signing);
    return signing;
  };
}

async function sendOne(
  input: SendPushInput,
  authorize: (endpoint: string) => Promise<string>,
): Promise<PushResult> {
  const { subscription, payload, ttl, urgency, topic, signal } = input;
  const fetchFn = input.fetchFn ?? fetch;

  if (byteLengthOf(payload) > MAX_PAYLOAD_BYTES) {
    // Refusé AVANT le réseau : le 413 est certain, autant l'annoncer tout de
    // suite pour que l'appelant raccourcisse au lieu de réessayer.
    return { ok: false, tooLarge: true };
  }
  if (topic !== undefined && !TOPIC_RE.test(topic)) {
    return { ok: false, error: "topic_invalid" };
  }

  let body: Buffer;
  let authorization: string;
  try {
    body = encryptPayload({
      payload,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    });
    authorization = await authorize(subscription.endpoint);
  } catch (err) {
    // Clés d'abonnement corrompues ou point de terminaison illisible : rien à
    // réessayer, mais ce n'est pas non plus un abonnement révoqué — l'appelant
    // journalise sans supprimer.
    return { ok: false, error: `push_prepare_failed: ${message(err)}` };
  }

  const headers: Record<string, string> = {
    Authorization: authorization,
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    "Content-Length": String(body.length),
    TTL: String(ttl === undefined ? DEFAULT_TTL_SECONDS : Math.max(0, Math.floor(ttl))),
    Urgency: urgency ?? "normal",
  };
  if (topic !== undefined) headers.Topic = topic;

  let res: Response;
  try {
    res = await fetchFn(subscription.endpoint, {
      method: "POST",
      headers,
      body: new Uint8Array(body),
      cache: "no-store",
      signal: requestSignal(signal),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return { ok: false, error: `timeout after ${PUSH_TIMEOUT_MS}ms` };
    }
    return { ok: false, error: `push_network_failed: ${message(err)}` };
  }

  if (res.ok) return { ok: true };
  if (res.status === 404 || res.status === 410) return { ok: false, gone: true };
  if (res.status === 429) {
    return { ok: false, retryAfterMs: retryAfterMs(res.headers, input.nowMs ?? Date.now()) };
  }
  if (res.status === 413) return { ok: false, tooLarge: true };

  // Le corps d'erreur d'un service de push est court et souvent le seul indice
  // (« UnauthorizedRegistration ») ; on le garde tronqué, jamais en entier.
  let detail = "";
  try {
    detail = (await res.text()).trim().slice(0, 200);
  } catch {
    // corps illisible — le statut suffit
  }
  return { ok: false, error: detail ? `http_${res.status}: ${detail}` : `http_${res.status}` };
}

/** Un envoi. Ne lève pas : tout ce qui rate rend un verdict. */
export async function sendPush(input: SendPushInput): Promise<PushResult> {
  const keys = input.keys ?? loadVapidKeys();
  if (!keys) return { ok: false, error: "vapid_not_configured" };
  try {
    return await sendOne(input, createAuthorizer(keys, input.nowMs));
  } catch (err) {
    return { ok: false, error: `push_failed: ${message(err)}` };
  }
}

export type SendPushBatchOptions = Omit<SendPushInput, "subscription" | "payload"> & {
  /** Envois simultanés. Six : de quoi couvrir l'équipe sans ouvrir une rafale. */
  concurrency?: number;
};

/** Le verdict d'un abonnement du lot, dans l'ORDRE d'entrée. */
export type PushBatchEntry = { endpoint: string; result: PushResult };

/**
 * Le même message à plusieurs appareils, six à la fois.
 *
 * L'ordre de sortie est celui de l'entrée — l'appelant recolle ses lignes de
 * base par l'index sans dépendre de l'ordre d'arrivée des réponses.
 */
export async function sendPushBatch(
  subscriptions: readonly PushSubscription[],
  payload: string | Uint8Array,
  options: SendPushBatchOptions = {},
): Promise<PushBatchEntry[]> {
  const results: PushBatchEntry[] = subscriptions.map((s) => ({
    endpoint: s.endpoint,
    result: { ok: false, error: "not_attempted" },
  }));
  if (subscriptions.length === 0) return results;

  const keys = options.keys ?? loadVapidKeys();
  if (!keys) {
    return results.map((entry) => ({ ...entry, result: { ok: false, error: "vapid_not_configured" } }));
  }

  const authorize = createAuthorizer(keys, options.nowMs);
  const lanes = Math.max(1, Math.min(options.concurrency ?? 6, subscriptions.length));
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= subscriptions.length) return;
      const subscription = subscriptions[index];
      try {
        results[index] = {
          endpoint: subscription.endpoint,
          result: await sendOne({ ...options, keys, subscription, payload }, authorize),
        };
      } catch (err) {
        // Ceinture et bretelles : `sendOne` rend déjà un verdict pour tout ce
        // qu'il connaît. Ce qu'il ne connaît pas ne doit pas tuer le lot.
        results[index] = {
          endpoint: subscription.endpoint,
          result: { ok: false, error: `push_failed: ${message(err)}` },
        };
      }
    }
  };

  await Promise.all(Array.from({ length: lanes }, worker));
  return results;
}
