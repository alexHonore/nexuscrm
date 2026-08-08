"use client";

import { formatInTimeZone } from "date-fns-tz";
import { enUS, fr } from "date-fns/locale";
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  PhoneOffIcon,
  TagsIcon,
  Trash2Icon,
  UserRoundPlusIcon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  bulkAssignClientsAction,
  bulkDeleteClientsAction,
  bulkSetClientsCategoryAction,
  type BulkResult,
} from "@/app/(app)/clients/actions";
import type { ClientListItem } from "@/components/clients/client-list-nav";
import type { FilterOption } from "@/components/clients/clients-filters";
import type { PanelCategory } from "@/components/clients/clients-workspace";
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
import { emitDataChange } from "@/lib/live";
import { formatPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";

export type ClientSortKey = "activity" | "name" | "createdAt" | "updatedAt";
export type ClientSortDir = "asc" | "desc";

/**
 * Vue tableau de /clients : colonnes triables (nom, création, modification) et,
 * pour l'admin seulement, sélection multiple + barre d'actions en masse
 * (assigner, catégoriser, supprimer). Le serveur refuse de toute façon ces
 * actions aux téléphonistes — la sélection cachée n'est pas la protection.
 * Mobile : le tableau devient une liste de cartes cochables.
 */
export function ClientsTable({
  items,
  loading,
  isAdmin,
  categories,
  sources,
  users,
  sortKey,
  sortDir,
  onSort,
}: {
  items: ClientListItem[];
  loading: boolean;
  isAdmin: boolean;
  categories: PanelCategory[];
  sources: FilterOption[];
  users: FilterOption[];
  sortKey: ClientSortKey;
  sortDir: ClientSortDir;
  onSort: (key: Exclude<ClientSortKey, "activity">) => void;
}) {
  const t = useTranslations("clients");
  const locale = useLocale();
  const router = useRouter();
  const dfnsLocale = locale === "en" ? enUS : fr;
  const [pending, startTransition] = useTransition();
  const [deleteOpen, setDeleteOpen] = useState(false);

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
  const sourceLabels = useMemo(() => new Map(sources.map((s) => [s.value, s.label])), [sources]);
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

  /** Exécute une action en masse et rafraîchit les listes en cas de succès. */
  const runBulk = (run: (ids: string[]) => Promise<BulkResult>, successKey: string) => {
    const ids = [...selected];
    if (ids.length === 0) return;
    startTransition(async () => {
      const res = await run(ids);
      if (res.ok) {
        toast.success(t(successKey, { count: res.count }));
        setDeleteOpen(false);
        clearSelection();
        emitDataChange("clients");
        router.refresh();
      } else {
        toast.error(res.error === "forbidden" ? t("errors.forbidden") : t("errors.generic"));
      }
    });
  };

  const sortHead = (key: Exclude<ClientSortKey, "activity">, label: string) => (
    <button
      type="button"
      onClick={() => onSort(key)}
      className="inline-flex min-h-8 items-center gap-1 hover:text-foreground"
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

  const categoryChip = (item: ClientListItem) => {
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

  if (loading) {
    return (
      <div className="space-y-1.5 p-3">
        {Array.from({ length: 10 }, (_, i) => (
          <Skeleton key={i} className="h-11 w-full rounded-lg" />
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
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {isAdmin ? (
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
              <TableHead>{t("table.phone")}</TableHead>
              <TableHead>{t("table.category")}</TableHead>
              <TableHead>{t("table.city")}</TableHead>
              <TableHead>{t("table.source")}</TableHead>
              <TableHead>{t("table.assignedTo")}</TableHead>
              <TableHead>{sortHead("createdAt", t("table.created"))}</TableHead>
              <TableHead>{sortHead("updatedAt", t("table.updated"))}</TableHead>
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
                {isAdmin ? (
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
                <TableCell className="tabular-nums">{formatPhone(item.phone)}</TableCell>
                <TableCell>{categoryChip(item)}</TableCell>
                <TableCell className="max-w-36 truncate text-muted-foreground">
                  {item.city ?? "—"}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {(item.sourceId !== null ? sourceLabels.get(String(item.sourceId)) : null) ?? "—"}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {(item.assignedToId ? userLabels.get(item.assignedToId) : null) ??
                    t("list.unassigned")}
                </TableCell>
                <TableCell className="text-muted-foreground" title={dayTime(item.createdAt)}>
                  {day(item.createdAt)}
                </TableCell>
                <TableCell className="text-muted-foreground" title={dayTime(item.updatedAt)}>
                  {day(item.updatedAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* ── Mobile : cartes cochables (règle « tableaux → cartes ») ── */}
      <ul className="divide-y divide-border/60 md:hidden">
        {items.map((item) => (
          <li key={item.id} className="flex min-h-[52px] items-center gap-3 px-3">
            {isAdmin ? (
              <Checkbox
                checked={selected.has(item.id)}
                onCheckedChange={() => toggleOne(item.id)}
                aria-label={t("table.selectRow", { name: item.fullName })}
              />
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
                {item.doNotCall ? (
                  <PhoneOffIcon
                    className="size-3.5 shrink-0 text-destructive"
                    aria-label={t("list.doNotCall")}
                  />
                ) : null}
              </span>
              <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                <span className="tabular-nums">{formatPhone(item.phone)}</span>
                <span>{t("table.createdShort", { date: day(item.createdAt) })}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>

      {/* ── Barre d'actions en masse (admin) ── */}
      {isAdmin && selected.size > 0 ? (
        <div className="fixed inset-x-3 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-30 mx-auto max-w-3xl rounded-xl border bg-background/95 p-2 shadow-lg backdrop-blur md:bottom-6">
          <div className="flex flex-wrap items-center gap-2">
            <span className="px-1.5 text-sm font-medium tabular-nums">
              {t("bulk.selected", { count: selected.size })}
            </span>

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

            <Button
              variant="ghost"
              className="ml-auto size-11 md:size-8"
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
