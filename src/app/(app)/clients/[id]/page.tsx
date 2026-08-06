import { asc, desc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { categories, sources, users } from "@/db/schema";
import { requireUser } from "@/lib/auth/guards";
import { ClientHeader } from "@/components/clients/client-header";
import { ClientHistory } from "@/components/clients/client-history";
import { ClientInfoForm } from "@/components/clients/client-info-form";
import { ClientSwitcher } from "@/components/clients/client-switcher";
import { CommentsTimeline } from "@/components/clients/comments-timeline";
import { DeleteClientButton } from "@/components/clients/delete-client-button";
import { FollowupsCard } from "@/components/clients/followups-card";
import type { FilterOption } from "@/components/clients/clients-filters";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const client = await db.query.clients.findFirst({
    where: (c, { eq: eqOp }) => eqOp(c.id, id),
    with: {
      calls: { with: { user: true }, orderBy: (c) => [desc(c.startedAt)], limit: 100 },
      appointments: { with: { user: true }, orderBy: (a) => [desc(a.startsAt)], limit: 100 },
      comments: { with: { user: true }, orderBy: (c) => [asc(c.createdAt)], limit: 200 },
      followups: { orderBy: (f) => [asc(f.dueAt)] },
    },
  });
  if (!client) notFound();

  const [allCategories, allSources, activeUsers] = await Promise.all([
    db.query.categories.findMany({ orderBy: [asc(categories.sortOrder), asc(categories.id)] }),
    db.query.sources.findMany({ orderBy: [asc(sources.name)] }),
    db.query.users.findMany({ where: eq(users.isActive, true), orderBy: [asc(users.name)] }),
  ]);

  const sourceOptions: FilterOption[] = allSources.map((s) => ({
    value: String(s.id),
    label: s.name,
  }));
  const userOptions: FilterOption[] = activeUsers.map((u) => ({ value: u.id, label: u.name }));

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
                startedAt: c.startedAt.toISOString(),
                durationSec: c.durationSec,
                disposition: c.disposition,
                note: c.note,
                // Enregistrements : admin seulement, via le proxy audité — jamais l'URL voip.ms brute.
                recordingUrl:
                  user.role === "admin" && c.recordingUrl
                    ? `/api/admin/recordings?url=${encodeURIComponent(c.recordingUrl)}`
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
    </div>
  );
}
