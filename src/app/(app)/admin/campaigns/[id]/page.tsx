import { asc, desc, eq, sql } from "drizzle-orm";
import { notFound } from "next/navigation";
import { CampaignEditor } from "@/components/admin/campaign-editor";
import type { CampaignEditorData, EnrollmentRow } from "@/components/admin/campaign-editor/types";
import { db } from "@/db";
import { categories, clients, sources, users } from "@/db/schema";
import { assistants, campaignEnrollments, campaigns, smsNumbers } from "@/db/schema-sms";
import { requireAdmin } from "@/lib/auth/guards";
import { countReopenCandidates } from "@/lib/campaigns-server/reopen";
import { campaignRowToConfig } from "@/lib/campaigns/schema";

export default async function CampaignEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  // Un identifiant qui n'est pas un uuid donnait une erreur Postgres (500)
  // au lieu d'une page introuvable.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();

  const row = await db.query.campaigns.findFirst({ where: eq(campaigns.id, id) });
  if (!row) notFound();
  const config = campaignRowToConfig(row);

  const [
    assistantRows,
    numberRows,
    categoryRows,
    sourceRows,
    userRows,
    enrollmentRows,
    statRows,
    reopenableCount,
  ] = await Promise.all([
      db
        .select({ id: assistants.id, name: assistants.name, status: assistants.status })
        .from(assistants)
        .where(sql`${assistants.status} <> 'archived'`)
        .orderBy(asc(assistants.name)),
      db
        .select({ id: smsNumbers.id, e164: smsNumbers.e164, label: smsNumbers.label })
        .from(smsNumbers)
        .where(eq(smsNumbers.active, true)),
      db
        .select({ id: categories.id, name: categories.nameFr })
        .from(categories)
        .orderBy(asc(categories.sortOrder)),
      db.select({ id: sources.id, name: sources.name }).from(sources).orderBy(asc(sources.name)),
      db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(eq(users.isActive, true))
        .orderBy(asc(users.name)),
      db
        .select({
          id: campaignEnrollments.id,
          clientId: campaignEnrollments.clientId,
          clientName: clients.fullName,
          variant: campaignEnrollments.variant,
          status: campaignEnrollments.status,
          step: campaignEnrollments.step,
          nextTouchAt: campaignEnrollments.nextTouchAt,
          endedAt: campaignEnrollments.endedAt,
          endReason: campaignEnrollments.endReason,
        })
        .from(campaignEnrollments)
        .innerJoin(clients, eq(clients.id, campaignEnrollments.clientId))
        .where(eq(campaignEnrollments.campaignId, id))
        .orderBy(desc(campaignEnrollments.enrolledAt))
        .limit(100),
      // Résultats par variante — la seule lecture qui répond à « laquelle
      // marche? », arrêts compris.
      db
        .select({
          variant: campaignEnrollments.variant,
          enrolled: sql<number>`count(*)::int`,
          replied: sql<number>`(count(*) filter (where ${campaignEnrollments.status} = 'replied'))::int`,
          stopped: sql<number>`(count(*) filter (where ${campaignEnrollments.status} = 'stopped'))::int`,
        })
        .from(campaignEnrollments)
        .where(eq(campaignEnrollments.campaignId, id))
        .groupBy(campaignEnrollments.variant),
      // Combien d'inscriptions terminées attendent les barreaux ajoutés depuis.
      // Compté sur TOUTE la campagne, pas sur les cent lignes affichées : c'est
      // précisément ce que l'écran ne montre pas qui dort depuis des mois.
      countReopenCandidates(id, config.ladder.length),
    ]);

  const enrollments: EnrollmentRow[] = enrollmentRows.map((e) => ({
    id: e.id,
    clientId: e.clientId,
    clientName: e.clientName,
    variant: e.variant,
    status: e.status,
    step: e.step,
    nextTouchAt: e.nextTouchAt?.toISOString() ?? null,
    endedAt: e.endedAt?.toISOString() ?? null,
    endReason: e.endReason,
  }));

  const data: CampaignEditorData = {
    id: row.id,
    config,
    status: row.status,
    reopenableCount,
    assistants: assistantRows,
    numbers: numberRows,
    categories: categoryRows,
    sources: sourceRows,
    users: userRows,
    enrollments,
    variantStats: statRows,
  };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-6">
      <CampaignEditor data={data} />
    </div>
  );
}
