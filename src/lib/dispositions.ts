import type { Disposition } from "@/db/schema";

/**
 * Les boutons colorés du popup d'après-appel.
 * `categoryKey` = catégorie (pipeline) appliquée automatiquement au client.
 */
export const DISPOSITION_CONFIG: Record<
  Disposition,
  { categoryKey: string | null; color: string; textColor?: string }
> = {
  voicemail: { categoryKey: "voicemail", color: "#3b82f6" }, // bleu
  booked: { categoryKey: "booked", color: "#16a34a" }, // vert
  callback: { categoryKey: "callback", color: "#f59e0b" }, // ambre
  not_interested: { categoryKey: "not_interested", color: "#ef4444" }, // rouge
  dncl: { categoryKey: "dncl", color: "#1e293b" }, // noir ardoise
  not_qualified: { categoryKey: "not_qualified", color: "#6b7280" }, // gris
  no_answer: { categoryKey: null, color: "#94a3b8" }, // gris clair — ne change pas la catégorie
};

export const DISPOSITION_ORDER: Disposition[] = [
  "booked",
  "callback",
  "voicemail",
  "no_answer",
  "not_interested",
  "not_qualified",
  "dncl",
];
