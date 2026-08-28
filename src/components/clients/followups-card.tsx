"use client";

import { addDays, format } from "date-fns";
import { enUS, fr } from "date-fns/locale";
import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";
import { CalendarClockIcon, CheckIcon, PencilIcon, PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  completeFollowupAction,
  createFollowupAction,
  updateFollowupDueAction,
  type ActionResult,
} from "@/app/(app)/clients/actions";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { emitDataChange } from "@/lib/live";
import { cn } from "@/lib/utils";
import { APP_TZ } from "./timezone";

export type FollowupData = {
  id: string;
  dueAt: string; // ISO
  note: string | null;
  doneAt: string | null; // ISO
  /** Computed server-side at render time. */
  overdue: boolean;
};

/** Préfixe des lignes optimistes (pas encore d'id serveur). */
const DRAFT_PREFIX = "draft:";

export function FollowupsCard({
  clientId,
  followups,
  canManage,
}: {
  clientId: string;
  followups: FollowupData[];
  /** Créer, déplacer, terminer un suivi sur CETTE fiche. Sinon : lecture. */
  canManage: boolean;
}) {
  const t = useTranslations("clients");
  const locale = useLocale();
  const dfnsLocale = locale === "en" ? enUS : fr;
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [createOpen, setCreateOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const tomorrow = format(addDays(new Date(), 1), "yyyy-MM-dd");
  const [date, setDate] = useState(tomorrow);
  const [time, setTime] = useState("09:00");
  const [note, setNote] = useState("");

  // ── État optimiste ─────────────────────────────────────────────────────────
  // Les suivis s'affichent instantanément (créé / terminé / échéance déplacée)
  // et reviennent en arrière avec un toast si le serveur refuse.
  const [rows, setRows] = useState<FollowupData[]>(followups);
  const inFlightRef = useRef(0);
  useEffect(() => {
    // Resynchronisation serveur seulement hors mutation en vol : un sondage de
    // fond ne doit jamais effacer une action que l'utilisateur vient de faire.
    if (inFlightRef.current === 0 && !pending) setRows(followups);
  }, [followups, pending]);

  /** Exécute une mutation optimiste : applique `next`, restaure en cas d'échec. */
  const mutate = (
    next: (current: FollowupData[]) => FollowupData[],
    run: () => Promise<ActionResult>,
    successMessage: string,
  ) => {
    // Sans le droit, aucun bouton n'existe : ce garde-fou couvre le raccourci
    // clavier et l'écran resté ouvert pendant qu'un rôle changeait.
    if (!canManage) return;
    let snapshot: FollowupData[] = [];
    setRows((current) => {
      snapshot = current;
      return next(current);
    });
    inFlightRef.current += 1;
    startTransition(async () => {
      const res = await run();
      inFlightRef.current -= 1;
      if (res.ok) {
        toast.success(successMessage);
        // Le prochain suivi change la ligne du panneau et la carte pipeline.
        emitDataChange("followups");
        router.refresh();
      } else {
        setRows(snapshot);
        toast.error(
          res.error === "forbidden"
            ? t("access.noRight")
            : res.error === "notFound"
              ? t("errors.notFound")
              : t("errors.generic"),
        );
      }
    });
  };

  const { open, done } = useMemo(() => {
    const sorted = [...rows];
    return {
      open: sorted
        .filter((f) => !f.doneAt)
        .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt)),
      done: sorted
        .filter((f) => f.doneAt)
        .sort((a, b) => Date.parse(b.doneAt ?? "") - Date.parse(a.doneAt ?? ""))
        .slice(0, 5),
    };
  }, [rows]);

  const fmtDue = (iso: string) =>
    formatInTimeZone(new Date(iso), APP_TZ, "EEE d MMM yyyy, HH:mm", { locale: dfnsLocale });

  const openCreate = () => {
    setDate(tomorrow);
    setTime("09:00");
    setNote("");
    setCreateOpen(true);
  };

  const openEdit = (f: FollowupData) => {
    const zoned = toZonedTime(new Date(f.dueAt), APP_TZ);
    setDate(format(zoned, "yyyy-MM-dd"));
    setTime(format(zoned, "HH:mm"));
    setEditId(f.id);
  };

  /** Échéance saisie (heure locale Toronto) en ISO UTC — pour l'affichage optimiste. */
  const draftDueIso = (d: string, tm: string) => fromZonedTime(`${d}T${tm}:00`, APP_TZ).toISOString();

  const submitCreate = () => {
    const dueAt = draftDueIso(date, time);
    const draft: FollowupData = {
      id: `${DRAFT_PREFIX}${Date.now()}`,
      dueAt,
      note: note.trim() || null,
      doneAt: null,
      overdue: Date.parse(dueAt) < Date.now(),
    };
    const payload = { clientId, date, time, note: note || undefined };
    setCreateOpen(false);
    mutate(
      (current) => [...current, draft],
      () => createFollowupAction(payload),
      t("followups.created"),
    );
  };

  const submitEdit = () => {
    if (!editId) return;
    const id = editId;
    const dueAt = draftDueIso(date, time);
    const payload = { followupId: id, date, time };
    setEditId(null);
    mutate(
      (current) =>
        current.map((f) =>
          f.id === id ? { ...f, dueAt, overdue: !f.doneAt && Date.parse(dueAt) < Date.now() } : f,
        ),
      () => updateFollowupDueAction(payload),
      t("followups.updated"),
    );
  };

  const complete = (id: string) => {
    const doneAt = new Date().toISOString();
    mutate(
      (current) => current.map((f) => (f.id === id ? { ...f, doneAt, overdue: false } : f)),
      () => completeFollowupAction(id),
      t("followups.completed"),
    );
  };

  const dateTimeFields = (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1.5">
        <Label htmlFor="fu-date">{t("followups.date")}</Label>
        <Input
          id="fu-date"
          type="date"
          className="min-h-11 md:min-h-8"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          required
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="fu-time">{t("followups.time")}</Label>
        <Input
          id="fu-time"
          type="time"
          className="min-h-11 md:min-h-8"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          required
        />
      </div>
    </div>
  );

  return (
    <Card className="shadow-xs">
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2">
          <CalendarClockIcon className="size-4 text-muted-foreground" />
          {t("followups.title")}
        </CardTitle>
        {canManage ? (
          <CardAction>
            <Button variant="outline" size="sm" className="min-h-11 md:min-h-7" onClick={openCreate}>
              <PlusIcon />
              {t("followups.add")}
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {open.length === 0 && done.length === 0 ? (
          <EmptyState icon={<CalendarClockIcon />} title={t("followups.empty")} className="py-6" />
        ) : null}

        {open.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              {t("followups.openSection")}
            </p>
            <ul className="space-y-2">
              {open.map((f) => {
                const overdue = f.overdue;
                // Ligne optimiste : pas encore d'id serveur, actions inertes.
                const isDraft = f.id.startsWith(DRAFT_PREFIX);
                return (
                  <li
                    key={f.id}
                    className={cn(
                      "flex items-center gap-2 rounded-lg border py-2 pr-1.5 pl-3 transition hover:bg-muted/40",
                      overdue && "border-l-4 border-l-destructive bg-destructive/5",
                      isDraft && "opacity-60",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <p
                        className={cn(
                          "text-sm font-medium tabular-nums",
                          overdue && "text-destructive",
                        )}
                      >
                        {fmtDue(f.dueAt)}
                        {overdue ? (
                          <span className="ml-2 inline-flex items-center rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-semibold text-destructive uppercase">
                            {t("followups.overdue")}
                          </span>
                        ) : null}
                      </p>
                      {f.note ? (
                        <p className="truncate text-xs text-muted-foreground">{f.note}</p>
                      ) : null}
                    </div>
                    {/* Déplacer et terminer : des gestes, donc rien à afficher
                        quand ils sont fermés — un bouton grisé n'apprend rien. */}
                    {canManage ? (
                      <>
                        <Button
                          variant="ghost"
                          className="size-11 md:size-8"
                          aria-label={t("followups.editDue")}
                          disabled={isDraft}
                          onClick={() => openEdit(f)}
                        >
                          <PencilIcon className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          className="size-11 text-emerald-600 md:size-8"
                          aria-label={t("followups.complete")}
                          disabled={isDraft}
                          onClick={() => complete(f.id)}
                        >
                          <CheckIcon className="size-5" />
                        </Button>
                      </>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        {done.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              {t("followups.doneSection")}
            </p>
            <ul className="space-y-1.5">
              {done.map((f) => (
                <li key={f.id} className="text-xs text-muted-foreground">
                  <span className="line-through">{fmtDue(f.dueAt)}</span>
                  {f.note ? <span className="ml-2 line-through">{f.note}</span> : null}
                  {f.doneAt ? (
                    <span className="ml-2">
                      {t("followups.doneAt", {
                        date: formatInTimeZone(new Date(f.doneAt), APP_TZ, "d MMM HH:mm", {
                          locale: dfnsLocale,
                        }),
                      })}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("followups.add")}</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              submitCreate();
            }}
          >
            {dateTimeFields}
            <div className="space-y-1.5">
              <Label htmlFor="fu-note">{t("followups.note")}</Label>
              <Textarea
                id="fu-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t("followups.notePlaceholder")}
                maxLength={1000}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                {t("followups.cancel")}
              </Button>
              <Button type="submit" disabled={pending}>
                {t("followups.create")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit due date dialog */}
      <Dialog open={editId !== null} onOpenChange={(o) => !o && setEditId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("followups.editDue")}</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              submitEdit();
            }}
          >
            {dateTimeFields}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditId(null)}>
                {t("followups.cancel")}
              </Button>
              <Button type="submit" disabled={pending}>
                {t("followups.editDue")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
