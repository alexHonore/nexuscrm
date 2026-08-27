"use client";

import { AlertTriangle, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { EDITOR_TAB_LOOK } from "@/components/look";
import { DEFAULT_MODEL_FALLBACK, PROVIDER_IDS, type ProviderId } from "@/lib/assistants/schema";
// Les plafonds viennent du TRANSPORT lui-même : l'écran et le moteur ne
// peuvent pas diverger sur le moment où l'on cesse d'attendre.
import { DEFAULT_RETRY_POLICY } from "@/lib/llm/http";
import type { ModelDescriptor } from "@/lib/llm/types";
import { ModelPicker } from "../model-picker";
import { api } from "../api";
import { EmptyRow, Fields, Panel, TabHead, ToggleRow, WideField, useTabHead } from "./layout";
import { FieldLabel } from "./param-help";
import type { TabProps } from "./types";

/**
 * Onglet Modèle.
 *
 * Le support des outils est BADGÉ, pas filtré : un modèle sans outils reste
 * choisissable (il convient très bien à un assistant « qualifier seulement »),
 * mais l'avertissement dit exactement ce qui cassera si on lui demande de
 * réserver — sinon l'échec ressemble à un bogue de prompt.
 */
export function ModelTab({ config, update }: TabProps) {
  const t = useTranslations("assistants");
  const head = useTabHead("model");
  const look = EDITOR_TAB_LOOK.model;
  const [catalog, setCatalog] = useState<Record<string, ModelDescriptor[]>>({});
  const [loading, setLoading] = useState<string | null>(null);
  /**
   * Les fournisseurs dont la CLÉ existe — null tant qu'on ne le sait pas.
   *
   * Un repli chez un fournisseur sans clé n'est pas un repli : il est sauté à
   * l'exécution. Le dire ici évite de croire l'assistant protégé par trois
   * crans dont deux n'existent pas.
   */
  const [configured, setConfigured] = useState<ProviderId[] | null>(null);

  const load = useCallback(async (provider: string) => {
    setLoading(provider);
    try {
      const res = await api<{ models: ModelDescriptor[]; configured?: ProviderId[] }>(
        `/api/llm/models?provider=${provider}`,
      );
      setCatalog((c) => ({ ...c, [provider]: res.models }));
      if (res.configured) setConfigured(res.configured);
    } catch {
      setCatalog((c) => ({ ...c, [provider]: [] }));
    } finally {
      setLoading(null);
    }
  }, []);

  // Le catalogue du fournisseur PRINCIPAL se charge une fois, à l'ouverture de
  // l'onglet : l'entonnoir commence par la liste des laboratoires, et sans
  // catalogue il n'affiche rien du tout — on demandait un geste pour voir le
  // premier écran. La réponse est mise en cache six heures côté serveur, donc
  // c'est un appel par session d'édition, pas par affichage.
  const requested = useRef<Set<string>>(new Set());
  useEffect(() => {
    const provider = config.model.provider;
    if (requested.current.has(provider)) return;
    requested.current.add(provider);
    void load(provider);
  }, [config.model.provider, load]);

  const chosen = (catalog[config.model.provider] ?? []).find((m) => m.id === config.model.model);
  const needsTools = config.tools.some((tool) => tool === "get_slots" || tool === "book_meeting");

  return (
    <div className="space-y-4">
      <TabHead look={look} title={head.title} hint={head.hint} />

      <Panel
        look={look}
        title={t("editor.model.sectionMain")}
        description={t("editor.model.sectionMainHint")}
      >
        <Fields>
          <WideField>
            {/* Entonnoir : laboratoire, puis modèle, puis effort. Une liste
                plate de 350 identifiants demande de savoir d'avance ce qu'on
                cherche. */}
            <ModelPicker
              models={catalog[config.model.provider] ?? []}
              loading={loading === config.model.provider}
              value={config.model.model}
              effort={config.model.reasoningEffort}
              onReload={() => void load(config.model.provider)}
              onChange={({ model, effort }) =>
                update((d) => {
                  d.model.model = model;
                  d.model.reasoningEffort = effort;
                })
              }
            />
          </WideField>

          {chosen && !chosen.supportsTools && needsTools ? (
            <Alert className="md:col-span-2">
              <AlertTriangle />
              <AlertDescription>{t("editor.model.toolWarning")}</AlertDescription>
            </Alert>
          ) : null}

          <ProviderSelect
            path="model.provider"
            value={config.model.provider}
            onChange={(v) => {
              update((d) => void (d.model.provider = v));
              void load(v);
            }}
            configured={configured}
          />

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <FieldLabel path="model.temperature" htmlFor="f-temp" />
              <Input
                id="f-temp"
                type="number"
                inputMode="decimal"
                step="0.05"
                min={0}
                max={1}
                value={config.model.temperature}
                onChange={(e) => update((d) => void (d.model.temperature = Number(e.target.value)))}
                className="min-h-11 md:min-h-9"
              />
            </div>

            <div className="space-y-1.5">
              <FieldLabel path="model.maxTokens" htmlFor="f-maxtok" />
              <Input
                id="f-maxtok"
                type="number"
                inputMode="numeric"
                min={50}
                max={2000}
                value={config.model.maxTokens}
                onChange={(e) => update((d) => void (d.model.maxTokens = Number(e.target.value)))}
                className="min-h-11 md:min-h-9"
              />
            </div>
          </div>
        </Fields>
      </Panel>

      <Panel
        look={look}
        title={t("editor.model.sectionClassifier")}
        description={t("editor.model.sectionClassifierHint")}
      >
        <Fields>
          <ProviderSelect
            path="model.classifier.provider"
            value={config.model.classifier.provider}
            onChange={(v) => {
              update((d) => void (d.model.classifier.provider = v));
              void load(v);
            }}
            configured={configured}
          />
          <ModelSelect
            path="model.classifier.model"
            provider={config.model.classifier.provider}
            models={catalog[config.model.classifier.provider]}
            loading={loading === config.model.classifier.provider}
            value={config.model.classifier.model}
            onChange={(v) => update((d) => void (d.model.classifier.model = v))}
            onReload={() => void load(config.model.classifier.provider)}
          />
        </Fields>
      </Panel>

      {/* L'ordre des cartes suit l'ordre des ÉVÉNEMENTS : le modèle, puis la
          reprise sur place, puis le changement de modèle. */}
      <Panel
        look={look}
        title={t("editor.model.sectionRetry")}
        description={t("editor.model.sectionRetryHint")}
      >
        <Fields>
          <div className="space-y-1.5">
            <FieldLabel path="model.retry.attempts" htmlFor="f-retry-attempts" />
            <Input
              id="f-retry-attempts"
              type="number"
              inputMode="numeric"
              min={1}
              max={5}
              value={config.model.retry.attempts}
              onChange={(e) =>
                update((d) => void (d.model.retry.attempts = Number(e.target.value)))
              }
              className="min-h-11 md:min-h-9"
            />
          </div>
          <div className="space-y-1.5">
            <FieldLabel path="model.retry.delaySec" htmlFor="f-retry-delay" />
            <Input
              id="f-retry-delay"
              type="number"
              inputMode="decimal"
              step="0.1"
              min={0.2}
              max={10}
              value={config.model.retry.delaySec}
              onChange={(e) =>
                update((d) => void (d.model.retry.delaySec = Number(e.target.value)))
              }
              className="min-h-11 md:min-h-9"
            />
          </div>
          {/* Ce que le réglage donne VRAIMENT, en clair : « 3 » et « 0,8 » ne
              disent pas au bout de combien de temps on abandonne. */}
          <RetrySummary retry={config.model.retry} />
        </Fields>
      </Panel>

      {/* Les replis sont une CHAÎNE : le premier qui répond gagne. Trois crans
          parce qu'un incident ne s'arrête pas au premier remplaçant — un 429
          chez le routeur un jour où le direct est saturé laissait l'assistant
          muet. */}
      <Panel
        look={look}
        title={t("editor.model.sectionFallback")}
        description={t("editor.model.sectionFallbackHint")}
        actions={
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 md:min-h-9"
            onClick={() =>
              update((d) => {
                d.model.fallbacks.push({ ...DEFAULT_MODEL_FALLBACK });
              })
            }
            disabled={config.model.fallbacks.length >= 3}
          >
            <Plus /> {t("editor.model.addFallback")}
          </Button>
        }
        contentClassName="space-y-3"
      >
        {config.model.fallbacks.length === 0 ? (
          <EmptyRow>{t("editor.model.noFallback")}</EmptyRow>
        ) : (
          config.model.fallbacks.map((rung, i) => (
            <div key={i} className="space-y-3 rounded-lg border bg-muted/20 p-3 md:p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary" className="shrink-0">
                  {t("editor.model.fallbackAt", { n: i + 1 })}
                </Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto min-h-11 shrink-0 text-destructive md:min-h-9"
                  onClick={() => update((d) => void d.model.fallbacks.splice(i, 1))}
                >
                  <Trash2 /> {t("editor.model.removeFallback")}
                </Button>
              </div>
              <Fields>
                <ProviderSelect
                  path={`model.fallbacks[${i}].provider`}
                  value={rung.provider}
                  onChange={(v) => {
                    update((d) => void (d.model.fallbacks[i].provider = v));
                    void load(v);
                  }}
                  configured={configured}
                />
                {/* Le catalogue du fournisseur de repli aide à ne pas recopier
                    l'identifiant du routeur chez un direct — l'erreur qui fait
                    échouer le repli au moment précis où on en a besoin. */}
                <ModelSelect
                  path={`model.fallbacks[${i}].model`}
                  provider={rung.provider}
                  models={catalog[rung.provider]}
                  loading={loading === rung.provider}
                  value={rung.model}
                  onChange={(v) => update((d) => void (d.model.fallbacks[i].model = v))}
                  onReload={() => void load(rung.provider)}
                />
              </Fields>
            </div>
          ))
        )}
      </Panel>

      <Panel
        look={look}
        title={t("editor.model.routingTitle")}
        description={t("editor.model.routingNote")}
        contentClassName="grid gap-2 md:grid-cols-2"
      >
        <ToggleRow
          control={
            <Switch
              checked={config.model.routing.dataCollection === "deny"}
              aria-label="deny"
              onCheckedChange={(next) =>
                update((d) => void (d.model.routing.dataCollection = next ? "deny" : "allow"))
              }
            />
          }
        >
          <FieldLabel path="model.routing.dataCollection" />
        </ToggleRow>
        <ToggleRow
          control={
            <Switch
              checked={config.model.routing.zdr}
              aria-label="zdr"
              onCheckedChange={(next) => update((d) => void (d.model.routing.zdr = next))}
            />
          }
        >
          <FieldLabel path="model.routing.zdr" />
        </ToggleRow>
        <ToggleRow
          control={
            <Switch
              checked={config.model.routing.allowFallbacks}
              aria-label="allowFallbacks"
              onCheckedChange={(next) =>
                update((d) => void (d.model.routing.allowFallbacks = next))
              }
            />
          }
        >
          <FieldLabel path="model.routing.allowFallbacks" />
        </ToggleRow>
      </Panel>
    </div>
  );
}

/**
 * Ce que le réglage donne VRAIMENT, en clair.
 *
 * « 3 » et « 0,8 » ne disent pas au bout de combien de temps on abandonne. Le
 * calcul reprend celui du transport — plafonds compris — et non une jolie
 * formule : au-delà d'un certain réglage, les dernières tentatives n'ont tout
 * simplement PAS lieu, et un écran qui promettrait cinq tentatives mentirait.
 */
function RetrySummary({ retry }: { retry: { attempts: number; delaySec: number } }) {
  const t = useTranslations("assistants");
  const { retries, totalSec } = plannedRetries(retry);

  return (
    <p className="text-xs text-muted-foreground md:col-span-2">
      {retries === 0
        ? t("editor.model.retryNone")
        : t("editor.model.retrySummary", {
            retries,
            first: Math.min(retry.delaySec, DEFAULT_RETRY_POLICY.maxDelayMs / 1000),
            total: totalSec,
          })}
    </p>
  );
}

/** Les reprises qui auront LIEU, et l'attente cumulée — mêmes bornes que `http.ts`. */
function plannedRetries(retry: { attempts: number; delaySec: number }): {
  retries: number;
  totalSec: number;
} {
  const maxOne = DEFAULT_RETRY_POLICY.maxDelayMs / 1000;
  const maxTotal = DEFAULT_RETRY_POLICY.maxTotalDelayMs / 1000;
  let waited = 0;
  let retries = 0;
  for (let attempt = 1; attempt < retry.attempts; attempt += 1) {
    const delay = Math.min(maxOne, retry.delaySec * Math.pow(3, attempt - 1));
    if (waited + delay > maxTotal) break;
    waited += delay;
    retries += 1;
  }
  return { retries, totalSec: Math.round(waited * 10) / 10 };
}

function ProviderSelect({
  path,
  value,
  onChange,
  configured,
}: {
  path: string;
  value: ProviderId;
  onChange: (v: ProviderId) => void;
  /** Fournisseurs dont la clé existe ; null = on ne sait pas encore. */
  configured?: ProviderId[] | null;
}) {
  const t = useTranslations("assistants");
  const missing = (p: ProviderId) => configured !== null && configured !== undefined && !configured.includes(p);

  return (
    <div className="space-y-1.5">
      <FieldLabel path={path} />
      <Select
        items={PROVIDER_IDS.map((p) => ({ value: p, label: p }))}
        value={value}
        onValueChange={(v) => onChange(String(v) as ProviderId)}
      >
        <SelectTrigger className="min-h-11 w-full md:min-h-9">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PROVIDER_IDS.map((p) => (
            <SelectItem key={p} value={p}>
              <span className="flex w-full items-center justify-between gap-2">
                <span>{p}</span>
                {/* Le libellé DOUBLE l'information : une couleur seule ne dirait
                    pas qu'il manque une clé. */}
                {missing(p) ? (
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {t("editor.model.noKey")}
                  </Badge>
                ) : null}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {missing(value) ? (
        <p className="text-xs text-muted-foreground">{t("editor.model.noKeyHint", { provider: value })}</p>
      ) : null}
    </div>
  );
}

function ModelSelect({
  path,
  models,
  loading,
  value,
  onChange,
  onReload,
}: {
  path: string;
  provider: string;
  models: ModelDescriptor[] | undefined;
  loading: boolean;
  value: string;
  onChange: (v: string) => void;
  onReload: () => void;
}) {
  const t = useTranslations("assistants");
  const known = models?.some((m) => m.id === value) ?? false;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <FieldLabel path={path} htmlFor={`f-${path}`} />
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 text-xs"
          onClick={onReload}
          disabled={loading}
        >
          {loading ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
          {loading ? t("editor.model.loading") : t("editor.model.loadModels")}
        </Button>
      </div>

      {models && models.length > 0 ? (
        <Select
          items={models.map((m) => ({ value: m.id, label: m.label }))}
          value={known ? value : ""}
          onValueChange={(v) => onChange(String(v))}
        >
          <SelectTrigger className="min-h-11 w-full md:min-h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {models.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                <span className="flex w-full items-center justify-between gap-2">
                  <span className="truncate">{m.label}</span>
                  {m.supportsTools ? (
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {t("editor.model.supportsTools")}
                    </Badge>
                  ) : null}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}

      {/* Saisie libre TOUJOURS visible : le catalogue peut être indisponible,
          et un identifiant qui n'existe plus doit rester lisible et corrigeable
          plutôt que remplacé en silence. */}
      <Input
        id={`f-${path}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-11 font-mono text-xs md:min-h-9"
        aria-invalid={models && models.length > 0 && !known ? true : undefined}
      />
    </div>
  );
}
