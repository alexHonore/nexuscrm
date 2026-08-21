"use client";

import {
  AlertTriangleIcon,
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
import { ApiError, api } from "../api";
import type { TabProps } from "./types";

type Verdict = {
  key: string;
  label: string;
  severity: "block" | "warn" | "off";
  passed: boolean;
  reason?: string;
};

type TurnResult = {
  draft: string;
  blocked: boolean;
  verdicts: Verdict[];
  toolCalls: { name: string; args: unknown }[];
  classification: {
    optOut: boolean;
    refusal: "none" | "soft" | "hard";
    wantsHuman: boolean;
    qualification: Record<string, unknown>;
  };
  rung: string;
  requiredFields: string[];
  runtimeBlock: string;
  softRefusals: number;
  qualification: Record<string, unknown>;
  error: string | null;
};

type Turn = { role: "assistant" | "user"; content: string; result?: TurnResult };

const TRIGGERS = ["inbound", "lead_created", "category_changed"] as const;

/**
 * Bac à sable — parler à l'assistant comme si on était le client.
 *
 * Ce qui distingue cet écran d'un simple aperçu de prompt : chaque réponse est
 * accompagnée de ce que les garde-fous en ont dit, du cran d'objectif courant
 * et des outils que le modèle a VOULU appeler. Régler une persistance ou un ton
 * sans voir ces trois choses revient à changer un chiffre et espérer.
 *
 * Rien n'est envoyé, rien n'est écrit, rien n'est réservé. Les appels d'outils
 * sont rapportés, jamais exécutés : un essai qui bloquerait une vraie plage
 * d'agenda serait un piège.
 */
export function SandboxTab({ data }: TabProps) {
  const t = useTranslations("assistants");
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
   * message. L'essai attendait le client dans tous les cas — un comportement
   * que la production n'a pas.
   */
  const [trigger, setTrigger] = useState<"inbound" | "lead_created" | "category_changed">(
    "inbound",
  );
  const stateRef = useRef({ qualification: {} as Record<string, unknown>, softRefusals: 0 });

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

  /** Un tour. `text` vide = l'assistant ouvre la conversation. */
  const runTurn = async (text: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const history = turns.map((x) => ({ role: x.role, content: x.content }));
    if (text !== "") setTurns((current) => [...current, { role: "user", content: text }]);
    setInbound("");

    try {
      const result = await api<TurnResult>(`/api/assistants/${data.id}/sandbox`, {
        method: "POST",
        body: JSON.stringify({
          history,
          inbound: text,
          lead,
          trigger: text === "" ? trigger : "inbound",
          // Une ouverture EST le premier message sortant : la règle
          // d'identification doit s'appliquer.
          openerSent: text !== "",
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
        { role: "assistant", content: result.draft, result },
      ]);
      if (result.error) setError(result.error);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      setError(code === "not_compiled" ? t("sandbox.notCompiled") : t("sandbox.failed"));
      // Le tour n'a pas eu lieu : on retire la bulle du client pour que
      // l'historique reste le reflet exact de ce que le modèle a reçu.
      if (text !== "") {
        setTurns((current) => current.slice(0, -1));
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

  return (
    <div className="space-y-4">
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

          {trigger === "inbound" ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">{t("sandbox.start")}</p>
              <div className="flex flex-wrap gap-2">
                {["Oui, je cherche à acheter", "Pas cette semaine", "STOP", "Ça vaut combien ma maison?"].map(
                  (suggestion) => (
                    <Button
                      key={suggestion}
                      variant="outline"
                      size="sm"
                      className="min-h-11 md:min-h-8"
                      onClick={() => setInbound(suggestion)}
                    >
                      {suggestion}
                    </Button>
                  ),
                )}
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

      {last ? <TurnInsight result={last} /> : null}
    </div>
  );
}

function TurnBubble({ turn }: { turn: Turn }) {
  const t = useTranslations("assistants");
  const outbound = turn.role === "assistant";
  const result = turn.result;
  const analysis = analyzeSms(turn.content);

  return (
    <div className={cn("flex flex-col gap-1", outbound ? "items-start" : "items-end")}>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap",
          outbound
            ? result?.blocked
              ? "bg-destructive/10 ring-1 ring-destructive/40"
              : "bg-muted"
            : "bg-primary text-primary-foreground",
        )}
      >
        {turn.content === "" ? (
          <span className="italic text-muted-foreground">{t("sandbox.emptyDraft")}</span>
        ) : (
          turn.content
        )}
      </div>

      {outbound ? (
        <p className="flex flex-wrap items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
          {result?.blocked ? (
            <span className="font-medium text-destructive">{t("sandbox.blocked")}</span>
          ) : null}
          <span>
            {t("sandbox.segments", { chars: analysis.units, segments: analysis.segments })}
          </span>
          {result?.toolCalls.length ? (
            <span className="flex items-center gap-1">
              <WrenchIcon className="size-3" />
              {result.toolCalls.map((c) => c.name).join(", ")}
            </span>
          ) : null}
        </p>
      ) : null}
    </div>
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
        {result.softRefusals > 0 ? (
          <span className="text-xs text-muted-foreground">
            {t("sandbox.softRefusals", { count: result.softRefusals })}
          </span>
        ) : null}
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
    </section>
  );
}
