"use client";

import { ArrowDown, ArrowRight, ChevronRight, ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import type {
  AuditChangeView,
  AuditEntryView,
  AuditValueView,
} from "@/app/(app)/admin/audit/audit-view";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * Journal d'audit : chaque entrée est cliquable et s'ouvre sur le détail
 * « avant → après ». Tout est déjà mis en forme côté serveur — ce fichier ne
 * fait qu'afficher et gérer l'ouverture.
 */

function ValueChip({ value, tone }: { value: AuditValueView; tone: "from" | "to" }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full min-w-0 items-start gap-1.5 rounded-md px-2 py-1 text-sm break-words whitespace-pre-wrap",
        tone === "from" ? "bg-muted text-muted-foreground" : "bg-primary/10 font-medium",
        value.empty && "italic",
      )}
    >
      {value.swatch ? (
        <span
          className="mt-1 size-3 shrink-0 rounded-full ring-1 ring-foreground/20"
          style={{ backgroundColor: value.swatch }}
        />
      ) : null}
      <span className="min-w-0 break-words">{value.text}</span>
    </span>
  );
}

function ChangeRow({ change }: { change: AuditChangeView }) {
  return (
    <li className="rounded-lg bg-card p-3 ring-1 ring-foreground/10">
      <p className="text-xs font-medium text-muted-foreground">{change.label}</p>
      <div className="mt-1.5 flex flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-2">
        <ValueChip value={change.from} tone="from" />
        <ArrowDown className="size-4 shrink-0 text-muted-foreground sm:hidden" aria-hidden />
        <ArrowRight className="hidden size-4 shrink-0 text-muted-foreground sm:block" aria-hidden />
        <ValueChip value={change.to} tone="to" />
      </div>
    </li>
  );
}

function AuditDetailDialog({
  entry,
  open,
  onOpenChange,
}: {
  entry: AuditEntryView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("admin");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] gap-3 overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="pr-8">{entry.actionLabel}</DialogTitle>
          <DialogDescription>
            <span className="font-mono text-xs">{entry.action}</span>
          </DialogDescription>
        </DialogHeader>

        {/* ── Qui, quand, sur quoi, d'où ── */}
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted-foreground">{t("audit.date")}</dt>
            <dd className="text-sm">
              <time dateTime={entry.dateIso}>{entry.dateLabel}</time>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t("audit.user")}</dt>
            <dd className={cn("text-sm", entry.isSystem && "text-muted-foreground italic")}>
              {entry.userLabel}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">{t("audit.entity")}</dt>
            <dd className="text-sm break-words">
              {entry.entityLabel ? (
                <>
                  {entry.entityHref ? (
                    <Link
                      href={entry.entityHref}
                      className="inline-flex min-h-11 items-center gap-1 underline underline-offset-4 sm:min-h-0"
                    >
                      {entry.entityName ?? entry.entityLabel}
                      <ExternalLink className="size-3.5" aria-hidden />
                    </Link>
                  ) : (
                    (entry.entityName ?? entry.entityLabel)
                  )}
                  {entry.entityId ? (
                    <span className="ml-1 block font-mono text-[11px] break-all text-muted-foreground">
                      {entry.entityName ? `${entry.entityLabel} · ${entry.entityId}` : entry.entityId}
                    </span>
                  ) : null}
                </>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t("audit.ip")}</dt>
            <dd className="font-mono text-sm break-all">
              {entry.ip ?? <span className="text-muted-foreground">—</span>}
            </dd>
          </div>
        </dl>

        {/* ── Ce qui a changé ── */}
        <section className="space-y-2">
          <h3 className="text-sm font-medium">{t("audit.changesTitle")}</h3>
          {entry.changes.length > 0 ? (
            <ul className="space-y-2">
              {entry.changes.map((change) => (
                <ChangeRow key={change.field} change={change} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t("audit.noChanges")}</p>
          )}
        </section>

        {/* ── Contexte (entrées anciennes, informations complémentaires) ── */}
        {entry.facts.length > 0 ? (
          <section className="space-y-2">
            <h3 className="text-sm font-medium">{t("audit.context")}</h3>
            <dl className="space-y-1.5">
              {entry.facts.map((fact) => (
                <div key={fact.key} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
                  <dt className="text-xs text-muted-foreground sm:w-40 sm:shrink-0 sm:text-sm">
                    {fact.label}
                  </dt>
                  <dd className="min-w-0 text-sm break-words">
                    {fact.value.swatch ? (
                      <span
                        className="mr-1.5 inline-block size-3 rounded-full align-middle ring-1 ring-foreground/20"
                        style={{ backgroundColor: fact.value.swatch }}
                      />
                    ) : null}
                    <span className={cn(fact.value.empty && "text-muted-foreground")}>
                      {fact.value.text}
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}

        {/* ── JSON brut (toujours disponible, jamais imposé) ── */}
        {entry.rawJson ? (
          <details className="group">
            <summary className="inline-flex min-h-11 cursor-pointer items-center text-xs text-muted-foreground select-none hover:text-foreground sm:min-h-0">
              {t("audit.rawJson")}
            </summary>
            <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">
              {entry.rawJson}
            </pre>
          </details>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Ligne du tableau (desktop) : toute la ligne ouvre le détail, le bouton aussi. */
export function AuditDetailRow({
  entry,
  children,
}: {
  entry: AuditEntryView;
  children: ReactNode;
}) {
  const t = useTranslations("admin");
  const [open, setOpen] = useState(false);
  const describe = t("audit.detailsFor", { action: entry.actionLabel, date: entry.dateLabel });

  return (
    <>
      <TableRow className="cursor-pointer" onClick={() => setOpen(true)}>
        {children}
        <TableCell className="w-px text-right">
          <Button
            variant="ghost"
            size="sm"
            className="min-h-11 gap-1 px-3"
            aria-label={describe}
            onClick={() => setOpen(true)}
          >
            {t("audit.details")}
            <ChevronRight className="size-4" aria-hidden />
          </Button>
        </TableCell>
      </TableRow>
      <AuditDetailDialog entry={entry} open={open} onOpenChange={setOpen} />
    </>
  );
}

/** Carte (mobile) : la carte entière est un bouton — cible tactile pleine largeur. */
export function AuditDetailCard({
  entry,
  children,
}: {
  entry: AuditEntryView;
  children: ReactNode;
}) {
  const t = useTranslations("admin");
  const [open, setOpen] = useState(false);
  const describe = t("audit.detailsFor", { action: entry.actionLabel, date: entry.dateLabel });

  return (
    <>
      <button
        type="button"
        aria-label={describe}
        onClick={() => setOpen(true)}
        className="w-full space-y-1.5 rounded-xl bg-card p-4 text-left ring-1 ring-foreground/10 transition-colors active:bg-muted/60"
      >
        {children}
        <span className="flex items-center gap-1 pt-1 text-xs font-medium text-primary">
          {t("audit.details")}
          <ChevronRight className="size-3.5" aria-hidden />
        </span>
      </button>
      <AuditDetailDialog entry={entry} open={open} onOpenChange={setOpen} />
    </>
  );
}
