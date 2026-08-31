"use client";

import { enUS, fr } from "date-fns/locale";
import {
  AlertTriangleIcon,
  BotIcon,
  ClockIcon,
  HandIcon,
  SmartphoneIcon,
  Undo2Icon,
  SendIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  assignAssistantAction,
  cancelOutboundSmsAction,
  cancelQueuedSmsAction,
  markConversationHandledAction,
  sendManualSmsAction,
  setConversationAiAction,
} from "@/app/(app)/conversations/actions";
import { FAILED_SEND_STATUSES } from "@/components/conversations/state";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  ATTENTION_LOOK,
  CHANNEL_LOOK,
  CONVERSATION_STATE_LOOK,
  LookIcon,
  lookTint,
} from "@/components/look";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatPhone } from "@/lib/phone";
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
  /** Pourquoi un sortant n'est PAS parti (code, éventuellement suivi de « : détail »). */
  skipReason: string | null;
  source: string;
  aiGenerated: boolean;
  sentByName: string | null;
};

/** Un envoi encore EN FILE — pas encore de rangée message, mais annulable. */
export type QueuedSendData = {
  jobId: string;
  body: string;
  source: string;
  automated: boolean;
  runAt: string;
};

export type SmsThreadData = {
  conversationId: string | null;
  /** Destinataire — affiché en permanence au-dessus de la zone de rédaction. */
  clientName: string;
  /** Déjà MASQUÉ par le serveur quand `clientPhoneMasked` — rien à reformater. */
  clientPhone: string;
  /**
   * Optionnel parce qu'il n'est qu'un INDICE de mise en forme : un producteur
   * qui l'oublie affiche quand même juste (mettre en forme un masque le laisse
   * intact). Ce qui protège, c'est que le serveur n'envoie pas le vrai numéro.
   */
  clientPhoneMasked?: boolean;
  aiEnabled: boolean;
  pausedByName: string | null;
  pausedAt: string | null;
  pauseReason: string | null;
  needsAttention: boolean;
  attentionReason: string | null;
  suppressed: boolean;
  hasActiveNumber: boolean;
  /** Qui parle côté IA, et à qui on peut confier le fil. */
  assistant: {
    currentId: string | null;
    currentName: string | null;
    options: { id: string; name: string }[];
  };
  queued: QueuedSendData[];
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
const SMS = CHANNEL_LOOK.sms;

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
  canReply = false,
  canControl = false,
  canAssignAssistant = false,
}: {
  clientId: string;
  thread: SmsThreadData;
  /**
   * Écrire un SMS à la main dans ce fil (`clients.sms` × `conversations.reply`).
   *
   * Non dit = fermé, comme partout dans la matrice (`noGrants()` est le socle,
   * un droit vaut par sa présence). Un appelant qui oublie perd la zone de
   * rédaction — bruyant et sans danger — plutôt que d'ouvrir en silence ce qui
   * envoie des messages HORS de l'application.
   */
  canReply?: boolean;
  /** Reprendre / rendre le fil à l'assistant, le marquer traité. */
  canControl?: boolean;
  /**
   * CHOISIR l'assistant qui tient le fil, en changer, le retirer
   * (`conversations.assistant` × case `assistant` de la fiche).
   *
   * Séparé de `canControl` parce que ce n'est pas le même métier : reprendre
   * la main est une décision de téléphoniste, brancher un robot sur ce
   * client-là engage ce que l'entreprise lui dira. Non dit = fermé, comme
   * `canReply` et `canControl` — l'appelant qui oublie perd le sélecteur,
   * jamais l'inverse.
   */
  canAssignAssistant?: boolean;
}) {
  const t = useTranslations("conversations");
  const tCommon = useTranslations("common");
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
  const blocked = thread.suppressed || !thread.hasActiveNumber || !canReply;
  // Annuler ce qui n'est pas encore parti appartient aux deux métiers : celui
  // qui écrit, et celui qui reprend la main sur l'assistant.
  const canCancel = canReply || canControl;
  /** Le numéro tel qu'il doit s'afficher — masqué, il est déjà mis en forme. */
  const phoneLabel = thread.clientPhoneMasked
    ? thread.clientPhone
    : formatPhone(thread.clientPhone);

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
      skipReason: null,
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

  // Prendre le contrôle demande une raison (facultative) : « qui et pourquoi »
  // était promis, seul « qui » existait.
  const [pausePrompt, setPausePrompt] = useState<string | null>(null);
  const toggleAi = (enabled: boolean, reason?: string) => {
    if (!thread.conversationId) return;
    startTransition(async () => {
      const result = await setConversationAiAction({
        conversationId: thread.conversationId!,
        enabled,
        reason: reason?.trim() ? reason.trim() : null,
      });
      if (!result.ok) {
        toast.error(t("error"));
        return;
      }
      setPausePrompt(null);
      toast.success(enabled ? t("ai.resumed") : t("ai.paused"));
      emitDataChange("sms");
      router.refresh();
    });
  };

  const assignAssistant = (assistantId: string | null) => {
    if (!thread.conversationId) return;
    startTransition(async () => {
      const result = await assignAssistantAction({ conversationId: thread.conversationId!, assistantId });
      if (!result.ok) {
        toast.error(result.error === "assistantUnavailable" ? t("thread.assistantUnavailable") : t("error"));
        return;
      }
      toast.success(assistantId ? t("assistant.assigned") : t("assistant.unassigned"));
      emitDataChange("sms");
      router.refresh();
    });
  };

  const cancelQueued = (jobId: string) => {
    startTransition(async () => {
      const result = await cancelQueuedSmsAction(jobId);
      if (!result.ok) {
        toast.error(result.error === "alreadySent" ? t("thread.tooLate") : t("error"));
        router.refresh();
        return;
      }
      toast.success(t("thread.cancelled"));
      emitDataChange("sms");
      router.refresh();
    });
  };

  /**
   * Annuler un envoi encore EN FILE. Un message remis à l'opérateur ne se
   * rappelle pas ; l'action refuse dans ce cas plutôt que de faire semblant.
   */
  const cancelSend = (messageId: string) => {
    startTransition(async () => {
      const result = await cancelOutboundSmsAction(messageId);
      if (!result.ok) {
        toast.error(result.error === "alreadySent" ? t("thread.tooLate") : t("error"));
        router.refresh();
        return;
      }
      setRows((current) =>
        current.map((r) => (r.id === messageId ? { ...r, status: "cancelled" } : r)),
      );
      toast.success(t("thread.cancelled"));
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
    /*
     * Cette carte SORT de l'application : ce qu'on y tape arrive sur le
     * téléphone de quelqu'un. Ses voisines (commentaires, historique, relances)
     * n'engagent rien.
     *
     * Elle portait la couleur PRIMAIRE, qui est celle de tous les boutons de
     * l'application : « teinté en bleu » ne se lit pas comme « autre chose »,
     * mais comme « mis en avant ». D'où une couleur de canal réservée
     * (`CHANNEL_LOOK.sms`), un liseré épais à gauche — le signal le moins cher
     * et le plus immédiat — et le numéro du destinataire écrit dans l'en-tête,
     * pas seulement au-dessus du champ de saisie.
     */
    <Card
      /*
       * `overflow-visible` sur téléphone n'est pas une coquetterie : la carte
       * rogne ses enfants par défaut, et un parent qui rogne fait de la carte
       * le « conteneur de défilement » le plus proche — ce qui rend
       * `position: sticky` totalement inopérant à l'intérieur. Sans cette
       * ligne, la zone de rédaction collante plus bas ne collerait à rien.
       * Au-delà de md, la carte retrouve exactement son rognage d'origine.
       */
      className="border-l-4 shadow-xs max-md:overflow-visible"
      style={{
        borderLeftColor: SMS.color,
        borderColor: `color-mix(in srgb, ${SMS.color} 35%, transparent)`,
        borderLeftWidth: 4,
      }}
    >
      <CardHeader
        className="rounded-t-xl border-b"
        style={{
          backgroundColor: `color-mix(in srgb, ${SMS.color} 7%, transparent)`,
          borderBottomColor: `color-mix(in srgb, ${SMS.color} 22%, transparent)`,
        }}
      >
        <CardTitle className="flex flex-wrap items-center gap-2">
          <LookIcon look={SMS} size="sm" />
          {t("thread.title")}
          {/* Le numéro dans l'EN-TÊTE : on sait à qui on parle avant même de
              faire défiler jusqu'au champ de saisie. */}
          <Badge
            variant="outline"
            className="gap-1 font-mono text-[10px]"
            style={{
              color: SMS.color,
              borderColor: `color-mix(in srgb, ${SMS.color} 40%, transparent)`,
            }}
          >
            {phoneLabel}
          </Badge>
        </CardTitle>
        <CardAction>
          {thread.conversationId && canControl ? (
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 md:min-h-7"
              disabled={pending}
              onClick={() => (thread.aiEnabled ? setPausePrompt("") : toggleAi(true))}
            >
              {thread.aiEnabled ? <HandIcon /> : <BotIcon />}
              {thread.aiEnabled ? t("ai.pause") : t("ai.resume")}
            </Button>
          ) : null}
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-3">
        {pausePrompt !== null ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
            <Label htmlFor={`pause-reason-${clientId}`} className="sr-only">
              {t("ai.reason")}
            </Label>
            <Input
              id={`pause-reason-${clientId}`}
              className="min-h-11 flex-1 md:min-h-9"
              placeholder={t("ai.pausePrompt")}
              maxLength={200}
              value={pausePrompt}
              onChange={(e) => setPausePrompt(e.target.value)}
            />
            <Button size="sm" className="min-h-11 md:min-h-8" disabled={pending} onClick={() => toggleAi(false, pausePrompt)}>
              <HandIcon /> {t("ai.confirmPause")}
            </Button>
            <Button variant="ghost" size="sm" className="min-h-11 md:min-h-8" disabled={pending} onClick={() => setPausePrompt(null)}>
              {tCommon("actions.cancel")}
            </Button>
          </div>
        ) : null}

        {/* Qui parle côté IA — et le geste de confier ou retirer le fil. Sans
            lui, seul un barreau de campagne savait donner un fil à un
            assistant : un contact qui écrivait de lui-même n'avait jamais de
            réponse IA.
            Ce sélecteur suit son droit à lui : on peut tenir la main sur un
            fil (bouton ci-dessus) sans avoir celui d'y brancher un robot. */}
        {thread.conversationId && canAssignAssistant ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <BotIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="text-muted-foreground">{t("assistant.label")} :</span>
            <Select
              items={[
                { value: "__none__", label: t("assistant.none") },
                ...thread.assistant.options.map((a) => ({ value: a.id, label: a.name })),
              ]}
              value={thread.assistant.currentId ?? "__none__"}
              onValueChange={(v) => assignAssistant(v === "__none__" ? null : String(v))}
              disabled={pending}
            >
              <SelectTrigger className="min-h-11 w-auto min-w-44 md:min-h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">{t("assistant.none")}</SelectItem>
                {thread.assistant.options.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

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
            {/* Le MÊME vocabulaire que la boîte de réception : la puce du
                motif porte sa teinte (répondre, panne, terminé) et son
                pictogramme, pas un gris interchangeable. */}
            {(() => {
              const look =
                (thread.attentionReason ? ATTENTION_LOOK[thread.attentionReason] : undefined) ??
                CONVERSATION_STATE_LOOK.attention;
              return (
                <Badge variant="outline" className="gap-1 font-normal" style={lookTint(look)}>
                  <look.Icon aria-hidden />
                  {thread.attentionReason
                    ? t(`inbox.reason.${thread.attentionReason}` as never)
                    : t("inbox.state.attention")}
                </Badge>
              );
            })()}
            <span className="flex-1" />
            {canControl ? (
              <Button
                variant="ghost"
                size="sm"
                className="min-h-11 md:min-h-7"
                disabled={pending}
                onClick={markHandled}
              >
                {t("inbox.markHandled")}
              </Button>
            ) : null}
          </div>
        ) : null}

        {rows.length === 0 && thread.queued.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {thread.hasActiveNumber ? t("thread.start") : t("thread.noNumber")}
          </p>
        ) : (
          /*
           * Sur écran large, le fil vit dans sa propre fenêtre de 24 rem : la
           * fiche entière tient à l'œil et le fil se parcourt sans emporter
           * la page.
           * Sur téléphone, cette même fenêtre devenait une meurtrière — un
           * cadre de 384 px, sous une barre de navigation, dans lequel il
           * fallait faire défiler un fil avec le pouce SANS faire défiler la
           * page. Deux défilements imbriqués sur un écran de 360 px : le
           * doigt ne sait plus lequel il commande. On rend donc le fil à la
           * page, et c'est la zone de rédaction (collante, plus bas) qui
           * garde sa place à l'écran.
           */
          <div
            ref={scrollRef}
            className="max-h-96 space-y-3 overflow-y-auto pr-1 max-md:max-h-none max-md:overflow-y-visible"
          >
            {rows.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                dfnsLocale={dfnsLocale}
                onCancel={canCancel ? cancelSend : null}
                busy={pending}
              />
            ))}
            {/* Envois encore EN FILE : aucune rangée message n'existe tant que
                le répartiteur ne les a pas pris — c'est ici, et seulement ici,
                qu'« annuler » veut dire quelque chose. */}
            {thread.queued.map((q) => (
              <div key={q.jobId} className="flex flex-col items-end gap-1">
                <div className="max-w-[85%] rounded-2xl border border-dashed border-primary/50 bg-primary/5 px-3 py-2 text-sm whitespace-pre-wrap">
                  {q.body}
                </div>
                <p className="flex flex-wrap items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
                  <ClockIcon className="size-3" />
                  <span>{t(`thread.source.${q.source}` as never)}</span>
                  <span>
                    ·{" "}
                    {t("thread.queued", {
                      when: new Date(q.runAt).toLocaleString(locale === "en" ? "en-CA" : "fr-CA", {
                        timeZone: "America/Toronto",
                        hour: "2-digit",
                        minute: "2-digit",
                        day: "numeric",
                        month: "short",
                      }),
                    })}
                  </span>
                </p>
                {canCancel ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="min-h-11 px-2 text-[11px] text-muted-foreground md:min-h-7"
                    disabled={pending}
                    onClick={() => cancelQueued(q.jobId)}
                  >
                    <Undo2Icon className="size-3" /> {t("thread.cancelQueued")}
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {/* Écrire est un droit à part : sans lui le fil se LIT (l'assistant
            continue de travailler), il ne s'écrit pas. */}
        {canReply ? (
          /*
           * La zone de rédaction n'est PLUS collante sur téléphone.

           *
           * Elle l'a été : posée à 8,5 rem du bas, elle flottait au MILIEU de
           * l'écran d'un téléphone de 740 px, avec près de 100 px de vide en
           * dessous, et elle coupait en deux la bulle du message qu'on venait
           * de lire. La distance était celle que la coquille réserve à sa
           * barre — mais une barre collante DOIT toucher le bord qu'elle
           * longe, sinon elle n'est qu'un bloc opaque garé en travers.
           *
           * L'historique n'a plus son propre défileur (voir plus haut) : la
           * carte se lit donc d'un seul mouvement et la rédaction arrive à sa
           * fin, là où on l'attend. Le `pb` garde le dernier bouton au-dessus
           * de la barre de navigation basse.
           */
          <div className="max-md:-mx-4 max-md:border-t max-md:bg-card max-md:px-4 max-md:pt-3 max-md:pb-[calc(1rem+env(safe-area-inset-bottom))]">
            <div
              className="space-y-1.5 rounded-lg border-2 p-3"
              style={{
                borderColor: `color-mix(in srgb, ${SMS.color} 40%, transparent)`,
                backgroundColor: `color-mix(in srgb, ${SMS.color} 6%, transparent)`,
              }}
            >
              {/* Le destinataire est toujours visible : c'est ce qui distingue le
                  plus sûrement une note interne (personne) d'un SMS (quelqu'un). */}
              <p
                className="flex flex-wrap items-center gap-1.5 text-xs font-medium"
                style={{ color: SMS.color }}
              >
                <SmartphoneIcon className="size-3.5" />
                {t("thread.sendsTo", { name: thread.clientName, phone: phoneLabel })}
              </p>
              {/* `field-sizing-content` fait grandir le champ avec le texte —
                  excellent au fil de la page, ruineux dans une barre collée en
                  bas : un long message finirait par manger l'écran entier. On
                  le plafonne donc à 8 rem sur téléphone, et il défile alors
                  LUI-MÊME, ce qui est le seul défilement imbriqué légitime
                  ici : celui de ce qu'on est en train d'écrire. */}
              <Textarea
                rows={2}
                value={body}
                disabled={blocked}
                placeholder={t("thread.placeholder")}
                className="max-md:max-h-32"
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
                  {body.trim() === "" ? (
                    /* « Cmd/Ctrl + Entrée » est un raccourci qui n'existe PAS
                       sur un clavier de téléphone : l'écrire là-bas, c'était
                       promettre un chemin introuvable pendant que le seul vrai
                       chemin — le bouton — se faisait discret. Chaque appareil
                       lit donc la phrase qui est vraie chez lui. */
                    <>
                      <span className="hidden max-md:inline">{t("thread.hintTouch")}</span>
                      <span className="max-md:hidden">{t("thread.hint")}</span>
                    </>
                  ) : (
                    // Le nombre de segments décide du coût réel de l'envoi.
                    t("thread.segments", { chars: analysis.units, segments: analysis.segments })
                  )}
                </p>
                <Button
                  size="sm"
                  // Pleine largeur sur téléphone : le geste qui ENVOIE hors de
                  // l'application ne se vise pas au coin de l'écran.
                  className="min-h-11 text-white md:min-h-8 max-md:w-full"
                  // Le bouton qui envoie VRAIMENT porte la couleur du canal ; tous
                  // les autres boutons de la fiche sont bleus.
                  style={{ backgroundColor: SMS.color }}
                  disabled={pending || blocked || body.trim() === ""}
                  onClick={send}
                >
                  <SendIcon />
                  {pending ? t("thread.sending") : t("thread.send")}
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function MessageBubble({
  message,
  dfnsLocale,
  onCancel,
  busy,
}: {
  message: SmsMessageData;
  dfnsLocale: typeof fr;
  /** null : ce regard ne rappelle pas un envoi — la bulle reste lisible. */
  onCancel: ((id: string) => void) | null;
  busy: boolean;
}) {
  const t = useTranslations("conversations");
  const outbound = message.direction === "out";
  // La MÊME liste que la vue « Échecs » de la boîte : une bulle rouge ici et
  // une ligne là-bas doivent parler du même fait.
  const failed = (FAILED_SEND_STATUSES as readonly string[]).includes(message.status ?? "");
  const cancelled = message.status === "cancelled";
  const skipCode = message.skipReason ? message.skipReason.split(":")[0] : null;
  // Encore en file : la seule fenêtre où « annuler » veut dire quelque chose.
  const cancellable =
    onCancel !== null &&
    outbound &&
    message.status === "queued" &&
    !message.id.startsWith(DRAFT_PREFIX);

  return (
    <div className={cn("flex flex-col gap-1", outbound ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap",
          outbound
            ? failed
              ? "bg-destructive/10 text-foreground ring-1 ring-destructive/40"
              : cancelled
                ? "bg-muted text-muted-foreground line-through"
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
      {/* Non envoyé : la RAISON est dite. « Message mis en file » puis plus
          rien était la pire réponse possible pour un téléphoniste. */}
      {skipCode ? (
        <p className="px-1 text-[11px] font-medium text-destructive">
          {t("thread.skippedLabel", {
            reason: t.has(`thread.skip.${skipCode}`) ? t(`thread.skip.${skipCode}` as never) : skipCode,
          })}
        </p>
      ) : null}

      {cancellable ? (
        <Button
          variant="ghost"
          size="sm"
          className="min-h-11 px-2 text-[11px] text-muted-foreground md:min-h-7"
          disabled={busy}
          onClick={() => onCancel(message.id)}
        >
          <Undo2Icon className="size-3" /> {t("thread.cancel")}
        </Button>
      ) : null}
    </div>
  );
}
