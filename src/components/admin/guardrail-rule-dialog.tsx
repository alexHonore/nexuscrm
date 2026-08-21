"use client";

import { AlertTriangleIcon, HelpCircleIcon, Loader2, SaveIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  GUARDRAIL_KIND_DOCS,
  GUARDRAIL_SEVERITY_DOCS,
  RULE_PRESETS,
  defaultConfigFor,
  kindDoc,
  type RulePreset,
} from "@/lib/guardrails/docs";
import {
  GUARDRAIL_KINDS,
  GUARDRAIL_SEVERITIES,
  type GuardrailKind,
  type GuardrailSeverity,
} from "@/lib/guardrails/types";
import { ApiError, api } from "./api";

export type EditableRule = {
  id: string | null;
  key: string;
  label: string;
  description: string | null;
  kind: GuardrailKind;
  config: unknown;
  promptText: string | null;
  severity: GuardrailSeverity;
  enabled: boolean;
};

/** Une règle prête à l'emploi → brouillon éditable. */
export function ruleFromPreset(preset: RulePreset): EditableRule {
  return {
    id: null,
    key: preset.key,
    label: preset.labelFr,
    description: preset.whatFr,
    kind: preset.kind,
    config: preset.config,
    promptText: preset.promptText,
    severity: preset.severity,
    enabled: true,
  };
}

export function emptyRule(): EditableRule {
  return {
    id: null,
    key: "",
    label: "",
    description: null,
    kind: "forbidden_terms",
    config: defaultConfigFor("forbidden_terms"),
    promptText: null,
    severity: "block",
    enabled: true,
  };
}

/**
 * Aide d'un type de règle — le (?) à côté du sélecteur.
 *
 * Les exemples « passe / attrapé » ne sont pas décoratifs : « motif interdit »
 * et « termes interdits » se ressemblent beaucoup décrits en une phrase, et le
 * choix entre les deux décide pourtant si « commissionnaire » déclenche la
 * règle écrite pour « commission ».
 */
export function KindHelp({ kind }: { kind: GuardrailKind }) {
  const t = useTranslations("assistants");
  const doc = kindDoc(kind);
  if (!doc) return null;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground"
            aria-label={`${t("guardrails.help")} — ${doc.labelFr}`}
          />
        }
      >
        <HelpCircleIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 space-y-3 text-sm">
        <div>
          <p className="font-medium">{doc.labelFr}</p>
          <p className="mt-1 text-xs text-muted-foreground">{doc.whatFr}</p>
        </div>

        <Block title={t("guardrails.helpWhen")} body={doc.whenFr} />
        <Block title={t("guardrails.helpConfig")} body={doc.configFr} />

        <div className="space-y-1.5">
          <p className="rounded-md bg-emerald-500/10 p-2 text-xs">
            <span className="font-medium text-emerald-700 dark:text-emerald-400">
              {t("guardrails.helpPasses")} :
            </span>{" "}
            <span className="text-muted-foreground">{doc.passesFr}</span>
          </p>
          <p className="rounded-md bg-destructive/10 p-2 text-xs">
            <span className="font-medium text-destructive">{t("guardrails.helpCaught")} :</span>{" "}
            <span className="text-muted-foreground">{doc.caughtFr}</span>
          </p>
        </div>

        <div className="rounded-md bg-amber-500/10 p-2">
          <p className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
            <AlertTriangleIcon className="size-3.5" /> {t("guardrails.helpPitfall")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{doc.pitfallFr}</p>
        </div>

        {doc.costsModelCall ? (
          <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
            {t("guardrails.helpCost")}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function Block({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{body}</p>
    </div>
  );
}

/** Champs de configuration propres à chaque type. */
function ConfigFields({
  kind,
  config,
  onChange,
}: {
  kind: GuardrailKind;
  config: unknown;
  onChange: (next: unknown) => void;
}) {
  const t = useTranslations("assistants");
  const value = (config ?? {}) as Record<string, unknown>;
  const list = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

  switch (kind) {
    case "forbidden_terms":
      return (
        <div className="space-y-1.5">
          <Label htmlFor="g-terms">{t("guardrails.config.terms")}</Label>
          <Textarea
            id="g-terms"
            rows={4}
            placeholder={t("guardrails.config.termsPlaceholder")}
            value={list(value.terms).join("\n")}
            onChange={(e) =>
              onChange({ terms: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })
            }
          />
          <p className="text-xs text-muted-foreground">{t("guardrails.config.onePerLine")}</p>
        </div>
      );

    case "forbidden_regex":
      return (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="g-patterns">{t("guardrails.config.patterns")}</Label>
            <Textarea
              id="g-patterns"
              rows={4}
              className="font-mono text-xs"
              value={list(value.patterns).join("\n")}
              onChange={(e) =>
                onChange({
                  ...value,
                  patterns: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean),
                })
              }
            />
            <p className="text-xs text-muted-foreground">{t("guardrails.config.onePerLine")}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="g-flags">{t("guardrails.config.flags")}</Label>
            <Input
              id="g-flags"
              className="min-h-11 font-mono md:min-h-9 md:w-32"
              value={typeof value.flags === "string" ? value.flags : "iu"}
              onChange={(e) => onChange({ ...value, flags: e.target.value })}
            />
          </div>
        </div>
      );

    case "max_chars":
    case "max_questions":
      return (
        <div className="space-y-1.5">
          <Label htmlFor="g-max">{t("guardrails.config.max")}</Label>
          <Input
            id="g-max"
            type="number"
            inputMode="numeric"
            min={kind === "max_questions" ? 0 : 1}
            className="min-h-11 md:min-h-9 md:w-40"
            value={typeof value.max === "number" ? value.max : ""}
            onChange={(e) => onChange({ max: Number(e.target.value) })}
          />
        </div>
      );

    case "link_policy":
      return (
        <div className="space-y-1.5">
          <Label htmlFor="g-domains">{t("guardrails.config.allowedDomains")}</Label>
          <Textarea
            id="g-domains"
            rows={3}
            className="font-mono text-xs"
            value={list(value.allowedDomains).join("\n")}
            onChange={(e) =>
              onChange({
                allowedDomains: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean),
              })
            }
          />
          <p className="text-xs text-muted-foreground">
            {t("guardrails.config.emptyMeansNoLinks")}
          </p>
        </div>
      );

    case "required_tool_on_intent":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="g-intent">{t("guardrails.config.intent")}</Label>
            <Input
              id="g-intent"
              className="min-h-11 md:min-h-9"
              value={typeof value.intent === "string" ? value.intent : ""}
              onChange={(e) => onChange({ ...value, intent: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="g-tool">{t("guardrails.config.tool")}</Label>
            <Input
              id="g-tool"
              className="min-h-11 md:min-h-9"
              value={typeof value.tool === "string" ? value.tool : ""}
              onChange={(e) => onChange({ ...value, tool: e.target.value })}
            />
          </div>
        </div>
      );

    case "llm_judge":
      return (
        <div className="space-y-1.5">
          <Label htmlFor="g-criterion">{t("guardrails.config.criterion")}</Label>
          <Textarea
            id="g-criterion"
            rows={3}
            placeholder={t("guardrails.config.criterionPlaceholder")}
            value={typeof value.criterion === "string" ? value.criterion : ""}
            onChange={(e) => onChange({ criterion: e.target.value })}
          />
        </div>
      );

    case "custom_instruction":
      return (
        <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          {t("guardrails.config.nothingToConfigure")}
        </p>
      );
  }
}

export function GuardrailRuleDialog({
  rule,
  open,
  onOpenChange,
}: {
  rule: EditableRule;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("assistants");
  const router = useRouter();
  const [draft, setDraft] = useState<EditableRule>(rule);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Le brouillon repart de la règle à chaque ouverture : sans ça, rouvrir le
  // dialogue après une annulation ressusciterait les valeurs abandonnées.
  const signature = `${rule.id ?? "new"}:${open}`;
  const [seen, setSeen] = useState(signature);
  if (seen !== signature) {
    setSeen(signature);
    setDraft(rule);
    setError(null);
  }

  const doc = useMemo(() => kindDoc(draft.kind), [draft.kind]);
  const creating = draft.id === null;
  /**
   * À la création, on part d'une INTENTION (« ne parle jamais de prix »), pas
   * d'un type technique. Choisir un type puis remplir une configuration, c'est
   * deux décisions d'ingénieur pour exprimer une règle d'affaires.
   */
  const [showPresets, setShowPresets] = useState(creating && draft.key === "");

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      // La réponse dit combien d'assistants cette règle vient de périmer :
      // leur L6 recopie son texte et leur suite doit être rejouée. Le dire
      // ici évite de le découvrir à l'activation suivante.
      let result: { staleAssistants?: number };
      if (creating) {
        result = await api<{ staleAssistants?: number }>("/api/admin/guardrails/rules", {
          method: "POST",
          body: JSON.stringify({
            key: draft.key,
            label: draft.label,
            description: draft.description,
            kind: draft.kind,
            config: draft.config,
            promptText: draft.promptText,
            severity: draft.severity,
            enabled: draft.enabled,
          }),
        });
      } else {
        result = await api<{ staleAssistants?: number }>(`/api/admin/guardrails/rules/${draft.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            label: draft.label,
            description: draft.description,
            promptText: draft.promptText,
            severity: draft.severity,
            enabled: draft.enabled,
            config: draft.config,
          }),
        });
      }
      const stale = result.staleAssistants ?? 0;
      toast.success(
        stale > 0
          ? `${t("guardrails.saved")} — ${t("guardrails.invalidated", { count: stale })}`
          : t("guardrails.saved"),
      );
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      setError(
        code === "key_taken"
          ? t("guardrails.errors.keyTaken")
          : code === "invalid_config"
            ? t("guardrails.errors.invalidConfig")
            : t("guardrails.genericError"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{creating ? t("guardrails.newRule") : t("guardrails.editRule")}</DialogTitle>
          <DialogDescription>{t("guardrails.ruleDialogHint")}</DialogDescription>
        </DialogHeader>

        {showPresets ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{t("guardrails.presets.hint")}</p>
            <div className="grid gap-2">
              {RULE_PRESETS.map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  className="rounded-lg border p-3 text-left transition-colors hover:border-primary hover:bg-primary/5"
                  onClick={() => {
                    setDraft(ruleFromPreset(preset));
                    setShowPresets(false);
                  }}
                >
                  <p className="text-sm font-medium">{preset.labelFr}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{preset.whatFr}</p>
                </button>
              ))}
              <button
                type="button"
                className="rounded-lg border border-dashed p-3 text-left text-sm text-muted-foreground transition-colors hover:border-primary"
                onClick={() => setShowPresets(false)}
              >
                {t("guardrails.presets.custom")}
              </button>
            </div>
          </div>
        ) : (
        <div className="space-y-4">
          {creating ? (
            <Button
              variant="ghost"
              size="sm"
              className="min-h-11 px-0 md:min-h-8"
              onClick={() => setShowPresets(true)}
            >
              ← {t("guardrails.presets.back")}
            </Button>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="g-label">{t("guardrails.columns.label")}</Label>
              <Input
                id="g-label"
                className="min-h-11 md:min-h-9"
                value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="g-key">{t("guardrails.columns.key")}</Label>
              <Input
                id="g-key"
                className="min-h-11 font-mono text-xs md:min-h-9"
                disabled={!creating}
                value={draft.key}
                onChange={(e) =>
                  setDraft({ ...draft, key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })
                }
              />
              {!creating ? (
                <p className="text-xs text-muted-foreground">{t("guardrails.keyImmutable")}</p>
              ) : null}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="g-desc">{t("guardrails.columns.description")}</Label>
            <Textarea
              id="g-desc"
              rows={2}
              value={draft.description ?? ""}
              onChange={(e) => setDraft({ ...draft, description: e.target.value || null })}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center gap-0.5">
              <Label>{t("guardrails.columns.kind")}</Label>
              <KindHelp kind={draft.kind} />
            </div>
            <Select
              items={GUARDRAIL_KINDS.map((k) => ({ value: k, label: GUARDRAIL_KIND_DOCS[k].labelFr }))}
              value={draft.kind}
              disabled={!creating}
              onValueChange={(v) => {
                const next = String(v) as GuardrailKind;
                // Changer de type change la forme de la config : repartir du
                // défaut évite d'enregistrer une config d'un autre type.
                setDraft({ ...draft, kind: next, config: defaultConfigFor(next) });
              }}
            >
              <SelectTrigger className="min-h-11 w-full md:min-h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GUARDRAIL_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {GUARDRAIL_KIND_DOCS[k].labelFr}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {doc ? <p className="text-xs text-muted-foreground">{doc.whatFr}</p> : null}
            {!creating ? (
              <p className="text-xs text-muted-foreground">{t("guardrails.kindImmutable")}</p>
            ) : null}
          </div>

          <ConfigFields
            kind={draft.kind}
            config={draft.config}
            onChange={(next) => setDraft({ ...draft, config: next })}
          />

          <div className="space-y-1.5">
            <Label htmlFor="g-prompt">{t("guardrails.promptText")}</Label>
            <Textarea
              id="g-prompt"
              rows={2}
              placeholder={t("guardrails.promptTextPlaceholder")}
              value={draft.promptText ?? ""}
              onChange={(e) => setDraft({ ...draft, promptText: e.target.value || null })}
            />
            <p className="text-xs text-muted-foreground">{t("guardrails.promptTextHint")}</p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t("guardrails.columns.severity")}</Label>
              <Select
                items={GUARDRAIL_SEVERITIES.map((s) => ({
                  value: s,
                  label: GUARDRAIL_SEVERITY_DOCS[s].labelFr,
                }))}
                value={draft.severity}
                onValueChange={(v) => setDraft({ ...draft, severity: String(v) as GuardrailSeverity })}
              >
                <SelectTrigger className="min-h-11 w-full md:min-h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GUARDRAIL_SEVERITIES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {GUARDRAIL_SEVERITY_DOCS[s].labelFr}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {GUARDRAIL_SEVERITY_DOCS[draft.severity].whatFr}
              </p>
            </div>

            <div className="flex items-start justify-between gap-3 rounded-md border p-3">
              <Label htmlFor="g-enabled">{t("guardrails.columns.enabled")}</Label>
              <Switch
                id="g-enabled"
                checked={draft.enabled}
                onCheckedChange={(next) => setDraft({ ...draft, enabled: next })}
              />
            </div>
          </div>

          {/* Une consigne de prompt marquée bloquante ment à l'écran : elle ne
              peut rien refuser. On le dit ici plutôt que de l'interdire. */}
          {draft.kind === "custom_instruction" && draft.severity === "block" ? (
            <Alert>
              <AlertTriangleIcon />
              <AlertDescription>{t("guardrails.errors.customCannotBlock")}</AlertDescription>
            </Alert>
          ) : null}

          {error ? (
            <Alert variant="destructive">
              <AlertTriangleIcon />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button
            onClick={() => void save()}
            disabled={
              busy || showPresets || draft.label.trim() === "" || (creating && draft.key.trim() === "")
            }
          >
            {busy ? <Loader2 className="animate-spin" /> : <SaveIcon />} {t("guardrails.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { GUARDRAIL_KIND_DOCS };
