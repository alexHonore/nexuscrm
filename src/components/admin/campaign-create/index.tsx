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
import {
  ChatIllustration,
  DashboardIllustration,
  FormIllustration,
  SparkleTrail,
} from "../create-illustrations";
import { briefToCampaignConfig } from "@/lib/campaigns/creator";
import type { CampaignConfig, TriggerKind } from "@/lib/campaigns/schema";
import { cn } from "@/lib/utils";
import { TRIGGER_LOOK, TriggerIcon } from "../trigger-look";
import { ApiError, api } from "../api";

type Mode = "choose" | "ai" | "simple" | "complex";

type Turn = { role: "user" | "assistant"; content: string };

/**
 * Création d'une campagne — mêmes trois portes que pour un assistant.
 *
 * Une campagne se règle sur six onglets et met en jeu des envois réels à de
 * vraies personnes. Commencer par un brouillon vide invite à activer sans avoir
 * compris ce que déclenche quoi.
 */
export function CampaignCreateDialog({ trigger }: { trigger: React.ReactNode }) {
  const t = useTranslations("campaigns");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("choose");
  const [busy, setBusy] = useState(false);

  const create = async (config: CampaignConfig) => {
    setBusy(true);
    try {
      const created = await api<{ id: string }>("/api/campaigns", {
        method: "POST",
        body: JSON.stringify(config),
      });
      toast.success(t("list.created"));
      setOpen(false);
      setMode("choose");
      setBusy(false);
      router.push(`/admin/campaigns/${created.id}`);
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
        if (!next) {
          setMode("choose");
          setBusy(false);
        }
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

function ModeChooser({ onPick }: { onPick: (mode: Mode) => void }) {
  const t = useTranslations("campaigns");
  const modes = [
    { key: "ai" as const, color: "var(--color-primary)", Illustration: ChatIllustration, badge: true },
    { key: "simple" as const, color: "#10B981", Illustration: FormIllustration, badge: false },
    { key: "complex" as const, color: "#8B5CF6", Illustration: DashboardIllustration, badge: false },
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
            style={{ color, backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)` }}
          >
            <Illustration className="h-12 w-16" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{t(`create.${key}.name`)}</span>
              {badge ? (
                <Badge className="gap-1" style={{ backgroundColor: color }}>
                  <SparklesIcon className="size-3" /> {t("create.ai.badge")}
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

type DraftReply =
  | { done: false; question: string; suggestions: string[] }
  | { done: true; summary: string; config: CampaignConfig };

function AiCreator({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: (config: CampaignConfig) => void;
}) {
  const t = useTranslations("campaigns");
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
      const result = await api<DraftReply>("/api/campaigns/draft", {
        method: "POST",
        body: JSON.stringify({ messages: next }),
      });
      setReply(result);
      if (!result.done) setTurns([...next, { role: "assistant", content: result.question }]);
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
            <div key={i} className={cn("flex", turn.role === "user" ? "justify-end" : "justify-start")}>
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
        <div className="space-y-3 rounded-lg border-2 border-primary/40 bg-primary/5 p-4">
          <p className="flex items-center gap-2 text-sm font-medium text-primary">
            <SparklesIcon className="size-4" /> {t("create.ai.ready")}
          </p>
          <p className="text-sm">{reply.summary}</p>
          <CampaignSummary config={reply.config} />
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
            <Button key={s} variant="outline" size="sm" className="min-h-11 md:min-h-8" onClick={() => void ask(s)}>
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

function SimpleCreator({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: (config: CampaignConfig) => void;
}) {
  const t = useTranslations("campaigns");
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState<TriggerKind>("scheduled");
  const [coldDays, setColdDays] = useState(90);
  const [followUps, setFollowUps] = useState(1);

  const config = briefToCampaignConfig({
    name: name.trim() || null,
    description: null,
    trigger,
    notContactedForDays: trigger === "scheduled" ? coldDays : null,
    followUps,
    daysBetween: 3,
    opener: null,
    abTest: false,
    dailyCap: 50,
  });

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="cpc-name">{t("create.simple.fieldName")}</Label>
        <Input
          id="cpc-name"
          className="min-h-11 md:min-h-9"
          placeholder={config.name}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <Choice
        label={t("create.simple.trigger")}
        value={trigger}
        onChange={(v) => setTrigger(v as TriggerKind)}
        options={(["lead_created", "category_changed", "scheduled", "manual"] as const).map((k) => ({
          value: k,
          label: t(`list.trigger.${k}`),
          hint: t(`create.simple.triggerHint.${k}`),
          color: TRIGGER_LOOK[k].color,
          icon: <TriggerIcon kind={k} />,
        }))}
      />

      {trigger === "scheduled" ? (
        <Choice
          label={t("create.simple.cold")}
          value={String(coldDays)}
          onChange={(v) => setColdDays(Number(v))}
          options={[30, 90, 180, 365].map((d) => ({
            value: String(d),
            label: t("create.simple.coldDays", { days: d }),
          }))}
        />
      ) : null}

      <Choice
        label={t("create.simple.followUps")}
        value={String(followUps)}
        onChange={(v) => setFollowUps(Number(v))}
        options={[
          { value: "0", label: t("create.simple.none"), hint: t("create.simple.noneHint") },
          { value: "1", label: t("create.simple.one"), hint: t("create.simple.oneHint") },
          { value: "2", label: t("create.simple.two"), hint: t("create.simple.twoHint") },
        ]}
      />

      <CampaignSummary config={config} />

      <Button className="w-full min-h-11 md:min-h-9" disabled={busy} onClick={() => onCreate(config)}>
        {busy ? <Loader2 className="animate-spin" /> : null}
        {t("create.simple.createIt")}
      </Button>
    </div>
  );
}

function ComplexCreator({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: (config: CampaignConfig) => void;
}) {
  const t = useTranslations("campaigns");
  const [name, setName] = useState("");
  const config = briefToCampaignConfig({
    name: name.trim() || "Nouvelle campagne",
    description: null,
    trigger: "manual",
    notContactedForDays: null,
    followUps: 1,
    daysBetween: 3,
    opener: null,
    abTest: false,
    dailyCap: 50,
  });

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="cpx-name">{t("create.simple.fieldName")}</Label>
        <Input
          id="cpx-name"
          className="min-h-11 md:min-h-9"
          placeholder="Nouvelle campagne"
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

function Choice({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string; hint?: string; color?: string; icon?: React.ReactNode }[];
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => {
          const selected = value === option.value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(option.value)}
              className={cn(
                "flex items-start gap-2.5 rounded-lg border p-2.5 text-left text-sm",
                "transition-all duration-150 hover:bg-[color:var(--tone)]/5",
                "hover:border-[color:var(--tone)]",
                selected && "border-[color:var(--tone)] bg-[color:var(--tone)]/5",
              )}
              style={{ ["--tone" as string]: option.color ?? "var(--color-primary)" }}
            >
              {option.icon}
              <span className="min-w-0">
                <span className="font-medium">{option.label}</span>
                {option.hint ? (
                  <span className="mt-0.5 block text-xs text-muted-foreground">{option.hint}</span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Aperçu de ce qui va être créé — même bloc dans les trois modes.
 *
 * L'échelle est montrée comme une FRISE avec des jours absolus : les délais
 * sont cumulatifs dans le moteur, et « 72 h » sur trois barreaux se lit
 * facilement comme « trois messages dans trois jours » alors que le dernier
 * part le neuvième jour.
 */
function CampaignSummary({ config }: { config: CampaignConfig }) {
  const t = useTranslations("campaigns");
  // Somme courante calculée d'un coup, EN HEURES : les délais sont cumulatifs,
  // et rechaîner sur des jours déjà arrondis fait dériver la frise dès qu'un
  // barreau n'est pas un multiple de 24 h.
  const hoursOf = config.ladder.reduce<number[]>((acc, step, i) => {
    acc.push((i === 0 ? 0 : acc[i - 1]) + step.delayHours);
    return acc;
  }, []);
  return (
    <div className="space-y-3 rounded-lg bg-muted/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <TriggerIcon kind={config.trigger.kind} />
        <span className="text-sm font-medium">{t(`list.trigger.${config.trigger.kind}`)}</span>
        {config.audience.notContactedForDays ? (
          <Badge variant="outline" className="font-normal">
            {t("create.simple.coldDays", { days: config.audience.notContactedForDays })}
          </Badge>
        ) : null}
        {config.variants.length > 0 ? (
          <Badge variant="outline" className="font-normal">
            {t("create.summary.abTest")}
          </Badge>
        ) : null}
        {/* Le plafond quotidien est AFFICHÉ : c'est le réglage qui, mal
            compris, produit une campagne active qui n'écrit à personne. */}
        <Badge variant="outline" className="font-normal">
          {t("create.summary.dailyCap", { count: config.dailyEnrollmentCap })}
        </Badge>
      </div>

      <div>
        <p className="text-xs font-medium text-muted-foreground">{t("create.summary.ladder")}</p>
        <ol className="mt-1.5 space-y-1.5">
          {config.ladder.map((step, i) => {
            const days = Math.round(hoursOf[i] / 24);
            return (
              <li key={i} className="flex items-center gap-2 text-xs">
                <span className="relative flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-medium text-primary">
                  {i + 1}
                  {i < config.ladder.length - 1 ? (
                    <span aria-hidden className="absolute left-1/2 top-full h-1.5 w-px -translate-x-1/2 bg-primary/25" />
                  ) : null}
                </span>
                <span className="font-medium">
                  {days === 0 ? t("create.summary.now") : t("create.summary.dayN", { days })}
                </span>
                <span className="text-muted-foreground">
                  {step.body ? t("create.summary.written") : t("create.summary.byAssistant")}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
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
