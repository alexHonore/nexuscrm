"use client";

import { formatInTimeZone } from "date-fns-tz";
import { enUS, fr } from "date-fns/locale";
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ClockAlertIcon,
  Columns3Icon,
  EyeOffIcon,
  MegaphoneIcon,
  PhoneOffIcon,
  TagsIcon,
  Trash2Icon,
  UserRoundPlusIcon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState, useSyncExternalStore, useTransition } from "react";
import { toast } from "sonner";
import {
  assignClientAction,
  bulkAssignClientsAction,
  bulkDeleteClientsAction,
  bulkSetClientsCategoryAction,
  bulkSetClientsSourceAction,
  setClientCategoryAction,
  setClientSourceAction,
  type ActionResult,
  type BulkResult,
} from "@/app/(app)/clients/actions";
import type { FilterOption } from "@/components/clients/clients-filters";
import type {
  ClientListCapabilities,
  ClientRow,
  PanelCategory,
} from "@/components/clients/clients-workspace";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { APP_TZ } from "@/components/clients/timezone";
import { BULK_MAX } from "@/lib/bulk";
import { ENROLL_REFUSALS } from "@/lib/campaigns/eligibility";
import { emitDataChange } from "@/lib/live";
import { formatPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";

export type ClientSortKey =
  | "activity"
  | "name"
  | "city"
  | "createdAt"
  | "updatedAt"
  | "followupAt"
  | "lastContact";
export type ClientSortDir = "asc" | "desc";

// ── Colonnes affichées : préférence par utilisateur (localStorage) ───────────
// Même patron de magasin externe que la préférence fiches/tableau du panneau.
// On stocke les colonnes MASQUÉES : une colonne ajoutée plus tard apparaît
// d'office chez tout le monde. « name » n'est pas masquable (ancre des lignes).

const COLUMNS_STORAGE_KEY = "nexus.clientsTableHiddenColumns";

/** Colonnes masquables, dans l'ordre d'affichage du tableau. */
const TOGGLEABLE_COLUMNS = [
  "phone",
  "category",
  "city",
  "source",
  "assignedTo",
  "followup",
  "lastContact",
  "created",
  "updated",
] as const;
type ToggleableColumn = (typeof TOGGLEABLE_COLUMNS)[number];

const NO_HIDDEN: ReadonlySet<ToggleableColumn> = new Set();
let hiddenCache: ReadonlySet<ToggleableColumn> | null = null;
const columnListeners = new Set<() => void>();

function parseHiddenColumns(): ReadonlySet<ToggleableColumn> {
  try {
    const raw = window.localStorage.getItem(COLUMNS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return NO_HIDDEN;
    return new Set(
      parsed.filter((v): v is ToggleableColumn =>
        (TOGGLEABLE_COLUMNS as readonly string[]).includes(v as string),
      ),
    );
  } catch {
    return NO_HIDDEN;
  }
}

function readHiddenColumns(): ReadonlySet<ToggleableColumn> {
  if (hiddenCache === null) hiddenCache = parseHiddenColumns();
  return hiddenCache;
}

function writeHiddenColumns(next: ReadonlySet<ToggleableColumn>): void {
  hiddenCache = next;
  try {
    window.localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify([...next]));
  } catch {
    // Stockage indisponible : la préférence ne survivra pas à la session.
  }
  for (const notify of columnListeners) notify();
}

function subscribeHiddenColumns(onChange: () => void): () => void {
  columnListeners.add(onChange);
  return () => columnListeners.delete(onChange);
}

/**
 * Vue tableau de /clients : colonnes triables (nom, création, modification) et,
 * pour qui en a le droit, sélection multiple + barre d'actions en masse
 * (assigner, catégoriser, supprimer) et édition en ligne.
 *
 * Chaque geste dépend de SA case (`can.bulk`, `can.category`, `can.assign`…) et
 * d'aucune autre : « administrateur » n'est plus une réponse à « peut-il
 * reclasser cette ligne ? ». Rien de tout cela ne protège quoi que ce soit — le
 * serveur refuse l'action, ligne par ligne, quoi qu'affiche le tableau.
 *
 * Mobile : le tableau devient une liste de cartes cochables.
 */
/** Motifs de refus connus — seuls ceux-là ont une étiquette traduite. */
const ENROLL_REFUSAL_KEYS = new Set<string>(ENROLL_REFUSALS);

export function ClientsTable({
  items,
  loading,
  can,
  categories,
  sources,
  users,
  campaigns,
  sortKey,
  sortDir,
  onSort,
  now,
}: {
  items: ClientRow[];
  loading: boolean;
  can: ClientListCapabilities;
  categories: PanelCategory[];
  sources: FilterOption[];
  users: FilterOption[];
  /** Campagnes SMS — pour inscrire une sélection d'un geste. */
  campaigns: FilterOption[];
  sortKey: ClientSortKey;
  sortDir: ClientSortDir;
  onSort: (key: Exclude<ClientSortKey, "activity">) => void;
  /** Horodatage « maintenant » du parent — évite un Date.now() par cellule. */
  now: number;
}) {
  const t = useTranslations("clients");
  // Les motifs de refus appartiennent au module des campagnes : on les LIT
  // chez lui plutôt que d'en recopier onze ici.
  const tc = useTranslations("campaigns");
  const locale = useLocale();
  const router = useRouter();
  const dfnsLocale = locale === "en" ? enUS : fr;
  const [pending, startTransition] = useTransition();
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Colonnes affichées (desktop) — préférence propre à l'utilisateur.
  const hiddenColumns = useSyncExternalStore(
    subscribeHiddenColumns,
    readHiddenColumns,
    (): ReadonlySet<ToggleableColumn> => NO_HIDDEN,
  );
  const show = (column: ToggleableColumn) => !hiddenColumns.has(column);
  const toggleColumn = (column: ToggleableColumn) => {
    const next = new Set(hiddenColumns);
    if (next.has(column)) next.delete(column);
    else next.add(column);
    writeHiddenColumns(next);
  };
  /** Libellés du menu — mêmes clés que les en-têtes du tableau. */
  const columnLabel: Record<ToggleableColumn, string> = {
    phone: t("table.phone"),
    category: t("table.category"),
    city: t("table.city"),
    source: t("table.source"),
    assignedTo: t("table.assignedTo"),
    followup: t("table.followup"),
    lastContact: t("table.lastContact"),
    created: t("table.created"),
    updated: t("table.updated"),
  };

  const [selectedRaw, setSelectedRaw] = useState<ReadonlySet<string>>(new Set());
  // Une fiche disparue de la liste (supprimée ailleurs, filtre changé) ne doit
  // pas rester silencieusement dans la sélection d'une action en masse — la
  // sélection effective est l'intersection avec les lignes visibles.
  const selected = useMemo(() => {
    const visible = new Set(items.map((item) => item.id));
    const kept = [...selectedRaw].filter((id) => visible.has(id));
    return kept.length === selectedRaw.size ? selectedRaw : new Set(kept);
  }, [items, selectedRaw]);

  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const sourceByValue = useMemo(() => new Map(sources.map((s) => [s.value, s])), [sources]);
  const userLabels = useMemo(() => new Map(users.map((u) => [u.value, u.label])), [users]);

  const allSelected = items.length > 0 && items.every((item) => selected.has(item.id));
  const someSelected = selected.size > 0 && !allSelected;

  const toggleAll = () => {
    setSelectedRaw(allSelected ? new Set() : new Set(items.map((item) => item.id)));
  };
  const toggleOne = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedRaw(next);
  };
  const clearSelection = () => setSelectedRaw(new Set());

  const day = (iso: string) =>
    formatInTimeZone(new Date(iso), APP_TZ, "d MMM yyyy", { locale: dfnsLocale });
  const dayTime = (iso: string) =>
    formatInTimeZone(new Date(iso), APP_TZ, "d MMM yyyy, HH:mm", { locale: dfnsLocale });

  /**
   * Exécute une action en masse et rafraîchit les listes en cas de succès.
   *
   * La sélection est découpée en lots de BULK_MAX : le serveur refuse au-delà,
   * et sans ce découpage sélectionner plus de fiches que la limite échouait sur
   * un « Une erreur est survenue » sans explication. En cas d'échec en cours de
   * route, on annonce ce qui a réellement été traité.
   */
  const runBulk = (run: (ids: string[]) => Promise<BulkResult>, successKey: string) => {
    const ids = [...selected];
    if (ids.length === 0) return;
    startTransition(async () => {
      let done = 0;
      for (let i = 0; i < ids.length; i += BULK_MAX) {
        const res = await run(ids.slice(i, i + BULK_MAX));
        if (!res.ok) {
          toast.error(
            // « Verrouillée » se nomme : ce lot touchait des fiches tenues par
            // quelqu'un d'autre. Le plafond, lui, n'a pas son compte ici (le
            // tableau ne connaît pas le maximum du rôle) et retombe au générique.
            res.error === "forbidden"
              ? t("access.noRight")
              : res.error === "locked"
                ? t("access.lockedForever")
                : done > 0
                  ? t("errors.bulkPartial", { done, total: ids.length })
                  : t("errors.generic"),
          );
          setDeleteOpen(false);
          if (done > 0) {
            clearSelection();
            emitDataChange("clients");
            router.refresh();
          }
          return;
        }
        done += res.count;
      }
      toast.success(t(successKey, { count: done }));
      setDeleteOpen(false);
      clearSelection();
      emitDataChange("clients");
      router.refresh();
    });
  };

  /**
   * Inscrire la sélection à une campagne.
   *
   * Passe par la MÊME route que « Ajouter des clients » de l'éditeur de
   * campagne, et pas par une action à part : l'éligibilité (numéro,
   * désabonnement, déjà inscrit, plafonds), le garde admin et le journal
   * d'audit y vivent déjà. Les réécrire ici les condamnerait à diverger.
   *
   * Le rapport n'est pas un simple compte : inscrire échoue pour des raisons
   * qu'il faut NOMMER — « 12 inscrits, 8 écartés » sans motif ne dit pas s'il
   * faut relever un plafond ou constater que tout le monde y était déjà.
   */
  const enrollSelection = (campaignId: string, campaignName: string) => {
    const ids = [...selected];
    if (ids.length === 0) return;
    startTransition(async () => {
      let added = 0;
      const refusals = new Map<string, number>();
      for (let i = 0; i < ids.length; i += BULK_MAX) {
        let payload: { added?: number; results?: { refusal?: string }[] };
        try {
          const res = await fetch(`/api/campaigns/${campaignId}/enrollments`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clientIds: ids.slice(i, i + BULK_MAX) }),
          });
          if (!res.ok) throw new Error(String(res.status));
          payload = (await res.json()) as typeof payload;
        } catch {
          toast.error(
            added > 0 ? t("errors.bulkPartial", { done: added, total: ids.length }) : t("errors.generic"),
          );
          if (added > 0) {
            clearSelection();
            emitDataChange("clients");
            router.refresh();
          }
          return;
        }
        added += payload.added ?? 0;
        for (const r of payload.results ?? []) {
          if (r.refusal) refusals.set(r.refusal, (refusals.get(r.refusal) ?? 0) + 1);
        }
      }
      const breakdown = [...refusals.entries()]
        .filter(([reason]) => ENROLL_REFUSAL_KEYS.has(reason))
        .map(([reason, n]) => `${tc(`editor.enrollments.refusal.${reason}` as never)} : ${n}`);
      toast.success(
        t("bulk.enrolled", { count: added, campaign: campaignName }),
        breakdown.length > 0 ? { description: breakdown.join(" · ") } : undefined,
      );
      clearSelection();
      emitDataChange("clients");
      router.refresh();
    });
  };

  /** Édition en ligne d'UNE fiche (admin) — même contrat que runBulk. */
  const runRow = (run: () => Promise<ActionResult>, successMessage: string) => {
    startTransition(async () => {
      const res = await run();
      if (res.ok) {
        toast.success(successMessage);
        emitDataChange("clients");
        router.refresh();
      } else {
        // Une ligne devenue invisible (rendue, réassignée) répond
        // « introuvable » : jamais « interdit », qui dirait qu'elle existe.
        toast.error(
          res.error === "forbidden"
            ? t("access.noRight")
            : res.error === "notFound"
              ? t("errors.notFound")
              : res.error === "locked"
                ? t("access.lockedForever")
                : t("errors.generic"),
        );
      }
    });
  };

  const sortHead = (key: Exclude<ClientSortKey, "activity">, label: string) => (
    <button
      type="button"
      onClick={() => onSort(key)}
      className={cn(
        "-mx-1.5 inline-flex min-h-8 items-center gap-1 rounded-md px-1.5 transition-colors hover:bg-muted hover:text-foreground",
        sortKey === key && "text-foreground",
      )}
      aria-label={t("table.sortBy", { column: label })}
    >
      {label}
      {sortKey === key ? (
        sortDir === "asc" ? (
          <ArrowUpIcon className="size-3.5" />
        ) : (
          <ArrowDownIcon className="size-3.5" />
        )
      ) : (
        <ArrowUpDownIcon className="size-3.5 opacity-40" />
      )}
    </button>
  );

  const categoryChip = (item: ClientRow) => {
    const category = item.categoryId !== null ? categoryById.get(item.categoryId) : undefined;
    if (!category) {
      return <span className="text-xs text-muted-foreground">{t("list.noCategory")}</span>;
    }
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium"
        style={{
          color: category.color,
          backgroundColor: `${category.color}1a`,
          borderColor: `${category.color}40`,
        }}
      >
        <span
          aria-hidden
          className="size-1.5 rounded-full"
          style={{ backgroundColor: category.color }}
        />
        {category.label}
      </span>
    );
  };

  const sourceChip = (item: ClientRow) => {
    const source = item.sourceId !== null ? sourceByValue.get(String(item.sourceId)) : undefined;
    if (!source) return <span className="text-muted-foreground">—</span>;
    return (
      <span className="inline-flex items-center gap-1.5">
        {source.color ? (
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: source.color }}
          />
        ) : null}
        {source.label}
      </span>
    );
  };

  /**
   * Le téléphone d'une ligne — ou la pastille qui dit qu'il n'est pas ouvert.
   * L'API n'a pas envoyé le numéro : il n'y a rien à révéler ici, et rien à
   * composer non plus.
   */
  const phoneCell = (item: ClientRow) =>
    item.contactHidden ? (
      <span
        title={t("access.maskedHint")}
        className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
      >
        <EyeOffIcon aria-hidden className="size-3" />
        {t("access.masked")}
      </span>
    ) : (
      formatPhone(item.phone)
    );

  const assigneeText = (item: ClientRow) =>
    (item.assignedToId ? userLabels.get(item.assignedToId) : null) ?? t("list.unassigned");

  const followupCell = (item: ClientRow) => {
    if (!item.nextFollowupAt) return <span className="text-muted-foreground">—</span>;
    const overdue = Date.parse(item.nextFollowupAt) < now;
    return (
      <span
        className={cn("inline-flex items-center gap-1 tabular-nums", overdue && "font-medium text-destructive")}
        title={dayTime(item.nextFollowupAt)}
      >
        {overdue ? <ClockAlertIcon className="size-3.5 shrink-0" aria-label={t("list.filters.late")} /> : null}
        {day(item.nextFollowupAt)}
      </span>
    );
  };

  /**
   * Cellule éditable en ligne (admin) : le contenu affiché devient le
   * déclencheur d'un menu. Le serveur revalide le rôle — le menu caché aux
   * téléphonistes n'est pas la protection.
   */
  const inlineMenu = (
    display: React.ReactNode,
    ariaLabel: string,
    menu: React.ReactNode,
  ) => (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            disabled={pending}
            aria-label={ariaLabel}
            className="group/edit -mx-1.5 -my-1 inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-1 text-left hover:bg-muted"
          />
        }
      >
        <span className="min-w-0 truncate">{display}</span>
        <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/edit:opacity-100" />
      </DropdownMenuTrigger>
      {menu}
    </DropdownMenu>
  );

  const categoryMenu = (item: ClientRow) => (
    <DropdownMenuContent align="start" className="min-w-48">
      {categories.map((c) => (
        <DropdownMenuItem
          key={c.id}
          className="min-h-10"
          disabled={c.id === item.categoryId}
          onClick={() =>
            runRow(() => setClientCategoryAction(item.id, c.id), t("detail.categoryUpdated"))
          }
        >
          <span aria-hidden className="size-2.5 rounded-full" style={{ backgroundColor: c.color }} />
          {c.label}
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        className="min-h-10"
        disabled={item.categoryId === null}
        onClick={() =>
          runRow(() => setClientCategoryAction(item.id, null), t("detail.categoryUpdated"))
        }
      >
        <span aria-hidden className="size-2.5 rounded-full bg-muted-foreground/40" />
        {t("detail.noCategory")}
      </DropdownMenuItem>
    </DropdownMenuContent>
  );

  const sourceMenu = (item: ClientRow) => (
    <DropdownMenuContent align="start" className="min-w-48">
      {sources.map((s) => (
        <DropdownMenuItem
          key={s.value}
          className="min-h-10"
          disabled={String(item.sourceId ?? "") === s.value}
          onClick={() =>
            runRow(() => setClientSourceAction(item.id, Number(s.value)), t("detail.sourceUpdated"))
          }
        >
          {s.color ? (
            <span aria-hidden className="size-2.5 rounded-full" style={{ backgroundColor: s.color }} />
          ) : null}
          {s.label}
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        className="min-h-10"
        disabled={item.sourceId === null}
        onClick={() => runRow(() => setClientSourceAction(item.id, null), t("detail.sourceUpdated"))}
      >
        {t("list.filters.noSource")}
      </DropdownMenuItem>
    </DropdownMenuContent>
  );

  const assigneeMenu = (item: ClientRow) => (
    <DropdownMenuContent align="start" className="min-w-48">
      {users.map((u) => (
        <DropdownMenuItem
          key={u.value}
          className="min-h-10"
          disabled={item.assignedToId === u.value}
          onClick={() => runRow(() => assignClientAction(item.id, u.value), t("assign.success"))}
        >
          {u.label}
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        className="min-h-10"
        disabled={item.assignedToId === null}
        onClick={() => runRow(() => assignClientAction(item.id, null), t("assign.success"))}
      >
        {t("list.unassigned")}
      </DropdownMenuItem>
    </DropdownMenuContent>
  );

  if (loading) {
    // Silhouette structurelle du tableau : rythme d'en-tête + lignes aux
    // largeurs variées, pour éviter le saut de mise en page au chargement.
    const nameWidths = ["w-40", "w-32", "w-44", "w-36", "w-28"];
    const cityWidths = ["w-24", "w-16", "w-20"];
    return (
      <div aria-hidden className="px-3 pb-2">
        <div className="flex h-10 items-center gap-4 border-b border-border/60">
          <Skeleton className="h-3 w-24 rounded" />
          <Skeleton className="h-3 w-16 rounded" />
          <Skeleton className="h-3 w-20 rounded" />
          <Skeleton className="hidden h-3 w-16 rounded md:block" />
          <Skeleton className="hidden h-3 w-20 rounded md:block" />
        </div>
        {Array.from({ length: 10 }, (_, i) => (
          <div
            key={i}
            className="flex h-[41px] items-center gap-4 border-b border-border/60"
          >
            <Skeleton className={cn("h-3.5 rounded", nameWidths[i % nameWidths.length])} />
            <Skeleton className="h-3.5 w-28 rounded" />
            <Skeleton className="h-5 w-20 rounded-full" />
            <Skeleton
              className={cn("hidden h-3.5 rounded md:block", cityWidths[i % cityWidths.length])}
            />
            <Skeleton className="hidden h-3.5 w-24 rounded md:block" />
          </div>
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return <p className="p-6 text-center text-sm text-muted-foreground">{t("list.empty")}</p>;
  }

  return (
    <div className={cn(selected.size > 0 && "pb-24")}>
      {/* ── Desktop : vrai tableau ── */}
      <div className="hidden md:block">
        <Table className="[&_th]:h-10 [&_th]:whitespace-nowrap [&_th]:text-[11px] [&_th]:font-medium [&_th]:uppercase [&_th]:tracking-wider">
          <TableHeader className="bg-muted/40">
            <TableRow className="hover:bg-transparent">
              {can.bulk ? (
                <TableHead className="w-10">
                  <Checkbox
                    checked={allSelected}
                    indeterminate={someSelected}
                    onCheckedChange={toggleAll}
                    aria-label={t("table.selectAll")}
                  />
                </TableHead>
              ) : null}
              <TableHead>{sortHead("name", t("table.name"))}</TableHead>
              {show("phone") ? <TableHead>{t("table.phone")}</TableHead> : null}
              {show("category") ? <TableHead>{t("table.category")}</TableHead> : null}
              {show("city") ? <TableHead>{sortHead("city", t("table.city"))}</TableHead> : null}
              {show("source") ? <TableHead>{t("table.source")}</TableHead> : null}
              {show("assignedTo") ? <TableHead>{t("table.assignedTo")}</TableHead> : null}
              {show("followup") ? (
                <TableHead>{sortHead("followupAt", t("table.followup"))}</TableHead>
              ) : null}
              {show("lastContact") ? (
                <TableHead>{sortHead("lastContact", t("table.lastContact"))}</TableHead>
              ) : null}
              {show("created") ? (
                <TableHead>{sortHead("createdAt", t("table.created"))}</TableHead>
              ) : null}
              {show("updated") ? (
                <TableHead>{sortHead("updatedAt", t("table.updated"))}</TableHead>
              ) : null}
              <TableHead className="w-10 text-right">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        className="size-8 text-muted-foreground"
                        aria-label={t("table.columns")}
                      />
                    }
                  >
                    <Columns3Icon />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    {TOGGLEABLE_COLUMNS.map((column) => (
                      <DropdownMenuCheckboxItem
                        key={column}
                        checked={show(column)}
                        onCheckedChange={() => toggleColumn(column)}
                        closeOnClick={false}
                      >
                        {columnLabel[column]}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow
                key={item.id}
                data-state={selected.has(item.id) ? "selected" : undefined}
                className="cursor-pointer"
                onClick={() => router.push(`/clients/${item.id}`)}
              >
                {can.bulk ? (
                  <TableCell
                    className="w-10"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Checkbox
                      checked={selected.has(item.id)}
                      onCheckedChange={() => toggleOne(item.id)}
                      aria-label={t("table.selectRow", { name: item.fullName })}
                    />
                  </TableCell>
                ) : null}
                <TableCell className="max-w-56">
                  <span className="flex items-center gap-1.5">
                    <Link
                      href={`/clients/${item.id}`}
                      className="truncate font-medium hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {item.fullName}
                    </Link>
                    {item.doNotCall ? (
                      <PhoneOffIcon
                        className="size-3.5 shrink-0 text-destructive"
                        aria-label={t("list.doNotCall")}
                      />
                    ) : null}
                  </span>
                </TableCell>
                {show("phone") ? (
                  <TableCell className="tabular-nums">{phoneCell(item)}</TableCell>
                ) : null}
                {show("category") ? (
                  <TableCell onClick={can.category ? (e) => e.stopPropagation() : undefined}>
                    {can.category
                      ? inlineMenu(
                          categoryChip(item),
                          t("table.editCategory", { name: item.fullName }),
                          categoryMenu(item),
                        )
                      : categoryChip(item)}
                  </TableCell>
                ) : null}
                {show("city") ? (
                  <TableCell className="max-w-36 truncate text-muted-foreground">
                    {item.city ?? "—"}
                  </TableCell>
                ) : null}
                {show("source") ? (
                  <TableCell
                    className="text-muted-foreground"
                    onClick={can.source ? (e) => e.stopPropagation() : undefined}
                  >
                    {can.source
                      ? inlineMenu(
                          sourceChip(item),
                          t("table.editSource", { name: item.fullName }),
                          sourceMenu(item),
                        )
                      : sourceChip(item)}
                  </TableCell>
                ) : null}
                {show("assignedTo") ? (
                  <TableCell
                    className="text-muted-foreground"
                    onClick={can.assign ? (e) => e.stopPropagation() : undefined}
                  >
                    {can.assign
                      ? inlineMenu(
                          assigneeText(item),
                          t("table.editAssignee", { name: item.fullName }),
                          assigneeMenu(item),
                        )
                      : assigneeText(item)}
                  </TableCell>
                ) : null}
                {show("followup") ? <TableCell>{followupCell(item)}</TableCell> : null}
                {show("lastContact") ? (
                  <TableCell
                    className="text-muted-foreground tabular-nums"
                    title={item.lastContactedAt ? dayTime(item.lastContactedAt) : undefined}
                  >
                    {item.lastContactedAt ? day(item.lastContactedAt) : "—"}
                  </TableCell>
                ) : null}
                {show("created") ? (
                  <TableCell className="text-muted-foreground" title={dayTime(item.createdAt)}>
                    {day(item.createdAt)}
                  </TableCell>
                ) : null}
                {show("updated") ? (
                  <TableCell className="text-muted-foreground" title={dayTime(item.updatedAt)}>
                    {day(item.updatedAt)}
                  </TableCell>
                ) : null}
                <TableCell className="w-10" />
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* ── Mobile : cartes cochables (règle « tableaux → cartes ») ── */}
      <ul className="divide-y divide-border/60 md:hidden">
        {items.map((item) => (
          <li key={item.id} className="flex min-h-[52px] items-center gap-1.5 px-3">
            {can.bulk ? (
              <span className="-ml-2 flex size-11 shrink-0 items-center justify-center">
                {/* after:-inset-3.5 : la zone de frappe du Checkbox remplit les 44px. */}
                <Checkbox
                  checked={selected.has(item.id)}
                  onCheckedChange={() => toggleOne(item.id)}
                  aria-label={t("table.selectRow", { name: item.fullName })}
                  className="after:-inset-3.5"
                />
              </span>
            ) : null}
            <Link href={`/clients/${item.id}`} className="min-w-0 flex-1 py-2">
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className={cn(
                    "size-2.5 shrink-0 rounded-full",
                    !item.categoryColor && "bg-muted-foreground/25",
                  )}
                  style={item.categoryColor ? { backgroundColor: item.categoryColor } : undefined}
                />
                <span className="truncate text-sm font-semibold">{item.fullName}</span>
                {item.nextFollowupAt && Date.parse(item.nextFollowupAt) < now ? (
                  <ClockAlertIcon
                    className="size-3.5 shrink-0 text-destructive"
                    aria-label={t("list.filters.late")}
                  />
                ) : null}
                {item.doNotCall ? (
                  <PhoneOffIcon
                    className="size-3.5 shrink-0 text-destructive"
                    aria-label={t("list.doNotCall")}
                  />
                ) : null}
              </span>
              <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                <span className="tabular-nums">{phoneCell(item)}</span>
                {item.city ? <span className="truncate">{item.city}</span> : null}
                <span className="shrink-0">
                  {t("table.createdShort", { date: day(item.createdAt) })}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>

      {/* ── Barre d'actions en masse (admin) ── */}
      {can.bulk && selected.size > 0 ? (
        <div className="fixed inset-x-3 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-30 mx-auto max-w-3xl animate-in rounded-xl border bg-background/95 p-2 shadow-lg ring-1 ring-border/60 backdrop-blur duration-200 fade-in-0 slide-in-from-bottom-3 md:bottom-6">
          <div className="flex items-center gap-2">
            <span className="shrink-0 px-1.5 text-sm font-medium tabular-nums">
              {t("bulk.selected", { count: selected.size })}
            </span>

            <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto [scrollbar-width:none] md:flex-wrap [&::-webkit-scrollbar]:hidden">
            {/* Chaque geste de la barre a SA case : assigner, reclasser,
                changer la source et supprimer ne se donnent pas ensemble. */}
            {can.assign ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<Button variant="outline" className="min-h-11 md:min-h-8" disabled={pending} />}
                >
                  <UserRoundPlusIcon />
                  {t("bulk.assign")}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-48">
                  {users.map((u) => (
                    <DropdownMenuItem
                      key={u.value}
                      className="min-h-10"
                      onClick={() => runBulk((ids) => bulkAssignClientsAction(ids, u.value), "bulk.assigned")}
                    >
                      {u.label}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="min-h-10"
                    onClick={() => runBulk((ids) => bulkAssignClientsAction(ids, null), "bulk.assigned")}
                  >
                    {t("list.unassigned")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}

            {/* Inscrire la sélection à une campagne. Absent s'il n'y en a
                aucune : un menu vide se clique une fois, jamais deux. */}
            {can.campaign && campaigns.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button variant="outline" className="min-h-11 md:min-h-8" disabled={pending} />
                  }
                >
                  <MegaphoneIcon />
                  {t("bulk.campaign")}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-48">
                  {campaigns.map((c) => (
                    <DropdownMenuItem
                      key={c.value}
                      className="min-h-10"
                      onClick={() => enrollSelection(c.value, c.label)}
                    >
                      {c.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}

            {can.category ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<Button variant="outline" className="min-h-11 md:min-h-8" disabled={pending} />}
                >
                  <TagsIcon />
                  {t("bulk.category")}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-48">
                  {categories.map((c) => (
                    <DropdownMenuItem
                      key={c.id}
                      className="min-h-10"
                      onClick={() =>
                        runBulk((ids) => bulkSetClientsCategoryAction(ids, c.id), "bulk.categorized")
                      }
                    >
                      <span
                        aria-hidden
                        className="size-2.5 rounded-full"
                        style={{ backgroundColor: c.color }}
                      />
                      {c.label}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="min-h-10"
                    onClick={() =>
                      runBulk((ids) => bulkSetClientsCategoryAction(ids, null), "bulk.categorized")
                    }
                  >
                    <span aria-hidden className="size-2.5 rounded-full bg-muted-foreground/40" />
                    {t("detail.noCategory")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}

            {can.source ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<Button variant="outline" className="min-h-11 md:min-h-8" disabled={pending} />}
                >
                  <MegaphoneIcon />
                  {t("bulk.source")}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-48">
                  {sources.map((s) => (
                    <DropdownMenuItem
                      key={s.value}
                      className="min-h-10"
                      onClick={() =>
                        runBulk(
                          (ids) => bulkSetClientsSourceAction(ids, Number(s.value)),
                          "bulk.sourced",
                        )
                      }
                    >
                      {s.color ? (
                        <span
                          aria-hidden
                          className="size-2.5 rounded-full"
                          style={{ backgroundColor: s.color }}
                        />
                      ) : null}
                      {s.label}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="min-h-10"
                    onClick={() =>
                      runBulk((ids) => bulkSetClientsSourceAction(ids, null), "bulk.sourced")
                    }
                  >
                    {t("list.filters.noSource")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}

            {can.delete ? (
              <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
                <AlertDialogTrigger
                  render={<Button variant="destructive" className="min-h-11 md:min-h-8" disabled={pending} />}
                >
                  <Trash2Icon />
                  {t("bulk.delete")}
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t("bulk.deleteTitle")}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("bulk.deleteDescription", { count: selected.size })}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("delete.cancel")}</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      className="bg-destructive text-white hover:bg-destructive/90"
                      disabled={pending}
                      onClick={() => runBulk(bulkDeleteClientsAction, "bulk.deleted")}
                    >
                      {t("delete.confirm")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : null}
            </div>

            <Button
              variant="ghost"
              className="size-11 shrink-0 md:size-8"
              aria-label={t("bulk.clear")}
              disabled={pending}
              onClick={clearSelection}
            >
              <XIcon />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
