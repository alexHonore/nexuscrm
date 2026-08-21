import type { LLMMessage } from "./types";

/**
 * Regroupe les résultats d'outils CONSÉCUTIFS en un seul tour.
 *
 * Quand le modèle émet deux appels d'outils dans le même tour (par ex.
 * `update_qualification` + `get_slots`), le moteur renvoie un message `tool`
 * par résultat. Google exige que TOUS les `functionResponse` d'un tour arrivent
 * dans UN seul contenu `user` — un tour par résultat fait rejeter la requête
 * (« le nombre de réponses doit égaler le nombre d'appels »). Anthropic
 * tolère la découpe, mais elle lui apprend à ne plus paralléliser ses appels.
 *
 * Le regroupement se fait donc ici, une fois, côté fournisseur : le moteur
 * garde son protocole simple (un message par résultat) sans connaître les
 * manies de chacun.
 */
export type MessageTurn =
  | { kind: "message"; message: LLMMessage }
  | { kind: "tool_results"; results: LLMMessage[] };

export function groupToolResults(messages: LLMMessage[]): MessageTurn[] {
  const turns: MessageTurn[] = [];
  for (const message of messages) {
    if (message.role !== "tool") {
      turns.push({ kind: "message", message });
      continue;
    }
    const last = turns[turns.length - 1];
    if (last && last.kind === "tool_results") {
      last.results.push(message);
    } else {
      turns.push({ kind: "tool_results", results: [message] });
    }
  }
  return turns;
}
