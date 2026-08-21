"use client";

import { AlertTriangle, ArrowLeft, CheckCircle2, Loader2, Play, Save, Zap } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { AssistantConfig } from "@/lib/assistants/schema";
import { ApiError, api } from "../api";
import { ParamDocsProvider, type ParamDocView } from "./param-help";
import {
  ApproachTab,
  GoalTab,
  IdentityTab,
  KnowledgeTab,
  ObjectionsTab,
  ToolsTab,
} from "./tabs-basic";
import { GuardrailsTab, JsonTab, PromptTab, TestTab } from "./tabs-advanced";
import { ModelTab } from "./tabs-model";
import { SandboxTab } from "./tab-sandbox";
import type { AssistantEditorData } from "./types";

const TAB_IDS = [
  "identity",
  "goal",
  "approach",
  "knowledge",
  "objections",
  "tools",
  "guardrails",
  "model",
  "prompt",
  // Le bac à sable est placé AVANT la suite : on essaie d'abord, on teste
  // ensuite. Régler un ton en lisant des fixtures rouges est le chemin long.
  "sandbox",
  "test",
  "json",
] as const;

type ChangeSummary = { changed: string[]; immediate: string[]; pending: string[] };

/**
 * Éditeur d'assistant.
 *
 * L'écran distingue trois états qui se confondent facilement : ce qui est
 * enregistré, ce qui est compilé, et ce qui a été testé. Un assistant peut être
 * enregistré sans être compilé (le prompt ment), compilé sans être vert (il se
 * comporte mal), et vert sans être actif. La barre du haut les montre tous les
 * trois ; le bandeau d'avertissement explique lequel manque.
 */
export function AssistantEditor({
  data,
  docs,
}: {
  data: AssistantEditorData;
  docs: Record<string, ParamDocView>;
}) {
  const t = useTranslations("assistants");
  const router = useRouter();

  const [config, setConfig] = useState<AssistantConfig>(data.config);
  const [saved, setSaved] = useState<AssistantConfig>(data.config);
  const [busy, setBusy] = useState<null | "save" | "compile" | "suite" | "activate">(null);
  const [lastChanges, setLastChanges] = useState<ChangeSummary | null>(null);

  const dirty = useMemo(() => JSON.stringify(config) !== JSON.stringify(saved), [config, saved]);

  // Un onglet fermé avec des modifications non enregistrées les perd. Le
  // navigateur n'affiche notre texte que si l'événement est annulé.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const update = useCallback((mutate: (draft: AssistantConfig) => void) => {
    setConfig((current) => {
      const draft = structuredClone(current);
      mutate(draft);
      return draft;
    });
  }, []);

  const save = async () => {
    setBusy("save");
    try {
      const res = await api<{ saved: boolean; changes: ChangeSummary }>(
        `/api/assistants/${data.id}`,
        { method: "PATCH", body: JSON.stringify(config) },
      );
      setSaved(config);
      setLastChanges(res.saved ? res.changes : null);
      toast.success(res.saved ? t("editor.saved") : t("editor.noChanges"));
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("editor.errors.save"));
    } finally {
      setBusy(null);
    }
  };

  const compile = async () => {
    setBusy("compile");
    try {
      const res = await api<{ version: number }>(`/api/assistants/${data.id}/compile`, {
        method: "POST",
      });
      toast.success(t("editor.compiled", { version: res.version }));
      router.refresh();
    } catch {
      toast.error(t("editor.errors.compile"));
    } finally {
      setBusy(null);
    }
  };

  const runSuite = async () => {
    setBusy("suite");
    try {
      await api(`/api/assistants/${data.id}/suite`, { method: "POST" });
      router.refresh();
    } catch {
      toast.error(t("editor.errors.suite"));
    } finally {
      setBusy(null);
    }
  };

  const activate = async () => {
    setBusy("activate");
    try {
      await api(`/api/assistants/${data.id}/activate`, { method: "POST" });
      toast.success(t("editor.activated"));
      router.refresh();
    } catch (err) {
      // La porte renvoie POURQUOI elle refuse : le dire vaut mieux qu'un
      // « activation refusée » qui laisse chercher.
      const code = err instanceof ApiError ? String(err.data.reason ?? "") : "";
      toast.error(
        code === "stale_compile"
          ? t("editor.errors.staleCompile")
          : code === "suite_not_passed"
            ? t("editor.errors.suiteNotPassed")
            : t("editor.errors.activate"),
      );
    } finally {
      setBusy(null);
    }
  };

  const tabProps = { config, update, data };

  return (
    <ParamDocsProvider docs={docs}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="min-h-11 md:min-h-9"
            render={<Link href="/admin/assistants" />}
          >
            <ArrowLeft /> {t("editor.back")}
          </Button>
          <span className="flex-1" />
          {dirty ? <Badge variant="secondary">{t("editor.unsaved")}</Badge> : null}
          <Button onClick={() => void save()} disabled={busy !== null || !dirty} className="min-h-11 md:min-h-9">
            {busy === "save" ? <Loader2 className="animate-spin" /> : <Save />}
            {busy === "save" ? t("editor.saving") : t("editor.save")}
          </Button>
          <Button
            variant="outline"
            onClick={() => void compile()}
            disabled={busy !== null || dirty}
            className="min-h-11 md:min-h-9"
          >
            {busy === "compile" ? <Loader2 className="animate-spin" /> : <Play />}
            {busy === "compile" ? t("editor.compiling") : t("editor.compile")}
          </Button>
          {data.status !== "active" ? (
            <Button
              variant="outline"
              onClick={() => void activate()}
              disabled={busy !== null || dirty || data.needsRecompile}
              className="min-h-11 md:min-h-9"
            >
              {busy === "activate" ? <Loader2 className="animate-spin" /> : <Zap />}
              {t("editor.activate")}
            </Button>
          ) : null}
        </div>

        {data.needsRecompile && data.compiledPrompt ? (
          <Alert>
            <AlertTriangle />
            <AlertTitle>{t("editor.stale.title")}</AlertTitle>
            <AlertDescription>
              {data.status === "active" ? t("editor.stale.bodyActive") : t("editor.stale.body")}
            </AlertDescription>
          </Alert>
        ) : null}

        {lastChanges && lastChanges.changed.length > 0 ? (
          <Alert>
            <CheckCircle2 />
            <AlertDescription>
              <span className="block">
                {t("editor.effects.immediate", { count: lastChanges.immediate.length })}
              </span>
              {lastChanges.pending.length > 0 ? (
                <span className="block">
                  {t("editor.effects.pending", { count: lastChanges.pending.length })}
                </span>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        <Tabs defaultValue="identity">
          {/* Onze onglets : la liste défile horizontalement sur téléphone
              plutôt que de se replier en menu, pour rester repérable. */}
          <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
            <TabsList className="w-max">
              {TAB_IDS.map((id) => (
                <TabsTrigger key={id} value={id} className="min-h-11 md:min-h-8">
                  {t(`editor.tabs.${id}`)}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <TabsContent value="identity" className="pt-4">
            <IdentityTab {...tabProps} />
          </TabsContent>
          <TabsContent value="goal" className="pt-4">
            <GoalTab {...tabProps} />
          </TabsContent>
          <TabsContent value="approach" className="pt-4">
            <ApproachTab {...tabProps} />
          </TabsContent>
          <TabsContent value="knowledge" className="pt-4">
            <KnowledgeTab {...tabProps} />
          </TabsContent>
          <TabsContent value="objections" className="pt-4">
            <ObjectionsTab {...tabProps} />
          </TabsContent>
          <TabsContent value="tools" className="pt-4">
            <ToolsTab {...tabProps} />
          </TabsContent>
          <TabsContent value="guardrails" className="pt-4">
            <GuardrailsTab {...tabProps} />
          </TabsContent>
          <TabsContent value="model" className="pt-4">
            <ModelTab {...tabProps} />
          </TabsContent>
          <TabsContent value="prompt" className="pt-4">
            <PromptTab {...tabProps} />
          </TabsContent>
          <TabsContent value="sandbox" className="pt-4">
            <SandboxTab {...tabProps} />
          </TabsContent>
          <TabsContent value="test" className="pt-4">
            <TestTab {...tabProps} onRunSuite={() => void runSuite()} running={busy === "suite"} />
          </TabsContent>
          <TabsContent value="json" className="pt-4">
            {/* Remonté à chaque changement de configuration : l'onglet doit
                montrer ce que les autres onglets viennent d'écrire. */}
            <JsonTab key={JSON.stringify(config)} {...tabProps} />
          </TabsContent>
        </Tabs>
      </div>
    </ParamDocsProvider>
  );
}
