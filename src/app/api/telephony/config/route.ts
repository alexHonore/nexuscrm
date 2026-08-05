import { NextResponse } from "next/server";
import { apiUser } from "@/lib/auth/guards";
import { decryptSecret } from "@/lib/crypto";
import { getSetting } from "@/lib/settings";

/**
 * GET /api/telephony/config — configuration téléphonie de l'utilisateur COURANT.
 * Ne retourne JAMAIS les identifiants d'un autre utilisateur.
 *
 * voip.ms : { provider, wssUrl, sipDomain, sipUsername, sipPassword, callerId, ready }
 * twilio  : { provider: 'twilio', callerId, ready } (le jeton est récupéré via
 *           POST /api/telephony/twilio-token, jamais ici)
 */
export async function GET() {
  const auth = await apiUser();
  if (auth instanceof NextResponse) return auth;

  const settings = await getSetting("telephony");
  const headers = { "Cache-Control": "no-store" };

  if (settings.provider === "twilio") {
    const ready = Boolean(
      process.env.TWILIO_ACCOUNT_SID &&
        process.env.TWILIO_API_KEY_SID &&
        process.env.TWILIO_API_KEY_SECRET &&
        process.env.TWILIO_TWIML_APP_SID,
    );
    return NextResponse.json(
      { provider: "twilio" as const, callerId: auth.didNumber ?? null, ready },
      { headers },
    );
  }

  // ── voip.ms (défaut) ──
  let sipPassword: string | null = null;
  if (auth.sipPasswordEnc) {
    try {
      sipPassword = decryptSecret(auth.sipPasswordEnc);
    } catch {
      // Clé de chiffrement changée / donnée corrompue — la ligne n'est pas prête.
      sipPassword = null;
    }
  }

  const wssUrl = process.env.NEXT_PUBLIC_SIP_WSS_URL || null;
  const ready = Boolean(wssUrl && auth.sipUsername && sipPassword);

  return NextResponse.json(
    {
      provider: "voipms" as const,
      wssUrl,
      sipDomain: process.env.VOIPMS_SIP_DOMAIN || "montreal.voip.ms",
      sipUsername: auth.sipUsername ?? null,
      sipPassword,
      callerId: auth.didNumber ?? null,
      ready,
    },
    { headers },
  );
}
