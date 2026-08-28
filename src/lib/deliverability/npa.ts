/**
 * Où part le message, d'après son indicatif régional.
 *
 * Module PUR. Cette table existe pour UNE question, et elle est structurante :
 * l'inscription A2P 10DLC se déclenche sur la DESTINATION, pas sur
 * l'expéditeur. Un courtier de Québec qui n'écrit qu'à des mobiles québécois
 * n'a rien à inscrire, et lui afficher une carte « marque non enregistrée »
 * l'enverrait remplir un formulaire inutile. Le jour où un mobile AMÉRICAIN
 * entre dans sa liste, la question change du tout au tout — et rien d'autre
 * dans ce dépôt ne le lui dirait.
 *
 * La liste des indicatifs canadiens du Plan de numérotation nord-américain est
 * courte et bouge lentement (quelques ajouts par décennie). Un indicatif neuf
 * absent d'ici serait lu comme américain : c'est le sens d'erreur voulu — on
 * signale à tort plutôt que de taire un vrai trafic vers les États-Unis.
 */

/**
 * Indicatifs régionaux GÉOGRAPHIQUES canadiens.
 *
 * `942` (Toronto) et `257` (Colombie-Britannique) sont entrés en service le
 * 24 mai 2025 : les oublier faisait lire un mobile de Toronto comme un mobile
 * américain, donc « vous écrivez aux États-Unis » à un courtier qui n'écrit
 * qu'au Canada — et l'inscription A2P 10DLC est justement ce que ce chiffre
 * déclenche. Un indicatif neuf absent d'ici penche du même côté : on signale à
 * tort plutôt que de taire un vrai trafic américain.
 */
export const CANADIAN_NPAS: ReadonlySet<string> = new Set([
  "204", "226", "236", "249", "250", "257", "263", "289",
  "306", "343", "354", "365", "367", "368", "382", "387",
  "403", "416", "418", "428", "431", "437", "438", "450", "468", "474",
  "506", "514", "519", "548", "579", "581", "584", "587",
  "604", "613", "639", "647", "672", "683",
  "705", "709", "742", "753", "778", "780", "782",
  "807", "819", "825", "867", "873", "879",
  "902", "905", "942",
]);

/**
 * Indicatifs NON GÉOGRAPHIQUES du plan nord-américain — sans frais, à frais
 * surtaxés, services.
 *
 * Ils ne désignent aucun pays, et surtout aucun mobile : un envoi vers un
 * 1-800 n'est pas « du trafic vers les États-Unis ». Les ranger dans le camp
 * américain gonflait `us_bound_share`, l'indicateur qui décide si le courtier
 * doit s'inquiéter d'une inscription A2P 10DLC — une alerte bâtie sur un
 * numéro qui n'aurait jamais dû être texté.
 */
export const SERVICE_NPAS: ReadonlySet<string> = new Set([
  "600", "622", // services canadiens
  "700", "710", // services du plan nord-américain
  "800", "833", "844", "855", "866", "877", "888", // sans frais
  "900", // frais surtaxés
]);

export type Destination = "ca" | "us" | "intl" | "service" | "unknown";

/**
 * Classe un numéro E.164. Tout ce qui n'est pas +1 est « international » :
 * hors du plan nord-américain, ni les règles 10DLC ni les seuils de filtrage
 * mesurés ici ne s'appliquent, et le mélanger au trafic canadien fausserait
 * les deux.
 */
export function destinationOf(e164: string | null | undefined): Destination {
  if (!e164 || !e164.startsWith("+")) return "unknown";
  if (!e164.startsWith("+1")) return "intl";
  const npa = e164.slice(2, 5);
  if (npa.length !== 3 || !/^[2-9]\d\d$/.test(npa)) return "unknown";
  if (SERVICE_NPAS.has(npa)) return "service";
  return CANADIAN_NPAS.has(npa) ? "ca" : "us";
}
