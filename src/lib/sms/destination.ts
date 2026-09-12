/**
 * Ce numéro peut-il seulement RECEVOIR un texto ? — la question posée AVANT
 * d'écrire le message, pas après.
 *
 * Module PUR (règle du dossier `src/lib/sms`) : aucune lecture de base, aucun
 * accès réseau, aucune variable d'environnement. On lui donne un numéro et la
 * liste des régions que le compte Twilio a le droit de servir ; il rend un
 * verdict. C'est ce qui permet de l'appeler du chemin le plus précoce — celui
 * où l'on décide d'appeler le modèle ou pas.
 *
 * **Pourquoi ce fichier existe.** Twilio refuse certains destinataires avec le
 * code 21408 (« la région de ce numéro n'est pas activée sur le compte ») ou
 * 21211 (« numéro invalide »). Ces refus arrivaient au tout dernier moment :
 * l'assistant avait déjà classé le message entrant, rédigé sa réponse, passé
 * les garde-fous — une demi-douzaine d'appels à OpenRouter — pour que le
 * transporteur jette le résultat. Le fil finissait sur « Ce message n'est pas
 * parti. Code 21408. », un nombre que personne dans le bureau ne sait lire,
 * et la facture du modèle était payée pour rien.
 *
 * D'où viennent ces numéros ? De `normalizePhone` (`src/lib/phone.ts`), qui
 * est volontairement tolérante : elle préfère garder un numéro douteux plutôt
 * que de perdre un lead. Sa dernière branche recolle les chiffres derrière un
 * « + » quoi qu'il arrive. Un « 476-1542 » à sept chiffres importé de Notion
 * devient `+4761542` ; un huit chiffres devient `+47615423`, que Twilio lit
 * comme la Norvège (+47) — région désactivée, 21408. Le numéro a l'air d'un
 * numéro, il passe l'expression régulière E.164 du fournisseur, et il ne peut
 * pourtant arriver nulle part.
 *
 * Ce que ce module NE fait pas : appeler Twilio Lookup. Savoir qu'un numéro
 * nord-américain bien formé est une ligne fixe (21614) ou hors réseau (21612)
 * demande une requête par numéro. Le verdict rendu ici est celui qu'on peut
 * rendre gratuitement et hors ligne ; c'est aussi celui qui couvre les refus
 * réellement observés.
 *
 * **Et pourquoi pas dans `src/lib/deliverability/npa.ts`?** Ce voisin connaît
 * les indicatifs canadiens et les indicatifs de service, mais il répond à une
 * AUTRE question — « où part ce message? », pour l'inscription A2P 10DLC et
 * les statistiques. Elle ne se pose qu'APRÈS coup, sur du trafic déjà parti.
 * Celle d'ici se pose AVANT, sur le chemin d'envoi, et `deliverability`
 * importe déjà de `sms` : les faire s'importer l'un l'autre nouerait les deux
 * dossiers. Ce qui est partagé se limite à la grammaire d'un numéro
 * nord-américain (2-9 en tête d'indicatif et de central) ; les TABLES, elles,
 * ne vivent qu'une fois, là-bas.
 */

import { isE164 } from "@/lib/phone";

/**
 * Régions permises par défaut : l'Amérique du Nord, et elle seule.
 *
 * Le CRM est celui d'un courtier québécois ; `src/lib/phone.ts` est écrit
 * « NANP d'abord » et transforme un dix chiffres nu en `+1…`. Un indicatif
 * étranger dans cette base est, en pratique, le symptôme d'un numéro abîmé.
 * Fermé par défaut, comme le mode d'envoi et l'interrupteur d'arrêt : ouvrir
 * une région est une décision d'exploitant (`SMS_ALLOWED_REGIONS`), qui doit
 * de toute façon être prise DEUX fois — ici et dans les permissions
 * géographiques de la console Twilio, sans quoi le 21408 revient.
 */
export const DEFAULT_ALLOWED_REGIONS: readonly string[] = ["1"];

/** `SMS_ALLOWED_REGIONS=*` — plus de garde régionale du tout. */
export const ALL_REGIONS = "*";

/**
 * Pourquoi ce numéro ne peut rien recevoir. Chaque motif est distinct parce
 * que chacun appelle un geste différent : corriger la fiche, ouvrir une
 * région, ou constater qu'il n'y a pas de numéro du tout.
 *
 * `invalid_to` garde le nom que le fournisseur écrivait déjà (`thread.skip.*`
 * le traduit depuis toujours) : un même fait ne doit pas prendre deux noms
 * selon la porte qui l'a arrêté.
 */
export const UNSENDABLE_REASONS = [
  /** Aucun numéro sur la fiche. */
  "no_phone",
  /** Pas au format E.164 — trop court, trop long, ou indicatif impossible. */
  "invalid_to",
  /** Indicatif de pays hors des régions permises — c'est le 21408. */
  "region_blocked",
  /** `+1`, mais aucun numéro nord-américain ne peut ressembler à ça. */
  "invalid_nanp",
] as const;
export type UnsendableReason = (typeof UNSENDABLE_REASONS)[number];

export type DestinationVerdict =
  | { sendable: true; region: string }
  | {
      sendable: false;
      reason: UnsendableReason;
      /**
       * De quoi comprendre le refus SANS republier le numéro : le début de
       * l'indicatif (« +336… »), le nombre de chiffres, ou la partie fautive
       * d'un numéro nord-américain. Ce texte finit dans `messages.skip_reason`
       * et dans les journaux ; il ne doit donc jamais suffire à recomposer le
       * numéro de quelqu'un. L'écran, lui, ne lit que le motif — il coupe aux
       * deux-points (`skipReason.split(":")[0]`).
       */
      detail: string | null;
    };

/**
 * Un numéro nord-américain, décomposé : indicatif régional (NPA), central
 * (NXX), ligne. Les deux premiers commencent par 2-9 — aucun numéro composable
 * ne commence par 0 ou 1, ces chiffres appartiennent à l'opérateur.
 */
const NANP_RE = /^\+1([2-9][0-9]{2})([2-9][0-9]{2})([0-9]{4})$/;

/**
 * Les dix chiffres d'un numéro nord-américain, SANS le « 1 » de tête.
 *
 * Sert à reconnaître le faux ami le plus fréquent de cette base : un numéro du
 * Québec collé derrière un « + » (« +4184761542 »). `normalizePhone` garde les
 * chiffres tels quels dès qu'il voit un plus, l'indicatif régional 418 devient
 * alors l'indicatif de PAYS 41, et le refus se lisait « pays non servi par le
 * compte Twilio » — qui envoie le courtier ouvrir les permissions
 * géographiques de Twilio pour la Suisse, alors que la réparation est un
 * caractère à effacer sur la fiche.
 */
const BARE_NANP_RE = /^[2-9][0-9]{2}[2-9][0-9]{2}[0-9]{4}$/;

/**
 * `SMS_ALLOWED_REGIONS` : des indicatifs de pays séparés par des virgules
 * (« 1 », « 1,33 »), ou `*` pour tout ouvrir. Vide ou absent = le défaut.
 *
 * On accepte le « + » d'usage (« +1 ») et on le retire : personne ne devrait
 * avoir à deviner laquelle des deux écritures ce réglage attend.
 */
export function parseAllowedRegions(value: string | undefined | null): readonly string[] {
  if (!value) return DEFAULT_ALLOWED_REGIONS;
  const entries = value
    .split(",")
    .map((entry) => entry.trim().replace(/^\+/, ""))
    .filter((entry) => entry === ALL_REGIONS || /^[1-9][0-9]{0,2}$/.test(entry));
  // Une valeur entièrement illisible ne doit pas OUVRIR la porte en silence :
  // on retombe sur le défaut, pas sur « aucune restriction ».
  return entries.length > 0 ? entries : DEFAULT_ALLOWED_REGIONS;
}

/**
 * L'indicatif de pays d'un numéro E.164, quand on le connaît.
 *
 * Les indicatifs forment un code PRÉFIXE : aucun n'est le début d'un autre.
 * Comparer le début du numéro à la liste permise est donc exact, et évite de
 * trimballer la table des ~230 indicatifs du monde pour répondre à une
 * question qui, ici, porte presque toujours sur un seul d'entre eux.
 */
function matchedRegion(e164: string, allowed: readonly string[]): string | null {
  const digits = e164.slice(1);
  for (const region of allowed) {
    if (digits.startsWith(region)) return region;
  }
  return null;
}

/**
 * Le verdict. `allowedRegions` vient de l'appelant (l'environnement, câblé
 * dans `src/lib/sms-server`) : ce module ne lit rien tout seul.
 */
export function checkDestination(
  to: string | null | undefined,
  regions: readonly string[] = DEFAULT_ALLOWED_REGIONS,
): DestinationVerdict {
  // Une liste VIDE fermerait la planète entière — ce que personne n'écrit
  // exprès. `parseAllowedRegions` n'en produit pas ; un appelant qui filtre sa
  // liste avant de la passer, si, et le noir total serait alors silencieux.
  const allowedRegions = regions.length > 0 ? regions : DEFAULT_ALLOWED_REGIONS;
  const trimmed = (to ?? "").trim();
  if (trimmed === "") return { sendable: false, reason: "no_phone", detail: null };
  if (!isE164(trimmed)) {
    // La LONGUEUR, pas le numéro : « 7 chiffres » se lit dans un journal, se
    // corrige sur une fiche, et ne désigne personne.
    const digits = trimmed.replace(/\D/g, "").length;
    return { sendable: false, reason: "invalid_to", detail: `${digits} chiffres` };
  }

  const unrestricted = allowedRegions.includes(ALL_REGIONS);
  const region = unrestricted ? null : matchedRegion(trimmed, allowedRegions);
  if (!unrestricted && region === null) {
    // Avant d'accuser un PAYS, reconnaître le numéro d'ici auquel il ne manque
    // que son « 1 ». C'est le cas le plus fréquent, et le seul dont la
    // réparation tient sur la fiche : le dire « pays non servi » enverrait
    // corriger la console Twilio pour un problème de saisie.
    if (BARE_NANP_RE.test(trimmed.slice(1))) {
      return { sendable: false, reason: "invalid_nanp", detail: "indicatif de pays manquant" };
    }
    // Sinon, un vrai indicatif étranger. On ne sait pas le découper exactement
    // (il faudrait la table mondiale) : les trois premiers chiffres suffisent à
    // dire QUEL pays ouvrir, et ne recomposent rien.
    return { sendable: false, reason: "region_blocked", detail: `+${trimmed.slice(1, 4)}…` };
  }

  // La grammaire nord-américaine, pour les seuls numéros qui s'en réclament.
  // Ailleurs, la longueur E.164 est tout ce qu'on peut affirmer hors ligne.
  if (trimmed.startsWith("+1")) {
    const parts = NANP_RE.exec(trimmed);
    if (!parts) {
      return {
        sendable: false,
        reason: "invalid_nanp",
        detail: trimmed.length === 12 ? "indicatif ou central impossible" : "longueur",
      };
    }
    const [, npa, nxx] = parts;
    // Les codes de service (411, 611, 911…) ne sont ni des régions ni des
    // centraux : un numéro qui en contient un n'a jamais été composable.
    if (npa.endsWith("11")) return { sendable: false, reason: "invalid_nanp", detail: "indicatif de service" };
    if (nxx.endsWith("11")) return { sendable: false, reason: "invalid_nanp", detail: "central de service" };
  }

  // Sans garde régionale, il n'y a pas d'indicatif « retenu » : la chaîne vide
  // dit exactement ça, plutôt que de faire deviner un pays qu'on n'a pas lu.
  return { sendable: true, region: region ?? "" };
}

