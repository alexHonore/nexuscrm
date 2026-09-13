/**
 * Unitaire — QUI apprend qu'un appel entrant n'a pas été pris.
 *
 * Ce que ces tests protègent : un appel manqué doit atteindre DEUX personnes —
 * celui dont la ligne a sonné dans le vide, et le téléphoniste à qui la fiche
 * est confiée, qui n'a rien entendu et qui est pourtant celui qui connaît le
 * dossier. Avant, seule la première était prévenue : « son » client rappelait,
 * personne ne le lui disait, et le rappel se perdait entre deux personnes qui
 * croyaient chacune que l'autre s'en occupait.
 *
 * Et la règle qui empêche le remède d'être pire que le mal : JAMAIS deux fois
 * la même personne. Le cas courant — on appelle le numéro qu'on a reçu, donc
 * le détenteur EST le propriétaire de la ligne — ne doit produire qu'une seule
 * ligne dans la cloche et une seule vibration.
 */
import { describe, expect, it, vi } from "vitest";

// `notification-content` porte `import "server-only"` : il est écrit pour le
// serveur et lit les fichiers de messages. Le neutraliser est le motif déjà
// employé par les tests d'intégration du dépôt.
vi.mock("server-only", () => ({}));

import { missedCallRows } from "@/components/clients/notification-content";

const LINE_OWNER = { id: "11111111-1111-4111-8111-111111111111", locale: "fr" };
const HOLDER = { id: "22222222-2222-4222-8222-222222222222", locale: "en" };
// `missedCallRows` ne reçoit PAS `assignedToId` : le détenteur est résolu par
// l'appelant (il lui faut la langue et le statut du compte, donc la base) et
// arrive déjà tranché dans `assignee`. La règle, elle, reste pure.
const CLIENT = { id: "33333333-3333-4333-8333-333333333333", fullName: "Marie Tremblay" };
const FROM = "+14185551234";

describe("missedCallRows", () => {
  it("prévient le propriétaire de la ligne ET le détenteur de la fiche", () => {
    const rows = missedCallRows({
      lineOwner: LINE_OWNER,
      assignee: HOLDER,
      client: CLIENT,
      visibleToLineOwner: true,
      fromNumber: FROM,
    });

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.userId)).toEqual([LINE_OWNER.id, HOLDER.id]);
    expect(rows.every((r) => r.type === "missed_call")).toBe(true);
    // Les deux mènent à la fiche, pas au journal d'appels.
    expect(rows.every((r) => r.link === `/clients/${CLIENT.id}`)).toBe(true);
  });

  it("n'écrit qu'UNE ligne quand le détenteur est le propriétaire de la ligne", () => {
    const rows = missedCallRows({
      lineOwner: LINE_OWNER,
      assignee: { id: LINE_OWNER.id, locale: "fr" },
      client: CLIENT,
      visibleToLineOwner: true,
      fromNumber: FROM,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(LINE_OWNER.id);
  });

  it("n'écrit qu'UNE ligne quand la fiche n'est confiée à personne", () => {
    const rows = missedCallRows({
      lineOwner: LINE_OWNER,
      assignee: null,
      client: CLIENT,
      visibleToLineOwner: true,
      fromNumber: FROM,
    });

    expect(rows).toHaveLength(1);
  });

  it("n'écrit qu'UNE ligne quand le numéro ne correspond à aucune fiche", () => {
    const rows = missedCallRows({
      lineOwner: LINE_OWNER,
      assignee: HOLDER,
      client: null,
      visibleToLineOwner: true,
      fromNumber: FROM,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(LINE_OWNER.id);
    // Sans fiche, la notification mène au journal d'appels.
    expect(rows[0].link).not.toContain("/clients/");
  });

  it("n'écrit qu'UNE ligne quand le détenteur n'est plus en service", () => {
    // L'appelant résout un compte désactivé à `null` — la règle reste pure.
    const rows = missedCallRows({
      lineOwner: LINE_OWNER,
      assignee: null,
      client: CLIENT,
      visibleToLineOwner: true,
      fromNumber: FROM,
    });

    expect(rows).toHaveLength(1);
  });

  it("tait le nom du client au propriétaire de la ligne qui n'a pas le droit de le voir — jamais au détenteur", () => {
    const rows = missedCallRows({
      lineOwner: LINE_OWNER,
      assignee: HOLDER,
      client: CLIENT,
      visibleToLineOwner: false,
      fromNumber: FROM,
    });

    expect(rows).toHaveLength(2);

    const [line, holder] = rows;
    // Le propriétaire de la ligne : ni le nom, ni le lien vers la fiche.
    expect(line.body ?? "").not.toContain("Marie Tremblay");
    expect(line.link).not.toContain(`/clients/${CLIENT.id}`);
    // Le détenteur voit sa propre fiche par définition (règle 13).
    expect(holder.body ?? "").toContain("Marie Tremblay");
    expect(holder.link).toBe(`/clients/${CLIENT.id}`);
  });

  it("écrit chaque ligne dans la langue de SON destinataire", () => {
    const rows = missedCallRows({
      lineOwner: LINE_OWNER,
      assignee: HOLDER,
      client: CLIENT,
      visibleToLineOwner: true,
      fromNumber: FROM,
    });

    // Deux titres, deux langues : le titre français et le titre anglais ne
    // peuvent pas être identiques, sans quoi la traduction ne sert à rien.
    expect(rows[0].title).not.toBe(rows[1].title);
  });

  it("traite une langue inconnue comme du français", () => {
    const rows = missedCallRows({
      lineOwner: { id: LINE_OWNER.id, locale: "es" },
      assignee: null,
      client: null,
      visibleToLineOwner: true,
      fromNumber: FROM,
    });

    const fr = missedCallRows({
      lineOwner: { id: LINE_OWNER.id, locale: "fr" },
      assignee: null,
      client: null,
      visibleToLineOwner: true,
      fromNumber: FROM,
    });

    expect(rows[0].title).toBe(fr[0].title);
  });
});
