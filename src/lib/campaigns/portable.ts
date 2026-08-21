import { z } from "zod";
import { campaignConfigSchema, type CampaignConfig } from "./schema";
import { CAMPAIGN_FIELD_DOCS, getCampaignFieldDoc } from "./docs";

/**
 * Import / export d'une campagne — module PUR (ni Next, ni base, ni horloge).
 *
 * Mêmes principes que pour un assistant :
 *
 *  · **Aucun identifiant local ne traverse.** Une campagne pointe vers un
 *    assistant, un numéro, des catégories, des sources, des utilisateurs — tous
 *    des identifiants qui, dans une autre base, désignent autre chose ou rien.
 *    Ils sortent de la config et deviennent des LIAISONS, avec de quoi les
 *    reconnaître à l'arrivée (nom de l'assistant, numéro E.164, nom de la
 *    catégorie, courriel de l'utilisateur). L'import les résout par ce nom
 *    quand c'est sans ambiguïté, propose le reste, et laisse vide ce qui ne
 *    se résout pas — avec un avertissement.
 *
 *  · **Un import est toujours un BROUILLON.** Activer se décide ici, après
 *    relecture, jamais parce que le fichier disait « active ».
 */

export const CAMPAIGN_EXPORT_FORMAT = "nexus.campaign/v1";

export const CAMPAIGN_BINDING_KINDS = ["assistant", "sms_number", "category", "source", "user"] as const;
export type CampaignBindingKind = (typeof CAMPAIGN_BINDING_KINDS)[number];

export const campaignBindingSchema = z.object({
  /** Chemin dans la config ; un suffixe « [] » désigne un élément de liste. */
  path: z.string().min(1),
  kind: z.enum(CAMPAIGN_BINDING_KINDS),
  /** Valeur d'origine — conservée pour information seulement, jamais réutilisée. */
  sourceValue: z.string().nullable(),
  /** De quoi reconnaître la cible dans une autre base (nom, E.164, courriel). */
  label: z.string().default(""),
  hint: z.string().default(""),
});
export type CampaignBinding = z.infer<typeof campaignBindingSchema>;

const docBlockSchema = z.object({
  label: z.string(),
  what: z.string(),
  why: z.string(),
  pitfalls: z.string().optional(),
});

/**
 * La config TRANSPORTABLE : la même que la config locale, sauf que les champs
 * d'identifiants sont vides — ils vivent dans `bindings`. On relit avec le
 * schéma de campagne lui-même : un fichier qui ne passe pas ce schéma ne
 * passerait pas non plus l'éditeur.
 */
export const campaignBundleSchema = z.object({
  format: z.literal(CAMPAIGN_EXPORT_FORMAT),
  exportedAt: z.string(),
  sourceOrg: z.string().default(""),
  campaign: campaignConfigSchema,
  bindings: z.array(campaignBindingSchema).default([]),
  /** Annotations lisibles — ignorées à la relecture. */
  _docs: z.record(z.string(), docBlockSchema).optional(),
});
export type CampaignBundle = z.infer<typeof campaignBundleSchema>;

// ── Export ───────────────────────────────────────────────────────────────────

/** Étiquette d'une cible locale, par genre et identifiant. */
export type BindingLabels = Partial<
  Record<CampaignBindingKind, Record<string, { label: string; hint?: string }>>
>;

export interface BuildCampaignBundleInput {
  config: CampaignConfig;
  labels: BindingLabels;
  sourceOrg?: string;
  now: Date;
  annotate?: boolean;
}

function labelFor(
  labels: BindingLabels,
  kind: CampaignBindingKind,
  id: string,
): { label: string; hint: string } {
  const meta = labels[kind]?.[id];
  return { label: meta?.label ?? "", hint: meta?.hint ?? "" };
}

export function buildCampaignBundle(input: BuildCampaignBundleInput): CampaignBundle {
  // Copie profonde : l'export ne doit pas vider les identifiants de l'objet
  // que l'appelant continue d'utiliser.
  const config: CampaignConfig = JSON.parse(JSON.stringify(input.config));
  const bindings: CampaignBinding[] = [];

  const bindOne = (path: string, kind: CampaignBindingKind, value: string | null) => {
    if (!value) return;
    bindings.push({ path, kind, sourceValue: value, ...labelFor(input.labels, kind, value) });
  };
  const bindList = (path: string, kind: CampaignBindingKind, values: (string | number)[]) => {
    for (const v of values) {
      const id = String(v);
      bindings.push({ path: `${path}[]`, kind, sourceValue: id, ...labelFor(input.labels, kind, id) });
    }
  };

  bindOne("assistantId", "assistant", config.assistantId);
  config.assistantId = null;
  bindOne("smsNumberId", "sms_number", config.smsNumberId);
  config.smsNumberId = null;

  if (config.trigger.kind === "lead_created") {
    bindList("trigger.sourceIds", "source", config.trigger.sourceIds);
    config.trigger.sourceIds = [];
  }
  if (config.trigger.kind === "category_changed") {
    bindList("trigger.toCategoryIds", "category", config.trigger.toCategoryIds);
    config.trigger.toCategoryIds = [];
  }

  bindList("audience.categoryIds", "category", config.audience.categoryIds);
  config.audience.categoryIds = [];
  bindList("audience.sourceIds", "source", config.audience.sourceIds);
  config.audience.sourceIds = [];
  bindList("audience.assignedToIds", "user", config.audience.assignedToIds);
  config.audience.assignedToIds = [];

  const bundle: CampaignBundle = {
    format: CAMPAIGN_EXPORT_FORMAT,
    exportedAt: input.now.toISOString(),
    sourceOrg: input.sourceOrg ?? "",
    campaign: config,
    bindings,
  };
  if (input.annotate !== false) bundle._docs = buildCampaignDocs(config);
  return bundle;
}

/** Annotations pour les chemins effectivement présents dans cette config. */
export function buildCampaignDocs(config: CampaignConfig): Record<string, z.infer<typeof docBlockSchema>> {
  const out: Record<string, z.infer<typeof docBlockSchema>> = {};
  const add = (path: string, docPath = path) => {
    const entry = getCampaignFieldDoc(docPath);
    if (!entry) return;
    out[path] = {
      label: entry.labelFr,
      what: entry.whatFr,
      why: entry.whyFr,
      ...(entry.pitfallsFr ? { pitfalls: entry.pitfallsFr } : {}),
    };
  };
  for (const entry of CAMPAIGN_FIELD_DOCS) {
    if (entry.path.includes("[]")) continue;
    // Les champs propres à un déclencheur ne sont annotés que s'ils s'appliquent.
    if (entry.path === "trigger.sourceIds" && config.trigger.kind !== "lead_created") continue;
    if (entry.path === "trigger.toCategoryIds" && config.trigger.kind !== "category_changed") continue;
    if (entry.path === "trigger.everyHours" && config.trigger.kind !== "scheduled") continue;
    add(entry.path);
  }
  config.ladder.forEach((_, i) => {
    for (const key of ["delayHours", "body", "label"]) add(`ladder[${i}].${key}`, `ladder[].${key}`);
  });
  config.variants.forEach((_, i) => {
    for (const key of ["key", "weight", "body"]) add(`variants[${i}].${key}`, `variants[].${key}`);
  });
  return out;
}

/** Sérialisation DÉTERMINISTE : clés triées, indentation fixe. */
export function serializeCampaignBundle(bundle: CampaignBundle): string {
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

export interface CampaignImportWarning {
  code: "unresolved_binding" | "docs_ignored" | "status_reset";
  messageFr: string;
  path?: string;
}

/** Le catalogue local : ce vers quoi une liaison PEUT pointer. */
export interface CampaignImportCatalog {
  assistants: { id: string; name: string }[];
  smsNumbers: { id: string; e164: string; label: string }[];
  categories: { id: number; name: string }[];
  sources: { id: number; name: string }[];
  users: { id: string; name: string; email: string }[];
}

export interface CampaignImportPlan {
  config: CampaignConfig;
  bindings: CampaignBinding[];
  /** Ce que chaque liaison est devenue : identifiant local ou null. */
  resolved: Record<string, string | null>;
  warnings: CampaignImportWarning[];
}

export function parseCampaignBundle(raw: unknown): {
  bundle: CampaignBundle;
  warnings: CampaignImportWarning[];
} {
  const bundle = campaignBundleSchema.parse(raw);
  const warnings: CampaignImportWarning[] = [];
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

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Résolution AUTOMATIQUE d'une liaison par son étiquette : une catégorie « À
 * rappeler » existe sous ce nom dans chaque installation, un utilisateur par
 * son courriel, un numéro par son E.164, un assistant par son nom. Le tout
 * n'est retenu que si la correspondance est UNIQUE — deux assistants du même
 * nom, et on laisse l'administrateur choisir.
 */
export function autoResolve(
  binding: CampaignBinding,
  catalog: CampaignImportCatalog,
): string | null {
  const label = norm(binding.label);
  if (label === "") return null;
  const unique = <T extends { id: string | number }>(rows: T[], pick: (r: T) => string) => {
    const hits = rows.filter((r) => norm(pick(r)) === label);
    return hits.length === 1 ? String(hits[0].id) : null;
  };
  switch (binding.kind) {
    case "assistant":
      return unique(catalog.assistants, (a) => a.name);
    case "sms_number":
      return unique(catalog.smsNumbers, (n) => n.e164);
    case "category":
      return unique(catalog.categories, (c) => c.name);
    case "source":
      return unique(catalog.sources, (s) => s.name);
    case "user":
      return unique(catalog.users, (u) => u.email) ?? unique(catalog.users, (u) => u.name);
  }
}

function existsLocally(kind: CampaignBindingKind, id: string, catalog: CampaignImportCatalog): boolean {
  switch (kind) {
    case "assistant":
      return catalog.assistants.some((a) => a.id === id);
    case "sms_number":
      return catalog.smsNumbers.some((n) => n.id === id);
    case "category":
      return catalog.categories.some((c) => String(c.id) === id);
    case "source":
      return catalog.sources.some((s) => String(s.id) === id);
    case "user":
      return catalog.users.some((u) => u.id === id);
  }
}

/**
 * Prépare l'écriture : résout chaque liaison (choix explicite > automatique >
 * vide), réinjecte les identifiants dans la config, et force le brouillon.
 *
 * `resolution` associe la valeur d'ORIGINE au choix local (`null` explicite =
 * « laisser vide »).
 */
export function planCampaignImport(
  bundle: CampaignBundle,
  catalog: CampaignImportCatalog,
  resolution: Record<string, string | null> = {},
): CampaignImportPlan {
  const config: CampaignConfig = JSON.parse(JSON.stringify(bundle.campaign));
  const warnings: CampaignImportWarning[] = [];
  const resolved: Record<string, string | null> = {};

  const lists: Record<string, (string | number)[]> = {
    "trigger.sourceIds": [],
    "trigger.toCategoryIds": [],
    "audience.categoryIds": [],
    "audience.sourceIds": [],
    "audience.assignedToIds": [],
  };

  for (const binding of bundle.bindings) {
    const key = binding.sourceValue ?? binding.path;
    let target: string | null;
    if (Object.hasOwn(resolution, key)) {
      target = resolution[key];
    } else {
      target = autoResolve(binding, catalog);
    }
    if (target !== null && !existsLocally(binding.kind, target, catalog)) target = null;
    resolved[key] = target;

    if (target === null) {
      warnings.push({
        code: "unresolved_binding",
        path: binding.path,
        messageFr: `« ${binding.label || binding.sourceValue || binding.path} » (${binding.kind}) n'a pas d'équivalent ici : ${
          binding.path.endsWith("[]") ? "retiré de la liste" : "le champ reste vide"
        }.`,
      });
      continue;
    }

    if (binding.path === "assistantId") config.assistantId = target;
    else if (binding.path === "smsNumberId") config.smsNumberId = target;
    else if (binding.path.endsWith("[]")) {
      const listPath = binding.path.slice(0, -2);
      const numeric = binding.kind === "category" || binding.kind === "source";
      lists[listPath]?.push(numeric ? Number(target) : target);
    }
  }

  if (config.trigger.kind === "lead_created") {
    config.trigger.sourceIds = lists["trigger.sourceIds"] as number[];
  }
  if (config.trigger.kind === "category_changed") {
    config.trigger.toCategoryIds = lists["trigger.toCategoryIds"] as number[];
  }
  config.audience.categoryIds = lists["audience.categoryIds"] as number[];
  config.audience.sourceIds = lists["audience.sourceIds"] as number[];
  config.audience.assignedToIds = lists["audience.assignedToIds"] as string[];

  return {
    config: campaignConfigSchema.parse(config),
    bindings: bundle.bindings,
    resolved,
    warnings,
  };
}
