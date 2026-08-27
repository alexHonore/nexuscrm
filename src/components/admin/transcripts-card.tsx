"use client";

import { AudioLines, Loader2, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isInteractiveModel } from "@/lib/llm/labs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "./api";

export type TranscriptsFormValues = {
  enabled: boolean;
  detail: "brief" | "standard" | "detailed" | "exhaustive";
  language: "fr" | "en";
  model: string;
  minSeconds: number;
  maxMinutes: number;
  keepTranscript: boolean;
};

type CatalogModel = {
  id: string;
  label: string;
  supportsAudio?: boolean;
  inputPerMTok?: number;
};

/**
 * Notes d'appel par IA : chaque appel enregistré est écouté par un modèle
 * audio, résumé, et la note est poussée en commentaire sur la fiche.
 *
 * Le choix de modèle est restreint aux modèles du catalogue OpenRouter qui
 * ACCEPTENT L'AUDIO — un modèle texte recevrait `input_audio` et l'appel
 * entier échouerait. Le champ libre reste l'échappatoire (nouveau modèle pas
 * encore dans le catalogue), signalée `aria-invalid` quand l'identifiant
 * tapé n'y figure pas.
 */
export function TranscriptsCard({
  initial,
  openrouterConfigured,
}: {
  initial: TranscriptsFormValues;
  openrouterConfigured: boolean;
}) {
  const t = useTranslations("admin");
  const [form, setForm] = useState(initial);
  const [pending, setPending] = useState(false);
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const loadedOnce = useRef(false);

  const loadModels = async () => {
    setLoadingModels(true);
    try {
      const res = await api<{ models: CatalogModel[] }>("/api/llm/models?provider=openrouter");
      // Audio en entrée ET interactif : les variantes :batch/:free du
      // catalogue répondent en différé — inutilisables pour un job qui attend.
      setModels(res.models.filter((m) => m.supportsAudio && isInteractiveModel(m.id)));
    } catch {
      toast.error(t("settings.transcripts.modelsLoadError"));
    } finally {
      setLoadingModels(false);
    }
  };

  useEffect(() => {
    if (!openrouterConfigured || loadedOnce.current) return;
    loadedOnce.current = true;
    void loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openrouterConfigured]);

  const knownModel = models.length === 0 || models.some((m) => m.id === form.model);

  const submit = async () => {
    setPending(true);
    try {
      await api("/api/admin/settings/transcripts", {
        method: "POST",
        body: JSON.stringify(form),
      });
      toast.success(t("saved"));
    } catch {
      toast.error(t("genericError"));
    } finally {
      setPending(false);
    }
  };

  return (
    <Card className="shadow-xs">
      <CardHeader className="border-b">
        <div className="flex items-center gap-3">
          <div
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary [&_svg]:size-4"
          >
            <AudioLines />
          </div>
          <div className="space-y-0.5">
            <CardTitle>{t("settings.transcripts.title")}</CardTitle>
            <CardDescription>{t("settings.transcripts.desc")}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!openrouterConfigured ? (
          <Alert>
            <AlertDescription>{t("settings.transcripts.envNote")}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex min-h-11 items-center gap-2 md:min-h-9">
          <Switch
            id="transcripts-enabled"
            checked={form.enabled}
            onCheckedChange={(next) => setForm({ ...form, enabled: next })}
          />
          <Label htmlFor="transcripts-enabled">{t("settings.transcripts.enabled")}</Label>
        </div>
        <p className="text-xs text-muted-foreground">{t("settings.transcripts.enabledDesc")}</p>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>{t("settings.transcripts.detail")}</Label>
            <Select
              items={[
                { value: "brief", label: t("settings.transcripts.detailBrief") },
                { value: "standard", label: t("settings.transcripts.detailStandard") },
                { value: "detailed", label: t("settings.transcripts.detailDetailed") },
                { value: "exhaustive", label: t("settings.transcripts.detailExhaustive") },
              ]}
              value={form.detail}
              onValueChange={(v) =>
                setForm({ ...form, detail: String(v) as TranscriptsFormValues["detail"] })
              }
            >
              <SelectTrigger className="min-h-11 w-full md:min-h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="brief">{t("settings.transcripts.detailBrief")}</SelectItem>
                <SelectItem value="standard">{t("settings.transcripts.detailStandard")}</SelectItem>
                <SelectItem value="detailed">{t("settings.transcripts.detailDetailed")}</SelectItem>
                <SelectItem value="exhaustive">
                  {t("settings.transcripts.detailExhaustive")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>{t("settings.transcripts.language")}</Label>
            <Select
              items={[
                { value: "fr", label: t("settings.transcripts.languageFr") },
                { value: "en", label: t("settings.transcripts.languageEn") },
              ]}
              value={form.language}
              onValueChange={(v) =>
                setForm({ ...form, language: String(v) as TranscriptsFormValues["language"] })
              }
            >
              <SelectTrigger className="min-h-11 w-full md:min-h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fr">{t("settings.transcripts.languageFr")}</SelectItem>
                <SelectItem value="en">{t("settings.transcripts.languageEn")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="transcripts-model">{t("settings.transcripts.model")}</Label>
            {openrouterConfigured ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="min-h-11 px-2 text-xs md:min-h-8"
                disabled={loadingModels}
                onClick={() => void loadModels()}
              >
                {loadingModels ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
                {t("settings.transcripts.modelsReload")}
              </Button>
            ) : null}
          </div>
          {models.length > 0 ? (
            <Select
              items={models.map((m) => ({ value: m.id, label: m.label }))}
              value={models.some((m) => m.id === form.model) ? form.model : ""}
              onValueChange={(v) => setForm({ ...form, model: String(v) })}
            >
              <SelectTrigger className="min-h-11 w-full md:min-h-9">
                <SelectValue placeholder={t("settings.transcripts.modelPick")} />
              </SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Input
            id="transcripts-model"
            className="min-h-11 font-mono text-xs md:min-h-8"
            value={form.model}
            aria-invalid={!knownModel || undefined}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">{t("settings.transcripts.modelHint")}</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="transcripts-min">{t("settings.transcripts.minSeconds")}</Label>
            <Input
              id="transcripts-min"
              type="number"
              className="min-h-11 md:min-h-8"
              min={5}
              max={600}
              value={form.minSeconds}
              onChange={(e) => setForm({ ...form, minSeconds: Number(e.target.value) || 0 })}
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.transcripts.minSecondsHint")}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="transcripts-max">{t("settings.transcripts.maxMinutes")}</Label>
            <Input
              id="transcripts-max"
              type="number"
              className="min-h-11 md:min-h-8"
              min={1}
              max={120}
              value={form.maxMinutes}
              onChange={(e) => setForm({ ...form, maxMinutes: Number(e.target.value) || 0 })}
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.transcripts.maxMinutesHint")}
            </p>
          </div>
        </div>

        <div className="flex min-h-11 items-center gap-2 md:min-h-9">
          <Switch
            id="transcripts-keep"
            checked={form.keepTranscript}
            onCheckedChange={(next) => setForm({ ...form, keepTranscript: next })}
          />
          <Label htmlFor="transcripts-keep">{t("settings.transcripts.keepTranscript")}</Label>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings.transcripts.keepTranscriptHint")}
        </p>
      </CardContent>
      <CardFooter>
        <Button onClick={() => void submit()} disabled={pending} className="min-h-11 md:min-h-8">
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          {t("save")}
        </Button>
      </CardFooter>
    </Card>
  );
}
