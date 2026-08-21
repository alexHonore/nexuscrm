import "server-only";
import { and, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { db } from "@/db";
import { clients } from "@/db/schema";
import {
  campaignEnrollments,
  campaigns,
  consents,
  conversations,
  suppressions,
} from "@/db/schema-sms";
import { campaignRowToConfig, type CampaignConfig } from "@/lib/campaigns/schema";
import {
  canEnroll,
  LIVE_CONVERSATION_WINDOW_MS,
  type EnrollFacts,
  type EnrollRefusal,
} from "@/lib/campaigns/eligibility";
import { nextTouchAt } from "@/lib/campaigns/ladder";
import { pickVariant } from "@/lib/campaigns/variants";
import { audienceWhere } from "./audience";

/**
 * Inscription à une campagne.
 *
 * L'idempotence ne repose PAS sur une vérification préalable : elle repose sur
 * l'index unique `(campaign_id, client_id)`. Deux déclencheurs simultanés sur le
 * même lead — le webhook et un balayage, par exemple — passent tous deux le
 * « déjà inscrit? », et c'est la base qui tranche. Le perdant reçoit
 * `already_enrolled` au lieu de créer une deuxième échelle de messages.
 *
 * Les faits sont rassemblés ICI, la décision est prise par le module pur
 * `eligibility` : ce partage permet d'écrire les règles une fois et de les
 * tester sans base.
 */

/** `db` ou une transaction en cours — même surface pour nos besoins. */
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface EnrollResult {
  clientId: string;
  enrolled: boolean;
  enrollmentId?: string;
  variant?: string;
  refusal?: EnrollRefusal;
}

/**
 * Minuit à Toronto, exprimé en UTC.
 *
 * Le plafond quotidien se compte sur la journée LOCALE : « 50 par jour » veut
 * dire par jour de Québec. Compter par tranche UTC ferait basculer le compteur
 * à 20 h le soir — au milieu de la plage d'envoi, pas entre deux journées.
 */
const TORONTO = "America/Toronto";

const startOfTorontoDay = (now: Date): Date =>
  fromZonedTime(`${formatInTimeZone(now, TORONTO, "yyyy-MM-dd")}T00:00:00`, TORONTO);

/** Consentement SMS valide : accordé, non révoqué, non expiré. */
async function consentedClientIds(clientIds: string[], now: Date): Promise<Set<string>> {
  if (clientIds.length === 0) return new Set();
  const rows = await db
    .select({ clientId: consents.clientId })
    .from(consents)
    .where(
      and(
        inArray(consents.clientId, clientIds),
        eq(consents.channel, "sms"),
        isNull(consents.revokedAt),
        or(isNull(consents.expiresAt), gte(consents.expiresAt, now))!,
      ),
    );
  return new Set(rows.map((r) => r.clientId));
}

async function suppressedPhones(phones: string[]): Promise<Set<string>> {
  if (phones.length === 0) return new Set();
  const rows = await db
    .select({ phone: suppressions.phoneE164 })
    .from(suppressions)
    .where(inArray(suppressions.phoneE164, phones));
  return new Set(rows.map((r) => r.phone));
}

/**
 * Numéros dont un fil a reçu un message entrant récemment — la personne est en
 * conversation avec nous (assistant ou humain). Sur N'IMPORTE QUEL numéro
 * expéditeur : c'est la personne qui est occupée, pas la ligne.
 */
async function livePhones(phones: string[], now: Date): Promise<Set<string>> {
  if (phones.length === 0) return new Set();
  const cutoff = new Date(now.getTime() - LIVE_CONVERSATION_WINDOW_MS);
  const rows = await db
    .select({ phone: conversations.clientPhone })
    .from(conversations)
    .where(
      and(inArray(conversations.clientPhone, phones), gte(conversations.lastInboundAt, cutoff)),
    );
  return new Set(rows.map((r) => r.phone));
}

async function activeElsewhere(clientIds: string[], campaignId: string): Promise<Set<string>> {
  if (clientIds.length === 0) return new Set();
  const rows = await db
    .select({ clientId: campaignEnrollments.clientId })
    .from(campaignEnrollments)
    .innerJoin(campaigns, eq(campaigns.id, campaignEnrollments.campaignId))
    .where(
      and(
        inArray(campaignEnrollments.clientId, clientIds),
        inArray(campaignEnrollments.status, ["pending", "active"]),
        // En pause compte : ces inscriptions reprendront, et deux échelles
        // écriraient alors à la même personne (voir audience.ts).
        inArray(campaigns.status, ["active", "paused"]),
        sql`${campaigns.id} <> ${campaignId}`,
      ),
    );
  return new Set(rows.map((r) => r.clientId));
}

/**
 * Inscrit une liste de clients. Retourne UNE décision par client, motif compris
 * — un appelant qui n'a qu'un compte global ne peut pas expliquer à
 * l'administrateur pourquoi 40 des 200 personnes visées n'ont rien reçu.
 */
export async function enrollClients(
  campaignId: string,
  clientIds: string[],
  opts: { now?: Date } = {},
): Promise<EnrollResult[]> {
  const now = opts.now ?? new Date();
  const row = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaignId) });
  if (!row) throw new Error("campaign_not_found");
  const config = campaignRowToConfig(row);

  if (clientIds.length === 0) return [];

  const clientRows = await db
    .select({
      id: clients.id,
      phone: clients.phone,
      doNotCall: clients.doNotCall,
    })
    .from(clients)
    .where(inArray(clients.id, clientIds));
  const byId = new Map(clientRows.map((c) => [c.id, c]));
  const phones = clientRows.map((c) => c.phone);

  const [consented, suppressed, live, elsewhere, alreadyIn, counts] = await Promise.all([
    consentedClientIds(clientIds, now),
    suppressedPhones(phones),
    livePhones(phones, now),
    config.audience.excludeActiveInOtherCampaign
      ? activeElsewhere(clientIds, campaignId)
      : Promise.resolve(new Set<string>()),
    db
      .select({ clientId: campaignEnrollments.clientId })
      .from(campaignEnrollments)
      .where(
        and(
          eq(campaignEnrollments.campaignId, campaignId),
          inArray(campaignEnrollments.clientId, clientIds),
        ),
      )
      .then((rows) => new Set(rows.map((r) => r.clientId))),
    enrollmentCounts(campaignId, now),
  ]);

  let today = counts.today;
  let total = counts.total;
  const results: EnrollResult[] = [];

  for (const clientId of clientIds) {
    const client = byId.get(clientId);
    if (!client) {
      results.push({ clientId, enrolled: false, refusal: "no_phone" });
      continue;
    }

    const facts: EnrollFacts = {
      status: row.status,
      now,
      hasPhone: client.phone.trim() !== "",
      hasValidConsent: consented.has(clientId),
      suppressed: suppressed.has(client.phone),
      doNotCall: client.doNotCall,
      alreadyEnrolled: alreadyIn.has(clientId),
      liveConversation: live.has(client.phone),
      activeInOtherCampaign: elsewhere.has(clientId),
      enrolledTodayCount: today,
      enrolledTotalCount: total,
    };

    // Première passe sur des compteurs lus une fois : écarte sans transaction
    // ce qui n'a aucune chance. La décision FINALE sur les plafonds est reprise
    // sous verrou dans `insertEnrollment`.
    const decision = canEnroll(config, facts);
    if (!decision.allowed) {
      results.push({ clientId, enrolled: false, refusal: decision.refusal });
      continue;
    }

    const written = await insertEnrollment(campaignId, clientId, config, facts, now);
    if ("refusal" in written) {
      results.push({ clientId, enrolled: false, refusal: written.refusal });
      continue;
    }

    // Les compteurs avancent au fil de la boucle : sans ça, inscrire 200
    // personnes d'un coup ignorerait le plafond quotidien puisqu'il aurait été
    // lu une seule fois, avant la première insertion.
    today += 1;
    total += 1;
    results.push({
      clientId,
      enrolled: true,
      enrollmentId: written.id,
      variant: written.variant,
    });
  }

  return results;
}

/**
 * Écrit l'inscription sous un verrou consultatif PAR CAMPAGNE.
 *
 * Sans lui, dix leads Facebook qui arrivent dans la même minute — chacun dans
 * sa propre fonction serverless — lisent tous « 45 inscrits aujourd'hui »,
 * concluent tous qu'il reste de la place sous un plafond de 50, et le plafond
 * finit à 55. Le verrou est transactionnel (`pg_advisory_xact_lock`) : il tombe
 * avec la transaction, y compris sur un pooler en mode transaction, et ne
 * sérialise que les inscriptions d'UNE campagne.
 */
async function insertEnrollment(
  campaignId: string,
  clientId: string,
  config: CampaignConfig,
  facts: EnrollFacts,
  now: Date,
): Promise<{ id: string; variant: string } | { refusal: EnrollRefusal }> {
  const variant = pickVariant(config.variants, campaignId, clientId);
  const due = nextTouchAt(config.ladder, 0, now, null);

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${campaignId}::text))`);

    // Les plafonds se relisent SOUS le verrou : c'est cette lecture-là qui fait foi.
    const counts = await enrollmentCounts(campaignId, now, tx);
    const decision = canEnroll(config, {
      ...facts,
      enrolledTodayCount: counts.today,
      enrolledTotalCount: counts.total,
    });
    if (!decision.allowed) return { refusal: decision.refusal };

    const [inserted] = await tx
      .insert(campaignEnrollments)
      .values({
        campaignId,
        clientId,
        variant,
        status: "pending",
        step: 0,
        nextTouchAt: due,
        enrolledAt: now,
      })
      .onConflictDoNothing({ target: [campaignEnrollments.campaignId, campaignEnrollments.clientId] })
      .returning({ id: campaignEnrollments.id, variant: campaignEnrollments.variant });

    // L'index unique a tranché : un autre déclencheur est passé le premier.
    return inserted ?? { refusal: "already_enrolled" };
  });
}

export async function enrollmentCounts(
  campaignId: string,
  now: Date,
  executor: Executor = db,
): Promise<{ today: number; total: number }> {
  const dayStart = startOfTorontoDay(now);
  const [row] = await executor
    .select({
      total: sql<number>`count(*)::int`,
      // Parenthèses obligatoires : `count(*) filter (…)::int` est une erreur de
      // syntaxe, le cast se rattachant à la clause FILTER et non à l'agrégat.
      // La condition passe par le constructeur drizzle et non par un paramètre
      // brut : dans un `sql` template, une Date part sans type et Postgres la
      // compare comme du texte.
      today: sql<number>`(count(*) filter (where ${gte(campaignEnrollments.enrolledAt, dayStart)}))::int`,
    })
    .from(campaignEnrollments)
    .where(eq(campaignEnrollments.campaignId, campaignId));
  return { today: row?.today ?? 0, total: row?.total ?? 0 };
}

/**
 * Combien de clients une configuration vise-t-elle aujourd'hui? Sert à
 * l'aperçu — y compris pour une configuration PAS ENCORE enregistrée : l'écran
 * d'édition recalcule ce qu'il affiche, pas ce qui dort en base.
 */
export async function audienceCountFor(
  config: CampaignConfig,
  opts: { campaignId?: string; now?: Date } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const [result] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(clients)
    .where(
      audienceWhere(config.audience, config.trigger, now, {
        campaignId: opts.campaignId,
        requireConsent: config.requireConsent,
      }),
    );
  return result?.n ?? 0;
}

/** Combien de clients l'audience ENREGISTRÉE vise-t-elle aujourd'hui? */
export async function audienceCount(campaignId: string, now = new Date()): Promise<number> {
  const row = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaignId) });
  if (!row) throw new Error("campaign_not_found");
  return audienceCountFor(campaignRowToConfig(row), { campaignId, now });
}

/** Les clients que l'audience vise, plafonnés — pour un balayage ou un envoi manuel. */
export async function audienceClientIds(
  campaignId: string,
  limit: number,
  now = new Date(),
): Promise<string[]> {
  const row = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaignId) });
  if (!row) throw new Error("campaign_not_found");
  const config = campaignRowToConfig(row);
  const rows = await db
    .select({ id: clients.id })
    .from(clients)
    .where(
      audienceWhere(config.audience, config.trigger, now, {
        campaignId,
        requireConsent: config.requireConsent,
      }),
    )
    // Les plus anciens d'abord : une réactivation doit commencer par les leads
    // qui dorment depuis le plus longtemps, pas par les derniers arrivés.
    .orderBy(clients.createdAt)
    .limit(limit);
  return rows.map((r) => r.id);
}
