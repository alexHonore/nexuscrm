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
