"use client";

import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
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
import { PROVIDER_IDS, type ProviderId } from "@/lib/assistants/schema";
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

  const load = useCallback(async (provider: string) => {
    setLoading(provider);
    try {
      const res = await api<{ models: ModelDescriptor[] }>(`/api/llm/models?provider=${provider}`);
      setCatalog((c) => ({ ...c, [provider]: res.models }));
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

      <Panel
        look={look}
        title={t("editor.model.sectionFallback")}
        description={t("editor.model.sectionFallbackHint")}
        actions={
          <Switch
            checked={config.model.fallback !== null}
            aria-label={t("editor.model.sectionFallback")}
            onCheckedChange={(next) =>
              update((d) => {
                d.model.fallback = next
                  ? { provider: "anthropic", model: "claude-sonnet-5" }
                  : null;
              })
            }
          />
        }
      >
        {config.model.fallback ? (
          <Fields>
            <ProviderSelect
              path="model.fallback.provider"
              value={config.model.fallback.provider}
              onChange={(v) =>
                update((d) => void (d.model.fallback && (d.model.fallback.provider = v)))
              }
            />
            <div className="space-y-1.5">
              <FieldLabel path="model.fallback.model" htmlFor="f-fallback-model" />
              <Input
                id="f-fallback-model"
                value={config.model.fallback.model}
                onChange={(e) =>
                  update((d) => void (d.model.fallback && (d.model.fallback.model = e.target.value)))
                }
                className="min-h-11 font-mono text-xs md:min-h-9"
              />
            </div>
          </Fields>
        ) : (
          <EmptyRow>{t("editor.model.noFallback")}</EmptyRow>
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

function ProviderSelect({
  path,
  value,
  onChange,
}: {
  path: string;
  value: ProviderId;
  onChange: (v: ProviderId) => void;
}) {
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
              {p}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
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
