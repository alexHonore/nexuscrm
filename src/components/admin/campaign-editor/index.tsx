"use client";

import { AlertTriangle, ArrowLeft, Download, Loader2, Pause, Play, Save } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CAMPAIGN_STATUS_LOOK, CAMPAIGN_TAB_LOOK, LookGlyph, lookTint } from "@/components/look";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ENROLL_REFUSALS } from "@/lib/campaigns/eligibility";
import type { CampaignConfig } from "@/lib/campaigns/schema";
import { ApiError, api } from "../api";
import { TriggerIcon } from "../trigger-look";
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

/** Motifs de refus connus — seuls ceux-là ont une étiquette traduite. */
const ENROLL_REFUSAL_KEYS = new Set<string>(ENROLL_REFUSALS);

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
      // Une référence disparue (assistant / numéro re-pointé ailleurs) a sa
      // phrase : le message brut « HTTP 409 » ne dit rien à corriger.
      const code = err instanceof ApiError ? err.code : "";
      toast.error(
        code === "assistant_not_found"
          ? t("editor.errors.assistantNotFound")
          : code === "sms_number_not_found"
            ? t("editor.errors.smsNumberNotFound")
            : err instanceof ApiError
              ? err.message
              : t("editor.errors.save"),
      );
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
      // Chaque refus d'activation a sa phrase : « impossible d'enregistrer »
      // ne dit pas à l'administrateur ce qu'il doit corriger.
      const code = err instanceof ApiError ? err.code : "";
      toast.error(
        code === "empty_ladder"
          ? t("editor.ladder.empty")
          : code === "assistant_inactive"
            ? t("editor.errors.assistantInactive")
            : code === "no_sender"
              ? t("editor.errors.noSender")
              : t("editor.errors.save"),
      );
    } finally {
      setBusy(null);
    }
  };

  const enroll = async () => {
    setBusy("enroll");
    try {
      const result = await api<{
        enrolled: number;
        considered: number;
        refusals?: Record<string, number>;
      }>(`/api/campaigns/${data.id}/enroll`, { method: "POST" });
      // Le détail PAR MOTIF : « 3 inscrits, 197 écartés » ne dit pas s'il
      // faut relever un plafond ou constater que l'audience est vide.
      const breakdown = Object.entries(result.refusals ?? {})
        .filter(([reason, n]) => n > 0 && ENROLL_REFUSAL_KEYS.has(reason))
        .map(([reason, n]) =>
          t("editor.enrollments.refusalCount", {
            label: t(`editor.enrollments.refusal.${reason}` as never),
            count: n,
          }),
        );
      toast.success(
        t("editor.enrollments.enrolled", {
          count: result.enrolled,
          skipped: result.considered - result.enrolled,
        }),
        breakdown.length > 0 ? { description: breakdown.join(" · ") } : undefined,
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
  // Un état inconnu (valeur écrite par un module futur) reste lisible plutôt
  // que de faire disparaître la pastille : il se présente en brouillon.
  const statusLook = CAMPAIGN_STATUS_LOOK[data.status] ?? CAMPAIGN_STATUS_LOOK.draft;
  const statusTint = lookTint(statusLook);

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
        {/* L'état est la seule chose à l'écran qui dise si des SMS partent en
            ce moment : il porte son pictogramme et sa couleur, comme dans la
            liste. Le libellé reste — la couleur ne porte jamais le sens seule,
            et elle vit sur le fond et le pictogramme, jamais sur le texte : un
            libellé ambre de douze pixels ne se lit pas. */}
        <Badge
          variant="outline"
          className="gap-1 pl-1.5 font-medium"
          style={{
            borderColor: statusTint.borderColor,
            backgroundColor: statusTint.backgroundColor,
          }}
        >
          <LookGlyph look={statusLook} />
          {t(`list.status.${data.status}` as never)}
        </Badge>
        {/* Le déclencheur porte la pastille de la création et de la liste :
            savoir ce qui fait partir la campagne ne devrait pas coûter un
            détour par un onglet. */}
        <Badge variant="outline" className="gap-1 pl-1 font-normal">
          <TriggerIcon kind={config.trigger.kind} size="sm" />
          {t(`list.trigger.${config.trigger.kind}`)}
        </Badge>
        <Button
          variant="outline"
          size="sm"
          className="min-h-11 md:min-h-9"
          render={<a href={`/api/campaigns/${data.id}/export`} download />}
        >
          <Download /> {t("editor.export")}
        </Button>
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
          {/* Chaque onglet porte son pictogramme : six libellés gris de la
              même taille se relisent un par un, une forme se reconnaît. La
              COULEUR, elle, groupe — ce que la campagne dit / la mécanique qui
              la déclenche / ce qui la vérifie une fois lancée. */}
          <TabsList className="w-max">
            {TAB_IDS.map((id) => (
              <TabsTrigger key={id} value={id} className="min-h-11 gap-1.5 md:min-h-8">
                <LookGlyph look={CAMPAIGN_TAB_LOOK[id]} className="size-3.5" />
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
