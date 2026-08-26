"use client";

import { enUS, fr } from "date-fns/locale";
import {
  AlertTriangleIcon,
  CheckIcon,
  MessageCircleIcon,
  MoonIcon,
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
  markConversationHandledAction,
} from "@/app/(app)/conversations/actions";
import {
  ATTENTION_KIND_LOOK,
  ATTENTION_LOOK,
  CONVERSATION_STATE_LOOK,
  LookGlyph,
  LookIcon,
  lookTint,
  type Look,
} from "@/components/look";
import {
  attentionKindOf,
  conversationStateOf,
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

/** Les onglets : les quatre états exclusifs d'un fil, plus « toutes ». */
type Tab = ConversationState | "all";
const TABS: Tab[] = ["attention", "human", "ai", "finished", "all"];
const POLL_MS = 25_000;

/**
 * Boîte de réception.
 *
 * Une seule règle d'architecture : un fil est TOUJOURS dans exactement un
 * état (`conversationStateOf`), et chaque onglet montre un état. Avant, les
 * onglets se recoupaient (« IA en pause » et « à traiter » partageaient des
 * fils, « les miennes » coupait au travers) et un fil clos portait encore la
 * puce d'alerte de la pause IA : on lisait tout, on ne comprenait rien.
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

  const counts = useMemo(() => {
    const c: Record<Tab, number> = { attention: 0, human: 0, ai: 0, finished: 0, all: rows.length };
    for (const row of rows) c[conversationStateOf(row)] += 1;
    return c;
  }, [rows]);
  const mineCount = useMemo(
    () => rows.filter((r) => r.assignedToId === currentUserId).length,
    [rows, currentUserId],
  );

  const visible = useMemo(() => {
    const base = mineOnly ? rows.filter((r) => r.assignedToId === currentUserId) : rows;
    const inTab = tab === "all" ? base : base.filter((r) => conversationStateOf(r) === tab);
    // « À traiter » est une FILE : le client qui attend depuis le plus
    // longtemps passe en premier. Les autres vues sont des journaux : le plus
    // récent d'abord.
    const time = (r: InboxRow) => (r.lastAt ? Date.parse(r.lastAt) : 0);
    return [...inTab].sort((a, b) => (tab === "attention" ? time(a) - time(b) : time(b) - time(a)));
  }, [rows, tab, mineOnly, currentUserId]);

  // Dans « à traiter », répondre et réparer ne sont pas le même métier : deux
  // sections plutôt qu'un entremêlement.
  const replyRows = useMemo(
    () => visible.filter((r) => attentionKindOf(r.attentionReason ?? "") === "reply"),
    [visible],
  );
  const engineRows = useMemo(
    () => visible.filter((r) => attentionKindOf(r.attentionReason ?? "") === "engine"),
    [visible],
  );

  const handle = (row: InboxRow) => {
    startTransition(async () => {
      const result = await markConversationHandledAction(row.id);
      if (!result.ok) {
        toast.error(t("error"));
        return;
      }
      toast.success(t("inbox.handled"));
      emitDataChange("sms");
      router.refresh();
    });
  };

  const claim = (row: InboxRow) => {
    startTransition(async () => {
      const result = await assignConversationAction({
        conversationId: row.id,
        userId: currentUserId,
      });
      if (!result.ok) {
        toast.error(t("error"));
        return;
      }
      emitDataChange("sms");
      router.refresh();
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

  const rowProps = { currentUserId, pending, onClaim: claim, onHandle: handle, dfnsLocale };

  return (
    <div className="space-y-4">
      <HealthStrip health={health} />

      {/* Les onglets sont les QUATRE états, plus « toutes » ; « les miennes »
          n'est pas un cinquième état, c'est un filtre qui coupe au travers —
          d'où un interrupteur à part, pas un onglet de plus. */}
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

      {visible.length === 0 ? (
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
              {replyRows.map((row) => (
                <InboxRowCard key={row.id} row={row} state="attention" {...rowProps} />
              ))}
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
              {engineRows.map((row) => (
                <InboxRowCard key={row.id} row={row} state="attention" {...rowProps} />
              ))}
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
      ) : (
        <div className="space-y-2">
          {visible.map((row) => (
            <InboxRowCard
              key={row.id}
              row={row}
              state={tab === "all" ? conversationStateOf(row) : tab}
              {...rowProps}
            />
          ))}
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
 * Toute la carte est UN lien vers la fiche client — viser un petit bouton
 * depuis un cellulaire en pleine journée d'appels était le geste le plus
 * fréquent et le plus pénible de l'écran. Les vrais boutons (s'attribuer,
 * marquer traité) flottent au-dessus du lien (`z-10`).
 *
 * Et chaque dernier message dit QUI l'a écrit : « Parfait, je vous confirme
 * jeudi » n'a pas le même sens selon que c'est le client ou l'assistant.
 */
function InboxRowCard({
  row,
  state,
  currentUserId,
  pending,
  onClaim,
  onHandle,
  dfnsLocale,
}: {
  row: InboxRow;
  state: ConversationState;
  currentUserId: string;
  pending: boolean;
  onClaim: (row: InboxRow) => void;
  onHandle: (row: InboxRow) => void;
  dfnsLocale: typeof fr;
}) {
  const t = useTranslations("conversations");
  const stateLook = CONVERSATION_STATE_LOOK[state];
  // La pastille de gauche porte le MOTIF quand il y en a un (à traiter,
  // terminée), l'état sinon (assistant, main humaine).
  const reasonLook =
    row.attentionReason !== null ? (ATTENTION_LOOK[row.attentionReason] ?? stateLook) : stateLook;
  const rowLook = state === "attention" || state === "finished" ? reasonLook : stateLook;

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

  const showActions = state === "attention";
  const assignedToMe = row.assignedToId === currentUserId;

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
          ) : state !== "attention" ? (
            <Badge variant="outline" className="gap-1 font-normal" style={lookTint(stateLook)}>
              <stateLook.Icon aria-hidden />
              {state === "ai" && row.assistantName ? row.assistantName : t(`inbox.state.${state}`)}
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1 font-normal" style={lookTint(stateLook)}>
              <stateLook.Icon aria-hidden />
              {t("inbox.state.attention")}
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

        {/* L'état de l'assistant sur les fils qu'il mène : « en attente du
            client » quand il a écrit le dernier — le fil ne demande rien. */}
        {state === "ai" && row.lastDirection === "out" ? (
          <p className="text-xs text-muted-foreground">{t("inbox.aiWaitingClient")}</p>
        ) : null}

        {showActions || row.assignedToName ? (
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            {row.assignedToName ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <UserRoundIcon aria-hidden className="size-3" />
                {assignedToMe ? t("inbox.you") : row.assignedToName}
              </span>
            ) : null}
            <span className="flex-1" />
            {showActions && !assignedToMe ? (
              <Button
                variant="ghost"
                size="sm"
                className="relative z-10 min-h-11 md:min-h-8"
                disabled={pending}
                onClick={() => onClaim(row)}
              >
                {t("inbox.assignToMe")}
              </Button>
            ) : null}
            {showActions ? (
              <Button
                variant="outline"
                size="sm"
                className="relative z-10 min-h-11 md:min-h-8"
                disabled={pending}
                onClick={() => onHandle(row)}
              >
                <CheckIcon aria-hidden /> {t("inbox.markHandled")}
              </Button>
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
