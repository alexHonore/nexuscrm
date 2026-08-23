"use client";

import {
  AlertTriangleIcon,
  BellRingIcon,
  CheckCircle2,
  Loader2,
  RotateCcw,
  PlayIcon,
  SendIcon,
  WrenchIcon,
  XCircle,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { analyzeSms } from "@/lib/sms/segments";
import { cn } from "@/lib/utils";
import { EDITOR_TAB_LOOK } from "@/components/look";
import { ApiError, api } from "../api";
import { TabHead, useTabHead } from "./layout";
import type { TabProps } from "./types";

type Verdict = {
  key: string;
  label: string;
  severity: "block" | "warn" | "off";
  passed: boolean;
  reason?: string;
};

/** Miroir de `SandboxTurnResult` (lib/agent/sandbox.ts). */
type TurnOutcome = "sent" | "blocked" | "stopped" | "handoff" | "error";
type TurnReason =
  | "optout"
  | "hard_refusal"
  | "client_wants_human"
  | "goal_chain_exhausted"
  | "max_turns"
  | "tool_stop"
  | "tool_handoff"
  | "blocked_after_regeneration"
  | "guardrail_unavailable"
  | "booking_failed"
  | "no_text"
  | "llm_error";

type TurnResult = {
  draft: string;
  outcome: TurnOutcome;
  reason: TurnReason | null;
  blocked: boolean;
  verdicts: Verdict[];
  toolCalls: { name: string; args: unknown; ok: boolean; result: string }[];
  classification: {
    optOut: boolean;
    refusal: "none" | "soft" | "hard";
    wantsHuman: boolean;
    qualification: Record<string, unknown>;
  };
  classifierError: string | null;
  rung: string;
  requiredFields: string[];
  runtimeBlock: string;
  instruction: string | null;
  softRefusals: number;
  qualification: Record<string, unknown>;
  turnsUsed: number;
  regenerations: number;
  droppedParagraphs: number;
  fullText: string;
  usage: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
    latencyMs: number;
    modelServed: string | null;
  } | null;
  error: string | null;
};

/**
 * Une bulle. `content` est ce qui PARTIRAIT réellement : vide quand la
 * production n'enverrait rien. Le texte écrit mais non envoyé vit dans
 * `result.fullText`. `seeded` marque l'ouverture collée par l'admin (la
 * campagne l'a envoyée avant que l'assistant ne parle).
 */
type Turn = {
  role: "assistant" | "user";
  content: string;
  result?: TurnResult;
  seeded?: boolean;
  /** Tour de RELANCE (le contact s'était tu) — compte pour le barreau suivant. */
  followUp?: boolean;
};

/** Relances déjà parties — la prochaine est la n+1, comme le barreau suivant. */
function followUpsSent(turns: Turn[]): number {
  return turns.filter((x) => x.followUp === true && wasSent(x)).length;
}

const TRIGGERS = ["inbound", "lead_created", "category_changed"] as const;
const SUGGESTIONS = ["buy", "later", "stop", "value"] as const;
/** Verdicts rendus AVANT tout appel au générateur (mêmes portes qu'en production). */
const GATE_REASONS: ReadonlySet<string> = new Set([
  "optout",
  "hard_refusal",
  "client_wants_human",
  "goal_chain_exhausted",
  "max_turns",
]);

/** Ce tour a-t-il produit un message que la production aurait envoyé? */
function wasSent(turn: Turn): boolean {
  return turn.role === "user" || turn.seeded === true || turn.result?.outcome === "sent";
}

/** Après ces verdicts, la production désactive l'IA sur la conversation. */
function closesConversation(result: TurnResult | undefined): boolean {
  return result?.outcome === "stopped" || result?.outcome === "handoff";
}

/**
 * Bac à sable — parler à l'assistant comme si on était le client.
 *
 * Ce qui distingue cet écran d'un simple aperçu de prompt : chaque réponse est
 * accompagnée de ce que la PRODUCTION en ferait (envoyé, bloqué, arrêt,
 * escalade), de ce que les garde-fous en ont dit, du cran d'objectif courant
 * et des outils que le modèle a VOULU appeler. Régler une persistance ou un
 * ton sans voir ces choses revient à changer un chiffre et espérer.
 *
 * Rien n'est envoyé, rien n'est écrit, rien n'est réservé. Les appels d'outils
 * sont simulés, jamais exécutés : un essai qui bloquerait une vraie plage
 * d'agenda serait un piège.
 *
 * L'historique renvoyé au modèle ne contient que ce qui serait réellement
 * parti : un brouillon bloqué ou vide n'entre pas dans le fil, exactement
 * comme en production — sinon le modèle lirait une conversation qui n'a pas
 * existé, et certains fournisseurs refusent un message d'assistant vide.
 */
export function SandboxTab({ data }: TabProps) {
  const t = useTranslations("assistants");
  const head = useTabHead("sandbox");
  const router = useRouter();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [inbound, setInbound] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lead, setLead] = useState({ firstName: "Marie", city: "Québec", projectType: "achat" });
  /**
   * Ce qui déclenche la conversation.
   *
   * « Le client écrit » n'est qu'un cas sur trois : un assistant part aussi sur
   * un nouveau lead ou un changement d'étape, et c'est LUI qui écrit le premier
   * message — puis relance si le contact se tait.
   */
  const [trigger, setTrigger] = useState<"inbound" | "lead_created" | "category_changed">(
    "inbound",
  );
  /** L'ouverture déjà envoyée par la campagne, quand le client répond à un message. */
  const [opener, setOpener] = useState("");
  /** Le contexte de campagne que la production donnerait au modèle. */
  const [campaign, setCampaign] = useState({ name: "", description: "", followUps: 2 });
  const stateRef = useRef({
    qualification: {} as Record<string, unknown>,
    softRefusals: 0,
  });

  const notCompiled = data.compiledPrompt === null;
  const [compiling, setCompiling] = useState(false);

  /**
   * Compiler DEPUIS le bac à sable.
   *
   * Un assistant fraîchement créé n'a pas de prompt compilé, et l'onglet
   * disait seulement « compilez d'abord » : une impasse. Le geste manquant
   * était à un clic, mais dans un autre onglet — et rien ne le disait.
   */
  const compileNow = async () => {
    setCompiling(true);
    setError(null);
    try {
      await api(`/api/assistants/${data.id}/compile`, { method: "POST" });
      router.refresh();
    } catch {
      setError(t("sandbox.compileFailed"));
    } finally {
      setCompiling(false);
    }
  };

  /**
   * Un tour. `text` vide = l'assistant écrit (ouverture ou relance).
   * `followUp` = le contact n'a pas répondu : on rejoue le barreau suivant.
   */
  const runTurn = async (text: string, options: { followUp?: boolean } = {}) => {
    if (busy) return;
    setBusy(true);
    setError(null);

    // L'ouverture collée par l'admin entre dans le fil AVANT le premier
    // message du client : c'est un vrai message sortant, il compte.
    const seed: Turn[] =
      turns.length === 0 && trigger === "inbound" && opener.trim() !== ""
        ? [{ role: "assistant", content: opener.trim(), seeded: true }]
        : [];
    const visible = [...seed, ...turns];
    const history = visible.filter(wasSent).map((x) => ({ role: x.role, content: x.content }));
    const startedByAssistant = visible.length > 0 && visible[0].role === "assistant";
    const step = options.followUp ? followUpsSent(visible) + 1 : 0;

    if (text !== "") setTurns([...visible, { role: "user", content: text }]);
    setInbound("");

    try {
      const result = await api<TurnResult>(`/api/assistants/${data.id}/sandbox`, {
        method: "POST",
        body: JSON.stringify({
          history,
          inbound: text,
          lead,
          trigger: text === "" ? trigger : "inbound",
          // L'ouverture est soit DANS le fil (collée ou écrite par l'assistant),
          // soit inexistante : la production ne connaît pas d'ouverture
          // invisible. Sans ouverture, la réponse est un PREMIER message
          // sortant et la règle d'identification s'applique — c'est juste.
          openerSent: startedByAssistant,
          outreach:
            text === ""
              ? {
                  step,
                  campaignName: campaign.name.trim() || undefined,
                  campaignDescription: campaign.description.trim() || undefined,
                  ladderLength: campaign.followUps + 1,
                }
              : undefined,
          qualification: stateRef.current.qualification,
          softRefusals: stateRef.current.softRefusals,
        }),
      });

      stateRef.current = {
        qualification: result.qualification,
        softRefusals: result.softRefusals,
      };

      setTurns((current) => [
        ...current,
        {
          role: "assistant",
          content: result.outcome === "sent" ? result.draft : "",
          result,
          followUp: options.followUp === true,
        },
      ]);
      if (result.error) setError(result.error);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      setError(
        code === "not_compiled"
          ? t("sandbox.notCompiled")
          : code === "rate_limited"
            ? t("sandbox.rateLimited")
            : t("sandbox.failed"),
      );
      // Le tour n'a pas eu lieu : on retire la bulle du client pour que
      // l'historique reste le reflet exact de ce que le modèle a reçu.
      if (text !== "") {
        setTurns(turns);
        setInbound(text);
      }
    } finally {
      setBusy(false);
    }
  };

  const send = () => void runTurn(inbound.trim());

  const reset = () => {
    setTurns([]);
    setError(null);
    stateRef.current = { qualification: {}, softRefusals: 0 };
  };

  const last = [...turns].reverse().find((x) => x.result)?.result;
  const lastSent = [...turns].reverse().find(wasSent);
  const nextFollowUp = followUpsSent(turns) + 1;
  // Relancer a un sens quand le dernier message PARTI est celui de l'assistant
  // (un jet bloqué entre-temps ne change rien : le contact se tait toujours).
  const canFollowUp = lastSent?.role === "assistant" && !closesConversation(last);

  return (
    <div className="space-y-4">
      <TabHead look={EDITOR_TAB_LOOK.sandbox} title={head.title} hint={head.hint} />

      <Alert>
        <AlertTriangleIcon />
        <AlertDescription>{t("sandbox.disclaimer")}</AlertDescription>
      </Alert>

      {notCompiled ? (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertDescription className="space-y-2">
            <p>{t("sandbox.notCompiled")}</p>
            <Button
              size="sm"
              variant="outline"
              className="min-h-11 md:min-h-8"
              onClick={() => void compileNow()}
              disabled={compiling}
            >
              {compiling ? <Loader2 className="animate-spin" /> : null}
              {compiling ? t("sandbox.compiling") : t("sandbox.compileNow")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Le faux client : la couche d'exécution reçoit ces valeurs, donc les
          changer change réellement ce que le modèle lit. */}
      <section className="grid gap-3 rounded-lg border p-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="sb-name">{t("sandbox.lead.firstName")}</Label>
          <Input
            id="sb-name"
            className="min-h-11 md:min-h-9"
            value={lead.firstName}
            onChange={(e) => setLead({ ...lead, firstName: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sb-city">{t("sandbox.lead.city")}</Label>
          <Input
            id="sb-city"
            className="min-h-11 md:min-h-9"
            value={lead.city}
            onChange={(e) => setLead({ ...lead, city: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sb-project">{t("sandbox.lead.projectType")}</Label>
          <Input
            id="sb-project"
            className="min-h-11 md:min-h-9"
            value={lead.projectType}
            onChange={(e) => setLead({ ...lead, projectType: e.target.value })}
          />
        </div>
      </section>

      {turns.length === 0 ? (
        <div className="space-y-3 rounded-lg border border-dashed p-4">
          <div className="space-y-1.5">
            <Label>{t("sandbox.triggerLabel")}</Label>
            <Select
              items={TRIGGERS.map((k) => ({ value: k, label: t(`sandbox.trigger.${k}`) }))}
              value={trigger}
              onValueChange={(v) => setTrigger(String(v) as typeof trigger)}
            >
              <SelectTrigger className="min-h-11 w-full md:min-h-9 md:w-80">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRIGGERS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {t(`sandbox.trigger.${k}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t(`sandbox.triggerHint.${trigger}`)}</p>
          </div>

          {/* Le contexte de campagne : la production le glisse dans la consigne
              d'ouverture et de relance (« à ne pas citer »). Sans lui, le
              modèle ne sait pas POURQUOI il écrit. */}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="sb-campaign-name">{t("sandbox.campaign.name")}</Label>
              <Input
                id="sb-campaign-name"
                className="min-h-11 md:min-h-9"
                value={campaign.name}
                placeholder={t("sandbox.campaign.namePlaceholder")}
                onChange={(e) => setCampaign({ ...campaign, name: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sb-campaign-desc">{t("sandbox.campaign.description")}</Label>
              <Input
                id="sb-campaign-desc"
                className="min-h-11 md:min-h-9"
                value={campaign.description}
                onChange={(e) => setCampaign({ ...campaign, description: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sb-campaign-followups">{t("sandbox.campaign.followUps")}</Label>
              <Input
                id="sb-campaign-followups"
                type="number"
                min={0}
                max={10}
                className="min-h-11 md:min-h-9"
                value={campaign.followUps}
                onChange={(e) =>
                  setCampaign({
                    ...campaign,
                    followUps: Math.max(0, Math.min(10, Number(e.target.value) || 0)),
                  })
                }
              />
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-3">{t("sandbox.campaign.hint")}</p>
          </div>

          {trigger === "inbound" ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="sb-opener">{t("sandbox.opener.label")}</Label>
                <Textarea
                  id="sb-opener"
                  rows={2}
                  value={opener}
                  placeholder={t("sandbox.opener.placeholder")}
                  onChange={(e) => setOpener(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">{t("sandbox.opener.hint")}</p>
              </div>
              <p className="text-sm text-muted-foreground">{t("sandbox.start")}</p>
              <div className="flex flex-wrap gap-2">
                {SUGGESTIONS.map((key) => (
                  <Button
                    key={key}
                    variant="outline"
                    size="sm"
                    className="min-h-11 md:min-h-8"
                    onClick={() => setInbound(t(`sandbox.suggestions.${key}`))}
                  >
                    {t(`sandbox.suggestions.${key}`)}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            /* L'assistant ouvre : un seul bouton, et il écrit le premier
               message sans qu'on ait à inventer ce que le client aurait dit. */
            <Button
              className="min-h-11 md:min-h-9"
              disabled={busy || notCompiled}
              onClick={() => void runTurn("")}
            >
              {busy ? <Loader2 className="animate-spin" /> : <PlayIcon />}
              {busy ? t("sandbox.thinking") : t("sandbox.startConversation")}
            </Button>
          )}
        </div>
      ) : (
        <div className="max-h-[28rem] space-y-3 overflow-y-auto rounded-lg border p-3">
          {turns.map((turn, i) => (
            <TurnBubble key={i} turn={turn} />
          ))}
        </div>
      )}

      {closesConversation(last) && last ? (
        <Alert>
          <AlertTriangleIcon />
          <AlertDescription>
            {t("sandbox.closed", {
              reason: last.reason ? t(`sandbox.reason.${last.reason}`) : t(`sandbox.outcome.${last.outcome}`),
            })}
          </AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertDescription className="font-mono text-xs">{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-1.5">
        <Textarea
          rows={2}
          disabled={notCompiled}
          placeholder={t("sandbox.placeholder")}
          value={inbound}
          onChange={(e) => setInbound(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="min-h-11 md:min-h-8"
            onClick={reset}
            disabled={busy || turns.length === 0}
          >
            <RotateCcw /> {t("sandbox.reset")}
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            {canFollowUp ? (
              /* Le contact se tait : on rejoue le barreau suivant, comme la
                 campagne le ferait — c'est le seul moyen de voir une relance. */
              <Button
                variant="outline"
                size="sm"
                className="min-h-11 md:min-h-8"
                title={t("sandbox.followUpHint")}
                onClick={() => void runTurn("", { followUp: true })}
                disabled={busy || notCompiled}
              >
                <BellRingIcon />
                {t("sandbox.followUp", { step: nextFollowUp })}
              </Button>
            ) : null}
            <Button
              size="sm"
              className="min-h-11 md:min-h-8"
              onClick={() => void send()}
              disabled={busy || notCompiled || inbound.trim() === ""}
            >
              {busy ? <Loader2 className="animate-spin" /> : <SendIcon />}
              {busy ? t("sandbox.thinking") : t("sandbox.send")}
            </Button>
          </div>
        </div>
      </div>

      {last ? <TurnInsight result={last} /> : null}
    </div>
  );
}

function TurnBubble({ turn }: { turn: Turn }) {
  const t = useTranslations("assistants");
  const outbound = turn.role === "assistant";
  const result = turn.result;
  const sent = wasSent(turn);
  // Ce qu'on montre dans la bulle : le message qui part, sinon ce que le
  // modèle a écrit sans que ça parte (bloqué, escaladé), sinon rien.
  const shown = sent ? turn.content : result?.draft || result?.fullText || "";
  const analysis = analyzeSms(shown);
  const full = result?.fullText.trim() ?? "";
  const dropped =
    result && result.droppedParagraphs > 0 && full.startsWith(result.draft)
      ? full.slice(result.draft.length).trim()
      : "";
  // La production s'est arrêtée AVANT d'appeler le modèle : rien à montrer, et
  // ce n'est pas une panne.
  const gatedBeforeModel = result ? GATE_REASONS.has(result.reason ?? "") : false;

  return (
    <div className={cn("flex flex-col gap-1", outbound ? "items-start" : "items-end")}>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap",
          outbound
            ? result?.blocked
              ? "bg-destructive/10 ring-1 ring-destructive/40"
              : sent
                ? "bg-muted"
                : "bg-muted/60 ring-1 ring-dashed ring-border text-muted-foreground"
            : "bg-primary text-primary-foreground",
        )}
      >
        {shown === "" ? (
          <span className="italic text-muted-foreground">
            {gatedBeforeModel ? t("sandbox.noMessage") : t("sandbox.emptyDraft")}
          </span>
        ) : (
          shown
        )}
        {dropped !== "" ? (
          <p className="mt-2 border-t border-dashed pt-2 text-xs italic text-muted-foreground line-through">
            {dropped}
          </p>
        ) : null}
      </div>

      {outbound ? (
        <p className="flex flex-wrap items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
          {result ? <OutcomeBadge result={result} /> : null}
          {turn.seeded ? <span>{t("sandbox.opener.seeded")}</span> : null}
          {shown !== "" ? (
            <span>
              {t("sandbox.segments", { chars: analysis.units, segments: analysis.segments })}
            </span>
          ) : null}
          {result && result.droppedParagraphs > 0 ? (
            <span>{t("sandbox.dropped", { count: result.droppedParagraphs })}</span>
          ) : null}
          {result && result.regenerations > 0 ? <span>{t("sandbox.regenerated")}</span> : null}
          {result?.toolCalls.length ? (
            <span className="flex items-center gap-1">
              <WrenchIcon className="size-3" />
              {result.toolCalls.map((c, i) => (
                <span key={`${c.name}-${i}`} title={c.result} className={c.ok ? "" : "line-through"}>
                  {c.name}
                  {i < result.toolCalls.length - 1 ? "," : ""}
                </span>
              ))}
            </span>
          ) : null}
          {result?.usage && result.usage.calls > 0 ? (
            <span title={result.usage.modelServed ?? undefined}>
              {t("sandbox.usage", {
                calls: result.usage.calls,
                tokensIn: result.usage.inputTokens,
                tokensOut: result.usage.outputTokens,
                latency: result.usage.latencyMs,
              })}
              {result.usage.costUsd !== null
                ? ` · ${t("sandbox.usageCost", { cost: result.usage.costUsd.toFixed(4) })}`
                : ""}
            </span>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

/** Ce que la PRODUCTION ferait de ce tour — la seule étiquette qui compte. */
function OutcomeBadge({ result }: { result: TurnResult }) {
  const t = useTranslations("assistants");
  const tone =
    result.outcome === "sent"
      ? "text-emerald-700 dark:text-emerald-400"
      : result.outcome === "blocked" || result.outcome === "error"
        ? "text-destructive"
        : "text-amber-700 dark:text-amber-400";
  return (
    <span className={cn("font-medium", tone)}>
      {t(`sandbox.outcome.${result.outcome}`)}
      {result.reason ? ` — ${t(`sandbox.reason.${result.reason}`)}` : ""}
    </span>
  );
}

/** Ce que les garde-fous ont dit, et où en est l'objectif. */
function TurnInsight({ result }: { result: TurnResult }) {
  const t = useTranslations("assistants");
  const shown = result.verdicts.filter((v) => v.severity !== "off");

  return (
    <section className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="secondary">{t("sandbox.rung", { rung: result.rung })}</Badge>
        {result.classification.refusal !== "none" ? (
          <Badge variant="outline">
            {t(`sandbox.refusal.${result.classification.refusal}` as never)}
          </Badge>
        ) : null}
        {result.classification.optOut ? (
          <Badge variant="destructive">{t("sandbox.optOut")}</Badge>
        ) : null}
        {result.classification.wantsHuman ? (
          <Badge variant="outline">{t("sandbox.wantsHuman")}</Badge>
        ) : null}
        {result.classifierError ? (
          <Badge variant="destructive" title={result.classifierError}>
            {t("sandbox.classifierError")}
          </Badge>
        ) : null}
        {result.softRefusals > 0 ? (
          <span className="text-xs text-muted-foreground">
            {t("sandbox.softRefusals", { count: result.softRefusals })}
          </span>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {t("sandbox.turnsUsed", { count: result.turnsUsed })}
        </span>
      </div>

      {Object.keys(result.qualification).length > 0 ? (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium">{t("sandbox.qualification")} :</span>{" "}
          {Object.entries(result.qualification)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(" · ")}
        </p>
      ) : null}

      {shown.length > 0 ? (
        <ul className="space-y-1">
          {shown.map((v) => (
            <li key={v.key} className="flex items-start gap-1.5 text-xs">
              {v.passed ? (
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
              ) : (
                <XCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
              )}
              <span className={v.passed ? "text-muted-foreground" : "font-medium"}>{v.label}</span>
              {!v.passed && v.reason ? (
                <span className="text-muted-foreground">— {v.reason}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {result.toolCalls.length > 0 ? (
        <ul className="space-y-1">
          {result.toolCalls.map((c, i) => (
            <li key={`${c.name}-${i}`} className="flex items-start gap-1.5 font-mono text-xs">
              {c.ok ? (
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
              ) : (
                <XCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
              )}
              <span className="font-medium">{c.name}</span>
              {c.result ? <span className="text-muted-foreground">→ {c.result}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {/* Ce que le modèle a LU : la consigne de tour et la couche L7. Sans
          cela, « pourquoi a-t-il écrit ça? » reste une devinette. */}
      {result.instruction || result.runtimeBlock ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">{t("sandbox.modelRead")}</summary>
          {result.instruction ? (
            <div className="mt-2 space-y-1">
              <p className="font-medium">{t("sandbox.instructionLabel")}</p>
              <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono">
                {result.instruction}
              </pre>
            </div>
          ) : null}
          {result.runtimeBlock ? (
            <div className="mt-2 space-y-1">
              <p className="font-medium">{t("sandbox.runtimeLabel")}</p>
              <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono">
                {result.runtimeBlock}
              </pre>
            </div>
          ) : null}
        </details>
      ) : null}
    </section>
  );
}
