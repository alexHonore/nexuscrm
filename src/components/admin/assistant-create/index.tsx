"use client";

import {
  ArrowLeftIcon,
  ArrowRightIcon,
  Loader2,
  SendIcon,
  SparklesIcon,
  WandSparklesIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  GOAL_TYPES,
  PROVIDER_IDS,
  type AssistantConfig,
  type GoalType,
  type ProviderId,
} from "@/lib/assistants/schema";
import { briefToConfig } from "@/lib/assistants/creator";
import type { ModelDescriptor } from "@/lib/llm/types";
import { cn } from "@/lib/utils";
import { ApiError, api } from "../api";
import { ModelPicker, type Effort } from "../model-picker";
import {
  ChatIllustration,
  DashboardIllustration,
  FormIllustration,
  SparkleTrail,
} from "../create-illustrations";

type Mode = "choose" | "ai" | "simple" | "complex";
type Turn = { role: "user" | "assistant"; content: string };

/** Une configuration prête, en attente du choix du modèle. */
export type Pending = { config: AssistantConfig };

/** Le modèle retenu à la dernière étape. */
export type ChosenModel = { provider: ProviderId; model: string; effort: Effort };

/** Rien de choisi. `model: ""` est ce qui garde le bouton de création inerte. */
export const EMPTY_CHOICE: ChosenModel = { provider: "openrouter", model: "", effort: "none" };

/**
 * Applique le modèle CHOISI à la configuration.
 *
 * Le schéma d'assistant garde un modèle par défaut — il faut bien qu'une
 * fiche déjà en base reste lisible — mais personne ne doit créer un assistant
 * sur ce défaut sans l'avoir vu : c'est lui qui décide du coût de chaque
 * message et de la qualité des réponses, et il vieillit vite.
 */
export function withChosenModel(config: AssistantConfig, chosen: ChosenModel): AssistantConfig {
  return {
    ...config,
    model: {
      ...config.model,
      provider: chosen.provider,
      model: chosen.model,
      reasoningEffort: chosen.effort,
    },
  };
}

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
  const [pending, setPending] = useState<Pending | null>(null);
  // Le modèle retenu vit ICI, pas dans l'étape : revenir en arrière pour
  // corriger un champ ne doit pas effacer le modèle déjà choisi.
  const [chosen, setChosen] = useState<ChosenModel>(EMPTY_CHOICE);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setMode("choose");
    setPending(null);
    setChosen(EMPTY_CHOICE);
    setBusy(false);
  };

  // Le choix du modèle passe DEVANT le mode dès qu'une configuration attend :
  // les trois portes produisent une config, une seule sortie la crée.
  const screen: Mode | "model" = pending ? "model" : mode;

  /** Enregistre la configuration et ouvre l'éditeur dessus. */
  const create = async (config: AssistantConfig) => {
    setBusy(true);
    try {
      const created = await api<{ id: string }>("/api/assistants", {
        method: "POST",
        body: JSON.stringify(config),
      });
      toast.success(t("list.created"));
      setOpen(false);
      reset();
      router.push(`/admin/assistants/${created.id}`);
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
            {screen !== "choose" ? (
              <Button
                variant="ghost"
                size="icon"
                className="-ml-2 size-8"
                aria-label={t("create.back")}
                // Reculer d'UN écran : depuis le modèle on retombe sur le mode
                // qui a produit la configuration, pas sur le choix des portes.
                onClick={() => (pending ? setPending(null) : setMode("choose"))}
              >
                <ArrowLeftIcon className="size-4" />
              </Button>
            ) : null}
            {t(screen === "choose" ? "create.title" : `create.${screen}.title`)}
          </DialogTitle>
          <DialogDescription>
            {t(screen === "choose" ? "create.subtitle" : `create.${screen}.subtitle`)}
          </DialogDescription>
        </DialogHeader>

        {/* `key` sur le MODE : le panneau est remonté quand on change de porte,
            donc l'animation d'entrée rejoue. Mais passer au choix du modèle ne
            change pas de mode — le formulaire reste monté, seulement masqué :
            revenir en arrière pour corriger un nom doit retrouver la
            conversation ou le formulaire, pas un écran vierge. */}
        <div
          key={mode}
          className="animate-in fade-in-0 slide-in-from-right-2 duration-200 motion-reduce:animate-none"
        >
          <div className={cn(pending !== null && "hidden")}>
            {mode === "choose" ? <ModeChooser onPick={setMode} /> : null}
            {mode === "ai" ? <AiCreator onSubmit={setPending} /> : null}
            {mode === "simple" ? <SimpleCreator onSubmit={setPending} /> : null}
            {mode === "complex" ? <ComplexCreator onSubmit={setPending} /> : null}
          </div>
          {pending ? (
            <div className="animate-in fade-in-0 slide-in-from-right-2 duration-200 motion-reduce:animate-none">
              <ModelStep
                busy={busy}
                config={pending.config}
                value={chosen}
                onChange={setChosen}
                onCreate={() => void create(withChosenModel(pending.config, chosen))}
              />
            </div>
          ) : null}
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

function AiCreator({ onSubmit }: { onSubmit: (pending: Pending) => void }) {
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
            onClick={() => onSubmit({ config: reply.config })}
          >
            <ArrowRightIcon />
            {t("create.next")}
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

function SimpleCreator({ onSubmit }: { onSubmit: (pending: Pending) => void }) {
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

      <Button className="w-full min-h-11 md:min-h-9" onClick={() => onSubmit({ config })}>
        <ArrowRightIcon />
        {t("create.next")}
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

function ComplexCreator({ onSubmit }: { onSubmit: (pending: Pending) => void }) {
  const t = useTranslations("assistants");
  const [name, setName] = useState("");

  // Le nom de repli est le MÊME que l'invite du champ : ce qu'on lit en gris
  // est ce qui sera enregistré si on ne tape rien.
  const fallbackName = t("create.complex.defaultName");
  const config = briefToConfig(
    {
      name: name.trim() || fallbackName,
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
          placeholder={fallbackName}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <p className="text-sm text-muted-foreground">{t("create.complex.note")}</p>
      <Button className="w-full min-h-11 md:min-h-9" onClick={() => onSubmit({ config })}>
        <ArrowRightIcon />
        {t("create.next")}
      </Button>
    </div>
  );
}

// ── Choix du modèle — dernière étape, commune aux trois modes ────────────────

/**
 * Le modèle se CHOISIT ; il n'est plus hérité.
 *
 * Avant, les trois portes créaient l'assistant sur le modèle par défaut du
 * schéma. C'est le réglage qui décide du prix de chaque message et de la
 * tenue des consignes, et il se périme : un défaut écrit il y a six mois
 * désigne un modèle que le catalogue ne sert peut-être plus. Le bouton reste
 * donc inerte tant que rien n'est choisi — un choix par omission n'est pas un
 * choix.
 *
 * Seul le modèle GÉNÉRATEUR est demandé ici. Le classifieur et le repli ont
 * des défauts qui se tiennent (un modèle économique, un fournisseur direct
 * différent) et se règlent dans l'éditeur : les demander maintenant ferait
 * quatre décisions avant d'avoir vu un seul message.
 */
function ModelStep({
  busy,
  config,
  value,
  onChange,
  onCreate,
}: {
  busy: boolean;
  config: AssistantConfig;
  /** Le choix est piloté par le dialogue : il survit à un aller-retour. */
  value: ChosenModel;
  onChange: (chosen: ChosenModel) => void;
  onCreate: () => void;
}) {
  const t = useTranslations("assistants");
  const { provider, model, effort } = value;
  const setProvider = (next: ProviderId) =>
    // Les identifiants ne se recoupent pas d'un fournisseur à l'autre : garder
    // le modèle en changeant de fournisseur créerait un assistant dont TOUS
    // les appels échouent.
    onChange({ provider: next, model: "", effort: "none" });
  const setModel = (next: string) => onChange({ ...value, model: next });
  const [catalog, setCatalog] = useState<Record<string, ModelDescriptor[]>>({});
  const [loading, setLoading] = useState<string | null>(null);
  // L'échec est retenu PAR FOURNISSEUR : garder un seul drapeau afficherait
  // encore « aucune clé configurée » après être passé à un fournisseur qui,
  // lui, répond très bien.
  const [failures, setFailures] = useState<Record<string, "unconfigured" | "unavailable">>({});

  const load = useCallback(async (id: string) => {
    setLoading(id);
    try {
      const res = await api<{ models: ModelDescriptor[] }>(`/api/llm/models?provider=${id}`);
      setCatalog((c) => ({ ...c, [id]: res.models }));
      setFailures((f) => {
        if (!(id in f)) return f;
        const next = { ...f };
        delete next[id];
        return next;
      });
    } catch (err) {
      // Un catalogue vide sans explication ressemble à « aucun modèle n'existe ».
      // La clé manquante et le fournisseur en panne ne se corrigent pas pareil.
      setCatalog((c) => ({ ...c, [id]: [] }));
      setFailures((f) => ({
        ...f,
        [id]:
          err instanceof ApiError && err.code === "provider_unconfigured"
            ? "unconfigured"
            : "unavailable",
      }));
    } finally {
      setLoading(null);
    }
  }, []);

  // Un catalogue par fournisseur, demandé UNE fois : la réponse est déjà mise
  // en cache six heures côté serveur.
  const requested = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (requested.current.has(provider)) return;
    requested.current.add(provider);
    void load(provider);
  }, [provider, load]);

  const chosen = (catalog[provider] ?? []).find((m) => m.id === model);
  const failure = failures[provider];
  const needsTools = config.tools.some((tool) => tool === "get_slots" || tool === "book_meeting");
  // Catalogue vide (clé absente, fournisseur en panne) : sans porte de sortie,
  // l'étape empêcherait de créer le moindre assistant. La saisie libre existe
  // pour la même raison dans l'éditeur — le catalogue n'est pas une autorité.
  const catalogueUnusable = catalog[provider]?.length === 0 && loading !== provider;

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="cm-provider">{t("create.model.provider")}</Label>
        <Select
          items={PROVIDER_IDS.map((p) => ({ value: p, label: p }))}
          value={provider}
          onValueChange={(v) => setProvider(String(v) as ProviderId)}
        >
          <SelectTrigger id="cm-provider" className="min-h-11 w-full md:min-h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDER_IDS.map((p) => (
              <SelectItem key={p} value={p}>
                {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* `key` sur le fournisseur : l'entonnoir est REMONTÉ et repart du choix
          du laboratoire. Sans ça, on reste sur la liste d'un laboratoire qui
          n'existe pas dans le nouveau catalogue — un écran vide sans raison. */}
      <ModelPicker
        key={provider}
        models={catalog[provider] ?? []}
        loading={loading === provider}
        value={model}
        effort={effort}
        onReload={() => void load(provider)}
        onChange={(next) => onChange({ ...value, model: next.model, effort: next.effort })}
      />

      {failure ? (
        <Alert variant="destructive">
          <AlertDescription>{t(`create.model.${failure}`)}</AlertDescription>
        </Alert>
      ) : null}

      {catalogueUnusable ? (
        <div className="space-y-1.5">
          <Label htmlFor="cm-manual">{t("create.model.manual")}</Label>
          <Input
            id="cm-manual"
            value={model}
            placeholder={t("create.model.manualPlaceholder")}
            onChange={(e) => setModel(e.target.value.trim())}
            className="min-h-11 font-mono text-xs md:min-h-9"
          />
          <p className="text-xs text-muted-foreground">{t("create.model.manualHint")}</p>
        </div>
      ) : null}

      {/* Badgé, pas filtré : un modèle sans outils convient à un assistant
          « qualifier seulement » — mais pas à celui-ci, qui doit réserver. */}
      {chosen && !chosen.supportsTools && needsTools ? (
        <Alert>
          <AlertDescription>{t("editor.model.toolWarning")}</AlertDescription>
        </Alert>
      ) : null}

      <Button
        className="w-full min-h-11 md:min-h-9"
        disabled={busy || model === ""}
        onClick={onCreate}
      >
        {busy ? <Loader2 className="animate-spin" /> : <SparklesIcon />}
        {t("create.model.createIt")}
      </Button>
      {model === "" ? (
        <p className="text-center text-xs text-muted-foreground">{t("create.model.required")}</p>
      ) : null}
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
export { AiCreator, SimpleCreator, ComplexCreator, ModelStep };
