import { briefToConfig } from "@/lib/assistants/creator";
import { buildBundle, serializeBundle, type AssistantBundle } from "@/lib/assistants/portable";
import { briefToCampaignConfig } from "@/lib/campaigns/creator";
import {
  buildCampaignBundle,
  serializeCampaignBundle,
  type CampaignBundle,
} from "@/lib/campaigns/portable";

/**
 * Fichiers d'EXEMPLE pour la documentation — module PUR.
 *
 * Ils ne sont pas écrits à la main : ils sortent des mêmes fonctions que les
 * vrais exports (création assistée → config → bundle). Un exemple rédigé à la
 * main dériverait du schéma en quelques semaines et enseignerait un format
 * que l'import refuse ; celui-ci est relu par les mêmes schémas, en test.
 *
 * Les identifiants de liaison sont des valeurs-témoins reconnaissables : ils
 * montrent la règle (« un identifiant ne voyage jamais, seule sa liaison
 * voyage ») sans pointer vers quoi que ce soit de réel.
 */

export const SAMPLE_USER_ID = "00000000-0000-4000-8000-00000000c0a1";
export const SAMPLE_ASSISTANT_ID = "00000000-0000-4000-8000-00000000a551";
export const SAMPLE_NUMBER_ID = "00000000-0000-4000-8000-0000000005a5";

export function exampleAssistantBundle(now: Date): AssistantBundle {
  const config = briefToConfig(
    {
      name: "Acheteurs Facebook",
      description: "Leads acheteurs venus de Facebook — qualifier, puis proposer une rencontre vidéo.",
      audience: "buyer",
      goalType: "video_meeting",
      durationMin: 30,
      requiredFields: ["project_type", "timing"],
      persistence: 3,
      warmth: 3,
      questionBudget: 2,
      formality: "vous",
      claims: ["Nous couvrons Québec et Lévis."],
    },
    { orgName: "Groupe Nexus", brokerName: "Alex-Honoré", brokerUserId: SAMPLE_USER_ID },
  );
  return buildBundle({
    config,
    rules: [],
    fixtures: [],
    objectionPacks: [
      {
        id: "buyer_fr",
        label: "Objections acheteurs (fr)",
        language: "fr-CA",
        items: [],
        isBuiltin: true,
      },
    ],
    labels: {
      [SAMPLE_USER_ID]: { label: "Alex-Honoré", hint: "alex@groupenexus.example · admin" },
      buyer_fr: { label: "Objections acheteurs (fr)", hint: "paquet d'objections" },
    },
    sourceOrg: "Groupe Nexus",
    now,
  });
}

export function exampleCampaignBundle(now: Date): CampaignBundle {
  const config = briefToCampaignConfig({
    name: "Réactivation 180 j",
    description: "Acheteurs sans nouvelles depuis six mois — un message, deux relances.",
    trigger: "scheduled",
    notContactedForDays: 180,
    followUps: 2,
    daysBetween: 4,
    opener: "Bonjour, ici l'équipe de Groupe Nexus. Toujours un projet immobilier en tête?",
    abTest: true,
    dailyCap: 40,
  });
  config.assistantId = SAMPLE_ASSISTANT_ID;
  config.smsNumberId = SAMPLE_NUMBER_ID;
  config.audience.categoryIds = [3];
  config.audience.assignedToIds = [SAMPLE_USER_ID];
  return buildCampaignBundle({
    config,
    labels: {
      assistant: { [SAMPLE_ASSISTANT_ID]: { label: "Acheteurs Facebook", hint: "assistant" } },
      sms_number: { [SAMPLE_NUMBER_ID]: { label: "+15814810742", hint: "Ligne principale" } },
      category: { "3": { label: "À rappeler", hint: "catégorie" } },
      user: { [SAMPLE_USER_ID]: { label: "alex@groupenexus.example", hint: "Alex-Honoré" } },
    },
    sourceOrg: "Groupe Nexus",
    now,
  });
}

export function exampleAssistantFile(now: Date): string {
  return serializeBundle(exampleAssistantBundle(now));
}

export function exampleCampaignFile(now: Date): string {
  return serializeCampaignBundle(exampleCampaignBundle(now));
}
