import { NextResponse } from "next/server";
import { apiActor } from "@/lib/permissions/server";
import { decryptSecret } from "@/lib/crypto";
import { getSetting } from "@/lib/settings";
import { sipDomain } from "@/lib/voipms";

/**
 * GET /api/telephony/config — configuration téléphonie de l'utilisateur COURANT.
 * Ne retourne JAMAIS les identifiants d'un autre utilisateur.
 *
 * voip.ms : { provider, wssUrl, sipDomain, sipUsername, sipPassword, callerId, ready }
 * twilio  : { provider: 'twilio', callerId, ready } (le jeton est récupéré via
 *           POST /api/telephony/twilio-token, jamais ici)
 *
 * Le droit d'APPELER se vérifie ici et pas seulement sur le bouton : cette
 * route rend le mot de passe SIP en clair, et un mot de passe SIP qu'on a tenu
 * une fois ne se reprend pas — il enregistre un téléphone logiciel n'importe
 * où, hors de l'application. Retirer « appeler » à quelqu'un doit donc lui
 * fermer la ligne, pas seulement le bouton. Refus poli plutôt que 403 : c'est
 * le socle téléphonique qui interroge cette route à chaque chargement, et une
 * erreur y ferait clignoter une panne là où il n'y a qu'un droit en moins.
 */
export async function GET() {
  const auth = await apiActor();
  if (auth instanceof NextResponse) return auth;

  const settings = await getSetting("telephony");
  const headers = { "Cache-Control": "no-store" };

  if (!auth.can("clients.call")) {
    return NextResponse.json(
      { provider: settings.provider, callerId: null, ready: false },
      { headers },
    );
  }

  if (settings.provider === "twilio") {
    const ready = Boolean(
      process.env.TWILIO_ACCOUNT_SID &&
        process.env.TWILIO_API_KEY_SID &&
        process.env.TWILIO_API_KEY_SECRET &&
        process.env.TWILIO_TWIML_APP_SID,
    );
    return NextResponse.json(
      { provider: "twilio" as const, callerId: auth.user.didNumber ?? null, ready },
      { headers },
    );
  }

  // ── voip.ms (défaut) ──
  let sipPassword: string | null = null;
  if (auth.user.sipPasswordEnc) {
    try {
      sipPassword = decryptSecret(auth.user.sipPasswordEnc);
    } catch {
      // Clé de chiffrement changée / donnée corrompue — la ligne n'est pas prête.
      sipPassword = null;
    }
  }

  const wssUrl = process.env.NEXT_PUBLIC_SIP_WSS_URL || null;
  const ready = Boolean(wssUrl && auth.user.sipUsername && sipPassword);

  return NextResponse.json(
    {
      provider: "voipms" as const,
      wssUrl,
      sipDomain: sipDomain(),
      sipUsername: auth.user.sipUsername ?? null,
      sipPassword,
      callerId: auth.user.didNumber ?? null,
      ready,
    },
    { headers },
  );
}
