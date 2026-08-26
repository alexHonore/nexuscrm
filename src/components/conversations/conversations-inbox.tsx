"use client";

import { enUS, fr } from "date-fns/locale";
import {
  AlertTriangleIcon,
  BotIcon,
  CheckIcon,
  MessageCircleIcon,
  MoonIcon,
  PencilLineIcon,
  PowerOffIcon,
  RotateCcwIcon,
  SunIcon,
  UserRoundIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  assignConversationAction,
  handBackToAiAction,
  markConversationHandledAction,
  retryAiTurnAction,
  setConversationAiAction,
} from "@/app/(app)/conversations/actions";
import {
  ATTENTION_KIND_LOOK,
  ATTENTION_LOOK,
  CONVERSATION_STATE_LOOK,
  TOOL_LOOK,
  LookGlyph,
  LookIcon,
  lookTint,
  type Look,
} from "@/components/look";
import {
  attentionKindOf,
  conversationStateOf,
  type ConversationDeed,
  type ConversationState,
} from "@/components/conversations/state";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { emitDataChange, useDataChange, useVisiblePolling } from "@/lib/live";
import { cn } from "@/lib/utils";

export type InboxRow = {
  id: string;
  clientId: string | null;
  clientName: string;
  clientPhone: string;
  needsAttention: boolean;
  attentionReason: string | null;
  aiEnabled: boolean;
  assignedToId: string | null;
  assignedToName: string | null;
  /** Nom de l'assistant qui tient le fil — null si un humain répond. */
  assistantName: string | null;
  /** Ce que l'assistant a FAIT (rendez-vous, classement, rappel…) — sa conclusion visible. */
  did: ConversationDeed[];
  lastBody: string | null;
  /** QUI a parlé en dernier : sans ça, impossible de savoir si on attend le client ou s'il nous attend. */
  lastDirection: "in" | "out" | null;
  lastSource: string | null;
  lastAt: string | null;
};

export type EngineHealth = {
  killSwitch: boolean;
  mode: "live" | "sandbox" | "dry_run";
  sendWindowOpen: boolean;
  queued: number;
  failed: number;
  suppressed: number;
};

/**
 * Les QUATRE vues (demande d'Alex, 2026-08-25 au soir) :
 *
 *  · « À traiter » — tout ce qui repose sur un humain : les fils qui
 *    réclament une décision ET ceux qu'un humain tient déjà en main.
 *  · « En attente du client » — l'assistant a écrit, la réponse n'est pas
 *    arrivée. Rien à faire, mais on veut le VOIR.
 *  · « Refus » — les non explicites (refus ferme, pas intéressé, STOP).
 *  · « Toutes » — chaque fil, RANGÉ par situation, avec un en-tête par
 *    groupe — pas une pile plate à déchiffrer.
 */
type Tab = "attention" | "waiting" | "refused" | "all";
const TABS: Tab[] = ["attention", "waiting", "refused", "all"];

/** Quels états chaque vue montre. `all` les montre tous, en sections. */
const TAB_STATES: Record<Exclude<Tab, "all">, ConversationState[]> = {
  attention: ["attention", "human"],
  waiting: ["ai"],
  refused: ["refused"],
};

/** L'ordre des sections de « Toutes » : l'urgent d'abord, le clos à la fin. */
const ALL_SECTIONS: ConversationState[] = ["attention", "human", "ai", "refused", "concluded"];

const POLL_MS = 25_000;

/**
 * Chaque acte de l'assistant reprend le pictogramme de l'OUTIL qui l'a posé
 * (`TOOL_LOOK`) : la même image dans l'éditeur d'assistant, dans les traces
 * et ici — un vocabulaire, pas trois.
 */
const DEED_LOOK: Record<ConversationDeed, Look> = {
  booked: TOOL_LOOK.book_meeting,
  categorized: TOOL_LOOK.set_category,
  qualified: TOOL_LOOK.update_qualification,
  followup: TOOL_LOOK.schedule_followup,
  note: TOOL_LOOK.add_client_comment,
  transferred: TOOL_LOOK.transfer_assistant,
};

/**
 * Boîte de réception.
 *
 * Une seule règle d'architecture : un fil est TOUJOURS dans exactement un
 * état (`conversationStateOf`), et chaque vue est une liste d'états — les
 * vues ne se recoupent jamais (« les miennes » reste un filtre transversal).
 *
 * La bande d'état reste en HAUT et non repliée : découvrir après avoir tapé
 * trois réponses que les envois sont suspendus, ou qu'on est en simulation,
 * est la pire manière de l'apprendre.
 */
export function ConversationsInbox({
  rows,
  currentUserId,
  health,
  isAdmin = false,
}: {
  rows: InboxRow[];
  currentUserId: string;
  health: EngineHealth;
  /** Le rejeu après panne est un geste d'administrateur (l'API le refuse aux autres). */
  isAdmin?: boolean;
}) {
  const t = useTranslations("conversations");
  const locale = useLocale();
  const dfnsLocale = locale === "en" ? enUS : fr;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [tab, setTab] = useState<Tab>("attention");
  const [mineOnly, setMineOnly] = useState(false);

  useDataChange(["sms"], () => router.refresh());
  useVisiblePolling(POLL_MS, () => router.refresh());

  const base = useMemo(
    () => (mineOnly ? rows.filter((r) => r.assignedToId === currentUserId) : rows),
    [rows, mineOnly, currentUserId],
  );

  const byState = useMemo(() => {
    const groups: Record<ConversationState, InboxRow[]> = {
      attention: [],
      human: [],
      ai: [],
      refused: [],
      concluded: [],
    };
    for (const row of base) groups[conversationStateOf(row)].push(row);
    // « À traiter » est une FILE : le client qui attend depuis le plus
    // longtemps passe en premier. Les autres vues sont des journaux : le
    // plus récent d'abord.
    const time = (r: InboxRow) => (r.lastAt ? Date.parse(r.lastAt) : 0);
    groups.attention.sort((a, b) => time(a) - time(b));
    for (const state of ["human", "ai", "refused", "concluded"] as const) {
      groups[state].sort((a, b) => time(b) - time(a));
    }
    return groups;
  }, [base]);

  const counts = useMemo(
    () => ({
      attention: byState.attention.length + byState.human.length,
      waiting: byState.ai.length,
      refused: byState.refused.length,
      all: base.length,
    }),
    [byState, base],
  );
  const mineCount = useMemo(
    () => rows.filter((r) => r.assignedToId === currentUserId).length,
    [rows, currentUserId],
  );

  // Dans « à traiter », répondre et réparer ne sont pas le même métier.
  const replyRows = useMemo(
    () => byState.attention.filter((r) => attentionKindOf(r.attentionReason ?? "") === "reply"),
    [byState],
  );
  const engineRows = useMemo(
    () => byState.attention.filter((r) => attentionKindOf(r.attentionReason ?? "") === "engine"),
    [byState],
  );

  const act = (fn: () => Promise<boolean>) => {
    startTransition(async () => {
      const ok = await fn();
      if (!ok) return;
      emitDataChange("sms");
      router.refresh();
    });
  };

  const handle = (row: InboxRow) =>
    act(async () => {
      const result = await markConversationHandledAction(row.id);
      if (!result.ok) {
        toast.error(t("error"));
        return false;
      }
      toast.success(t("inbox.handled"));
      return true;
    });

  // « Rendre à l'IA » : l'assistant reprend le fil ET répond tout de suite à
  // l'entrant qui attend — la décision vaut traitement.
  const handBack = (row: InboxRow) =>
    act(async () => {
      const result = await handBackToAiAction(row.id);
      if (!result.ok) {
        toast.error(
          result.error === "assistantUnavailable" ? t("thread.assistantUnavailable") : t("error"),
        );
        return false;
      }
      toast.success(t("inbox.handedBack"));
      return true;
    });

  // « Réessayer » : rejouer le tour d'UN fil en panne — entrants rouverts,
  // ouverture de campagne remise en file, IA remise en selle. Le toast dit
  // honnêtement si quelque chose est reparti.
  const retry = (row: InboxRow) =>
    act(async () => {
      const result = await retryAiTurnAction(row.id);
      if (!result.ok) {
        toast.error(
          result.error === "assistantUnavailable" ? t("thread.assistantUnavailable") : t("error"),
        );
        return false;
      }
      if (result.relaunched) toast.success(t("inbox.retried"));
      else toast.info(t("inbox.retriedNothing"));
      return true;
    });

  // « Je réponds » : prendre le fil (IA coupée, fil attribué) et atterrir
  // directement dans la zone de rédaction de la fiche. La pastille « à
  // traiter » ne tombe QUE lorsque la réponse part vraiment (l'envoi manuel
  // la retire) — cliquer n'est pas répondre.
  const respond = (row: InboxRow) => {
    startTransition(async () => {
      if (row.aiEnabled) {
        const paused = await setConversationAiAction({
          conversationId: row.id,
          enabled: false,
          reason: null,
        });
        if (!paused.ok) {
          toast.error(t("error"));
          return;
        }
      }
      if (row.assignedToId !== currentUserId) {
        await assignConversationAction({ conversationId: row.id, userId: currentUserId });
      }
      emitDataChange("sms");
      if (row.clientId) router.push(`/clients/${row.clientId}`);
      else router.refresh();
    });
  };

  // Après une panne de modèle, les tours morts ne repartent pas seuls : ce
  // bouton rejoue tout ce qui peut l'être (réponses, ouvertures de campagne,
  // entrants orphelins). Idempotent — le presser « pour rien » ne fait rien.
  const [replaying, setReplaying] = useState(false);
  const replay = async () => {
    setReplaying(true);
    try {
      const res = await fetch("/api/admin/sms/replay-llm-errors", { method: "POST" });
      if (!res.ok) throw new Error(`replay_${res.status}`);
      const d = (await res.json()) as {
        replayedInbound: number;
        replayedOutreach: number;
        replayedOrphans: number;
      };
      toast.success(
        t("inbox.replay.done", {
          count: d.replayedInbound + d.replayedOutreach + d.replayedOrphans,
        }),
      );
      emitDataChange("sms");
      router.refresh();
    } catch {
      toast.error(t("error"));
    } finally {
      setReplaying(false);
    }
  };

  const rowProps = {
    currentUserId,
    pending,
    onHandle: handle,
    onHandBack: handBack,
    onRetry: retry,
    onRespond: respond,
    dfnsLocale,
  };

  const renderRows = (list: InboxRow[]) =>
    list.map((row) => (
      <InboxRowCard key={row.id} row={row} state={conversationStateOf(row)} {...rowProps} />
    ));

  const visibleCount = tab === "all" ? counts.all : counts[tab];

  return (
    <div className="space-y-4">
      <HealthStrip health={health} />

      <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
        <div className="flex w-max items-center gap-2">
          {TABS.map((key) => (
            <Button
              key={key}
              variant={tab === key ? "default" : "outline"}
              size="sm"
              className="min-h-11 md:min-h-9"
              aria-pressed={tab === key}
              onClick={() => setTab(key)}
            >
              {t(`inbox.tabs.${key}`)}
              <Badge
                variant="secondary"
                className="ml-1"
                // Le compte « à traiter » reste teinté même quand l'onglet
                // n'est pas actif : c'est LE chiffre de l'écran.
                style={
                  key === "attention" && counts.attention > 0 && tab !== key
                    ? lookTint(CONVERSATION_STATE_LOOK.attention)
                    : undefined
                }
              >
                {counts[key]}
              </Badge>
            </Button>
          ))}
          <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden />
          <Button
            variant={mineOnly ? "secondary" : "ghost"}
            size="sm"
            className="min-h-11 md:min-h-9"
            aria-pressed={mineOnly}
            onClick={() => setMineOnly((v) => !v)}
          >
            <UserRoundIcon aria-hidden />
            {t("inbox.mine")}
            <Badge variant="secondary" className="ml-1">
              {mineCount}
            </Badge>
          </Button>
        </div>
      </div>

      {visibleCount === 0 ? (
        <EmptyState
          icon={<MessageCircleIcon />}
          title={t(`inbox.empty.${tab}.title`)}
          hint={mineOnly ? t("inbox.empty.mine") : t(`inbox.empty.${tab}.desc`)}
        />
      ) : tab === "attention" ? (
        <div className="space-y-5">
          {replyRows.length > 0 ? (
            <section className="space-y-2">
              <SectionHeader
                look={ATTENTION_KIND_LOOK.reply}
                label={t("inbox.sections.reply")}
                count={replyRows.length}
              />
              {renderRows(replyRows)}
            </section>
          ) : null}
          {engineRows.length > 0 ? (
            <section className="space-y-2">
              <SectionHeader
                look={ATTENTION_KIND_LOOK.engine}
                label={t("inbox.sections.engine")}
                count={engineRows.length}
                action={
                  isAdmin ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="relative z-10 min-h-11 md:min-h-8"
                      onClick={replay}
                      disabled={replaying}
                    >
                      <RotateCcwIcon aria-hidden />
                      {t("inbox.replay.button")}
                    </Button>
                  ) : null
                }
              />
              {renderRows(engineRows)}
            </section>
          ) : null}
          {/* Les fils qu'un humain tient déjà : pas urgents, mais ils sont du
              travail humain — c'est ICI qu'on doit les retrouver, pas dans un
              cinquième onglet. */}
          {byState.human.length > 0 ? (
            <section className="space-y-2">
              <SectionHeader
                look={CONVERSATION_STATE_LOOK.human}
                label={t("inbox.sections.held")}
                count={byState.human.length}
              />
              {renderRows(byState.human)}
            </section>
          ) : null}
          {/* Pas de panne visible mais un rejeu quand même possible (entrants
              orphelins, tours morts sans fil listé) : le geste reste offert,
              discrètement. */}
          {isAdmin && engineRows.length === 0 ? (
            <div className="flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                className="min-h-11 text-muted-foreground md:min-h-8"
                onClick={replay}
                disabled={replaying}
              >
                <RotateCcwIcon aria-hidden />
                {t("inbox.replay.button")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : tab === "all" ? (
        // « Toutes » n'est pas une pile plate : chaque situation a son
        // en-tête, pour VOIR clairement — c'est toute sa raison d'être.
        <div className="space-y-5">
          {ALL_SECTIONS.map((state) =>
            byState[state].length > 0 ? (
              <section key={state} className="space-y-2">
                <SectionHeader
                  look={CONVERSATION_STATE_LOOK[state]}
                  label={t(`inbox.state.${state}`)}
                  count={byState[state].length}
                />
                {renderRows(byState[state])}
              </section>
            ) : null,
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {renderRows(TAB_STATES[tab].flatMap((state) => byState[state]))}
        </div>
      )}
    </div>
  );
}

function SectionHeader({
  look,
  label,
  count,
  action,
}: {
  look: Look;
  label: string;
  count: number;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-2">
      <h2 className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        <LookGlyph look={look} className="size-3.5" />
        {label}
        <span className="font-normal">· {count}</span>
      </h2>
      <span className="flex-1" />
      {action}
    </div>
  );
}

/**
 * Une ligne de la boîte.
 *
 * Toute la carte est UN lien vers la fiche client. Les fils qui réclament une
 * décision offrent les TROIS réponses possibles, sur place : « Rendre à
 * l'IA » (l'assistant continue et répond tout de suite), « Je réponds »
 * (prise en main + la fiche s'ouvre sur la zone de rédaction), « Marquer
 * traité » (rien à faire). Décider ne doit pas demander d'ouvrir trois
 * écrans.
 *
 * Et chaque dernier message dit QUI l'a écrit : « Parfait, je vous confirme
 * jeudi » n'a pas le même sens selon que c'est le client ou l'assistant.
 */
function InboxRowCard({
  row,
  state,
  currentUserId,
  pending,
  onHandle,
  onHandBack,
  onRetry,
  onRespond,
  dfnsLocale,
}: {
  row: InboxRow;
  state: ConversationState;
  currentUserId: string;
  pending: boolean;
  onHandle: (row: InboxRow) => void;
  onHandBack: (row: InboxRow) => void;
  onRetry: (row: InboxRow) => void;
  onRespond: (row: InboxRow) => void;
  dfnsLocale: typeof fr;
}) {
  const t = useTranslations("conversations");
  // Une PANNE se réessaie (entrants rouverts, tour rejoué) ; une demande du
  // client se REND à l'IA ou se répond — pas le même geste.
  const isEngine =
    state === "attention" && attentionKindOf(row.attentionReason ?? "") === "engine";
  const stateLook = CONVERSATION_STATE_LOOK[state];
  // La pastille de gauche porte le MOTIF quand il y en a un (à traiter,
  // refus, conclu), l'état sinon (assistant, main humaine).
  const reasonLook =
    row.attentionReason !== null ? (ATTENTION_LOOK[row.attentionReason] ?? stateLook) : stateLook;
  const rowLook = state === "human" || state === "ai" ? stateLook : reasonLook;

  // Le client a parlé en dernier et le fil est à traiter : c'est LUI qui
  // attend, et depuis l'heure affichée. Le texte reste en pleine couleur.
  const clientWaiting = state === "attention" && row.lastDirection === "in";

  const speaker =
    row.lastDirection === "in"
      ? t("inbox.from.client")
      : row.lastSource === "agent"
        ? t("inbox.from.assistant")
        : row.lastSource === "opener" || row.lastSource === "ladder"
          ? t("inbox.from.campaign")
          : row.lastSource === "system"
            ? t("inbox.from.system")
            : t("inbox.from.team");

  return (
    <article
      className={cn(
        "relative flex items-start gap-3 rounded-xl border bg-card p-3 shadow-xs transition-colors md:p-4",
        row.clientId && "hover:border-ring/60 hover:bg-accent/40",
        state === "attention" && "border-l-4",
      )}
      style={state === "attention" ? { borderLeftColor: rowLook.color } : undefined}
    >
      {row.clientId ? (
        <Link
          href={`/clients/${row.clientId}`}
          className="absolute inset-0 rounded-xl"
          aria-label={`${t("inbox.open")} — ${row.clientName}`}
        />
      ) : null}

      <LookIcon look={rowLook} className="mt-0.5" />

      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold">{row.clientName}</span>
          {row.attentionReason !== null ? (
            <Badge variant="outline" className="gap-1 font-normal" style={lookTint(reasonLook)}>
              <reasonLook.Icon aria-hidden />
              {t(`inbox.reason.${row.attentionReason}` as never)}
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1 font-normal" style={lookTint(stateLook)}>
              <stateLook.Icon aria-hidden />
              {state === "ai" && row.assistantName ? row.assistantName : t(`inbox.state.${state}`)}
            </Badge>
          )}
          {/* Un fil à traiter dont l'IA est coupée : personne ne répondra
              automatiquement — ça se dit, même quand le motif dit autre chose. */}
          {state === "attention" && !row.aiEnabled ? (
            <Badge
              variant="outline"
              className="gap-1 font-normal"
              style={lookTint(CONVERSATION_STATE_LOOK.human)}
            >
              <CONVERSATION_STATE_LOOK.human.Icon aria-hidden />
              {t("ai.off")}
            </Badge>
          ) : null}
          <span className="flex-1" />
          {row.lastAt ? (
            <span
              className={cn(
                "text-xs whitespace-nowrap",
                clientWaiting ? "font-medium" : "text-muted-foreground",
              )}
              style={clientWaiting ? { color: CONVERSATION_STATE_LOOK.attention.color } : undefined}
            >
              <RelativeTime date={row.lastAt} locale={dfnsLocale} />
            </span>
          ) : null}
        </div>

        {row.lastBody ? (
          <p className="line-clamp-2 text-sm">
            <span className={cn("font-medium", clientWaiting ? undefined : "text-muted-foreground")}>
              {speaker}&nbsp;:{" "}
            </span>
            <span className={clientWaiting ? "text-foreground" : "text-muted-foreground"}>
              {row.lastBody}
            </span>
          </p>
        ) : null}

        {/* La conclusion de l'assistant — ce qu'il a FAIT sur ce fil. Un
            rendez-vous réservé ou une fiche classée se voient ici, sans
            ouvrir la fiche pour le découvrir. */}
        {row.did.length > 0 ? (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {row.did.map((deed) => (
              <span key={deed} className="inline-flex items-center gap-1">
                <LookGlyph look={DEED_LOOK[deed]} className="size-3" />
                {t(`inbox.did.${deed}`)}
              </span>
            ))}
          </p>
        ) : null}

        {/* Sur les fils que l'assistant mène : dire si la balle est chez le
            client ou si la réponse de l'assistant est en route. */}
        {state === "ai" ? (
          <p className="text-xs text-muted-foreground">
            {row.lastDirection === "out" ? t("inbox.aiWaitingClient") : t("inbox.aiComposing")}
          </p>
        ) : null}

        {state === "attention" || state === "human" || row.assignedToName ? (
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            {row.assignedToName ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <UserRoundIcon aria-hidden className="size-3" />
                {row.assignedToId === currentUserId ? t("inbox.you") : row.assignedToName}
              </span>
            ) : null}
            <span className="flex-1" />
            {/* Les 2-3 décisions possibles, sur place. « Réessayer » sur une
                panne, « Rendre à l'IA » sur une demande — et seulement si un
                assistant tient réellement le fil. */}
            {(state === "attention" || state === "human") && row.assistantName ? (
              <Button
                variant="outline"
                size="sm"
                className="relative z-10 min-h-11 md:min-h-8"
                disabled={pending}
                onClick={() => (isEngine ? onRetry(row) : onHandBack(row))}
              >
                {isEngine ? <RotateCcwIcon aria-hidden /> : <BotIcon aria-hidden />}
                {isEngine ? t("inbox.actions.retry") : t("inbox.actions.handBack")}
              </Button>
            ) : null}
            {state === "attention" ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="relative z-10 min-h-11 md:min-h-8"
                  disabled={pending}
                  onClick={() => onRespond(row)}
                >
                  <PencilLineIcon aria-hidden /> {t("inbox.actions.respond")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="relative z-10 min-h-11 md:min-h-8"
                  disabled={pending}
                  onClick={() => onHandle(row)}
                >
                  <CheckIcon aria-hidden /> {t("inbox.markHandled")}
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function HealthStrip({ health }: { health: EngineHealth }) {
  const t = useTranslations("conversations");
  // Deux états méritent une ALERTE, pas une pastille : rien ne part, ou rien
  // ne part pour de vrai. Les confondre avec « 12 en file » serait les noyer.
  const suspended = health.killSwitch;
  const notLive = health.mode !== "live";

  return (
    <div className="space-y-2">
      {suspended ? (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm font-medium text-destructive"
        >
          <PowerOffIcon className="size-4 shrink-0" />
          {t("health.killSwitch.on")}
        </div>
      ) : null}

      {notLive ? (
        <div
          role="status"
          className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
        >
          <AlertTriangleIcon className="size-4 shrink-0" />
          {t(`health.mode.${health.mode}`)}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          {health.sendWindowOpen ? (
            <SunIcon className="size-3.5" aria-hidden />
          ) : (
            <MoonIcon className="size-3.5" aria-hidden />
          )}
          {t(health.sendWindowOpen ? "health.quiet.open" : "health.quiet.closed")}
        </span>
        <span>{t("health.queue", { count: health.queued })}</span>
        {health.failed > 0 ? (
          <span className="font-medium text-destructive">
            {t("health.failed", { count: health.failed })}
          </span>
        ) : null}
        <span>{t("health.suppressed", { count: health.suppressed })}</span>
      </div>
    </div>
  );
}
