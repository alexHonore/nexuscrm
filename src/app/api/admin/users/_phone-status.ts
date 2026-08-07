import type { PhoneStatusDto } from "@/components/admin/types";

/**
 * État « le téléphone de cette personne peut-il servir ? », calculé côté
 * serveur et envoyé au client sous forme de BOOLÉENS uniquement — ni mot de
 * passe SIP (même chiffré), ni URL de passerelle ne traversent jamais le pont.
 *
 * L'incident d'origine : un téléphoniste ne pouvait pas appeler parce que ses
 * champs SIP étaient vides, et rien dans l'écran Utilisateurs ne le montrait.
 */

/** La passerelle SIP-WSS est-elle configurée ? (booléen, jamais la valeur). */
export function sipGatewayConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SIP_WSS_URL);
}

export function computePhoneStatus(
  user: { sipUsername: string | null; sipPasswordEnc: string | null; didNumber: string | null },
  gatewayConfigured: boolean = sipGatewayConfigured(),
): PhoneStatusDto {
  const hasSipUsername = Boolean(user.sipUsername);
  const hasSipPassword = Boolean(user.sipPasswordEnc);
  const hasDid = Boolean(user.didNumber);
  const hasCredentials = hasSipUsername && hasSipPassword;

  // Sans passerelle, PERSONNE ne peut appeler : ce diagnostic prime sur le
  // reste, sinon l'admin corrige des lignes déjà correctes.
  const code: PhoneStatusDto["code"] = !gatewayConfigured
    ? "no_gateway"
    : !hasCredentials
      ? "not_configured"
      : !hasDid
        ? "no_did"
        : "ready";

  return { code, hasSipUsername, hasSipPassword, hasDid, hasGateway: gatewayConfigured };
}
