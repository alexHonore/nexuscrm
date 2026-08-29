"use server";

import { and, eq, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { pushSubscriptions, userReach } from "@/db/schema-push";
import { type AuditChanges, diffFields, logAudit, secretChange } from "@/lib/audit";
import { getCurrentUser } from "@/lib/auth/guards";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { createSession, readSession } from "@/lib/auth/session";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { normalizePhone } from "@/lib/phone";
import { NOTIFICATION_TYPES, parseHhMm, pushRule } from "@/lib/push/policy";

export type ProfileResult =
  | { ok: true }
  | { ok: false; error: "invalid" | "forbidden" | "emailTaken" | "wrongPassword" };

const FORBIDDEN = { ok: false, error: "forbidden" } as const;
const INVALID = { ok: false, error: "invalid" } as const;

const profileSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(200),
});

/** Chaque utilisateur (admin ou téléphoniste) modifie SON nom / courriel. */
export async function updateProfileAction(input: {
  name: string;
  email: string;
}): Promise<ProfileResult> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;

  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) return INVALID;
  const { name, email } = parsed.data;

  // Le courriel sert d'identifiant de connexion : unicité vérifiée avant.
  const taken = await db.query.users.findFirst({
    where: and(eq(users.email, email), ne(users.id, user.id)),
    columns: { id: true },
  });
  if (taken) return { ok: false, error: "emailTaken" };

  const changes = diffFields(user, { name, email }, ["name", "email"]);
  if (changes) {
    await db
      .update(users)
      .set({ name, email, updatedAt: new Date() })
      .where(eq(users.id, user.id));
    await logAudit({
      userId: user.id,
      action: "user.update",
      entity: "user",
      entityId: user.id,
      detail: { self: true, changes },
    });
  }
  revalidatePath("/profile");
  return { ok: true };
}

/**
 * Changement de mot de passe par son détenteur — exige le mot de passe actuel.
 * Mêmes règles et même action d'audit que la route admin
 * (POST /api/admin/password) : min 8, et toutes les AUTRES sessions sont
 * révoquées (tokenVersion) — seul le navigateur courant reçoit un nouveau cookie.
 */
export async function changePasswordAction(input: {
  current: string;
  next: string;
}): Promise<ProfileResult> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;

  const parsed = z
    .object({ current: z.string().min(1), next: z.string().min(8).max(128) })
    .safeParse(input);
  if (!parsed.success) return INVALID;

  const ok = await verifyPassword(parsed.data.current, user.passwordHash);
  if (!ok) return { ok: false, error: "wrongPassword" };

  const [row] = await db
    .update(users)
    .set({
      passwordHash: await hashPassword(parsed.data.next),
      // Invalide les sessions existantes (cookie volé, appareil partagé)…
      tokenVersion: sql`${users.tokenVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id))
    .returning({ tokenVersion: users.tokenVersion });
  // …et réémet la session courante pour que CE navigateur reste connecté.
  const session = await readSession();
  await createSession({
    uid: user.id,
    role: user.role,
    tv: row.tokenVersion,
    remember: session?.remember ?? false,
  });
  await logAudit({
    userId: user.id,
    action: "user.password_change",
    entity: "user",
    entityId: user.id,
  });
  return { ok: true };
}

// ── Notifications : par quoi cette personne accepte d'être atteinte ──────────

/**
 * Les réglages de joignabilité ont leur propre vocabulaire d'échec : `phone`
 * n'est pas `invalid`. Un numéro refusé se corrige dans le champ qu'on vient
 * de remplir, et le dire précisément évite le « une erreur est survenue » qui
 * laisse chercher laquelle.
 */
export type ReachResult = { ok: true } | { ok: false; error: "invalid" | "forbidden" | "phone" };

const REACH_FORBIDDEN = { ok: false, error: "forbidden" } as const;
const REACH_INVALID = { ok: false, error: "invalid" } as const;

/**
 * Écrit la ligne de `user_reach`, ou la crée.
 *
 * L'insertion-ou-mise-à-jour n'est pas une coquetterie : personne ne fabrique
 * cette ligne à la création du compte — son ABSENCE signifie « les défauts »,
 * jamais « rien » (voir `src/db/schema-push.ts`). Un simple `update` ne rendrait
 * donc aucune erreur sur un compte qui n'a jamais rien réglé : il toucherait
 * zéro ligne, et le réglage disparaîtrait en silence au rechargement.
 */
async function saveReach(
  userId: string,
  patch: Partial<typeof userReach.$inferInsert>,
): Promise<void> {
  const now = new Date();
  await db
    .insert(userReach)
    .values({ userId, ...patch, updatedAt: now })
    .onConflictDoUpdate({ target: userReach.userId, set: { ...patch, updatedAt: now } });
}

/**
 * Ce que la personne accepte de recevoir, type par type.
 *
 * On n'enregistre QUE les refus. `shouldPush` lit une préférence absente comme
 * un oui, et c'est ce qui permet à un type ajouté l'an prochain d'arriver chez
 * tout le monde sans que personne n'ait à rouvrir cet écran : c'est le silence
 * qui se demande, jamais le bruit. Enregistrer la liste complète des « oui »
 * aurait figé le catalogue d'aujourd'hui dans chaque ligne de la table, et le
 * type suivant serait né muet.
 *
 * La liste est FERMÉE côté serveur : un nom inventé par le navigateur n'entre
 * pas en base, où plus rien ne viendrait jamais le relire ni le retirer.
 */
export async function updatePushPrefsAction(input: {
  prefs: Record<string, boolean>;
}): Promise<ReachResult> {
  const user = await getCurrentUser();
  if (!user) return REACH_FORBIDDEN;

  const parsed = z.object({ prefs: z.record(z.string(), z.boolean()) }).safeParse(input);
  if (!parsed.success) return REACH_INVALID;

  const refused: Record<string, boolean> = {};
  for (const type of NOTIFICATION_TYPES) {
    if (pushRule(type).push && parsed.data.prefs[type] === false) refused[type] = false;
  }

  await saveReach(user.id, { pushPrefs: refused });
  revalidatePath("/profile");
  return { ok: true };
}

/**
 * Les heures de silence du téléphoniste — celles qui le protègent de son
 * employeur, à ne pas confondre avec celles qui protègent le client de nos
 * envois (`src/lib/sms/quiet-hours.ts`).
 *
 * Deux champs vides valent « jamais de silence » ; un seul rempli est refusé
 * plutôt que complété d'office, parce qu'aucune moitié de nuit n'a de sens et
 * qu'inventer l'autre borne ferait taire des heures que personne n'a choisies.
 * Deux heures IDENTIQUES sont refusées pour la même raison : `isWithinQuietHours`
 * les lit comme une fenêtre vide, et l'écran afficherait alors « 22:00 → 22:00 »
 * en promettant un silence qui n'arrive jamais.
 */
export async function updateQuietHoursAction(input: {
  from: string;
  to: string;
  bypassUrgent: boolean;
}): Promise<ReachResult> {
  const user = await getCurrentUser();
  if (!user) return REACH_FORBIDDEN;

  const parsed = z
    .object({ from: z.string().max(5), to: z.string().max(5), bypassUrgent: z.boolean() })
    .safeParse(input);
  if (!parsed.success) return REACH_INVALID;

  const from = parsed.data.from.trim();
  const to = parsed.data.to.trim();
  const cleared = from === "" && to === "";
  if (!cleared) {
    if (parseHhMm(from) === null || parseHhMm(to) === null) return REACH_INVALID;
    if (from === to) return REACH_INVALID;
  }

  await saveReach(user.id, {
    quietFrom: cleared ? null : from,
    quietTo: cleared ? null : to,
    quietBypassUrgent: parsed.data.bypassUrgent,
  });
  revalidatePath("/profile");
  return { ok: true };
}

/**
 * Le numéro composable, tel que voip.ms et Twilio l'acceptent : indicatif de
 * pays, huit à quinze chiffres. Le même que celui de `resolveSimulRing`, et
 * recopié pour la même raison qu'il y est écrit — un « 514 555-0199 » collé
 * tel quel produit un `<Number>` invalide, c'est-à-dire un appel entrant qui
 * échoue au lieu de sonner.
 */
const DIALABLE_E164 = /^\+[1-9]\d{7,14}$/;

/** Le numéro précédent, déchiffré, ou `null` — une clé changée ne doit rien casser. */
function previousMobile(enc: string | null): string | null {
  if (!enc) return null;
  try {
    return decryptSecret(enc);
  } catch {
    return null;
  }
}

/**
 * Le cellulaire personnel et le « oui » qui l'accompagne.
 *
 * Trois choses tiennent ensemble ici, et aucune ne se déduit des autres :
 *
 * 1. Le numéro est CHIFFRÉ (règle 4). C'est un numéro personnel confié à un
 *    employeur pour une seule raison, et il n'a pas à être lisible par qui
 *    obtient une copie de la base. Seuls les quatre derniers chiffres restent
 *    en clair, parce qu'un écran doit pouvoir dire « •••• 0199 » sans
 *    déchiffrer et sans redemander.
 * 2. Le numéro ne redescend JAMAIS vers l'écran — il n'en connaît que les
 *    quatre derniers chiffres. Un champ vide ne peut donc pas vouloir dire
 *    « efface » : ce serait effacer par omission, à chaque fois que quelqu'un
 *    vient seulement basculer l'interrupteur. D'où trois cas explicites :
 *    `null` ne touche pas au numéro, `""` le retire, le reste le remplace.
 * 3. `ringMobile` est le consentement de la PERSONNE, distinct des deux
 *    interrupteurs de l'administrateur (`telephony.simulRing`). Il s'enregistre
 *    même quand la fonction est fermée pour l'équipe — l'écran le dit — parce
 *    que `resolveSimulRing` exige les trois : rien ne sonne d'un seul « oui ».
 *    Sans numéro, il retombe à faux : un « oui » orphelin se réveillerait tout
 *    seul au prochain numéro saisi, et c'est exactement la surprise qu'on refuse.
 *
 * Le journal (règle 5) consigne QU'un numéro a changé, jamais lequel : les
 * marqueurs de `secretChange` disent « défini » puis « modifié », et le numéro
 * lui-même n'entre pas dans `audit_logs`.
 */
export async function updateMobileAction(input: {
  /** `null` : ne touche pas au numéro. `""` : le retirer. Sinon : le remplacer. */
  phone: string | null;
  ringMobile: boolean;
}): Promise<ReachResult> {
  const user = await getCurrentUser();
  if (!user) return REACH_FORBIDDEN;

  const parsed = z
    .object({ phone: z.string().max(40).nullable(), ringMobile: z.boolean() })
    .safeParse(input);
  if (!parsed.success) return REACH_INVALID;

  const [existing] = await db
    .select({ enc: userReach.mobilePhoneEnc, ringMobile: userReach.ringMobile })
    .from(userReach)
    .where(eq(userReach.userId, user.id))
    .limit(1);

  const before = previousMobile(existing?.enc ?? null);
  const wasRinging = existing?.ringMobile ?? false;

  const raw = parsed.data.phone === null ? null : parsed.data.phone.trim();
  let phone: string | null;
  if (raw === null) phone = before;
  else if (raw === "") phone = null;
  else {
    phone = normalizePhone(raw);
    if (!phone || !DIALABLE_E164.test(phone)) return { ok: false, error: "phone" };
  }
  const ringMobile = phone === null ? false : parsed.data.ringMobile;

  const changes: AuditChanges = {};
  if (before !== phone) changes.mobilePhone = secretChange(before !== null, phone !== null);
  if (wasRinging !== ringMobile) changes.ringMobile = { from: wasRinging, to: ringMobile };

  await saveReach(user.id, {
    // Le numéro n'est réécrit que s'il a été TOUCHÉ. Le rechiffrer à chaque
    // passage n'aurait rien cassé (AES-GCM tire un IV neuf, le clair est le
    // même), mais écrire une colonne qu'on n'a pas modifiée est la meilleure
    // façon de perdre la trace du jour où elle a vraiment changé.
    ...(raw === null
      ? {}
      : {
          mobilePhoneEnc: phone === null ? null : encryptSecret(phone),
          mobileLast4: phone === null ? null : phone.slice(-4),
        }),
    ringMobile,
  });

  if (Object.keys(changes).length > 0) {
    await logAudit({
      userId: user.id,
      action: "user.mobile_update",
      entity: "user",
      entityId: user.id,
      detail: { self: true, changes },
    });
  }
  revalidatePath("/profile");
  return { ok: true };
}

/**
 * « Cet appareil ne veut plus rien recevoir. »
 *
 * L'appareil est désigné par l'identifiant de SA ligne et la suppression est
 * bornée au propriétaire : sans le `and`, connaître l'identifiant d'un collègue
 * suffirait à le rendre sourd — et il ne s'en apercevrait qu'en ratant un
 * prospect.
 *
 * Le geste est consigné sous la MÊME action que la route
 * `DELETE /api/push/subscribe` (`push.unsubscribe`) : c'est le même événement
 * de sécurité, et deux noms auraient coupé le journal en deux selon l'écran
 * d'où l'on a cliqué. Jamais l'endpoint en entier — c'est un jeton d'envoi ;
 * sa fin suffit à reconnaître l'appareil.
 */
export async function forgetDeviceAction(input: { id: string }): Promise<ReachResult> {
  const user = await getCurrentUser();
  if (!user) return REACH_FORBIDDEN;
  if (!z.string().uuid().safeParse(input.id).success) return REACH_INVALID;

  const deleted = await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.id, input.id), eq(pushSubscriptions.userId, user.id)))
    .returning({ id: pushSubscriptions.id, endpoint: pushSubscriptions.endpoint });

  if (deleted.length > 0) {
    await logAudit({
      userId: user.id,
      action: "push.unsubscribe",
      entity: "push_subscription",
      entityId: deleted[0].id,
      detail: { tail: deleted[0].endpoint.slice(-12), self: true },
    });
  }

  // On répond « fait » même si la ligne n'existait pas : l'appareil ne reçoit
  // plus rien, c'est ce qui était demandé. Distinguer renseignerait sur ce qui
  // existe chez les autres.
  revalidatePath("/profile");
  return { ok: true };
}
