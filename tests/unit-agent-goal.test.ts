/**
 * Unitaire — chaîne de rétrogradation de l'objectif.
 *
 * La distinction que ce fichier verrouille : un refus MOU descend d'un cran,
 * un refus FERME ne touche JAMAIS la chaîne. Se tromper là-dessus, c'est
 * proposer un « et un appel de 15 minutes? » à quelqu'un qui vient de dire non.
 */
import { describe, expect, it } from "vitest";
import {
  applyRefusal,
  parseRungKey,
  requiredFieldsFor,
  resolveRung,
  rungAtDepth,
  rungCount,
  rungNeedsSlots,
} from "@/lib/agent/goal";
import { goalConfigSchema } from "@/lib/assistants/schema";

/** Acheteur FB : visio 30 → appel 15 → courriel (le cas réel du seed). */
const goal = goalConfigSchema.parse({
  primary: {
    type: "video_meeting",
    durationMin: 30,
    appointmentType: "meet",
    requiredFields: ["project_type", "timing"],
  },
  fallbacks: [
    { type: "phone_call", durationMin: 15, requiredFields: ["project_type"] },
    { type: "collect_email", requiredFields: ["email"] },
  ],
});

/** Long terme : un seul cran, aucun repli. */
const singleRung = goalConfigSchema.parse({
  primary: { type: "phone_call", durationMin: 10, requiredFields: [] },
  fallbacks: [],
});

describe("résolution des crans", () => {
  it("compte le principal plus les replis", () => {
    expect(rungCount(goal)).toBe(3);
    expect(rungCount(singleRung)).toBe(1);
  });

  it("aucun refus mou = objectif principal", () => {
    const rung = resolveRung(goal, 0);
    expect(rung).toMatchObject({ key: "primary", depth: 0, isLast: false });
    expect(rung.goal.type).toBe("video_meeting");
  });

  it("chaque refus mou descend d'un cran", () => {
    expect(resolveRung(goal, 1).key).toBe("fallback:0");
    expect(resolveRung(goal, 1).goal.type).toBe("phone_call");
    expect(resolveRung(goal, 2).key).toBe("fallback:1");
    expect(resolveRung(goal, 2).goal.type).toBe("collect_email");
  });

  it("au-delà de la chaîne on reste sur le dernier cran (borné)", () => {
    const rung = resolveRung(goal, 9);
    expect(rung.key).toBe("fallback:1");
    expect(rung.isLast).toBe(true);
    expect(rungAtDepth(goal, -3).key).toBe("primary");
  });

  it("parseRungKey relit ce qui est stocké, tout inconnu = principal", () => {
    expect(parseRungKey("primary")).toBe(0);
    expect(parseRungKey("fallback:0")).toBe(1);
    expect(parseRungKey("fallback:2")).toBe(3);
    expect(parseRungKey(null)).toBe(0);
    expect(parseRungKey("n'importe quoi")).toBe(0);
  });
});

describe("applyRefusal", () => {
  it("aucun refus : rien ne bouge", () => {
    const r = applyRefusal(goal, 0, "none");
    expect(r).toMatchObject({ downgraded: false, softRefusals: 0, exhausted: false });
    expect(r.rung.key).toBe("primary");
  });

  it("§21 — un refus mou fait passer au repli 0", () => {
    const r = applyRefusal(goal, 0, "soft");
    expect(r.rung.key).toBe("fallback:0");
    expect(r.downgraded).toBe(true);
    expect(r.softRefusals).toBe(1);
    expect(r.exhausted).toBe(false);
  });

  it("§21 — un refus FERME ne touche JAMAIS la chaîne", () => {
    // Depuis le principal…
    const fromPrimary = applyRefusal(goal, 0, "hard");
    expect(fromPrimary.rung.key).toBe("primary");
    expect(fromPrimary.downgraded).toBe(false);
    expect(fromPrimary.softRefusals).toBe(0);

    // …et depuis un cran déjà descendu : toujours aucun mouvement.
    const fromFallback = applyRefusal(goal, 1, "hard");
    expect(fromFallback.rung.key).toBe("fallback:0");
    expect(fromFallback.downgraded).toBe(false);
    expect(fromFallback.softRefusals).toBe(1);
  });

  it("un refus mou au dernier cran épuise la chaîne", () => {
    const r = applyRefusal(goal, 2, "soft");
    expect(r.exhausted).toBe(true);
    expect(r.rung.key).toBe("fallback:1");
  });

  it("un assistant sans repli est épuisé dès le premier refus mou", () => {
    const r = applyRefusal(singleRung, 0, "soft");
    expect(r.exhausted).toBe(true);
    expect(r.rung.key).toBe("primary");
    expect(r.downgraded).toBe(false);
  });

  it("deux refus mous consécutifs descendent de deux crans", () => {
    const first = applyRefusal(goal, 0, "soft");
    const second = applyRefusal(goal, first.softRefusals, "soft");
    expect(second.rung.key).toBe("fallback:1");
    expect(second.softRefusals).toBe(2);
  });
});

describe("propriétés d'un cran", () => {
  it("les champs requis suivent le cran", () => {
    expect(requiredFieldsFor(resolveRung(goal, 0))).toEqual(["project_type", "timing"]);
    expect(requiredFieldsFor(resolveRung(goal, 1))).toEqual(["project_type"]);
    expect(requiredFieldsFor(resolveRung(goal, 2))).toEqual(["email"]);
  });

  it("seuls les crans qui réservent ont besoin de disponibilités", () => {
    expect(rungNeedsSlots(resolveRung(goal, 0))).toBe(true); // visio
    expect(rungNeedsSlots(resolveRung(goal, 1))).toBe(true); // appel
    expect(rungNeedsSlots(resolveRung(goal, 2))).toBe(false); // courriel
  });
});
