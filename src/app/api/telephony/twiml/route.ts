import { createHmac, timingSafeEqual } from "crypto";
import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { normalizePhone } from "@/lib/phone";

/**
 * POST /api/telephony/twiml — webhook TwiML appelé PAR LES SERVEURS TWILIO
 * (jamais par notre front). Actif seulement quand l'admin bascule le fournisseur
 * sur Twilio ET que les variables TWILIO_* sont définies :
 *   - TwiML App « Voice Request URL » → https://<app>/api/telephony/twiml
 *   - Numéro Twilio « A call comes in » → la même TwiML App
 *
 * Sortant (SDK navigateur) : From = "client:user-<uid>", params To + CallerId
 *   → <Dial callerId><Number>To</Number></Dial>
 * Entrant (PSTN vers un DID Twilio) : To = numéro appelé
 *   → on route vers l'identité du navigateur de l'utilisateur qui possède ce DID
 *   → <Dial><Client>user-<uid></Client></Dial>
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

  // URL publique telle que configurée dans la TwiML App (derrière le proxy Vercel).
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  const url = base ? `${base}/api/telephony/twiml` : req.url;

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

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const params = new URLSearchParams(raw);

  if (!isValidTwilioSignature(req, params)) {
    return new NextResponse("invalid signature", { status: 403 });
  }

  const from = params.get("From") ?? "";
  const to = params.get("To") ?? "";

  // ── Sortant : appel lancé par le SDK navigateur (device.connect) ──
  if (from.startsWith("client:")) {
    const dest = normalizePhone(to);
    const callerId = normalizePhone(params.get("CallerId"));
    if (!dest) return twiml("<Reject/>");
    const callerAttr = callerId ? ` callerId="${xmlEscape(callerId)}"` : "";
    return twiml(
      `<Dial${callerAttr} answerOnBridge="true"><Number>${xmlEscape(dest)}</Number></Dial>`,
    );
  }

  // ── Entrant : PSTN vers un DID Twilio → identité navigateur du propriétaire ──
  const did = normalizePhone(to);
  if (did) {
    const owner = await db.query.users.findFirst({ where: eq(users.didNumber, did) });
    if (owner && owner.isActive) {
      return twiml(
        `<Dial answerOnBridge="true" timeout="30"><Client>${xmlEscape(`user-${owner.id}`)}</Client></Dial>`,
      );
    }
  }

  // Aucun destinataire — occupé.
  return twiml("<Reject reason=\"busy\"/>");
}
