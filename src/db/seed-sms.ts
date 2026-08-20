 
/**
 * Seed du moteur SMS/IA — appelé depuis src/db/seed.ts (pnpm db:seed).
 * Idempotent : ne recrée pas ce qui existe déjà.
 */
import { eq } from "drizzle-orm";

export async function seedSms(): Promise<void> {
  const { db } = await import("@/db");
  const { assistants } = await import("@/db/schema-sms");
  const { seedGuardrailDefaults } = await import("@/lib/guardrails/store");
  const { assistantConfigSchema, ASSISTANT_TOOLS } = await import("@/lib/assistants/schema");

  // ── Garde-fous, corps du prompt L0 et paquets d'objections ──
  const seeded = await seedGuardrailDefaults();
  console.log(
    `✓ Garde-fous (core v1${seeded.core ? " créé" : " déjà présent"}, ` +
      `${seeded.rules} règle(s), ${seeded.fixtures} cas de test, ${seeded.packs} paquet(s) d'objections ajoutés)`,
  );

  // ── Assistants de départ (brouillons — la compilation/activation reste un
  // geste admin explicite, cf. le déclencheur assistants_activation_gate) ──
  const identity = {
    mode: "team" as const,
    orgName: "Groupe Nexus",
    brokerName: "Alex-Honoré",
  };

  const drafts = [
    {
      name: "Acheteur FB",
      description: "Leads acheteurs Facebook — qualifie puis propose une rencontre vidéo.",
      identity,
      goal: {
        primary: {
          type: "video_meeting" as const,
          durationMin: 30,
          appointmentType: "meet" as const,
          requiredFields: ["project_type", "timing"] as const,
          slotOfferCount: 2,
        },
        fallbacks: [
          {
            type: "phone_call" as const,
            durationMin: 15,
            requiredFields: ["project_type"] as const,
          },
          {
            type: "collect_email" as const,
            requiredFields: ["email"] as const,
          },
        ],
      },
      approach: { persistence: 3 },
      objectionPacks: ["buyer_fr"],
    },
    {
      name: "Vendeur FB",
      description: "Leads vendeurs Facebook — qualifie puis propose une rencontre en personne (évaluation).",
      identity,
      goal: {
        primary: {
          type: "in_person_meeting" as const,
          durationMin: 45,
          appointmentType: "inperson" as const,
          requiredFields: ["project_type", "timing"] as const,
        },
        fallbacks: [
          {
            type: "video_meeting" as const,
            durationMin: 30,
            appointmentType: "meet" as const,
          },
          {
            type: "phone_call" as const,
            durationMin: 15,
          },
        ],
      },
      approach: { persistence: 3 },
      objectionPacks: ["seller_fr"],
    },
    {
      name: "Long terme",
      description: "Leads long terme — objectif léger : un appel téléphonique.",
      identity,
      goal: {
        primary: {
          type: "phone_call" as const,
          durationMin: 10,
          requiredFields: ["project_type"] as const,
        },
        fallbacks: [],
      },
      approach: { persistence: 1 },
      objectionPacks: ["longterm_fr"],
    },
    {
      name: "Réactivation 90 j",
      description: "Réactivation après 90 jours — qualifie sans jamais réserver de rendez-vous.",
      identity,
      goal: {
        primary: {
          type: "qualify_only" as const,
          durationMin: null,
          requiredFields: [] as const,
        },
        fallbacks: [],
      },
      approach: { persistence: 1 },
      objectionPacks: ["reengage_fr"],
      // qualify_only ne doit jamais réserver : on retire book_meeting de la
      // boîte à outils plutôt que de compter sur le seul objectif pour l'empêcher.
      tools: ASSISTANT_TOOLS.filter((tool) => tool !== "book_meeting"),
    },
  ];

  let created = 0;
  for (const draft of drafts) {
    const existing = await db.query.assistants.findFirst({
      where: eq(assistants.name, draft.name),
    });
    if (existing) continue;

    // `model` n'a pas de défaut au niveau supérieur du schéma — {} suffit
    // pour que modelConfigSchema remplisse tous ses propres défauts.
    const config = assistantConfigSchema.parse({ model: {}, ...draft });
    await db.insert(assistants).values({
      name: config.name,
      description: config.description,
      status: "draft",
      language: config.language,
      identity: config.identity,
      goal: config.goal,
      approach: config.approach,
      knowledge: config.knowledge,
      objectionPacks: config.objectionPacks,
      tools: config.tools,
      model: config.model,
      promptMode: config.promptMode,
      systemPromptOverride: config.systemPromptOverride,
      layerOverrides: config.layerOverrides,
      turnInstructions: config.turnInstructions,
      includeRuntimeLayer: config.includeRuntimeLayer,
      requireSuitePass: config.requireSuitePass,
      needsRecompile: true,
      suitePassed: false,
    });
    created += 1;
  }
  console.log(`✓ Assistants (${created} créé(s), ${drafts.length - created} déjà présent(s))`);
}
