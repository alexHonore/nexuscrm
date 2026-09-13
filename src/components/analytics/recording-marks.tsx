"use client";

import { useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/components/admin/api";
import { LIBRARY_LOOK, lookTint } from "@/components/look";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * Les deux gestes qu'on pose sur un enregistrement, partout où on le croise :
 * l'étoile (pour soi) et le rangement (pour l'équipe).
 *
 * Un seul composant pour le journal d'appels ET la bibliothèque, parce que
 * c'est un seul geste : le jour où l'étoile aura deux formes selon l'écran,
 * personne ne saura plus si elle a été posée. Il vit sous `analytics` avec le
 * reste du journal d'appels, dont il partage le namespace de traduction.
 */

export type CollectionOption = { id: string; kind: "folder" | "tag"; name: string };
export type CallFilingMark = CollectionOption & { note: string | null };
export type CallMarks = { starred: boolean; collections: CallFilingMark[] };

/** Le même dictionnaire, sans cette clé — pour vider un brouillon de motif. */
function withoutKey(d: Record<string, string>, key: string): Record<string, string> {
  if (!(key in d)) return d;
  const next = { ...d };
  delete next[key];
  return next;
}

/** L'étoile. Pleine = marquée par MOI ; personne d'autre ne la voit. */
export function StarButton({
  callId,
  starred,
  compact,
}: {
  callId: string;
  starred: boolean;
  compact?: boolean;
}) {
  const t = useTranslations("analytics");
  const router = useRouter();
  // Optimiste : l'étoile est un geste qu'on pose en écoutant, elle ne peut pas
  // attendre un aller-retour réseau pour se remplir.
  const [on, setOn] = useState(starred);
  const [pending, startTransition] = useTransition();
  const [syncedFrom, setSyncedFrom] = useState(starred);
  if (starred !== syncedFrom) {
    setSyncedFrom(starred);
    setOn(starred);
  }

  const look = LIBRARY_LOOK.starred;
  const Icon = look.Icon;
  const label = on ? t("callsPage.unstar") : t("callsPage.star");

  const toggle = () => {
    const next = !on;
    setOn(next);
    startTransition(async () => {
      try {
        await api("/api/admin/recordings/star", {
          method: next ? "POST" : "DELETE",
          body: JSON.stringify({ callId }),
        });
        router.refresh();
      } catch {
        setOn(!next);
        toast.error(t("library.genericError"));
      }
    });
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      aria-pressed={on}
      title={label}
      disabled={pending}
      className={cn("shrink-0", compact && "size-11")}
      onClick={toggle}
    >
      <Icon
        aria-hidden
        className="size-4"
        style={on ? { color: look.color, fill: look.color } : undefined}
      />
    </Button>
  );
}

/** Les recueils où cet appel est rangé — lus d'un coup d'œil, sans l'ouvrir. */
export function FilingChips({
  collections,
  hide,
}: {
  collections: CallFilingMark[];
  /** Le recueil qu'on est en train d'ouvrir — il se lit déjà en titre. */
  hide?: string;
}) {
  const t = useTranslations("analytics");
  const shown = hide ? collections.filter((c) => c.id !== hide) : collections;
  if (shown.length === 0) return null;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      <span className="sr-only">
        {t("callsPage.filedIn", { names: shown.map((c) => c.name).join(", ") })}
      </span>
      {shown.map((c) => {
        const look = LIBRARY_LOOK[c.kind];
        const Icon = look.Icon;
        const tint = lookTint(look);
        return (
          <span
            key={c.id}
            aria-hidden
            className="inline-flex h-6 max-w-full items-center gap-1 rounded-full border px-2 text-xs font-medium"
            style={{
              color: tint.color,
              backgroundColor: tint.backgroundColor,
              borderColor: tint.borderColor,
            }}
            title={c.note ?? c.name}
          >
            <Icon className="size-3 shrink-0" />
            <span className="truncate">{c.name}</span>
          </span>
        );
      })}
    </span>
  );
}

/**
 * « Ranger » : cocher des recueils, et écrire pourquoi.
 *
 * Le motif est attaché au COUPLE (appel, recueil), pas à l'appel — d'où un
 * champ par case cochée plutôt qu'un seul en bas. Le même appel rangé dans
 * « bons rebonds » et dans « à revoir avec Marc » n'y est pas pour la même
 * raison, et un champ unique aurait forcé à en perdre une.
 */
export function FilingButton({
  callId,
  marks,
  collections,
  compact,
}: {
  callId: string;
  marks: CallFilingMark[];
  collections: CollectionOption[];
  compact?: boolean;
}) {
  const t = useTranslations("analytics");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [local, setLocal] = useState<CallFilingMark[]>(marks);
  const [syncedFrom, setSyncedFrom] = useState(marks);
  if (marks !== syncedFrom) {
    setSyncedFrom(marks);
    setLocal(marks);
  }
  // Le motif en cours de frappe, par recueil. Il vit ICI et pas seulement dans
  // le champ, parce que le champ disparaît avec la bulle : la fermer d'un Échap
  // ou d'un tap à côté démonte le textarea sans garantie qu'un `blur` parte
  // avant — et la phrase qu'on venait d'écrire partait avec lui.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Le motif déjà en route vers le serveur : le `blur` et la fermeture tombent
  // souvent ensemble, un seul des deux doit l'envoyer.
  const inflight = useRef(new Map<string, string | null>());

  const look = LIBRARY_LOOK.folder;
  const Icon = look.Icon;
  const filedIds = new Set(local.map((c) => c.id));

  const add = async (c: CollectionOption, note: string | null) => {
    setBusy(c.id);
    try {
      await api(`/api/admin/recordings/collections/${c.id}/items`, {
        method: "POST",
        body: JSON.stringify({ callId, note }),
      });
      setLocal((cur) => [...cur.filter((x) => x.id !== c.id), { ...c, note }]);
      // Le brouillon s'efface s'il est ce qu'on vient d'enregistrer — pas si
      // la frappe a continué pendant l'aller-retour.
      setDrafts((d) => ((d[c.id] ?? "").trim() === (note ?? "") ? withoutKey(d, c.id) : d));
      router.refresh();
    } catch {
      toast.error(t("library.genericError"));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (c: CollectionOption) => {
    setBusy(c.id);
    try {
      await api(`/api/admin/recordings/collections/${c.id}/items`, {
        method: "DELETE",
        body: JSON.stringify({ callId }),
      });
      setLocal((cur) => cur.filter((x) => x.id !== c.id));
      setDrafts((d) => withoutKey(d, c.id));
      router.refresh();
    } catch {
      toast.error(t("library.genericError"));
    } finally {
      setBusy(null);
    }
  };

  /** Envoie le motif en cours de frappe — s'il a changé, et s'il n'est pas déjà parti. */
  const commitNote = (c: CollectionOption) => {
    const draft = drafts[c.id];
    const filed = local.find((x) => x.id === c.id);
    if (draft === undefined || !filed) return;
    const next = draft.trim() || null;
    if (next === (filed.note ?? null) || inflight.current.get(c.id) === next) return;
    inflight.current.set(c.id, next);
    void add(c, next).finally(() => {
      if (inflight.current.get(c.id) === next) inflight.current.delete(c.id);
    });
  };

  const groups = [
    { kind: "folder" as const, label: t("library.folders") },
    { kind: "tag" as const, label: t("library.tags") },
  ];

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // Fermer vaut « j'ai fini » : ce qui est encore en cours de frappe part.
        if (!next) collections.forEach(commitNote);
        setOpen(next);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("callsPage.file")}
            title={t("callsPage.file")}
            className={cn("shrink-0", compact && "size-11")}
          />
        }
      >
        <Icon
          aria-hidden
          className="size-4"
          style={local.length > 0 ? { color: look.color } : undefined}
        />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))] p-0">
        <div className="border-b px-3 py-2">
          <p className="text-sm font-medium">{t("library.fileTitle")}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("library.fileHint")}</p>
        </div>
        {collections.length === 0 ? (
          <div className="px-3 py-4">
            <p className="text-sm text-muted-foreground">{t("library.noCollections")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t("library.noCollectionsHint")}</p>
          </div>
        ) : (
          <div className="max-h-[60vh] space-y-3 overflow-y-auto p-3">
            {groups.map((g) => {
              const items = collections.filter((c) => c.kind === g.kind);
              if (items.length === 0) return null;
              return (
                <div key={g.kind} className="space-y-1">
                  <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                    {g.label}
                  </p>
                  {items.map((c) => {
                    const filed = local.find((x) => x.id === c.id);
                    return (
                      <div key={c.id}>
                        <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-1 hover:bg-muted md:min-h-9">
                          <Checkbox
                            checked={filedIds.has(c.id)}
                            disabled={busy === c.id}
                            onCheckedChange={(checked) =>
                              checked ? void add(c, null) : void remove(c)
                            }
                          />
                          <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
                        </label>
                        {filed ? (
                          <div className="pb-2 pl-7">
                            <label
                              className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground"
                              htmlFor={`note-${callId}-${c.id}`}
                            >
                              {t("library.noteLabel")}
                            </label>
                            <Textarea
                              id={`note-${callId}-${c.id}`}
                              rows={2}
                              maxLength={500}
                              value={drafts[c.id] ?? filed.note ?? ""}
                              placeholder={t("library.notePlaceholder")}
                              className="mt-1 min-h-11 text-sm"
                              onChange={(e) => {
                                const value = e.currentTarget.value;
                                setDrafts((d) => ({ ...d, [c.id]: value }));
                              }}
                              onBlur={() => commitNote(c)}
                            />
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              );
            })}
            <p className="text-xs text-muted-foreground">{t("library.noteHint")}</p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** L'étoile + le rangement, dans l'ordre où on les pose. */
export function RecordingMarks({
  callId,
  marks,
  collections,
  canCurate,
  compact,
}: {
  callId: string;
  marks: CallMarks;
  collections: CollectionOption[];
  canCurate: boolean;
  compact?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-0.5">
      <StarButton callId={callId} starred={marks.starred} compact={compact} />
      {canCurate ? (
        <FilingButton
          callId={callId}
          marks={marks.collections}
          collections={collections}
          compact={compact}
        />
      ) : null}
    </span>
  );
}
