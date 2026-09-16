"use client";

import { addDays, format } from "date-fns";
import { enUS, fr } from "date-fns/locale";
import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";
import { CalendarClockIcon, CheckIcon, PencilIcon, PlusIcon, UserRoundIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  completeFollowupAction,
  createFollowupAction,
  updateFollowupAction,
  type ActionResult,
} from "@/app/(app)/clients/actions";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { emitDataChange } from "@/lib/live";
import { cn } from "@/lib/utils";
import { APP_TZ } from "./timezone";

/** Un collègue à qui ce suivi peut revenir. */
export type FollowupPerson = { id: string; name: string };

export type FollowupData = {
  id: string;
  dueAt: string; // ISO
  note: string | null;
  doneAt: string | null; // ISO
  /** Computed server-side at render time. */
  overdue: boolean;
  /** À qui la tâche revient. `null` seulement si le compte a disparu. */
  assignee: FollowupPerson | null;
};

/** Préfixe des lignes optimistes (pas encore d'id serveur). */
const DRAFT_PREFIX = "draft:";

export function FollowupsCard({
  clientId,
  followups,
  canManage,
  candidates,
  currentUserId,
}: {
  clientId: string;
  followups: FollowupData[];
  /** Créer, déplacer, terminer un suivi sur CETTE fiche. Sinon : lecture. */
  canManage: boolean;
  /**
   * Les collègues à qui CETTE fiche est ouverte et qui peuvent clore un suivi
   * (`followupCandidates`, côté serveur). L'auteur en fait toujours partie —
   * il voit la fiche, sinon il ne serait pas là.
   */
  candidates: FollowupPerson[];
  currentUserId: string;
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
  // Un suivi se pose d'abord pour SOI : c'est le geste d'après-appel. Partager
  // est un second geste, et il se voit.
  const [picked, setPicked] = useState<string[]>([currentUserId]);
  const [handTo, setHandTo] = useState(currentUserId);

  // Seul à pouvoir porter ce suivi : la question « pour qui » ne se pose pas,
  // et une case unique cochée d'avance n'apprend rien à personne.
  const shared = candidates.length > 1;
  const nameOf = (person: FollowupPerson | null): string =>
    person ? (person.id === currentUserId ? t("followups.you") : person.name) : "—";

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
              : res.error === "invalidAssignee"
                ? t("errors.invalidAssignee")
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
    setPicked([currentUserId]);
    setCreateOpen(true);
  };

  const openEdit = (f: FollowupData) => {
    const zoned = toZonedTime(new Date(f.dueAt), APP_TZ);
    setDate(format(zoned, "yyyy-MM-dd"));
    setTime(format(zoned, "HH:mm"));
    setHandTo(f.assignee?.id ?? currentUserId);
    setEditId(f.id);
  };

  const togglePicked = (id: string, checked: boolean) =>
    setPicked((current) =>
      checked ? [...new Set([...current, id])] : current.filter((x) => x !== id),
    );

  /** Échéance saisie (heure locale Toronto) en ISO UTC — pour l'affichage optimiste. */
  const draftDueIso = (d: string, tm: string) => fromZonedTime(`${d}T${tm}:00`, APP_TZ).toISOString();

  const submitCreate = () => {
    if (picked.length === 0) return;
    const dueAt = draftDueIso(date, time);
    const overdue = Date.parse(dueAt) < Date.now();
    // Une ligne par destinataire, à l'écran comme en base : c'est exactement ce
    // que le serveur va écrire, et chacun terminera la sienne.
    const drafts: FollowupData[] = picked.map((id, i) => ({
      id: `${DRAFT_PREFIX}${Date.now()}:${i}`,
      dueAt,
      note: note.trim() || null,
      doneAt: null,
      overdue,
      assignee: candidates.find((c) => c.id === id) ?? null,
    }));
    const payload = {
      clientId,
      date,
      time,
      note: note || undefined,
      assigneeIds: picked,
    };
    setCreateOpen(false);
    mutate(
      (current) => [...current, ...drafts],
      () => createFollowupAction(payload),
      t("followups.created"),
    );
  };

  const submitEdit = () => {
    if (!editId) return;
    const id = editId;
    const current = rows.find((f) => f.id === id) ?? null;
    const dueAt = draftDueIso(date, time);
    const handedOver = shared && handTo !== (current?.assignee?.id ?? currentUserId);
    const nextAssignee = candidates.find((c) => c.id === handTo) ?? current?.assignee ?? null;
    const payload = {
      followupId: id,
      date,
      time,
      ...(shared ? { assigneeId: handTo } : {}),
    };
    setEditId(null);
    mutate(
      (list) =>
        list.map((f) =>
          f.id === id
            ? {
                ...f,
                dueAt,
                overdue: !f.doneAt && Date.parse(dueAt) < Date.now(),
                assignee: nextAssignee,
              }
            : f,
        ),
      () => updateFollowupAction(payload),
      handedOver
        ? t("followups.handedOver", { name: nameOf(nextAssignee) })
        : t("followups.updated"),
    );
  };

  const complete = (id: string) => {
    const doneAt = new Date().toISOString();
    mutate(
      (list) => list.map((f) => (f.id === id ? { ...f, doneAt, overdue: false } : f)),
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
                // À qui la tâche revient. On le tait quand il n'y a personne
                // d'autre à qui elle pourrait revenir — une mention « Moi » sur
                // chaque ligne d'un bureau d'une personne n'apprend rien.
                const showsWho = shared || f.assignee?.id !== currentUserId;
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
                      {showsWho ? (
                        <p className="flex items-center gap-1 text-xs text-muted-foreground">
                          {/* Le mot « Pour » disparaît de l'écran, pas de la
                              phrase : le pictogramme le porte à l'œil, et la
                              ligne lue à voix haute reste entière. Le NOM, lui,
                              n'est jamais remplacé par un dessin. */}
                          <UserRoundIcon className="size-3 shrink-0" aria-hidden />
                          <span className="sr-only">
                            {t("followups.forPerson", { name: nameOf(f.assignee) })}
                          </span>
                          <span className="truncate" aria-hidden>
                            {nameOf(f.assignee)}
                          </span>
                        </p>
                      ) : null}
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
                          aria-label={t("followups.edit")}
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
                  {shared || f.assignee?.id !== currentUserId ? (
                    <span className="ml-2 inline-flex items-center gap-1">
                      <UserRoundIcon className="size-3 shrink-0" aria-hidden />
                      <span className="sr-only">
                        {t("followups.forPerson", { name: nameOf(f.assignee) })}
                      </span>
                      <span aria-hidden>{nameOf(f.assignee)}</span>
                    </span>
                  ) : null}
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
        {/* « Pour qui » fait grandir la boîte avec l'équipe. Sur un téléphone,
            une boîte plus haute que l'écran cache son bouton « Créer » sans
            rien à faire défiler — elle se borne donc à la hauteur visible. */}
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
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
            {/* « Pour qui » : coché sur soi d'avance, parce que c'est le cas de
                loin le plus courant — on se note un rappel après un appel. La
                liste n'apparaît que s'il y a vraiment quelqu'un d'autre. */}
            {shared ? (
              <fieldset className="space-y-1.5">
                {/* Le titre de section n'est plus peint : une colonne de noms
                    cochables sous une date, dans une boîte « Ajouter un suivi »,
                    ne se confond avec rien. Il reste dans l'arbre
                    d'accessibilité, où l'œil ne peut pas suppléer. */}
                <legend className="sr-only">{t("followups.assignees")}</legend>
                <ul className="max-h-48 space-y-0.5 overflow-y-auto border-t pt-2">
                  {candidates.map((person) => (
                    <li key={person.id} className="flex min-h-11 items-center gap-3">
                      <Checkbox
                        id={`fu-who-${person.id}`}
                        checked={picked.includes(person.id)}
                        onCheckedChange={(checked) => togglePicked(person.id, checked === true)}
                        className="after:-inset-3.5"
                      />
                      <Label
                        htmlFor={`fu-who-${person.id}`}
                        className="flex flex-1 items-center gap-2 font-normal"
                      >
                        <UserRoundIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        {nameOf(person)}
                      </Label>
                    </li>
                  ))}
                </ul>
              </fieldset>
            ) : null}
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
            {/* Planifier un rappel est un geste D'APRÈS-APPEL, fait le
                téléphone à la main : deux boutons de 32 px au bas d'une
                boîte de dialogue n'y suffisent pas. Le bureau garde les
                siens. */}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-11 md:min-h-8"
                onClick={() => setCreateOpen(false)}
              >
                {t("followups.cancel")}
              </Button>
              <Button
                type="submit"
                className="min-h-11 md:min-h-8"
                disabled={pending || picked.length === 0}
              >
                {t("followups.create")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit dialog — échéance et destinataire */}
      <Dialog open={editId !== null} onOpenChange={(o) => !o && setEditId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("followups.edit")}</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              submitEdit();
            }}
          >
            {dateTimeFields}
            {/* Une ligne = une personne : on la PASSE, on ne la partage pas
                ici. Partager se fait en créant un suivi par personne. */}
            {shared ? (
              <div className="space-y-1.5">
                <Select
                  items={candidates.map((c) => ({ value: c.id, label: nameOf(c) }))}
                  value={handTo}
                  onValueChange={(value) => setHandTo(value ?? currentUserId)}
                >
                  {/* Le nom affiché EST le libellé ; « Confier à » au-dessus ne
                      faisait que le répéter en plus long. Le pictogramme dit
                      « quelqu'un », le nom dit qui, et l'étiquette d'accessi-
                      bilité dit la phrase entière à qui ne voit pas l'icône. */}
                  <SelectTrigger
                    id="fu-hand"
                    className="min-h-11 w-full md:min-h-8"
                    aria-label={t("followups.assignees")}
                  >
                    <UserRoundIcon className="text-muted-foreground" aria-hidden />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {candidates.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {nameOf(c)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-11 md:min-h-8"
                onClick={() => setEditId(null)}
              >
                {t("followups.cancel")}
              </Button>
              <Button type="submit" className="min-h-11 md:min-h-8" disabled={pending}>
                {t("followups.edit")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
