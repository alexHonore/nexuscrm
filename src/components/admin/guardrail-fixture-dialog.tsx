"use client";

import { AlertTriangleIcon, HelpCircleIcon, Loader2, SaveIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import {
  GUARDRAIL_KIND_LOOK,
  LookGlyph,
  RESULT_LOOK,
  SEVERITY_LOOK,
  type Look,
} from "@/components/look";
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
import { docLocale } from "@/lib/docs/types";
import {
  GUARDRAIL_SEVERITY_DOCS,
  fixtureFieldDoc,
  fixtureText,
  severityText,
} from "@/lib/guardrails/docs";
import { GUARDRAIL_SEVERITIES, type GuardrailSeverity } from "@/lib/guardrails/types";
import { api } from "./api";

export type EditableFixture = {
  id: string | null;
  label: string;
  inbound: string;
  priorTurns: [("out" | "in"), string][];
  severity: GuardrailSeverity;
  enabled: boolean;
  mustCallTool: string[];
  mustNotCallTool: string[];
  mustMatch: string[];
  mustNotMatch: string[];
  judge: string | null;
  maxChars: number | null;
};

export function emptyFixture(): EditableFixture {
  return {
    id: null,
    label: "",
    // Un tour sortant d'emblée : sans lui, le scénario est un PREMIER message
    // et la règle d'identification LCAP le fait échouer pour une raison qui
    // n'a rien à voir avec ce qu'on teste.
    priorTurns: [["out", "Bonjour, ici Groupe Nexus."]],
    inbound: "",
    severity: "block",
    enabled: true,
    mustCallTool: [],
    mustNotCallTool: [],
    mustMatch: [],
    mustNotMatch: [],
    judge: null,
    maxChars: null,
  };
}

/** (?) d'un champ de fixture — ce qu'il fait, un exemple, et son piège. */
export function FixtureFieldHelp({ field }: { field: string }) {
  const t = useTranslations("assistants");
  const locale = docLocale(useLocale());
  const doc = fixtureFieldDoc(field);
  if (!doc) return null;
  const text = fixtureText(doc, locale);

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground"
            aria-label={`${t("guardrails.help")} — ${text.label}`}
          />
        }
      >
        <HelpCircleIcon className="size-3.5" />
      </PopoverTrigger>
      {/* 384 px d'aide sur un écran de 360 px : le plafond ne mord qu'en
          dessous de 416 px de large. */}
      <PopoverContent align="start" className="w-96 max-w-[calc(100vw-2rem)] space-y-2.5 text-sm">
        <div>
          <p className="font-medium">{text.label}</p>
          <p className="mt-1 text-xs text-muted-foreground">{text.what}</p>
        </div>
        <p className="rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">
          <span className="font-medium">{t("guardrails.helpExample")} :</span> {text.example}
        </p>
        <div className="rounded-md bg-amber-500/10 p-2">
          <p className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
            <AlertTriangleIcon className="size-3.5" /> {t("guardrails.helpPitfall")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{text.pitfall}</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Une attente de fixture — liste de lignes.
 *
 * `look` n'est pas de la décoration : « Doit appeler » et « Ne doit PAS
 * appeler » sont deux champs voisins, de même taille, dont seul le mot « PAS »
 * les sépare — et remplir le mauvais rend la fixture verte sur exactement ce
 * qu'elle devait interdire. La coche et la croix se voient avant qu'on lise.
 */
function ListField({
  field,
  label,
  value,
  onChange,
  mono,
  look,
}: {
  field: string;
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  mono?: boolean;
  look?: Look;
}) {
  const t = useTranslations("assistants");
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-0.5">
        {look ? <LookGlyph look={look} className="mr-1 size-3.5" /> : null}
        <Label className="min-w-0 break-words">{label}</Label>
        <FixtureFieldHelp field={field} />
      </div>
      <Textarea
        rows={2}
        className={mono ? "font-mono text-xs" : undefined}
        value={value.join("\n")}
        onChange={(e) => onChange(e.target.value.split("\n").map((s) => s.trim()).filter(Boolean))}
      />
      <p className="text-xs text-muted-foreground">{t("guardrails.config.onePerLine")}</p>
    </div>
  );
}

export function GuardrailFixtureDialog({
  fixture,
  open,
  onOpenChange,
}: {
  fixture: EditableFixture;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("assistants");
  const locale = docLocale(useLocale());
  const router = useRouter();
  const [draft, setDraft] = useState<EditableFixture>(fixture);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signature = `${fixture.id ?? "new"}:${open}`;
  const [seen, setSeen] = useState(signature);
  if (seen !== signature) {
    setSeen(signature);
    setDraft(fixture);
    setError(null);
  }

  const creating = draft.id === null;
  const firstOutbound = !draft.priorTurns.some((tn) => tn[0] === "out");

  const save = async () => {
    setBusy(true);
    setError(null);
    const payload = {
      label: draft.label,
      inbound: draft.inbound,
      setup: { priorTurns: draft.priorTurns, qualification: {}, rung: "primary", turnsUsed: 0 },
      expectations: {
        mustCallTool: draft.mustCallTool,
        mustNotCallTool: draft.mustNotCallTool,
        mustMatch: draft.mustMatch,
        mustNotMatch: draft.mustNotMatch,
        judge: draft.judge,
        maxChars: draft.maxChars,
      },
      severity: draft.severity,
      enabled: draft.enabled,
    };
    try {
      const res = await api<{ staleAssistants?: number }>(
        creating
          ? "/api/admin/guardrails/fixtures"
          : `/api/admin/guardrails/fixtures/${draft.id}`,
        { method: creating ? "POST" : "PATCH", body: JSON.stringify(payload) },
      );
      // Une mise en situation modifiée périme la suite des assistants : le
      // vert affiché ailleurs ne vaut plus rien tant qu'ils n'ont pas rejoué.
      const stale = res.staleAssistants ?? 0;
      toast.success(
        stale > 0
          ? `${t("guardrails.saved")} — ${t("guardrails.invalidated", { count: stale })}`
          : t("guardrails.saved"),
      );
      onOpenChange(false);
      router.refresh();
    } catch {
      setError(t("guardrails.genericError"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {creating ? t("guardrails.fixtures.newTitle") : t("guardrails.fixtures.editTitle")}
          </DialogTitle>
          <DialogDescription>{t("guardrails.fixtures.hint")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="fx-label">{t("guardrails.columns.label")}</Label>
            <Input
              id="fx-label"
              className="min-h-11 md:min-h-9"
              value={draft.label}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center gap-0.5">
              <Label htmlFor="fx-history">{t("guardrails.fixtures.history")}</Label>
              <FixtureFieldHelp field="priorTurns" />
            </div>
            <Textarea
              id="fx-history"
              rows={3}
              className="font-mono text-xs"
              placeholder={"out: Bonjour, ici Groupe Nexus.\nin: c'est quoi ça?"}
              value={draft.priorTurns.map(([dir, text]) => `${dir}: ${text}`).join("\n")}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  priorTurns: e.target.value
                    .split("\n")
                    .map((line) => line.trim())
                    .filter(Boolean)
                    .map((line) => {
                      const out = line.startsWith("out:");
                      return [out ? "out" : "in", line.replace(/^(out|in):\s*/, "")] as [
                        "out" | "in",
                        string,
                      ];
                    }),
                })
              }
            />
            {/* Le piège le plus coûteux de tout l'écran : sans tour sortant, la
                fixture teste un PREMIER message et échoue sur l'identification
                LCAP, pas sur ce qu'elle voulait vérifier. */}
            {firstOutbound ? (
              <Alert>
                <AlertTriangleIcon />
                <AlertDescription>{t("guardrails.fixtures.firstOutboundWarning")}</AlertDescription>
              </Alert>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center gap-0.5">
              <Label htmlFor="fx-inbound">{t("guardrails.fixtures.inbound")}</Label>
              <FixtureFieldHelp field="inbound" />
            </div>
            <Textarea
              id="fx-inbound"
              rows={2}
              value={draft.inbound}
              onChange={(e) => setDraft({ ...draft, inbound: e.target.value })}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <ListField
              field="mustCallTool"
              label={t("guardrails.fixtures.mustCallTool")}
              value={draft.mustCallTool}
              onChange={(v) => setDraft({ ...draft, mustCallTool: v })}
              mono
              look={RESULT_LOOK.pass}
            />
            <ListField
              field="mustNotCallTool"
              label={t("guardrails.fixtures.mustNotCallTool")}
              value={draft.mustNotCallTool}
              onChange={(v) => setDraft({ ...draft, mustNotCallTool: v })}
              mono
              look={RESULT_LOOK.fail}
            />
            <ListField
              field="mustMatch"
              label={t("guardrails.fixtures.mustMatch")}
              value={draft.mustMatch}
              onChange={(v) => setDraft({ ...draft, mustMatch: v })}
              mono
              look={RESULT_LOOK.pass}
            />
            <ListField
              field="mustNotMatch"
              label={t("guardrails.fixtures.mustNotMatch")}
              value={draft.mustNotMatch}
              onChange={(v) => setDraft({ ...draft, mustNotMatch: v })}
              mono
              look={RESULT_LOOK.fail}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center gap-0.5">
              {/* Le même pictogramme que la règle « Jugement par IA » : c'est
                  le même mécanisme, appliqué à une seule mise en situation. */}
              <LookGlyph look={GUARDRAIL_KIND_LOOK.llm_judge} className="mr-1 size-3.5" />
              <Label htmlFor="fx-judge">{t("guardrails.fixtures.judge")}</Label>
              <FixtureFieldHelp field="judge" />
            </div>
            <Textarea
              id="fx-judge"
              rows={2}
              value={draft.judge ?? ""}
              onChange={(e) => setDraft({ ...draft, judge: e.target.value || null })}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <div className="flex items-center gap-0.5">
                <LookGlyph look={GUARDRAIL_KIND_LOOK.max_chars} className="mr-1 size-3.5" />
                <Label htmlFor="fx-maxchars">{t("guardrails.fixtures.maxChars")}</Label>
                <FixtureFieldHelp field="maxChars" />
              </div>
              <Input
                id="fx-maxchars"
                type="number"
                inputMode="numeric"
                min={1}
                className="min-h-11 md:min-h-9"
                value={draft.maxChars ?? ""}
                onChange={(e) =>
                  setDraft({ ...draft, maxChars: e.target.value ? Number(e.target.value) : null })
                }
              />
            </div>

            <div className="space-y-1.5">
              <Label>{t("guardrails.columns.severity")}</Label>
              <Select
                items={GUARDRAIL_SEVERITIES.map((s) => ({
                  value: s,
                  label: severityText(GUARDRAIL_SEVERITY_DOCS[s], locale).label,
                }))}
                value={draft.severity}
                onValueChange={(v) =>
                  setDraft({ ...draft, severity: String(v) as GuardrailSeverity })
                }
              >
                <SelectTrigger className="min-h-11 w-full md:min-h-9">
                  <LookGlyph look={SEVERITY_LOOK[draft.severity]} className="size-3.5" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GUARDRAIL_SEVERITIES.map((s) => (
                    <SelectItem key={s} value={s}>
                      <LookGlyph look={SEVERITY_LOOK[s]} className="size-3.5" />
                      {severityText(GUARDRAIL_SEVERITY_DOCS[s], locale).label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-start justify-between gap-3 rounded-md border p-3">
              <Label htmlFor="fx-enabled">{t("guardrails.columns.enabled")}</Label>
              <Switch
                id="fx-enabled"
                checked={draft.enabled}
                onCheckedChange={(next) => setDraft({ ...draft, enabled: next })}
              />
            </div>
          </div>
        </div>

        {error ? (
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button
            onClick={() => void save()}
            disabled={busy || draft.label.trim() === "" || draft.inbound.trim() === ""}
          >
            {busy ? <Loader2 className="animate-spin" /> : <SaveIcon />} {t("guardrails.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
