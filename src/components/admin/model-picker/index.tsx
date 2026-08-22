"use client";

import {
  CheckIcon,
  ChevronLeftIcon,
  Loader2,
  RefreshCwIcon,
  SearchIcon,
  TriangleAlertIcon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LABS, isFloatingAlias, isInteractiveModel, labIdOf, labOf, type LabBrand } from "@/lib/llm/labs";
import type { ModelDescriptor } from "@/lib/llm/types";
import { cn } from "@/lib/utils";
import { LabMark } from "./lab-mark";

export type Effort = "none" | "low" | "medium" | "high";

/**
 * Choix du modèle en ENTONNOIR : laboratoire, puis modèle, puis effort.
 *
 * Une liste plate de 350 identifiants techniques demande de savoir d'avance ce
 * qu'on cherche. Le laboratoire est la seule chose qu'on reconnaît sans effort ;
 * une fois choisi, il reste une dizaine de modèles, comparables entre eux.
 *
 * L'étape « effort » n'apparaît que pour les modèles qui savent réfléchir :
 * l'offrir ailleurs ferait rejeter la requête entière par le fournisseur.
 */
export function ModelPicker({
  models,
  loading,
  value,
  effort,
  onChange,
  onReload,
}: {
  models: ModelDescriptor[];
  loading: boolean;
  value: string;
  effort: Effort;
  onChange: (next: { model: string; effort: Effort }) => void;
  onReload: () => void;
}) {
  const t = useTranslations("assistants");
  const [step, setStep] = useState<"lab" | "model" | "effort">("lab");
  const [lab, setLab] = useState<string>(() => labIdOf(value));
  const [query, setQuery] = useState("");

  // Les variantes différées et gratuites sont écartées : moins chères à
  // l'affichage, inutilisables pour un assistant qui répond à un client.
  const usable = useMemo(() => models.filter((m) => isInteractiveModel(m.id)), [models]);

  const byLab = useMemo(() => {
    const map = new Map<string, ModelDescriptor[]>();
    for (const model of usable) {
      const id = labIdOf(model.id);
      const list = map.get(id) ?? [];
      list.push(model);
      map.set(id, list);
    }
    return map;
  }, [usable]);

  const labs = useMemo(() => {
    const entries = [...byLab.entries()].map(([id, list]) => ({
      brand: LABS[id] ?? labOf(list[0].id),
      count: list.length,
    }));
    // Les maisons connues d'abord, puis par nombre de modèles.
    return entries.sort((a, b) => {
      const known = Number(Boolean(LABS[b.brand.id])) - Number(Boolean(LABS[a.brand.id]));
      return known !== 0 ? known : b.count - a.count;
    });
  }, [byLab]);

  const labModels = useMemo(() => {
    const list = byLab.get(lab) ?? [];
    const q = query.trim().toLowerCase();
    const filtered = q === "" ? list : list.filter((m) => m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
    // Les moins chers en premier : c'est le critère qu'on compare vraiment.
    return [...filtered].sort((a, b) => (a.inputPerMTok ?? 0) - (b.inputPerMTok ?? 0));
  }, [byLab, lab, query]);

  const current = usable.find((m) => m.id === value);
  const currentLab = labOf(value);

  return (
    <div className="space-y-3">
      {/* Sélection courante — toujours visible, même en cours de navigation. */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 p-3">
        <LabMark lab={currentLab} size={38} />
        <div className="min-w-0 flex-1">
          {/* À la création, rien n'est encore choisi : on le DIT. Une ligne
              vide ressemble à un catalogue en cours de chargement, et on
              attend au lieu de cliquer. */}
          <p className="truncate text-sm font-medium">
            {value === "" ? t("model.noneChosen") : (current?.label ?? value)}
          </p>
          {value === "" ? null : (
            <p className="truncate font-mono text-[11px] text-muted-foreground">{value}</p>
          )}
        </div>
        {effort !== "none" ? (
          <Badge variant="outline" className="gap-1">
            <ZapIcon className="size-3" /> {t(`model.effort.${effort}`)}
          </Badge>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1 text-xs"
          onClick={onReload}
          disabled={loading}
        >
          {loading ? <Loader2 className="size-3 animate-spin" /> : <RefreshCwIcon className="size-3" />}
          {t("model.refresh")}
        </Button>
      </div>

      {isFloatingAlias(value) ? (
        <p className="flex items-start gap-1.5 text-xs text-amber-600">
          <TriangleAlertIcon className="mt-px size-3.5 shrink-0" />
          {t("model.floatingHint")}
        </p>
      ) : null}

      <Steps step={step} />

      {step === "lab" ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {labs.map(({ brand, count }) => (
            <button
              key={brand.id}
              type="button"
              className={cn(
                "group flex items-start gap-3 rounded-xl border p-3 text-left transition-all",
                "hover:-translate-y-0.5 hover:border-current hover:shadow-sm",
                lab === brand.id && "border-current bg-muted/40",
              )}
              style={{ color: lab === brand.id ? brand.color : undefined }}
              onClick={() => {
                setLab(brand.id);
                setQuery("");
                setStep("model");
              }}
            >
              <LabMark lab={brand} className="group-hover:scale-105" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="font-medium text-foreground">{brand.name}</span>
                  <Badge variant="secondary" className="text-[10px]">
                    {count}
                  </Badge>
                </span>
                <LabNote noteKey={brand.noteKey} />
              </span>
            </button>
          ))}
          {labs.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("model.empty")}</p>
          ) : null}
        </div>
      ) : null}

      {step === "model" ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" className="min-h-11 md:min-h-8" onClick={() => setStep("lab")}>
              <ChevronLeftIcon /> {t("model.backToLabs")}
            </Button>
            <span className="relative flex-1">
              <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="min-h-11 pl-8 md:min-h-9"
                placeholder={t("model.search")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </span>
          </div>

          <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
            {labModels.map((model) => {
              const selected = model.id === value;
              return (
                <button
                  key={model.id}
                  type="button"
                  className={cn(
                    "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                    "hover:border-primary hover:bg-primary/5",
                    selected && "border-primary bg-primary/5",
                  )}
                  onClick={() => {
                    // Un modèle sans réflexion ne doit pas garder un effort
                    // hérité du précédent : le fournisseur rejetterait l'appel.
                    const nextEffort = model.supportsReasoning ? effort : "none";
                    onChange({ model: model.id, effort: nextEffort });
                    if (model.supportsReasoning) setStep("effort");
                  }}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium">{model.label}</span>
                      {selected ? <CheckIcon className="size-3.5 text-primary" /> : null}
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                      {model.id}
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-1.5">
                      {model.supportsTools ? (
                        <Badge variant="outline" className="gap-1 text-[10px]">
                          <WrenchIcon className="size-2.5" /> {t("model.tools")}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] text-destructive">
                          {t("model.noTools")}
                        </Badge>
                      )}
                      {model.supportsReasoning ? (
                        <Badge variant="outline" className="gap-1 text-[10px]">
                          <ZapIcon className="size-2.5" /> {t("model.reasons")}
                        </Badge>
                      ) : null}
                      {/* Signalé, pas masqué : derrière un alias le modèle
                          change sans prévenir, et un assistant réglé sur
                          celui d'hier répond autrement demain. */}
                      {isFloatingAlias(model.id) ? (
                        <Badge variant="outline" className="gap-1 text-[10px] text-amber-600">
                          <TriangleAlertIcon className="size-2.5" /> {t("model.floating")}
                        </Badge>
                      ) : null}
                      {model.inputPerMTok !== undefined ? (
                        <span className="text-[11px] text-muted-foreground">
                          {t("model.price", { price: model.inputPerMTok.toFixed(2) })}
                        </span>
                      ) : null}
                    </span>
                  </span>
                </button>
              );
            })}
            {labModels.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">{t("model.noMatch")}</p>
            ) : null}
          </div>
        </div>
      ) : null}

      {step === "effort" ? (
        <div className="space-y-2">
          <Button variant="ghost" size="sm" className="min-h-11 md:min-h-8" onClick={() => setStep("model")}>
            <ChevronLeftIcon /> {t("model.backToModels")}
          </Button>
          <p className="text-sm text-muted-foreground">{t("model.effortHint")}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {(["none", "low", "medium", "high"] as const).map((level) => (
              <button
                key={level}
                type="button"
                className={cn(
                  "rounded-lg border p-3 text-left transition-colors hover:border-primary hover:bg-primary/5",
                  effort === level && "border-primary bg-primary/5",
                )}
                onClick={() => onChange({ model: value, effort: level })}
              >
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <ZapIcon
                    className={cn("size-3.5", level === "none" && "opacity-30")}
                  />
                  {t(`model.effort.${level}`)}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t(`model.effortDesc.${level}`)}
                </p>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Note d'un laboratoire — « ce qu'il vaut pour notre usage », traduite.
 *
 * La clé vient du registre (`labs.ts`), le texte des messages : une note
 * absente dans la locale courante ne s'affiche pas, plutôt que de laisser
 * fuir une clé brute ou une phrase dans la mauvaise langue.
 */
function LabNote({ noteKey }: { noteKey: string }) {
  const t = useTranslations("assistants");
  const key = `model.labNote.${noteKey}`;
  if (!t.has(key)) return null;
  return <span className="mt-0.5 block text-xs text-muted-foreground">{t(key)}</span>;
}

/** Fil d'Ariane des trois étapes. */
function Steps({ step }: { step: "lab" | "model" | "effort" }) {
  const t = useTranslations("assistants");
  const order = ["lab", "model", "effort"] as const;
  const index = order.indexOf(step);
  return (
    <ol className="flex items-center gap-1.5 text-xs">
      {order.map((s, i) => (
        <li key={s} className="flex items-center gap-1.5">
          <span
            className={cn(
              "flex size-5 items-center justify-center rounded-full border text-[10px] font-medium transition-colors",
              i < index && "border-primary bg-primary text-primary-foreground",
              i === index && "border-primary text-primary",
              i > index && "text-muted-foreground",
            )}
          >
            {i < index ? <CheckIcon className="size-3" /> : i + 1}
          </span>
          <span className={cn(i === index ? "font-medium" : "text-muted-foreground")}>
            {t(`model.step.${s}`)}
          </span>
          {i < order.length - 1 ? <span className="text-muted-foreground">›</span> : null}
        </li>
      ))}
    </ol>
  );
}

export { LabMark };
export type { LabBrand };
