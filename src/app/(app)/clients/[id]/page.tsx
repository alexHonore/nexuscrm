import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";
import { enUS, fr } from "date-fns/locale";
import { HistoryIcon } from "lucide-react";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@/db";
import { auditLogs, categories, sources, users } from "@/db/schema";
import { messages, smsNumbers } from "@/db/schema-sms";
import { requireUser } from "@/lib/auth/guards";
import { dispositionDisplayMap } from "@/lib/dispositions";
import { APP_TZ } from "@/components/clients/timezone";
import { ClientHeader } from "@/components/clients/client-header";
import { ClientHistory } from "@/components/clients/client-history";
import { ClientInfoForm } from "@/components/clients/client-info-form";
import { ClientSwitcher } from "@/components/clients/client-switcher";
import { CommentsTimeline } from "@/components/clients/comments-timeline";
import { DeleteClientButton } from "@/components/clients/delete-client-button";
import { FollowupsCard } from "@/components/clients/followups-card";
import { SmsThreadCard, type SmsThreadData } from "@/components/clients/sms-thread-card";
import { readSmsConsent } from "@/lib/sms-server/consent-state";
import type { FilterOption } from "@/components/clients/clients-filters";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const t = await getTranslations("clients");
  const locale = await getLocale();
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const client = await db.query.clients.findFirst({
    where: (c, { eq: eqOp }) => eqOp(c.id, id),
    with: {
      createdBy: { columns: { name: true } },
      calls: { with: { user: true }, orderBy: (c) => [desc(c.startedAt)], limit: 100 },
      appointments: { with: { user: true }, orderBy: (a) => [desc(a.startsAt)], limit: 100 },
      comments: { with: { user: true }, orderBy: (c) => [asc(c.createdAt)], limit: 200 },
      followups: { orderBy: (f) => [asc(f.dueAt)] },
    },
  });
  if (!client) notFound();

  // ── Fil SMS ────────────────────────────────────────────────────────────────
  // Chargé à part de la requête relationnelle du client : `conversations` est
  // liée par (téléphone, numéro) et non par une clé étrangère simple, et le fil
  // doit exister même quand aucune conversation n'a encore été créée.
  const thread = client.phone
    ? await db.query.conversations.findFirst({
        where: (c, { eq: eqOp }) => eqOp(c.clientId, client.id),
        with: { pausedBy: { columns: { name: true } } },
      })
    : undefined;

  const [threadMessages, suppressedRow, activeNumber, consent] = await Promise.all([
    thread
      ? db
          .select({
            id: messages.id,
            direction: messages.direction,
            body: messages.body,
            createdAt: messages.createdAt,
            status: messages.status,
            errorCode: messages.errorCode,
            source: messages.source,
            aiGenerated: messages.aiGenerated,
            sentByName: users.name,
          })
          .from(messages)
          .leftJoin(users, eq(users.id, messages.sentById))
          .where(eq(messages.conversationId, thread.id))
          .orderBy(asc(messages.createdAt))
          .limit(200)
      : Promise.resolve([]),
    client.phone
      ? db.query.suppressions.findFirst({
          where: (sup, { eq: eqOp }) => eqOp(sup.phoneE164, client.phone),
        })
      : Promise.resolve(undefined),
    db.query.smsNumbers.findFirst({ where: eq(smsNumbers.active, true) }),
    readSmsConsent(client.id),
  ]);

  const smsThread: SmsThreadData = {
    conversationId: thread?.id ?? null,
    clientName: client.fullName,
    clientPhone: client.phone,
    aiEnabled: thread?.aiEnabled ?? true,
    pausedByName: thread?.pausedBy?.name ?? null,
    pausedAt: thread?.pausedAt?.toISOString() ?? null,
    pauseReason: thread?.pauseReason ?? null,
    needsAttention: thread?.needsAttention ?? false,
    attentionReason: thread?.attentionReason ?? null,
    suppressed: suppressedRow !== undefined,
    hasActiveNumber: activeNumber !== undefined,
    consent,
    messages: threadMessages.map((m) => ({
      id: m.id,
      direction: m.direction,
      body: m.body,
      createdAt: m.createdAt.toISOString(),
      status: m.status,
      errorCode: m.errorCode,
      source: m.source,
      aiGenerated: m.aiGenerated,
      sentByName: m.sentByName,
    })),
  };

  const [allCategories, allSources, activeUsers, lastEditRows] = await Promise.all([
    db.query.categories.findMany({ orderBy: [asc(categories.sortOrder), asc(categories.id)] }),
    db.query.sources.findMany({ orderBy: [asc(sources.name)] }),
    db.query.users.findMany({ where: eq(users.isActive, true), orderBy: [asc(users.name)] }),
    // « Modifiée par qui » : le schéma ne stocke pas d'updatedById — la
    // dernière écriture HUMAINE vient du journal d'audit (les mises à jour
    // système, ex. recalcul de relance, n'y figurent pas : c'est voulu).
    db
      .select({ at: auditLogs.createdAt, userName: users.name })
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.userId, users.id))
      .where(
        and(
          eq(auditLogs.entity, "client"),
          eq(auditLogs.entityId, id),
          inArray(auditLogs.action, ["client.update", "client.category", "client.assign"]),
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(1),
  ]);

  // Libellés/couleurs des dispositions (statuts du pipeline) pour l'historique.
  const dispoDisplay = dispositionDisplayMap(allCategories, locale);
  const lastEdit = lastEditRows[0] ?? null;

  const sourceOptions: FilterOption[] = allSources.map((s) => ({
    value: String(s.id),
    label: s.name,
  }));
  const userOptions: FilterOption[] = activeUsers.map((u) => ({ value: u.id, label: u.name }));

  // ── « Créée le … par … / Modifiée le … par … » ────────────────────────────
  const dfnsLocale = locale === "en" ? enUS : fr;
  const metaDate = (d: Date) =>
    formatInTimeZone(d, APP_TZ, "d MMM yyyy, HH:mm", { locale: dfnsLocale });

  const createdLine = client.createdBy?.name
    ? t("meta.createdBy", { date: metaDate(client.createdAt), name: client.createdBy.name })
    : t("meta.created", { date: metaDate(client.createdAt) });

  // Priorité au journal d'audit (il porte l'auteur) ; sinon updatedAt seul, et
  // rien du tout si la fiche n'a jamais bougé depuis sa création (± 1 min).
  const updatedLine = lastEdit
    ? lastEdit.userName
      ? t("meta.updatedBy", { date: metaDate(lastEdit.at), name: lastEdit.userName })
      : t("meta.updated", { date: metaDate(lastEdit.at) })
    : client.updatedAt.getTime() - client.createdAt.getTime() > 60_000
      ? t("meta.updated", { date: metaDate(client.updatedAt) })
      : null;

  // Followups: open first (asc dueAt), then done (most recent first).
  const followupsSorted = [
    ...client.followups.filter((f) => !f.doneAt),
    ...client.followups
      .filter((f) => f.doneAt)
      .sort((a, b) => (b.doneAt?.getTime() ?? 0) - (a.doneAt?.getTime() ?? 0)),
  ];

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 px-4 py-3 md:px-6 md:py-4">
      {/* Quick switching in the panel's filtered order + back button on mobile */}
      <div className="flex items-center gap-2">
        <ClientSwitcher clientId={client.id} />
        {user.role === "admin" ? (
          <DeleteClientButton clientId={client.id} clientName={client.fullName} />
        ) : null}
      </div>

      <ClientHeader
        client={{
          id: client.id,
          fullName: client.fullName,
          phone: client.phone,
          email: client.email,
          city: client.city,
          doNotCall: client.doNotCall,
          categoryId: client.categoryId,
        }}
        categories={allCategories.map((c) => ({
          id: c.id,
          nameFr: c.nameFr,
          nameEn: c.nameEn,
          color: c.color,
        }))}
      />

      {/* Container queries: the working area is squeezed by the list panel, so
          columns depend on the available width, not the viewport. */}
      <div className="@container">
        <div className="grid items-start gap-4 @3xl:grid-cols-3 md:gap-5">
          {/* Follow-ups + comments first when stacked — the caller's workspace */}
          <div className="order-1 space-y-4 @3xl:order-2 @3xl:col-span-1 md:space-y-5">
            <FollowupsCard
              clientId={client.id}
              followups={followupsSorted.map((f) => ({
                id: f.id,
                dueAt: f.dueAt.toISOString(),
                note: f.note,
                doneAt: f.doneAt?.toISOString() ?? null,
                overdue: !f.doneAt && f.dueAt < new Date(),
              }))}
            />
            <CommentsTimeline
              clientId={client.id}
              comments={client.comments.map((c) => ({
                id: c.id,
                body: c.body,
                createdAt: c.createdAt.toISOString(),
                author: { id: c.userId, name: c.user?.name ?? "—" },
              }))}
            />
            {/* Sous les commentaires : le fil SMS fait partie de l'espace de
                travail du téléphoniste, au même titre que ses relances. */}
            <SmsThreadCard clientId={client.id} thread={smsThread} />
          </div>

          <div className="order-2 space-y-4 @3xl:order-1 @3xl:col-span-2 md:space-y-5">
            <ClientInfoForm
              client={{
                id: client.id,
                fullName: client.fullName,
                phone: client.phone,
                phoneAlt: client.phoneAlt,
                email: client.email,
                language: client.language,
                city: client.city,
                address: client.address,
                projectType: client.projectType,
                timing: client.timing,
                budget: client.budget,
                sourceId: client.sourceId,
                assignedToId: client.assignedToId,
                notes: client.notes,
              }}
              sources={sourceOptions}
              users={userOptions}
              isAdmin={user.role === "admin"}
            />
            <ClientHistory
              calls={client.calls.map((c) => ({
                id: c.id,
                direction: c.direction,
                missed: c.direction === "inbound" && !c.answeredAt,
                dispositionLabel: c.disposition
                  ? (dispoDisplay.get(c.disposition)?.label ??
                    (/^cat:\d+$/.test(c.disposition) ? t("dispositions.deleted") : null))
                  : null,
                dispositionColor: c.disposition
                  ? (dispoDisplay.get(c.disposition)?.color ?? null)
                  : null,
                startedAt: c.startedAt.toISOString(),
                durationSec: c.durationSec,
                disposition: c.disposition,
                note: c.note,
                // Enregistrements : admin seulement, via le proxy audité — jamais l'URL voip.ms brute.
                recordingUrl:
                  user.role === "admin" && c.recordingUrl
                    ? `/api/admin/recordings?url=${encodeURIComponent(c.recordingUrl)}&callId=${encodeURIComponent(c.id)}`
                    : null,
                userName: c.user?.name ?? null,
              }))}
              appointments={client.appointments.map((a) => ({
                id: a.id,
                title: a.title,
                type: a.type,
                status: a.status,
                startsAt: a.startsAt.toISOString(),
                endsAt: a.endsAt.toISOString(),
                location: a.location,
                meetLink: a.meetLink,
                userName: a.user?.name ?? null,
              }))}
            />
          </div>
        </div>
      </div>

      {/* Provenance de la fiche : création et dernière modification humaine. */}
      <p className="flex items-center gap-1.5 border-t pt-3 pb-2 text-xs text-muted-foreground">
        <HistoryIcon aria-hidden className="size-3.5 shrink-0" />
        <span>
          {createdLine}
          {updatedLine ? <span> · {updatedLine}</span> : null}
        </span>
      </p>
    </div>
  );
}
