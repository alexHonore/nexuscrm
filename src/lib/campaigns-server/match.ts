import "server-only";
import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { campaignEnrollments, campaigns } from "@/db/schema-sms";
import { runAfterResponse } from "@/lib/after-response";
import { logAudit } from "@/lib/audit";
import { enqueueJob } from "@/lib/jobs/queue";
import { campaignRowToConfig } from "@/lib/campaigns/schema";
import { settingsSendGate } from "@/lib/sms-server";
import { audienceWhere } from "./audience";
import { audienceClientIds, enrollClients } from "./enroll";

/**
 * Quelles campagnes réclament ce lead, et la mise en file des barreaux.
 *
 * Appelé APRÈS la réponse du webhook (Next 16 `after()`) : un lead entrant ne
 * doit pas attendre que le moteur de campagnes ait fini pour recevoir son 200.
 * n8n renverrait le lead en pensant à un échec, et on aurait deux clients.
 */

/**
 * Inscrit un client fraîchement créé dans toutes les campagnes actives dont le
 * déclencheur est `lead_created` et dont l'audience le retient.
 */
export async function matchCampaigns(
  clientId: string,
  opts: { now?: Date; kind?: "lead_created" | "category_changed" } = {},
): Promise<{ campaignId: string; enrolled: boolean; refusal?: string }[]> {
  const now = opts.now ?? new Date();
  const kind = opts.kind ?? "lead_created";

  const active = await db
    .select()
    .from(campaigns)
    .where(
      and(
        eq(campaigns.status, "active"),
        sql`${campaigns.trigger}->>'kind' = ${kind}`,
      ),
    );
  if (active.length === 0) return [];

  const out: { campaignId: string; enrolled: boolean; refusal?: string }[] = [];

  for (const row of active) {
    const config = campaignRowToConfig(row);

    // Le client passe-t-il l'audience ET le filtre du déclencheur? On repose la
    // question en SQL plutôt que de la reconstruire en mémoire : c'est la même
    // requête que l'aperçu, donc le même résultat.
    const [match] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(
        and(
          eq(clients.id, clientId),
          audienceWhere(config.audience, config.trigger, now, {
            campaignId: row.id,
            requireConsent: config.requireConsent,
          }),
        ),
      )
      .limit(1);

    if (!match) {
      out.push({ campaignId: row.id, enrolled: false, refusal: "audience_miss" });
      continue;
    }

    const [result] = await enrollClients(row.id, [clientId], { now });
    out.push({
      campaignId: row.id,
      enrolled: result?.enrolled ?? false,
      refusal: result?.refusal,
    });
    if (result?.enrolled && result.enrollmentId) {
      await queueTouch(result.enrollmentId, now);
    }
  }

  return out;
}

export interface CategoryChange {
  clientId: string;
  from: number | null;
  to: number | null;
}

/**
 * LE point d'entrée du déclencheur « changement de catégorie ».
 *
 * Dans ce CRM, les boutons d'après-appel SONT le pipeline : classer un appel
 * « chaud » déplace la fiche. Le déclencheur n'était branché que sur la liste
 * déroulante de l'en-tête — le chemin principal (la disposition), les actions
 * en masse et les réservations changeaient la catégorie sans que personne ne
 * soit inscrit. Tout chemin qui écrit `clients.categoryId` passe par ici.
 *
 * Le travail part APRÈS la réponse : l'écran ne doit pas attendre l'évaluation
 * des audiences. Seuls les vrais changements comptent — réenregistrer la même
 * catégorie ne relance rien, et retirer la catégorie (null) n'est pas une
 * « arrivée » quelque part. Une campagne qui échoue ne fait pas échouer la
 * réponse déjà envoyée (garanti par `runAfterResponse`).
 */
export function notifyCategoryChanges(changes: CategoryChange[]): void {
  const real = changes.filter((c) => c.to !== null && c.from !== c.to);
  if (real.length === 0) return;

  runAfterResponse(async () => {
    for (const change of real) {
      const matches = await matchCampaigns(change.clientId, { kind: "category_changed" });
      const enrolled = matches.filter((m) => m.enrolled);
      if (enrolled.length === 0) continue;
      await logAudit({
        userId: null,
        action: "campaign.enroll",
        entity: "client",
        entityId: change.clientId,
        detail: {
          campaignIds: enrolled.map((m) => m.campaignId),
          via: "category_changed",
          from: change.from,
          to: change.to,
        },
      });
    }
  });
}

export function notifyCategoryChanged(clientId: string, from: number | null, to: number | null): void {
  notifyCategoryChanges([{ clientId, from, to }]);
}

/**
 * Balayage d'une campagne `scheduled` : prend les prochains clients de
 * l'audience, dans la limite du plafond quotidien restant.
 */
export async function sweepCampaign(
  campaignId: string,
  opts: { now?: Date; limit?: number } = {},
): Promise<{ considered: number; enrolled: number; refusals: Record<string, number> }> {
  const now = opts.now ?? new Date();
  const row = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaignId) });
  if (!row) throw new Error("campaign_not_found");
  const config = campaignRowToConfig(row);

  // On ne demande jamais plus que le plafond du jour : ramener 5 000 lignes
  // pour en refuser 4 950 coûte une requête inutile à chaque balayage.
  const limit = Math.min(opts.limit ?? config.dailyEnrollmentCap, config.dailyEnrollmentCap);
  const candidates = await audienceClientIds(campaignId, limit, now);
  if (candidates.length === 0) {
    // Un balayage qui n'inscrit personne compte quand même comme un balayage :
    // sinon l'intervalle ne s'écoule jamais et la campagne rebalaie à chaque
    // cycle, pour rien.
    await db.update(campaigns).set({ lastSweptAt: now }).where(eq(campaigns.id, campaignId));
    return { considered: 0, enrolled: 0, refusals: {} };
  }

  const results = await enrollClients(campaignId, candidates, { now });
  await db
    .update(campaigns)
    .set({ lastSweptAt: now })
    .where(eq(campaigns.id, campaignId));
  const refusals: Record<string, number> = {};
  let enrolled = 0;

  for (const result of results) {
    if (result.enrolled && result.enrollmentId) {
      enrolled += 1;
      await queueTouch(result.enrollmentId, now);
    } else if (result.refusal) {
      refusals[result.refusal] = (refusals[result.refusal] ?? 0) + 1;
    }
  }

  return { considered: candidates.length, enrolled, refusals };
}

/** Met le prochain barreau en file. La clé de dédoublonnage porte le barreau. */
export async function queueTouch(enrollmentId: string, runAt: Date): Promise<void> {
  const enrollment = await db.query.campaignEnrollments.findFirst({
    where: eq(campaignEnrollments.id, enrollmentId),
  });
  if (!enrollment || enrollment.nextTouchAt === null) return;

  await enqueueJob({
    type: "campaign_touch",
    runAt: enrollment.nextTouchAt > runAt ? enrollment.nextTouchAt : runAt,
    payload: { enrollmentId },
    // Le barreau est dans la clé : mettre en file le barreau 2 ne peut pas
    // absorber le barreau 1 encore en attente, et rejouer le même barreau ne
    // crée pas un deuxième job. Le préfixe `ctouch:` sépare CE job de l'envoi
    // qu'il produira (`csend:`) — une clé partagée ferait absorber l'envoi par
    // le job encore vivant qui l'a demandé.
    dedupeKey: `ctouch:${enrollmentId}:${enrollment.step}`,
  });
}

/**
 * Met en file tous les barreaux dus — appelé par le cycle de dispatch.
 *
 * Sous interrupteur d'arrêt, on ne met RIEN en file : chaque barreau serait
 * refusé à l'exécution et repoussé, pour rien. Les inscriptions restent dues
 * (`next_touch_at` inchangé) et repartent au cycle qui suit la levée de
 * l'interrupteur — c'est un report, pas une perte.
 */
export async function queueDueTouches(limit: number, now = new Date()): Promise<number> {
  if (!(await settingsSendGate.isSendingAllowed())) return 0;

  const rows = await db
    .select({ id: campaignEnrollments.id, step: campaignEnrollments.step })
    .from(campaignEnrollments)
    .innerJoin(campaigns, eq(campaigns.id, campaignEnrollments.campaignId))
    .where(
      and(
        inArray(campaignEnrollments.status, ["pending", "active"]),
        eq(campaigns.status, "active"),
        isNotNull(campaignEnrollments.nextTouchAt),
        // `lte` et non un `sql` brut : dans un template, la Date part sans type.
        lte(campaignEnrollments.nextTouchAt, now),
      ),
    )
    .orderBy(campaignEnrollments.nextTouchAt)
    .limit(limit);

  for (const row of rows) {
    await enqueueJob({
      type: "campaign_touch",
      runAt: now,
      payload: { enrollmentId: row.id },
      dedupeKey: `ctouch:${row.id}:${row.step}`,
    });
  }
  return rows.length;
}

/**
 * Balaie les campagnes `scheduled` dont l'intervalle est écoulé.
 *
 * Sans cet appel, le déclencheur « balayage périodique » serait sélectionnable
 * à l'écran et n'inscrirait JAMAIS personne : une campagne d'apparence vivante
 * qui ne fait rien, et rien pour le dire.
 *
 * Sous interrupteur d'arrêt, aucun balayage : inscrire des gens pendant un
 * incident, c'est empiler des barreaux qui partiraient tous d'un coup à la
 * levée. L'intervalle n'avance pas, le balayage reprend au cycle suivant.
 */
export async function sweepDueCampaigns(
  now = new Date(),
): Promise<{ campaignId: string; enrolled: number }[]> {
  if (!(await settingsSendGate.isSendingAllowed())) return [];

  const rows = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.status, "active"), sql`${campaigns.trigger}->>'kind' = 'scheduled'`));

  const out: { campaignId: string; enrolled: number }[] = [];
  for (const row of rows) {
    const config = campaignRowToConfig(row);
    if (config.trigger.kind !== "scheduled") continue;

    const dueAt =
      row.lastSweptAt === null
        ? now
        : new Date(row.lastSweptAt.getTime() + config.trigger.everyHours * 60 * 60 * 1000);
    if (dueAt > now) continue;

    try {
      const result = await sweepCampaign(row.id, { now });
      out.push({ campaignId: row.id, enrolled: result.enrolled });
      // Un balayage qui considère des gens et n'inscrit personne est la panne
      // la plus silencieuse du déclencheur : on le dit dans les journaux.
      if (result.considered > 0 && result.enrolled === 0) {
        console.warn(
          JSON.stringify({
            at: "campaigns/sweep",
            event: "sweep_enrolled_nobody",
            campaignId: row.id,
            considered: result.considered,
            refusals: result.refusals,
          }),
        );
      }
    } catch (err) {
      // Une campagne mal configurée ne doit pas empêcher les autres de tourner.
      console.error(
        JSON.stringify({
          at: "campaigns/sweep",
          event: "sweep_failed",
          campaignId: row.id,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  return out;
}
