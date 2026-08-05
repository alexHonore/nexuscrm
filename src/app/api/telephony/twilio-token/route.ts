import { SignJWT } from "jose";
import { NextResponse } from "next/server";
import { apiUser } from "@/lib/auth/guards";
import { getSetting } from "@/lib/settings";

/**
 * POST /api/telephony/twilio-token — jeton d'accès Twilio Voice pour l'utilisateur courant.
 *
 * Le SDK serveur Twilio n'est PAS installé : le JWT est construit manuellement avec
 * `jose` selon la spec des Access Tokens Twilio (HS256, cty "twilio-fpa;v=1",
 * grant voice.outgoing.application_sid + identity).
 * Utilisé seulement quand l'admin bascule le fournisseur sur Twilio.
 */
export async function POST() {
  const auth = await apiUser();
  if (auth instanceof NextResponse) return auth;

  const settings = await getSetting("telephony");
  if (settings.provider !== "twilio") {
    return NextResponse.json({ error: "twilio_not_active" }, { status: 409 });
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const apiKeySid = process.env.TWILIO_API_KEY_SID;
  const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;
  const twimlAppSid = process.env.TWILIO_TWIML_APP_SID;
  if (!accountSid || !apiKeySid || !apiKeySecret || !twimlAppSid) {
    return NextResponse.json({ error: "twilio_not_configured" }, { status: 503 });
  }

  const identity = `user-${auth.id}`;
  const now = Math.floor(Date.now() / 1000);
  const ttl = 3600; // 1 h — le SDK rafraîchit via l'événement tokenWillExpire

  const token = await new SignJWT({
    jti: `${apiKeySid}-${now}`,
    iss: apiKeySid,
    sub: accountSid,
    iat: now,
    exp: now + ttl,
    grants: {
      identity,
      voice: {
        outgoing: { application_sid: twimlAppSid },
        incoming: { allow: true },
      },
    },
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT", cty: "twilio-fpa;v=1" })
    .sign(new TextEncoder().encode(apiKeySecret));

  return NextResponse.json(
    { token, identity, ttl },
    { headers: { "Cache-Control": "no-store" } },
  );
}
