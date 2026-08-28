/**
 * Unitaire — correctifs d'audit H2 (transport de fichiers + interface publique).
 *
 * Quatre garanties, aucune visible à l'écran :
 *  · #15 — un fichier d'assistant dont une liaison vise « __proto__.… » est
 *    REFUSÉ, et même appelé directement, `planImport` n'écrit jamais dans
 *    Object.prototype (la pollution empoisonnait tout le processus dès la
 *    prévisualisation).
 *  · #58 — une liaison de campagne dont la sorte ne colle pas au chemin
 *    (un uuid d'utilisateur dans « assistantId ») est refusée à la lecture au
 *    lieu d'échouer au FK en 500 — ou pire, de s'enregistrer sans bruit.
 *  · #13 — les pages légales publiques honorent `?lang=` : un lecteur sans
 *    cookie (vérification Google, lien partagé) peut lire l'anglais.
 *  · #55 — le sélecteur de langue de la coquille suit la langue EFFECTIVE de
 *    l'écran (cookie), pas `users.locale` : le premier clic change toujours.
 */
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import enLegal from "../messages/en/legal.json";
import frLegal from "../messages/fr/legal.json";
import type { ImportCatalog } from "@/lib/assistants/portable";
import type { CampaignBundle, CampaignImportCatalog } from "@/lib/campaigns/portable";

vi.mock("server-only", () => ({}));
// Le repli « cookie » des pages légales : ici, toujours français.
vi.mock("next-intl/server", () => ({ getLocale: async () => "fr" }));

const { assistantConfigSchema } = await import("@/lib/assistants/schema");
const { buildBundle, parseBundle, planImport, serializeBundle } = await import(
  "@/lib/assistants/portable"
);
const { campaignConfigSchema } = await import("@/lib/campaigns/schema");
const { buildCampaignBundle, parseCampaignBundle, planCampaignImport, serializeCampaignBundle } =
  await import("@/lib/campaigns/portable");

const NOW = new Date("2026-08-21T12:00:00.000Z");
const SOURCE_USER = "33333333-3333-4333-8333-333333333333";
const LOCAL_USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** L'état du prototype partagé — vérifié avant ET après chaque attaque. */
function expectPrototypePristine() {
  expect(Object.prototype.hasOwnProperty).toBeTypeOf("function");
  const probe = {} as Record<string, unknown>;
  expect(probe.polluted).toBeUndefined();
  expect("polluted" in probe).toBe(false);
}

// ── #15 — import d'assistant : chemins de liaison ────────────────────────────

function assistantConfig(overrides: Record<string, unknown> = {}) {
  return assistantConfigSchema.parse({
    name: "Acheteur FB",
    identity: {},
    goal: { primary: { type: "qualify_only", requiredFields: [] }, fallbacks: [] },
    approach: {},
    model: {},
    ...overrides,
  });
}

function assistantBundle(bindings: unknown[]): unknown {
  return {
    format: "nexus.assistant/v1",
    assistant: assistantConfig(),
    bindings,
  };
}

const binding = (path: string, kind = "user", sourceValue: string | null = null) => ({
  path,
  kind,
  sourceValue,
  label: "",
  hint: "",
});

describe("#15 — un chemin de liaison hostile ne pollue jamais le prototype", () => {
  it("le fichier est REFUSÉ dès la lecture, avec le chemin fautif", () => {
    for (const path of [
      "__proto__.polluted",
      "__proto__.hasOwnProperty",
      "constructor.prototype.polluted",
      "identity.__proto__.brokerUserId",
      "nimporte.quoi",
    ]) {
      expect(() => parseBundle(assistantBundle([binding(path)])), path).toThrow(z.ZodError);
    }
    expectPrototypePristine();
  });

  it("les chemins qu'un export émet passent, eux", () => {
    const ok = [
      binding("identity.brokerUserId", "user", SOURCE_USER),
      binding("goal.primary.withUserId", "user", SOURCE_USER),
      binding("goal.fallbacks[0].withUserId", "user", SOURCE_USER),
      binding("objectionPacks[]", "objection_pack", "pack-1"),
    ];
    expect(() => parseBundle(assistantBundle(ok))).not.toThrow();
    // La sorte doit coller au chemin : un « objection_pack » sur un champ
    // d'utilisateur est un fichier incohérent, pas une variante tolérable.
    expect(() =>
      parseBundle(assistantBundle([binding("identity.brokerUserId", "objection_pack")])),
    ).toThrow(z.ZodError);
  });

  it("appelé DIRECTEMENT, planImport ignore le chemin hostile et prévient", () => {
    const catalog: ImportCatalog = { userIds: new Set([LOCAL_USER]), packIds: new Set() };
    expectPrototypePristine();
    for (const [path, resolution] of [
      ["__proto__.polluted", { x: LOCAL_USER }],
      ["__proto__.hasOwnProperty", {}],
      ["constructor.prototype.polluted", { x: LOCAL_USER }],
    ] as const) {
      const bundle = parseBundle(assistantBundle([])).bundle;
      bundle.bindings = [{ path, kind: "user", sourceValue: "x", label: "", hint: "" }];
      const plan = planImport(bundle, catalog, resolution as Record<string, string | null>);
      expect(plan.warnings.map((w) => w.code), path).toContain("unknown_binding_path");
      expectPrototypePristine();
    }
    expect(Function.prototype as unknown as Record<string, unknown>).not.toHaveProperty(
      "polluted",
    );
  });

  it("un indice de repli hors de la config est ignoré aussi", () => {
    // `goal.fallbacks[7]` n'existe pas dans une config sans repli : la
    // grammaire du schéma le laisse passer, le plan doit le refuser.
    const bundle = parseBundle(
      assistantBundle([binding("goal.fallbacks[7].withUserId", "user", SOURCE_USER)]),
    ).bundle;
    const plan = planImport(bundle, { userIds: new Set([LOCAL_USER]), packIds: new Set() }, {
      [SOURCE_USER]: LOCAL_USER,
    });
    expect(plan.warnings.map((w) => w.code)).toContain("unknown_binding_path");
  });

  it("la résolution LÉGITIME écrit toujours, et l'export se relit", () => {
    const config = assistantConfig({ identity: { brokerUserId: SOURCE_USER } });
    const bundle = buildBundle({
      config,
      rules: [],
      fixtures: [],
      objectionPacks: [],
      labels: { [SOURCE_USER]: { label: "Alex-Honoré" } },
      now: NOW,
      annotate: false,
    });
    // L'export sort l'identifiant de la config et le met en liaison.
    expect(bundle.assistant.identity.brokerUserId).toBeNull();
    const reread = parseBundle(JSON.parse(serializeBundle(bundle))).bundle;
    const plan = planImport(reread, { userIds: new Set([LOCAL_USER]), packIds: new Set() }, {
      [SOURCE_USER]: LOCAL_USER,
    });
    expect(plan.config.identity.brokerUserId).toBe(LOCAL_USER);
    expect(plan.warnings.map((w) => w.code)).not.toContain("unknown_binding_path");
  });
});

// ── #58 — import de campagne : sorte contre chemin ───────────────────────────

const CAMPAIGN_ASSISTANT = "11111111-1111-4111-8111-111111111111";
const CAMPAIGN_NUMBER = "22222222-2222-4222-8222-222222222222";

function campaignConfig() {
  return campaignConfigSchema.parse({
    name: "Réactivation 180 j",
    description: "Vieux leads acheteurs",
    assistantId: CAMPAIGN_ASSISTANT,
    smsNumberId: CAMPAIGN_NUMBER,
    trigger: { kind: "category_changed", toCategoryIds: [3] },
    audience: { categoryIds: [1], sourceIds: [7], assignedToIds: [SOURCE_USER] },
    ladder: [{ delayHours: 0, body: "Bonjour, ici Groupe Nexus.", label: "ouverture" }],
  });
}

const CAMPAIGN_LABELS = {
  assistant: { [CAMPAIGN_ASSISTANT]: { label: "Acheteur FB" } },
  sms_number: { [CAMPAIGN_NUMBER]: { label: "+15814810742" } },
  category: { "1": { label: "Non contacté" }, "3": { label: "À rappeler" } },
  source: { "7": { label: "Facebook" } },
  user: { [SOURCE_USER]: { label: "alex@example.com" } },
};

const CAMPAIGN_CATALOG: CampaignImportCatalog = {
  assistants: [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Acheteur FB" }],
  smsNumbers: [{ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", e164: "+15814810742", label: "" }],
  categories: [
    { id: 10, name: "Non contacté" },
    { id: 30, name: "À rappeler" },
  ],
  sources: [{ id: 70, name: "Facebook" }],
  users: [{ id: LOCAL_USER, name: "Alex-Honoré", email: "alex@example.com" }],
};

function exportedCampaign(): CampaignBundle {
  const bundle = buildCampaignBundle({
    config: campaignConfig(),
    labels: CAMPAIGN_LABELS,
    now: NOW,
    annotate: false,
  });
  return JSON.parse(serializeCampaignBundle(bundle)) as CampaignBundle;
}

describe("#58 — la sorte d'une liaison doit coller à son chemin", () => {
  it("un export se relit tel quel : la table est UNE pour les deux sens", () => {
    expect(() => parseCampaignBundle(exportedCampaign())).not.toThrow();
  });

  it("un uuid d'utilisateur dans « assistantId » est refusé à la LECTURE", () => {
    const raw = exportedCampaign();
    const b = raw.bindings.find((x) => x.path === "assistantId")!;
    b.kind = "user";
    b.label = "alex@example.com";
    expect(() => parseCampaignBundle(raw)).toThrow(z.ZodError);
    try {
      parseCampaignBundle(raw);
    } catch (err) {
      const issues = (err as z.ZodError).issues.map((i) => i.message).join(" | ");
      expect(issues).toContain("assistantId");
      expect(issues).toContain("assistant");
    }
  });

  it("un chemin inconnu — « __proto__[] » compris — est refusé à la LECTURE", () => {
    for (const path of ["__proto__[]", "audience.__proto__[]", "nimporte.quoi"]) {
      const raw = exportedCampaign();
      raw.bindings.push({ path, kind: "user", sourceValue: "x", label: "", hint: "" });
      expect(() => parseCampaignBundle(raw), path).toThrow(z.ZodError);
    }
    expectPrototypePristine();
  });

  it("appelé DIRECTEMENT, le plan n'écrit rien pour une liaison incohérente", () => {
    // Sans `parseCampaignBundle` devant lui, `planCampaignImport` doit rester
    // sûr : la liaison incohérente tombe dans l'avertissement existant.
    const raw = exportedCampaign();
    const assistantBinding = raw.bindings.find((x) => x.path === "assistantId")!;
    assistantBinding.kind = "user";
    assistantBinding.label = "alex@example.com";
    const assigned = raw.bindings.find((x) => x.path === "audience.assignedToIds[]")!;
    assigned.kind = "assistant";
    assigned.label = "Acheteur FB";
    raw.bindings.push({ path: "__proto__[]", kind: "user", sourceValue: "x", label: "", hint: "" });

    const plan = planCampaignImport(raw, CAMPAIGN_CATALOG, {
      [assistantBinding.sourceValue!]: LOCAL_USER,
    });
    // Rien d'écrit : ni l'uuid d'utilisateur dans le champ d'assistant, ni
    // l'uuid d'assistant dans le filtre d'assignés, ni quoi que ce soit au
    // prototype — et chaque liaison perdue est DITE.
    expect(plan.config.assistantId).toBeNull();
    expect(plan.config.audience.assignedToIds).toEqual([]);
    const codes = plan.warnings.map((w) => w.code);
    expect(codes).toContain("unresolved_binding_cleared");
    expect(codes).toContain("unresolved_binding_removed");
    expectPrototypePristine();
  });

  it("les liaisons COHÉRENTES se résolvent comme avant", () => {
    const plan = planCampaignImport(exportedCampaign(), CAMPAIGN_CATALOG);
    expect(plan.config.assistantId).toBe("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    expect(plan.config.smsNumberId).toBe("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    expect(plan.config.audience.assignedToIds).toEqual([LOCAL_USER]);
    expect(plan.config.trigger.kind === "category_changed" && plan.config.trigger.toCategoryIds).toEqual([30]);
    expect(plan.warnings).toEqual([]);
  });
});

// ── #13 — pages légales : `?lang=` fait foi ──────────────────────────────────

const legalPages = {
  privacy: await import("@/app/(legal)/privacy/page"),
  terms: await import("@/app/(legal)/terms/page"),
};
const { LegalShell, resolveLegalLocale } = await import("@/app/(legal)/legal-shell");

const sp = (lang?: string) => ({ searchParams: Promise.resolve(lang ? { lang } : {}) });

describe("#13 — les pages légales publiques honorent ?lang=", () => {
  it("?lang= force la langue, le cookie n'est qu'un repli, le reste est ignoré", async () => {
    expect(await resolveLegalLocale("en")).toBe("en");
    expect(await resolveLegalLocale("fr")).toBe("fr");
    // Sans paramètre : le cookie (moqué à « fr » ici). Une valeur farfelue
    // ne casse rien : elle retombe aussi sur le repli.
    expect(await resolveLegalLocale(undefined)).toBe("fr");
    expect(await resolveLegalLocale("de")).toBe("fr");
  });

  it("la page rend le titre dans la langue demandée", async () => {
    const en = await legalPages.privacy.default(sp("en"));
    expect(en.props.locale).toBe("en");
    expect(en.props.title).toBe(enLegal.privacy.title);

    const fallback = await legalPages.privacy.default(sp());
    expect(fallback.props.locale).toBe("fr");
    expect(fallback.props.title).toBe(frLegal.privacy.title);

    const terms = await legalPages.terms.default(sp("en"));
    expect(terms.props.title).toBe(enLegal.terms.title);
  });

  it("les métadonnées suivent la même langue que la page", async () => {
    const md = await legalPages.terms.generateMetadata(sp("en"));
    expect(md.title).toBe(enLegal.terms.title);
    const mdFr = await legalPages.privacy.generateMetadata(sp());
    expect(mdFr.title).toBe(frLegal.privacy.title);
  });

  it("le bascule vise l'AUTRE langue et les liens du pied gardent la langue", async () => {
    const enHtml = renderToStaticMarkup(
      await LegalShell({ locale: "en", title: "T", updated: "U", children: null }),
    );
    // Depuis l'anglais on propose le français…
    expect(enHtml).toContain('href="?lang=fr"');
    expect(enHtml).toContain("Français");
    expect(enHtml.toLowerCase()).toContain('hreflang="fr"');
    // …et naviguer vers l'autre page légale reste en anglais. Le lien
    // /developers reste nu — unit-developers-page.test.ts exige ce libellé.
    expect(enHtml).toContain('href="/terms?lang=en"');
    expect(enHtml).toContain('href="/privacy?lang=en"');
    expect(enHtml).toContain('href="/developers"');

    const frHtml = renderToStaticMarkup(
      await LegalShell({ locale: "fr", title: "T", updated: "U", children: null }),
    );
    expect(frHtml).toContain('href="?lang=en"');
    expect(frHtml).toContain("English");
  });
});

// ── #55 — le sélecteur de langue suit l'écran, pas la base ───────────────────

/** Le code, sans les commentaires — un commentaire a le droit d'en parler. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("#55 — le sélecteur de langue de la coquille", () => {
  it("se règle sur useLocale(), jamais sur users.locale", () => {
    // La langue de l'écran vient du cookie NEXT_LOCALE ; `users.locale` peut
    // en diverger (compte créé en anglais, navigateur neuf) et le bouton
    // proposait alors la langue DÉJÀ affichée : premier clic sans effet.
    //
    // Le fichier a été coupé en deux quand la navigation est devenue affaire
    // de droits : `app-shell.tsx` résout côté serveur, `app-shell-client.tsx`
    // dessine. Le sélecteur vit désormais dans le second — mais la règle vaut
    // pour les DEUX : ni l'un ni l'autre ne doit lire `user.locale`.
    const client = code("src/components/shell/app-shell-client.tsx");
    expect(client).toContain("useLocale()");
    expect(client).not.toContain("user.locale");
    expect(code("src/components/shell/app-shell.tsx")).not.toContain("user.locale");
  });
});
