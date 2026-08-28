import type { Locale } from "date-fns";
import { enCA } from "date-fns/locale/en-CA";
import { fr } from "date-fns/locale/fr";
import { formatInTimeZone } from "date-fns-tz";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { PhoneCall } from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { CallsFilters } from "@/components/analytics/calls-filters";
import { CallsList, type CallRow } from "@/components/analytics/calls-list";
import { SyncCallsButton } from "@/components/analytics/sync-calls-button";
import { APP_TZ, dayStartUtc, shiftDateStr } from "@/components/analytics/period";
import { VizTheme } from "@/components/analytics/viz-theme";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { db } from "@/db";
import { calls, categories, clients, users } from "@/db/schema";
import { dispositionDisplayMap, pipelineDispositionOptions } from "@/lib/dispositions";
import { bucketFor, grantsFor } from "@/lib/permissions/access";
import type { Grants } from "@/lib/permissions/catalog";
import { loadDirectory, requirePerm, visibilityCondition } from "@/lib/permissions/server";
import { formatPhone } from "@/lib/phone";
import { getUserOptions } from "../analytics/queries";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export async function generateMetadata() {
  const t = await getTranslations("analytics");
  return { title: t("callsPage.title") };
}

export default async function CallsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requirePerm("admin.calls");
  const sp = await searchParams;
  const t = await getTranslations("analytics");
  // « Masqué » est écrit une seule fois, chez les fiches.
  const tAccess = await getTranslations("clients");
  const locale = await getLocale();
  const dateLocale: Locale = locale === "en" ? enCA : fr;
  const nf = new Intl.NumberFormat(locale === "en" ? "en-CA" : "fr-CA");

  // ── Filtres depuis l'URL ──
  const q = (first(sp.q) ?? "").trim().slice(0, 80);
  const userParam = first(sp.user);
  const userId = userParam && UUID_RE.test(userParam) ? userParam : undefined;
  const directionParam = first(sp.direction);
  const direction =
    directionParam === "outbound" || directionParam === "inbound"
      ? directionParam
      : undefined;
  const dispoParam = first(sp.dispo)?.slice(0, 64);
  const disposition = dispoParam || undefined;
  const statusParam = first(sp.status);
  const status =
    statusParam === "missed" || statusParam === "answered" ? statusParam : undefined;
  const fromParam = first(sp.from);
  const toParam = first(sp.to);
  const fromStr = fromParam && DATE_RE.test(fromParam) ? fromParam : undefined;
  const toStr = toParam && DATE_RE.test(toParam) ? toParam : undefined;
  const pageParam = Number(first(sp.page));
  const page = Number.isInteger(pageParam) && pageParam >= 1 ? pageParam : 1;

  // ── Portée du regard ──────────────────────────────────────────────────────
  // « Suivre les appels de l'ÉQUIPE » n'est pas « voir toutes les FICHES ». Le
  // journal joint `clients` : la visibilité s'y pose donc directement, sur la
  // même requête que le total — un total non filtré sous une liste filtrée
  // annoncerait à lui seul le nombre de lignes qu'on cache.
  // Un appel SANS fiche ne protège rien (il n'y a pas de fiche derrière) : il
  // reste au journal, sinon les appels hors fiche disparaîtraient pour qui ne
  // voit pas le bassin. Composition à la main plutôt que `withVisibility`, qui
  // ajoute toujours une condition — ici c'est un OU.
  const [visible, { cfg, roleOf, rows: accounts }] = await Promise.all([
    visibilityCondition(actor),
    loadDirectory(),
  ]);
  const noClient = isNull(calls.clientId);
  const reach: SQL | undefined = visible ? or(noClient, visible)! : undefined;

  // Le compartiment d'une fiche ne dépend que de son DÉTENTEUR : on le résout
  // une fois par détenteur, pas une fois par ligne — une page de 25 appels ne
  // coûte donc pas 25 questions de plus à la matrice.
  const grantsCache = new Map<string, Grants>();
  const grantsOfHolder = (assignedToId: string | null): Grants => {
    const key = assignedToId ?? "";
    const hit = grantsCache.get(key);
    if (hit) return hit;
    const holder = assignedToId ? (roleOf.get(assignedToId) ?? null) : null;
    const g = grantsFor(cfg, actor.role, bucketFor(actor.user.id, { assignedToId }, holder));
    grantsCache.set(key, g);
    return g;
  };

  // Sur quelles fiches ce regard a-t-il droit aux COORDONNÉES ? La même
  // réduction « par détenteur » que /api/clients/list, traduite en condition
  // SQL : elle empêche la recherche par numéro de devenir un oracle.
  const contactHolders = accounts.filter((a) => grantsOfHolder(a.id).contact).map((a) => a.id);
  const contactOpen: SQL | undefined =
    grantsOfHolder(null).contact && contactHolders.length === accounts.length
      ? undefined
      : (() => {
          const parts: SQL[] = [];
          if (grantsOfHolder(null).contact) parts.push(isNull(clients.assignedToId));
          if (contactHolders.length > 0) parts.push(inArray(clients.assignedToId, contactHolders));
          if (parts.length === 0) return sql`false`;
          return parts.length === 1 ? parts[0] : or(...parts)!;
        })();

  const conds: SQL[] = [];
  if (userId) conds.push(eq(calls.userId, userId));
  // Manqués = entrants jamais décrochés (même définition que les analytiques).
  // « direction=outbound&status=missed » serait contradictoire : « manqués »
  // l'emporte sur la direction.
  if (direction && !(status === "missed" && direction === "outbound")) {
    conds.push(eq(calls.direction, direction));
  }
  if (disposition) conds.push(eq(calls.disposition, disposition));
  if (status === "missed") conds.push(eq(calls.direction, "inbound"), isNull(calls.answeredAt));
  if (status === "answered") conds.push(isNotNull(calls.answeredAt));
  if (fromStr) conds.push(gte(calls.startedAt, dayStartUtc(fromStr)));
  if (toStr) conds.push(lt(calls.startedAt, dayStartUtc(shiftDateStr(toStr, 1))));
  if (q) {
    const digits = q.replace(/\D/g, "");
    // Le NOM se cherche partout où la fiche est visible (la portée est déjà
    // dans le `where`). Les NUMÉROS, eux, ne se comparent que là où le
    // compartiment ouvre les coordonnées : sans cette garde, la recherche
    // devient un oracle qui rend chiffre par chiffre le numéro que la page
    // refuse d'afficher. Même règle que /api/clients/list.
    const parts: SQL[] = [ilike(clients.fullName, `%${q}%`)];
    if (digits.length >= 3) {
      const numbers = or(
        like(calls.fromNumber, `%${digits}%`),
        like(calls.toNumber, `%${digits}%`),
        like(clients.phone, `%${digits}%`),
      )!;
      const guard = contactOpen ? or(noClient, contactOpen)! : undefined;
      parts.push(guard ? and(guard, numbers)! : numbers);
    }
    const orCond = or(...parts);
    if (orCond) conds.push(orCond);
  }
  if (reach) conds.push(reach);
  const where = conds.length > 0 ? and(...conds) : undefined;

  // ── Requêtes : page + total (agrégé, jamais toutes les lignes) ──
  const [rows, [{ total }], userOptions, catRows] = await Promise.all([
    db
      .select({
        id: calls.id,
        startedAt: calls.startedAt,
        direction: calls.direction,
        answeredAt: calls.answeredAt,
        fromNumber: calls.fromNumber,
        toNumber: calls.toNumber,
        durationSec: calls.durationSec,
        disposition: calls.disposition,
        note: calls.note,
        recordingUrl: calls.recordingUrl,
        userName: users.name,
        clientId: clients.id,
        clientName: clients.fullName,
        holderId: clients.assignedToId,
      })
      .from(calls)
      .innerJoin(users, eq(users.id, calls.userId))
      .leftJoin(clients, eq(clients.id, calls.clientId))
      .where(where)
      .orderBy(desc(calls.startedAt))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(calls)
      .innerJoin(users, eq(users.id, calls.userId))
      .leftJoin(clients, eq(clients.id, calls.clientId))
      .where(where),
    getUserOptions(),
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

  // Dispositions = statuts du pipeline (libellés/couleurs de la table
  // categories ; repli i18n pour no_answer et les vieilles valeurs).
  const dispositionOptions = pipelineDispositionOptions(
    catRows,
    locale,
    t.has("dispositions.no_answer") ? t("dispositions.no_answer") : "no_answer",
  );
  const dispoDisplay = dispositionDisplayMap(catRows, locale);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const timePattern = locale === "en" ? "h:mm a" : "HH 'h' mm";
  const callRows: CallRow[] = rows.map((row) => {
    const rawNumber =
      row.direction === "outbound"
        ? (row.toNumber ?? row.fromNumber)
        : (row.fromNumber ?? row.toNumber);
    // La portée a déjà écarté les fiches invisibles ; ce qui reste à trancher
    // ligne par ligne, ce sont les DEUX cases qui n'ouvrent pas avec elle :
    // les coordonnées (le numéro distant) et l'historique (la note d'après-appel
    // et l'enregistrement). Un appel sans fiche n'a rien à protéger.
    const open = row.clientId ? grantsOfHolder(row.holderId) : null;
    const named = open ? open.visible : false;
    const contact = open ? open.visible && open.contact : true;
    const history = open ? open.visible && open.history : true;
    return {
      id: row.id,
      dateLabel: formatInTimeZone(row.startedAt, APP_TZ, "d MMM yyyy", { locale: dateLocale }),
      timeLabel: formatInTimeZone(row.startedAt, APP_TZ, timePattern, { locale: dateLocale }),
      userName: row.userName,
      direction: row.direction,
      missed: row.direction === "inbound" && !row.answeredAt,
      clientId: named ? row.clientId : null,
      clientName: named ? row.clientName : null,
      // Un numéro fermé ne PART PAS : on n'envoie pas au navigateur un chiffre
      // qu'on masquerait ensuite en CSS.
      number: contact
        ? rawNumber
          ? formatPhone(rawNumber)
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
      // La note d'après-appel raconte la fiche : c'est de l'historique.
      note: history ? row.note : null,
      // L'enregistrement aussi — et le proxy exige en plus `clients.recordings`
      // (il journalise chaque écoute). Sans ce droit, pas de bouton mort ici.
      recordingUrl: history && actor.can("clients.recordings") ? row.recordingUrl : null,
    };
  });

  // ── Liens de pagination (les filtres restent) ──
  const pageHref = (target: number) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (userId) params.set("user", userId);
    if (direction) params.set("direction", direction);
    if (disposition) params.set("dispo", disposition);
    if (status) params.set("status", status);
    if (fromStr) params.set("from", fromStr);
    if (toStr) params.set("to", toStr);
    if (target > 1) params.set("page", String(target));
    const qs = params.toString();
    return qs ? `/admin/calls?${qs}` : "/admin/calls";
  };

  return (
    <div className="nx-viz space-y-4 p-4 md:p-6">
      <VizTheme />

      <PageHeader
        icon={<PhoneCall />}
        title={t("callsPage.title")}
        subtitle={t("callsPage.subtitle")}
        actions={<SyncCallsButton />}
      />

      <CallsFilters
        q={q}
        userId={userId}
        direction={direction}
        disposition={disposition}
        status={status}
        fromStr={fromStr}
        toStr={toStr}
        users={userOptions}
        dispositions={dispositionOptions.map((o) => ({ value: o.value, label: o.label }))}
      />

      <p className="text-sm tabular-nums text-muted-foreground">
        {t("callsPage.resultsCount", { count: nf.format(total) })}
      </p>

      <CallsList rows={callRows} />

      {totalPages > 1 ? (
        <nav
          aria-label={t("callsPage.pagination")}
          className="flex items-center justify-between gap-2"
        >
          <Button
            variant="outline"
            className="h-11 md:h-8"
            disabled={page <= 1}
            render={page > 1 ? <Link href={pageHref(page - 1)} /> : undefined}
          >
            {t("callsPage.prev")}
          </Button>
          <span className="text-sm tabular-nums text-muted-foreground">
            {t("callsPage.page", { page, total: totalPages })}
          </span>
          <Button
            variant="outline"
            className="h-11 md:h-8"
            disabled={page >= totalPages}
            render={page < totalPages ? <Link href={pageHref(page + 1)} /> : undefined}
          >
            {t("callsPage.next")}
          </Button>
        </nav>
      ) : null}
    </div>
  );
}
