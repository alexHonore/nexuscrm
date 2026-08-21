"use client";

import { ArrowLeftIcon, Loader2, SendIcon, SparklesIcon, WandSparklesIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { GOAL_TYPES, type AssistantConfig, type GoalType } from "@/lib/assistants/schema";
import { briefToConfig } from "@/lib/assistants/creator";
import { cn } from "@/lib/utils";
import { ApiError, api } from "../api";
import {
  ChatIllustration,
  DashboardIllustration,
  FormIllustration,
  SparkleTrail,
} from "../create-illustrations";

type Mode = "choose" | "ai" | "simple" | "complex";
type Turn = { role: "user" | "assistant"; content: string };

/**
 * Création d'un assistant — trois chemins vers le même objet.
 *
 * Le formulaire complet compte onze onglets. C'est ce qu'il faut pour régler un
 * assistant en production, et c'est beaucoup trop pour en créer un premier :
 * on abandonne avant d'avoir compris ce qu'on configure. D'où trois portes
 * d'entrée — décrire son besoin, répondre à quatre questions, ou tout régler —
 * qui produisent toutes une configuration complète et valide.
 */
export function AssistantCreateDialog({ trigger }: { trigger: React.ReactNode }) {
  const t = useTranslations("assistants");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("choose");
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setMode("choose");
    setBusy(false);
  };

  /** Enregistre la configuration et ouvre l'éditeur dessus. */
  const create = async (config: AssistantConfig, opening?: string) => {
    setBusy(true);
    try {
      const created = await api<{ id: string }>("/api/assistants", {
        method: "POST",
        body: JSON.stringify(config),
      });
      toast.success(t("list.created"));
      setOpen(false);
      reset();
      router.push(`/admin/assistants/${created.id}${opening ?? ""}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("editor.errors.save"));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger render={trigger as React.ReactElement} />
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {mode !== "choose" ? (
              <Button
                variant="ghost"
                size="icon"
                className="-ml-2 size-8"
                aria-label={t("create.back")}
                onClick={() => setMode("choose")}
              >
                <ArrowLeftIcon className="size-4" />
              </Button>
            ) : null}
            {t(mode === "choose" ? "create.title" : `create.${mode}.title`)}
          </DialogTitle>
          <DialogDescription>
            {t(mode === "choose" ? "create.subtitle" : `create.${mode}.subtitle`)}
          </DialogDescription>
        </DialogHeader>

        {/* `key` sur le mode : le panneau est REMONTÉ à chaque changement, donc
            l'animation d'entrée rejoue et le changement d'écran se voit. */}
        <div
          key={mode}
          className="animate-in fade-in-0 slide-in-from-right-2 duration-200 motion-reduce:animate-none"
        >
          {mode === "choose" ? <ModeChooser onPick={setMode} /> : null}
          {mode === "ai" ? <AiCreator busy={busy} onCreate={create} /> : null}
          {mode === "simple" ? <SimpleCreator busy={busy} onCreate={create} /> : null}
          {mode === "complex" ? <ComplexCreator busy={busy} onCreate={create} /> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Choix du mode ────────────────────────────────────────────────────────────

function ModeChooser({ onPick }: { onPick: (mode: Mode) => void }) {
  const t = useTranslations("assistants");

  const modes = [
    {
      key: "ai" as const,
      color: "var(--color-primary)",
      Illustration: ChatIllustration,
      badge: t("create.ai.badge"),
    },
    { key: "simple" as const, color: "#10B981", Illustration: FormIllustration, badge: null },
    { key: "complex" as const, color: "#8B5CF6", Illustration: DashboardIllustration, badge: null },
  ];

  return (
    <div className="space-y-3">
      <SparkleTrail className="h-5 w-full text-primary" />
      {modes.map(({ key, color, Illustration, badge }, i) => (
        <button
          key={key}
          type="button"
          onClick={() => onPick(key)}
          className={cn(
            "group flex w-full items-center gap-4 rounded-xl border p-4 text-left",
            "transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md",
            "hover:border-[color:var(--tone)]",
            // Les trois portes arrivent l'une après l'autre : on les lit dans
            // l'ordre au lieu de voir un bloc de trois d'un coup.
            "animate-in fade-in-0 slide-in-from-bottom-2 fill-mode-backwards duration-300 motion-reduce:animate-none",
          )}
          style={{ ["--tone" as string]: color, animationDelay: `${i * 70}ms` }}
        >
          <span
            className="flex size-20 shrink-0 items-center justify-center rounded-lg transition-transform duration-200 group-hover:scale-105"
            style={{
              color,
              backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
            }}
          >
            <Illustration className="h-12 w-16" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{t(`create.${key}.name`)}</span>
              {badge ? (
                <Badge className="gap-1" style={{ backgroundColor: color }}>
                  <SparklesIcon className="size-3" /> {badge}
                </Badge>
              ) : null}
            </span>
            <span className="mt-1 block text-sm text-muted-foreground">
              {t(`create.${key}.pitch`)}
            </span>
            <span className="mt-1.5 block text-xs text-muted-foreground/80">
              {t(`create.${key}.time`)}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

// ── Mode « créateur IA » ─────────────────────────────────────────────────────

type DraftReply =
  | { done: false; question: string; suggestions: string[] }
  | { done: true; summary: string; config: AssistantConfig };

function AiCreator({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: (config: AssistantConfig) => void;
}) {
  const t = useTranslations("assistants");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [reply, setReply] = useState<DraftReply | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ask = async (text: string) => {
    const trimmed = text.trim();
    if (trimmed === "" || thinking) return;

    const next: Turn[] = [...turns, { role: "user", content: trimmed }];
    setTurns(next);
    setInput("");
    setThinking(true);
    setError(null);

    try {
      const result = await api<DraftReply>("/api/assistants/draft", {
        method: "POST",
        body: JSON.stringify({ messages: next }),
      });
      setReply(result);
      if (!result.done) {
        setTurns([...next, { role: "assistant", content: result.question }]);
      }
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      setError(
        code === "no_provider"
          ? t("create.ai.noProvider")
          : code === "unreadable_reply"
            ? t("create.ai.retry")
            : t("create.ai.failed"),
      );
    } finally {
      setThinking(false);
    }
  };

  const suggestions = reply && !reply.done ? reply.suggestions : [];

  return (
    <div className="space-y-3">
      {turns.length === 0 ? (
        <div className="rounded-lg border border-dashed p-4 text-center">
          <WandSparklesIcon className="mx-auto size-8 text-primary" />
          <p className="mt-2 text-sm font-medium">{t("create.ai.prompt")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("create.ai.example")}</p>
        </div>
      ) : (
        <div className="max-h-64 space-y-2 overflow-y-auto rounded-lg border p-3">
          {turns.map((turn, i) => (
            <div
              key={i}
              className={cn("flex", turn.role === "user" ? "justify-end" : "justify-start")}
            >
              <p
                className={cn(
                  "max-w-[85%] rounded-2xl px-3 py-2 text-sm",
                  turn.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted",
                )}
              >
                {turn.content}
              </p>
            </div>
          ))}
          {thinking ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> {t("create.ai.thinking")}
            </p>
          ) : null}
        </div>
      )}

      {reply?.done ? (
        /* Le résumé est relu AVANT toute écriture : c'est le seul moment où on
           peut encore corriger sans avoir créé quoi que ce soit. */
        <div className="space-y-3 rounded-lg border-2 border-primary/40 bg-primary/5 p-4">
          <p className="flex items-center gap-2 text-sm font-medium text-primary">
            <SparklesIcon className="size-4" /> {t("create.ai.ready")}
          </p>
          <p className="text-sm">{reply.summary}</p>
          <ConfigSummary config={reply.config} />
          <Button
            className="w-full min-h-11 md:min-h-9"
            disabled={busy}
            onClick={() => onCreate(reply.config)}
          >
            {busy ? <Loader2 className="animate-spin" /> : <SparklesIcon />}
            {t("create.ai.createIt")}
          </Button>
        </div>
      ) : null}

      {suggestions.length > 0 && !thinking ? (
        <div className="flex flex-wrap gap-2">
          {suggestions.map((s) => (
            <Button
              key={s}
              variant="outline"
              size="sm"
              className="min-h-11 md:min-h-8"
              onClick={() => void ask(s)}
            >
              {s}
            </Button>
          ))}
        </div>
      ) : null}

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {!reply?.done ? (
        <div className="flex gap-2">
          <Textarea
            rows={2}
            value={input}
            disabled={thinking}
            placeholder={t("create.ai.placeholder")}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void ask(input);
              }
            }}
          />
          <Button
            className="min-h-11 self-end md:min-h-9"
            disabled={thinking || input.trim() === ""}
            onClick={() => void ask(input)}
          >
            <SendIcon />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ── Mode « simple » ──────────────────────────────────────────────────────────

function SimpleCreator({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: (config: AssistantConfig) => void;
}) {
  const t = useTranslations("assistants");
  const [name, setName] = useState("");
  const [audience, setAudience] = useState<"buyer" | "seller" | "both">("buyer");
  const [goalType, setGoalType] = useState<GoalType>("video_meeting");
  const [persistence, setPersistence] = useState(3);

  const config = briefToConfig(
    {
      name: name.trim() || null,
      description: null,
      audience,
      goalType,
      durationMin: 30,
      requiredFields: ["project_type", "timing"],
      persistence,
      warmth: 3,
      questionBudget: 2,
      formality: "vous",
      claims: [],
    },
    { orgName: "Groupe Nexus", brokerName: "Alex-Honoré", brokerUserId: null },
  );

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="sc-name">{t("create.simple.fieldName")}</Label>
        <Input
          id="sc-name"
          className="min-h-11 md:min-h-9"
          placeholder={config.name}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <Choice
        label={t("create.simple.audience")}
        value={audience}
        onChange={(v) => setAudience(v as typeof audience)}
        options={[
          { value: "buyer", label: t("create.simple.buyer") },
          { value: "seller", label: t("create.simple.seller") },
          { value: "both", label: t("create.simple.both") },
        ]}
      />

      <Choice
        label={t("create.simple.goal")}
        value={goalType}
        onChange={(v) => setGoalType(v as GoalType)}
        options={GOAL_TYPES.filter((g) => g !== "handoff").map((g) => ({
          value: g,
          label: t(`goalType.${g}`),
          hint: t(`goalTypeHint.${g}`),
        }))}
      />

      <Choice
        label={t("create.simple.persistence")}
        value={String(persistence)}
        onChange={(v) => setPersistence(Number(v))}
        options={[
          { value: "1", label: t("create.simple.soft"), hint: t("create.simple.softHint") },
          { value: "3", label: t("create.simple.balanced"), hint: t("create.simple.balancedHint") },
          { value: "5", label: t("create.simple.firm"), hint: t("create.simple.firmHint") },
        ]}
      />

      <ConfigSummary config={config} />

      <Button className="w-full min-h-11 md:min-h-9" disabled={busy} onClick={() => onCreate(config)}>
        {busy ? <Loader2 className="animate-spin" /> : null}
        {t("create.simple.createIt")}
      </Button>
    </div>
  );
}

function Choice({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string; hint?: string }[];
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-lg border p-2.5 text-left text-sm transition-colors",
              "hover:border-primary hover:bg-primary/5",
              value === option.value && "border-primary bg-primary/5",
            )}
          >
            <span className="font-medium">{option.label}</span>
            {option.hint ? (
              <span className="mt-0.5 block text-xs text-muted-foreground">{option.hint}</span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Mode « complet » ─────────────────────────────────────────────────────────

function ComplexCreator({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: (config: AssistantConfig, opening?: string) => void;
}) {
  const t = useTranslations("assistants");
  const [name, setName] = useState("");

  const config = briefToConfig(
    {
      name: name.trim() || "Nouvel assistant",
      description: null,
      audience: "unknown",
      goalType: "video_meeting",
      durationMin: 30,
      requiredFields: ["project_type", "timing"],
      persistence: 3,
      warmth: 3,
      questionBudget: 2,
      formality: "vous",
      claims: [],
    },
    { orgName: "Groupe Nexus", brokerName: "Alex-Honoré", brokerUserId: null },
  );

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="cc-name">{t("create.simple.fieldName")}</Label>
        <Input
          id="cc-name"
          className="min-h-11 md:min-h-9"
          placeholder="Nouvel assistant"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <p className="text-sm text-muted-foreground">{t("create.complex.note")}</p>
      <Button className="w-full min-h-11 md:min-h-9" disabled={busy} onClick={() => onCreate(config)}>
        {busy ? <Loader2 className="animate-spin" /> : null}
        {t("create.complex.createIt")}
      </Button>
    </div>
  );
}

/** Aperçu de ce qui va être créé — même bloc dans les trois modes. */
function ConfigSummary({ config }: { config: AssistantConfig }) {
  const t = useTranslations("assistants");
  return (
    <dl className="grid gap-x-4 gap-y-1 rounded-lg bg-muted/40 p-3 text-xs sm:grid-cols-2">
      <Row label={t("create.summary.goal")} value={t(`goalType.${config.goal.primary.type}`)} />
      <Row
        label={t("create.summary.fallback")}
        value={
          config.goal.fallbacks.length > 0
            ? t(`goalType.${config.goal.fallbacks[0].type}`)
            : t("create.summary.none")
        }
      />
      <Row
        label={t("create.summary.required")}
        value={
          config.goal.primary.requiredFields.length > 0
            ? config.goal.primary.requiredFields.map((f) => t(`qualificationField.${f}`)).join(", ")
            : t("create.summary.none")
        }
      />
      <Row label={t("create.summary.persistence")} value={`${config.approach.persistence}/5`} />
    </dl>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2 sm:block">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

/*
 * Les trois panneaux sont exportés pour être RENDUS en test : le corps d'un
 * dialogue Base UI n'apparaît pas dans le rendu serveur, donc une clé i18n
 * manquante ou un composant mal composé à l'intérieur ne se verrait qu'à
 * l'ouverture, en production.
 */
export { AiCreator, SimpleCreator, ComplexCreator };
