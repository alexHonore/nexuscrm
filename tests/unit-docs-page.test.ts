/**
 * Unitaire — la page de documentation.
 *
 * Deux garanties : les fichiers d'EXEMPLE sont relus par les vrais schémas
 * d'import (un exemple qui enseigne un format refusé serait pire que pas
 * d'exemple), et la page rend chaque registre avec les vrais messages, sans
 * clé manquante — en français ET en anglais.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import assistantsEn from "../messages/en/assistants.json";
import assistantsFr from "../messages/fr/assistants.json";
import commonEn from "../messages/en/common.json";
import commonFr from "../messages/fr/common.json";
import { parseBundle, serializeBundle } from "@/lib/assistants/portable";
import { parseCampaignBundle, serializeCampaignBundle } from "@/lib/campaigns/portable";
import { CAMPAIGN_FIELD_DOCS, campaignFieldText } from "@/lib/campaigns/docs";
import { resolveParamDoc } from "@/lib/docs/locale";
import { PARAM_DOCS } from "@/lib/docs/params";
import {
  exampleAssistantBundle,
  exampleAssistantFile,
  exampleCampaignBundle,
  exampleCampaignFile,
  SAMPLE_ASSISTANT_ID,
  SAMPLE_USER_ID,
} from "@/lib/docs/examples";
import {
  FIXTURE_FIELD_DOCS,
  GUARDRAIL_KIND_DOCS,
  GUARDRAIL_SEVERITY_DOCS,
  fixtureText,
  kindText,
  severityText,
} from "@/lib/guardrails/docs";
import { TOOL_DEFS } from "@/lib/agent/tools";
import { OPTOUT_KEYWORDS } from "@/lib/sms/optout";
import { DEFAULT_QUIET_HOURS } from "@/lib/sms/quiet-hours";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const { DocsContent } = await import("@/components/admin/docs/docs-content");
type Labels = Parameters<typeof DocsContent>[0]["labels"];

const NOW = new Date("2026-01-01T12:00:00.000Z");

describe("fichiers d'exemple", () => {
  it("l'exemple d'assistant est relu par le schéma d'import, liaisons comprises", () => {
    const raw = JSON.parse(exampleAssistantFile(NOW));
    const { bundle } = parseBundle(raw);
    expect(bundle.format).toBe("nexus.assistant/v1");
    // La règle enseignée : l'identifiant est SORTI de la config, seule la liaison le porte.
    expect(JSON.stringify(bundle.assistant)).not.toContain(SAMPLE_USER_ID);
    expect(bundle.bindings.some((b) => b.kind === "user" && b.sourceValue === SAMPLE_USER_ID)).toBe(true);
    expect(Object.keys(raw._docs ?? {}).length).toBeGreaterThan(20);
  });

  it("l'exemple de campagne est relu par le schéma d'import, liaisons comprises", () => {
    const raw = JSON.parse(exampleCampaignFile(NOW));
    const { bundle } = parseCampaignBundle(raw);
    expect(bundle.format).toBe("nexus.campaign/v1");
    expect(JSON.stringify(bundle.campaign)).not.toContain(SAMPLE_ASSISTANT_ID);
    expect(bundle.bindings.map((b) => b.kind).sort()).toEqual(["assistant", "category", "sms_number", "user"]);
    // Un test A/B avec ouverture dictée : deux variantes, et l'échelle a trois barreaux.
    expect(bundle.campaign.variants).toHaveLength(2);
    expect(bundle.campaign.ladder).toHaveLength(3);
  });

  it("les exemples sont STABLES : même date, mêmes octets", () => {
    expect(exampleAssistantFile(NOW)).toBe(serializeBundle(exampleAssistantBundle(NOW)));
    expect(exampleCampaignFile(NOW)).toBe(serializeCampaignBundle(exampleCampaignBundle(NOW)));
  });
});

function render(locale: "fr" | "en"): string {
  const messages = locale === "fr" ? assistantsFr : assistantsEn;
  const labels = (messages as unknown as { docs: Labels }).docs;
  const checks = (messages as unknown as { goLive: { check: Record<string, { label: string; fix: string }> } })
    .goLive.check;
  return renderToStaticMarkup(
    createElement(DocsContent, {
      labels,
      data: {
        // Résolus dans la langue rendue — exactement ce que fait la page.
        params: PARAM_DOCS.map((p) => resolveParamDoc({ ...p, overridden: false }, locale)),
        campaignFields: CAMPAIGN_FIELD_DOCS.map((f) => ({
          ...campaignFieldText(f, locale),
          path: f.path,
          binding: f.binding,
        })),
        guardrailKinds: Object.values(GUARDRAIL_KIND_DOCS).map((k) => ({
          ...kindText(k, locale),
          kind: k.kind,
          costsModelCall: k.costsModelCall,
        })),
        severities: Object.values(GUARDRAIL_SEVERITY_DOCS).map((sv) => ({
          ...severityText(sv, locale),
          severity: sv.severity,
        })),
        fixtureFields: FIXTURE_FIELD_DOCS.map((f) => ({ ...fixtureText(f, locale), key: f.key })),
        tools: Object.values(TOOL_DEFS).map((d) => ({ name: d.name, description: d.description })),
        optoutKeywords: [...OPTOUT_KEYWORDS],
        quietHours: DEFAULT_QUIET_HOURS,
        goLiveChecks: Object.entries(checks).map(([id, c]) => ({ id, label: c.label, fix: c.fix })),
        // Les annotations « _docs » du fichier d'exemple suivent la page.
        examples: {
          assistant: exampleAssistantFile(NOW, locale),
          campaign: exampleCampaignFile(NOW, locale),
        },
      },
    }),
  );
}

describe("page de documentation", () => {
  it("rend les dix sections et CHAQUE registre, en français", () => {
    const html = render("fr");
    for (const id of ["overview", "create", "triggers", "assistants", "guardrails", "tools", "sending", "operator", "json", "golive"]) {
      expect(html, id).toContain(`id="${id}"`);
    }
    // Chaque paramètre d'assistant apparaît avec son chemin JSON.
    for (const p of PARAM_DOCS) expect(html, p.path).toContain(`>${p.path}<`);
    for (const f of CAMPAIGN_FIELD_DOCS) expect(html, f.path).toContain(`>${f.path}<`);
    for (const k of Object.keys(GUARDRAIL_KIND_DOCS)) expect(html, k).toContain(`>${k}<`);
    for (const name of Object.keys(TOOL_DEFS)) expect(html, name).toContain(`>${name}<`);
    expect(html).toContain("nexus.assistant/v1");
    expect(html).toContain("nexus.campaign/v1");
    expect(html).toContain("STOPALL");
    expect(html).toContain("dispatcher");
    // Les réglages nouvellement documentés sont bien rendus.
    expect(html).toContain("Numéros SMS");
    expect(html).toContain("Interrupteur d&#x27;arrêt");
    expect(html).toContain("ASSISTANT PAR DÉFAUT");
  });

  it("rend aussi en anglais, sans clé manquante ni fuite de chemin", () => {
    for (const locale of ["fr", "en"] as const) {
      const html = render(locale);
      expect(html, locale).not.toContain("MISSING_MESSAGE");
      expect(html, locale).not.toMatch(/docs\.[a-z]+\.[a-z]+/);
      expect(html, locale).not.toContain("undefined");
    }
    expect(render("en")).toContain("How it works");
  });

  it("les REGISTRES suivent la langue de la page, pas seulement les titres", () => {
    // Le vrai contenu de cette page, ce sont les fiches — pas les intertitres.
    // Tant qu'elles n'existaient qu'en français, basculer la langue ne changeait
    // qu'une dizaine de mots sur mille lignes.
    const fr = render("fr");
    const en = render("en");

    expect(fr).toContain("Objectif principal — type");
    expect(en).toContain("Primary goal — type");
    expect(en).not.toContain("Objectif principal — type");

    // Garde-fous et champs de campagne, mêmes registres, même règle.
    expect(fr).toContain("Interdire des mots précis");
    expect(en).toContain("Forbid specific words");
    expect(en).not.toContain("Interdire des mots précis");
    expect(en).toContain("Sending number");

    // Les identifiants, eux, ne se traduisent JAMAIS : c'est ce qu'on tape.
    for (const html of [fr, en]) {
      expect(html).toContain(">goal.primary.type<");
      expect(html).toContain(">forbidden_terms<");
      expect(html).toContain("anthropic/claude-sonnet-5");
    }
  });

  it("les blocs « docs » fr et en ont exactement les mêmes clés", () => {
    const keys = (o: unknown, p = ""): string[] =>
      o && typeof o === "object" && !Array.isArray(o)
        ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => keys(v, p + k + "."))
        : [p];
    const fr = new Set(keys((assistantsFr as unknown as { docs: unknown }).docs));
    const en = new Set(keys((assistantsEn as unknown as { docs: unknown }).docs));
    expect([...fr].filter((k) => !en.has(k))).toEqual([]);
    expect([...en].filter((k) => !fr.has(k))).toEqual([]);
    expect((commonFr as { nav: Record<string, string> }).nav.docs).toBeTruthy();
    expect((commonEn as { nav: Record<string, string> }).nav.docs).toBeTruthy();
  });

  it("chaque outil a sa glose humaine, en plus de la consigne que lit le modèle", () => {
    for (const locale of ["fr", "en"] as const) {
      const gloss = ((locale === "fr" ? assistantsFr : assistantsEn) as unknown as { docs: { tools: { gloss: Record<string, string> } } }).docs.tools.gloss;
      for (const name of Object.keys(TOOL_DEFS)) expect(gloss[name], `${locale} ${name}`).toBeTruthy();
    }
  });
});
