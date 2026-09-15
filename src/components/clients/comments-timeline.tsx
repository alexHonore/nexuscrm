"use client";

import { enUS, fr } from "date-fns/locale";
import { LockIcon, MessageSquareIcon, SendIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { toast } from "sonner";
import { addCommentAction } from "@/app/(app)/clients/actions";
import { LookGlyph, NOTIFICATION_LOOK } from "@/components/look";
import { RelativeTime } from "@/components/relative-time";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Textarea } from "@/components/ui/textarea";
import { emitDataChange } from "@/lib/live";
import {
  activeMentionQuery,
  eraseWholeMention,
  mentionRanges,
  parseStoredBody,
  rankMentionCandidates,
  searchMatch,
  toStoredBody,
  type MentionRange,
  type MentionRef,
} from "@/lib/mentions";
import { cn } from "@/lib/utils";

export type CommentData = {
  id: string;
  body: string;
  createdAt: string; // ISO
  author: { id: string; name: string };
};

/**
 * Une mention porte le pictogramme et la teinte de SA notification dans la
 * cloche : c'est le même fait, vu depuis le fil au lieu de la cloche.
 */
const MENTION = NOTIFICATION_LOOK.mention;

/** Préfixe du commentaire optimiste (pas encore confirmé par le serveur). */
const DRAFT_PREFIX = "draft:";

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function mentionTint(percent: number): string {
  return `color-mix(in srgb, ${MENTION.color} ${percent}%, transparent)`;
}

/**
 * Un collègue mentionné, dans le fil. Le nom garde la couleur du texte —
 * l'ambre sur fond clair ne se lit pas ; la teinte et le pictogramme suffisent
 * à dire « mention ». La sienne ressort plus fort : le nom, lui, dit déjà de
 * qui il s'agit.
 */
function MentionChip({ name, self }: { name: string; self: boolean }) {
  return (
    <span
      className="mx-px rounded-full px-1.5 py-px font-medium whitespace-nowrap text-foreground"
      style={{
        backgroundColor: mentionTint(self ? 26 : 14),
        boxShadow: self ? `inset 0 0 0 1px ${mentionTint(60)}` : undefined,
      }}
    >
      <LookGlyph look={MENTION} className="mr-0.5 inline-block size-3 align-[-0.1em]" />
      <span className="sr-only">@</span>
      {name}
    </span>
  );
}

function CommentBody({ body, viewerId }: { body: string; viewerId: string }) {
  return parseStoredBody(body).map((segment, i) =>
    segment.kind === "text" ? (
      <Fragment key={i}>{segment.text}</Fragment>
    ) : (
      <MentionChip key={i} name={segment.name} self={segment.id === viewerId} />
    ),
  );
}

/**
 * Le calque sous la zone de saisie : le MÊME texte, aux mêmes positions, avec
 * les mentions surlignées. La zone de saisie au-dessus a un texte transparent
 * — on voit le calque, on tape dans la zone. Rien ici ne doit changer la
 * largeur d'un caractère (pas de gras, pas de marge) : le curseur se
 * décalerait du texte. Le relief de la pastille vient d'une ombre, qui ne
 * prend aucune place.
 */
function ComposerHighlights({ text, ranges }: { text: string; ranges: MentionRange[] }) {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  for (const { start, end } of ranges) {
    if (start > last) nodes.push(text.slice(last, start));
    nodes.push(
      <mark
        key={start}
        className="rounded-[3px] text-foreground"
        style={{ backgroundColor: mentionTint(22), boxShadow: `0 0 0 2px ${mentionTint(22)}` }}
      >
        {text.slice(start, end)}
      </mark>,
    );
    last = end;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function MatchedName({ name, query }: { name: string; query: string }) {
  const hit = searchMatch(name, query);
  if (!hit) return name;
  return (
    <>
      {name.slice(0, hit[0])}
      <strong className="font-semibold">{name.slice(hit[0], hit[1])}</strong>
      {name.slice(hit[1])}
    </>
  );
}

export function CommentsTimeline({
  clientId,
  comments,
  canComment,
  viewerId,
}: {
  clientId: string;
  comments: CommentData[];
  /** Écrire une note sur CETTE fiche. Le fil se lit sans ce droit. */
  canComment: boolean;
  /** Pour faire ressortir ses propres mentions et ne pas se proposer soi-même. */
  viewerId: string;
}) {
  const t = useTranslations("clients");
  const locale = useLocale();
  const dfnsLocale = locale === "en" ? enUS : fr;
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // Le texte AFFICHÉ (« @Nom ») ; les identifiants attendent à côté, dans
  // `picked`, et ne rejoignent le texte qu'à l'envoi.
  const [body, setBody] = useState("");
  const [picked, setPicked] = useState<MentionRef[]>([]);
  // Fil optimiste : le commentaire apparaît dès l'envoi, et disparaît (texte
  // restitué dans le champ) si le serveur refuse.
  const [rows, setRows] = useState<CommentData[]>(comments);
  const inFlightRef = useRef(0);
  useEffect(() => {
    if (inFlightRef.current === 0 && !pending) setRows(comments);
  }, [comments, pending]);
  const [users, setUsers] = useState<MentionRef[]>([]);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  // Le « @ » dont on a fermé la liste (Échap) : elle ne se rouvre pas à la
  // frappe suivante, seulement sur un autre « @ ».
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    let cancelled = false;
    fetch("/api/users/mentions")
      .then((r) => (r.ok ? r.json() : []))
      .then((data: MentionRef[]) => {
        if (!cancelled && Array.isArray(data)) setUsers(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const ranges = useMemo(() => mentionRanges(body, picked), [body, picked]);
  // Se mentionner soi-même ne notifie personne (`addCommentAction` écarte
  // l'auteur) : on ne se propose pas.
  const candidates = useMemo(() => users.filter((u) => u.id !== viewerId), [users, viewerId]);
  const suggestions = mention ? rankMentionCandidates(candidates, mention.query) : [];
  // « Personne ne correspond » tant qu'on tape UN mot ; au premier espace sans
  // correspondance, c'était un « @ » ordinaire et la liste se retire.
  const showNone =
    mention !== null && suggestions.length === 0 && candidates.length > 0 && !/\s/.test(mention.query);
  const listOpen = mention !== null && (suggestions.length > 0 || showNone);
  const activeOption = listOpen && suggestions.length > 0 ? `${listId}-${highlighted}` : undefined;

  useEffect(() => {
    if (activeOption) document.getElementById(activeOption)?.scrollIntoView({ block: "nearest" });
  }, [activeOption]);

  // Le curseur à replacer après le prochain rendu — dans un effet de mise en
  // page, qui passe AVANT la frappe suivante. Avec `requestAnimationFrame`, la
  // lettre tapée juste après avoir choisi un collègue atterrissait en fin de
  // texte (« @Philippe Côté erci !m »).
  const caretRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const pos = caretRef.current;
    const el = textareaRef.current;
    if (pos === null || !el) return;
    caretRef.current = null;
    el.focus();
    el.setSelectionRange(pos, pos);
  });

  const placeCaret = (pos: number) => {
    caretRef.current = pos;
  };

  const refreshMention = (value: string, caret: number) => {
    const next = activeMentionQuery(value, caret, mentionRanges(value, picked));
    if (!next) setDismissedAt(null);
    setMention(next && next.start !== dismissedAt ? next : null);
    setHighlighted(0);
  };

  const insertMention = (user: MentionRef) => {
    if (!mention) return;
    const caret = textareaRef.current?.selectionStart ?? body.length;
    const label = `@${user.name}`;
    const after = body.slice(caret);
    setBody(body.slice(0, mention.start) + label + (after.startsWith(" ") ? "" : " ") + after);
    setPicked((current) => [...current.filter((r) => r.id !== user.id), user]);
    setMention(null);
    placeCaret(mention.start + label.length + 1);
  };

  /** Le bouton « @ » : le symbole est enfoui sur un clavier de téléphone. */
  const startMention = () => {
    const el = textareaRef.current;
    const from = el?.selectionStart ?? body.length;
    const to = el?.selectionEnd ?? from;
    const before = body.slice(0, from);
    const insert = before && !/[\s([{]$/.test(before) ? " @" : "@";
    const pos = from + insert.length;
    setBody(before + insert + body.slice(to));
    setDismissedAt(null);
    setMention({ start: pos - 1, query: "" });
    setHighlighted(0);
    placeCaret(pos);
  };

  const submit = () => {
    const display = body.trim();
    if (!display || !canComment) return;
    const stored = toStoredBody(display, picked);
    const keptPicked = picked;
    const draft: CommentData = {
      id: `${DRAFT_PREFIX}${Date.now()}`,
      body: stored,
      createdAt: new Date().toISOString(),
      author: { id: DRAFT_PREFIX, name: t("comments.you") },
    };
    let snapshot: CommentData[] = [];
    setRows((current) => {
      snapshot = current;
      return [...current, draft];
    });
    setBody("");
    setPicked([]);
    setMention(null);
    inFlightRef.current += 1;
    startTransition(async () => {
      const res = await addCommentAction({ clientId, body: stored });
      inFlightRef.current -= 1;
      if (res.ok) {
        toast.success(t("comments.posted"));
        // Les mentions créent des notifications : pastille à réactualiser.
        emitDataChange("notifications");
        router.refresh();
      } else {
        setRows(snapshot);
        setBody(display);
        setPicked(keptPicked);
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

  return (
    <Card className="shadow-xs">
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2">
          <MessageSquareIcon className="size-4 text-muted-foreground" />
          {t("comments.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {rows.length === 0 ? (
          <EmptyState icon={<MessageSquareIcon />} title={t("comments.empty")} className="py-6" />
        ) : (
          <ul className="space-y-4">
            {rows.map((c) => (
              <li
                key={c.id}
                className={cn(
                  "flex gap-3",
                  c.id.startsWith(DRAFT_PREFIX) && "opacity-60",
                )}
              >
                <Avatar className="mt-0.5 size-8 shrink-0">
                  <AvatarFallback className="bg-primary/10 text-xs font-medium text-primary">
                    {initials(c.author.name)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    <span className="font-medium">{c.author.name}</span>{" "}
                    <span className="text-xs text-muted-foreground">
                      <RelativeTime date={c.createdAt} locale={dfnsLocale} />
                    </span>
                  </p>
                  <p className="mt-1 rounded-lg rounded-tl-sm bg-muted/50 px-3 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap">
                    <CommentBody body={c.body} viewerId={viewerId} />
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* Composer with @mention autocomplete — absent sans le droit de
            commenter : le fil se lit, la note ne s'écrit pas. Le serveur
            refuse de toute façon un commentaire sur une fiche fermée. */}
        {canComment ? (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            {/* Étiquette « interne » explicite : la carte SMS vit juste en
                dessous, et la ressemblance des deux zones de saisie fait courir
                le risque d'envoyer une note à un client. On dit donc, des deux
                côtés, à qui le texte s'adresse. */}
            <p className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <LockIcon className="size-3.5" />
              {t("comments.internalOnly")}
            </p>
            {/* Calque + zone de saisie dans la MÊME cellule de grille : même
                largeur, même hauteur, même retour à la ligne. Le fond sombre
                vit sur l'enveloppe — posé sur la zone de saisie, il voilerait
                le calque. */}
            <div className="relative grid rounded-lg dark:bg-input/30">
              <div
                ref={mirrorRef}
                aria-hidden
                className="pointer-events-none col-start-1 row-start-1 overflow-hidden rounded-lg border border-transparent px-2.5 py-2 text-base break-words whitespace-pre-wrap text-foreground md:text-sm"
              >
                <ComposerHighlights text={body} ranges={ranges} />
              </div>
              <Textarea
                ref={textareaRef}
                value={body}
                placeholder={t("comments.placeholder")}
                maxLength={5000}
                rows={3}
                aria-autocomplete="list"
                aria-controls={listOpen ? listId : undefined}
                aria-activedescendant={activeOption}
                className="col-start-1 row-start-1 text-transparent caret-foreground selection:bg-primary/20 selection:text-transparent dark:bg-transparent"
                onChange={(e) => {
                  const el = e.currentTarget;
                  const erased = eraseWholeMention(body, el.value, picked);
                  if (erased) {
                    setBody(erased.text);
                    setMention(null);
                    placeCaret(erased.caret);
                    return;
                  }
                  setBody(el.value);
                  refreshMention(el.value, el.selectionStart ?? el.value.length);
                }}
                onSelect={(e) => {
                  const el = e.currentTarget;
                  refreshMention(el.value, el.selectionStart ?? el.value.length);
                }}
                onScroll={(e) => {
                  if (mirrorRef.current) mirrorRef.current.scrollTop = e.currentTarget.scrollTop;
                }}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (mention && listOpen) {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setDismissedAt(mention.start);
                      setMention(null);
                      return;
                    }
                    if (suggestions.length > 0) {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setHighlighted((h) => (h + 1) % suggestions.length);
                        return;
                      }
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setHighlighted((h) => (h - 1 + suggestions.length) % suggestions.length);
                        return;
                      }
                      if (e.key === "Enter" || e.key === "Tab") {
                        e.preventDefault();
                        insertMention(suggestions[highlighted] ?? suggestions[0]);
                        return;
                      }
                    }
                  }
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    submit();
                  }
                }}
              />
              {mention && listOpen ? (
                <div className="absolute bottom-full left-0 z-20 mb-1.5 w-full max-w-xs overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/10">
                  <p className="flex items-center gap-1.5 border-b px-3 py-2 text-xs font-medium text-muted-foreground">
                    <LookGlyph look={MENTION} className="size-3.5" />
                    {t("comments.mentionHint")}
                  </p>
                  {suggestions.length > 0 ? (
                    <ul
                      id={listId}
                      role="listbox"
                      aria-label={t("comments.mentionHint")}
                      className="max-h-56 overflow-y-auto p-1"
                    >
                      {suggestions.map((u, i) => (
                        <li
                          key={u.id}
                          id={`${listId}-${i}`}
                          role="option"
                          aria-selected={i === highlighted}
                          className={cn(
                            "flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg px-2 text-sm md:min-h-9",
                            i === highlighted && "bg-accent text-accent-foreground",
                          )}
                          // Garde le focus dans la zone de saisie : le curseur
                          // doit y être encore pour insérer la mention.
                          onMouseDown={(e) => e.preventDefault()}
                          onMouseEnter={() => setHighlighted(i)}
                          onClick={() => insertMention(u)}
                        >
                          <Avatar className="size-7">
                            <AvatarFallback className="bg-primary/10 text-[11px] font-medium text-primary">
                              {initials(u.name)}
                            </AvatarFallback>
                          </Avatar>
                          <span className="min-w-0 truncate">
                            <MatchedName name={u.name} query={mention.query} />
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="px-3 py-3 text-sm text-muted-foreground">
                      {t("comments.mentionNone", { query: mention.query })}
                    </p>
                  )}
                  {suggestions.length > 0 ? (
                    <p className="hidden border-t px-3 py-1.5 text-[11px] text-muted-foreground md:block">
                      {t("comments.mentionKeys")}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="ghost"
                className="min-h-11 text-muted-foreground md:min-h-8"
                onClick={startMention}
              >
                <LookGlyph look={MENTION} />
                {t("comments.mentionButton")}
              </Button>
              <Button type="submit" className="min-h-11 md:min-h-8" disabled={pending || !body.trim()}>
                <SendIcon />
                {t("comments.submit")}
              </Button>
            </div>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}
