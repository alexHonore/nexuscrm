import type { Locale } from "date-fns";
import { enCA } from "date-fns/locale/en-CA";
import { fr } from "date-fns/locale/fr";
import { formatInTimeZone } from "date-fns-tz";
import { asc } from "drizzle-orm";
import { LibraryBig } from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { CallsList, type CallRow } from "@/components/analytics/calls-list";
import { CollectionsPanel } from "@/components/analytics/collections-panel";
import { APP_TZ } from "@/components/analytics/period";
import type { CollectionOption } from "@/components/analytics/recording-marks";
import { VizTheme } from "@/components/analytics/viz-theme";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { db } from "@/db";
import { categories } from "@/db/schema";
import { dispositionDisplayMap } from "@/lib/dispositions";
import { requirePerm } from "@/lib/permissions/server";
import { formatPhone } from "@/lib/phone";
import {
  LIBRARY_PAGE_SIZE,
  type LibraryScope,
  grantsResolver,
  loadCollections,
  loadLibraryPage,
  markersFor,
  starredCount,
} from "@/lib/recordings/library";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export async function generateMetadata() {
  const t = await getTranslations("analytics");
  return { title: t("library.title") };
}

/**
 * La bibliothèque d'écoute — retrouver un appel par ce qu'il ENSEIGNE, pas par
 * sa date.
 *
 * L'écran est gardé par le droit d'ÉCOUTER, pas par celui de ranger : un
 * téléphoniste doit pouvoir ouvrir « Formation — objections prix » sans avoir
 * la main sur son contenu. Le droit de ranger n'ajoute que des boutons.
 *
 * Tout ce qui est compté ici l'est à travers le regard de celui qui regarde
 * (`loadCollections`, `starredCount`, `loadLibraryPage`) — jamais un total
 * brut sous une liste filtrée (règle 13).
 */
export default async function RecordingLibraryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requirePerm("clients.recordings");
  const [t, locale] = await Promise.all([getTranslations("analytics"), getLocale()]);
  const dateLocale: Locale = locale === "en" ? enCA : fr;

  const sp = await searchParams;
  const rawCollection = first(sp.c);
  const collectionId = rawCollection && UUID_RE.test(rawCollection) ? rawCollection : undefined;
  const pageRaw = Number(first(sp.page) ?? "1");
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;

  const canCurate = actor.can("clients.recordingsCurate");

  const [collections, starred] = await Promise.all([loadCollections(actor), starredCount(actor)]);

  // Un identifiant de recueil disparu (dossier supprimé, lien périmé) retombe
  // sur « Mes marqués » plutôt que d'afficher une page vide qui ne dit pas
  // pourquoi elle l'est. Les recueils ne sont secrets pour personne : leur
  // liste part entière avec l'écran, seul leur CONTENU est filtré.
  const known = collections.find((c) => c.id === collectionId);
  const scope: LibraryScope = known ? { kind: "collection", id: known.id } : { kind: "starred" };

  const [{ rows, total }, catRows] = await Promise.all([
    loadLibraryPage(actor, scope, page),
    db
      .select({
        id: categories.id,
        key: categories.key,
        nameFr: categories.nameFr,
        nameEn: categories.nameEn,
        color: categories.color,
        sortOrder: categories.sortOrder,
      })
      .from(categories)
      .orderBy(asc(categories.sortOrder)),
  ]);

  const [marks, grantsOfHolder] = await Promise.all([
    markersFor(
      actor,
      rows.map((r) => r.id),
    ),
    grantsResolver(actor),
  ]);

  const dispoDisplay = dispositionDisplayMap(catRows, locale === "en" ? "en" : "fr");
  const tAccess = await getTranslations("clients");
  const timePattern = locale === "en" ? "h:mm a" : "HH 'h' mm";

  const callRows: CallRow[] = rows.map((row) => {
    // Même redaction ligne par ligne que le journal d'appels : la portée a
    // écarté les fiches invisibles, restent les deux cases qui n'ouvrent pas
    // avec elle — les coordonnées et l'historique.
    const open = row.clientId ? grantsOfHolder(row.holderId) : null;
    const named = open ? open.visible : false;
    const contact = open ? open.visible && open.contact : true;
    const history = open ? open.visible && open.history : true;
    return {
      id: row.id,
      dateLabel: formatInTimeZone(row.startedAt, APP_TZ, "d MMM yyyy", { locale: dateLocale }),
      timeLabel: formatInTimeZone(row.startedAt, APP_TZ, timePattern, { locale: dateLocale }),
      userName: row.userName ?? "—",
      direction: row.direction,
      missed: row.missed,
      clientId: named ? row.clientId : null,
      clientName: named ? row.clientName : null,
      number: contact
        ? row.rawNumber
          ? formatPhone(row.rawNumber)
          : t("callsPage.unknownNumber")
        : tAccess("access.masked"),
      durationSec: row.durationSec,
      disposition: row.disposition,
      dispositionLabel: row.disposition
        ? (dispoDisplay.get(row.disposition)?.label ??
          (t.has(`dispositions.${row.disposition}`)
            ? t(`dispositions.${row.disposition}`)
            : /^cat:\d+$/.test(row.disposition)
              ? t("dispositions.deleted")
              : row.disposition))
        : null,
      dispositionColor: row.disposition
        ? (dispoDisplay.get(row.disposition)?.color ?? null)
        : null,
      note: history ? row.note : null,
      recordingUrl: history ? row.recordingUrl : null,
      marks: history ? (marks.get(row.id) ?? { starred: false, collections: [] }) : null,
      filingNote: history ? row.filingNote : null,
    };
  });

  const collectionOptions: CollectionOption[] = collections.map((c) => ({
    id: c.id,
    kind: c.kind,
    name: c.name,
  }));

  const totalPages = Math.max(1, Math.ceil(total / LIBRARY_PAGE_SIZE));
  const pageHref = (target: number) => {
    const params = new URLSearchParams();
    if (scope.kind === "collection") params.set("c", scope.id);
    if (target > 1) params.set("page", String(target));
    const qs = params.toString();
    return qs ? `/admin/recordings?${qs}` : "/admin/recordings";
  };

  const title = known ? known.name : t("library.starredScope");
  const emptyHint =
    scope.kind === "starred" ? t("library.emptyStarredHint") : t("library.emptyCollectionHint");

  return (
    <div className="nx-viz space-y-4 p-4 md:p-6">
      <VizTheme />

      <PageHeader
        icon={<LibraryBig />}
        title={t("library.title")}
        subtitle={t("library.subtitle")}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <CollectionsPanel
          collections={collections}
          starred={starred}
          scope={scope}
          canCurate={canCurate}
        />

        <section className="min-w-0 space-y-3">
          <div>
            <h2 className="text-base font-semibold">{title}</h2>
            <p className="text-sm text-muted-foreground">
              {known?.description ?? t("library.count", { count: total })}
            </p>
          </div>

          {callRows.length === 0 ? (
            <div className="rounded-xl bg-card p-8 text-center ring-1 ring-foreground/10">
              <p className="text-sm font-medium">{t("library.empty")}</p>
              <p className="mt-1 text-sm text-muted-foreground">{emptyHint}</p>
            </div>
          ) : (
            <CallsList
              rows={callRows}
              collections={collectionOptions}
              canCurate={canCurate}
              variant="library"
              hideCollectionId={scope.kind === "collection" ? scope.id : undefined}
            />
          )}

          {totalPages > 1 ? (
            <nav
              aria-label={t("callsPage.pagination")}
              className="flex items-center justify-between gap-2"
            >
              <Button
                variant="outline"
                size="sm"
                className="h-11 md:h-8"
                disabled={page <= 1}
                render={page > 1 ? <Link href={pageHref(page - 1)} /> : undefined}
              >
                {t("callsPage.prev")}
              </Button>
              <span className="text-xs text-muted-foreground">
                {t("callsPage.page", { page, total: totalPages })}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-11 md:h-8"
                disabled={page >= totalPages}
                render={page < totalPages ? <Link href={pageHref(page + 1)} /> : undefined}
              >
                {t("callsPage.next")}
              </Button>
            </nav>
          ) : null}
        </section>
      </div>
    </div>
  );
}
