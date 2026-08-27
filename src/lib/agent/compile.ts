/**
 * Compilateur de prompt en couches (§10) — assemble L0-L6 en un prompt
 * système unique et déterministe à partir d'une `AssistantConfig` (voir
 * lib/assistants/schema.ts), du corps de noyau versionné (L0), des paquets
 * d'objections sélectionnés (L5) et des règles de garde-fous (L6).
 *
 * Pur et déterministe : aucune horloge, aucun aléa, aucune I/O — mêmes
 * entrées, sortie strictement identique (octet pour octet). C'est ce qui
 * permet de figer un prompt compilé dans assistant_versions.snapshot et de le
 * reconstituer exactement plus tard.
 *
 * En mode `raw`, rien n'est composé : `systemPromptOverride` EST le prompt.
 * C'est aussi la voie d'« éjection » — un prompt composé peut être copié tel
 * quel dans `systemPromptOverride` d'une config raw et recompiler à
 * l'identique (aucune perte d'information).
 */
import {
  LAYER_IDS,
  type AssistantConfig,
  type AssistantLanguage,
  type GoalStep,
  type IdentityConfig,
  type GoalType,
  type LayerId,
  type QualificationField,
} from "@/lib/assistants/schema";

// ── Entrées ──────────────────────────────────────────────────────────────────

/** Corps L0 versionné (table `prompt_cores`). */
export interface CoreDoc {
  version: number;
  body: string;
}

/** Un item d'objection (table `objection_packs.items`). */
export interface ObjectionItem {
  key: string;
  triggerHint: string;
  acknowledge: string;
  reframe: string;
  ask: string;
}

/** Un paquet d'objections sélectionnable via `config.objectionPacks`. */
export interface ObjectionPack {
  id: string;
  label: string;
  items: ObjectionItem[];
}

/**
 * Une règle de classement, DÉJÀ résolue par l'appelant.
 *
 * Le module reste pur : il ne lit ni les réglages ni la table des catégories.
 * L'appelant a donc traduit chaque règle en trois chaînes — la condition, la
 * valeur de catégorie que l'outil attend, et le nom lisible que le modèle
 * verra. Sans le nom, le prompt dirait « range dans cat:14 », ce qu'aucun
 * modèle ne peut juger.
 */
export interface ClassificationRuleInput {
  when: string;
  categoryValue: string;
  categoryLabel: string;
}

/** Une règle de garde-fou (table `guardrail_rules`) — core ou assistant. */
export interface GuardRuleInput {
  key: string;
  label: string;
  promptText: string | null;
  severity: string;
  enabled: boolean;
  /** "core" = commune à tous les assistants ; toute autre valeur = fork assistant. */
  scope: string;
  /** Clé d'une règle core que cette règle (de portée assistant) remplace. */
  overridesKey: string | null;
  orderIndex: number;
}

// ── Sorties ──────────────────────────────────────────────────────────────────

export type LayerSource = "generated" | "replaced" | "appended";

export interface CompiledLayer {
  id: LayerId;
  source: LayerSource;
  text: string;
}

export interface CompiledPrompt {
  prompt: string;
  coreVersion: number;
  layers: CompiledLayer[];
}

// ── L0 — substitution des jetons de noyau ───────────────────────────────────

function substituteCoreTokens(body: string, orgName: string, brokerName: string): string {
  return body.split("{{org}}").join(orgName).split("{{broker}}").join(brokerName);
}

// ── L1 — IDENTITÉ ────────────────────────────────────────────────────────────

function buildIdentityLayer(config: AssistantConfig): string {
  const { identity } = config;
  const lines: string[] = ["# IDENTITÉ"];

  if (identity.mode === "team") {
    lines.push(`L'assistant écrit au nom de l'équipe de ${identity.orgName}.`);
  } else {
    lines.push(`L'assistant écrit au nom de ${identity.brokerName}, de ${identity.orgName}.`);
  }

  lines.push(`Le rendez-vous ou l'appel a lieu avec ${identity.brokerName}, le courtier.`);

  if (identity.aiDisclosure === "upfront") {
    lines.push(
      "Le PREMIER message de la conversation doit indiquer explicitement qu'il s'agit d'un assistant automatisé.",
    );
  }

  const signature = signatureFor(identity);
  if (signature !== null) {
    lines.push(`Termine tes messages par cette signature exacte : ${signature}`);
  }

  return lines.join("\n");
}

/**
 * La signature effective, ou null quand l'assistant ne signe pas.
 *
 * « custom » sans texte revient à ne pas signer : mieux vaut aucune signature
 * qu'un tiret suivi de rien à la fin de chaque message.
 */
export function signatureFor(identity: IdentityConfig): string | null {
  switch (identity.signature) {
    case "none":
      return null;
    case "first_name": {
      const firstName = identity.brokerName.split(/\s+/)[0] ?? identity.brokerName;
      return `— ${firstName}`;
    }
    case "full_name":
      return `— ${identity.brokerName}`;
    case "org":
      return `— ${identity.orgName}`;
    case "custom": {
      const text = identity.signatureText?.trim() ?? "";
      return text === "" ? null : text;
    }
    default:
      return null;
  }
}

// ── L2 — OBJECTIF ────────────────────────────────────────────────────────────

const FIELD_LABELS: Partial<Record<string, string>> & Record<QualificationField, string> = {
  project_type: "type de projet",
  timing: "échéancier",
  budget: "budget",
  sector: "secteur",
  financing: "financement",
  current_situation: "situation actuelle",
  email: "adresse courriel",
  preferred_time: "moment préféré",
};

const GOAL_TYPE_DESCRIPTIONS: Record<GoalType, (step: GoalStep) => string> = {
  video_meeting: (step) => `une rencontre vidéo de ${step.durationMin ?? "?"} minutes`,
  in_person_meeting: (step) => `une rencontre en personne de ${step.durationMin ?? "?"} minutes`,
  phone_call: (step) => `un appel de ${step.durationMin ?? "?"} minutes`,
  collect_email: () => "obtenir la meilleure adresse courriel",
  collect_callback_time: () => "convenir d'un moment de rappel",
  qualify_only: () => "qualifier la personne sans JAMAIS proposer de rencontre",
  handoff: () => "amener rapidement la personne vers le courtier",
};

function describeGoalStep(step: GoalStep): string {
  return GOAL_TYPE_DESCRIPTIONS[step.type](step);
}

/**
 * Le classement — dans L2 parce que c'est une conclusion sur l'objectif.
 *
 * Ranger quelqu'un dans « Long terme » ou « Non qualifié », c'est décider que
 * l'objectif courant ne s'applique pas à cette personne-là. Cela n'a sa place
 * ni dans les faits (L4), ni dans le ton (L3), ni dans les garde-fous (L6) qui
 * interdisent : ici on demande une ACTION, sous condition.
 *
 * Les règles sont numérotées et la liste est FERMÉE — l'outil refuse toute
 * catégorie qui n'y figure pas, et le dire au modèle évite qu'il essaie.
 */
function buildClassificationLines(rules: ClassificationRuleInput[]): string[] {
  if (rules.length === 0) return [];
  const lines = [
    "",
    "## CLASSEMENT",
    "Dès que la conversation te permet de trancher l'un des cas ci-dessous, appelle `set_category` avec la clé indiquée, sans attendre la fin de l'échange.",
  ];
  rules.forEach((rule, i) => {
    lines.push(`${i + 1}. Si ${rule.when} → « ${rule.categoryLabel} » (clé : ${rule.categoryValue})`);
  });
  lines.push(
    "Tu ne ranges JAMAIS une fiche dans une catégorie absente de cette liste, et tu ne classes pas sur une supposition : il te faut une phrase de la personne qui le dise.",
  );
  return lines;
}

function buildGoalLayer(config: AssistantConfig, classification: ClassificationRuleInput[]): string {
  const { primary, fallbacks } = config.goal;
  const lines: string[] = ["# OBJECTIF"];

  lines.push(`Objectif actuel : ${describeGoalStep(primary)}.`);
  // La consigne du cran passe juste après ce que le cran cherche : c'est le
  // COMMENT de ce QUOI, et les séparer les rendait tous deux abstraits.
  if (primary.instruction) lines.push(`Pour ce cran : ${primary.instruction}`);

  if (primary.requiredFields.length > 0) {
    lines.push("Informations requises avant de réserver :");
    // Une exigence libre (« nombre de chambres ») n'a pas de libellé au
    // catalogue : on la rend TELLE QUELLE. C'est la personne qui l'a écrite
    // qui sait ce qu'elle veut dire — la traduire serait la déformer.
    for (const field of primary.requiredFields) lines.push(`- ${FIELD_LABELS[field] ?? field}`);
  } else {
    lines.push("Informations requises avant de réserver : aucune.");
  }

  if (fallbacks.length > 0) {
    const chain = fallbacks
      .map((step, index) => {
        const rung = `${index + 1}) ${describeGoalStep(step)}`;
        // La consigne suit SON cran, entre parenthèses : posée en bloc à la
        // fin, on ne savait plus à quel repli elle s'appliquait.
        return step.instruction ? `${rung} — ${step.instruction}` : rung;
      })
      .join(" ");
    lines.push(`En cas de refus mou, replis dans l'ordre : ${chain}`);
  } else {
    lines.push(
      "En cas de refus mou : aucun repli configuré — termine poliment plutôt que d'insister.",
    );
  }

  lines.push(...buildClassificationLines(classification));

  lines.push("Le palier (rung) actuellement actif est fourni dans le bloc d'exécution (runtime).");

  return lines.join("\n");
}

// ── L3 — APPROCHE ────────────────────────────────────────────────────────────

const PERSISTENCE_PHRASES: Record<number, string> = {
  1: "ne redemande JAMAIS après un refus mou",
  2: "une seule relance douce",
  3: "jusqu'à deux relances espacées",
  4: "relance avec constance",
  5: "insiste (sans jamais passer outre un refus clair)",
};

/** Échelle 1-5 partagée par la chaleur et la proactivité. */
function styleLevelPhrase(level: number): string {
  if (level <= 2) return "sec et bref";
  if (level === 3) return "neutre";
  return "chaleureux et proactif";
}

/** Comment on NOMME une langue au modèle — un code ISO ne suffit pas. */
const LANGUAGE_NAMES: Record<AssistantLanguage, string> = {
  "fr-CA": "français québécois",
  "en-CA": "anglais canadien",
};

/**
 * La langue de rédaction, dite explicitement.
 *
 * Elle était enregistrée sur la fiche et n'entrait dans AUCUNE couche : le
 * modèle écrivait en français parce que tout le reste du prompt l'était, pas
 * parce qu'on le lui demandait. Un assistant réglé sur l'anglais écrivait donc
 * en français — le réglage mentait.
 *
 * La seconde langue est une autorisation de BASCULER, jamais d'ouvrir : le
 * premier message suit la langue principale, et l'assistant ne change que si
 * la personne écrit dans l'autre.
 */
function buildLanguageLines(config: AssistantConfig): string[] {
  const primary = LANGUAGE_NAMES[config.language];
  const lines = [`Tu écris en ${primary}.`];
  if (config.secondaryLanguage === null) {
    lines.push(
      `Même si la personne écrit dans une autre langue, tu continues en ${primary}.`,
    );
    return lines;
  }
  const secondary = LANGUAGE_NAMES[config.secondaryLanguage];
  lines.push(
    `Si la personne écrit en ${secondary}, tu lui réponds en ${secondary} et tu continues dans cette langue tant qu'elle s'y tient.`,
    `Ton PREMIER message reste en ${primary} : tu ne devines pas la langue de quelqu'un qui n'a encore rien écrit.`,
  );
  return lines;
}

function buildApproachLayer(config: AssistantConfig): string {
  const { approach } = config;
  const lines: string[] = ["# APPROCHE"];

  lines.push(...buildLanguageLines(config));
  lines.push(
    approach.formality === "vous"
      ? "Vouvoie la personne (« vous »)."
      : "Tutoie la personne (« tu »).",
  );
  lines.push(`Persistance : ${PERSISTENCE_PHRASES[approach.persistence]}.`);
  if (approach.qualificationMode === "strict") {
    // Un plafond ABSOLU, pas « avant la première proposition » : l'ancienne
    // formulation laissait l'assistant relancer un interrogatoire après un
    // premier refus, comme si le compteur repartait de zéro.
    //
    // Ce texte est reproduit à l'IDENTIQUE, à la même place du tableau : le
    // prompt compilé est mis en cache sur la fiche, sans empreinte ni version
    // de compilateur. Le moindre octet qui bouge ici et toute la flotte sert
    // un prompt qui ne correspond plus à sa configuration, en silence.
    lines.push(
      `Tu disposes de ${approach.questionBudget} questions de qualification EN TOUT, pour toute la conversation. ` +
        `Sers-t'en pour obtenir les informations requises ; une fois ce nombre atteint, tu ne poses plus de question de qualification et tu proposes avec ce que tu as.`,
    );
  } else {
    // Le plafond ne passe JAMAIS sous la cible : deux nombres qui se
    // contredisent dans la même consigne la font écarter en entier, cible
    // comprise. Le schéma ne croise pas les deux champs (il rendrait des
    // fiches existantes illisibles) — on relève ici.
    const ceiling = Math.max(approach.questionBudget, approach.questionCeiling);
    lines.push(
      // La cible arrive APRÈS le critère : ouvrir sur un nombre en fait un
      // quota à dépenser, ce que le mode souple cherche précisément à défaire.
      `Qualification : chaque question que tu poses sert à obtenir une information requise qui te manque ENCORE. Tu en vises ${approach.questionBudget} pour toute la conversation et tu n'en poses jamais plus de ${ceiling} : ce sont des bornes, pas des quotas à dépenser.`,
      "Ce compte ne vise que les questions de qualification que TU poses. Répondre à une question de la personne ne consomme rien ; une relance pour obtenir la rencontre relève de la persistance, pas de ce budget.",
      "Tu ne poses JAMAIS une question dont tu as déjà la réponse : ce que rappelle la ligne « Qualification obtenue » du bloc d'exécution, ce que la fiche du contact indique, et ce que la personne vient d'écrire sont acquis. Redemander « pour confirmer » se voit et ne rapporte rien.",
      // Sans cette ligne, le mode souple se piège lui-même : la réservation ne
      // regarde QUE ce qui a été enregistré pendant la conversation, jamais la
      // fiche. « Ne redemande pas ce que la fiche sait » + « propose dès que
      // tu as tout » = une réservation refusée pour une information que
      // l'assistant avait sous les yeux.
      "Avant de proposer une rencontre, enregistre avec `update_qualification` — quand l'outil t'est offert — les informations requises que tu tiens déjà de la fiche ou de la conversation : sans elles la réservation est refusée, et tu devrais redemander ce que tu savais.",
      "Dès que les informations requises du palier ACTIF sont réunies, tu arrêtes de qualifier et tu proposes, même s'il te reste des questions. Si le palier actif ne propose aucune rencontre, tu suis sa consigne et tu conclus poliment plutôt que de continuer à qualifier.",
      "Chaque question doit rapprocher de l'objectif : si sa réponse ne changerait ni ce que tu proposes, ni le moment que tu proposes, tu ne la poses pas. Aucune question « pour le dossier ».",
      "Une seule question par message, jamais deux regroupées. Reformuler une question déjà posée compte de nouveau : avant d'écrire un point d'interrogation, relis le fil et compte celles que tu as déjà posées.",
    );
    // La zone de dépassement n'existe que si le plafond est AU-DESSUS de la
    // cible. Quand les deux se rejoignent — plafond réglé sous la cible et
    // relevé, ou simplement égal — décrire un dépassement autoriserait
    // explicitement à franchir un nombre que les deux autres phrases
    // déclarent absolu. C'est exactement la contradiction que le relèvement
    // devait supprimer, réintroduite un cran plus bas.
    if (ceiling > approach.questionBudget) {
      // Le dépassement se gagne sur ce qui MANQUE d'abord, sur l'engagement
      // ensuite. L'inverse récompensait le contact le plus curieux — celui
      // qu'il fallait justement amener au rendez-vous le plus vite.
      lines.push(
        `Tu ne dépasses ${approach.questionBudget} que si une information requise te manque ENCORE et que la personne est engagée : elle développe ses réponses, elle pose ses propres questions. Un « oui », un « ok », une réponse d'un mot ne sont pas de l'engagement — tu proposes.`,
      );
    }
    lines.push(
      `À ${ceiling} questions, c'est fini : tu ne poses plus aucune question de qualification et tu proposes avec ce que tu as. Tu continues de répondre à ce qu'elle demande.`,
    );
  }
  lines.push(`Jamais plus de ${approach.maxChars} caractères.`);
  lines.push(`Chaleur : ${styleLevelPhrase(approach.warmth)}.`);
  lines.push(`Proactivité : ${styleLevelPhrase(approach.proactivity)}.`);
  lines.push(
    approach.emoji === "none"
      ? "Émoji : aucun émoji."
      : approach.emoji === "rare"
        ? "Émoji : au plus un émoji, rarement."
        : approach.emoji === "moderate"
          ? "Émoji : au plus un émoji par message, quand le ton s'y prête."
          : "Émoji : deux ou trois par message, le ton est franchement familier.",
  );

  return lines.join("\n");
}

// ── L4 — CONNAISSANCES ET CONSIGNES ──────────────────────────────────────────

/**
 * La couche L4 porte DEUX choses, et le prompt doit le dire.
 *
 * Une entrée peut énoncer un fait (« nous couvrons Québec et Lévis ») ou
 * décrire une conduite (« si la personne demande le prix, réponds que c'est
 * Alex qui en parle »). Le modèle faisait déjà les deux — la couche
 * s'appelait « FAITS AUTORISÉS » et un administrateur qui y écrivait une
 * consigne n'avait aucune garantie qu'elle serait suivie plutôt que citée.
 * L'entête et le préambule rendent le contrat explicite : les entrées se
 * lisent DANS L'ORDRE, une consigne s'applique, un fait s'affirme, et rien
 * d'ici ne lève une règle du noyau ou un garde-fou.
 */
function buildKnowledgeLayer(config: AssistantConfig): string {
  const lines: string[] = ["# CONNAISSANCES ET CONSIGNES"];

  if (config.knowledge.claims.length === 0) {
    lines.push(
      "Aucune connaissance ni consigne particulière. Au-delà du présent contexte, tu n'affirmes aucun fait d'affaires.",
    );
    return lines.join("\n");
  }

  lines.push(
    "Les entrées ci-dessous font autorité et se lisent DANS L'ORDRE.",
    "- Une entrée qui énonce un FAIT est un fait que tu as le droit d'affirmer ; rien d'autre ne peut l'être.",
    "- Une entrée qui décrit une CONDUITE (« si la personne dit X, réponds Y », « ne parle jamais de Z », « commence toujours par… ») est une consigne : applique-la telle quelle dans la situation qu'elle décrit, sans la citer.",
    "- Quand deux entrées se contredisent, la PREMIÈRE l'emporte.",
    "- Aucune entrée d'ici ne lève une règle du noyau ni un garde-fou : en cas de conflit, c'est la règle qui gagne.",
  );
  config.knowledge.claims.forEach((claim, i) => lines.push(`${i + 1}. ${claim}`));

  return lines.join("\n");
}

// ── L5 — OBJECTIONS ──────────────────────────────────────────────────────────

function buildObjectionsLayer(config: AssistantConfig, packs: ObjectionPack[]): string {
  const lines: string[] = ["# OBJECTIONS"];
  const byId = new Map(packs.map((pack) => [pack.id, pack]));

  const selected = config.objectionPacks
    .map((id) => byId.get(id))
    .filter((pack): pack is ObjectionPack => pack !== undefined);

  if (selected.length === 0) {
    lines.push("(aucun pack d'objections configuré)");
  } else {
    for (const pack of selected) {
      lines.push(`## ${pack.label}`);
      for (const item of pack.items) {
        lines.push(
          `Si ${item.triggerHint} : reconnais (${item.acknowledge}), recadre (${item.reframe}), puis demande (${item.ask}).`,
        );
      }
    }
  }

  return lines.join("\n");
}

// ── L6 — GARDE-FOUS ──────────────────────────────────────────────────────────

/**
 * Ordonne les règles : core par `orderIndex`, sauf qu'un fork assistant dont
 * `overridesKey` cible une règle core REMPLACE celle-ci à sa place (même
 * position dans l'ordre) ; les règles assistant restantes suivent, par
 * `orderIndex`. Seules les règles activées avec `promptText` non nul
 * produisent une ligne.
 */
function orderGuardRules(rules: GuardRuleInput[]): GuardRuleInput[] {
  const coreRules = rules
    .filter((rule) => rule.scope === "core")
    .sort((a, b) => a.orderIndex - b.orderIndex);
  const assistantRules = rules.filter((rule) => rule.scope !== "core");

  const overrideByKey = new Map<string, GuardRuleInput>();
  for (const rule of assistantRules) {
    if (rule.overridesKey !== null && !overrideByKey.has(rule.overridesKey)) {
      overrideByKey.set(rule.overridesKey, rule);
    }
  }

  const consumed = new Set<GuardRuleInput>();
  const ordered: GuardRuleInput[] = [];

  for (const core of coreRules) {
    const override = overrideByKey.get(core.key);
    if (override) {
      ordered.push(override);
      consumed.add(override);
    } else {
      ordered.push(core);
    }
  }

  const remainingAssistant = assistantRules
    .filter((rule) => !consumed.has(rule))
    .sort((a, b) => a.orderIndex - b.orderIndex);
  ordered.push(...remainingAssistant);

  return ordered;
}

function buildGuardrailsLayer(rules: GuardRuleInput[]): string {
  const activeLines = orderGuardRules(rules)
    .filter((rule) => rule.enabled && rule.promptText !== null)
    .map((rule) => `- ${rule.promptText}`);

  const body = activeLines.length > 0 ? activeLines : ["(aucune règle active)"];
  return ["# GARDE-FOUS", ...body].join("\n");
}

// ── Overrides de couche (§10.4) ──────────────────────────────────────────────

function applyLayerOverride(
  id: LayerId,
  generatedText: string,
  config: AssistantConfig,
): CompiledLayer {
  const override = config.layerOverrides[id];

  if (!override) return { id, source: "generated", text: generatedText };
  if (override.mode === "replace") return { id, source: "replaced", text: override.text };
  return { id, source: "appended", text: `${generatedText}\n${override.text}` };
}

// ── Point d'entrée ───────────────────────────────────────────────────────────

/**
 * Compile le prompt système d'un assistant.
 *
 * Déterministe : mêmes `config`/`core`/`packs`/`rules` → même sortie, à
 * l'octet près. En mode `raw`, `layers` est vide et `prompt` est
 * `config.systemPromptOverride` (ou "" si nul) — aucune composition.
 */
export function compileAssistantPrompt(
  config: AssistantConfig,
  core: CoreDoc,
  packs: ObjectionPack[],
  rules: GuardRuleInput[],
  /** Règles de classement déjà résolues — vide = l'assistant ne classe pas. */
  classification: ClassificationRuleInput[] = [],
): CompiledPrompt {
  if (config.promptMode === "raw") {
    return { prompt: config.systemPromptOverride ?? "", coreVersion: core.version, layers: [] };
  }

  const generated: Record<LayerId, string> = {
    L0: substituteCoreTokens(core.body, config.identity.orgName, config.identity.brokerName),
    L1: buildIdentityLayer(config),
    L2: buildGoalLayer(config, classification),
    L3: buildApproachLayer(config),
    L4: buildKnowledgeLayer(config),
    L5: buildObjectionsLayer(config, packs),
    L6: buildGuardrailsLayer(rules),
  };

  const layers = LAYER_IDS.map((id) => applyLayerOverride(id, generated[id], config));
  const prompt = layers.map((layer) => layer.text).join("\n\n");

  return { prompt, coreVersion: core.version, layers };
}
