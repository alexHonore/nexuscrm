/**
 * Unitaire — une notification s'écrit à UN seul endroit.
 *
 * Ce que ce test protège : le jour où l'application est installée sur le
 * téléphone d'un téléphoniste, une notification cesse d'être une ligne dans
 * une cloche — elle devient un objet qui vibre dans une poche, au restaurant,
 * en voiture. Ce qui fait vibrer part de `createNotifications()` : c'est là que
 * la poussée est branchée, après la réponse, une seule fois.
 *
 * La façon dont ça casserait est banale, et surtout INVISIBLE. Quelqu'un ajoute
 * un producteur — un cron de plus, un webhook de plus — recopie le
 * `db.insert(notifications).values(...)` du fichier d'à côté, et c'est correct :
 * la ligne apparaît bien dans la cloche, l'écran la montre, la revue de code
 * passe. Seulement le téléphone, lui, ne sonne jamais. Une notification
 * manquante ne casse rien et ne lève rien ; elle se contente de ne pas
 * arriver, et personne ne remarque ce qui n'a pas sonné. « Les appels manqués
 * réveillent le téléphone mais pas les nouveaux prospects » est exactement le
 * genre de panne qu'on ne diagnostique jamais.
 *
 * D'où ce balayage brutal des sources : le seul fichier qui a le droit
 * d'insérer dans `notifications` est celui qui pousse.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** L'écrivain sanctionné — le seul. */
const CHOKEPOINT = join("src", "lib", "notify.ts");

/**
 * L'insertion, quel que soit le nom du client (`db`, `tx`, `writer`…) et quelle
 * que soit la façon d'atteindre la table (`notifications`, `schema.notifications`).
 */
const DIRECT_INSERT = /\.insert\(\s*(?:\w+\.)?notifications\s*\)/;

/**
 * On lit le CODE, pas la prose. Un fichier a parfaitement le droit d'expliquer
 * dans un commentaire pourquoi `db.insert(notifications)` est interdit — et
 * `notify.ts` le fait. Faire échouer un test sur une phrase apprendrait aux
 * relecteurs à ne plus écrire la phrase, jamais à ne plus écrire l'appel.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Tous les `.ts` et `.tsx` sous `src`, chemin relatif au dépôt. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith(".ts") || full.endsWith(".tsx") ? [full] : [];
  });
}

describe("le point de passage obligé des notifications", () => {
  it("personne n'insère dans `notifications` en dehors de src/lib/notify.ts", () => {
    const files = walk("src").filter((f) => f !== CHOKEPOINT);
    // Un balayage vide passerait sans rien vérifier : c'est la panne de test
    // la plus discrète qui soit.
    expect(files.length, "aucune source balayée ?").toBeGreaterThan(100);

    const offenders = files.filter((file) =>
      DIRECT_INSERT.test(stripComments(readFileSync(file, "utf8"))),
    );

    expect(
      offenders,
      "Ces fichiers écrivent une notification sans passer par createNotifications() de " +
        "src/lib/notify.ts — sinon l'événement n'atteint jamais les téléphones :\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  it("…et l'écrivain sanctionné, lui, insère bien", () => {
    // Le test ci-dessus passerait aussi le jour où plus PERSONNE n'écrit de
    // notification, y compris le point de passage. Un interdit dont il ne
    // reste rien à interdire ne protège plus rien.
    const source = stripComments(readFileSync(CHOKEPOINT, "utf8"));
    expect(source, "src/lib/notify.ts n'insère plus rien : le goulot a-t-il déménagé ?").toMatch(
      DIRECT_INSERT,
    );
  });

  it("le goulot pousse APRÈS la réponse, il ne fait pas attendre le webhook", () => {
    // Un envoi vers APNs ou FCM se compte en secondes et Twilio abandonne un
    // webhook qu'on fait attendre — puis le re-livre, donc duplique la ligne.
    // Si la poussée redevenait synchrone, la panne serait des notifications en
    // double, pas des notifications absentes : plus bruyante, aussi mauvaise.
    const source = stripComments(readFileSync(CHOKEPOINT, "utf8"));
    expect(source).toContain("runAfterResponse");
    expect(source).toContain("fanoutPush");
  });
});
