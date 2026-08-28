/**
 * Unitaire — « jamais reçu » couvre les DEUX orthographes d'« annulé ».
 *
 * `messages.status` est du texte libre alimenté par deux vocabulaires :
 *
 *  · `canceled`, un seul L — celui de Twilio, consigné par
 *    `recordDeliveryOutcome` pour un message programmé annulé avant son heure ;
 *  · `cancelled`, deux L — le nôtre, écrit par
 *    `src/app/(app)/conversations/actions.ts` quand un téléphoniste annule un
 *    envoi encore en file. L'annulation n'est acceptée que si le job est
 *    toujours `pending` : rien n'est donc parti, personne n'a rien reçu.
 *
 * Tant que seule la graphie de Twilio figurait dans `UNDELIVERED_STATUSES`, un
 * envoi annulé à la main comptait comme REÇU. Trois conséquences, toutes
 * silencieuses : le modèle relisait « comme je vous le disais » un message que
 * personne n'a lu, son budget de tours le décomptait, et le rejeu après panne
 * refusait de rouvrir l'entrant qui suivait — le contact avait répondu, et
 * l'assistant restait muet.
 *
 * Le test croise la liste avec le littéral RÉELLEMENT écrit par le code
 * d'annulation, lu sur le disque : renommer l'un sans l'autre fait échouer ici
 * plutôt qu'en production, six mois plus tard, sur un fil qui ne repart pas.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// Le runtime est un module serveur ; on ne lit ici qu'une constante pure.
vi.mock("server-only", () => ({}));
const { UNDELIVERED_STATUSES } = await import("@/lib/agent/runtime");

const CANCEL_ACTION = "src/app/(app)/conversations/actions.ts";

describe("statuts « jamais reçu »", () => {
  it("les deux orthographes d'« annulé » y sont", () => {
    expect(UNDELIVERED_STATUSES).toContain("canceled");
    expect(UNDELIVERED_STATUSES).toContain("cancelled");
  });

  it("le littéral que l'annulation ÉCRIT est bien dans la liste", () => {
    const source = readFileSync(CANCEL_ACTION, "utf8");
    const written = [...source.matchAll(/\.set\(\{\s*status:\s*"([a-z_]+)"[^}]*\}\)/g)].map(
      (m) => m[1],
    );
    expect(
      written,
      "l'extracteur ne trouve plus le statut écrit par l'annulation : le garde ne protège plus rien",
    ).toContain("cancelled");
    expect(
      UNDELIVERED_STATUSES,
      `« cancelled » est écrit par ${CANCEL_ACTION} mais absent de la liste : ` +
        "un envoi annulé compterait comme reçu",
    ).toContain("cancelled");
  });

  it("ce qui est PEUT-ÊTRE parti n'y est pas", () => {
    // `unknown` = délai ou coupure réseau pendant l'appel à Twilio : le message
    // a peut-être été livré. Le ranger ici ferait renvoyer un doublon.
    expect(UNDELIVERED_STATUSES).not.toContain("unknown");
    expect(UNDELIVERED_STATUSES).not.toContain("sent");
    expect(UNDELIVERED_STATUSES).not.toContain("delivered");
    expect(UNDELIVERED_STATUSES).not.toContain("queued");
  });
});
