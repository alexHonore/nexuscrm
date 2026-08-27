import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  campaignEnrollments,
  campaignTouches,
  campaigns,
  scheduledJobs,
} from "@/db/schema-sms";
import { campaignRowToConfig } from "@/lib/campaigns/schema";
import { nextTouchAt } from "@/lib/campaigns/ladder";
import {
  PAUSED_REASON,
  REMOVED_REASON,
  enrollmentInFlight,
  enrollmentPaused,
} from "@/lib/campaigns/enrollment-status";
import {
  reopenEnrollments,
  type ReopenGateError,
  type ReopenRowRefusal,
} from "./reopen";

/**
 * Actions manuelles de l'administrateur sur UNE inscription : la mettre en
 * pause, la reprendre, retirer le client de la campagne, ou RELANCER une
 * inscription terminée quand l'échelle a grandi depuis (`reopen.ts`).
 *
 * « Reprendre » et « relancer » ne se confondent pas : la première sort une
 * inscription VIVANTE de la pause où l'administrateur l'a mise, la seconde
 * rouvre une inscription CLOSE parce qu'il reste des barreaux qui n'existaient
 * pas quand elle s'est terminée.
 *
 * Le schéma est gelé : pas de statut « en pause » dédié. On s'appuie donc sur
 * un invariant du planificateur (voir `queueDueTouches` : il ne sélectionne
 * que les inscriptions dont `next_touch_at` N'EST PAS null). `touch.ts` le
 * garantit dans l'autre sens : une inscription « active » a TOUJOURS une date
 * de prochain barreau — sinon elle est close. L'état « actif + next_touch_at
 * null » n'existe donc jamais naturellement : c'est notre marqueur de pause,
 * confirmé par `end_reason = 'paused_by_admin'` pour le distinguer sans
 * ambiguïté (une inscription close pose `ended_at`, jamais une pause).
 */

export { PAUSED_REASON, REMOVED_REASON } from "@/lib/campaigns/enrollment-status";

type EnrollmentRow = typeof campaignEnrollments.$inferSelect;

export type EnrollmentActionError =
  | "not_found"
  | "not_in_flight"
  | "already_paused"
  | "not_paused"
  // La relance a ses propres refus — ceux de la campagne comme ceux de la
  // personne. Ils remontent tels quels : « action impossible » ne dit pas à
  // l'administrateur si c'est le numéro qui manque ou la personne qui a dit non.
  | ReopenGateError
  | ReopenRowRefusal;

export type EnrollmentActionResult =
  | { ok: true; clientId: string }
  | { ok: false; error: EnrollmentActionError };

/**
 * Annule ce qui est encore EN ATTENTE pour cette inscription : le réveil de
 * l'assistant (`outreach:<id>:*`) et la mise en file du barreau (`ctouch:<id>:*`).
 * Les envois déjà en file (`csend:`) ne sont pas touchés — leur barreau est
 * tracé « envoyé » et le message part dans la minute ; annuler mentirait.
 * Même logique de clé que `closeCampaignEnrollments`.
 *
 * Exporté parce que la clôture AUTOMATIQUE d'une inscription périmée
 * (`releaseCategoryMismatches`, dans `match.ts`) doit annuler exactement le
 * même travail que le retrait manuel. Deux copies de cette requête finiraient
 * par diverger, et la copie oubliée laisserait partir un barreau d'une campagne
 * dont le client vient d'être retiré.
 */
export async function cancelPendingWork(enrollmentIds: string[]): Promise<void> {
  if (enrollmentIds.length === 0) return;
  await db
    .update(scheduledJobs)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(scheduledJobs.status, "pending"),
        sql`(${scheduledJobs.dedupeKey} like 'ctouch:%' or ${scheduledJobs.dedupeKey} like 'outreach:%')`,
        sql`split_part(${scheduledJobs.dedupeKey}, ':', 2) in ${enrollmentIds}`,
      ),
    );
  await db
    .update(campaignTouches)
    .set({ status: "cancelled" })
    .where(
      and(
        inArray(campaignTouches.enrollmentId, enrollmentIds),
        eq(campaignTouches.status, "queued"),
      ),
    );
}

/** Charge l'inscription EN vérifiant qu'elle appartient bien à cette campagne (anti-IDOR). */
async function loadEnrollment(campaignId: string, enrollmentId: string): Promise<EnrollmentRow | null> {
  const e = await db.query.campaignEnrollments.findFirst({
    where: and(
      eq(campaignEnrollments.id, enrollmentId),
      eq(campaignEnrollments.campaignId, campaignId),
    ),
  });
  return e ?? null;
}

/**
 * Met une inscription en pause : elle reste inscrite mais sort de la file.
 * `next_touch_at` à null la rend invisible au planificateur ; `end_reason`
 * marque que c'est volontaire, et non une inscription close.
 */
export async function pauseEnrollment(
  campaignId: string,
  enrollmentId: string,
  now = new Date(),
): Promise<EnrollmentActionResult> {
  const e = await loadEnrollment(campaignId, enrollmentId);
  if (!e) return { ok: false, error: "not_found" };
  if (enrollmentPaused(e)) return { ok: false, error: "already_paused" };
  if (!enrollmentInFlight(e.status)) return { ok: false, error: "not_in_flight" };

  await db
    .update(campaignEnrollments)
    .set({ nextTouchAt: null, endReason: PAUSED_REASON, updatedAt: now })
    .where(eq(campaignEnrollments.id, enrollmentId));
  await cancelPendingWork([enrollmentId]);
  return { ok: true, clientId: e.clientId };
}

/**
 * Reprend une inscription en pause : le prochain barreau est reprogrammé selon
 * l'échelle (jamais avant `now` en pratique, puisqu'il était déjà dû), et le
 * marqueur de pause est effacé.
 */
export async function resumeEnrollment(
  campaignId: string,
  enrollmentId: string,
  now = new Date(),
): Promise<EnrollmentActionResult> {
  const e = await loadEnrollment(campaignId, enrollmentId);
  if (!e) return { ok: false, error: "not_found" };
  if (!enrollmentPaused(e)) return { ok: false, error: "not_paused" };

  const campaignRow = await db.query.campaigns.findFirst({
    where: eq(campaigns.id, e.campaignId),
  });
  // Sans la campagne (course improbable), on repose la date à maintenant : le
  // barreau dû repartira au prochain cycle, ou se clôturera si l'échelle est finie.
  const due = campaignRow
    ? nextTouchAt(campaignRowToConfig(campaignRow).ladder, e.step, e.enrolledAt, e.lastTouchAt)
    : now;

  await db
    .update(campaignEnrollments)
    .set({ nextTouchAt: due ?? now, endReason: null, updatedAt: now })
    .where(eq(campaignEnrollments.id, enrollmentId));
  return { ok: true, clientId: e.clientId };
}

/**
 * Retire le client de la campagne : l'inscription est close (« écartée », pas
 * « arrêtée » — un retrait par l'administrateur n'est pas un refus de la
 * personne et ne doit pas gonfler le taux d'arrêts) et le travail en attente
 * annulé. Une inscription déjà close n'est pas re-retirée.
 */
export async function removeEnrollment(
  campaignId: string,
  enrollmentId: string,
  now = new Date(),
): Promise<EnrollmentActionResult> {
  const e = await loadEnrollment(campaignId, enrollmentId);
  if (!e) return { ok: false, error: "not_found" };
  if (!enrollmentInFlight(e.status)) return { ok: false, error: "not_in_flight" };

  await db
    .update(campaignEnrollments)
    .set({
      status: "excluded",
      endReason: REMOVED_REASON,
      endedAt: now,
      nextTouchAt: null,
      updatedAt: now,
    })
    .where(eq(campaignEnrollments.id, enrollmentId));
  await cancelPendingWork([enrollmentId]);
  return { ok: true, clientId: e.clientId };
}

/**
 * Relance UNE inscription terminée. Le travail est fait par le module de
 * relance — même lecture, mêmes refus, même étalement que le geste en lot :
 * une deuxième implémentation « pour un cas simple » finirait par autoriser
 * ici ce que l'autre refuse.
 */
export async function reopenEnrollment(
  campaignId: string,
  enrollmentId: string,
  now = new Date(),
): Promise<EnrollmentActionResult> {
  const result = await reopenEnrollments(campaignId, { enrollmentIds: [enrollmentId], now });
  if (!result.ok) return { ok: false, error: result.error };
  const [reopened] = result.planned;
  if (reopened) return { ok: true, clientId: reopened.clientId };
  // Un seul candidat : le rapport ne contient qu'un motif, et c'est le sien.
  const [refusal] = Object.keys(result.refused) as ReopenRowRefusal[];
  return { ok: false, error: refusal ?? "not_found" };
}

export type EnrollmentAction = "pause" | "resume" | "remove" | "reopen";

/** Aiguillage unique — le point d'entrée de la route. */
export async function applyEnrollmentAction(
  campaignId: string,
  enrollmentId: string,
  action: EnrollmentAction,
  now = new Date(),
): Promise<EnrollmentActionResult> {
  switch (action) {
    case "pause":
      return pauseEnrollment(campaignId, enrollmentId, now);
    case "resume":
      return resumeEnrollment(campaignId, enrollmentId, now);
    case "remove":
      return removeEnrollment(campaignId, enrollmentId, now);
    case "reopen":
      return reopenEnrollment(campaignId, enrollmentId, now);
  }
}
