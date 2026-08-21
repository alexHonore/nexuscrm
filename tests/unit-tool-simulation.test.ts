/**
 * Unitaire — simulation d'outils (`lib/agent/tool-simulation.ts`).
 *
 * Le bac à sable et la suite répondent au modèle avec les MÊMES règles que
 * `executeTools` en production : zod, champs requis, créneau offert, effets de
 * bord joués une seule fois. Une version antérieure répondait « confirmé » à
 * tout `book_meeting` — l'essai montrait un rendez-vous pris là où la
 * production escaladait.
 */
import { describe, expect, it } from "vitest";
import {
  SIDE_EFFECT_TOOLS,
  isTerminalTool,
  simulateToolCall,
  simulatedSlots,
  simulatedSlotsText,
  simulatedToolResult,
} from "@/lib/agent/tool-simulation";
import { formatSlotLabel } from "@/lib/booking/provider";

const NOW = new Date("2026-08-19T15:00:00.000Z"); // mercredi 11 h à Toronto

const booking = {
  appointmentType: "meet" as const,
  requiredFields: ["project_type"],
  qualification: { project_type: "acheter" },
  now: NOW,
};

describe("simulatedSlots", () => {
  it("propose les prochaines heures ouvrables, toujours dans le futur", () => {
    // Mercredi 11 h à Toronto → le lendemain (jeudi) dès 10 h.
    const slots = simulatedSlots(NOW);
    expect(slots.map((s) => s.label)).toEqual(["jeudi 10 h", "jeudi 14 h", "jeudi 18 h 30"]);
    for (const slot of slots) {
      expect(new Date(slot.iso).getTime()).toBeGreaterThan(NOW.getTime());
      // Le libellé est celui que la production fabrique pour cet instant.
      expect(formatSlotLabel(new Date(slot.iso), "America/Toronto")).toBe(slot.label);
    }
    expect(slots[0].iso).toBe("2026-08-20T14:00:00.000Z");
  });

  it("les JOURS RÉSERVABLES des réglages sont respectés", () => {
    // Une installation qui n'ouvre que le samedi et le dimanche.
    const slots = simulatedSlots(NOW, { days: [0, 6] });
    expect(slots.every((s) => /samedi|dimanche/.test(s.label))).toBe(true);
    expect(slots.length).toBeGreaterThan(0);
  });

  it("« fin de semaine » ne rend QUE des samedis et dimanches", () => {
    // Le bogue signalé : l'agenda simulé était figé sur jeudi/vendredi/lundi,
    // donc un essai « je peux juste la fin de semaine » s'entendait toujours
    // répondre qu'il n'y a rien — quels que soient les réglages.
    const weekend = simulatedSlots(NOW, { preference: "weekend" });
    expect(weekend.length).toBeGreaterThan(0);
    expect(weekend.every((s) => /samedi|dimanche/.test(s.label))).toBe(true);
    const weekday = simulatedSlots(NOW, { preference: "weekday" });
    expect(weekday.every((s) => !/samedi|dimanche/.test(s.label))).toBe(true);
  });

  it("les moments de la journée sont respectés", () => {
    expect(simulatedSlots(NOW, { preference: "morning" }).every((s) => /10 h/.test(s.label))).toBe(true);
    expect(simulatedSlots(NOW, { preference: "evening" }).every((s) => /18 h 30/.test(s.label))).toBe(true);
  });

  it("une contrainte impossible ne rend rien plutôt que d'inventer", () => {
    // Ouvert seulement en semaine, contrainte « fin de semaine ».
    expect(simulatedSlots(NOW, { days: [1, 2, 3, 4, 5], preference: "weekend" })).toEqual([]);
  });

  it("le texte respecte le nombre demandé et ne mentionne jamais l'essai", () => {
    expect(simulatedSlotsText(2, NOW)).toBe("jeudi 10 h, jeudi 14 h");
    expect(simulatedSlotsText(1, NOW)).toBe("jeudi 10 h");
    expect(simulatedSlotsText(2, NOW)).not.toMatch(/bac à sable|sandbox|simul/i);
  });
});

describe("simulateToolCall", () => {
  it("des arguments invalides sont refusés sans compter comme appel réussi (comme zod en production)", () => {
    const out = simulateToolCall("handoff", new Set(), { ...booking, args: {} });
    expect(out.ok).toBe(false);
    expect(out.terminated).toBeNull();
    expect(out.content).toContain("invalid_args");
  });

  it("un outil inconnu est refusé", () => {
    const out = simulateToolCall("teleport", new Set(), { ...booking, args: {} });
    expect(out.ok).toBe(false);
    expect(out.content).toContain("unknown_tool");
  });

  it("get_slots rend le libellé ET l'ISO, autant de fois qu'on l'appelle", () => {
    const done = new Set<string>();
    const first = simulateToolCall("get_slots", done, { ...booking, args: { count: 2 } });
    expect(first.content).toContain("jeudi 10 h (2026-08-20T14:00:00.000Z)");
    expect(first.content).toContain("jeudi 14 h");
    // Appelable sans limite : ce n'est pas un effet de bord.
    const second = simulateToolCall("get_slots", done, { ...booking, args: { count: 3 } });
    expect(second.content).toContain("jeudi 10 h");
    expect(SIDE_EFFECT_TOOLS.has("get_slots")).toBe(false);
  });

  it("get_slots honore « fin de semaine » — et le DIT quand rien n'y répond", () => {
    const weekend = simulateToolCall("get_slots", new Set(), {
      ...booking,
      args: { count: 2, preference: "weekend" },
    });
    expect(weekend.content).toMatch(/samedi|dimanche/);
    expect(weekend.content).not.toContain("RIEN ne correspond");

    // Installation ouverte du lundi au vendredi seulement : le repli est
    // proposé, mais annoncé comme tel.
    const impossible = simulateToolCall("get_slots", new Set(), {
      ...booking,
      bookableDays: [1, 2, 3, 4, 5],
      args: { count: 2, preference: "weekend" },
    });
    expect(impossible.content).toContain("RIEN ne correspond à « weekend »");
    expect(impossible.content).toMatch(/jeudi|vendredi|lundi/);
  });

  it("get_slots sur un cran qui ne réserve pas : même phrase qu'en production", () => {
    const out = simulateToolCall("get_slots", new Set(), {
      ...booking,
      appointmentType: null,
      args: {},
    });
    expect(out.content).toBe("get_slots : ce cran d'objectif ne réserve pas de rencontre");
  });

  it("book_meeting refuse tant qu'un champ requis manque — et la production escalade", () => {
    const out = simulateToolCall("book_meeting", new Set(), {
      ...booking,
      requiredFields: ["project_type", "timing"],
      qualification: { project_type: "acheter" },
      args: { slotIso: simulatedSlots(NOW)[0].iso },
    });
    expect(out.ok).toBe(true);
    expect(out.bookingFailed).toBe(true);
    expect(out.content).toContain("il manque encore ces informations : timing");
  });

  it("book_meeting refuse une heure qui n'a pas été offerte (slot_taken) et une date illisible (invalid_slot)", () => {
    const taken = simulateToolCall("book_meeting", new Set(), {
      ...booking,
      args: { slotIso: "2026-08-20T19:00:00.000Z" },
    });
    expect(taken.bookingFailed).toBe(true);
    expect(taken.content).toContain("ÉCHEC (slot_taken)");
    expect(taken.content).toContain("ne confirme RIEN");

    const invalid = simulateToolCall("book_meeting", new Set(), {
      ...booking,
      args: { slotIso: "jeudi prochain" },
    });
    expect(invalid.bookingFailed).toBe(true);
    expect(invalid.content).toContain("ÉCHEC (invalid_slot)");
  });

  it("book_meeting confirme un créneau offert, puis refuse de rejouer (effet de bord)", () => {
    const done = new Set<string>();
    const iso = simulatedSlots(NOW)[2].iso;
    const ok = simulateToolCall("book_meeting", done, { ...booking, args: { slotIso: iso } });
    expect(ok.bookingFailed).toBe(false);
    expect(ok.content).toBe(`book_meeting : confirmé pour ${iso}`);
    // Même instant, autre écriture ISO : l'agenda compare des instants.
    const again = simulateToolCall("book_meeting", new Set(), {
      ...booking,
      args: { slotIso: "2026-08-20T18:30:00-04:00" },
    });
    expect(again.bookingFailed).toBe(false);

    const replay = simulateToolCall("book_meeting", done, { ...booking, args: { slotIso: iso } });
    expect(replay.content).toBe("book_meeting : déjà exécuté à ce tour");
  });

  it("book_meeting sur un cran sans rendez-vous échoue", () => {
    const out = simulateToolCall("book_meeting", new Set(), {
      ...booking,
      appointmentType: null,
      requiredFields: [],
      args: { slotIso: simulatedSlots(NOW)[0].iso },
    });
    expect(out.bookingFailed).toBe(true);
    expect(out.content).toBe("book_meeting : ce cran ne réserve pas de rencontre");
  });

  it("stop et handoff terminent le tour, sans texte renvoyé au modèle", () => {
    const done = new Set<string>();
    const stop = simulateToolCall("stop", done, { ...booking, args: {} });
    expect(stop.terminated).toBe("stop");
    expect(stop.content).toBe("");
    const handoff = simulateToolCall("handoff", done, { ...booking, args: { reason: "lead chaud" } });
    expect(handoff.terminated).toBe("handoff");
    expect(isTerminalTool("stop") && isTerminalTool("handoff")).toBe(true);
  });

  it("les autres outils sont « pris en compte », comme en production", () => {
    const done = new Set<string>();
    const q = simulateToolCall("update_qualification", done, {
      ...booking,
      args: { fields: { budget: "400k" } },
    });
    expect(q.content).toBe("update_qualification : pris en compte");
    const f = simulateToolCall("schedule_followup", done, {
      ...booking,
      args: { whenIso: "2026-09-01T14:00:00Z" },
    });
    expect(f.content).toBe("schedule_followup : pris en compte");
    expect(
      simulateToolCall("schedule_followup", done, { ...booking, args: { whenIso: "2026-09-01T14:00:00Z" } })
        .content,
    ).toBe("schedule_followup : déjà exécuté à ce tour");
  });

  it("aucune réponse ne dit au modèle qu'il est à l'essai", () => {
    const done = new Set<string>();
    const names = ["get_slots", "book_meeting", "update_qualification", "schedule_followup", "close_conversation"];
    const args: Record<string, unknown> = {
      get_slots: {},
      book_meeting: { slotIso: simulatedSlots(NOW)[0].iso },
      update_qualification: { fields: {} },
      schedule_followup: { whenIso: "2026-09-01T14:00:00Z" },
      close_conversation: { outcome: "goal_reached" },
    };
    for (const name of names) {
      const out = simulateToolCall(name, done, { ...booking, args: args[name] });
      expect(out.content, name).not.toMatch(/bac à sable|sandbox|simul|essai|exemple/i);
    }
  });
});

describe("simulatedToolResult (forme historique, suite de garde-fous)", () => {
  it("lit les mêmes disponibilités que le bac à sable et ne dédoublonne que les effets de bord", () => {
    const done = new Set<string>();
    expect(simulatedToolResult("get_slots", done)).toBe(`get_slots : ${simulatedSlotsText(2)}`);
    expect(simulatedToolResult("get_slots", done)).toBe(`get_slots : ${simulatedSlotsText(2)}`);
    expect(simulatedToolResult("book_meeting", done)).toBe("book_meeting : confirmé");
    expect(simulatedToolResult("book_meeting", done)).toBe("book_meeting : déjà exécuté à ce tour");
    expect(simulatedToolResult("update_qualification", done)).toBe("update_qualification : pris en compte");
  });
});
