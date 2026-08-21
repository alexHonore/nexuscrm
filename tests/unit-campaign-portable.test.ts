/**
 * Unitaire — import/export d'une campagne, partie PURE.
 *
 * Ce qui compte : aucun identifiant local ne traverse, la résolution
 * automatique relie par NOM (pas par identifiant), ce qui ne se résout pas
 * est retiré avec avertissement, et deux exports du même objet sont identiques
 * à l'octet.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { campaignConfigSchema } from "@/lib/campaigns/schema";
import { CAMPAIGN_FIELD_DOCS, getCampaignFieldDoc } from "@/lib/campaigns/docs";
import {
  CAMPAIGN_EXPORT_FORMAT,
  autoResolve,
  buildCampaignBundle,
  parseCampaignBundle,
  planCampaignImport,
  serializeCampaignBundle,
  type CampaignImportCatalog,
} from "@/lib/campaigns/portable";

const NOW = new Date("2026-08-21T12:00:00.000Z");
const ASSISTANT = "11111111-1111-4111-8111-111111111111";
const NUMBER = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

const config = () =>
  campaignConfigSchema.parse({
    name: "Réactivation 180 j",
    description: "Vieux leads acheteurs",
    assistantId: ASSISTANT,
    smsNumberId: NUMBER,
    trigger: { kind: "category_changed", toCategoryIds: [3] },
    audience: { categoryIds: [1, 3], sourceIds: [7], assignedToIds: [USER], notContactedForDays: 180 },
    ladder: [
      { delayHours: 0, body: "Bonjour, ici Groupe Nexus.", label: "ouverture" },
      { delayHours: 72, body: null, label: "relance" },
    ],
    variants: [
      { key: "directe", weight: 50, body: "Toujours un projet?" },
      { key: "douce", weight: 50, body: "" },
    ],
  });

const LABELS = {
  assistant: { [ASSISTANT]: { label: "Acheteur FB", hint: "assistant" } },
  sms_number: { [NUMBER]: { label: "+15814810742", hint: "Ligne principale" } },
  category: { "1": { label: "Non contacté" }, "3": { label: "À rappeler" } },
  source: { "7": { label: "Facebook" } },
  user: { [USER]: { label: "alex@example.com", hint: "Alex-Honoré" } },
};

const CATALOG: CampaignImportCatalog = {
  assistants: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Acheteur FB" }],
  smsNumbers: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", e164: "+15814810742", label: "" }],
  categories: [
    { id: 10, name: "Non contacté" },
    { id: 30, name: "À rappeler" },
  ],
  sources: [{ id: 70, name: "Facebook" }],
  users: [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Alex-Honoré", email: "alex@example.com" }],
};

describe("export", () => {
  it("aucun identifiant local ne traverse : ils deviennent des liaisons", () => {
    const bundle = buildCampaignBundle({ config: config(), labels: LABELS, now: NOW });
    const json = JSON.stringify(bundle.campaign);
    for (const id of [ASSISTANT, NUMBER, USER]) expect(json).not.toContain(id);
    expect(bundle.campaign.assistantId).toBeNull();
    expect(bundle.campaign.smsNumberId).toBeNull();
    expect(bundle.campaign.audience.categoryIds).toEqual([]);
    expect(bundle.campaign.audience.assignedToIds).toEqual([]);
    if (bundle.campaign.trigger.kind === "category_changed") {
      expect(bundle.campaign.trigger.toCategoryIds).toEqual([]);
    }
    // Les liaisons portent de quoi reconnaître la cible ailleurs.
    const byPath = Object.fromEntries(bundle.bindings.map((b) => [`${b.path}:${b.sourceValue}`, b]));
    expect(byPath[`assistantId:${ASSISTANT}`].label).toBe("Acheteur FB");
    expect(byPath[`smsNumberId:${NUMBER}`].label).toBe("+15814810742");
    expect(byPath["audience.categoryIds[]:3"].label).toBe("À rappeler");
    expect(byPath["trigger.toCategoryIds[]:3"].label).toBe("À rappeler");
    expect(byPath[`audience.assignedToIds[]:${USER}`].label).toBe("alex@example.com");
  });

  it("ne modifie pas la config exportée", () => {
    const c = config();
    buildCampaignBundle({ config: c, labels: LABELS, now: NOW });
    expect(c.assistantId).toBe(ASSISTANT);
    expect(c.audience.categoryIds).toEqual([1, 3]);
  });

  it("est annoté par défaut, seulement sur les chemins présents", () => {
    const bundle = buildCampaignBundle({ config: config(), labels: LABELS, now: NOW });
    expect(bundle._docs?.["trigger.toCategoryIds"]).toBeDefined();
    // Pas de déclencheur « nouveau lead » ici : pas d'annotation pour ses sources.
    expect(bundle._docs?.["trigger.sourceIds"]).toBeUndefined();
    expect(bundle._docs?.["ladder[1].body"]?.what).toContain("ASSISTANT");
    expect(buildCampaignBundle({ config: config(), labels: LABELS, now: NOW, annotate: false })._docs).toBeUndefined();
  });

  it("deux exports du même objet sont IDENTIQUES à l'octet", () => {
    const a = serializeCampaignBundle(buildCampaignBundle({ config: config(), labels: LABELS, now: NOW }));
    const b = serializeCampaignBundle(buildCampaignBundle({ config: config(), labels: LABELS, now: NOW }));
    expect(a).toBe(b);
    expect(a.endsWith("\n")).toBe(true);
  });
});

describe("import", () => {
  it("relie AUTOMATIQUEMENT par nom, courriel et numéro — pas par identifiant", () => {
    const bundle = buildCampaignBundle({ config: config(), labels: LABELS, now: NOW });
    const plan = planCampaignImport(bundle, CATALOG);
    expect(plan.config.assistantId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(plan.config.smsNumberId).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    // Les catégories ont d'AUTRES identifiants ici (10, 30) : c'est le nom qui relie.
    expect(plan.config.audience.categoryIds).toEqual([10, 30]);
    expect(plan.config.audience.sourceIds).toEqual([70]);
    expect(plan.config.audience.assignedToIds).toEqual(["cccccccc-cccc-4ccc-8ccc-cccccccccccc"]);
    if (plan.config.trigger.kind === "category_changed") {
      expect(plan.config.trigger.toCategoryIds).toEqual([30]);
    }
    expect(plan.warnings).toEqual([]);
  });

  it("une correspondance AMBIGUË n'est pas devinée", () => {
    const bundle = buildCampaignBundle({ config: config(), labels: LABELS, now: NOW });
    const twoAssistants = {
      ...CATALOG,
      assistants: [...CATALOG.assistants, { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", name: "acheteur fb" }],
    };
    const binding = bundle.bindings.find((b) => b.path === "assistantId")!;
    expect(autoResolve(binding, twoAssistants)).toBeNull();
    const plan = planCampaignImport(bundle, twoAssistants);
    expect(plan.config.assistantId).toBeNull();
    expect(plan.warnings.some((w) => w.path === "assistantId")).toBe(true);
  });

  it("ce qui ne se résout pas est RETIRÉ avec avertissement, jamais écrit tel quel", () => {
    const bundle = buildCampaignBundle({ config: config(), labels: LABELS, now: NOW });
    const empty: CampaignImportCatalog = { assistants: [], smsNumbers: [], categories: [], sources: [], users: [] };
    const plan = planCampaignImport(bundle, empty);
    expect(plan.config.assistantId).toBeNull();
    expect(plan.config.audience.categoryIds).toEqual([]);
    expect(plan.config.audience.assignedToIds).toEqual([]);
    expect(plan.warnings.filter((w) => w.code === "unresolved_binding").length).toBeGreaterThanOrEqual(6);
    // Et surtout : aucun identifiant d'ORIGINE ne s'est glissé dans la config.
    expect(JSON.stringify(plan.config)).not.toContain(ASSISTANT);
  });

  it("un choix explicite l'emporte sur la résolution automatique, et « null » veut dire vide", () => {
    const bundle = buildCampaignBundle({ config: config(), labels: LABELS, now: NOW });
    const plan = planCampaignImport(bundle, CATALOG, { [ASSISTANT]: null, "3": "10" });
    expect(plan.config.assistantId).toBeNull();
    // « À rappeler » (3) ramené sur « Non contacté » (10), dans l'audience ET le déclencheur.
    expect(plan.config.audience.categoryIds).toEqual([10, 10]);
    if (plan.config.trigger.kind === "category_changed") {
      expect(plan.config.trigger.toCategoryIds).toEqual([10]);
    }
  });

  it("un choix vers une cible qui n'existe pas localement est refusé", () => {
    const bundle = buildCampaignBundle({ config: config(), labels: LABELS, now: NOW });
    const plan = planCampaignImport(bundle, CATALOG, { [ASSISTANT]: "99999999-9999-4999-8999-999999999999" });
    expect(plan.config.assistantId).toBeNull();
  });

  it("les annotations du fichier sont ignorées, pas relues comme configuration", () => {
    const bundle = buildCampaignBundle({ config: config(), labels: LABELS, now: NOW });
    const { bundle: parsed, warnings } = parseCampaignBundle(JSON.parse(serializeCampaignBundle(bundle)));
    expect(parsed._docs).toBeUndefined();
    expect(warnings.map((w) => w.code)).toContain("docs_ignored");
  });

  it("un fichier d'un autre format est REFUSÉ", () => {
    expect(() => parseCampaignBundle({ format: "nexus.assistant/v1", exportedAt: "x", assistant: {} })).toThrow(z.ZodError);
    expect(() => parseCampaignBundle({ format: CAMPAIGN_EXPORT_FORMAT, exportedAt: "x", campaign: { name: "" } })).toThrow(z.ZodError);
  });

  it("exporter → relire → exporter : octets IDENTIQUES", () => {
    const first = serializeCampaignBundle(buildCampaignBundle({ config: config(), labels: LABELS, now: NOW }));
    const { bundle } = parseCampaignBundle(JSON.parse(first));
    // On ré-exporte la config relue (liaisons déjà vides) avec les MÊMES liaisons.
    const again = serializeCampaignBundle({ ...bundle, _docs: JSON.parse(first)._docs });
    expect(again).toBe(first);
  });
});

describe("documentation des champs de campagne", () => {
  /** Chemins des feuilles du schéma — tableaux d'objets représentés par « [] ». */
  function leafPaths(schema: z.ZodType, prefix = ""): string[] {
    const inner = (schema as unknown as { def: { innerType?: z.ZodType } }).def.innerType;
    if (inner) return leafPaths(inner, prefix);
    const def = (schema as unknown as { def: { type: string; shape?: Record<string, z.ZodType>; element?: z.ZodType; options?: z.ZodType[] } }).def;
    if (def.type === "object" && def.shape) {
      return Object.entries(def.shape).flatMap(([k, c]) => leafPaths(c, prefix ? `${prefix}.${k}` : k));
    }
    if (def.type === "union" && def.options) {
      // Déclencheur discriminé : l'union des feuilles de chaque branche.
      return [...new Set(def.options.flatMap((o) => leafPaths(o, prefix)))];
    }
    if (def.type === "array" && def.element) {
      const elDef = (def.element as unknown as { def: { type: string; innerType?: unknown } }).def;
      if (elDef.type === "object" || elDef.innerType) return leafPaths(def.element, `${prefix}[]`);
      return [prefix];
    }
    return [prefix];
  }

  it("CHAQUE feuille de la config de campagne est documentée", () => {
    const paths = leafPaths(campaignConfigSchema);
    expect(paths.length).toBeGreaterThan(20);
    const undocumented = paths.filter((p) => getCampaignFieldDoc(p) === undefined);
    expect(
      undocumented,
      `Champs sans documentation dans src/lib/campaigns/docs.ts :\n  ${undocumented.join("\n  ")}`,
    ).toEqual([]);
  });

  it("aucune fiche ne pointe vers un champ qui n'existe plus", () => {
    const paths = new Set(leafPaths(campaignConfigSchema));
    const orphans = CAMPAIGN_FIELD_DOCS.map((d) => d.path).filter(
      (p) => !paths.has(p) && !["ladder", "variants"].includes(p),
    );
    expect(orphans).toEqual([]);
  });

  it("chaque fiche dit QUOI et POURQUOI", () => {
    for (const d of CAMPAIGN_FIELD_DOCS) {
      expect(d.whatFr.length, d.path).toBeGreaterThan(20);
      expect(d.whyFr.length, d.path).toBeGreaterThan(20);
    }
  });
});
