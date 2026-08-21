/**
 * Résultats d'outils SIMULÉS — module pur, partagé par le bac à sable et la
 * suite de garde-fous.
 *
 * Une seule copie, délibérément. Ces deux surfaces doivent répondre au modèle
 * de la MÊME façon, sinon un assistant qui passe la suite se comporte
 * autrement à l'essai — et l'écart serait invisible jusqu'à ce que quelqu'un
 * compare les deux à la main.
 *
 * Les réponses sont NEUTRES : on ne dit jamais au modèle qu'il est dans un
 * essai. Une version antérieure annonçait « exemples non réservables » et le
 * modèle rappelait l'outil en boucle au lieu de rédiger — un comportement que
 * la production n'a jamais. L'avertissement « ce n'est pas réel » s'adresse à
 * l'humain, à l'écran.
 */

/** Résultat d'UN appel — rattaché à son identifiant par l'appelant. */
export function simulatedToolResult(name: string, done: Set<string>): string {
  if (done.has(name)) return `${name} : déjà exécuté à ce tour`;
  done.add(name);
  switch (name) {
    case "get_slots":
      return `${name} : jeudi 14 h, vendredi 10 h`;
    case "book_meeting":
      return `${name} : confirmé`;
    case "update_qualification":
      return `${name} : enregistré`;
    case "schedule_followup":
      return `${name} : relance programmée`;
    default:
      return `${name} : ok`;
  }
}

export function simulatedToolResults(
  calls: { name: string }[],
  /** Outils déjà exécutés dans CE tour — même garde qu'en production. */
  done: Set<string>,
): string {
  const lines = calls.map((call) => {
    // Sans ce retour, le modèle rappelle le même outil au second aller-retour
    // et ne rédige jamais.
    if (done.has(call.name)) return `${call.name} : déjà exécuté à ce tour`;
    done.add(call.name);
    switch (call.name) {
      case "get_slots":
        return `${call.name} : jeudi 14 h, vendredi 10 h`;
      case "book_meeting":
        return `${call.name} : confirmé`;
      case "update_qualification":
        return `${call.name} : enregistré`;
      case "schedule_followup":
        return `${call.name} : relance programmée`;
      default:
        return `${call.name} : ok`;
    }
  });
  return lines.join("\n") || "(aucun résultat)";
}

/** Ces outils terminent le tour : rappeler le modèle ensuite ne sert à rien. */
export function isTerminalTool(name: string): boolean {
  return name === "stop" || name === "handoff";
}
