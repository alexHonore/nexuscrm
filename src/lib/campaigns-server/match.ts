import "server-only";
import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { campaignEnrollments, campaigns } from "@/db/schema-sms";
import { runAfterResponse } from "@/lib/after-response";
import { logAudit } from "@/lib/audit";
import { enqueueJob } from "@/lib/jobs/queue";
import { campaignRowToConfig } from "@/lib/campaigns/schema";
import { targetsCategory } from "@/lib/campaigns/eligibility";
import { LEFT_AUDIENCE_REASON } from "@/lib/campaigns/enrollment-status";
import { settingsSendGate } from "@/lib/sms-server";
import { audienceWhere } from "./audience";
import { audienceClientIds, enrollClients } from "./enroll";
import { cancelPendingWork } from "./enrollment-admin";

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

export interface ReleasedEnrollment {
  enrollmentId: string;
  campaignId: string;
  clientId: string;
}

/**
 * Taille des tranches de libération, et plafond de la ré-inscription en masse.
 * Voir `applyCategoryChanges` : libérer est bon marché et doit TOUJOURS passer,
 * inscrire coûte par fiche et se refuse franchement plutôt que d'expirer.
 */
const RELEASE_CHUNK = 500;
const MAX_ENROLL_FANOUT = 500;

/**
 * Clôt les inscriptions EN VOL dont la campagne ne vise plus la catégorie du
 * client.
 *
 * C'est la moitié qui manquait. Le déclencheur savait faire ENTRER une fiche
 * dans une campagne quand elle arrivait dans la bonne catégorie ; rien ne l'en
 * faisait SORTIR quand elle la quittait. La fiche restait affichée comme
 * inscrite à une campagne qui ne la visait plus, et son échelle continuait de
 * lui écrire.
 *
 * Pire : tant que cette inscription périmée reste `pending`/`active`, elle
 * BLOQUE la nouvelle. `audience.excludeActiveInOtherCampaign` vaut `true` par
 * défaut, et le client est alors refusé partout ailleurs (« active_elsewhere »,
 * et même avant ça par le `not exists` de `audienceConditions`). C'est pourquoi
 * la clôture doit être TERMINÉE avant que `matchCampaigns` ne soit appelé — pas
 * seulement lancée.
 *
 * On part des INSCRIPTIONS du client, pas des campagnes déclenchables : une
 * inscription périmée peut très bien appartenir à une campagne `manual`,
 * `scheduled` ou `lead_created`, qu'un balayage sur `trigger = category_changed`
 * ne regarderait jamais.
 *
 * Le statut de la CAMPAGNE n'entre volontairement pas en ligne de compte. Une
 * campagne en pause reprendra, et son inscription périmée bloque déjà les
 * autres entre-temps. Une campagne remise en brouillon garde elle aussi ses
 * inscriptions en vol — elles s'affichent toujours sur la fiche, et à la
 * réactivation le barreau partirait sans que rien ne revérifie l'audience
 * (`canSendTouch` est aveugle à l'audience, exprès). Les laisser serait donc
 * garder une promesse d'envoi qu'on sait déjà mauvaise.
 */
export async function releaseCategoryMismatches(
  targets: readonly { clientId: string; to: number | null }[],
  now = new Date(),
): Promise<ReleasedEnrollment[]> {
  // La DERNIÈRE catégorie annoncée pour une fiche fait foi : un lot peut
  // contenir deux mouvements de la même fiche.
  const wanted = new Map(targets.map((t) => [t.clientId, t.to]));
  const clientIds = [...wanted.keys()];
  if (clientIds.length === 0) return [];

  const candidates = new Map<string, ReleasedEnrollment>();

  // Par tranches : un transfert de catégorie porte sur TOUTE une catégorie —
  // des milliers de fiches sur cette base. Un `in (…)` de dix mille valeurs
  // fait une requête que Postgres planifie mal, et une par fiche ferait dix
  // mille allers-retours après la réponse : la fonction expirerait à
  // mi-chemin, moitié des fiches libérées, sans que rien ne le dise.
  for (let i = 0; i < clientIds.length; i += RELEASE_CHUNK) {
    const chunk = clientIds.slice(i, i + RELEASE_CHUNK);
    const rows = await db
      .select({ enrollment: campaignEnrollments, campaign: campaigns })
      .from(campaignEnrollments)
      .innerJoin(campaigns, eq(campaigns.id, campaignEnrollments.campaignId))
      .where(
        and(
          inArray(campaignEnrollments.clientId, chunk),
          inArray(campaignEnrollments.status, ["pending", "active"]),
        ),
      );

    for (const row of rows) {
      // Une campagne mal formée ne doit pas empêcher de libérer les autres :
      // sans ce garde-fou, une config que zod refuse ferait échouer TOUT le
      // changement de catégorie.
      let stillTargeted: boolean;
      try {
        stillTargeted = targetsCategory(
          campaignRowToConfig(row.campaign),
          wanted.get(row.enrollment.clientId) ?? null,
        );
      } catch {
        continue;
      }
      if (stillTargeted) continue;

      candidates.set(row.enrollment.id, {
        enrollmentId: row.enrollment.id,
        campaignId: row.campaign.id,
        clientId: row.enrollment.clientId,
      });
    }
  }

  const ids = [...candidates.keys()];
  const released: ReleasedEnrollment[] = [];

  for (let i = 0; i < ids.length; i += RELEASE_CHUNK) {
    const chunk = ids.slice(i, i + RELEASE_CHUNK);
    const closed = await db
      .update(campaignEnrollments)
      .set({
        status: "excluded",
        endReason: LEFT_AUDIENCE_REASON,
        endedAt: now,
        nextTouchAt: null,
        updatedAt: now,
      })
      .where(
        and(
          inArray(campaignEnrollments.id, chunk),
          // Le statut est REPRIS ici, et pas seulement au SELECT : entre les
          // deux, la personne a pu répondre, prendre rendez-vous ou se
          // désabonner. Sans cette reprise, la libération écraserait le motif
          // qui compte vraiment — un refus ferme deviendrait une sortie
          // d'audience, et le taux d'arrêts perdrait sa ligne.
          inArray(campaignEnrollments.status, ["pending", "active"]),
        ),
      )
      .returning({ id: campaignEnrollments.id });

    // Ce qui est JOURNALISÉ est ce qui a réellement été écrit : annoncer une
    // libération qui n'a pas eu lieu enverrait chercher une cause inexistante.
    for (const row of closed) {
      const entry = candidates.get(row.id);
      if (entry) released.push(entry);
    }
    // Le barreau déjà en file partirait sinon quelques minutes après le
    // retrait : le message d'une campagne dont la fiche vient de sortir.
    await cancelPendingWork(closed.map((r) => r.id));
  }

  return released;
}

/**
 * L'effet COMPLET d'un changement de catégorie sur les campagnes des fiches.
 *
 * Un changement de catégorie en a deux, et longtemps un seul était écrit :
 *
 *  1. **Libérer** les inscriptions que la nouvelle catégorie périme. Retirer sa
 *     catégorie à une fiche (`to === null`) en fait partie : elle n'est plus
 *     « dans l'une de ces catégories », où que ce soit.
 *  2. **Inscrire** dans les campagnes que la nouvelle catégorie réclame — et
 *     `null` n'est une arrivée nulle part, donc cette moitié-là ne s'applique
 *     pas.
 *
 * L'ORDRE est la moitié du correctif, pas un détail de style : tant que
 * l'ancienne inscription est en vol, `excludeActiveInOtherCampaign` (vrai par
 * défaut) refuse la nouvelle avec « active_elsewhere ». Les lancer en parallèle
 * — deux `runAfterResponse` distincts, par exemple — reproduirait le symptôme
 * exact qu'on corrige : la fiche accrochée à l'ancienne campagne, absente de la
 * nouvelle. D'où la libération de TOUT le lot, awaitée, avant la moindre
 * inscription.
 *
 * Les deux moitiés ne coûtent pas la même chose. Libérer se fait en lot, à
 * quelques requêtes quel que soit le nombre de fiches. Inscrire est
 * irréductiblement par fiche (audience, plafonds, verrou par campagne) : au-delà
 * de `MAX_ENROLL_FANOUT`, on ne le tente pas. Libérer des milliers de fiches
 * reste juste ; en inscrire des milliers d'un seul geste ne l'est pas, et la
 * fonction expirerait de toute façon à mi-parcours. L'administrateur garde
 * « Inscrire l'audience » dans l'éditeur pour le faire délibérément.
 */
export async function applyCategoryChanges(changes: readonly CategoryChange[]): Promise<void> {
  if (changes.length === 0) return;

  // Une entrée de journal PAR FICHE : « 400 inscriptions libérées » ne dit pas
  // à qui, et c'est la seule question qu'on se posera en relisant.
  const releasedByClient = new Map<string, string[]>();
  for (const r of await releaseCategoryMismatches(changes)) {
    releasedByClient.set(r.clientId, [...(releasedByClient.get(r.clientId) ?? []), r.campaignId]);
  }
  for (const change of changes) {
    const campaignIds = releasedByClient.get(change.clientId);
    if (!campaignIds) continue;
    await logAudit({
      userId: null,
      action: "campaign.release",
      entity: "client",
      entityId: change.clientId,
      detail: {
        campaignIds,
        via: "category_changed",
        reason: LEFT_AUDIENCE_REASON,
        from: change.from,
        to: change.to,
      },
    });
  }

  // Retirer la catégorie n'est une arrivée nulle part : rien à inscrire.
  const arrivals = changes.filter((c) => c.to !== null);
  if (arrivals.length === 0) return;
  if (arrivals.length > MAX_ENROLL_FANOUT) {
    // Dit, jamais tu : sans cette ligne, « rien n'est parti » ressemblerait à
    // une campagne mal configurée plutôt qu'à un plafond volontaire.
    console.warn(
      JSON.stringify({
        at: "campaigns/match",
        event: "enroll_fanout_skipped",
        changed: arrivals.length,
        limit: MAX_ENROLL_FANOUT,
      }),
    );
    return;
  }

  for (const change of arrivals) {
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
 * des audiences. Une campagne qui échoue ne fait pas échouer la réponse déjà
 * envoyée (garanti par `runAfterResponse`).
 *
 * Seuls les VRAIS changements comptent — réenregistrer la même catégorie ne
 * relance rien. En revanche `to === null` n'est plus écarté ici : retirer sa
 * catégorie à une fiche n'inscrit nulle part, mais doit la libérer de ce qui ne
 * la vise plus. C'est `applyCategoryChange` qui fait ce tri.
 */
export function notifyCategoryChanges(changes: CategoryChange[]): void {
  const real = changes.filter((c) => c.from !== c.to);
  if (real.length === 0) return;

  runAfterResponse(() => applyCategoryChanges(real));
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
