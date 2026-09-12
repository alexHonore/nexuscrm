/**
 * Tests unitaires — le destinataire peut-il recevoir un texto ?
 * (`src/lib/sms/destination.ts`)
 *
 * Module pur : aucune base, aucun réseau, aucune variable d'environnement.
 *
 * Ce que ce fichier tient : les numéros qui ont produit un refus de Twilio
 * (21408 « pays désactivé », 21211 « numéro illisible ») sont refusés ICI,
 * avant qu'un modèle ne soit appelé pour rédiger un message qui ne peut pas
 * arriver. Les cas ne sont pas inventés : ils viennent de ce que
 * `normalizePhone` (`src/lib/phone.ts`) produit sur des saisies réelles.
 */
import { describe, expect, it } from "vitest";

import {
  ALL_REGIONS,
  DEFAULT_ALLOWED_REGIONS,
  checkDestination,
  parseAllowedRegions,
} from "@/lib/sms/destination";
import { normalizePhone } from "@/lib/phone";

describe("parseAllowedRegions", () => {
  it("absent ou vide : l'Amérique du Nord, et elle seule", () => {
    expect(parseAllowedRegions(undefined)).toEqual(["1"]);
    expect(parseAllowedRegions("")).toEqual(["1"]);
    expect(parseAllowedRegions(null)).toEqual(["1"]);
    expect(DEFAULT_ALLOWED_REGIONS).toEqual(["1"]);
  });

  it("découpe, tolère les espaces et le « + » d'usage", () => {
    expect(parseAllowedRegions(" +1 , 33 ,+44 ")).toEqual(["1", "33", "44"]);
  });

  it("une valeur entièrement illisible retombe sur le défaut, jamais sur « tout ouvert »", () => {
    // Le sens d'erreur qui compte : un réglage mal tapé ne doit pas ouvrir la
    // porte du monde entier en silence.
    expect(parseAllowedRegions("abc,,0,+")).toEqual(["1"]);
  });

  it("l'étoile lève la garde", () => {
    expect(parseAllowedRegions("*")).toEqual([ALL_REGIONS]);
    expect(checkDestination("+33612345678", parseAllowedRegions("*")).sendable).toBe(true);
  });
});

describe("checkDestination — ce qui passe", () => {
  it.each([
    "+15145551234",
    "+14184761542",
    "+18195550100",
    // Sans frais : capable de recevoir des textos une fois inscrit, on ne le
    // refuse pas hors ligne.
    "+18005550199",
  ])("%s est joignable", (to) => {
    expect(checkDestination(to)).toEqual({ sendable: true, region: "1" });
  });

  it("une région ouverte explicitement passe, et ne subit pas la grammaire nord-américaine", () => {
    const regions = parseAllowedRegions("1,33");
    expect(checkDestination("+33612345678", regions)).toEqual({ sendable: true, region: "33" });
  });
});

describe("checkDestination — le 21408 (« pays désactivé »)", () => {
  it("un numéro étranger est refusé AVANT Twilio, avec l'indicatif en clair", () => {
    const verdict = checkDestination("+33612345678");
    expect(verdict).toEqual({ sendable: false, reason: "region_blocked", detail: "+336…" });
  });

  it("le piège réel : un Québec tapé avec un « + » de trop désigne la FICHE, pas la Suisse", () => {
    // « +4184761542 » : normalizePhone garde les chiffres tels quels dès qu'il
    // y a un « + », donc l'indicatif régional 418 devient l'indicatif de pays
    // +41. Le numéro a l'air juste, il passe l'ancienne porte E.164, et Twilio
    // le refuse par un 21408 facturé.
    //
    // Le motif compte autant que le refus : dire « pays non servi » enverrait
    // le courtier ouvrir la Suisse dans les permissions Twilio, alors que la
    // réparation est un caractère à effacer sur la fiche.
    const e164 = normalizePhone("+4184761542");
    expect(e164).toBe("+4184761542");
    expect(checkDestination(e164)).toEqual({
      sendable: false,
      reason: "invalid_nanp",
      detail: "indicatif de pays manquant",
    });
  });

  it("un vrai numéro étranger reste un problème de PAYS", () => {
    // Onze chiffres derrière +41 : ce n'est pas un dix chiffres nord-américain,
    // et le geste est bien d'ouvrir (ou non) une région.
    expect(checkDestination("+41794761542")).toMatchObject({ reason: "region_blocked" });
  });

  it("le détail ne recompose jamais le numéro", () => {
    // La FORME, pas une comparaison de sous-chaîne : « ne contient pas » passe
    // pour n'importe quel détail se terminant par « … », le numéro entier
    // compris. Trois chiffres, jamais plus.
    const verdict = checkDestination("+442079460958");
    if (verdict.sendable) throw new Error("attendu : refusé");
    expect(verdict.detail).toMatch(/^\+\d{3}…$/);
    expect(verdict.detail).toHaveLength(5);
  });

  it("une liste de régions VIDE ne fait pas le noir complet", () => {
    // Fermer la planète entière n'est la volonté de personne : une liste vide
    // se lit comme absente, donc l'Amérique du Nord.
    expect(checkDestination("+14165551234", []).sendable).toBe(true);
  });
});

describe("checkDestination — le 21211 (« numéro illisible »)", () => {
  it("aucun numéro du tout", () => {
    expect(checkDestination(null)).toEqual({ sendable: false, reason: "no_phone", detail: null });
    expect(checkDestination("   ")).toEqual({ sendable: false, reason: "no_phone", detail: null });
  });

  it.each([
    ["476-1542", "+4761542"], // sept chiffres : trop court pour E.164
    ["0033612345678", "+0033612345678"], // préfixe international 00 recollé
    ["011 33 6 12 34 56 78", "+01133612345678"], // préfixe international nord-américain
  ])("%s → %s est écarté sur la forme", (input, expected) => {
    const e164 = normalizePhone(input);
    expect(e164).toBe(expected);
    expect(checkDestination(e164)).toMatchObject({ sendable: false, reason: "invalid_to" });
  });

  it("un huit chiffres importé passait l'ancienne porte et partait chez Twilio", () => {
    // C'est LE cas qui coûtait de l'argent : `+12345678` a huit chiffres, donc
    // il satisfaisait `^\+[0-9]{8,15}$`, et Twilio lisait « +1 234-5678 » —
    // sept chiffres nationaux là où l'Amérique du Nord en veut dix.
    const e164 = normalizePhone("12345678");
    expect(e164).toBe("+12345678");
    expect(checkDestination(e164)).toEqual({
      sendable: false,
      reason: "invalid_nanp",
      detail: "longueur",
    });
  });

  it.each([
    ["+19115550134", "indicatif de service"], // 911 en indicatif régional
    ["+12115550134", "indicatif de service"], // 211
    ["+14185550134".replace("555", "411"), "central de service"], // 411 en central
  ])("%s : un code de service n'a jamais été composable", (to, detail) => {
    expect(checkDestination(to)).toEqual({ sendable: false, reason: "invalid_nanp", detail });
  });

  it.each(["+11185550134", "+14181550134", "+10000000000"])(
    "%s : indicatif ou central commençant par 0 ou 1",
    (to) => {
      expect(checkDestination(to)).toEqual({
        sendable: false,
        reason: "invalid_nanp",
        detail: "indicatif ou central impossible",
      });
    },
  );

  it("la grammaire nord-américaine s'applique même quand la garde régionale est levée", () => {
    // `*` ouvre les PAYS ; il ne rend pas composable un numéro qui ne l'est pas.
    expect(checkDestination("+19115550134", parseAllowedRegions("*"))).toMatchObject({
      sendable: false,
      reason: "invalid_nanp",
    });
  });
});
