import type { CampaignConfig } from "@/lib/campaigns/schema";

export type CampaignEditorData = {
  id: string;
  config: CampaignConfig;
  status: string;
  assistants: { id: string; name: string; status: string }[];
  numbers: { id: string; e164: string; label: string | null }[];
  categories: { id: number; name: string }[];
  sources: { id: number; name: string }[];
  users: { id: string; name: string }[];
  enrollments: EnrollmentRow[];
  /** Résultats par variante — inscrits, réponses, arrêts. */
  variantStats: { variant: string; enrolled: number; replied: number; stopped: number }[];
  /**
   * Inscriptions TERMINÉES que l'échelle actuelle dépasse — celles qui ont fini
   * avant que les derniers barreaux n'existent. Compté sur toute la campagne,
   * pas sur les cent lignes affichées.
   */
  reopenableCount: number;
};

export type EnrollmentRow = {
  id: string;
  clientId: string;
  clientName: string;
  variant: string;
  status: string;
  step: number;
  nextTouchAt: string | null;
  endedAt: string | null;
  endReason: string | null;
};

export type CampaignTabProps = {
  config: CampaignConfig;
  update: (mutate: (draft: CampaignConfig) => void) => void;
  data: CampaignEditorData;
};
