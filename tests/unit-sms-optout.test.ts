/**
 * Tests unitaires — détection des mots-clés opt-out SMS (src/lib/sms/optout.ts).
 *
 * Logique pure : aucun accès base de données ni réseau. Sémantique CASL/Twilio :
 * seul un message ENTIER égal à un mot-clé (après normalisation) est un opt-out.
 */
import { describe, expect, it } from "vitest";
import {
  OPTOUT_KEYWORDS,
  detectOptOut,
  normalizeOptOutInput,
} from "@/lib/sms/optout";

// « arrêt » en forme décomposée (e + accent circonflexe combinant U+0302) —
// certains claviers/passerelles envoient du NFD au lieu du NFC.
const ARRET_NFD = "arre" + String.fromCharCode(0x0302) + "t";

describe("optout — normalizeOptOutInput", () => {
  it.each([
    ["espaces d'encadrement", " stop ", "STOP"],
    ["point final", "Stop.", "STOP"],
    ["accents retirés (NFC)", "arrêt", "ARRET"],
    ["accents retirés (NFD)", ARRET_NFD, "ARRET"],
    ["exclamation finale", "arrêt!", "ARRET"],
    ["blancs internes réduits", "stop \t all", "STOP ALL"],
    ["guillemets français", "« stop »", "STOP"],
    ["guillemets droits et typographiques", "\"stop\"", "STOP"],
    ["ponctuation cumulée", "stop !?.", "STOP"],
    ["trait d'union d'encadrement", "-stop-", "STOP"],
    ["majuscules accentuées", "DÉSABONNEMENT", "DESABONNEMENT"],
    ["chaîne vide", "", ""],
    ["ponctuation seule", "!?.", ""],
    ["phrase intacte à l'intérieur", "stop it please", "STOP IT PLEASE"],
  ])("%s", (_label, input, expected) => {
    expect(normalizeOptOutInput(input)).toBe(expected);
  });
});

describe("optout — detectOptOut : opt-outs reconnus", () => {
  it.each([
    ["STOP", "STOP"],
    [" stop ", "STOP"],
    ["Stop.", "STOP"],
    ["arrêt", "ARRET"],
    [ARRET_NFD, "ARRET"],
    ["arrêt!", "ARRET"],
    ["Désabonner", "DESABONNER"],
    ["DÉSABONNEMENT", "DESABONNEMENT"],
    ["annuler", "ANNULER"],
    ["Unsubscribe", "UNSUBSCRIBE"],
    ["stop all", "STOP ALL"],
    ["stopall", "STOPALL"],
    ["cancel", "CANCEL"],
    ["end", "END"],
    ["quit", "QUIT"],
  ])("« %s » → mot-clé %s", (input, keyword) => {
    expect(detectOptOut(input)).toEqual({ optOut: true, keyword });
  });
});

describe("optout — detectOptOut : non-opt-outs", () => {
  it.each([
    ["pas intéressé"],
    ["stop it please"],
    ["je veux annuler mon rdv"],
    ["non merci"],
    [""],
    ["   "],
    ["!?."],
    // Dérivés d'un mot-clé mais pas le mot-clé exact
    ["arrêter"],
    ["annulé"],
    ["stops"],
  ])("« %s » → aucun opt-out", (input) => {
    expect(detectOptOut(input)).toEqual({ optOut: false, keyword: null });
  });
});

describe("optout — OPTOUT_KEYWORDS", () => {
  it("chaque mot-clé est déjà sous forme normalisée", () => {
    for (const keyword of OPTOUT_KEYWORDS) {
      expect(normalizeOptOutInput(keyword)).toBe(keyword);
    }
  });

  it("contient le jeu Twilio anglais et les mots français", () => {
    for (const expected of [
      "STOP",
      "STOPALL",
      "STOP ALL",
      "UNSUBSCRIBE",
      "CANCEL",
      "END",
      "QUIT",
      "ARRET",
      "DESABONNER",
      "DESABONNEMENT",
      "ANNULER",
    ]) {
      expect(OPTOUT_KEYWORDS).toContain(expected);
    }
  });

  it("chaque mot-clé est détecté tel quel", () => {
    for (const keyword of OPTOUT_KEYWORDS) {
      expect(detectOptOut(keyword)).toEqual({ optOut: true, keyword });
    }
  });
});
