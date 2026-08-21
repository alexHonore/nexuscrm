"use client";

import { AlertTriangle, ArrowLeft, Loader2, Pause, Play, Save } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { CampaignConfig } from "@/lib/campaigns/schema";
import { ApiError, api } from "../api";
import {
  AudienceTab,
  BasicsTab,
  EnrollmentsTab,
  LadderTab,
  TriggerTab,
  VariantsTab,
} from "./tabs";
import type { CampaignEditorData } from "./types";

const TAB_IDS = ["basics", "trigger", "audience", "ladder", "variants", "enrollments"] as const;

/**
 * Éditeur de campagne.
 *
 * Activer est refusé tant que l'échelle est vide — côté serveur aussi. Une
 * campagne active sans barreau inscrirait des gens sans jamais leur écrire, et
 * rien à l'écran ne dirait pourquoi il ne se passe rien.
 */
export function CampaignEditor({ data }: { data: CampaignEditorData }) {
  const t = useTranslations("campaigns");
  const router = useRouter();

  const [config, setConfig] = useState<CampaignConfig>(data.config);
  const [saved, setSaved] = useState<CampaignConfig>(data.config);
  const [busy, setBusy] = useState<null | "save" | "status" | "enroll">(null);

  const dirty = useMemo(() => JSON.stringify(config) !== JSON.stringify(saved), [config, saved]);

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const update = useCallback((mutate: (draft: CampaignConfig) => void) => {
    setConfig((current) => {
      const draft = structuredClone(current);
      mutate(draft);
      return draft;
    });
  }, []);

  const save = async () => {
    setBusy("save");
    try {
      await api(`/api/campaigns/${data.id}`, {
        method: "PATCH",
        body: JSON.stringify({ config }),
      });
      setSaved(config);
      toast.success(t("editor.saved"));
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("editor.errors.save"));
    } finally {
      setBusy(null);
    }
  };

  const setStatus = async (status: "active" | "paused") => {
    setBusy("status");
    try {
      await api(`/api/campaigns/${data.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      toast.success(status === "active" ? t("editor.activated") : t("editor.paused"));
      router.refresh();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      toast.error(code === "empty_ladder" ? t("editor.ladder.empty") : t("editor.errors.save"));
    } finally {
      setBusy(null);
    }
  };

  const enroll = async () => {
    setBusy("enroll");
    try {
      const result = await api<{ enrolled: number; considered: number }>(
        `/api/campaigns/${data.id}/enroll`,
        { method: "POST" },
      );
      toast.success(
        t("editor.enrollments.enrolled", {
          count: result.enrolled,
          skipped: result.considered - result.enrolled,
        }),
      );
      router.refresh();
    } catch {
      toast.error(t("editor.errors.enroll"));
    } finally {
      setBusy(null);
    }
  };

  const tabProps = { config, update, data };
  const emptyLadder = config.ladder.length === 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="min-h-11 md:min-h-9"
          render={<Link href="/admin/campaigns" />}
        >
          <ArrowLeft /> {t("editor.back")}
        </Button>
        <span className="flex-1" />
        {dirty ? <Badge variant="secondary">{t("editor.unsaved")}</Badge> : null}
        <Badge variant={data.status === "active" ? "default" : "secondary"}>
          {t(`list.status.${data.status}` as never)}
        </Badge>
        <Button
          onClick={() => void save()}
          disabled={busy !== null || !dirty}
          className="min-h-11 md:min-h-9"
        >
          {busy === "save" ? <Loader2 className="animate-spin" /> : <Save />}
          {busy === "save" ? t("editor.saving") : t("editor.save")}
        </Button>
        {data.status === "active" ? (
          <Button
            variant="outline"
            onClick={() => void setStatus("paused")}
            disabled={busy !== null}
            className="min-h-11 md:min-h-9"
          >
            <Pause /> {t("editor.pause")}
          </Button>
        ) : (
          <Button
            variant="outline"
            onClick={() => void setStatus("active")}
            disabled={busy !== null || dirty || emptyLadder}
            className="min-h-11 md:min-h-9"
          >
            <Play /> {t("editor.activate")}
          </Button>
        )}
      </div>

      {emptyLadder ? (
        <Alert>
          <AlertTriangle />
          <AlertDescription>{t("editor.ladder.empty")}</AlertDescription>
        </Alert>
      ) : null}

      <Tabs defaultValue="basics">
        <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
          <TabsList className="w-max">
            {TAB_IDS.map((id) => (
              <TabsTrigger key={id} value={id} className="min-h-11 md:min-h-8">
                {t(`editor.tabs.${id}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <TabsContent value="basics" className="pt-4">
          <BasicsTab {...tabProps} />
        </TabsContent>
        <TabsContent value="trigger" className="pt-4">
          <TriggerTab {...tabProps} />
        </TabsContent>
        <TabsContent value="audience" className="pt-4">
          <AudienceTab {...tabProps} />
        </TabsContent>
        <TabsContent value="ladder" className="pt-4">
          <LadderTab {...tabProps} />
        </TabsContent>
        <TabsContent value="variants" className="pt-4">
          <VariantsTab {...tabProps} />
        </TabsContent>
        <TabsContent value="enrollments" className="pt-4">
          <EnrollmentsTab
            {...tabProps}
            onEnroll={() => void enroll()}
            enrolling={busy === "enroll"}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
