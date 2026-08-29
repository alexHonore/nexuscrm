import { createHmac, timingSafeEqual } from "crypto";
import { and, desc, eq, gte, isNull, like, or } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { missedCallNotification } from "@/components/clients/notification-content";
import { db } from "@/db";
import { calls, clients, users } from "@/db/schema";
import { createNotification } from "@/lib/notify";
import { userReach } from "@/db/schema-push";
import { decryptSecret } from "@/lib/crypto";
import { normalizePhone, phoneMatchKey } from "@/lib/phone";
import { getSetting } from "@/lib/settings";
import {
  inboundDialTwiml,
  resolveSimulRing,
  type SimulRingDecision,
} from "@/lib/telephony/simulring";

/**
 * POST /api/telephony/twiml — webhook TwiML appelé PAR LES SERVEURS TWILIO
 * (jamais par notre front). Actif seulement quand l'admin bascule le fournisseur
 * sur Twilio ET que les variables TWILIO_* sont définies :
 *   - TwiML App « Voice Request URL » → https://<app>/api/telephony/twiml
 *   - Numéro Twilio « A call comes in » → la même TwiML App
 *
 * Sortant (SDK navigateur) : From = "client:user-<uid>", param To
 *   → <Dial callerId=DID de <uid>><Number>To</Number></Dial>
 *   L'identité vient du jeton signé par /api/telephony/twilio-token : c'est
 *   ELLE qui dit qui appelle. Le DID présenté est relu en base à partir d'elle,
 *   jamais pris dans les paramètres du navigateur (un « CallerId » envoyé par le
 *   SDK serait celui que l'utilisateur veut, pas le sien), et un utilisateur
 *   désactivé est refusé même si son jeton d'une heure court encore.
 * Entrant (PSTN vers un DID Twilio) : To = numéro appelé
 *   → on route vers l'identité du navigateur de l'utilisateur qui possède ce DID
 *   → <Dial><Client>user-<uid></Client></Dial>
 * Résultat du Dial entrant (?dialResult=1, attribut action) : un appel non
 *   abouti (no-answer, busy, failed, canceled — fureteur fermé compris) est
 *   journalisé comme appel manqué et notifié au propriétaire de la ligne.
 *
 * Pas d'apiUser ici (requête serveur-à-serveur) : l'authenticité est vérifiée via
 * la signature X-Twilio-Signature (HMAC-SHA1, spec Twilio) quand TWILIO_AUTH_TOKEN
 * est défini.
 */

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function twiml(body: string): NextResponse {
  return new NextResponse(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    headers: { "Content-Type": "text/xml; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** Validation de signature Twilio : base64(HMAC-SHA1(url + params triés, authToken)). */
function isValidTwilioSignature(req: NextRequest, params: URLSearchParams): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  // Sans auth token configuré on ne peut pas valider — on laisse passer en dev,
  // mais en production Twilio doit être configuré au complet.
  if (!authToken) return process.env.NODE_ENV !== "production";

  const signature = req.headers.get("x-twilio-signature");
  if (!signature) return false;

  // URL publique telle que configurée dans la TwiML App (derrière le proxy
  // Vercel). Twilio signe l'URL COMPLÈTE, chaîne de requête incluse
  // (?dialResult=1 pour le rappel de l'attribut action).
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  const url = base ? `${base}/api/telephony/twiml${req.nextUrl.search}` : req.url;

  const data =
    url +
    [...params.keys()]
      .sort()
      .map((k) => k + (params.get(k) ?? ""))
      .join("");

  const expected = createHmac("sha1", authToken).update(data, "utf8").digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

const CLIENT_IDENTITY_RE =
  /^client:user-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * L'utilisateur derrière une identité navigateur « client:user-<uid> ». L'uid
 * est vérifié avant la requête : `users.id` est un uuid, une chaîne quelconque
 * ferait planter le cast côté Postgres.
 */
async function outboundOwner(from: string) {
  const uid = CLIENT_IDENTITY_RE.exec(from)?.[1];
  if (!uid) return undefined;
  return db.query.users.findFirst({
    where: eq(users.id, uid),
    columns: { id: true, isActive: true, didNumber: true },
  });
}

/**
 * La décision « fait-on sonner son cellulaire ? », lue au moment de l'appel.
 *
 * Le numéro est déchiffré ICI et nulle part ailleurs : il vit chiffré dans
 * `user_reach` (règle 4), il ne traverse aucun écran, et il ne sert qu'à
 * fabriquer un `<Number>` que Twilio compose. Une clé de chiffrement absente ou
 * un enregistrement illisible rendent « pas de sonnerie » plutôt qu'une erreur :
 * un appel entrant qui ÉCHOUE est bien pire qu'un appel entrant qui sonne au
 * seul poste, et c'est de toute façon le comportement par défaut.
 */
async function resolveSimulRingFor(userId: string): Promise<SimulRingDecision> {
  try {
    const [telephony, reach] = await Promise.all([
      getSetting("telephony"),
      db.query.userReach.findFirst({ where: eq(userReach.userId, userId) }),
    ]);
    if (!telephony.simulRing.enabled) return { status: "skipped", reason: "feature_off" };
    const cell = reach?.mobilePhoneEnc ? decryptSecret(reach.mobilePhoneEnc) : null;
    return resolveSimulRing(telephony.simulRing, userId, {
      cell,
      ringMobile: reach?.ringMobile ?? false,
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        at: "twiml",
        event: "simulring_resolve_failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return { status: "skipped", reason: "feature_off" };
  }
}

/**
 * Rappel de l'attribut action du Dial entrant. Un statut non abouti devient un
 * appel manqué : rangée `calls` + notification — sauf si le webphone (encore
 * ouvert) l'a déjà journalisé, ou si Twilio relivre le même rappel (CallSid).
 */
async function handleInboundDialResult(params: URLSearchParams): Promise<NextResponse> {
  const status = (params.get("DialCallStatus") ?? "").toLowerCase();
  if (status === "completed" || status === "answered") return twiml("");

  const did = normalizePhone(params.get("To"));
  const fromNumber = normalizePhone(params.get("From"));
  const callSid = params.get("CallSid");
  const owner = did
    ? await db.query.users.findFirst({
        where: eq(users.didNumber, did),
        columns: { id: true, locale: true },
      })
    : undefined;
  if (!owner) return twiml("<Hangup/>");

  // La sonnerie a duré au plus les 30 s du timeout du Dial — « maintenant »
  // reste dans la fenêtre de rapprochement de ±3 min du webphone.
  const now = new Date();
  const fromKey = phoneMatchKey(fromNumber);
  const dupConds = [
    ...(callSid ? [eq(calls.providerCallId, callSid)] : []),
    ...(fromKey ? [like(calls.fromNumber, `%${fromKey}`)] : []),
  ];
  const existing =
    dupConds.length > 0
      ? await db.query.calls.findFirst({
          where: and(
            eq(calls.userId, owner.id),
            eq(calls.direction, "inbound"),
            // SANS réponse seulement : un appel répondu du même numéro il y a
            // deux minutes n'est PAS ce manqué-ci — sans ce filtre, un rappel
            // immédiat manqué serait avalé (et le CallSid apposé au mauvais appel).
            isNull(calls.answeredAt),
            gte(calls.startedAt, new Date(now.getTime() - 5 * 60_000)),
            or(...dupConds),
          ),
          orderBy: [desc(calls.startedAt)],
          columns: { id: true, providerCallId: true },
        })
      : undefined;
  if (existing) {
    if (callSid && !existing.providerCallId) {
      await db.update(calls).set({ providerCallId: callSid }).where(eq(calls.id, existing.id));
    }
    return twiml("<Hangup/>");
  }

  let client: { id: string; fullName: string } | null = null;
  if (fromKey) {
    const [match] = await db
      .select({ id: clients.id, fullName: clients.fullName })
      .from(clients)
      .where(or(like(clients.phone, `%${fromKey}`), like(clients.phoneAlt, `%${fromKey}`)))
      .limit(1);
    client = match ?? null;
  }

  await db.insert(calls).values({
    userId: owner.id,
    clientId: client?.id ?? null,
    direction: "inbound",
    fromNumber,
    toNumber: did,
    startedAt: now,
    endedAt: now,
    provider: "twilio",
    providerCallId: callSid,
  });
  await createNotification(
    missedCallNotification({
      userId: owner.id,
      locale: owner.locale === "en" ? "en" : "fr",
      client,
      fromNumber,
    }),
  );

  return twiml("<Hangup/>");
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const params = new URLSearchParams(raw);

  if (!isValidTwilioSignature(req, params)) {
    return new NextResponse("invalid signature", { status: 403 });
  }

  if (req.nextUrl.searchParams.get("dialResult") === "1") {
    return handleInboundDialResult(params);
  }

  const from = params.get("From") ?? "";
  const to = params.get("To") ?? "";

  // ── Sortant : appel lancé par le SDK navigateur (device.connect) ──
  if (from.startsWith("client:")) {
    const dest = normalizePhone(to);
    if (!dest) return twiml("<Reject/>");

    // Le propriétaire de la ligne, d'après l'identité du jeton — et lui seul.
    // Un utilisateur inconnu ou désactivé ne compose plus, même avec un jeton
    // encore valide ; sans DID attitré, rien à présenter : Twilio refuserait
    // de toute façon un Dial PSTN sans callerId.
    const owner = await outboundOwner(from);
    const callerId = owner?.isActive ? normalizePhone(owner.didNumber) : null;
    if (!callerId) return twiml("<Reject/>");
    return twiml(
      `<Dial callerId="${xmlEscape(callerId)}" answerOnBridge="true">` +
        `<Number>${xmlEscape(dest)}</Number></Dial>`,
    );
  }

  // ── Entrant : PSTN vers un DID Twilio → identité navigateur du propriétaire ──
  const did = normalizePhone(to);
  if (did) {
    const owner = await db.query.users.findFirst({ where: eq(users.didNumber, did) });
    if (owner && owner.isActive) {
      // La sonnerie simultanée, si et seulement si les TROIS conditions sont
      // réunies (maison, ligne, accord de la personne — voir
      // `resolveSimulRing`). Éteinte, `inboundDialTwiml` rend exactement la
      // chaîne d'avant, octet pour octet : c'est le contrat que vérifie
      // `tests/unit-simulring.test.ts`, parce qu'une option neuve n'a pas le
      // droit de changer le comportement de ceux qui ne l'ont pas demandée.
      const simulRing = await resolveSimulRingFor(owner.id);
      return twiml(inboundDialTwiml({ identity: `user-${owner.id}`, simulRing }));
    }
  }

  // Aucun destinataire — occupé.
  return twiml("<Reject reason=\"busy\"/>");
}
