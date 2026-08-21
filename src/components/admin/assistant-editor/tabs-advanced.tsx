"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  RotateCcw,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { LAYER_IDS, assistantConfigSchema, type LayerId } from "@/lib/assistants/schema";
import { copyToClipboard } from "../api";
import { FieldLabel } from "./param-help";
import type { TabProps } from "./types";

// ── Garde-fous ───────────────────────────────────────────────────────────────

/**
 * Vue lecture des règles applicables.
 *
 * L'édition des règles du noyau vit dans /admin/guardrails : les dupliquer ici
 * ferait croire qu'on modifie une règle pour CET assistant alors qu'on la
 * change pour tous.
 */
export function GuardrailsTab({ config, update, data }: TabProps) {
  const t = useTranslations("assistants");
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 rounded-md border p-3">
        <FieldLabel path="requireSuitePass" />
        <Switch
          checked={config.requireSuitePass}
          aria-label={t("editor.tabs.guardrails")}
          onCheckedChange={(next) => update((d) => void (d.requireSuitePass = next))}
        />
      </div>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium">{t("editor.guardrails.coreTitle")}</h3>
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 md:min-h-9"
            render={<Link href="/admin/guardrails" />}
          >
            <ExternalLink /> {t("editor.guardrails.manage")}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{t("editor.guardrails.coreNote")}</p>
        <RuleList rules={data.coreRules} />
      </section>

      <section className="space-y-2">
        <h3 className="font-medium">{t("editor.guardrails.ownTitle")}</h3>
        {data.ownRules.length === 0 ? (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            {t("editor.guardrails.ownEmpty")}
          </p>
        ) : (
          <RuleList rules={data.ownRules} />
        )}
      </section>
    </div>
  );
}

function RuleList({ rules }: { rules: TabProps["data"]["coreRules"] }) {
  const t = useTranslations("assistants");
  return (
    <ul className="divide-y rounded-md border">
      {rules.map((rule) => (
        <li key={rule.id} className="flex flex-wrap items-center gap-2 p-3 text-sm">
          <span className="min-w-0 flex-1 truncate">{rule.label}</span>
          <Badge variant="outline" className="font-normal">
            {t(`guardrails.kind.${rule.kind}`)}
          </Badge>
          <Badge
            variant={rule.severity === "block" ? "destructive" : "secondary"}
            className={rule.enabled ? "" : "opacity-50"}
          >
            {t(`guardrails.severity.${rule.severity}`)}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

// ── Prompt ───────────────────────────────────────────────────────────────────

export function PromptTab({ config, update, data }: TabProps) {
  const t = useTranslations("assistants");
  const raw = config.promptMode === "raw";

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <FieldLabel path="promptMode" />
        <Select
          items={[
            { value: "composed", label: t("editor.prompt.modeComposed") },
            { value: "raw", label: t("editor.prompt.modeRaw") },
          ]}
          value={config.promptMode}
          onValueChange={(v) => update((d) => void (d.promptMode = String(v) as "composed" | "raw"))}
        >
          <SelectTrigger className="min-h-11 w-full md:min-h-9 md:w-72">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="composed">{t("editor.prompt.modeComposed")}</SelectItem>
            <SelectItem value="raw">{t("editor.prompt.modeRaw")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {raw ? (
        <>
          <Alert>
            <AlertTriangle />
            <AlertDescription>{t("editor.prompt.rawWarning")}</AlertDescription>
          </Alert>
          <div className="space-y-1.5">
            <FieldLabel path="systemPromptOverride" htmlFor="f-raw" />
            <Textarea
              id="f-raw"
              rows={16}
              className="font-mono text-xs"
              value={config.systemPromptOverride ?? ""}
              onChange={(e) =>
                update((d) => void (d.systemPromptOverride = e.target.value || null))
              }
            />
          </div>
        </>
      ) : (
        <section className="space-y-3">
          <FieldLabel path="layerOverrides" />
          <div className="space-y-2">
            {LAYER_IDS.map((layer) => (
              <LayerRow key={layer} layer={layer} config={config} update={update} />
            ))}
          </div>
        </section>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3 rounded-md border p-3">
          <FieldLabel path="includeRuntimeLayer" />
          <Switch
            checked={config.includeRuntimeLayer}
            aria-label={t("editor.prompt.runtimeLayer")}
            onCheckedChange={(next) => update((d) => void (d.includeRuntimeLayer = next))}
          />
        </div>
        <div className="space-y-1.5">
          <FieldLabel path="turnInstructions" htmlFor="f-turn" />
          <Textarea
            id="f-turn"
            rows={6}
            className="font-mono text-xs"
            value={config.turnInstructions ?? ""}
            onChange={(e) => update((d) => void (d.turnInstructions = e.target.value || null))}
          />
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="font-medium">{t("editor.tabs.prompt")}</h3>
        {data.compiledPrompt ? (
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 font-mono text-xs">
            {data.compiledPrompt}
          </pre>
        ) : (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            {t("editor.prompt.notCompiled")}
          </p>
        )}
      </section>
    </div>
  );
}

function LayerRow({
  layer,
  config,
  update,
}: {
  layer: LayerId;
  config: TabProps["config"];
  update: TabProps["update"];
}) {
  const t = useTranslations("assistants");
  const override = config.layerOverrides[layer];

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm">{layer}</span>
        {override ? (
          <Badge variant="secondary">{t("editor.prompt.overridden")}</Badge>
        ) : (
          <Badge variant="outline" className="font-normal text-muted-foreground">
            {t("editor.prompt.generated")}
          </Badge>
        )}
        <span className="flex-1" />
        {override ? (
          <Button
            variant="ghost"
            size="sm"
            className="min-h-11 md:min-h-9"
            onClick={() =>
              update((d) => {
                delete d.layerOverrides[layer];
              })
            }
          >
            <RotateCcw /> {t("editor.prompt.resetLayer")}
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="min-h-11 md:min-h-9"
            onClick={() =>
              update((d) => void (d.layerOverrides[layer] = { mode: "append", text: "" }))
            }
          >
            {t("editor.prompt.override")}
          </Button>
        )}
      </div>

      {override ? (
        <div className="space-y-2">
          <Select
            items={[
              { value: "append", label: t("editor.prompt.override") },
              { value: "replace", label: t("editor.prompt.overridden") },
            ]}
            value={override.mode}
            onValueChange={(v) =>
              update(
                (d) =>
                  void (d.layerOverrides[layer] = {
                    ...override,
                    mode: String(v) as "append" | "replace",
                  }),
              )
            }
          >
            <SelectTrigger className="min-h-11 w-full md:min-h-9 md:w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="append">append</SelectItem>
              <SelectItem value="replace">replace</SelectItem>
            </SelectContent>
          </Select>
          <Textarea
            rows={4}
            className="font-mono text-xs"
            value={override.text}
            onChange={(e) =>
              update(
                (d) => void (d.layerOverrides[layer] = { ...override, text: e.target.value }),
              )
            }
          />
        </div>
      ) : null}
    </div>
  );
}

// ── Test ─────────────────────────────────────────────────────────────────────

export function TestTab({
  data,
  onRunSuite,
  running,
}: TabProps & { onRunSuite: () => void; running: boolean }) {
  const t = useTranslations("assistants");
  const run = data.lastRun;
  // Un vert affiché n'en est un que si le drapeau de la fiche le confirme :
  // une sauvegarde ou une recompilation l'efface sans toucher à l'exécution
  // passée. Sans ce signal, l'onglet disait « 14/14 » et la porte refusait.
  const stale = run !== null && run.passed && !data.suitePassed;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-1">
          {run ? (
            <>
              <p className="text-sm">
                {t("editor.test.passed", { passed: run.passedCount, total: run.total })}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("editor.test.lastRun", {
                  when: new Date(run.createdAt).toLocaleString("fr-CA", {
                    timeZone: "America/Toronto",
                    dateStyle: "medium",
                    timeStyle: "short",
                  }),
                })}
              </p>
              {stale ? (
                <p className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="size-3.5" /> {t("editor.test.stale")}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t("editor.test.never")}</p>
          )}
        </div>
        <Button onClick={onRunSuite} disabled={running} className="min-h-11 md:min-h-9">
          {running ? <Loader2 className="animate-spin" /> : null}
          {running ? t("editor.runningSuite") : t("editor.test.run")}
        </Button>
      </div>

      {run ? (
        <ul className="divide-y rounded-md border">
          {run.results.map((r, i) => (
            <li key={i} className="space-y-1 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                {r.passed ? (
                  <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />
                ) : (
                  <XCircle className="size-4 shrink-0 text-destructive" />
                )}
                <span className="min-w-0 flex-1">{r.label}</span>
                {r.severity === "block" ? (
                  <Badge variant="outline">{t("editor.test.blocking")}</Badge>
                ) : null}
              </div>
              {!r.passed && r.reason ? (
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium">{t("editor.test.reason")} :</span> {r.reason}
                </p>
              ) : null}
              {!r.passed && r.output ? (
                <p className="rounded bg-muted/50 p-2 font-mono text-xs">{r.output}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ── JSON ─────────────────────────────────────────────────────────────────────

export function JsonTab({ config, update, data }: TabProps) {
  const t = useTranslations("assistants");
  const [draft, setDraft] = useState(() => JSON.stringify(config, null, 2));
  const [error, setError] = useState<string | null>(null);

  const apply = () => {
    try {
      const parsed = assistantConfigSchema.parse(JSON.parse(draft));
      // On remplace la configuration entière : c'est ce que l'onglet promet.
      update((d) => void Object.assign(d, parsed));
      setError(null);
      toast.success(t("editor.json.applied"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("editor.json.invalid"));
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label htmlFor="f-json">{t("editor.json.title")}</Label>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 md:min-h-9"
            onClick={() =>
              void copyToClipboard(draft).then((ok) =>
                ok ? toast.success(t("editor.json.copied")) : undefined,
              )
            }
          >
            <Copy /> {t("editor.json.copy")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 md:min-h-9"
            render={<a href={`/api/assistants/${data.id}/export`} download />}
          >
            {t("editor.json.download")}
          </Button>
          <Button size="sm" className="min-h-11 md:min-h-9" onClick={apply}>
            {t("editor.json.apply")}
          </Button>
        </div>
      </div>

      <Textarea
        id="f-json"
        rows={22}
        className="font-mono text-xs"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-invalid={error !== null || undefined}
      />

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertDescription className="font-mono text-xs">{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
