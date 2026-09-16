import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { isMessageLike, pickOutboundDraft } from "@/lib/agent/draft";

/**
 * Le choix du texte qui PART au client.
 *
 * Le cas fondateur est réel : le 2026-08-25, une cliente a reçu « { } ». Le
 * modèle avait écrit les arguments de ses outils dans le canal texte avant sa
 * vraie réponse, et la règle « premier paragraphe » les a pris pour le message.
 */

const PROD_2026_08_25 = [
  "{ }",
  '{"reason":"Projet de vente non actif; souhaite seulement connaître la valeur de sa maison."}',
  "Je comprends, Jessica. Comme vous ne prévoyez pas vendre pour l’instant, je vous remercie" +
    " d’avoir précisé. Si votre projet change, vous pourrez nous réécrire ici.",
].join("\n\n");

describe("isMessageLike", () => {
  it("accepte ce qu'un humain écrit dans un texto", () => {
    expect(isMessageLike("Bonjour Jessica, avez-vous un moment cette semaine ?")).toBe(true);
    // Un message peut parfaitement CONTENIR une accolade sans être du JSON.
    expect(isMessageLike("Votre code {G1V 2M3} est bien noté.")).toBe(true);
    expect(isMessageLike("Parfait — 14 h, mardi.")).toBe(true);
  });

  it("refuse le bruit de machine", () => {
    expect(isMessageLike("{ }")).toBe(false);
    expect(isMessageLike('{"reason":"pas intéressé"}')).toBe(false);
    expect(isMessageLike('[{"name":"read_client"}]')).toBe(false);
    expect(isMessageLike("<thinking>il faut clore</thinking>")).toBe(false);
    expect(isMessageLike("```json\n{}\n```")).toBe(false);
  });

  it("refuse ce qui ne porte aucune lettre", () => {
    expect(isMessageLike("---")).toBe(false);
    expect(isMessageLike("…")).toBe(false);
    expect(isMessageLike("1. 2. 3.")).toBe(false);
    expect(isMessageLike("   ")).toBe(false);
  });
});

describe("pickOutboundDraft", () => {
  it("envoie le VRAI message de Jessica, pas « { } »", () => {
    const picked = pickOutboundDraft(PROD_2026_08_25);
    expect(picked.draft.startsWith("Je comprends, Jessica.")).toBe(true);
    expect(picked.skipped).toEqual([
      "{ }",
      '{"reason":"Projet de vente non actif; souhaite seulement connaître la valeur de sa maison."}',
    ]);
    expect(picked.dropped).toBe(0);
  });

  it("garde la règle « un seul message par tour » sur de la prose", () => {
    const picked = pickOutboundDraft("Premier paragraphe.\n\nDeuxième paragraphe.\n\nTroisième.");
    expect(picked.draft).toBe("Premier paragraphe.");
    expect(picked.dropped).toBe(2);
    expect(picked.skipped).toEqual([]);
  });

  it("rend un brouillon VIDE quand rien n'est un message — jamais le bruit faute de mieux", () => {
    const picked = pickOutboundDraft('{ }\n\n{"reason":"x"}');
    expect(picked.draft).toBe("");
    expect(picked.skipped).toHaveLength(2);
  });

  it("rend un brouillon vide sur une réponse vide", () => {
    expect(pickOutboundDraft("").draft).toBe("");
    expect(pickOutboundDraft("\n\n   \n\n").draft).toBe("");
  });

  it("ne coupe pas un message d'une seule ligne", () => {
    const picked = pickOutboundDraft("Merci Nadjia, bonne journée.");
    expect(picked.draft).toBe("Merci Nadjia, bonne journée.");
    expect(picked.dropped).toBe(0);
  });
});
