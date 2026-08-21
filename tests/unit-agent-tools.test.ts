/**
 * Tests unitaires — définitions d'outils de l'agent (src/lib/agent/tools.ts).
 *
 * Logique pure : aucune base de données, aucune horloge, aucun aléa. On
 * vérifie ici la frontière modèle → handler : la validation zod des
 * arguments hallucinés par le modèle ne doit JAMAIS lever, et les défauts /
 * filtrages doivent se comporter comme documenté.
 */
import { describe, expect, it } from "vitest";

import { ASSISTANT_TOOLS, QUALIFICATION_FIELDS, type AssistantTool } from "@/lib/assistants/schema";
import { missingFieldsError, parseToolArgs, TOOL_ARG_SCHEMAS, TOOL_DEFS, toolDefsFor } from "@/lib/agent/tools";

// ═══════════════════════════════════════════════════════════════════════════
// Couverture des 8 outils
// ═══════════════════════════════════════════════════════════════════════════

describe("TOOL_DEFS / TOOL_ARG_SCHEMAS — couverture", () => {
  it("chaque outil de ASSISTANT_TOOLS a une définition ET un schéma d'arguments", () => {
    for (const name of ASSISTANT_TOOLS) {
      expect(TOOL_DEFS[name]).toBeDefined();
      expect(TOOL_ARG_SCHEMAS[name]).toBeDefined();
    }
  });

  it("chaque définition a un nom cohérent, une description française non vide, et des parameters JSON-Schema valides", () => {
    for (const name of ASSISTANT_TOOLS) {
      const def = TOOL_DEFS[name];
      expect(def.name).toBe(name);
      expect(typeof def.description).toBe("string");
      expect(def.description.length).toBeGreaterThan(20);

      expect(def.parameters).toBeTypeOf("object");
      expect(def.parameters).not.toBeNull();
      expect((def.parameters as Record<string, unknown>).type).toBe("object");
      expect((def.parameters as Record<string, unknown>).properties).toBeTypeOf("object");
    }
  });

  it("book_meeting : la description exige explicitement que les champs requis soient recueillis d'abord", () => {
    const description = TOOL_DEFS.book_meeting.description;
    expect(description).toMatch(/recueilli/i);
    expect(description.toLowerCase()).toContain("avant");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// toolDefsFor
// ═══════════════════════════════════════════════════════════════════════════

describe("toolDefsFor", () => {
  it("ne retourne que les outils activés", () => {
    const defs = toolDefsFor(["stop", "handoff"]);
    expect(defs.map((d) => d.name).sort()).toEqual(["handoff", "stop"]);
  });

  it("respecte l'ordre CANONIQUE de ASSISTANT_TOOLS, peu importe l'ordre d'entrée", () => {
    const defs = toolDefsFor(["close_conversation", "get_slots", "handoff"]);
    expect(defs.map((d) => d.name)).toEqual(["get_slots", "handoff", "close_conversation"]);
  });

  it("ignore silencieusement les noms inconnus", () => {
    const defs = toolDefsFor(["get_slots", "not_a_real_tool", "book_meeting"]);
    expect(defs.map((d) => d.name)).toEqual(["get_slots", "book_meeting"]);
  });

  it("liste vide → tableau vide", () => {
    expect(toolDefsFor([])).toEqual([]);
  });

  it("tous les outils activés → les 8, dans l'ordre canonique", () => {
    const shuffled = [...ASSISTANT_TOOLS].reverse();
    const defs = toolDefsFor(shuffled);
    expect(defs.map((d) => d.name)).toEqual([...ASSISTANT_TOOLS]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// parseToolArgs — cas valides par outil
// ═══════════════════════════════════════════════════════════════════════════

describe("parseToolArgs — arguments valides", () => {
  it("get_slots : {} applique le défaut count = 2", () => {
    const result = parseToolArgs("get_slots", {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.args).toEqual({ count: 2, preference: "any" });
  });

  it("get_slots : count explicite valide (3) est conservé", () => {
    const result = parseToolArgs("get_slots", { count: 3 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.args).toEqual({ count: 3, preference: "any" });
  });

  it("book_meeting : slotIso seul suffit (email optionnel)", () => {
    const result = parseToolArgs("book_meeting", { slotIso: "2026-08-25T14:00:00-04:00" });
    expect(result.ok).toBe(true);
  });

  it("book_meeting : slotIso + email", () => {
    const result = parseToolArgs("book_meeting", {
      slotIso: "2026-08-25T14:00:00-04:00",
      email: "marie@example.com",
    });
    expect(result.ok).toBe(true);
  });

  it("update_qualification : un seul champ (map partielle)", () => {
    const result = parseToolArgs("update_qualification", { fields: { budget: "200k" } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.args).toEqual({ fields: { budget: "200k" } });
  });

  it("update_qualification : map vide est acceptée", () => {
    const result = parseToolArgs("update_qualification", { fields: {} });
    expect(result.ok).toBe(true);
  });

  it("update_qualification : plusieurs champs valides", () => {
    const result = parseToolArgs("update_qualification", {
      fields: { budget: "200k", timing: "3 mois", email: "x@y.com" },
    });
    expect(result.ok).toBe(true);
  });

  it("schedule_followup : whenIso seul", () => {
    const result = parseToolArgs("schedule_followup", { whenIso: "2026-09-01T09:00:00-04:00" });
    expect(result.ok).toBe(true);
  });

  it("stop : reason omis", () => {
    const result = parseToolArgs("stop", {});
    expect(result.ok).toBe(true);
  });

  it("handoff : reason requis fourni", () => {
    const result = parseToolArgs("handoff", { reason: "Lead chaud, veut parler à un humain" });
    expect(result.ok).toBe(true);
  });

  it("transfer_assistant : uuid valide", () => {
    const result = parseToolArgs("transfer_assistant", {
      assistantId: "123e4567-e89b-12d3-a456-426614174000",
    });
    expect(result.ok).toBe(true);
  });

  it("close_conversation : outcome valide", () => {
    const result = parseToolArgs("close_conversation", { outcome: "goal_reached" });
    expect(result.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// parseToolArgs — rejets attendus
// ═══════════════════════════════════════════════════════════════════════════

describe("parseToolArgs — rejets", () => {
  it("nom d'outil inconnu → unknown_tool", () => {
    const result = parseToolArgs("delete_everything", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("unknown_tool: delete_everything");
  });

  it("get_slots : count hors bornes (9) est rejeté", () => {
    const result = parseToolArgs("get_slots", { count: 9 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^invalid_args:/);
  });

  it("get_slots : count non entier est rejeté", () => {
    const result = parseToolArgs("get_slots", { count: 1.5 });
    expect(result.ok).toBe(false);
  });

  it("book_meeting : slotIso manquant est rejeté", () => {
    const result = parseToolArgs("book_meeting", { email: "x@y.com" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^invalid_args: slotIso/);
  });

  it("book_meeting : slotIso vide est rejeté", () => {
    const result = parseToolArgs("book_meeting", { slotIso: "" });
    expect(result.ok).toBe(false);
  });

  it("update_qualification : clé hors vocabulaire est rejetée", () => {
    const result = parseToolArgs("update_qualification", { fields: { not_a_field: "x" } });
    expect(result.ok).toBe(false);
  });

  it("update_qualification : valeur non-string est rejetée", () => {
    const result = parseToolArgs("update_qualification", { fields: { budget: 200000 } });
    expect(result.ok).toBe(false);
  });

  it("transfer_assistant : assistantId non-uuid est rejeté", () => {
    const result = parseToolArgs("transfer_assistant", { assistantId: "not-a-uuid" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^invalid_args: assistantId/);
  });

  it("transfer_assistant : assistantId manquant est rejeté", () => {
    const result = parseToolArgs("transfer_assistant", { reason: "test" });
    expect(result.ok).toBe(false);
  });

  it("handoff : reason manquant est rejeté", () => {
    const result = parseToolArgs("handoff", {});
    expect(result.ok).toBe(false);
  });

  it("close_conversation : outcome hors énumération est rejeté", () => {
    const result = parseToolArgs("close_conversation", { outcome: "maybe_later" });
    expect(result.ok).toBe(false);
  });

  it("close_conversation : outcome manquant est rejeté", () => {
    const result = parseToolArgs("close_conversation", {});
    expect(result.ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// parseToolArgs — ne lève jamais, même sur des entrées farfelues
// ═══════════════════════════════════════════════════════════════════════════

describe("parseToolArgs — jamais de levée d'exception", () => {
  const garbageArgs: unknown[] = [null, "", 42, {}, [], true, undefined, { random: "garbage" }];

  for (const name of ASSISTANT_TOOLS) {
    for (const garbage of garbageArgs) {
      it(`${name} avec args=${JSON.stringify(garbage)} ne lève jamais`, () => {
        expect(() => parseToolArgs(name, garbage)).not.toThrow();
        const result = parseToolArgs(name, garbage);
        expect(typeof result.ok).toBe("boolean");
      });
    }
  }

  it("nom farfelu (chaîne vide, garbage) ne lève jamais", () => {
    for (const badName of ["", "🙂", "GET_SLOTS", "get slots", "get_slots "]) {
      expect(() => parseToolArgs(badName, {})).not.toThrow();
      const result = parseToolArgs(badName, {});
      expect(result.ok).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// missingFieldsError
// ═══════════════════════════════════════════════════════════════════════════

describe("missingFieldsError", () => {
  it("inclut chaque champ manquant, nommément", () => {
    const message = missingFieldsError(["timing", "budget"]);
    expect(message).toContain("timing");
    expect(message).toContain("budget");
  });

  it("est un texte en français orienté action pour le modèle", () => {
    const message = missingFieldsError(["email"]);
    expect(message.toLowerCase()).toContain("réserver");
    expect(message).toContain("email");
  });

  it("couvre chaque champ du vocabulaire QUALIFICATION_FIELDS", () => {
    const message = missingFieldsError([...QUALIFICATION_FIELDS]);
    for (const field of QUALIFICATION_FIELDS) {
      expect(message).toContain(field);
    }
  });

  it("une seule liste de champs manquants → aucune levée, même vide", () => {
    expect(() => missingFieldsError([])).not.toThrow();
    expect(typeof missingFieldsError([])).toBe("string");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Cohérence AssistantTool ↔ literal keys
// ═══════════════════════════════════════════════════════════════════════════

describe("cohérence des clés", () => {
  it("TOOL_DEFS et TOOL_ARG_SCHEMAS n'ont ni clé manquante ni clé en trop", () => {
    const expected: AssistantTool[] = [...ASSISTANT_TOOLS];
    expect(Object.keys(TOOL_DEFS).sort()).toEqual([...expected].sort());
    expect(Object.keys(TOOL_ARG_SCHEMAS).sort()).toEqual([...expected].sort());
  });
});
