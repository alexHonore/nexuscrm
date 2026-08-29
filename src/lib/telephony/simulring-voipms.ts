import "server-only";
import { didDigits, routeDidToSubAccount, voipms } from "@/lib/voipms";
import {
  forwardingDescription,
  forwardingNumber,
  ringGroupMembers,
  ringGroupName,
  ringGroupRouting,
  subAccountRouting,
  type SimulRingDecision,
  type SimulRingSkipReason,
} from "./simulring";

/**
 * L'approvisionnement voip.ms de la sonnerie simultanée — la moitié qui PARLE
 * au fournisseur.
 *
 * Séparée de `simulring.ts` pour une raison de frontière et pas de goût :
 * `src/lib/voipms.ts` est `server-only`, et les décisions de sonnerie (le
 * schéma du réglage, le TwiML, les chaînes de routage) doivent rester lisibles
 * depuis un écran. Tout ce qui traverse le réseau vit donc ici, et rien de ce
 * qui vit ici n'est nécessaire pour DÉCIDER — seulement pour APPLIQUER.
 */

// ── voip.ms : les appels REST ────────────────────────────────────────────────

/**
 * voip.ms ne documente pas sous quel nom il rend l'identifiant d'une entrée
 * qu'il vient de créer, et les réponses observées varient d'une méthode à
 * l'autre. On accepte donc les noms plausibles plutôt que de parier sur un
 * seul : se tromper de champ rendrait « créé, mais introuvable », c'est-à-dire
 * une entrée de plus à chaque enregistrement.
 */
function firstId(payload: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

const FORWARD_ID_KEYS = ["forwarding", "id", "fwd"] as const;
const RING_GROUP_ID_KEYS = ["ring_group", "ringgroup", "id"] as const;

/** Ce que voip.ms rend dans `getForwardings` (champs utiles seulement). */
type VoipMsForwarding = {
  forwarding?: string | number;
  id?: string | number;
  phone_number?: string;
  description?: string;
};

/** Ce que voip.ms rend dans `getRingGroups` (champs utiles seulement). */
type VoipMsRingGroup = {
  ring_group?: string | number;
  ringgroup?: string | number;
  id?: string | number;
  name?: string;
  members?: string;
};

/**
 * « Rien de ce genre sur le compte » — ce n'est pas une panne. voip.ms le dit
 * par un statut, pas par une liste vide, exactement comme pour les DID et les
 * enregistrements (voir `EMPTY_DID_STATUSES` dans src/lib/voipms.ts).
 */
const EMPTY_STATUSES = new Set([
  "no_forwarding",
  "no_forwardings",
  "no_ring_group",
  "no_ring_groups",
  "no_ringgroup",
  "no_ringgroups",
]);

async function listOrEmpty<T>(
  method: string,
  field: string,
  params: Record<string, string | number | undefined> = {},
): Promise<T[]> {
  try {
    const r = await voipms<Record<string, unknown>>(method, params);
    const list = r[field];
    return Array.isArray(list) ? (list as T[]) : [];
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    if (typeof status === "string" && EMPTY_STATUSES.has(status)) return [];
    throw err;
  }
}

export interface SimulRingUser {
  /** `users.id` — sert à retrouver la ligne dans le réglage. */
  id: string;
  /** Nom affiché : il devient la description du renvoi côté voip.ms. */
  name: string;
  /** Décision déjà rendue pour cette personne (`resolveSimulRing`). */
  simulRing: SimulRingDecision;
  /** Identifiant du renvoi déjà créé pour elle, si on le connaît. */
  forwardId?: string | null;
}

export type EnsureForwardingResult =
  | { status: "ok"; forwardId: string; created: boolean }
  | { status: "skipped"; reason: SimulRingSkipReason }
  | { status: "failed"; reason: "forward_id_unknown" };

/**
 * L'entrée « Call Forwarding » qui porte le cellulaire de la personne.
 *
 * C'est l'objet indirect qu'exige voip.ms : un groupe de sonnerie ne prend pas
 * un numéro de téléphone, il prend des MEMBRES, et un numéro externe n'y entre
 * que sous la forme d'un renvoi (`fwd:<id>`) créé à l'avance.
 *
 * Aucun `callerid_override` n'est envoyé, et c'est un choix : le wiki
 * prévient qu'un renvoi porteur d'un override, une fois placé dans un groupe
 * de sonnerie, impose ce numéro à TOUS les appels qui passent par le groupe
 * (wiki.voip.ms/article/Call_Forwarding). Le forcer masquerait donc l'appelant
 * sur toutes les jambes, y compris celle du softphone — et le CRM ne saurait
 * plus quelle fiche afficher.
 */
export async function ensureCellForwarding(user: SimulRingUser): Promise<EnsureForwardingResult> {
  if (user.simulRing.status !== "on") {
    return { status: "skipped", reason: user.simulRing.reason };
  }

  const phone = forwardingNumber(user.simulRing.cell);
  const description = forwardingDescription(user.name);
  const existing = user.forwardId?.trim();

  const payload = await voipms<Record<string, unknown>>("setForwarding", {
    // Vide ⇒ `voipms()` retire le paramètre, et voip.ms CRÉE au lieu de réécrire.
    forwarding: existing || undefined,
    phone_number: phone,
    description,
  });

  const id = firstId(payload, FORWARD_ID_KEYS);
  if (id) return { status: "ok", forwardId: id, created: !existing };
  if (existing) return { status: "ok", forwardId: existing, created: false };

  // Créé, mais voip.ms n'a pas nommé l'identifiant dans sa réponse : on relit
  // la liste et on reconnaît notre entrée à sa description dérivée. Sans ce
  // repli, chaque enregistrement ajouterait un renvoi de plus au compte.
  const list = await listOrEmpty<VoipMsForwarding>("getForwardings", "forwardings");
  const mine = list.find(
    (f) => f.description === description || String(f.phone_number ?? "") === phone,
  );
  const found = mine ? firstId(mine as Record<string, unknown>, FORWARD_ID_KEYS) : null;
  if (found) return { status: "ok", forwardId: found, created: true };
  return { status: "failed", reason: "forward_id_unknown" };
}

export type EnsureRingGroupResult =
  | { status: "ok"; ringGroupId: string; created: boolean }
  | { status: "skipped"; reason: SimulRingSkipReason | "too_many_sip" | "too_many_forwards" }
  | { status: "failed"; reason: "ring_group_id_unknown" };

/**
 * Le groupe de sonnerie : le poste SIP du téléphoniste ET le renvoi vers son
 * cellulaire, dans un même objet voip.ms. Un DID routé vers un groupe fait
 * sonner tous ses membres EN MÊME TEMPS jusqu'à ce que l'un décroche
 * (wiki.voip.ms/article/Ring_Groups) — c'est cette phrase-là qui fait tout le
 * travail, on ne fait que fabriquer l'objet.
 *
 * Le groupe est retrouvé par son NOM avant d'être écrit : voip.ms crée une
 * nouvelle entrée dès qu'on ne lui donne pas d'identifiant, et un compte qui
 * accumule « Nexus 4184761542 » en douze exemplaires ne se démêle plus.
 */
export async function ensureRingGroup(opts: {
  /** DID de la ligne, E.164 — il ne sert qu'à NOMMER le groupe. */
  did: string | null;
  /** Nom complet du sous-compte SIP (« 551013_alex »). */
  sipAccount: string | null;
  /** Identifiant du renvoi rendu par `ensureCellForwarding`. */
  cellForwardId: string | null;
  /**
   * Boîte vocale du groupe. `setRingGroup` exige le paramètre ; 0 est la
   * valeur « aucune » observée dans les clients tiers — non confirmée par la
   * documentation, d'où le fait qu'elle soit réglable ici.
   */
  voicemail?: string | number;
  language?: string;
}): Promise<EnsureRingGroupResult> {
  if (!opts.did) return { status: "skipped", reason: "no_did" };
  if (!opts.sipAccount) return { status: "skipped", reason: "no_sip_account" };
  if (!opts.cellForwardId) return { status: "skipped", reason: "no_forward" };

  const members = ringGroupMembers({
    sipAccounts: [opts.sipAccount],
    forwardIds: [opts.cellForwardId],
  });
  if (members.status !== "ok") {
    return members.reason === "no_members"
      ? { status: "skipped", reason: "no_forward" }
      : { status: "skipped", reason: members.reason };
  }

  const name = ringGroupName(opts.did);
  const groups = await listOrEmpty<VoipMsRingGroup>("getRingGroups", "ring_groups");
  const existing = groups.find((g) => g.name === name);
  const existingId = existing
    ? firstId(existing as Record<string, unknown>, RING_GROUP_ID_KEYS)
    : null;

  const payload = await voipms<Record<string, unknown>>("setRingGroup", {
    ring_group: existingId ?? undefined,
    name,
    members: members.members,
    voicemail: opts.voicemail ?? 0,
    language: opts.language,
  });

  const id = firstId(payload, RING_GROUP_ID_KEYS) ?? existingId;
  if (id) return { status: "ok", ringGroupId: id, created: !existingId };

  const after = await listOrEmpty<VoipMsRingGroup>("getRingGroups", "ring_groups");
  const mine = after.find((g) => g.name === name);
  const found = mine ? firstId(mine as Record<string, unknown>, RING_GROUP_ID_KEYS) : null;
  if (found) return { status: "ok", ringGroupId: found, created: true };
  return { status: "failed", reason: "ring_group_id_unknown" };
}

export type RouteResult =
  | { status: "ok"; routing: string }
  | { status: "skipped"; reason: SimulRingSkipReason };

/**
 * Bascule le DID du sous-compte vers le groupe. C'est la DERNIÈRE étape et
 * elle doit le rester : router un DID vers un groupe qui n'existe pas encore,
 * ou dont le renvoi manque, envoie les appels entrants dans le vide.
 *
 * Le POP du DID doit être le même serveur que celui où les membres SIP du
 * groupe s'enregistrent — le wiki y insiste (wiki.voip.ms/article/Ring_Groups).
 * C'est déjà vrai ici : `DEFAULT_SIP_DOMAIN` sert au softphone comme au choix
 * du POP à l'achat d'un numéro.
 */
export async function routeDidToRingGroup(
  did: string | null,
  ringGroupId: string | null,
): Promise<RouteResult> {
  if (!did) return { status: "skipped", reason: "no_did" };
  if (!ringGroupId) return { status: "skipped", reason: "no_forward" };
  const routing = ringGroupRouting(ringGroupId);
  await voipms("setDIDRouting", { did: didDigits(did), routing });
  return { status: "ok", routing };
}

/**
 * Le retour en arrière : le DID repointe DIRECTEMENT sur le sous-compte, comme
 * avant que l'option existe.
 *
 * Le groupe et le renvoi ne sont pas supprimés, exprès. Éteindre l'option doit
 * être instantané et réversible ; détruire les objets voip.ms rendrait le
 * rallumage lent (deux créations, deux identifiants à re-mémoriser) et
 * risquerait d'effacer une entrée qu'un humain a entre-temps réutilisée
 * ailleurs — un renvoi se partage entre plusieurs DID. Ce qui compte pour que
 * le cellulaire cesse de sonner, c'est le ROUTAGE, et il est réécrit ici.
 */
export async function disableSimulRing(
  did: string | null,
  sipAccount: string | null,
): Promise<RouteResult> {
  if (!did) return { status: "skipped", reason: "no_did" };
  if (!sipAccount) return { status: "skipped", reason: "no_sip_account" };
  await routeDidToSubAccount(did, sipAccount);
  return { status: "ok", routing: subAccountRouting(sipAccount) };
}
