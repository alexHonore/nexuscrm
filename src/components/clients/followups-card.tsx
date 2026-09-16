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
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
} from "@/components/ui/avatar";
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
  /**
   * Qui porte ce suivi — un, ou plusieurs. C'est UNE tâche : elle se déplace et
   * se termine d'un geste pour tout le monde. En base elle s'écrit une ligne
   * par personne (le tableau de bord et les rappels ne savent lire que ça) ;
   * la fiche, elle, les recolle (`groupFollowups`).
   */
  assignees: FollowupPerson[];
};

/** Deux lettres pour une pastille — même règle que le fil de commentaires. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** Pastilles au-delà desquelles on compte au lieu d'empiler. */
const FACES_SHOWN = 4;

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
  // est un second geste, et il se voit. La même liste sert à la création et à
  // la modification — un suivi se confie de la même façon des deux côtés.
  const [picked, setPicked] = useState<string[]>([currentUserId]);

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
    // La liste cochée EST celle des porteurs : cocher quelqu'un l'ajoute au
    // suivi, le décocher l'en retire. Une case qui ne ferait qu'ajouter
    // mentirait à moitié.
    setPicked(f.assignees.map((person) => person.id));
    setEditId(f.id);
  };

  /** Les personnes cochées, triées comme le serveur les rendra. */
  const pickedPeople = (): FollowupPerson[] =>
    candidates
      .filter((person) => picked.includes(person.id))
      .sort((a, b) => a.name.localeCompare(b.name, "fr"));

  const togglePicked = (id: string, checked: boolean) =>
    setPicked((current) =>
      checked ? [...new Set([...current, id])] : current.filter((x) => x !== id),
    );

  /** Échéance saisie (heure locale Toronto) en ISO UTC — pour l'affichage optimiste. */
  const draftDueIso = (d: string, tm: string) => fromZonedTime(`${d}T${tm}:00`, APP_TZ).toISOString();

  const submitCreate = () => {
    if (picked.length === 0) return;
    const dueAt = draftDueIso(date, time);
    // UN suivi, porté par les personnes cochées — c'est ce que la fiche
    // montrera une fois le serveur passé.
    const draft: FollowupData = {
      id: `${DRAFT_PREFIX}${Date.now()}`,
      dueAt,
      note: note.trim() || null,
      doneAt: null,
      overdue: Date.parse(dueAt) < Date.now(),
      assignees: pickedPeople(),
    };
    const payload = {
      clientId,
      date,
      time,
      note: note || undefined,
      assigneeIds: picked,
    };
    setCreateOpen(false);
    mutate(
      (current) => [...current, draft],
      () => createFollowupAction(payload),
      t("followups.created"),
    );
  };

  const submitEdit = () => {
    if (!editId || picked.length === 0) return;
    const id = editId;
    const dueAt = draftDueIso(date, time);
    const people = pickedPeople();
    const payload = {
      followupId: id,
      date,
      time,
      ...(shared ? { assigneeIds: picked } : {}),
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
                ...(shared ? { assignees: people } : {}),
              }
            : f,
        ),
      () => updateFollowupAction(payload),
      t("followups.updated"),
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

  /**
   * Les porteurs d'un suivi, en pastilles.
   *
   * Trois noms écrits en toutes lettres sous chaque échéance noyaient la carte
   * — c'est ce qui rendait un suivi partagé illisible. Les initiales tiennent
   * sur une ligne, quel que soit le nombre de personnes.
   *
   * Le dessin ne porte pas le sens tout seul : la phrase entière (« Pour Moi,
   * Marie Lavoie ») vit en `sr-only` et dans l'infobulle. C'est elle que lit un
   * lecteur d'écran, et elle que l'on obtient en survolant.
   */
  const faces = (people: FollowupPerson[]) => {
    const label = t("followups.forPerson", {
      name: people.map((person) => nameOf(person)).join(", "),
    });
    const shown = people.slice(0, FACES_SHOWN);
    return (
      <span className="flex items-center gap-1.5" title={label}>
        <span className="sr-only">{label}</span>
        {/* Le chevauchement de la pile par défaut (8 px) est taillé pour des
            pastilles de 32 px ; sur les nôtres, de 24, il les écrase en une
            tache illisible. 4 px laissent lire chaque paire d'initiales. */}
        <AvatarGroup aria-hidden className="-space-x-1">
          {shown.map((person) => (
            <Avatar key={person.id} size="sm">
              <AvatarFallback className="bg-primary/10 text-[10px] font-medium text-primary">
                {initials(person.name)}
              </AvatarFallback>
            </Avatar>
          ))}
          {people.length > shown.length ? (
            <AvatarGroupCount className="size-6 text-[10px]">
              +{people.length - shown.length}
            </AvatarGroupCount>
          ) : null}
        </AvatarGroup>
        {/* Seul, le nom s'écrit : une pastille isolée ne vaut pas la peine
            d'être déchiffrée. À plusieurs, les initiales suffisent — c'est le
            nombre et les visages qu'on lit, pas l'état civil. */}
        {people.length === 1 ? (
          <span className="truncate" aria-hidden>
            {nameOf(people[0])}
          </span>
        ) : null}
      </span>
    );
  };

  /**
   * Qui porte ce suivi. La MÊME pièce dans les deux boîtes : créer et confier
   * sont le même geste, et deux commandes différentes pour une seule question
   * obligeraient à réapprendre la seconde.
   *
   * Le préfixe d'identifiant sépare les deux boîtes : deux `id` identiques dans
   * la page feraient pointer chaque étiquette sur la mauvaise case.
   */
  const peopleField = (idPrefix: string) => (
    <fieldset className="space-y-1.5">
      {/* Le titre de section n'est plus peint : une colonne de noms cochables
          sous une date, dans une boîte « suivi », ne se confond avec rien. Il
          reste dans l'arbre d'accessibilité, où l'œil ne peut pas suppléer. */}
      <legend className="sr-only">{t("followups.assignees")}</legend>
      <ul className="max-h-48 space-y-0.5 overflow-y-auto border-t pt-2">
        {candidates.map((person) => (
          <li key={person.id} className="flex min-h-11 items-center gap-3">
            <Checkbox
              id={`fu-${idPrefix}-${person.id}`}
              checked={picked.includes(person.id)}
              onCheckedChange={(checked) => togglePicked(person.id, checked === true)}
              className="after:-inset-3.5"
            />
            <Label
              htmlFor={`fu-${idPrefix}-${person.id}`}
              className="flex flex-1 items-center gap-2 font-normal"
            >
              <UserRoundIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              {nameOf(person)}
            </Label>
          </li>
        ))}
      </ul>
    </fieldset>
  );

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
                // À qui la tâche revient. On le tait quand elle n'est qu'à soi
                // dans un bureau d'une personne — une pastille « moi » sur
                // chaque ligne n'apprend rien.
                const showsWho =
                  f.assignees.length > 1 || shared || f.assignees[0]?.id !== currentUserId;
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
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {faces(f.assignees)}
                        </div>
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
                  {f.assignees.length > 1 || shared || f.assignees[0]?.id !== currentUserId ? (
                    <span className="ml-2 inline-flex align-middle">{faces(f.assignees)}</span>
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
            {/* Coché sur soi d'avance : c'est le cas de loin le plus courant — on
                se note un rappel après un appel. La liste n'apparaît que s'il y
                a vraiment quelqu'un d'autre à qui le confier. */}
            {shared ? peopleField("new") : null}
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
            {/* Cocher quelqu'un de plus lui ouvre SA ligne, à la même échéance
                et avec la même note. Décocher n'efface rien : une tâche déjà
                annoncée à un collègue se termine sur sa propre ligne. */}
            {shared ? peopleField("edit") : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-11 md:min-h-8"
                onClick={() => setEditId(null)}
              >
                {t("followups.cancel")}
              </Button>
              <Button
                type="submit"
                className="min-h-11 md:min-h-8"
                disabled={pending || (shared && picked.length === 0)}
              >
                {t("followups.edit")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
