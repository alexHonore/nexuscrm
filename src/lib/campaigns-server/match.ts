import "server-only";
import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { campaignEnrollments, campaigns } from "@/db/schema-sms";
import { enqueueJob } from "@/lib/jobs/queue";
import { campaignRowToConfig } from "@/lib/campaigns/schema";
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
          audienceWhere(config.audience, config.trigger, now, { campaignId: row.id }),
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
  if (candidates.length === 0) return { considered: 0, enrolled: 0, refusals: {} };

  const results = await enrollClients(campaignId, candidates, { now });
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
    // crée pas un deuxième job.
    dedupeKey: `touch:${enrollmentId}:${enrollment.step}`,
  });
}

/** Met en file tous les barreaux dus — appelé par le cycle de dispatch. */
export async function queueDueTouches(limit: number, now = new Date()): Promise<number> {
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
      dedupeKey: `touch:${row.id}:${row.step}`,
    });
  }
  return rows.length;
}
