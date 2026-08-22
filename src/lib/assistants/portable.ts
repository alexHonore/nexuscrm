import { z } from "zod";
import {
  ASSISTANT_TOOLS,
  assistantConfigSchema,
  type AssistantConfig,
} from "./schema";
import {
  GUARDRAIL_KINDS,
  GUARDRAIL_SEVERITIES,
  fixtureExpectationsSchema,
  fixtureSetupSchema,
  objectionItemSchema,
  safeParseRuleConfig,
  type FixtureData,
  type RuleData,
} from "@/lib/guardrails/types";
import { paramDocText } from "@/lib/docs/locale";
import { PARAM_DOCS, getParamDoc } from "@/lib/docs/params";
import type { DocLocale } from "@/lib/docs/types";

/**
 * Import / export d'un assistant (§15.3).
 *
 * Module PUR : ni Next, ni base, ni horloge implicite. Il produit un document
 * et en relit un ; c'est l'appelant qui va chercher les règles, les fixtures et
 * le catalogue local.
 *
 * Deux choix expliquent tout le reste :
 *
 *  · **Aucun identifiant local ne traverse.** Un `users.id` exporté d'une base
 *    et réinjecté dans une autre pointe soit vers rien, soit — pire — vers
 *    quelqu'un d'autre. Les champs qui portent un identifiant sont donc sortis
 *    de la config et listés comme LIAISONS, avec de quoi les reconnaître à
 *    l'arrivée (nom, courriel). L'import ne devine pas : il propose, et ce qui
 *    reste non résolu devient null avec un avertissement.
 *
 *  · **Les règles du noyau ne s'importent pas.** Elles appartiennent à
 *    l'installation, pas à l'assistant. Un document qui en contient les voit
 *    retirées et l'importateur est prévenu — sans quoi un fichier venu d'ailleurs
 *    redéfinirait silencieusement les garde-fous de TOUS les assistants.
 */

export const EXPORT_FORMAT = "nexus.assistant/v1";

// ── Liaisons ─────────────────────────────────────────────────────────────────

export const BINDING_KINDS = ["user", "objection_pack"] as const;
export type BindingKind = (typeof BINDING_KINDS)[number];

export const bindingSchema = z.object({
  /** Chemin dans la config, ou « objectionPacks[] » pour un élément de liste. */
  path: z.string().min(1),
  kind: z.enum(BINDING_KINDS),
  /** Valeur d'origine — conservée pour information seulement, jamais réutilisée. */
  sourceValue: z.string().nullable(),
  /** De quoi reconnaître la cible dans une autre base. */
  label: z.string().default(""),
  hint: z.string().default(""),
});
export type Binding = z.infer<typeof bindingSchema>;

// ── Règles et fixtures transportables ────────────────────────────────────────

const portableRuleSchema = z
  .object({
    scope: z.enum(["core", "assistant"]),
    key: z.string().min(1),
    label: z.string().min(1),
    description: z.string().nullable().default(null),
    kind: z.enum(GUARDRAIL_KINDS),
    config: z.unknown(),
    promptText: z.string().nullable().default(null),
    severity: z.enum(GUARDRAIL_SEVERITIES),
    enabled: z.boolean(),
    overridesKey: z.string().nullable().default(null),
    orderIndex: z.number().int(),
  })
  // La config est validée selon le `kind` DÈS la lecture du fichier, comme
  // l'API le fait à la création. Une règle illisible écrite telle quelle
  // faisait lever le filtre de sortie à CHAQUE tour : l'assistant ne
  // répondait plus et personne n'était prévenu. Ici, le fichier est refusé
  // avec le chemin exact de la règle fautive.
  .superRefine((rule, ctx) => {
    const parsed = safeParseRuleConfig(rule.kind, rule.config ?? {});
    if (parsed.success) return;
    for (const issue of parsed.error.issues) {
      ctx.addIssue({
        code: "custom",
        path: ["config", ...issue.path.map(String)],
        message: `règle « ${rule.key} » : ${issue.message}`,
      });
    }
  });
export type PortableRule = z.infer<typeof portableRuleSchema>;

const portableFixtureSchema = z.object({
  scope: z.enum(["core", "assistant"]),
  key: z.string().nullable().default(null),
  label: z.string().min(1),
  setup: fixtureSetupSchema,
  inbound: z.string(),
  expectations: fixtureExpectationsSchema,
  severity: z.enum(GUARDRAIL_SEVERITIES),
  enabled: z.boolean(),
  orderIndex: z.number().int(),
});
export type PortableFixture = z.infer<typeof portableFixtureSchema>;

const portablePackSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  language: z.string().default("fr-CA"),
  // Des items TYPÉS : un paquet « items: "texte" » itérait caractère par
  // caractère et compilait « Si undefined : reconnais (undefined)… » dans le
  // prompt d'un assistant en service. Le fichier est refusé avec le chemin.
  items: z.array(objectionItemSchema),
  isBuiltin: z.boolean().default(false),
});
export type PortablePack = z.infer<typeof portablePackSchema>;

// ── Document ─────────────────────────────────────────────────────────────────

const docBlockSchema = z.object({
  label: z.string(),
  what: z.string(),
  why: z.string(),
  effect: z.string().optional(),
  pitfalls: z.string().optional(),
});

/**
 * Forme de TRANSPORT de la config : identique à la config stockée, sauf les
 * outils, lus comme de simples chaînes. Un fichier venu d'une version future
 * peut nommer un outil inconnu ici ; `planImport` le retire avec un
 * avertissement au lieu que tout le fichier soit refusé pour ça. La config
 * repasse par `assistantConfigSchema` (strict) avant toute écriture.
 */
const portableAssistantSchema = assistantConfigSchema.extend({
  tools: z.array(z.string()).default([...ASSISTANT_TOOLS]),
});

export const bundleSchema = z
  .object({
    format: z.literal(EXPORT_FORMAT),
    exportedAt: z.string(),
    /** Nom de l'installation d'origine — purement informatif. */
    sourceOrg: z.string().default(""),
    assistant: portableAssistantSchema,
    bindings: z.array(bindingSchema).default([]),
    guardrails: z.array(portableRuleSchema).default([]),
    fixtures: z.array(portableFixtureSchema).default([]),
    objectionPacks: z.array(portablePackSchema).default([]),
    /** Annotations lisibles — ignorées à la relecture. */
    _docs: z.record(z.string(), docBlockSchema).optional(),
  })
  // Deux règles de même clé violeraient l'index unique en pleine transaction :
  // l'import entier tombait en 500 « duplicate key ». Ici, c'est une erreur de
  // fichier, dite à la prévisualisation, avec la position du doublon.
  .superRefine((bundle, ctx) => {
    const seenRules = new Set<string>();
    bundle.guardrails.forEach((rule, i) => {
      const id = `${rule.scope}:${rule.key}`;
      if (seenRules.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["guardrails", i, "key"],
          message: `clé de règle en double : « ${rule.key} »`,
        });
      }
      seenRules.add(id);
    });
    const seenFixtures = new Set<string>();
    bundle.fixtures.forEach((fixture, i) => {
      if (fixture.key === null) return;
      const id = `${fixture.scope}:${fixture.key}`;
      if (seenFixtures.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["fixtures", i, "key"],
          message: `clé de fixture en double : « ${fixture.key} »`,
        });
      }
      seenFixtures.add(id);
    });
    const seenPacks = new Set<string>();
    bundle.objectionPacks.forEach((pack, i) => {
      if (seenPacks.has(pack.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["objectionPacks", i, "id"],
          message: `paquet d'objections en double : « ${pack.id} »`,
        });
      }
      seenPacks.add(pack.id);
    });
  });
export type AssistantBundle = z.infer<typeof bundleSchema>;

// ── Export ───────────────────────────────────────────────────────────────────

export interface BuildBundleInput {
  config: AssistantConfig;
  rules: RuleData[];
  fixtures: FixtureData[];
  objectionPacks: PortablePack[];
  /** Étiquettes des cibles de liaison, par identifiant local. */
  labels: Record<string, { label: string; hint?: string }>;
  sourceOrg?: string;
  now: Date;
  /** Annoter par défaut : un fichier qu'on relit six mois plus tard. */
  annotate?: boolean;
  /**
   * Langue des annotations `_docs`. Celles-ci sont lues par un HUMAIN — elles
   * suivent donc la langue de qui exporte, contrairement à la configuration
   * elle-même, qui décide de ce que l'assistant écrit à ses clients.
   */
  locale?: DocLocale;
}

/** Chemins de la config qui portent un identifiant d'utilisateur local. */
export function userBindingPaths(config: AssistantConfig): string[] {
  const paths = ["identity.brokerUserId", "goal.primary.withUserId"];
  config.goal.fallbacks.forEach((_, i) => paths.push(`goal.fallbacks[${i}].withUserId`));
  return paths;
}

function readPath(config: AssistantConfig, path: string): string | null {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  let node: unknown = config;
  for (const part of parts) {
    if (node === null || typeof node !== "object") return null;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : null;
}

function writePath(config: AssistantConfig, path: string, value: string | null): void {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  const last = parts.pop()!;
  let node: unknown = config;
  for (const part of parts) {
    if (node === null || typeof node !== "object") return;
    node = (node as Record<string, unknown>)[part];
  }
  if (node && typeof node === "object") (node as Record<string, unknown>)[last] = value;
}

export function buildBundle(input: BuildBundleInput): AssistantBundle {
  // Copie profonde : l'export ne doit pas vider les identifiants de l'objet
  // que l'appelant continue d'utiliser.
  const config: AssistantConfig = JSON.parse(JSON.stringify(input.config));
  const bindings: Binding[] = [];

  for (const path of userBindingPaths(config)) {
    const value = readPath(config, path);
    if (!value) continue;
    const meta = input.labels[value];
    bindings.push({
      path,
      kind: "user",
      sourceValue: value,
      label: meta?.label ?? "",
      hint: meta?.hint ?? "",
    });
    // L'identifiant SORT de la config : seul le descripteur de liaison le porte.
    writePath(config, path, null);
  }

  for (const id of config.objectionPacks) {
    const meta = input.labels[id];
    bindings.push({
      path: "objectionPacks[]",
      kind: "objection_pack",
      sourceValue: id,
      label: meta?.label ?? id,
      hint: meta?.hint ?? "",
    });
  }

  const bundle: AssistantBundle = {
    format: EXPORT_FORMAT,
    exportedAt: input.now.toISOString(),
    sourceOrg: input.sourceOrg ?? "",
    assistant: config,
    bindings,
    // Seules les règles propres à cet assistant voyagent (voir en-tête).
    guardrails: input.rules
      .filter((r) => r.scope === "assistant")
      .map((r) => ({
        scope: "assistant" as const,
        key: r.key,
        label: r.label,
        description: r.description ?? null,
        kind: r.kind,
        config: r.config,
        promptText: r.promptText,
        severity: r.severity,
        enabled: r.enabled,
        overridesKey: r.overridesKey ?? null,
        orderIndex: r.orderIndex,
      })),
    fixtures: input.fixtures
      .filter((f) => f.scope === "assistant")
      .map((f) => ({
        scope: "assistant" as const,
        key: f.key ?? null,
        label: f.label,
        setup: f.setup,
        inbound: f.inbound,
        expectations: f.expectations,
        severity: f.severity,
        enabled: f.enabled,
        orderIndex: f.orderIndex,
      })),
    objectionPacks: input.objectionPacks.filter((p) => config.objectionPacks.includes(p.id)),
  };

  if (input.annotate !== false) bundle._docs = buildDocs(config, input.locale ?? "fr");
  return bundle;
}

/** Annotations pour les chemins effectivement présents dans cette config. */
export function buildDocs(
  config: AssistantConfig,
  locale: DocLocale = "fr",
): Record<string, z.infer<typeof docBlockSchema>> {
  const out: Record<string, z.infer<typeof docBlockSchema>> = {};
  const add = (path: string) => {
    const entry = getParamDoc(path);
    if (!entry) return;
    const text = paramDocText(entry, locale);
    out[path] = {
      label: text.label,
      what: text.what,
      why: text.why,
      ...(text.effect ? { effect: text.effect } : {}),
      ...(text.pitfalls ? { pitfalls: text.pitfalls } : {}),
    };
  };

  for (const entry of PARAM_DOCS) {
    if (entry.path.includes("[]")) continue;
    if (entry.path.startsWith("tools.")) continue;
    add(entry.path);
  }
  // Les replis : un bloc par cran réellement configuré, pas le gabarit.
  config.goal.fallbacks.forEach((_, i) => {
    for (const entry of PARAM_DOCS) {
      if (!entry.path.startsWith("goal.fallbacks[].")) continue;
      add(entry.path.replace("[]", `[${i}]`));
    }
  });
  return out;
}

/**
 * Sérialisation DÉTERMINISTE : clés triées, indentation fixe. Sans ça, deux
 * exports du même assistant diffèrent d'octets sans différer de sens, et le
 * versionnement d'un fichier exporté devient illisible.
 */
export function serializeBundle(bundle: AssistantBundle): string {
  return `${JSON.stringify(sortKeys(bundle), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortKeys(source[key]);
    return out;
  }
  return value;
}

// ── Import ───────────────────────────────────────────────────────────────────

export interface ImportWarning {
  code:
    | "core_rules_stripped"
    | "core_override"
    | "pack_kept_local"
    | "unresolved_user"
    | "unresolved_pack"
    | "named_person_without_user"
    | "unknown_tool"
    | "docs_ignored";
  messageFr: string;
  path?: string;
}

export interface ImportCatalog {
  /** Identifiants d'utilisateurs valides dans CETTE base. */
  userIds: Set<string>;
  /** Identifiants de paquets d'objections disponibles. */
  packIds: Set<string>;
  /** Clés des règles du noyau de CETTE installation — pour nommer les forks. */
  coreRuleKeys?: Set<string>;
}

export interface ImportPlan {
  config: AssistantConfig;
  rules: PortableRule[];
  fixtures: PortableFixture[];
  /** Paquets absents localement qu'il faudra créer. */
  packsToCreate: PortablePack[];
  bindings: Binding[];
  warnings: ImportWarning[];
}

export interface ParseResult {
  bundle: AssistantBundle;
  warnings: ImportWarning[];
}

/** Relit un document. Lève une erreur zod si la forme est invalide. */
export function parseBundle(raw: unknown): ParseResult {
  const bundle = bundleSchema.parse(raw);
  const warnings: ImportWarning[] = [];
  if (bundle._docs) {
    warnings.push({
      code: "docs_ignored",
      messageFr:
        "Les annotations « _docs » du fichier sont ignorées : la documentation vient de cette installation, pas du fichier importé.",
    });
    delete bundle._docs;
  }
  return { bundle, warnings };
}

/**
 * Résout les liaisons contre le catalogue local et prépare l'écriture.
 *
 * `resolution` associe la valeur d'ORIGINE à la cible locale choisie par
 * l'administrateur. Ce qui n'y figure pas et n'existe pas localement devient
 * null : mieux vaut un champ vide et un avertissement qu'un rendez-vous chez
 * la mauvaise personne.
 */
export function planImport(
  bundle: AssistantBundle,
  catalog: ImportCatalog,
  resolution: Record<string, string | null> = {},
): ImportPlan {
  const config: AssistantConfig = JSON.parse(JSON.stringify(bundle.assistant));
  const warnings: ImportWarning[] = [];

  for (const binding of bundle.bindings) {
    if (binding.kind !== "user") continue;
    const chosen = binding.sourceValue !== null ? resolution[binding.sourceValue] : null;
    const resolved = chosen && catalog.userIds.has(chosen) ? chosen : null;
    writePath(config, binding.path, resolved);
    if (!resolved) {
      warnings.push({
        code: "unresolved_user",
        path: binding.path,
        messageFr: `« ${binding.label || binding.path} » n'a pas d'équivalent ici : le champ reste vide.`,
      });
    }
  }

  // Paquets : on garde ceux qui existent localement, on crée ceux fournis, on
  // écarte le reste.
  const available = new Set(catalog.packIds);
  const packsToCreate: PortablePack[] = [];
  const keptPacks: string[] = [];
  for (const id of config.objectionPacks) {
    // `null` explicite = « laisser tomber ce paquet ». `?? id` seul aurait
    // rendu ce choix impossible à exprimer.
    if (Object.hasOwn(resolution, id) && resolution[id] === null) {
      warnings.push({
        code: "unresolved_pack",
        path: "objectionPacks",
        messageFr: `Le paquet d'objections « ${id} » a été écarté à l'import.`,
      });
      continue;
    }
    const target = resolution[id] ?? id;
    const supplied = bundle.objectionPacks.find((p) => p.id === id);
    if (available.has(target)) {
      keptPacks.push(target);
      // Le fichier apporte aussi sa version du paquet : c'est la LOCALE qui
      // est gardée, et le contenu du fichier ignoré. Sans avertissement, un
      // collègue qui a retouché les items du paquet croit l'avoir importé.
      if (supplied && target === id) {
        warnings.push({
          code: "pack_kept_local",
          path: "objectionPacks",
          messageFr: `Le paquet d'objections « ${id} » existe déjà ici : la version locale est conservée, le contenu du fichier est ignoré.`,
        });
      }
      continue;
    }
    if (supplied) {
      packsToCreate.push(supplied);
      keptPacks.push(supplied.id);
      continue;
    }
    warnings.push({
      code: "unresolved_pack",
      path: "objectionPacks",
      messageFr: `Le paquet d'objections « ${id} » n'existe pas ici et n'est pas fourni dans le fichier : il est retiré.`,
    });
  }
  config.objectionPacks = keptPacks;

  if (config.identity.mode === "named_person" && !config.identity.brokerUserId) {
    warnings.push({
      code: "named_person_without_user",
      path: "identity.brokerUserId",
      messageFr:
        "L'assistant écrit au nom d'une personne mais aucun compte n'y est rattaché : les rendez-vous retomberont sur un administrateur.",
    });
  }

  const unknownTools = config.tools.filter(
    (t) => !(ASSISTANT_TOOLS as readonly string[]).includes(t),
  );
  for (const tool of unknownTools) {
    warnings.push({
      code: "unknown_tool",
      path: "tools",
      messageFr: `L'outil « ${tool} » n'existe pas dans cette installation : il est retiré.`,
    });
  }
  config.tools = config.tools.filter((t) => (ASSISTANT_TOOLS as readonly string[]).includes(t));

  const coreRules = bundle.guardrails.filter((r) => r.scope === "core");
  if (coreRules.length > 0) {
    warnings.push({
      code: "core_rules_stripped",
      messageFr: `${coreRules.length} règle(s) du noyau ont été retirées : les garde-fous du noyau appartiennent à cette installation et ne s'importent pas.`,
    });
  }

  // Ce qui REDÉFINIT un garde-fou du noyau pour cet assistant est gardé —
  // c'est un choix d'auteur légitime — mais JAMAIS en silence : aucun écran
  // ne sait créer un fork, seul un fichier le peut, et un fork « off » annule
  // la règle globale pour cet assistant sans que la liste du noyau ne change.
  const rules = bundle.guardrails.filter((r) => r.scope === "assistant");
  rules.forEach((rule) => {
    if (!rule.overridesKey) return;
    const neutralises = !rule.enabled || rule.severity === "off";
    const knownLocally = catalog.coreRuleKeys ? catalog.coreRuleKeys.has(rule.overridesKey) : true;
    warnings.push({
      code: "core_override",
      path: `guardrails.${rule.key}`,
      messageFr: knownLocally
        ? `La règle « ${rule.key} » REMPLACE la règle du noyau « ${rule.overridesKey} » pour cet assistant${neutralises ? " — et la neutralise (désactivée ou inactive)" : ""}.`
        : `La règle « ${rule.key} » prétend remplacer une règle du noyau « ${rule.overridesKey} » qui n'existe pas ici : elle s'appliquera comme une règle ordinaire.`,
    });
  });
  for (const layer of ["L0", "L6"] as const) {
    const override = config.layerOverrides[layer];
    if (override?.mode !== "replace") continue;
    warnings.push({
      code: "core_override",
      path: `layerOverrides.${layer}`,
      messageFr:
        layer === "L0"
          ? "La couche L0 (noyau : rôle, limites OACIQ, honnêteté) est REMPLACÉE par le texte du fichier : le prompt de cet assistant n'énonce plus les limites professionnelles du noyau."
          : "La couche L6 (garde-fous) est REMPLACÉE par le texte du fichier : les règles du noyau ne sont plus rédigées dans le prompt de cet assistant (elles restent évaluées à l'exécution).",
    });
  }

  return {
    config: assistantConfigSchema.parse(config),
    rules,
    fixtures: bundle.fixtures.filter((f) => f.scope === "assistant"),
    packsToCreate,
    bindings: bundle.bindings,
    warnings,
  };
}
