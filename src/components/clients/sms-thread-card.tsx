"use client";

import { enUS, fr } from "date-fns/locale";
import { AlertTriangleIcon, BotIcon, HandIcon, MessageCircleIcon, SendIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  markConversationHandledAction,
  sendManualSmsAction,
  setConversationAiAction,
} from "@/app/(app)/conversations/actions";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { analyzeSms } from "@/lib/sms/segments";
import { emitDataChange, useDataChange, useVisiblePolling } from "@/lib/live";
import { cn } from "@/lib/utils";

export type SmsMessageData = {
  id: string;
  direction: "in" | "out";
  body: string;
  createdAt: string;
  status: string | null;
  errorCode: number | null;
  source: string;
  aiGenerated: boolean;
  sentByName: string | null;
};

export type SmsThreadData = {
  conversationId: string | null;
  aiEnabled: boolean;
  pausedByName: string | null;
  pausedAt: string | null;
  pauseReason: string | null;
  needsAttention: boolean;
  attentionReason: string | null;
  suppressed: boolean;
  hasActiveNumber: boolean;
  messages: SmsMessageData[];
};

/** Préfixe d'un message optimiste, pas encore confirmé par le serveur. */
const DRAFT_PREFIX = "draft:";
/**
 * Sondage du fil. La fiche client est la requête la PLUS lourde de
 * l'application (client + appels + rendez-vous + commentaires + relances + fil)
 * et `router.refresh()` la rejoue en entier. On ne sonde donc que lorsqu'un fil
 * existe vraiment : sans conversation, rien ne peut changer sans une action de
 * l'utilisateur, et payer ce rafraîchissement serait gratuit dans le mauvais
 * sens du terme.
 */
const POLL_MS = 30_000;

/**
 * Le fil SMS d'un client.
 *
 * Trois choses que cet écran doit dire sans qu'on ait à cliquer :
 *
 *  · **Qui parle.** Un message de l'assistant, une relance de campagne et un
 *    message tapé par un collègue se ressemblent à l'écran ; les confondre
 *    conduit à répondre par-dessus une machine, ou à croire qu'un humain a déjà
 *    traité le fil.
 *  · **Ce qui n'est pas parti.** Un envoi en échec ressemble à un envoi réussi
 *    tant qu'on n'affiche pas son état. C'est le pire silence possible.
 *  · **Qui a la main.** La bannière de prise de contrôle est délibérément
 *    voyante : tant qu'elle est là, l'assistant se tait.
 */
export function SmsThreadCard({
  clientId,
  thread,
}: {
  clientId: string;
  thread: SmsThreadData;
}) {
  const t = useTranslations("conversations");
  const locale = useLocale();
  const dfnsLocale = locale === "en" ? enUS : fr;
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [body, setBody] = useState("");
  const [rows, setRows] = useState<SmsMessageData[]>(thread.messages);
  const inFlightRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Les données du serveur ne remplacent l'état local que si aucun envoi
  // optimiste n'est en vol — sinon le message qu'on vient de taper clignote.
  useEffect(() => {
    if (inFlightRef.current === 0 && !pending) setRows(thread.messages);
  }, [thread.messages, pending]);

  // Un entrant peut arriver d'un webhook, sans aucune action dans cet onglet.
  useDataChange(["sms"], () => router.refresh());
  useVisiblePolling(thread.conversationId ? POLL_MS : 0, () => router.refresh());

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows.length]);

  const analysis = analyzeSms(body);
  const blocked = thread.suppressed || !thread.hasActiveNumber;

  const send = () => {
    const text = body.trim();
    if (text === "" || blocked) return;

    const optimistic: SmsMessageData = {
      id: `${DRAFT_PREFIX}${Date.now()}`,
      direction: "out",
      body: text,
      createdAt: new Date().toISOString(),
      status: "queued",
      errorCode: null,
      source: "human",
      aiGenerated: false,
      sentByName: t("thread.you"),
    };
    setRows((current) => [...current, optimistic]);
    setBody("");
    inFlightRef.current += 1;

    startTransition(async () => {
      try {
        const result = await sendManualSmsAction({ clientId, body: text });
        if (!result.ok) {
          setRows((current) => current.filter((r) => r.id !== optimistic.id));
          setBody(text);
          toast.error(
            result.error === "suppressed"
              ? t("thread.suppressed")
              : result.error === "noNumber"
                ? t("thread.noNumber")
                : t("thread.error"),
          );
          return;
        }
        toast.success(t("thread.sent"));
        emitDataChange("sms");
        router.refresh();
      } finally {
        inFlightRef.current -= 1;
      }
    });
  };

  const toggleAi = (enabled: boolean) => {
    if (!thread.conversationId) return;
    startTransition(async () => {
      const result = await setConversationAiAction({
        conversationId: thread.conversationId!,
        enabled,
      });
      if (!result.ok) {
        toast.error(t("error"));
        return;
      }
      toast.success(enabled ? t("ai.resumed") : t("ai.paused"));
      emitDataChange("sms");
      router.refresh();
    });
  };

  const markHandled = () => {
    if (!thread.conversationId) return;
    startTransition(async () => {
      const result = await markConversationHandledAction(thread.conversationId!);
      if (!result.ok) {
        toast.error(t("error"));
        return;
      }
      toast.success(t("inbox.handled"));
      emitDataChange("sms");
      router.refresh();
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageCircleIcon className="size-4" />
          {t("thread.title")}
        </CardTitle>
        <CardAction>
          {thread.conversationId ? (
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 md:min-h-7"
              disabled={pending}
              onClick={() => toggleAi(!thread.aiEnabled)}
            >
              {thread.aiEnabled ? <HandIcon /> : <BotIcon />}
              {thread.aiEnabled ? t("ai.pause") : t("ai.resume")}
            </Button>
          ) : null}
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Prise de contrôle : voyante par construction. Tant qu'elle est là,
            l'assistant se tait — c'est trop important pour une pastille. */}
        {thread.conversationId && !thread.aiEnabled ? (
          <div
            role="alert"
            className="space-y-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-700 dark:text-amber-400"
          >
            <p className="flex items-center gap-2 font-medium">
              <HandIcon className="size-4 shrink-0" />
              {t("ai.banner")}
            </p>
            {thread.pausedByName && thread.pausedAt ? (
              <p className="text-xs opacity-90">
                {t("ai.bannerBy", {
                  name: thread.pausedByName,
                  when: new Date(thread.pausedAt).toLocaleString(locale === "en" ? "en-CA" : "fr-CA", {
                    timeZone: "America/Toronto",
                  }),
                })}
              </p>
            ) : null}
          </div>
        ) : null}

        {thread.suppressed ? (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm font-medium text-destructive"
          >
            <AlertTriangleIcon className="size-4 shrink-0" />
            {t("thread.suppressed")}
          </div>
        ) : null}

        {thread.needsAttention && thread.conversationId ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
            <Badge variant="secondary">
              {thread.attentionReason
                ? t(`inbox.reason.${thread.attentionReason}` as never)
                : t("inbox.filters.attention")}
            </Badge>
            <span className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              className="min-h-11 md:min-h-7"
              disabled={pending}
              onClick={markHandled}
            >
              {t("inbox.markHandled")}
            </Button>
          </div>
        ) : null}

        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {thread.hasActiveNumber ? t("thread.start") : t("thread.noNumber")}
          </p>
        ) : (
          <div ref={scrollRef} className="max-h-96 space-y-3 overflow-y-auto pr-1">
            {rows.map((message) => (
              <MessageBubble key={message.id} message={message} dfnsLocale={dfnsLocale} />
            ))}
          </div>
        )}

        <div className="space-y-1.5">
          <Textarea
            rows={2}
            value={body}
            disabled={blocked}
            placeholder={t("thread.placeholder")}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {body.trim() === ""
                ? t("thread.hint")
                : // Le nombre de segments décide du coût réel de l'envoi.
                  t("thread.segments", { chars: analysis.units, segments: analysis.segments })}
            </p>
            <Button
              size="sm"
              className="min-h-11 md:min-h-8"
              disabled={pending || blocked || body.trim() === ""}
              onClick={send}
            >
              <SendIcon />
              {pending ? t("thread.sending") : t("thread.send")}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function MessageBubble({
  message,
  dfnsLocale,
}: {
  message: SmsMessageData;
  dfnsLocale: typeof fr;
}) {
  const t = useTranslations("conversations");
  const outbound = message.direction === "out";
  const failed = message.status === "failed" || message.status === "undelivered";

  return (
    <div className={cn("flex flex-col gap-1", outbound ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap",
          outbound
            ? failed
              ? "bg-destructive/10 text-foreground ring-1 ring-destructive/40"
              : "bg-primary text-primary-foreground"
            : "bg-muted",
        )}
      >
        {message.body}
      </div>

      {/* Qui parle et ce qui est arrivé au message — sans ça, une relance de
          campagne, une réponse d'assistant et un message tapé par un collègue
          se ressemblent, et un échec ressemble à un succès. */}
      <p className="flex flex-wrap items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
        {outbound ? (
          <span>
            {message.source === "human"
              ? (message.sentByName ?? t("thread.source.human"))
              : t(`thread.source.${message.source}` as never)}
          </span>
        ) : null}
        <RelativeTime date={message.createdAt} locale={dfnsLocale} />
        {outbound && message.status ? (
          <span className={failed ? "font-medium text-destructive" : undefined}>
            · {t(`thread.status.${message.status}` as never)}
          </span>
        ) : null}
      </p>

      {failed && message.errorCode ? (
        <p className="px-1 text-[11px] font-medium text-destructive">
          {t("thread.failedHint", { code: message.errorCode })}
        </p>
      ) : null}
    </div>
  );
}
