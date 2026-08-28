"use client";

import { enUS, fr } from "date-fns/locale";
import { LockIcon, MessageSquareIcon, SendIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { addCommentAction } from "@/app/(app)/clients/actions";
import { RelativeTime } from "@/components/relative-time";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Textarea } from "@/components/ui/textarea";
import { emitDataChange } from "@/lib/live";
import { cn } from "@/lib/utils";

export type CommentData = {
  id: string;
  body: string;
  createdAt: string; // ISO
  author: { id: string; name: string };
};

type MentionUser = { id: string; name: string };

const MENTION_TOKEN = /@\[([^\]]+)\]\(([0-9a-fA-F-]{36})\)/g;

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

/** Render a comment body, highlighting "@[Name](id)" mention tokens. */
function renderBody(body: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const match of body.matchAll(MENTION_TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push(body.slice(last, index));
    nodes.push(
      <span
        key={`m-${i++}`}
        className="rounded bg-primary/10 px-1 font-medium text-primary"
      >
        @{match[1]}
      </span>,
    );
    last = index + match[0].length;
  }
  if (last < body.length) nodes.push(body.slice(last));
  return nodes;
}

/** Active "@query" being typed at the caret, if any. */
function activeMention(text: string, caret: number): { start: number; query: string } | null {
  const upToCaret = text.slice(0, caret);
  const at = upToCaret.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/[\s([{.,;:!?]/.test(upToCaret[at - 1])) return null;
  const query = upToCaret.slice(at + 1);
  if (query.length > 30 || /[\n@\]()]/.test(query)) return null;
  return { start: at, query };
}

export function CommentsTimeline({
  clientId,
  comments,
  canComment,
}: {
  clientId: string;
  comments: CommentData[];
  /** Écrire une note sur CETTE fiche. Le fil se lit sans ce droit. */
  canComment: boolean;
}) {
  const t = useTranslations("clients");
  const locale = useLocale();
  const dfnsLocale = locale === "en" ? enUS : fr;
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [body, setBody] = useState("");
  // Fil optimiste : le commentaire apparaît dès l'envoi, et disparaît (texte
  // restitué dans le champ) si le serveur refuse.
  const [rows, setRows] = useState<CommentData[]>(comments);
  const inFlightRef = useRef(0);
  useEffect(() => {
    if (inFlightRef.current === 0 && !pending) setRows(comments);
  }, [comments, pending]);
  const [users, setUsers] = useState<MentionUser[]>([]);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/users/mentions")
      .then((r) => (r.ok ? r.json() : []))
      .then((data: MentionUser[]) => {
        if (!cancelled && Array.isArray(data)) setUsers(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const suggestions = mention
    ? users
        .filter((u) => u.name.toLowerCase().includes(mention.query.toLowerCase()))
        .slice(0, 6)
    : [];

  const refreshMention = (value: string, caret: number) => {
    setMention(activeMention(value, caret));
    setHighlighted(0);
  };

  const insertMention = (user: MentionUser) => {
    if (!mention) return;
    const caret = textareaRef.current?.selectionStart ?? body.length;
    const token = `@[${user.name}](${user.id}) `;
    const next = body.slice(0, mention.start) + token + body.slice(caret);
    setBody(next);
    setMention(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        const pos = mention.start + token.length;
        el.setSelectionRange(pos, pos);
      }
    });
  };

  const submit = () => {
    const trimmed = body.trim();
    if (!trimmed || !canComment) return;
    const draft: CommentData = {
      id: `${DRAFT_PREFIX}${Date.now()}`,
      body: trimmed,
      createdAt: new Date().toISOString(),
      author: { id: DRAFT_PREFIX, name: t("comments.you") },
    };
    let snapshot: CommentData[] = [];
    setRows((current) => {
      snapshot = current;
      return [...current, draft];
    });
    setBody("");
    setMention(null);
    inFlightRef.current += 1;
    startTransition(async () => {
      const res = await addCommentAction({ clientId, body: trimmed });
      inFlightRef.current -= 1;
      if (res.ok) {
        toast.success(t("comments.posted"));
        // Les mentions créent des notifications : pastille à réactualiser.
        emitDataChange("notifications");
        router.refresh();
      } else {
        setRows(snapshot);
        setBody(trimmed);
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
                  <p className="mt-1 rounded-lg rounded-tl-sm bg-muted/50 px-3 py-2 text-sm break-words whitespace-pre-wrap">
                    {renderBody(c.body)}
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
            className="relative space-y-2"
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
            <Textarea
              ref={textareaRef}
              value={body}
              placeholder={t("comments.placeholder")}
              maxLength={5000}
              rows={3}
              onChange={(e) => {
                setBody(e.target.value);
                refreshMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
              }}
              onClick={(e) => {
                const el = e.currentTarget;
                refreshMention(el.value, el.selectionStart ?? el.value.length);
              }}
              onKeyDown={(e) => {
                if (mention && suggestions.length > 0) {
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
                  if (e.key === "Escape") {
                    setMention(null);
                    return;
                  }
                }
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            {mention && suggestions.length > 0 ? (
              <ul
                role="listbox"
                className="absolute bottom-full left-0 z-20 mb-1 max-h-56 w-full max-w-xs overflow-y-auto rounded-lg bg-popover p-1 shadow-md ring-1 ring-foreground/10"
              >
                {suggestions.map((u, i) => (
                  <li key={u.id} role="option" aria-selected={i === highlighted}>
                    <button
                      type="button"
                      className={cn(
                        "flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm md:min-h-9",
                        i === highlighted && "bg-accent text-accent-foreground",
                      )}
                      onMouseEnter={() => setHighlighted(i)}
                      onClick={() => insertMention(u)}
                    >
                      <Avatar className="size-6">
                        <AvatarFallback className="text-[10px]">{initials(u.name)}</AvatarFallback>
                      </Avatar>
                      {u.name}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="flex justify-end">
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
