/**
 * Sonnerie SIMULTANÉE : le poste du téléphoniste ET son cellulaire personnel
 * sonnent en même temps, le premier qui décroche prend l'appel.
 *
 * L'exploitant a tranché (2026-08-28) : la notification poussée reste le
 * DÉFAUT, faire sonner le cellulaire est une option que l'administrateur
 * allume. Ce module est donc écrit pour être INERTE : tant que le réglage est
 * éteint ou qu'aucun cellulaire n'est enregistré, chaque fonction rend
 * `{ status: "skipped", reason }` sans toucher au réseau et sans lever
 * d'exception. Un numéro personnel qui se met à sonner parce qu'un défaut a
 * changé serait la pire des surprises ; le silence par défaut n'en est pas une.
 *
 * Ce module-ci est la moitié PURE : la décision (`resolveSimulRing`), le
 * schéma du réglage, les chaînes de routage voip.ms et le TwiML Twilio. Rien
 * n'y touche au réseau, donc tout s'y teste — et surtout, il reste lisible
 * depuis `src/lib/settings.ts`, que le moindre écran finit par importer.
 *
 * Les appels REST qui FABRIQUENT le renvoi, le groupe de sonnerie et le
 * routage du DID vivent à côté, dans `simulring-voipms.ts`, derrière
 * `server-only` — décider et appliquer ne se font pas au même endroit.
 *
 * Twilio n'a pas de seconde moitié : un `<Dial>` accepte plusieurs enfants et
 * les fait sonner ensemble, donc tout tient dans le TwiML. voip.ms n'a pas cet
 * équivalent — il faut un objet « Ring Group » créé d'avance chez lui, dont le
 * DID devient la destination.
 */
import { z } from "zod";
import { normalizePhone } from "@/lib/phone";
/**
 * Le DID réduit à ses chiffres composables — le jumeau PUR de `didDigits` de
 * `src/lib/voipms.ts`, recopié plutôt qu'importé.
 *
 * Ce module doit rester lisible depuis `src/lib/settings.ts`, que TOUT l'écran
 * lit ; `src/lib/voipms.ts` commence par `import "server-only"`, et l'importer
 * ici ferait tomber le premier composant client qui touche à un réglage. Trois
 * lignes dupliquées coûtent moins qu'une frontière serveur/client cassée —
 * `tests/unit-simulring.test.ts` vérifie que les deux versions s'accordent.
 */
export function didDigitsPure(did: string): string {
  const digits = did.replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

// ── Réglage ──────────────────────────────────────────────────────────────────

/**
 * Ce que l'administrateur enregistre pour UNE personne.
 *
 * Le NUMÉRO n'est pas ici : il vit chiffré dans `user_reach.mobile_phone_enc`
 * (règle 4). Un cellulaire personnel confié à son employeur n'a rien à faire en
 * clair dans un `jsonb` de réglages que tout écran d'administration relit — et
 * le dupliquer à deux endroits garantissait qu'un des deux finirait périmé.
 *
 * `forwardId` / `ringGroupId` ne sont pas des préférences : ce sont les
 * identifiants que voip.ms nous a rendus. On les mémorise pour RÉÉCRIRE les
 * mêmes entrées au lieu d'en empiler une nouvelle à chaque enregistrement —
 * un compte voip.ms se remplit vite de renvois orphelins que personne ne sait
 * plus rattacher à qui.
 */
export const simulRingLineSchema = z.object({
  enabled: z.boolean().default(false),
  forwardId: z.string().trim().default(""),
  ringGroupId: z.string().trim().default(""),
});
export type SimulRingLine = z.infer<typeof simulRingLineSchema>;

/**
 * L'interrupteur GLOBAL et les lignes, indexées par `users.id`.
 *
 * Deux interrupteurs plutôt qu'un : le global est celui que l'exploitant
 * bascule pour éteindre TOUT le monde d'un coup (une nuit, un incident, un
 * doute), sans avoir à défaire les réglages individuels et à se souvenir de
 * qui était allumé pour les remettre ensuite.
 */
export const simulRingSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  lines: z.record(z.string(), simulRingLineSchema).default({}),
});
export type SimulRingSettings = z.infer<typeof simulRingSettingsSchema>;

/** Réglage absent = éteint. C'est ce que voit une installation qui n'a rien enregistré. */
export const SIMULRING_OFF: SimulRingSettings = { enabled: false, lines: {} };

// ── La décision ──────────────────────────────────────────────────────────────

/**
 * Pourquoi on NE fait PAS sonner un cellulaire. Chaque raison est distincte
 * parce qu'elles ne se corrigent pas au même endroit : `feature_off` se règle
 * dans les réglages généraux, `line_off` sur la fiche de la personne,
 * `not_consented` et `no_cell` en le lui DEMANDANT — pas en le décidant pour
 * lui, `no_did` / `no_sip_account` en lui
 * attribuant une ligne. Un seul « non » les rendrait indiscernables dans un
 * journal, et l'admin chercherait longtemps.
 */
export type SimulRingSkipReason =
  | "feature_off"
  | "line_off"
  | "not_consented"
  | "no_cell"
  | "no_did"
  | "no_sip_account"
  | "no_forward";

export type SimulRingDecision =
  | { status: "on"; cell: string }
  | { status: "skipped"; reason: SimulRingSkipReason };

/** E.164 tel qu'on accepte de le composer : indicatif pays, 8 à 15 chiffres. */
const E164_RE = /^\+[1-9]\d{7,14}$/;

/**
 * Ce que la PERSONNE a accepté, déchiffré par l'appelant.
 *
 * Passé en argument plutôt que lu ici : ce module doit rester pur (il est
 * importé par `src/lib/settings.ts`, donc par tout l'écran) et le numéro sort
 * d'un `decryptSecret`, qui est `server-only`.
 */
export type ReachForRing = { cell: string | null; ringMobile: boolean };

/**
 * La question posée une seule fois, pour les deux fournisseurs.
 *
 * TROIS conditions, et il les faut toutes — c'est la traduction en code de la
 * décision de l'exploitant (2026-08-28) :
 *
 *  1. la maison a ouvert la fonction (`settings.enabled`) ;
 *  2. l'administrateur a ouvert la ligne de cette personne (`line.enabled`) ;
 *  3. la personne a dit oui et laissé un numéro (`reach`).
 *
 * La troisième n'est pas une redondance des deux premières : faire sonner le
 * cellulaire personnel de quelqu'un est une décision qui lui appartient, et
 * aucun interrupteur d'administration ne peut la prendre à sa place.
 *
 * Le numéro est RE-normalisé même s'il est censé l'être en base : un
 * « 514 555-0199 » collé tel quel produirait chez Twilio un `<Number>`
 * invalide — c'est-à-dire un appel entrant qui échoue au lieu de sonner.
 */
export function resolveSimulRing(
  settings: SimulRingSettings,
  userId: string,
  reach: ReachForRing | null,
): SimulRingDecision {
  if (!settings.enabled) return { status: "skipped", reason: "feature_off" };
  const line = settings.lines[userId];
  if (!line || !line.enabled) return { status: "skipped", reason: "line_off" };
  if (!reach || !reach.ringMobile) return { status: "skipped", reason: "not_consented" };
  const cell = normalizePhone(reach.cell ?? "");
  if (!cell || !E164_RE.test(cell)) return { status: "skipped", reason: "no_cell" };
  return { status: "on", cell };
}

/** La ligne enregistrée pour une personne, ou une ligne éteinte. */
export function simulRingLine(settings: SimulRingSettings, userId: string): SimulRingLine {
  return settings.lines[userId] ?? simulRingLineSchema.parse({});
}

// ── Twilio : un seul <Dial>, deux enfants ────────────────────────────────────

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Les valeurs du `<Dial>` entrant D'AUJOURD'HUI, sorties en constantes.
 *
 * Elles ne sont pas là pour être réglées mais pour être VÉRIFIÉES : le contrat
 * de ce module est que, option éteinte, le TwiML sortant soit identique octet
 * pour octet à celui que la route produisait avant. Un test compare la chaîne
 * complète ; ces constantes sont le seul endroit où l'attribut se décrit.
 */
export const INBOUND_DIAL_TIMEOUT_SECONDS = 30;
export const INBOUND_DIAL_ACTION = "/api/telephony/twiml?dialResult=1";

export interface InboundDialInput {
  /** Identité navigateur du propriétaire de la ligne, sans le préfixe « client: ». */
  identity: string;
  /** Décision rendue par `resolveSimulRing` — absente ou « skipped » ⇒ TwiML d'avant. */
  simulRing?: SimulRingDecision | null;
  /**
   * URL de CONFIRMATION jouée au cellulaire avant de ponter (« appuyez sur 1 »).
   * Absente par défaut : voir la note sur la boîte vocale plus bas.
   */
  confirmUrl?: string | null;
  timeoutSeconds?: number;
  action?: string;
}

/**
 * Le `<Dial>` d'un appel ENTRANT vers le DID d'un téléphoniste.
 *
 * Twilio fait le travail tout seul : plusieurs enfants dans un même `<Dial>`
 * sonnent EN PARALLÈLE et le premier qui décroche gagne, les autres jambes
 * sont raccrochées. D'où l'ordre choisi — `<Client>` d'abord : c'est la
 * destination normale, celle qui reste seule quand l'option est éteinte, et la
 * garder en tête laisse le diff à une seule balise ajoutée.
 *
 * Pas d'attribut `callerId` : sans lui, Twilio présente le numéro de
 * l'APPELANT aux deux jambes. C'est voulu deux fois plutôt qu'une — le
 * téléphoniste voit qui l'appelle sur son cellulaire, et le rapprochement de
 * la fiche client (qui lit ce numéro) continue de fonctionner. Le forcer au
 * DID afficherait « c'est le travail » mais effacerait l'identité de
 * l'appelant, ce qui est exactement l'information dont on a besoin.
 *
 * ⚠️ La boîte vocale du cellulaire est un CONCURRENT : elle décroche vers 20 s
 * alors que le `<Dial>` dure 30 s, et un répondeur qui décroche gagne la
 * course — l'appel est « répondu », le poste cesse de sonner, et l'appelant
 * parle à une messagerie personnelle. `confirmUrl` est la parade (la jambe
 * n'est pontée que si quelqu'un appuie sur une touche) ; elle est optionnelle
 * pour que l'activation reste un choix explicite de l'exploitant.
 */
export function inboundDialTwiml(input: InboundDialInput): string {
  const timeout = input.timeoutSeconds ?? INBOUND_DIAL_TIMEOUT_SECONDS;
  const action = input.action ?? INBOUND_DIAL_ACTION;

  const legs = [`<Client>${escapeXml(input.identity)}</Client>`];
  if (input.simulRing?.status === "on") {
    const url = input.confirmUrl ? ` url="${escapeXml(input.confirmUrl)}"` : "";
    legs.push(`<Number${url}>${escapeXml(input.simulRing.cell)}</Number>`);
  }

  return (
    `<Dial answerOnBridge="true" timeout="${timeout}" action="${escapeXml(action)}">` +
    `${legs.join("")}</Dial>`
  );
}

// ── voip.ms : les chaînes de routage ─────────────────────────────────────────

/**
 * `setDIDRouting` ne prend pas un objet mais une CHAÎNE `en-tête:identifiant`
 * (`account`, `fwd`, `vm`, `sip`, `grp`, `ivr`, `sys`, `recording`, `queue`,
 * `cb`, `tc`, `disa`, `none`). Les trois formes utiles ici sont écrites une
 * fois, ici, plutôt qu'interpolées à l'appel : une faute de préfixe ne se voit
 * pas — voip.ms accepte la requête et l'appel entrant part ailleurs.
 */
export function subAccountRouting(account: string): string {
  return `account:${account}`;
}

export function ringGroupRouting(ringGroupId: string | number): string {
  return `grp:${ringGroupId}`;
}

export function forwardingRouting(forwardId: string | number): string {
  return `fwd:${forwardId}`;
}

/**
 * Plafonds documentés d'un groupe de sonnerie voip.ms : au plus 8 membres SIP
 * / IAX2 / SIP URI et au plus 4 entrées de renvoi, douze en tout
 * (wiki.voip.ms/article/Ring_Groups). On les vérifie AVANT l'appel : dépassés,
 * voip.ms tronque ou refuse selon les cas, et un membre disparu d'un groupe
 * est une ligne qui ne sonne plus sans que rien ne le dise.
 */
export const MAX_RING_GROUP_SIP_MEMBERS = 8;
export const MAX_RING_GROUP_FORWARD_MEMBERS = 4;

export type RingGroupMembersResult =
  | { status: "ok"; members: string }
  | { status: "skipped"; reason: "no_members" | "too_many_sip" | "too_many_forwards" };

/**
 * La liste des membres, telle que l'attend le paramètre `members` de
 * `setRingGroup` : des `en-tête:identifiant` séparés par des POINTS-VIRGULES
 * (« account:100001;fwd:16006 »).
 */
export function ringGroupMembers(input: {
  sipAccounts: readonly string[];
  forwardIds: readonly (string | number)[];
}): RingGroupMembersResult {
  const sip = input.sipAccounts.filter((a) => a.trim() !== "");
  const fwd = input.forwardIds.map(String).filter((id) => id.trim() !== "");
  if (sip.length === 0 && fwd.length === 0) return { status: "skipped", reason: "no_members" };
  if (sip.length > MAX_RING_GROUP_SIP_MEMBERS) return { status: "skipped", reason: "too_many_sip" };
  if (fwd.length > MAX_RING_GROUP_FORWARD_MEMBERS) {
    return { status: "skipped", reason: "too_many_forwards" };
  }
  return {
    status: "ok",
    members: [...sip.map(subAccountRouting), ...fwd.map(forwardingRouting)].join(";"),
  };
}

/**
 * Le numéro tel que le veut une entrée de renvoi voip.ms.
 *
 * Le wiki est explicite (wiki.voip.ms/article/Call_Forwarding) : en Amérique
 * du Nord, dix chiffres ou le préfixe 1 donnent le même résultat ; ailleurs,
 * le numéro doit porter le préfixe 00 ou 011. Un « + » E.164 n'est donc JAMAIS
 * ce qu'il faut envoyer : on rend 10 chiffres pour le NANP et une forme 011…
 * pour le reste — même raison que `didDigits`, dont la version E.164 faisait
 * échouer `setDIDRouting` avec « invalid_did » en production.
 */
export function forwardingNumber(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length === 10) return digits;
  return `011${digits}`;
}

/**
 * Le nom des objets que ce module fabrique chez voip.ms. Il est DÉRIVÉ (du
 * DID, du nom de la personne) et non saisi : c'est la seule façon de retrouver
 * « notre » entrée dans un compte voip.ms partagé avec ce qu'un humain y a
 * créé à la main, et donc de la réécrire au lieu d'en ajouter une jumelle.
 * Sans accent, volontairement : ces chaînes traversent une API REST ancienne
 * et reviennent dans un portail qui n'est pas le nôtre.
 */
export function forwardingDescription(userName: string): string {
  return `Nexus cellulaire ${userName}`.slice(0, 60);
}

export function ringGroupName(did: string): string {
  return `Nexus ${didDigitsPure(did)}`;
}
