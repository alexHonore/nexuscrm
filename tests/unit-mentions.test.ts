/**
 * Unitaire — les mentions « @collègue » du composeur de commentaires.
 *
 * Ce que ces tests protègent : l'identifiant d'un collègue ne s'affiche plus
 * dans le texte qu'on écrit, mais il doit TOUJOURS arriver en base sous la
 * forme `@[Nom](uuid)` — c'est elle qui déclenche la notification. Un « @Nom »
 * mal reconnu est une notification qui ne part pas, sans aucune erreur.
 */
import { describe, expect, it } from "vitest";
import {
  activeMentionQuery,
  eraseWholeMention,
  mentionRanges,
  parseStoredBody,
  rankMentionCandidates,
  searchMatch,
  toStoredBody,
} from "@/lib/mentions";

const MARIE = { id: "11111111-1111-4111-8111-111111111111", name: "Marie Tremblay" };
const ALEX = { id: "22222222-2222-4222-8222-222222222222", name: "Alex" };
const ALEX_ROY = { id: "33333333-3333-4333-8333-333333333333", name: "Alex Roy" };

describe("toStoredBody — du texte affiché au jeton stocké", () => {
  it("remplace « @Nom » par le jeton, le reste intact", () => {
    expect(toStoredBody("Rappeler avec @Marie Tremblay demain", [MARIE])).toBe(
      `Rappeler avec @[Marie Tremblay](${MARIE.id}) demain`,
    );
  });

  it("revient intact à l'affichage", () => {
    const stored = toStoredBody("Voir @Marie Tremblay.", [MARIE]);
    expect(parseStoredBody(stored)).toEqual([
      { kind: "text", text: "Voir " },
      { kind: "mention", id: MARIE.id, name: "Marie Tremblay" },
      { kind: "text", text: "." },
    ]);
  });

  it("le nom le plus long gagne", () => {
    expect(toStoredBody("@Alex Roy et @Alex", [ALEX, ALEX_ROY])).toBe(
      `@[Alex Roy](${ALEX_ROY.id}) et @[Alex](${ALEX.id})`,
    );
  });

  it("ni un nom plus long, ni une adresse courriel", () => {
    const text = "@Alexandre écrit à info@Alex";
    expect(toStoredBody(text, [ALEX])).toBe(text);
  });

  it("un nom retouché à la main n'est plus une mention", () => {
    expect(toStoredBody("@Marie Trembla", [MARIE])).toBe("@Marie Trembla");
  });

  it("reconnaît la mention entre parenthèses et devant la ponctuation", () => {
    expect(toStoredBody("(@Marie Tremblay), merci", [MARIE])).toBe(
      `(@[Marie Tremblay](${MARIE.id})), merci`,
    );
  });

  it("entre deux homonymes, le dernier choisi l'emporte", () => {
    const other = { id: "44444444-4444-4444-8444-444444444444", name: "Marie Tremblay" };
    expect(toStoredBody("@Marie Tremblay", [MARIE, other])).toBe(`@[Marie Tremblay](${other.id})`);
  });
});

describe("activeMentionQuery — la liste de suggestions", () => {
  it("s'ouvre sur « @requête » au curseur", () => {
    expect(activeMentionQuery("Voir @mar", 9)).toEqual({ start: 5, query: "mar" });
  });

  it("reste fermée dans une adresse courriel", () => {
    expect(activeMentionQuery("info@mar", 8)).toBeNull();
  });

  it("ne se rouvre pas sur une mention qu'on vient d'insérer", () => {
    const text = "@Marie Tremblay ";
    expect(activeMentionQuery(text, text.length, mentionRanges(text, [MARIE]))).toBeNull();
  });
});

describe("eraseWholeMention — Retour arrière sur une mention", () => {
  it("efface la mention entière, curseur à sa place", () => {
    expect(eraseWholeMention("Voir @Marie Tremblay", "Voir @Marie Trembla", [MARIE])).toEqual({
      text: "Voir ",
      caret: 5,
    });
  });

  it("l'espace qui suit n'est pas la mention", () => {
    expect(eraseWholeMention("@Marie Tremblay x", "@Marie Tremblayx", [MARIE])).toBeNull();
  });

  it("ignore une frappe ordinaire", () => {
    expect(eraseWholeMention("@Marie Tremblay a", "@Marie Tremblay ab", [MARIE])).toBeNull();
    expect(eraseWholeMention("abc @Marie Tremblay", "ac @Marie Tremblay", [MARIE])).toBeNull();
  });
});

describe("rankMentionCandidates — qui proposer", () => {
  const users = [
    { id: "a", name: "Hélène Gagnon" },
    { id: "b", name: "Jean-Philippe Roy" },
    { id: "c", name: "Marie Tremblay" },
    { id: "d", name: "Philippe Côté" },
  ];

  it("ignore les accents", () => {
    expect(rankMentionCandidates(users, "hel").map((u) => u.id)).toEqual(["a"]);
    expect(rankMentionCandidates(users, "cote").map((u) => u.id)).toEqual(["d"]);
  });

  it("le début du nom passe avant le début d'un mot", () => {
    expect(rankMentionCandidates(users, "phil").map((u) => u.id)).toEqual(["d", "b"]);
  });

  it("sans requête, propose tout le monde dans l'ordre reçu", () => {
    expect(rankMentionCandidates(users, "", 2).map((u) => u.id)).toEqual(["a", "b"]);
  });

  it("repère la partie qui correspond, accents compris", () => {
    expect(searchMatch("Hélène Gagnon", "hele")).toEqual([0, 4]);
    expect(searchMatch("Hélène Gagnon", "zz")).toBeNull();
  });
});
