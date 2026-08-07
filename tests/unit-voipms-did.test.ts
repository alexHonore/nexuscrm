/**
 * Normalisation du DID pour l'API voip.ms.
 *
 * Régression réelle (production, 2026-08-07) : `setDIDRouting` échouait avec
 * « invalid_did » parce qu'on lui passait la forme E.164 stockée en base
 * (« +15149561693 », 11 chiffres). Conséquence silencieuse : le routage
 * entrant restait sur le compte principal et AUCUN appel entrant n'arrivait
 * au téléphoniste.
 */
import { describe, expect, it, vi } from "vitest";

// `src/lib/voipms.ts` est un module serveur — même convention que
// tests/int-voipms-line.test.ts pour pouvoir l'importer ici.
vi.mock("server-only", () => ({}));

const { didDigits } = await import("@/lib/voipms");

describe("didDigits", () => {
  it("retire l'indicatif de pays de la forme E.164", () => {
    expect(didDigits("+15149561693")).toBe("5149561693");
  });

  it("laisse un numéro déjà à 10 chiffres intact", () => {
    expect(didDigits("5149561693")).toBe("5149561693");
  });

  it("ignore la mise en forme", () => {
    expect(didDigits("(514) 956-1693")).toBe("5149561693");
    expect(didDigits("+1 514 956 1693")).toBe("5149561693");
    expect(didDigits("1-514-956-1693")).toBe("5149561693");
  });

  it("ne tronque PAS un numéro à 11 chiffres qui ne commence pas par 1", () => {
    // Hors NANP : mieux vaut transmettre tel quel et laisser voip.ms trancher
    // que d'amputer silencieusement un chiffre significatif.
    expect(didDigits("44207946095")).toBe("44207946095");
  });

  it("laisse passer une entrée trop courte sans la déformer", () => {
    expect(didDigits("4443")).toBe("4443");
  });
});
