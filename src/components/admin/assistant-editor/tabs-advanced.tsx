"use client";

import {
  AlertTriangle,
  Copy,
  DownloadIcon,
  ExternalLink,
  Loader2,
  PlayIcon,
  RotateCcw,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import {
  EDITOR_TAB_LOOK,
  GUARDRAIL_KIND_LOOK,
  LookGlyph,
  LookIcon,
  ORIGIN_LOOK,
  RESULT_LOOK,
  SEVERITY_LOOK,
  lookTint,
} from "@/components/look";
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
import type { GuardrailSeverity } from "@/lib/guardrails/types";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "../api";
import { EmptyRow, Panel, TabHead, ToggleRow, useTabHead } from "./layout";
import { FieldLabel } from "./param-help";
import type { TabProps } from "./types";

/**
 * Puce de sévérité.
 *
 * Redéfinie ici plutôt qu'importée de l'écran d'administration : l'éditeur
 * d'assistant n'a pas à traîner le dialogue CRUD des garde-fous dans son
 * paquet. Ce qui doit rester unique, c'est le VOCABULAIRE (`SEVERITY_LOOK`),
 * pas le composant qui l'affiche.
 */
function SeverityBadge({
  severity,
  label,
  className,
}: {
  severity: GuardrailSeverity;
  /** Formulation propre à l'écran (« Bloquante ») quand elle qualifie une
   *  fixture et non le sort d'un message. */
  label?: string;
  className?: string;
}) {
  const t = useTranslations("assistants");
  const look = SEVERITY_LOOK[severity];
  return (
    <Badge variant="outline" className={cn("gap-1", className)} style={lookTint(look)}>
      <LookGlyph look={look} className="size-3" />
      {label ?? t(`guardrails.severity.${severity}`)}
    </Badge>
  );
}

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
  const head = useTabHead("guardrails");
  const look = EDITOR_TAB_LOOK.guardrails;

  return (
    <div className="space-y-4">
      <TabHead look={look} title={head.title} hint={head.hint} />

      {/* La pastille est celle de l'onglet « Vérification » : ce réglage parle
          de la suite, pas des règles listées en dessous. */}
      <ToggleRow
        control={
          <Switch
            checked={config.requireSuitePass}
            aria-label={t("editor.tabs.guardrails")}
            onCheckedChange={(next) => update((d) => void (d.requireSuitePass = next))}
          />
        }
      >
        <LookIcon look={EDITOR_TAB_LOOK.test} size="sm" />
        <FieldLabel path="requireSuitePass" />
      </ToggleRow>

      {/* L'édition des règles du noyau vit dans /admin/guardrails : les
          dupliquer ici ferait croire qu'on modifie une règle pour CET
          assistant alors qu'on la change pour tous. */}
      <Panel
        look={look}
        title={t("editor.guardrails.coreTitle")}
        description={t("editor.guardrails.coreNote")}
        actions={
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 md:min-h-9"
            render={<Link href="/admin/guardrails" />}
          >
            <ExternalLink /> {t("editor.guardrails.manage")}
          </Button>
        }
      >
        <RuleList rules={data.coreRules} />
      </Panel>

      <Panel look={look} title={t("editor.guardrails.ownTitle")}>
        {data.ownRules.length === 0 ? (
          <EmptyRow>{t("editor.guardrails.ownEmpty")}</EmptyRow>
        ) : (
          <RuleList rules={data.ownRules} />
        )}
      </Panel>
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
          <Badge variant="outline" className="max-w-full gap-1 font-normal">
            <LookGlyph look={GUARDRAIL_KIND_LOOK[rule.kind]} className="size-3" />
            {/* `min-w-0` : sans lui la puce ne tronque pas, elle coupe. */}
            <span className="min-w-0 truncate">{t(`guardrails.kind.${rule.kind}`)}</span>
          </Badge>
          {/* Une règle désactivée garde sa sévérité affichée, en retrait : la
              masquer ferait croire qu'elle n'en a plus quand on la rallume. */}
          <SeverityBadge severity={rule.severity} className={rule.enabled ? undefined : "opacity-50"} />
        </li>
      ))}
    </ul>
  );
}

// ── Prompt ───────────────────────────────────────────────────────────────────

export function PromptTab({ config, update, data }: TabProps) {
  const t = useTranslations("assistants");
  const head = useTabHead("prompt");
  const look = EDITOR_TAB_LOOK.prompt;
  const raw = config.promptMode === "raw";

  return (
    <div className="space-y-4">
      <TabHead look={look} title={head.title} hint={head.hint} />

      <Panel look={look} contentClassName="space-y-4">
        <div className="space-y-1.5">
          <FieldLabel path="promptMode" />
          <Select
            items={[
              { value: "composed", label: t("editor.prompt.modeComposed") },
              { value: "raw", label: t("editor.prompt.modeRaw") },
            ]}
            value={config.promptMode}
            onValueChange={(v) =>
              update((d) => void (d.promptMode = String(v) as "composed" | "raw"))
            }
          >
            {/* Les deux modes décident QUI écrit le prompt — l'app ou la main. */}
            <SelectTrigger className="min-h-11 w-full md:min-h-9 md:w-72">
              <LookGlyph look={ORIGIN_LOOK[raw ? "handwritten" : "generated"]} className="size-3.5" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="composed">
                <LookGlyph look={ORIGIN_LOOK.generated} className="size-3.5" />
                {t("editor.prompt.modeComposed")}
              </SelectItem>
              <SelectItem value="raw">
                <LookGlyph look={ORIGIN_LOOK.handwritten} className="size-3.5" />
                {t("editor.prompt.modeRaw")}
              </SelectItem>
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
          <div className="space-y-2">
            <FieldLabel path="layerOverrides" />
            {LAYER_IDS.map((layer) => (
              <LayerRow key={layer} layer={layer} config={config} update={update} />
            ))}
          </div>
        )}
      </Panel>

      <Panel look={look} contentClassName="space-y-3">
        <ToggleRow
          control={
            <Switch
              checked={config.includeRuntimeLayer}
              aria-label={t("editor.prompt.runtimeLayer")}
              onCheckedChange={(next) => update((d) => void (d.includeRuntimeLayer = next))}
            />
          }
        >
          <FieldLabel path="includeRuntimeLayer" />
        </ToggleRow>
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
      </Panel>

      <Panel look={look} title={t("editor.tabs.prompt")}>
        {data.compiledPrompt ? (
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 font-mono text-xs">
            {data.compiledPrompt}
          </pre>
        ) : (
          <EmptyRow>{t("editor.prompt.notCompiled")}</EmptyRow>
        )}
      </Panel>
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
        {/* Sept couches nommées L0…L6 : ce qu'on cherche en ouvrant l'onglet,
            c'est laquelle a été reprise à la main. */}
        {override ? (
          <Badge variant="outline" className="gap-1" style={lookTint(ORIGIN_LOOK.handwritten)}>
            <LookGlyph look={ORIGIN_LOOK.handwritten} className="size-3" />
            {t("editor.prompt.overridden")}
          </Badge>
        ) : (
          <Badge variant="outline" className="gap-1 font-normal text-muted-foreground">
            <LookGlyph look={ORIGIN_LOOK.generated} className="size-3" />
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
            <LookGlyph look={ORIGIN_LOOK.handwritten} className="size-3.5" />
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
              <SelectItem value="append">{t("editor.prompt.override")}</SelectItem>
              <SelectItem value="replace">{t("editor.prompt.overridden")}</SelectItem>
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
  const head = useTabHead("test");
  const look = EDITOR_TAB_LOOK.test;
  const run = data.lastRun;
  // Un vert affiché n'en est un que si le drapeau de la fiche le confirme :
  // une sauvegarde ou une recompilation l'efface sans toucher à l'exécution
  // passée. Sans ce signal, l'onglet disait « 14/14 » et la porte refusait.
  const stale = run !== null && run.passed && !data.suitePassed;

  return (
    <div className="space-y-4">
      <TabHead
        look={look}
        title={head.title}
        hint={head.hint}
        actions={
          <Button onClick={onRunSuite} disabled={running} className="min-h-11 md:min-h-9">
            {running ? <Loader2 className="animate-spin" /> : <PlayIcon />}
            {running ? t("editor.runningSuite") : t("editor.test.run")}
          </Button>
        }
      />

      {/* Le verdict d'abord, en grand : « 13/14 » se lit, un rouge se voit. */}
      <Panel look={run && !run.passed ? RESULT_LOOK.fail : look}>
        <div className="flex min-w-0 items-start gap-3">
          {run ? <LookIcon look={RESULT_LOOK[run.passed ? "pass" : "fail"]} size="lg" /> : null}
          <div className="min-w-0 space-y-1">
            {run ? (
              <>
                <p className="font-heading text-base font-medium">
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
                  <p className="flex items-center gap-1 text-xs break-words text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="size-3.5 shrink-0" /> {t("editor.test.stale")}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t("editor.test.never")}</p>
            )}
          </div>
        </div>
      </Panel>

      {run ? (
        <Panel look={look} contentClassName="p-0">
          <ul className="divide-y">
            {run.results.map((r, i) => (
              <li
                key={i}
                className={cn(
                  "space-y-1 px-4 py-3 text-sm first:rounded-t-xl last:rounded-b-xl",
                  !r.passed && "bg-destructive/5",
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  {/* Coche ou croix : la forme dit déjà ce que dit la couleur,
                      pour l'œil qui ne distingue pas le rouge du vert. */}
                  <LookGlyph look={RESULT_LOOK[r.passed ? "pass" : "fail"]} />
                  <span className="min-w-0 flex-1 break-words">{r.label}</span>
                  <SeverityBadge
                    severity={r.severity}
                    label={r.severity === "block" ? t("editor.test.blocking") : undefined}
                  />
                </div>
                {!r.passed && r.reason ? (
                  <p className="text-xs break-words text-muted-foreground">
                    <span className="font-medium">{t("editor.test.reason")} :</span> {r.reason}
                  </p>
                ) : null}
                {!r.passed && r.output ? (
                  <p className="rounded-md bg-background p-2 font-mono text-xs break-words ring-1 ring-border">
                    {r.output}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}

// ── JSON ─────────────────────────────────────────────────────────────────────

export function JsonTab({ config, update, data }: TabProps) {
  const t = useTranslations("assistants");
  const head = useTabHead("json");
  const look = EDITOR_TAB_LOOK.json;
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
    <div className="space-y-4">
      <TabHead
        look={look}
        title={head.title}
        hint={head.hint}
        actions={
          <>
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
              <DownloadIcon /> {t("editor.json.download")}
            </Button>
            <Button size="sm" className="min-h-11 md:min-h-9" onClick={apply}>
              {t("editor.json.apply")}
            </Button>
          </>
        }
      />

      <Panel look={look} contentClassName="space-y-3">
        <Label htmlFor="f-json">{t("editor.json.title")}</Label>
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
      </Panel>
    </div>
  );
}
